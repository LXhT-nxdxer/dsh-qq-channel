/**
 * plugins/memory/store-vector.js — 语义检索的两块「可选」地基。
 *
 * ① createEmbeddingClient：OpenAI 兼容的 `POST {baseUrl}/embeddings`
 *    （请求 `{ model, input: [文本...] }` → 响应 `{ data: [{ embedding: [...] }] }`）。
 *    超时走 AbortSignal.timeout；**任何失败都不抛错**，只返回 null + debug 日志 + 熔断：
 *    失败后 `cooldownMs`（默认 60s）内连网络都不碰，避免每轮都去撞同一个坏接口
 *    （HF 模型下载失败 / 401 / 内网超时这类情况，重试纯浪费）。
 *
 * ② createVectorStore：向量缓存 `vectors.json`（和 items.json 同目录，但**分成两个文件**：
 *    别把大数组塞进每条记录里，items.json 要保持人眼可读）。
 *    它只是缓存 —— 文件损坏 / 缺条目一律当空处理，绝不阻塞召回；items.json 才是事实源。
 *    条目删除 / 归档时由 store 调 remove() / prune() 同步清理；embedding 模型换了整库作废重算。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'

export const VECTOR_VERSION = 1
/** 单次 embedding 请求默认超时（毫秒）：这是给「每轮注入」用的，不能等太久。 */
export const DEFAULT_TIMEOUT_MS = 5000
/** 失败后的默认熔断时长（毫秒）：期间不再打网络，只用关键词。 */
export const DEFAULT_COOLDOWN_MS = 60_000
/** 单次请求最多带多少条文本（懒加载时按批切，别一口气把 200 条塞给接口）。 */
export const MAX_EMBED_BATCH = 32

/** 缓存里向量保留 6 位小数：够算余弦，又能把文件压小一大截。 */
const VECTOR_PRECISION = 1e6

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * baseUrl → 真正的 embeddings 端点。
 * 允许用户填 `https://api.openai.com/v1`（补 `/embeddings`）或直接填完整端点（原样用）。
 */
export function normalizeEmbeddingUrl(raw) {
  const base = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!base) return ''
  return /\/embeddings$/i.test(base) ? base : `${base}/embeddings`
}

/** 是不是一条能用的向量：非空数组、全是有限数字。 */
export function isVector(value) {
  if (!Array.isArray(value) || value.length === 0) return false
  for (const n of value) if (!Number.isFinite(n)) return false
  return true
}

/**
 * 余弦相似度（-1–1）。维度不一致 / 空 / 含 NaN / 零向量一律当 0 —— 语义分宁可 0，也不许 NaN。
 */
export function cosineSimilarity(a, b) {
  if (!isVector(a) || !isVector(b) || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na <= 0 || nb <= 0) return 0
  const sim = dot / Math.sqrt(na * nb)
  if (!Number.isFinite(sim)) return 0
  return Math.max(-1, Math.min(1, sim))
}

/** 存盘用的向量拷贝（四舍五入到 6 位小数，顺手把 -0 变成 0）。 */
function roundVector(vec) {
  return vec.map((n) => {
    const r = Math.round(n * VECTOR_PRECISION) / VECTOR_PRECISION
    return Object.is(r, -0) ? 0 : r
  })
}

/** 把异常翻译成一句能进日志的原因（超时别显示成一句看不懂的 stack）。 */
function describeFailure(error, timeoutMs) {
  const name = String(error?.name || '')
  if (name === 'TimeoutError' || name === 'AbortError') return `超时 ${timeoutMs}ms`
  const message = String(error?.message || error || '未知错误').trim()
  return message.slice(0, 200) || '未知错误'
}

/**
 * OpenAI 兼容的 embedding 客户端。
 *
 * @param {object} options
 * @param {string} [options.baseUrl] 例 `https://api.openai.com/v1`（会自动补 `/embeddings`）
 * @param {string} [options.model]   例 `text-embedding-3-small`
 * @param {string} [options.apiKey]  没填就不带 Authorization（本地服务常见）
 * @param {number} [options.timeoutMs] 单次请求超时，默认 5000
 * @param {number} [options.cooldownMs] 失败熔断时长，默认 60000；0 = 不熔断
 * @param {() => number} [options.now] 时钟（测试用）
 * @param {Function} [options.fetch] fetch 实现（测试用）
 * @param {{debug?:Function,info?:Function,warn?:Function}} [options.log]
 */
export function createEmbeddingClient(options = {}) {
  const url = normalizeEmbeddingUrl(options.baseUrl)
  const model = String(options.model ?? '').trim()
  const apiKey = String(options.apiKey ?? '').trim()
  const timeoutMs = clampInt(options.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS)
  const cooldownMs = clampInt(options.cooldownMs, 0, 60 * 60 * 1000, DEFAULT_COOLDOWN_MS)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = options.log || null
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : (input, init) => globalThis.fetch(input, init)
  /** 缺 baseUrl 或 model = 没配，直接当关键词模式（不报错、不告警）。 */
  const enabled = Boolean(url && model)

  let openUntil = 0
  let lastError = ''
  let attempts = 0
  let failures = 0
  let skipped = 0
  let computed = 0

  const stats = {}
  for (const [key, read] of Object.entries({
    attempts: () => attempts,
    failures: () => failures,
    skipped: () => skipped,
    computed: () => computed,
    openUntil: () => openUntil,
    lastError: () => lastError,
  })) {
    Object.defineProperty(stats, key, { get: read, enumerable: true })
  }

  function markFailure(reason) {
    failures += 1
    lastError = String(reason || '未知错误').slice(0, 200)
    if (cooldownMs > 0) openUntil = now() + cooldownMs
    const wait = cooldownMs > 0 ? `${Math.round(cooldownMs / 1000)}s 内只用关键词` : '本轮只用关键词'
    log?.debug?.(`[记忆·语义] embedding 失败，${wait}：${lastError}`)
  }

  /**
   * 算一组文本的向量。
   * @param {string|string[]} rawTexts
   * @param {{timeoutMs?:number}} [opts] 单次覆盖超时（「回话前」那条链路要压到 300ms 级）
   * @returns {Promise<number[][]|null>} 失败 / 熔断中 / 没配 → null（调用方据此退回关键词）
   */
  async function embed(rawTexts, opts = {}) {
    if (!enabled) return null
    const texts = (Array.isArray(rawTexts) ? rawTexts : [rawTexts])
      .map((text) => String(text ?? '').trim())
      .filter(Boolean)
    if (!texts.length) return null
    if (cooldownMs > 0 && openUntil > now()) {
      skipped += 1
      return null
    }
    const callTimeoutMs = clampInt(opts.timeoutMs, 50, 120000, timeoutMs)
    attempts += 1
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(callTimeoutMs),
      })
      if (!res || !res.ok) {
        const detail = res && typeof res.text === 'function' ? await res.text().catch(() => '') : ''
        throw new Error(`HTTP ${res?.status ?? '?'}${detail ? ` ${String(detail).slice(0, 160)}` : ''}`)
      }
      const json = await res.json()
      const data = Array.isArray(json?.data) ? json.data : []
      const rows = data
        .map((row, i) => ({
          idx: Number.isFinite(Number(row?.index)) ? Number(row.index) : i,
          vec: row?.embedding,
        }))
        .sort((a, b) => a.idx - b.idx)
      const vectors = rows.map((row) => row.vec)
      if (vectors.length !== texts.length) {
        throw new Error(`返回 ${vectors.length} 条向量，请求了 ${texts.length} 条`)
      }
      const dim = isVector(vectors[0]) ? vectors[0].length : 0
      if (!dim) throw new Error('返回的向量为空')
      for (const [i, vec] of vectors.entries()) {
        if (!isVector(vec) || vec.length !== dim) {
          throw new Error(`第 ${i + 1} 条向量不合法（维度应 ${dim}）`)
        }
      }
      computed += vectors.length
      if (cooldownMs > 0) openUntil = 0
      return vectors
    } catch (e) {
      markFailure(describeFailure(e, callTimeoutMs))
      return null
    }
  }

  /** 熔断中？（还在冷却窗口里 = 不会再打网络） */
  function isOpen() {
    return cooldownMs > 0 && openUntil > now()
  }

  return { enabled, model, url, timeoutMs, cooldownMs, embed, isOpen, stats }
}

/**
 * 向量缓存（vectors.json）：
 *   { version: 1, model: 'text-embedding-3-small', dim: 1024, updatedAt, vectors: { [条目id]: [...] } }
 *
 * 纪律：这份文件是**派生缓存**，任何损坏 / 写失败都只记 debug、绝不让召回或写入失败；
 * 但也不能悄悄吞掉「模型变了」的情况 —— 不同模型的向量不可比，必须整库作废重算。
 *
 * @param {object} options
 * @param {string} options.file vectors.json 的绝对路径
 * @param {() => number} [options.now]
 * @param {{debug?:Function,info?:Function,warn?:Function}} [options.log]
 */
export function createVectorStore(options = {}) {
  if (!options.file) throw new Error('createVectorStore 缺少 file')
  const file = path.resolve(String(options.file))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = options.log || null
  let state = null
  let dirty = false

  const emptyState = () => ({ version: VECTOR_VERSION, model: '', dim: 0, updatedAt: '', vectors: {} })

  function normalizeState(data) {
    const vectors = {}
    const raw = data?.vectors && typeof data.vectors === 'object' ? data.vectors : {}
    for (const [id, vec] of Object.entries(raw)) {
      if (!id || !isVector(vec)) continue
      vectors[id] = roundVector(vec)
    }
    let dim = Number.isFinite(Number(data?.dim)) ? Math.max(0, Math.trunc(Number(data.dim))) : 0
    if (!dim) dim = Object.values(vectors)[0]?.length || 0
    if (dim) {
      for (const [id, vec] of Object.entries(vectors)) {
        if (vec.length !== dim) delete vectors[id] // 维度对不上的残留（换过模型）直接丢
      }
    }
    return {
      version: VECTOR_VERSION,
      model: String(data?.model || ''),
      dim,
      updatedAt: String(data?.updatedAt || ''),
      vectors,
    }
  }

  /** 读缓存（只读一次）；文件不存在 / 损坏都当空缓存，下次写盘顺手修好。 */
  function load() {
    if (state) return state
    let data
    try {
      data = readJsonFile(file)
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        log?.debug?.(`[记忆·语义] 向量缓存读不了，当空缓存重建（${file}）：${e.message}`)
        dirty = true
      }
      state = emptyState()
      return state
    }
    state = normalizeState(data)
    return state
  }

  function size() {
    return Object.keys(load().vectors).length
  }

  function modelOf() {
    return load().model
  }

  function has(id) {
    return Boolean(load().vectors[String(id ?? '')])
  }

  function get(id) {
    const vec = load().vectors[String(id ?? '')]
    return vec ? vec.slice() : null
  }

  /**
   * 确认缓存里的向量是不是当前 embedding 模型算的。
   * 模型不同 = 不可比 → 整库清空、标记待落盘，返回 false（调用方照常重算）。
   * @returns {boolean} 现有向量能否继续用
   */
  function acceptsModel(model) {
    const want = String(model ?? '').trim()
    if (!want) return false
    const cur = load()
    if (cur.model && cur.model !== want) {
      if (Object.keys(cur.vectors).length) {
        log?.info?.(`[记忆·语义] embedding 模型换了（${cur.model} → ${want}），旧向量作废重算`)
      }
      cur.vectors = {}
      cur.dim = 0
      cur.model = want
      dirty = true
      return false
    }
    if (!cur.model) {
      cur.model = want
      dirty = true
    }
    return true
  }

  /**
   * 批量写向量（维度与缓存不一致的跳过）。返回真正写进去的条数。
   * @param {Array<[string, number[]]>} entries
   * @param {{model?:string}} [info]
   */
  function putMany(entries, info = {}) {
    const cur = load()
    const model = String(info.model ?? '').trim()
    if (model) cur.model = model
    let added = 0
    for (const pair of Array.isArray(entries) ? entries : []) {
      const id = String(pair?.[0] ?? '')
      const vec = pair?.[1]
      if (!id || !isVector(vec)) continue
      if (cur.dim && vec.length !== cur.dim) continue
      if (!cur.dim) cur.dim = vec.length
      cur.vectors[id] = roundVector(vec)
      added += 1
    }
    if (added) dirty = true
    return added
  }

  /** 删掉指定条目的向量，返回删了几条。 */
  function remove(ids) {
    const cur = load()
    let removed = 0
    for (const id of Array.isArray(ids) ? ids : []) {
      const key = String(id ?? '')
      if (!key || !Object.hasOwn(cur.vectors, key)) continue
      delete cur.vectors[key]
      removed += 1
    }
    if (removed) dirty = true
    return removed
  }

  /** 只保留 validIds 里的向量（条目已删 / 已归档的顺手清掉），返回清了几条。 */
  function prune(validIds) {
    const keep = validIds instanceof Set ? validIds : new Set(Array.isArray(validIds) ? validIds.map(String) : [])
    const cur = load()
    let removed = 0
    for (const id of Object.keys(cur.vectors)) {
      if (keep.has(id)) continue
      delete cur.vectors[id]
      removed += 1
    }
    if (removed) dirty = true
    return removed
  }

  /**
   * 落盘（原子写）。没变化就什么都不做；清空后顺手删掉文件，别留一份误导人的空缓存。
   * 写失败只记 debug（缓存坏了不能让召回失败）。
   * @returns {boolean} 是否真的写了盘
   */
  function save() {
    if (!dirty) return false
    const cur = load()
    try {
      if (!Object.keys(cur.vectors).length) {
        try {
          fs.unlinkSync(file)
        } catch (e) {
          if (e?.code !== 'ENOENT') throw e
        }
        dirty = false
        return true
      }
      cur.updatedAt = new Date(now()).toISOString()
      writeJsonFileSync(file, cur)
      dirty = false
      return true
    } catch (e) {
      log?.debug?.(`[记忆·语义] 向量缓存写盘失败（不影响召回）：${e.message}`)
      return false
    }
  }

  /** 丢掉内存缓存，下次操作重新读盘。 */
  function reload() {
    state = null
    dirty = false
  }

  return { file, load, size, modelOf, has, get, acceptsModel, putMany, remove, prune, save, reload }
}

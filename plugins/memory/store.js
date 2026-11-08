/**
 * plugins/memory/store.js — 事实记忆（L2）的存取 / 检索 / 打分 / 注入。
 *
 * 存储：单文件 `items.json`（`{ version, updatedAt, items: [...] }`），原子写（tmp → rename，
 * 走 platform/atomic.js；Windows 下 rename 被占用会退避重试）。一条记录：
 *   { id, text, source, chatKey, at, importance(1-5), hits, lastHitAt, archived, archivedAt }
 *
 * 检索：**关键词永远是基线**，向量只是可选增强（配了 embedding 才走，见 store-vector.js）：
 *   · 关键词（默认、不依赖任何外部服务）：中文 2-gram + 英文/数字按词，
 *     相关度 = 命中 token 数 / token 总数（0–1）；
 *   · 语义：query / 条目各一条向量，存 `vectors.json`（和 items.json 分家，别把大数组塞进每条记录），
 *     余弦相似度与关键词分**加权融合**：relevance = w×语义 + (1-w)×关键词，w 默认 0.6（`semanticWeight` 可配）。
 *     纯语义命中要求 sim ≥ minSimilarity（默认 0.45），否则宁可回空也不拿不相关的糊弄。
 *   · **任何一步失败（没配 / 超时 / 401 / 网络 / 返回畸形）都静默退回关键词**：
 *     embed 只返回 null、失败原因进 debug 日志、60 秒熔断（熔断期内不碰网络），永不抛错。
 *     老库没有向量就懒加载：工具检索路径现算并缓存；`before-turn` 路径只等 query 向量（硬上限 300ms），
 *     条目向量丢后台补算，绝不让回话为 embedding 排队。
 *
 * 打分（两条口径，别混）：
 *   · 检索排序：0.7×相关 + 0.2×时间 + 0.1×频率（设计文档 §5.1 的三因子）；"相关" = 上面那个融合分
 *   · 归档判定：没有 query，用 importance/5 顶替"相关"：0.7×(importance/5) + 0.2×时间 + 0.1×频率
 *   · 时间 = exp(-距上次出现天数 / 30)；频率 = min(1, log(1+hits) / log(20))
 *   · archived 仍可被检索到，但整分 ×0.4（软删除 = 降权，不是消失）；归档时顺手删掉它的向量
 *
 * 同步 / 异步两条口径（老调用方一个都不用改）：
 *   · 同步 `recall()` / `buildInjection()` = 纯关键词、绝不发网络请求；
 *   · 新增异步 `recallSemantic()` / `buildInjectionAsync()` = 关键词 + 向量融合，失败自动回退同步版。
 *
 * 纪律：写盘一律"新数组 → 原子落盘 → 成功才换内存状态"。写失败时内存保持旧值，
 * 不会出现"内存里已经加了、磁盘上却没有"的分裂（半截文件也不可能出现在目标路径上）。
 * vectors.json 只是缓存：读不了/写不进只记 debug，绝不影响召回与写入。
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'
import {
  MAX_EMBED_BATCH,
  cosineSimilarity,
  createEmbeddingClient,
  createVectorStore,
} from './store-vector.js'


export const MEMORY_VERSION = 1
/** L2 事实层的默认预算（设计文档：800 字）。 */
export const DEFAULT_INJECT_MAX_CHARS = 800
/** 硬上限：配置调大也不许超过它（防止把上下文撑爆）。 */
export const HARD_INJECT_MAX_CHARS = 800
/** 归档条目的检索降权系数。 */
export const ARCHIVED_WEIGHT = 0.4
/** 单条事实最长多少字（一句话一条，超了截断）。 */
export const MAX_TEXT_CHARS = 240
/** 语义分权重：默认 0.6 语义 + 0.4 关键词（`semanticWeight` 可配，关键词永远占剩下的那部分）。 */
export const DEFAULT_SEMANTIC_WEIGHT = 0.6
/** 纯语义命中的相似度门槛：低于它、又没有关键词命中，就不算命中（别拿不相关的糊弄）。 */
export const DEFAULT_MIN_SIMILARITY = 0.45
/** 「回话前」那条链路单次 embedding 的超时硬上限（毫秒）：宁可这轮用关键词，也不让人等。 */
export const INJECT_EMBED_TIMEOUT_MS = 300
/** query 向量内存缓存：同一句话 10 分钟内直接复用（省一次网络 + 一次超时风险）。 */
export const QUERY_CACHE_TTL_MS = 10 * 60 * 1000
/** query 缓存最多留几条（超了丢最早插入的）。 */
export const QUERY_CACHE_MAX = 128
/** 单轮最多给多少条老条目补算向量（懒加载有上限，别让一次召回等太久）。 */
export const MAX_LAZY_ITEMS = 64

const DAY_MS = 24 * 60 * 60 * 1000
const TIME_DECAY_DAYS = 30
const FREQ_FULL_HITS = 20
const MIN_INJECT_CHARS = 50
const MAX_INJECT_ITEMS = 18

/** 按 Unicode 码点计数（"字"的口径；直接取 .length 会把 emoji 算成 2）。 */
export function charLength(value) {
  return [...String(value ?? '')].length
}

/** 按码点截断，绝不把代理对（emoji）切成半个。 */
export function clipChars(value, max) {
  const chars = [...String(value ?? '')]
  const limit = Math.max(0, Math.trunc(Number(max) || 0))
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('')
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 归一化事实正文：去控制字符、压平换行/空白、截到 240 字。 */
export function normalizeText(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clipChars(text, MAX_TEXT_CHARS).trim()
}

// 单字虚词不进 token（中文只出 2-gram，单字只在整段只有一个字时才可能进来）
const SINGLE_CHAR_STOP = new Set([
  ...'的了吗呢啊吧嘛呀哦嗯我你他她它这那是不有在就都也还很太要会能可把被和与对给从到为以于之其着过个些么什怎谁哪',
])

/**
 * 关键词 token：中文按 2-gram（相邻两字），英文/数字按词。
 * 例：'咖啡' → ['咖啡']；'想喝美式咖啡' → ['想喝','喝美','美式','式咖','咖啡']。
 */
export function tokenize(raw) {
  const text = String(raw ?? '').toLowerCase()
  const tokens = new Set()
  for (const m of text.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    const word = m[0]
    if (word.length < 2 && !/[0-9]/.test(word)) continue // 单字母太吵
    tokens.add(word)
  }
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      if (!SINGLE_CHAR_STOP.has(run)) tokens.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens]
}

/** 相关度 0–1：query 的 token 有多少比例出现在文本里。 */
export function relevanceOf(tokens, text) {
  const list = Array.isArray(tokens) ? tokens : tokenize(tokens)
  if (!list.length) return 0
  const hay = String(text ?? '').toLowerCase()
  if (!hay) return 0
  let hit = 0
  for (const token of list) if (token && hay.includes(token)) hit += 1
  return hit / list.length
}

/**
 * 融合相关度 0–1：`w×语义 + (1-w)×关键词`。
 * 余弦相似度落在 -1–1，负的当 0（语义相反不是"更相关"）；权重夹到 0–1。
 * @param {number} keywordRelevance 0–1
 * @param {number} semanticSimilarity 余弦相似度
 * @param {number} [weight] 语义权重（默认 0.6；0 = 纯关键词，1 = 纯语义）
 */
export function fuseRelevance(keywordRelevance, semanticSimilarity, weight = DEFAULT_SEMANTIC_WEIGHT) {
  const w = clampFloat(weight, 0, 1, DEFAULT_SEMANTIC_WEIGHT)
  const kw = clampFloat(keywordRelevance, 0, 1, 0)
  const sem = clampFloat(semanticSimilarity, 0, 1, 0)
  return w * sem + (1 - w) * kw
}

/** 时间新鲜度 0–1：exp(-距上次出现天数 / 30)（30 天衰减到约 0.37）。 */
export function timeScore(atMs, nowMs = Date.now()) {
  const at = Number(atMs)
  const nowValue = Number(nowMs)
  if (!Number.isFinite(at) || !Number.isFinite(nowValue)) return 0
  const ageDays = Math.max(0, (nowValue - at) / DAY_MS)
  return Math.exp(-ageDays / TIME_DECAY_DAYS)
}

/** 使用频率 0–1：min(1, log(1+hits) / log(20))。 */
export function freqScore(hits) {
  const n = Math.max(0, Number(hits) || 0)
  return Math.min(1, Math.log(1 + n) / Math.log(FREQ_FULL_HITS))
}

/** "上次出现"的时间：优先 lastHitAt，退回创建时间 at。 */
export function lastSeenOf(item) {
  const hitAt = Number(item?.lastHitAt)
  if (Number.isFinite(hitAt) && hitAt > 0) return hitAt
  const at = Number(item?.at)
  return Number.isFinite(at) ? at : 0
}

/**
 * 检索排序分：0.7×相关 + 0.2×时间 + 0.1×频率；归档条目整分 ×0.4。
 * @param {object} item
 * @param {string[]} tokens tokenize(query) 的结果
 * @param {number} [nowMs]
 * @param {number|null} [relevance] 传入时用它顶替"相关"（语义融合分）；不传 = 现算关键词相关
 */
export function rankScore(item, tokens, nowMs = Date.now(), relevance = null) {
  const rel = relevance == null ? relevanceOf(tokens, item?.text) : clampFloat(relevance, 0, 1, 0)
  const base = 0.7 * rel
    + 0.2 * timeScore(lastSeenOf(item), nowMs)
    + 0.1 * freqScore(item?.hits)
  return item?.archived ? base * ARCHIVED_WEIGHT : base
}

/**
 * 归档分：0.7×(importance/5) + 0.2×时间 + 0.1×频率（没有 query，用重要度顶替"相关"）。
 * @param {object} item
 * @param {number} [nowMs]
 */
export function decayScore(item, nowMs = Date.now()) {
  const importance = clampInt(item?.importance, 1, 5, 3)
  const base = 0.7 * (importance / 5)
    + 0.2 * timeScore(lastSeenOf(item), nowMs)
    + 0.1 * freqScore(item?.hits)
  return item?.archived ? base * ARCHIVED_WEIGHT : base
}

/** 注入块开头：说清"这是长期记忆，不是对方刚说的话"（错误归因是这个注入点最容易出的问题）。 */
export const INJECT_HEADER = '[记忆·事实（长期记忆，不是对方刚说的话）]'

/**
 * 会话级静态前缀里事实块的开头（与每轮 hint 分开命名：一个进会话历史常驻，一个只活一轮，
 * 排障时一眼能看出这行是从哪儿来的）。
 */
export const PREFIX_HEADER = '[长期记忆·常驻事实（会话级，不是对方刚说的话）]'

/**
 * 渲染排好序的候选 → `{ text, ids, texts }`。
 * 为什么要把 ids 带出来：前缀注入之后，同一批事实不能再进每轮 hint（否则同一句话付两遍钱），
 * 调用方要靠 ids 排除；只要 text 的话，"哪些条目最终被预算收下"就说不清了。
 * @param {Array<{item?:{id?:string,text:string}, text?:string}>} rows
 * @param {{maxChars?:number, maxItems?:number, header?:string}} [opts]
 * @returns {{text:string, ids:string[], texts:string[]}}
 */
export function renderRows(rows, opts = {}) {
  const budget = clampInt(opts.maxChars, MIN_INJECT_CHARS, HARD_INJECT_MAX_CHARS, DEFAULT_INJECT_MAX_CHARS)
  const maxItems = clampInt(opts.maxItems, 1, MAX_INJECT_ITEMS, 10)
  const header = String(opts.header ?? INJECT_HEADER) || INJECT_HEADER
  const selected = (Array.isArray(rows) ? rows : []).slice(0, maxItems)
  const lines = []
  const ids = []
  const texts = []
  let used = charLength(header)
  for (const row of selected) {
    const text = normalizeText(row?.item?.text ?? row?.text)
    if (!text) continue
    const line = `\n- ${text}`
    const lineLen = charLength(line)
    if (used + lineLen <= budget) {
      lines.push(line)
      ids.push(String(row?.item?.id ?? ''))
      texts.push(text)
      used += lineLen
      continue
    }
    // 剩余预算里塞一条截断的（至少 8 字才有意义，否则直接停）
    const remain = budget - used - charLength('\n- ') - 1
    if (remain >= 8) {
      lines.push(`\n- ${clipChars(text, remain)}…`)
      // 截断的条目**不进 ids**：前缀里只有半条事实时，hint 仍应完整带一遍（只多付这一条）
      used = budget
    }
    break
  }
  return { text: lines.length ? header + lines.join('') : '', ids, texts }
}

/**
 * 把排好序的候选渲染成一段提示，**硬截断到 maxChars 字**：
 * 放不下整条就按剩余字数截断并加 "…"，再放不下就停 —— 绝不超预算、绝不切碎 emoji。
 * @param {Array<{item?:{text:string}, text?:string}>} rows
 * @param {{maxChars?:number, maxItems?:number, header?:string}} [opts]
 * @returns {string} 没有可用条目时返回 ''（调用方据此决定不注入）
 */
export function renderInjection(rows, opts = {}) {
  return renderRows(rows, opts).text
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const text = normalizeText(raw.text)
  const chatKey = String(raw.chatKey ?? '').trim()
  if (!text || !chatKey) return null
  const at = Number(raw.at)
  const createdAt = Number.isFinite(at) ? at : 0
  const hits = Math.max(0, Math.trunc(Number(raw.hits) || 0))
  const lastHitAt = Number(raw.lastHitAt)
  const archivedAt = Number(raw.archivedAt)
  return {
    id: String(raw.id || `m-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    text,
    source: String(raw.source || 'unknown').slice(0, 40),
    chatKey: chatKey.slice(0, 64),
    at: createdAt,
    importance: clampInt(raw.importance, 1, 5, 3),
    hits,
    lastHitAt: Number.isFinite(lastHitAt) ? lastHitAt : createdAt,
    archived: raw.archived === true,
    archivedAt: raw.archivedAt != null && Number.isFinite(archivedAt) ? archivedAt : null,
  }
}

function normalizeState(data) {
  const items = Array.isArray(data?.items) ? data.items.map(normalizeItem).filter(Boolean) : []
  return { version: MEMORY_VERSION, updatedAt: String(data?.updatedAt || ''), items }
}

/**
 * 把 options.embedding 解析成客户端：
 *   · 传已构造好的客户端（有 embed 函数）= 直接用（测试 / 上层复用同一个实例）；
 *   · 传配置（baseUrl + model …）= 现造一个；缺 baseUrl 或 model 视为没配，返回 null；
 *   · 没传 / 空对象 = 纯关键词模式（这也是默认形态）。
 */
function resolveEmbeddingClient(spec, deps) {
  if (!spec || typeof spec !== 'object') return null
  if (typeof spec.embed === 'function') return spec.enabled === false ? null : spec
  const client = createEmbeddingClient({ ...spec, now: deps.now, log: deps.log })
  return client.enabled ? client : null
}

/**
 * 打开（或新建）一份事实记忆库。
 *
 * @param {object} options
 * @param {string} options.file items.json 的绝对路径
 * @param {() => number} [options.now] 时钟（测试用）
 * @param {{warn?:Function, info?:Function, debug?:Function}} [options.log]
 * @param {string} [options.vectorsFile] 向量缓存路径（默认 items.json 同目录的 vectors.json）
 * @param {number} [options.semanticWeight] 语义权重 0–1（默认 0.6）
 * @param {number} [options.minSimilarity] 纯语义命中门槛（默认 0.45）
 * @param {object|Function} [options.embedding] embedding 配置或现成客户端（不传 = 纯关键词）
 */
export function createMemoryStore(options = {}) {
  if (!options.file) throw new Error('createMemoryStore 缺少 file')
  const file = path.resolve(String(options.file))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = options.log || null
  const embedding = resolveEmbeddingClient(options.embedding, { now, log })
  const semanticWeight = clampFloat(
    options.semanticWeight ?? options.embedding?.semanticWeight,
    0, 1, DEFAULT_SEMANTIC_WEIGHT,
  )
  const minSimilarity = clampFloat(
    options.minSimilarity ?? options.embedding?.minSimilarity,
    0, 1, DEFAULT_MIN_SIMILARITY,
  )
  const vectorsFile = path.resolve(String(options.vectorsFile || path.join(path.dirname(file), 'vectors.json')))
  let state = null

  // 向量缓存（懒创建：没配 embedding 就一个字节都不写）
  let vectors = null
  const vectorsOf = () => {
    if (!vectors) vectors = createVectorStore({ file: vectorsFile, log, now })
    return vectors
  }

  // query 向量内存缓存：同一句话 10 分钟内复用（回话前那条链路最容易被它救）
  const queryCache = new Map()
  // 向量任务串行化：写缓存只走一条队，避免并发读改写把彼此覆盖
  let vectorJob = Promise.resolve()
  function enqueueVectorJob(fn) {
    vectorJob = vectorJob.then(fn).catch((e) => {
      log?.debug?.(`[记忆·语义] 向量任务失败（已忽略）：${e?.message || e}`)
    })
    return vectorJob
  }

  const freshState = () => ({ version: MEMORY_VERSION, updatedAt: new Date(now()).toISOString(), items: [] })

  /**
   * 读盘（只读一次，之后走内存）。文件不存在 = 空库；
   * 文件损坏 → 抛错（**绝不自动覆盖**，让上层报出来给人处理）。
   */
  function load() {
    if (state) return state
    let data
    try {
      data = readJsonFile(file)
    } catch (e) {
      if (e?.code === 'ENOENT') {
        state = freshState()
        return state
      }
      throw new Error(`记忆文件无法读取/解析（${file}）：${e.message}`)
    }
    state = normalizeState(data)
    return state
  }

  /** 落盘成功后才换内存状态；mutate 里抛错则不落盘、状态不变。 */
  function commit(mutate) {
    const current = load()
    const draft = {
      version: MEMORY_VERSION,
      updatedAt: new Date(now()).toISOString(),
      items: current.items.map((item) => ({ ...item })),
    }
    const result = mutate(draft)
    writeJsonFileSync(file, draft)
    state = draft
    return result
  }

  /**
   * 存一条事实。同会话同正文 = 重复提及：hits+1、重要度取高、归档的复活，不新增条目。
   * @param {string} rawText
   * @param {{chatKey?:string, importance?:number, source?:string, at?:number}} [opts]
   * @returns {{item:object, merged:boolean}}
   */
  function add(rawText, opts = {}) {
    const text = normalizeText(rawText)
    if (!text) throw new Error('记忆正文不能为空')
    const chatKey = String(opts.chatKey ?? '').trim()
    if (!chatKey) throw new Error('记忆缺少 chatKey（不知道属于哪条会话）')
    const importance = clampInt(opts.importance, 1, 5, 3)
    const source = String(opts.source || 'tool').slice(0, 40)
    const at = Number.isFinite(Number(opts.at)) ? Number(opts.at) : now()
    return commit((draft) => {
      const dup = draft.items.find((item) => item.chatKey === chatKey && item.text === text)
      if (dup) {
        dup.hits += 1
        dup.lastHitAt = at
        dup.importance = Math.max(dup.importance, importance)
        if (dup.archived) {
          dup.archived = false
          dup.archivedAt = null
        }
        return { item: { ...dup }, merged: true }
      }
      const item = {
        id: `m-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        source,
        chatKey,
        at,
        importance,
        hits: 0,
        lastHitAt: at,
        archived: false,
        archivedAt: null,
      }
      draft.items.push(item)
      return { item: { ...item }, merged: false }
    })
  }

  /**
   * 关键词检索（带时间衰减）。给了 query 就只返回 **有命中** 的条目（找不到就是空数组，别拿不相关的糊弄）。
   * 归档条目也会返回，但分数 ×0.4。
   * @param {string} rawQuery
   * @param {{chatKey?:string, limit?:number, now?:number}} [opts]
   * @returns {Array<{item:object, relevance:number, score:number}>}
   */
  function recall(rawQuery, opts = {}) {
    const chatKey = String(opts.chatKey ?? '').trim()
    const limit = clampInt(opts.limit, 1, 20, 5)
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : now()
    const tokens = tokenize(rawQuery)
    const rows = []
    for (const item of load().items) {
      if (chatKey && item.chatKey !== chatKey) continue
      const relevance = relevanceOf(tokens, item.text)
      if (tokens.length > 0 && relevance <= 0) continue
      rows.push({ item: { ...item }, relevance, score: rankScore(item, tokens, nowMs) })
    }
    rows.sort((a, b) => b.score - a.score || b.item.at - a.item.at)
    return rows.slice(0, limit)
  }

  /**
   * 每轮注入用的挑选：本会话的**未归档**事实，相关的排前面；没有相关命中就按
   * 重要度/新鲜度（decayScore）兜底（这样"置顶事实"每轮都在）。
   * `excludeIds` = 已经进了会话级静态前缀的那批事实：它们常驻在历史里，**不能再进 hint**，
   * 否则同一句话每轮付两遍 token（这正是 L1 常驻改造要消掉的开销）。
   * @param {{chatKey?:string, query?:string, maxChars?:number, maxItems?:number, now?:number, excludeIds?:Iterable<string>}} [opts]
   * @returns {string} 拼好的提示段（≤ maxChars 字）；没有可注入的返回 ''
   */
  function buildInjection(opts = {}) {
    const chatKey = String(opts.chatKey ?? '').trim()
    if (!chatKey) return ''
    const exclude = new Set([...(opts.excludeIds ?? [])].map(String))
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : now()
    const tokens = tokenize(opts.query)
    const rows = []
    for (const item of load().items) {
      if (item.chatKey !== chatKey) continue
      if (item.archived) continue // 归档的不进每轮注入（memory_recall 仍然搜得到）
      if (exclude.has(item.id)) continue // 已经常驻在前缀里：hint 不再重复
      rows.push({
        item,
        relevance: relevanceOf(tokens, item.text),
        score: rankScore(item, tokens, nowMs),
        decay: decayScore(item, nowMs),
      })
    }
    rows.sort((a, b) => {
      const aHit = a.relevance > 0 ? 1 : 0
      const bHit = b.relevance > 0 ? 1 : 0
      if (aHit !== bHit) return bHit - aHit
      return (aHit ? b.score - a.score : b.decay - a.decay) || b.item.at - a.item.at
    })
    return renderInjection(rows, { maxChars: opts.maxChars, maxItems: opts.maxItems })
  }

  /**
   * 会话级静态前缀用的**稳定**事实块：本会话未归档事实，按「重要度降序 → 新→旧」排，**不含时间因子**
   * （前缀要稳定，不能因为"30 天新鲜度衰减"隔三差五变一次、白触发一次刷新）。
   *
   * 返回 `{ text, ids, version }`：
   *   · `text` 进会话历史常驻（L1 层，只发一次）；
   *   · `ids` 给 `buildInjection({excludeIds})` 排除，保证同一批事实不再进每轮 hint；
   *   · `version` 是内容指纹（id+正文），驱动靠它判断"变了才刷新"。
   * @param {{chatKey?:string, maxChars?:number, maxItems?:number}} [opts]
   * @returns {{text:string, ids:string[], version:string}}
   */
  function buildStableInjection(opts = {}) {
    const chatKey = String(opts.chatKey ?? '').trim()
    if (!chatKey) return { text: '', ids: [], version: '' }
    const rows = []
    for (const item of load().items) {
      if (item.chatKey !== chatKey) continue
      if (item.archived) continue
      rows.push({ item })
    }
    rows.sort((a, b) => (b.item.importance - a.item.importance)
      || (b.item.at - a.item.at)
      || (a.item.id < b.item.id ? -1 : 1))
    const rendered = renderRows(rows, {
      maxChars: opts.maxChars,
      maxItems: opts.maxItems,
      header: PREFIX_HEADER,
    })
    if (!rendered.text) return { text: '', ids: [], version: '' }
    const version = crypto.createHash('sha1')
      .update(rendered.ids.map((id, i) => `${id}:${rendered.texts[i] ?? ''}`).join('|'))
      .digest('hex')
    return { text: rendered.text, ids: rendered.ids, version }
  }

  /**
   * 三因子归档（软删除）：只归档 **未归档 + importance<5 + 超过 minAgeDays 没出现 + decayScore<threshold** 的。
   * @param {{threshold?:number, minAgeDays?:number, now?:number}} [opts]
   * @returns {{archived:number, total:number}}
   */
  function prune(opts = {}) {
    const threshold = clampFloat(opts.threshold, 0, 1, 0.2)
    const minAgeDays = clampInt(opts.minAgeDays, 0, 3650, 90)
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : now()
    const current = load()
    const ids = []
    for (const item of current.items) {
      if (item.archived) continue
      if (item.importance >= 5) continue // 核心规则：重要度 5 永不归档
      const ageDays = Math.max(0, (nowMs - lastSeenOf(item)) / DAY_MS)
      if (ageDays < minAgeDays) continue
      if (decayScore(item, nowMs) >= threshold) continue
      ids.push(item.id)
    }
    if (!ids.length) return { archived: 0, total: current.items.length }
    const want = new Set(ids)
    commit((draft) => {
      for (const item of draft.items) {
        if (!want.has(item.id)) continue
        item.archived = true
        item.archivedAt = nowMs
      }
      return null
    })
    log?.debug?.(`[记忆] 归档 ${ids.length} 条低分旧事实（共 ${current.items.length} 条）`)
    return { archived: ids.length, total: current.items.length }
  }

  /** 命中计数：hits+1、lastHitAt=now（只在工具 recall 时调；注入不写盘）。 */
  function touch(ids, at = null) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String))
    if (!want.size) return 0
    if (!load().items.some((item) => want.has(item.id))) return 0
    const atMs = Number.isFinite(Number(at)) ? Number(at) : now()
    return commit((draft) => {
      let n = 0
      for (const item of draft.items) {
        if (!want.has(item.id)) continue
        item.hits += 1
        item.lastHitAt = atMs
        n += 1
      }
      return n
    })
  }

  /** 读全部条目（拷贝；不传 chatKey = 全库，测试/排查用）。 */
  function all(chatKey = '') {
    const key = String(chatKey ?? '').trim()
    return load().items.filter((item) => !key || item.chatKey === key).map((item) => ({ ...item }))
  }

  /** 丢掉内存缓存，下次操作重新读盘（控制台手改文件后用）。 */
  function reload() {
    state = null
  }

  return { file, add, recall, buildInjection, buildStableInjection, prune, touch, all, reload }
}

/**
 * vision — 看图：一张本地图片 → 一段中文描述（走 OpenAI 兼容的 /chat/completions）
 *
 * 为什么需要它：
 *   DSH 这条 QQ 线的会话模型（deepseek-flash）**不收图片输入**，内核正确的做法是丢图 + 如实告知，
 *   所以机器人只会说"图片我收不到"。丢图以后"识别表情包 / 自动打标"整条链全断。
 *   这里先用视觉接口把图**转成文字**，纯文本模型照样能"看见"——不换模型、不动会话。
 *
 * 三条纪律（跟 stickers 插件同一套）：
 *  ① **失败一律返回 null**：看图挂了只记日志，绝不能让聊天哑掉（调用方按"没看见"降级）。
 *  ② **凭据只从配置来**：`runtime.vision.apiKey`；日志里只出现模型名，不出现 key。
 *  ③ **同一张图不重复花钱**：按文件内容哈希缓存（表情包会反复出现，缓存命中率很高）。
 *
 * 配置（config.json 顶层 `vision`，全部可选）：
 *   enabled   true/false，默认 true（但 apiKey + baseUrl 缺一个就是关）
 *   baseUrl   https://open.bigmodel.cn/api/paas/v4   （结尾不要带 /chat/completions）
 *   apiKey    视觉服务的 key
 *   model     glm-4v-flash（免费的够用）
 *   maxTokens 600      输出上限（glm-4v-flash 硬上限 1024）
 *   timeoutMs 30000    单张超时
 *   maxBytes  8388608  超过就不传（省流量、也避免 400）
 */

import fs from 'node:fs'
import crypto from 'node:crypto'

/** 按魔数认图片类型：扩展名不可信（QQ 的图经常 .jpg 但其实 png/gif）。 */
export function detectMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return 'image/jpeg'
}

/** 把模型答案压成一行好读的中文（换行太多塞进 prompt 会撑爆一条消息）。 */
function flatten(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
    .trim()
}

/**
 * @param {{cfg?:object, log?:{info:Function,warn:Function,debug:Function}}} opts
 * @returns {{enabled:boolean, model:string, describeImage:(file:string, prompt?:string)=>Promise<string|null>}}
 */
export function createVision({ cfg = {}, log = console } = {}) {
  const baseUrl = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.apiKey || '').trim()
  const model = String(cfg.model || 'glm-4v-flash').trim()
  const maxTokens = Math.max(1, Math.min(1024, Number(cfg.maxTokens) || 600))
  const timeoutMs = Math.max(3000, Number(cfg.timeoutMs) || 30000)
  const maxBytes = Math.max(64 * 1024, Number(cfg.maxBytes) || 8 * 1024 * 1024)
  const cacheLimit = Math.max(0, Number(cfg.cacheLimit) || 200)
  const enabled = cfg.enabled !== false && Boolean(baseUrl) && Boolean(apiKey)

  if (cfg.enabled !== false && !enabled) {
    log.warn('[识图] 没配对（缺 baseUrl 或 apiKey）→ 识图关闭，图片仍按原样丢给模型')
  }

  /** 内容哈希 → 描述。只在内存里，重启就空（够用，且不用管清理）。 */
  const cache = new Map()
  function cacheGet(k) {
    if (!cache.has(k)) return null
    const v = cache.get(k)
    cache.delete(k) // LRU：命中就挪到最后
    cache.set(k, v)
    return v
  }
  function cachePut(k, v) {
    if (cacheLimit <= 0) return
    cache.set(k, v)
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value)
  }

  /**
   * 看一张图。
   * @param {string} file 本地路径
   * @param {string} [prompt] 追加的指令（默认"客观描述"）
   * @returns {Promise<string|null>} 失败/没开/文件不对 → null
   */
  async function describeImage(file, prompt = '') {
    if (!enabled) return null
    const p = String(file || '').trim()
    if (!p) return null
    let buf
    try {
      const st = fs.statSync(p)
      if (!st.isFile() || st.size <= 0) return null
      if (st.size > maxBytes) {
        log.warn(`[识图] 跳过 ${p}：${st.size}B 超过上限 ${maxBytes}B`)
        return null
      }
      buf = fs.readFileSync(p)
    } catch (e) {
      log.debug?.(`[识图] 读不到 ${p}: ${e.message}`)
      return null
    }

    const hash = crypto.createHash('sha1')
      .update(buf)
      .update('|')
      .update(String(prompt || ''))
      .digest('hex')
    const hit = cacheGet(hash)
    if (hit) return hit

    const mime = detectMime(buf)
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    const ask = String(prompt || '').trim()
      || '客观描述这张图：画面里是什么、图上的文字（照抄）、整体情绪/氛围。80 字以内，不要解释你在做什么。'

    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: ask },
        ],
      }],
    }

    const started = Date.now()
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        log.warn(`[识图] HTTP ${res.status}（${model}）：${String(detail).slice(0, 200)}`)
        return null
      }
      const json = await res.json()
      const raw = String(json?.choices?.[0]?.message?.content || '').trim()
      if (!raw) {
        log.warn(`[识图] ${model} 返回空内容`)
        return null
      }
      // 自定义提示词 = 调用方要按行解析（表情包打标就是「看/用/词」五行）→ 原样返回，绝不能压成一行；
      // 只有默认那套"随口描述"才压成一行（塞进 prompt 更好读）。
      const text = prompt && String(prompt).trim() ? raw : flatten(raw)
      log.info(`[识图] ${model} ${Date.now() - started}ms ${buf.length}B → ${text.slice(0, 40)}…`)
      cachePut(hash, text)
      return text
    } catch (e) {
      const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message
      log.warn(`[识图] 失败（${model}）：${why}`)
      return null
    }
  }

  return { enabled, model, dropImages: cfg.dropImages !== false, describeImage }
}

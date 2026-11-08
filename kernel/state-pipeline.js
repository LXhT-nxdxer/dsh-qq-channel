/**
 * kernel/state-pipeline.js — 会话状态 / 入站管线 / **唯一出站实现**。
 *
 * 这里替代历史实现里散落的一堆隐式共享 Map（lastSendAt / followUp / turnAnchor / spontTurn…）：
 * 状态收进 ChatState，回合串行进 ChatState.serialize，出站只剩 createDeliver 一份。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { STAGES, createTurnContext, isMasterPrivate } from '../contracts.js'
import {
  escapeCq, extractAtMarkers, sanitizeSensitive, toWellFormedText, splitLongText, clipChars,
} from './format.js'

/** 本轮 TurnContext 的 AsyncLocalStorage：工具执行时 `currentTurn()` 靠它取（契约 bot.currentTurn） */
export const turnStore = new AsyncLocalStorage()

export function currentTurn() {
  return turnStore.getStore() ?? null
}

// ============================================================
// 会话状态
// ============================================================

const emptyChatState = () => ({
  lastSendAt: 0,      // 自发接话的"静默期"判据
  lastInboundAt: 0,
  followUpUntil: 0,   // "@ 之后同一人补发的正文"接续窗口截止时间
  followUpCache: null, // 接续窗口里挂起的引用/图片
  lastContextId: null, // 群上文水位（只补新消息，不整份重发）
  turnQueue: [],      // 引用锚队列：每轮 wake 后 push { triggerId, arrived, at }
})

export class ChatState {
  constructor({ log = console, turnAnchorTtlMs = 300000 } = {}) {
    this.log = log
    this.turnAnchorTtlMs = turnAnchorTtlMs
    this.map = new Map()
    this.chains = new Map() // chatKey → 该线"上一轮结束"的 promise
  }

  get(chatKey) {
    const k = String(chatKey)
    let s = this.map.get(k)
    if (!s) { s = emptyChatState(); this.map.set(k, s) }
    return s
  }

  /**
   * 同一个会话（QQ 线）**串行**跑回合。
   * 以前两轮可以交错：后一轮顶掉引用锚 + DSH 会话里两轮上下文搅在一起 → 前一轮的回答挂到
   * 后一条消息上（甚至像"认错人"）。前一轮抛错也照跑下一轮 —— 不能让一条线卡死，错误只进日志。
   */
  serialize(chatKey, fn) {
    const k = String(chatKey)
    const prev = this.chains.get(k) || Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(k, next.then(() => {}, () => {}))
    return next
  }

  markSent(chatKey) {
    this.get(chatKey).lastSendAt = Date.now()
  }

  // ── 引用锚（旧 markTurnAnchor / turnAnchorFor / countTurnArrival / quoteNeed）──
  // 判据不是"自上次发言以来刷了多少"，而是"唤醒那条 → 这轮回复真的发出去之间插了几条"：
  // 中间插了话 → 回复得挂引用（否则别人不知道在回哪条）；一条没插 → 引用零信息量，不挂。

  /** 每开一轮 push 一个锚。**队列不是单槽**：同群两轮交错时后一轮会顶掉前一轮的锚，
   *  前一轮输出就挂到后一条消息上（线上真实踩过）。出站取队首＝最早那轮。 */
  markTurnAnchor(chatKey, triggerId) {
    if (triggerId == null || !chatKey) return
    const q = this.get(chatKey).turnQueue
    q.push({ triggerId: Number(triggerId), arrived: 0, at: Date.now() })
    while (q.length > 5) q.shift() // 异常情况下别让队列无限长
  }

  /** 取本轮锚；过期（默认 5 分钟）就当没有 —— 免得隔很久的散消息误挂引用 */
  anchorFor(chatKey) {
    const q = this.get(chatKey).turnQueue
    while (q.length && Date.now() - q[0].at > this.turnAnchorTtlMs) q.shift()
    return q[0] || null
  }

  /**
   * 回合还活着就刷新锚的时间（滑动续期，由内核在工具调用/turn 活动时调用）。
   * 长回合（生图 240s + 发媒体 180s + 模型步进）不该在 turn/end 前被 5 分钟锚 TTL 淘汰 ——
   * 一淘汰 autoQuote 就取不到 triggerId，长回合的后半段回复全部丢失引用。
   */
  touchTurnAnchor(chatKey, triggerId) {
    const q = this.get(chatKey).turnQueue
    if (!q.length) return
    const a = triggerId == null ? q[0] : q.find((x) => Number(x.triggerId) === Number(triggerId))
    if (a) a.at = Date.now()
  }

  /** 唤醒之后、回复之前同群又来了几条（跳过唤醒那条自己；队列里每个未答复的锚各记一笔，不串轮） */
  countArrival(chatKey, messageId) {
    for (const a of this.get(chatKey).turnQueue) {
      if (messageId != null && Number(messageId) === a.triggerId) continue
      a.arrived += 1
    }
  }

  /**
   * 这一轮**真正结束**（DSH turn/end）时消费它的锚。
   *
   * 旧桥接的语义：锚从 `turn/start` 活到 `turn/end`，出站取队首＝正在回的那轮；
   * 一轮发多条也只消费一次。**不要**在 prompt admission 时消费 —— 那时模型还没跑，
   * 回复属于哪一轮就说不清了（引错人的根因）。
   * triggerId 不匹配时按 id 兜底删（防御异常/乱序）。
   */
  consumeTurnAnchor(chatKey, triggerId) {
    const q = this.get(chatKey).turnQueue
    if (!q.length) return null
    let idx = 0
    if (triggerId != null && Number(q[0].triggerId) !== Number(triggerId)) {
      idx = q.findIndex((a) => Number(a.triggerId) === Number(triggerId))
      if (idx < 0) return null
    }
    const [removed] = q.splice(idx, 1)
    return removed || null
  }

  /** need = 0 → 永不自动挂（全交给模型显式传 replyTo） */
  quoteNeed(chatKey, need = 1) {
    const n = Number.isFinite(Number(need)) ? Number(need) : 1
    const a = this.anchorFor(chatKey)
    return { allow: n > 0 && !!a && a.arrived >= n, arrived: a ? a.arrived : 0, need: n, triggerId: a ? a.triggerId : null }
  }
}

// ============================================================
// 入站管线
// ============================================================

export class Pipeline {
  constructor({ log = console } = {}) {
    this.log = log
    this.stages = new Map(STAGES.map((s) => [s, []]))
    this._onError = null
  }

  /** 注册插件回调；返回取消函数。order 小的先跑（缺省 100），同 order 按注册顺序。 */
  use(stage, fn, { order = 100, pluginId = '' } = {}) {
    const list = this.stages.get(stage)
    // 阶段名拼错要当场炸：静默不跑 = 功能无声消失，比启动失败难查一百倍
    if (!list) throw new Error(`未知阶段 "${stage}"，只能是 ${STAGES.join(' / ')}`)
    const item = { order: Number(order), pluginId, fn }
    list.push(item)
    list.sort((a, b) => a.order - b.order)
    return () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) }
  }

  /** 旁路监听"插件回调抛异常"（控制台/自检用）；插件异常永远不影响别的插件 */
  onPluginError(fn) {
    this._onError = fn
    return this
  }

  _fail(e, stage, pluginId, ev) {
    this.log.error(`[${stage}] 插件 ${pluginId} 异常: ${e.stack || e.message}`)
    // 两种写法都吃：`pipeline.onPluginError(fn)`（调用注册）或 `pipeline.onPluginError = fn`（赋值）。
    // 赋值会盖掉原型方法 —— 实例上有没有这个属性正好能区分，不用再引入第二个名字。
    const hook = this._onError || (Object.hasOwn(this, 'onPluginError') ? this.onPluginError : null)
    if (typeof hook !== 'function') return
    try { hook(e, { stage, pluginId, ev }) } catch { /* 旁路监听自己崩了也不许影响主流程 */ }
  }

  /**
   * 依次跑五个阶段；没被 stop 且有 wake 才把这一轮交给 terminal（拼 prompt → 交模型）。
   * 容错语义按契约分两种：
   *   · pre-gate **fail-closed**：插件抛错 = 拦住这条（门禁自己都不确定能不能放，就别放）；
   *   · passive-tap **fire-and-forget**：不 await、抛错只记日志（采集/留档不许拖慢也不许弄挂聊天）；
   *   · 其余阶段逐个 try/catch：异常只记日志 + onPluginError，继续下一个。
   */
  async run(ev, terminal) {
    if (!ev || ev.stopped) return undefined
    for (const stage of STAGES) {
      for (const s of [...this.stages.get(stage)]) {
        if (ev.stopped) break
        if (stage === 'passive-tap') {
          try { Promise.resolve(s.fn(ev)).catch((e) => this._fail(e, stage, s.pluginId, ev)) }
          catch (e) { this._fail(e, stage, s.pluginId, ev) }
          continue
        }
        try {
          await s.fn(ev)
        } catch (e) {
          if (stage === 'pre-gate') {
            ev.stopped = true
            ev.stopReason = `pre-gate 插件异常(${s.pluginId})`
          }
          this._fail(e, stage, s.pluginId, ev)
        }
      }
      if (ev.stopped) return undefined
    }
    if (!ev.wake) return undefined // 没唤醒 = 这条不归模型管
    // 唤醒通过才创建 TurnContext，并挂进 AsyncLocalStorage —— 贯穿 prompt/工具/出站，turn/end 时自然失效
    ev.turnCtx = createTurnContext(ev)
    return turnStore.run(ev.turnCtx, () => terminal(ev))
  }
}

// ============================================================
// 出站：唯一实现
// ============================================================

/** 单条正文上限的合法范围（与控制台 admin/schema.js 一致）。 */
export const REPLY_MAX_LENGTH_MIN = 100
export const REPLY_MAX_LENGTH_MAX = 100000
export const REPLY_MAX_LENGTH_FALLBACK = 3000

/** 把「任意输入」收成数字（只认数字或非空数字字符串；null/''/true 都算非法，别被 Number() 骗）。 */
const toNumOrNaN = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN))

/**
 * 配置来源用的**严格**夹紧：落在 [100, 100000]，非法值回落 3000。
 *
 * 为什么必须夹：`replyMaxLength` 来自 config.json，**手改不受控制台 schema 约束**。
 * 配成 0 / 负数时 deliver 的 `text.length > replyMaxLength` 恒成立 → 所有正文一律抛
 * 「超过上限」，等于整个机器人哑了；这类值没人会故意填，只能是手滑或迁移出错。
 * 下限取 100（与控制台一致）：1~99 也基本等于「什么都发不出去」。
 */
export function normalizeReplyMaxLength(v) {
  const n = toNumOrNaN(v)
  if (!Number.isFinite(n) || n <= 0) return REPLY_MAX_LENGTH_FALLBACK
  return Math.min(REPLY_MAX_LENGTH_MAX, Math.max(REPLY_MAX_LENGTH_MIN, Math.round(n)))
}

/**
 * 构造期的**宽松**版：只挡明显非法（0 / 负数 / NaN / 非数字）→ 3000，正数原样（只夹上限）。
 *
 * 为什么不在这里也把下限抬到 100：`createDeliver` 是公开 API，单测/嵌入方会故意传 20
 * 造「超限报错」场景（test/audit-kernel-outbound.test.js）；生产路径的配置值已经不经过这里
 * —— loadConfig 会先夹紧，热重载走 deliver.configure 的严格版。
 */
function initialReplyMaxLength(v) {
  const n = toNumOrNaN(v)
  if (!Number.isFinite(n) || n <= 0) return REPLY_MAX_LENGTH_FALLBACK
  return Math.min(REPLY_MAX_LENGTH_MAX, Math.round(n))
}

/**
 * 长文卡片参数收口：
 *   · threshold ≤ 0 / 非法 = 0（语义见使用处：0 = 用单条上限，等于关卡片）；
 *   · chunkSize 夹在 [200, 5000]（sendLongAsForward 里还有一层 max(200, …) 兜底，
 *     这里在配置入口再收一次，免得 1e9 之类的值把卡片切成怪物/把参数顶爆）。
 */
export function normalizeLongForward(longForward = {}) {
  const out = { ...(longForward || {}) }
  const threshold = toNumOrNaN(out.threshold)
  out.threshold = Number.isFinite(threshold) && threshold > 0 ? Math.min(100000, Math.round(threshold)) : 0
  const chunk = toNumOrNaN(out.chunkSize)
  out.chunkSize = Number.isFinite(chunk) && chunk > 0 ? Math.min(5000, Math.max(200, Math.round(chunk))) : 800
  return out
}

/**
 * 超长消息 → 合并转发卡片（需求：超长消息发成一张卡片，不刷屏）。
 * 卡片失败要**降级成普通分段**，话不能吞。独立成函数只是为了让 deliver 读得完。
 */
async function sendLongAsForward({ napcat, log, target, text, longForward, replyMaxLength }) {
  const lf = longForward || {}
  const chunk = Math.max(200, Number(lf.chunkSize) || 800)
  const name = String(napcat.selfNickname || lf.nodeName || '机器人').slice(0, 24)
  const uin = String(napcat.selfId || '')
  /** 降级：普通分段发送（话不能吞）。 */
  const sendPlain = async () => {
    const parts = splitLongText(text, { max: replyMaxLength })
    let messageId = null
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500)) // 同一秒灌一堆像刷屏
      messageId = await napcat.sendMessage(target, escapeCq(parts[i]))
    }
    return { messageId, mode: 'forward-fallback' }
  }
  // uin 是卡片节点的必填字段：重启后登录信息还没取到（selfId 为空）时发出去协议端会拒，
  // 白等一次失败再降级。这里直接分段，简单可靠（等登录信息重试反而可能拖住这一轮）。
  if (!uin) {
    log.warn(`[出站] 合并转发缺 uin（登录信息未就绪），直接分段发送 (${target})`)
    return sendPlain()
  }
  const nodes = splitLongText(text, { max: chunk }).map((t) => ({
    type: 'node',
    data: { uin, name, content: [{ type: 'text', data: { text: escapeCq(t) } }] },
  }))
  try {
    // 合并转发同样非幂等：retries:0（同一张卡片发两遍比发失败还糟）
    const messageId = await napcat.sendForward(target, nodes, {
      timeoutMs: Number(lf.timeoutMs) > 0 ? Number(lf.timeoutMs) : 180000,
      retries: 0,
    })
    log.info(`[出站] 超长消息 ${text.length} 字 → 合并转发卡片 ${nodes.length} 节 (${target})`)
    return { messageId, mode: 'forward' }
  } catch (e) {
    log.warn(`[出站] 合并转发卡片失败 (${target}): ${e.message} → 降级普通分段发送`)
    return sendPlain()
  }
}

/**
 * 构造**唯一出站口** `deliver(target, text, opts)`，并在它身上挂两个东西：
 *   · `deliver.onDecorate(fn)` —— 插件挂出站装饰（契约 bot.onOutbound；引用锚定夺/拆条/自发轮去引用）
 *   · `deliver.media(target, cqBody, caption)` —— 带媒体 CQ 串的出站（契约 bot.sendMedia）
 *
 * deliver 内部四步是契约硬编码顺序（OUTBOUND_PHASE）：① 抽 [AT:] → ② 脱敏+合法化 → ③ decorate → ④ 发送+留档。
 * ⚠️ ①② 顺序反了会出大事（自检逮到过）：先脱敏会把 `[AT:qq=123]` 的号码变成 [已隐去]，
 *   标记当场废掉 → @ 静默失效，而且只在非豁免会话里失效，极难发现。
 *
 * @param {{napcat: object, log?: object, adminQq?: number|string|null, longForward?: object, replyMaxLength?: number,
 *          onAfterSend?: Function, outboundHooks?: Function[]}} cfg
 *   onAfterSend(rec) —— 发送成功后的落点：留档 + ChatState.markSent 都收口在这儿
 *   （deliver 不持有 ChatState，免得同一份状态两处写）
 *   outboundHooks —— 宿主自己的出站钩子数组（与 deliver.onDecorate 同一个池子，便于宿主把
 *   `bot.onOutbound` 直接接进去；不传就内部自建）
 */
export function createDeliver({ napcat, log = console, adminQq = null, longForward = {}, replyMaxLength = 3000, onAfterSend = null, outboundHooks = [] }) {
  const hooks = outboundHooks
  // 入参收口：配置/调用方给了 0、负数、NaN 时不能一路带进「凡正文必报错」的死路
  replyMaxLength = initialReplyMaxLength(replyMaxLength)
  longForward = normalizeLongForward(longForward)

  async function deliver(target, text, opts = {}) {
    const m = /^(group|private):(\d{1,12})$/.exec(String(target ?? ''))
    if (!m) throw new Error(`target 格式错误: "${target}"，应为 group:<群号> 或 private:<QQ号>`)
    const to = `${m[1]}:${m[2]}`
    const raw = toWellFormedText(text ?? '')
    if (!raw.trim()) throw new Error('text 不能为空')
    // ① 先抽 @ 标记，再脱敏（顺序理由见函数头注释）
    const atMarkers = extractAtMarkers(raw)
    // ② 脱敏：命中即清除该字段后照发；唯一豁免是主人私聊（脱敏豁免）
    const exempt = isMasterPrivate(to, adminQq)
    const safe = sanitizeSensitive(atMarkers.text, { exempt })
    const ats = (Array.isArray(opts.ats) ? opts.ats : []).map(Number).filter((q) => Number.isInteger(q) && q > 0)
    ats.push(...atMarkers.qq)
    if (atMarkers.names.length) {
      if (m[1] === 'group') {
        for (const nm of atMarkers.names) {
          const q = await napcat.resolveMemberByName?.(m[2], nm) // 测试桩可能没有成员表
          if (q) ats.push(q)
          else log.warn(`[出站] 群 ${m[2]} 里找不到「${nm}」，这条 @ 不了（消息照发）`)
        }
      } else log.warn(`[出站] 私聊里无法解析 [AT:名字]（${atMarkers.names.join('/')}），已忽略`)
    }
    // ③ decorate：钩子可改 text / ats / replyTo / mode。钩子抛错只记日志 —— 话不能因为钩子崩了被吞
    const rawRt = Number(opts.replyTo)
    const out = {
      target: to,
      text: toWellFormedText(safe.text),
      ats: [...new Set(ats)],
      replyTo: opts.replyTo == null || !Number.isInteger(rawRt) || rawRt <= 0 ? null : rawRt,
      noReply: opts.replyTo !== undefined && opts.replyTo !== null && rawRt === 0,
      mode: 'plain',
      turnCtx: opts.turnCtx ?? null,
      // 只有"模型通过 send_message 工具发的回复"才允许内核自动挂引用。
      // 命令 / 答应声 / 冷却 / 生图失败提示等出站没有自己的回合上下文，挂引用只会引错人。
      autoQuote: opts.autoQuote === true,
    }
    for (const fn of [...hooks]) {
      try { await fn(out) } catch (e) { log.error(`[出站] decorate 钩子异常(忽略): ${e.stack || e.message}`) }
    }
    // 钩子可以显式拦下这一条（例：主动接话一轮最多 2 条）：抛错会被上面吞掉继续发，所以用标记位
    if (out.blocked) throw new Error(out.blockReason || '消息被出站钩子拦下')
    // ④ 发送：超长走卡片 / 超上限报错 / 其余单条
    const lf = longForward || {}
    const forwardLimit = Number(lf.threshold) > 0 ? Number(lf.threshold) : replyMaxLength
    // @/引用是挂在单条消息上的语义，卡片承载不了 —— 有 @ 或引用时保持普通发送（长文场景基本也用不到）
    // out.noForward：主动接话轮等场景要求"不套卡片"（群友随口接一句不该甩一张卡片）
    const wantForward = out.mode === 'forward'
      || (lf.enabled !== false && out.text.length > forwardLimit && !out.ats.length && out.replyTo == null && out.noForward !== true)
    if (!wantForward && out.text.length > replyMaxLength) {
      throw new Error(`内容 ${out.text.length} 字超过上限 ${replyMaxLength} 字，请精简后再发`)
    }
    let wire = ''
    let messageId = null
    let mode = out.replyTo != null ? 'reply' : (out.ats.length ? 'at' : 'plain')
    if (wantForward) {
      ({ messageId, mode } = await sendLongAsForward({ napcat, log, target: to, text: out.text, longForward: lf, replyMaxLength }))
    } else {
      wire = (out.replyTo != null ? `[CQ:reply,id=${out.replyTo}] ` : '')
        + (out.ats.length ? out.ats.map((q) => `[CQ:at,qq=${q}]`).join(' ') + ' ' : '')
        + escapeCq(out.text)
      messageId = await napcat.sendMessage(to, wire)
    }
    const rec = { target: to, text: out.text, ats: out.ats, replyTo: out.replyTo, mode, messageId, hits: safe.hits, wire, turnCtx: out.turnCtx }
    // 每条成功出站都留一行 —— 外部脚本/控制台靠它统计出站量，别改静默
    log.info(`[出站] 发送 ${to} (id=${messageId ?? '?'}, ${out.text.length} 字, ${mode}${safe.hits.length ? ', 脱敏 ' + safe.hits.join('/') : ''})`)
    // 留档 + markSent：留档失败绝不反报"发送失败"（话已经发出去了）
    if (onAfterSend) {
      try { await onAfterSend(rec) } catch (e) { log.warn(`[出站] 留档失败(忽略): ${e.message}`) }
    }
    return rec
  }

  /** 插件挂出站装饰（契约 bot.onOutbound）；返回取消函数。 */
  deliver.onDecorate = (fn) => {
    hooks.push(fn)
    return () => { const i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1) }
  }

  /**
   * 发一条**带媒体的 CQ 串**（契约 bot.sendMedia 的实现；图/视频都走这里）。
   * 与 deliver 共用脱敏 / 长度 / 留档纪律，区别只是正文允许带 CQ 媒体码
   * （deliver 会把正文当纯文本转义，发不了图）。底层 sendMedia 强制零重试。
   */
  deliver.media = async (target, cqBody, caption = '') => {
    const m = /^(group|private):(\d{1,12})$/.exec(String(target ?? ''))
    if (!m) throw new Error(`target 格式错误: "${target}"，应为 group:<群号> 或 private:<QQ号>`)
    const to = `${m[1]}:${m[2]}`
    const exempt = isMasterPrivate(to, adminQq)
    const safe = sanitizeSensitive(String(caption ?? ''), { exempt })
    // caption 只有一句说明：超长截断比整条报错好（媒体必须发出去）
    const cap = clipChars(toWellFormedText(safe.text).trim(), replyMaxLength)
    if (!/^\[CQ:/i.test(String(cqBody || ''))) throw new Error('sendMedia 的 cqBody 必须是 CQ 码串（纯文本请用 deliver）')
    // 装饰钩子对媒体也要跑：主动接话的一轮条数计数、relationship 的冷落计时、入群欢迎的
    // 「模型已出站」判据、context-gap 的让路标记全靠它 —— 只跑 deliver 不跑 media 的话，
    // 「只发了图」的那些轮次这些约束全部静默失效（历史上就是这样漏的）。
    const out = { target: to, text: cap, ats: [], replyTo: null, mode: 'media', turnCtx: turnStore.getStore() ?? null }
    for (const fn of [...hooks]) {
      try { await fn(out) } catch (e) { log.error(`[出站] decorate 钩子异常(忽略-媒体): ${e.stack || e.message}`) }
    }
    if (out.blocked) throw new Error(out.blockReason || '媒体消息被出站钩子拦下')
    // caption 里的 [ ] 会把 CQ 码拆坏，必须转义；cqBody 本身是 CQ 码，不能碰
    const wire = (out.text ? escapeCq(toWellFormedText(out.text)) + ' ' : '') + cqBody
    const messageId = await napcat.sendMedia(to, wire)
    // 媒体消息也带上本轮上下文（主动接话统计"已接"、留档排查都要它）；没有上下文时保持 null
    const rec = { target: to, text: out.text, ats: [], replyTo: null, mode: 'media', messageId, hits: safe.hits, wire, turnCtx: out.turnCtx }
    if (onAfterSend) {
      try { await onAfterSend(rec) } catch (e) { log.warn(`[出站] 留档失败(忽略): ${e.message}`) }
    }
    return rec
  }

  /**
   * 配置热更新（宿主 reloadConfig 用）：脱敏豁免的主人 QQ / 长文卡片阈值 / 单条上限。
   * 引用阈值（quoteAfterMsgs）由宿主的 decorate 钩子现读运行时配置，不在这里。
   * 数值一律走 normalize*：控制台 schema 有范围，但手改 config.json 没有。
   */
  deliver.configure = ({ adminQq: nextAdminQq, longForward: nextLongForward, replyMaxLength: nextReplyMaxLength } = {}) => {
    if (nextAdminQq !== undefined) adminQq = nextAdminQq
    if (nextLongForward !== undefined) longForward = normalizeLongForward(nextLongForward)
    if (nextReplyMaxLength !== undefined) replyMaxLength = normalizeReplyMaxLength(nextReplyMaxLength)
  }

  return deliver
}

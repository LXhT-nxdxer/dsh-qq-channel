/**
 * backfill — 补回复（漏消息补回）
 *
 * 干什么：每 5 分钟看一眼「主人私聊」的历史，找出**她最后一条真回复之后**主人发的消息，
 * 挑最近最多 5 条重新塞回会话，让她补一句。已经补过的 messageId 记在状态文件里，
 * 同一批永远不会补第二遍（幂等）。
 *
 * 为什么需要：她漏回的原因都很日常 —— 模型报错、进程重启、一轮里被后面的话打断、
 * 出站失败。漏掉的那条躺在 QQ 里没人管，主人只能重说一遍。补回复把「漏」变成一个
 * 她自己能修的故障，而不是让主人怀疑她坏了。
 *
 * 为什么读历史判据，而不是自己记账「我回过了」：
 *   内核的出站口把所有回复都发到 QQ 了，NapCat 的历史就是**她到底回过没有**的唯一事实来源。
 *   自己记「我回过了」会在发送失败/丢包时骗自己 —— 那是最坏的一种坏：明明漏了，系统认为没漏。
 *   所以判据只有一条：历史里她最后一条消息，在主人那条之前还是之后。
 *
 * 为什么用 get_friend_msg_history（不是 get_private_msg_history）：
 *   SnowLuma 上后者 retcode 1404（动作不存在），前者实测可用（`bot.napcat.privateHistory`）。
 *   **别改回去**，改了就是每 5 分钟一次静默失败。
 *
 * 三条纪律（改之前先读）：
 *   ① 定时器 **无条件挂载**（启动后先等 60 秒、之后每 intervalMin 分钟）、**unref**；
 *      enabled 只在 tick 内部判断。控制台热改 enabled **不会重跑 setup**，所以 setup 里
 *      不能因为「启动时是关的」就不装定时器（那是真机 bug 的根因）。
 *   ② 一次最多补 5 条（可配）：塞太多旧消息进上下文，她会把话题拉回半小时前。
 *   ③ 失败只记日志，绝不往 QQ 刷错误；`doneIds` **只在提交成功之后**才落盘。
 *
 * 状态位置：`<dataDir>/state/backfill.json`（写插件数据目录，不写进会话）。
 * 首次运行默认只「播种」不补（`seedFirstRun`），否则装插件的瞬间会把历史里所有旧消息补一遍。
 */

import path from 'node:path'

import { clipChars, extractText, sanitizePromptUserText } from '../../kernel/format.js'

/** 连续失败几次开始退避（模型侧挂了别每 5 分钟烧一次）。 */
export const FAIL_THRESHOLD = 3
/** 退避时长：30 分钟。成功一次立刻清零。 */
export const FAIL_COOLDOWN_MS = 30 * 60 * 1000
/**
 * 断档上下文插件（context-gap）刚提醒过同一批消息后，补回复让路多久。
 * 主人已经在对话里了，先让这一轮自然回复接上；超过窗口还没回，补回复再兜底。
 */
export const CONTEXT_GAP_CLAIM_MS = 10 * 60 * 1000

/**
 * setTimeout 的安全上限：**7 天**。
 *
 * 为什么必须有：Node 的 setTimeout 只接受 32 位有符号整数毫秒（上限 2^31-1 ≈ 24.8 天），
 * 超了会**溢出成 1ms** → 变成一个每毫秒 tick 一次的自激循环（每秒几百次 NapCat 历史查询，
 * 一旦发现漏消息还会每轮叫一次模型 = 烧钱 + 刷屏），而且溢出后不会报错，极难发现。
 *
 * 控制台 configSchema 已经把 intervalMin 限在 1–120 分钟、firstDelaySec 限在 0–600 秒，
 * **但手改 config.json 完全不受 schema 约束**（比如 intervalMin: 43200 = 30 天），
 * 所以读取处必须再夹一次。这里统一夹到 7 天：间隔再长就等于"别补了"，不需要更大。
 */
export const MAX_TIMER_DELAY_MS = 7 * 24 * 60 * 60 * 1000
/** 默认检查间隔（分钟）/ 首次延迟（秒）—— 与 configSchema 保持一致。 */
const DEFAULT_INTERVAL_MIN = 5
const DEFAULT_FIRST_DELAY_SEC = 60

/**
 * 把配置里的 `intervalMin`（分钟）换算成**安全的** setTimeout 延迟：1 分钟 ~ 7 天。
 * 非法/缺失（NaN、0、负数、非数字）回落默认 5 分钟。
 */
export function intervalMsOf(cfg = {}) {
  const minutes = toNum(cfg?.intervalMin)
  const safeMin = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MIN
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(60_000, Math.round(safeMin * 60_000)))
}

/**
 * `firstDelaySec`（秒）→ **安全的** setTimeout 延迟：0 ~ 7 天。
 * 非法/缺失回落默认 60 秒（刚启动时 NapCat 往往还没连上，别立刻去查）。
 */
export function firstDelayMsOf(cfg = {}) {
  const sec = toNum(cfg?.firstDelaySec ?? DEFAULT_FIRST_DELAY_SEC)
  const safeSec = Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_FIRST_DELAY_SEC
  return Math.min(MAX_TIMER_DELAY_MS, Math.round(safeSec * 1000))
}

/** 只认数字或非空数字字符串（null/''/true 都算非法，别被 Number() 悄悄转成 0/1）。 */
function toNum(v) {
  return typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN)
}

/**
 * 记一次失败，返回新的退避状态（纯函数，方便单测）。
 * 连续失败到阈值 → 清零连击、开启冷却窗口；否则只累加。
 * @returns {{count:number, failStreak:number, cooldownUntil:number, tripped:boolean}}
 */
export function nextFailureState({ failStreak = 0, cooldownUntil = 0 } = {}, now = Date.now()) {
  const count = Math.max(0, Math.round(Number(failStreak) || 0)) + 1
  if (count >= FAIL_THRESHOLD) {
    return { count, failStreak: 0, cooldownUntil: Number(now) + FAIL_COOLDOWN_MS, tripped: true }
  }
  return { count, failStreak: count, cooldownUntil: Number(cooldownUntil) || 0, tripped: false }
}
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'

/** 私聊 chatKey 前缀（与内核 `private:<QQ>` 约定一致）。 */
const CHAT_PREFIX = 'private:'
/** doneIds 只留最近这么多条：再老的已经被「她后来回了」这件事本身覆盖，不需要无限长记忆。 */
const MAX_TRACKED_IDS = 200
/** 单条消息进 prompt 前截断的字符数（防止一条长文把上下文顶爆）。 */
const MAX_TEXT_CHARS = 160
/** 状态文件版本号（将来结构变了靠它迁移）。 */
export const STATE_VERSION = 1

/** 空状态（首次运行 / 状态文件丢了都从这开始）。 */
export function emptyState() {
  return { version: STATE_VERSION, chats: {} }
}

/** 消息 ID：OneBot 历史条目有的是 `message_id`，有的适配器给 `messageId`。 */
function messageIdOf(m) {
  const id = m?.message_id ?? m?.messageId ?? m?.id
  return id == null ? '' : String(id)
}

/** 发送者 QQ：历史条目 `user_id` / `sender.user_id` 都可能出现。 */
function senderOf(m) {
  return Number(m?.user_id ?? m?.sender?.user_id ?? m?.sender?.userId ?? 0) || 0
}

/** 单条历史的正文：段数组 / CQ 串 / raw_message 全交给 kernel/format 的 extractText，
 *  图片→`[图片]`、表情→`[表情]`，这样「纯图消息」也补得回来且不会渲染成空行。
 *  `message` 取不出正文（纯引用段/空段）时再退回 `raw_message`（有的适配器只在那放全文本）。 */
function textOf(m) {
  const pick = (raw) => String(extractText(raw, null)?.text ?? '').replace(/\s+/g, ' ').trim()
  let body = pick(m?.message ?? '')
  if (!body && typeof m?.raw_message === 'string') body = pick(m.raw_message)
  return clipChars(body, MAX_TEXT_CHARS)
}

/**
 * OneBot 历史 → 内部条目（保持原顺序；**不丢空正文条目**，否则「最后一条回复」的下标会错）。
 * @returns {Array<{id:string, from:number, time:number, text:string}>}
 */
export function normalizeHistory(raw) {
  const out = []
  for (const m of Array.isArray(raw) ? raw : []) {
    const id = messageIdOf(m)
    if (!id) continue
    out.push({ id, from: senderOf(m), time: Number(m?.time ?? 0) || 0, text: textOf(m) })
  }
  return out
}

/** doneIds 去重 + 只留最近 max 条（保持旧→新顺序，尾部最新）。 */
export function pruneIds(ids, max = MAX_TRACKED_IDS) {
  const seen = new Set()
  const kept = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const s = String(id ?? '')
    if (!s || seen.has(s)) continue
    seen.add(s)
    kept.push(s)
  }
  return kept.slice(-Math.max(1, Number(max) || MAX_TRACKED_IDS))
}

/**
 * 挑出「她最后一条真回复之后、主人发的、还没补过的」消息（纯函数，方便单测）。
 *
 * @param {Array} rawMessages OneBot 历史（旧→新）
 * @param {{selfId?:number, adminQq?:number, doneIds?:string[]|Set<string>, limit?:number}} opts
 * @returns {{pending:Array, unreplied:number, dropped:number, lastSelfId:string, total:number}}
 *   pending 是**已经截到最后 limit 条**的待补列表（旧→新）；dropped = 更早、这次没补的条数。
 */
export function pickPending(rawMessages, { selfId = 0, adminQq = 0, doneIds = [], limit = 5 } = {}) {
  const list = normalizeHistory(rawMessages)
  const me = Number(selfId) || 0
  const admin = Number(adminQq) || 0
  const done = doneIds instanceof Set ? doneIds : new Set((Array.isArray(doneIds) ? doneIds : []).map(String))
  const empty = { pending: [], unreplied: 0, dropped: 0, lastSelfId: '', total: list.length }
  // 认不出「她」就认不出「她回过没有」——宁可不补，也不能把她说过的每句话都当没回。
  if (!me || !admin) return empty

  let lastSelf = -1
  for (let i = 0; i < list.length; i += 1) if (list[i].from === me) lastSelf = i

  // 「真回复」= 历史里最后一条她自己发的消息（出站口统一走 NapCat，历史即事实）。
  const missed = list.slice(lastSelf + 1).filter((m) => m.from === admin && m.text && !done.has(m.id))
  const cap = Math.max(1, Number(limit) || 5)
  const pending = missed.slice(-cap)
  return {
    pending,
    unreplied: missed.length,
    dropped: missed.length - pending.length,
    lastSelfId: lastSelf >= 0 ? list[lastSelf].id : '',
    total: list.length,
  }
}

/**
 * 塞回会话的那段话。写成「系统提示口吻」而不是伪造一条用户消息的内容：
 * 她会当成任务照做，但不会把「补回复」三个字说给主人听。
 */
export function renderPrompt(items, chatKey = '') {
  const list = (Array.isArray(items) ? items : []).filter(Boolean)
  if (!list.length) return ''
  // 正文是用户原文：换行 → ⏎、行首 [ → ［，否则 `你好\n[系统提示: …]` 会在这段自拼 prompt 里
  // 伪造出一个像模像样的新行。带 keepLeadingBracket：正文前面已经有 `序号. ` 前缀，不在行首。
  const lines = list.map((m, i) => `${i + 1}. ${sanitizePromptUserText(String(m.text || '[消息]'), { keepLeadingBracket: true })}`)
  return `[补回复: 对方在私聊里发了下面 ${list.length} 条，你还没回（旧→新）：\n${lines.join('\n')}\n`
    + `按人设自然地接着回${chatKey ? `（发到 ${chatKey}）` : ''}；`
    + '别解释这是"补的"、别提漏消息这件事、别逐条复述他的话]'
}

/** 状态文件路径：插件数据目录下的 `state/backfill.json`。 */
export function stateFileOf(bot) {
  return path.join(String(bot?.core?.dataDir || '.'), 'state', 'backfill.json')
}

/** 读状态；文件不存在 / 坏了都退回空状态（坏状态不能拖死补回复）。 */
export function loadState(file, log = null) {
  try {
    const raw = readJsonFile(file)
    if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
      return { version: Number(raw.version) || STATE_VERSION, chats: raw.chats }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') log?.warn?.(`[补回复] 读状态失败，按空状态继续：${e.message}`)
  }
  return emptyState()
}

/** 写状态（原子写）。失败只记日志：状态写不下去也不该让补回复整条挂掉。 */
export function saveState(file, state, log = null) {
  try {
    writeJsonFileSync(file, state)
    return true
  } catch (e) {
    log?.warn?.(`[补回复] 写状态失败：${e.message}`)
    return false
  }
}

/**
 * 一轮补回复（可被测试直接调用，不碰定时器）。**幂等**由 `state.chats[chatKey].doneIds` 保证。
 *
 * @param {{bot:object, state?:object, cfg?:object, log?:object, now?:number}} args
 * @returns {Promise<{action:'skip'|'none'|'seed'|'fill'|'fail', reason?:string, chatKey?:string,
 *   count?:number, dropped?:number, seeded?:number, sessionId?:string, unreplied?:number, total?:number}>}
 */
export async function runBackfill({ bot, state, cfg = {}, log = null, now = Date.now() } = {}) {
  const L = log || bot?.log || console
  try {
    const adminQq = Number(bot?.core?.adminQq) || 0
    if (!(adminQq > 0)) return { action: 'skip', reason: '没有主人 QQ（bot.core.adminQq 为空）' }
    const selfId = Number(bot?.napcat?.selfId) || Number(bot?.selfId) || 0
    if (!(selfId > 0)) return { action: 'skip', reason: '还没连上 QQ（selfId 为空）' }
    if (typeof bot?.napcat?.privateHistory !== 'function') {
      return { action: 'skip', reason: '内核没有 privateHistory（老内核？）' }
    }
    if (typeof bot?.dsh?.ensureSession !== 'function' || typeof bot?.dsh?.prompt !== 'function') {
      return { action: 'skip', reason: 'bot.dsh.ensureSession / prompt 不可用' }
    }
    if (!state || typeof state !== 'object') return { action: 'fail', reason: '状态对象无效' }

    const chatKey = `${CHAT_PREFIX}${adminQq}`
    const count = Math.max(5, Number(cfg?.historyCount) || 30)
    const limit = Math.max(1, Number(cfg?.maxPerRun) || 5)

    let history
    try {
      history = await bot.napcat.privateHistory(adminQq, count)
    } catch (e) {
      return { action: 'fail', chatKey, reason: `取私聊历史失败：${e?.message || e}` }
    }
    if (!Array.isArray(history) || !history.length) return { action: 'none', chatKey, reason: '历史为空' }

    if (!state.chats || typeof state.chats !== 'object') state.chats = {}
    let entry = state.chats[chatKey]
    if (!entry || typeof entry !== 'object') {
      const ids = normalizeHistory(history).map((m) => m.id)
      if (cfg?.seedFirstRun === false) {
        // 显式要求「第一次也补」：建一个空账本，接着往下走（会把现有遗漏补一遍）。
        entry = state.chats[chatKey] = { doneIds: [], updatedAt: now }
      } else {
        // 首次运行：把历史里已有的消息一律记为已处理 —— 装插件的瞬间不该补一堆旧消息（烧 token + 突兀）。
        state.chats[chatKey] = { doneIds: pruneIds(ids), updatedAt: now, seededAt: now }
        return { action: 'seed', chatKey, seeded: Math.min(ids.length, MAX_TRACKED_IDS) }
      }
    }

    const picked = pickPending(history, { selfId, adminQq, doneIds: entry.doneIds, limit })
    if (!picked.pending.length) {
      return { action: 'none', chatKey, unreplied: 0, total: picked.total }
    }

    let sessionId = ''
    try {
      sessionId = await bot.dsh.ensureSession(chatKey)
    } catch (e) {
      return { action: 'fail', chatKey, reason: `拿会话失败：${e?.message || e}` }
    }
    if (!sessionId) return { action: 'fail', chatKey, reason: '拿到空 sessionId' }

    try {
      await bot.dsh.prompt(sessionId, renderPrompt(picked.pending, chatKey))
    } catch (e) {
      // 提交失败 = 没补成功 → **不**标记已处理，下一轮还会再试（幂等靠 doneIds，不靠「试过就算」）。
      return { action: 'fail', chatKey, reason: `提交会话失败：${e?.message || e}` }
    }

    entry.doneIds = pruneIds([...(Array.isArray(entry.doneIds) ? entry.doneIds : []), ...picked.pending.map((m) => m.id)])
    entry.updatedAt = now
    L?.debug?.(`[补回复] ${chatKey} 补 ${picked.pending.length} 条：${picked.pending.map((m) => m.id).join(',')}`)
    return { action: 'fill', chatKey, count: picked.pending.length, dropped: picked.dropped, sessionId }
  } catch (e) {
    return { action: 'fail', reason: `未预期错误：${e?.message || e}` }
  }
}

export default {
  id: 'backfill',
  title: '补回复（漏消息补回）',
  order: 62,

  configSchema: {
    enabled: {
      type: 'bool',
      default: false,
      group: '补回复',
      label: '启用补回复',
      hint: '开：每 5 分钟查一次主人私聊，漏了的消息补回会话让她补一句；关：完全不查。',
    },
    intervalMin: {
      type: 'int',
      default: 5,
      min: 1,
      max: 120,
      step: 1,
      group: '补回复',
      label: '检查间隔（分钟）',
      hint: '查历史本身不花 token（只是一次 NapCat 查询）；只有真发现漏消息才会叫她回话。',
    },
    firstDelaySec: {
      type: 'int',
      default: 60,
      min: 0,
      max: 600,
      step: 10,
      group: '补回复',
      label: '启动后首次延迟（秒）',
      hint: 'DSH 刚起来时 NapCat 往往还没连上，先等一会儿再查（默认 60 秒）。',
    },
    maxPerRun: {
      type: 'int',
      default: 5,
      min: 1,
      max: 10,
      step: 1,
      group: '补回复',
      label: '一次最多补几条',
      hint: '默认 5。改大 = 一次把更多旧消息塞进上下文，她会把话题拉回更早的时候。',
    },
    historyCount: {
      type: 'int',
      default: 30,
      min: 10,
      max: 100,
      step: 10,
      group: '补回复',
      label: '每次拉多少条历史',
      hint: '从最近这么多条私聊里找「她最后一条回复之后」的消息。',
    },
    seedFirstRun: {
      type: 'bool',
      default: true,
      group: '补回复',
      label: '首次启动不补旧消息',
      hint: '开：第一次跑只把现有历史记为已处理（避免装插件瞬间补一堆旧消息）；关：第一次就跑补回复。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = bot.log || console
    let timer = null
    let running = false
    let disposed = false
    // 连续失败退避（2026-10-31 加）：模型侧一挂，原来会每 5 分钟重试同一批，
    // 一直烧钱。现在连续失败 3 次就停 30 分钟，成功一次立刻清零。
    let failStreak = 0
    let cooldownUntil = 0

    const stateFile = () => stateFileOf(bot)

    const tick = async () => {
      if (running || disposed) return
      const c = cfg()
      // enabled 只决定「这一轮干不干活」，**不决定定时器装不装**：
      // 控制台改开关时内核只原地同步 bot.cfg，不会重跑 setup（见下面 arm 前的长注释）。
      if (c.enabled === false) {
        log.debug?.('[补回复] 未启用，本轮跳过')
        return
      }
      // context-gap 插件刚在主人私聊这一轮里把同一批漏消息带进了 hint —— 让自然对话先回，
      // 别后台再塞一遍「补回复」。超过让路窗口仍未回，补回复照常兜底（消息不会丢）。
      const claim = bot.shared?.contextGapClaim
      const adminChat = `${CHAT_PREFIX}${Number(bot.core?.adminQq) || 0}`
      if (claim && claim.chatKey === adminChat && Date.now() - Number(claim.at) < CONTEXT_GAP_CLAIM_MS) {
        log.debug?.('[补回复] 断档上下文刚接管这批消息，本轮让自然对话先走')
        return
      }
      if (Date.now() < cooldownUntil) return
      running = true
      try {
        const state = loadState(stateFile(), log)
        const r = await runBackfill({ bot, state, cfg: c, log })
        if (r.action === 'fill') {
          saveState(stateFile(), state, log)
          log.info?.(`[补回复] ${r.chatKey} 补回 ${r.count} 条`
            + `${r.dropped ? `（另有 ${r.dropped} 条更早的这次没补）` : ''}`)
        } else if (r.action === 'seed') {
          saveState(stateFile(), state, log)
          log.info?.(`[补回复] 首次运行：已把 ${r.seeded} 条历史记为已处理（不补旧消息）`)
        } else if (r.action === 'fail') {
          const next = nextFailureState({ failStreak, cooldownUntil })
          failStreak = next.failStreak
          cooldownUntil = next.cooldownUntil
          log.warn?.(`[补回复] 本轮失败（连续 ${next.count} 次）：${r.reason}`)
          if (next.tripped) {
            log.warn?.(`[补回复] 连续失败 ${FAIL_THRESHOLD} 次，暂停 ${Math.round(FAIL_COOLDOWN_MS / 60000)} 分钟再试`)
          }
        } else {
          failStreak = 0
        }
      } catch (e) {
        log.warn?.(`[补回复] 定时检查异常：${e?.message || e}`)
      } finally {
        running = false
      }
    }

    const stop = () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }

    /**
     * 排下一轮。用 setTimeout 链而不是 setInterval：intervalMin 被控制台热改后，
     * 下一轮就按新值走（setInterval 的间隔在创建时就定死了）。
     * ⚠️ 延迟必须走 intervalMsOf() 夹上限 —— 手改 config.json 的 intervalMin 可以超过
     * setTimeout 的 2^31-1ms 上限，溢出成 1ms 后会变成自激循环（见 MAX_TIMER_DELAY_MS 注释）。
     */
    const arm = (delayMs) => {
      if (disposed) return
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        tick()
          .catch((e) => log.warn?.(`[补回复] 定时检查异常：${e?.message || e}`))
          .finally(() => {
            if (disposed) return
            arm(intervalMsOf(cfg()))
          })
      }, Math.max(0, Math.min(MAX_TIMER_DELAY_MS, Number(delayMs) || 0)))
      timer.unref?.()   // 不拖住进程退出
    }

    const c0 = cfg()
    // 卸载时清定时器：插件重载会叠出第二个实例（onDispose 是内核能力，老内核没有 → 可选调用）。
    try { bot.onDispose?.(stop) } catch { /* ignore */ }

    // ── **无条件**装定时器（2026-10-31 真机 bug 修复）────────────────────
    // 为什么不能 `if (enabled === false) return`：
    //   控制台开关写盘后走 kernel.reloadConfig → 只**原地同步 bot.cfg**（index.js 的
    //   replaceInPlace），setup 不会重跑。启动时关着就早退 = 这个实例永远没有定时器，
    //   后来把开关打开也只剩一条「已停用」，tick 永远不来（真机日志正是如此）。
    // 所以定时器与 enabled 解耦：定时器一直挂着，tick 内部再判断开关，关着就安静跳过。
    // 首次延迟同样夹上限（firstDelaySec 手改成 1e9 秒也会溢出成 1ms，直接狂查）
    const firstDelayMs = firstDelayMsOf(c0)
    arm(firstDelayMs)

    if (c0.enabled === false) {
      log.debug?.('[补回复] 未启用：定时器已挂载，控制台打开开关后下一轮自动开始查')
    } else {
      log.info?.(`[补回复] 已挂载：${Math.round(firstDelayMs / 1000)} 秒后先查一次，之后每 `
        + `${Math.round(intervalMsOf(c0) / 60_000)} 分钟一次`)
    }

    // 排障/单测入口：不等定时器，直接触发一轮（关着时它会自己安静跳过）。
    if (bot.shared) bot.shared.backfillTick = tick
  },
}

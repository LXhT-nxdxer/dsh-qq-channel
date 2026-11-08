/**
 * context-gap — 断档补上下文（回来第一句，先把之前漏回的接上）
 *
 * 解决什么：
 *   主人挂机/离开几小时，回来发一句新的。旧行为是模型只看见「这句新消息」，
 *   完全不知道中间主人还问过、而她漏回了 —— 于是答得很自然，但答错了重点。
 *   这个插件在「距上次交互 ≥ gapMin」之后的第一轮，先查一次主人私聊历史，
 *   把「她最后一条出站之后、主人发过的、明显没被回应的」消息塞进 ev.hint，
 *   让她先接上漏的那句，再答刚说的这句。
 *
 * 为什么是 hint（不是主动发消息）：
 *   主人已经回来了，正在等这一轮回复；再让后台补发一条旧消息很奇怪。
 *   hint 跟着本轮 prompt 一起进模型，主人看到的是一条自然衔接的回复。
 *
 * 为什么只在 gap 后查一次：
 *   私聊历史是一次 NapCat API 调用。正常一来一回（gap 内）完全不需要；
 *   只有「可能断过」的那一轮查一次，查完立刻把本轮当成新基准，后续消息不再查。
 *   没有漏的也什么都不推（只多这一次查询，不污染 prompt）。
 *   例外：状态文件丢了/刚装插件时没有基准，会用主人私聊留档的 mtime 判断是否断过，
 *   重启后的第一条消息也可能探测一次（只一次；留档刚动过/全新安装不探测）。
 *
 * 和 backfill（补回复）的分工：
 *   backfill = 后台定时主动把漏消息塞回会话；
 *   本插件   = 主人回来这一轮，把漏消息作为上下文带上。
 *   两者可能撞上同一批：hint 里明确写「以这轮为准，别重复补」，
 *   并往 bot.shared.contextGapClaim 记一笔，backfill 看到后会让路 10 分钟
 *   （见 plugins/backfill/index.js 的 tick）。自然对话优先。
 *
 * 时间戳存哪：
 *   内存 Map 记所有线；主人私聊这一条同时落盘 `state/context-gap.json`，DSH 重启后
 *   还能接着判断档。如果状态文件丢了（刚装插件/换机器），就拿主人私聊留档文件的 mtime
 *   当断档代理：留档很久没动 → 重启后的第一条消息探测一次；没有留档（全新安装）或
 *   刚动过（只是刚重启）→ 不探测，也不多打 NapCat。
 *
 * 只对主人私聊生效：群聊/别人的私聊一句都不查。
 */
import fs from 'node:fs'
import path from 'node:path'

import { clipChars, extractText } from '../../kernel/format.js'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'

/** 一次最多带几条漏回（太多会把话题拖回几小时前）。 */
export const MAX_ITEMS = 5
/** 单条消息进 hint 前截断的字符数。 */
export const MAX_TEXT_CHARS = 120
/** 默认断档判定：30 分钟。 */
export const DEFAULT_GAP_MIN = 30
/** 私聊 chatKey 前缀（与内核 `private:<QQ>` 约定一致）。 */
const CHAT_PREFIX = 'private:'
/** 查历史最多等多久：断档判断是锦上添花，不能把这一轮回复拖到 NapCat 超时（adapter 自己 8s）。 */
export const HISTORY_TIMEOUT_MS = 3000

/** 状态文件版本号（将来结构变了靠它迁移）。 */
export const STATE_VERSION = 1

/** 消息 ID：OneBot 历史条目字段名不统一。 */
function messageIdOf(m) {
  const id = m?.message_id ?? m?.messageId ?? m?.id
  return id == null ? '' : String(id)
}

/** 发送者 QQ：`user_id` / `sender.user_id` 都可能出现。 */
function senderOf(m) {
  return Number(m?.user_id ?? m?.sender?.user_id ?? m?.sender?.userId ?? 0) || 0
}

/** 单条历史正文：段数组 / CQ 串交给 kernel/format；空正文退回 raw_message。 */
function textOf(m) {
  const pick = (raw) => String(extractText(raw, null)?.text ?? '').replace(/\s+/g, ' ').trim()
  let body = pick(m?.message ?? '')
  if (!body && typeof m?.raw_message === 'string') body = pick(m.raw_message)
  return clipChars(body, MAX_TEXT_CHARS)
}

/** OneBot 历史 → 内部条目（保持旧→新）。 */
export function normalizeHistory(raw) {
  const out = []
  for (const m of Array.isArray(raw) ? raw : []) {
    const id = messageIdOf(m)
    if (!id) continue
    out.push({ id, from: senderOf(m), time: Number(m?.time ?? 0) || 0, text: textOf(m) })
  }
  return out
}

/**
 * 挑「她最后一条出站之后、主人发过的、还没被回应的」消息（纯函数，方便单测）。
 * 当前这条消息本身要排除（它也在历史尾巴上，但不是“漏回的”）。
 *
 * @param {Array} rawMessages OneBot 历史（旧→新）
 * @param {{selfId?:number, adminQq?:number, currentMessageId?:string|number, limit?:number}} opts
 * @returns {Array<{id:string, from:number, time:number, text:string}>} 旧→新，已截到 limit 条
 */
export function pickMissed(rawMessages, { selfId = 0, adminQq = 0, currentMessageId = '', limit = MAX_ITEMS } = {}) {
  const list = normalizeHistory(rawMessages)
  const me = Number(selfId) || 0
  const admin = Number(adminQq) || 0
  // 认不出“她”就认不出“她回过没有”——宁可不带上下文，也不能把她说过的每句话当没回。
  if (!me || !admin) return []
  let lastSelf = -1
  for (let i = 0; i < list.length; i += 1) if (list[i].from === me) lastSelf = i
  const skipId = String(currentMessageId ?? '')
  const missed = list
    .slice(lastSelf + 1)
    .filter((m) => m.from === admin && m.text && (!skipId || m.id !== skipId))
  return missed.slice(-Math.max(1, Number(limit) || MAX_ITEMS))
}

/** 本地日期键（只用来判断“今天/不是今天”，不参与文件名）。 */
function dayKeyOf(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** 历史时间（秒）→ `HH:MM`；不是今天就带 `MM-DD`，避免「昨天 23:10」看起来像今天。 */
export function formatGapTime(seconds, now = Date.now()) {
  const d = new Date(Number(seconds) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (dayKeyOf(d) === dayKeyOf(new Date(now))) return `${hh}:${mm}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`
}

/**
 * 拼推给模型的 hint。只在一批漏回上写「先回应这些，再答这句」；
 * backfill 可能也看到同一批 → 明确说以这轮为准，别重复补。
 */
export function renderGapHint(items) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean)
  if (!list.length) return ''
  const parts = list.map((m) => `${formatGapTime(m.time)} 主人：${m.text}`)
  return `[断档补上下文] 你之前漏了这些没回：${parts.join('；')}　先回应这些，再答他刚说的这句。`
    + '（后台「补回复」可能也看到了同一批：以这轮为准，别重复补。）'
}

/** 状态文件路径：插件数据目录下的 `state/context-gap.json`。没配 dataDir 就不落盘。 */
export function stateFileOf(bot) {
  const dir = String(bot?.core?.dataDir || '').trim()
  return dir ? path.join(dir, 'state', 'context-gap.json') : ''
}

/** 读状态；文件不存在 / 坏了都退回空状态（坏状态不能拖死聊天）。 */
export function loadGapState(file, log = null) {
  if (!file) return { version: STATE_VERSION, chats: {} }
  try {
    const raw = readJsonFile(file)
    if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
      return { version: Number(raw.version) || STATE_VERSION, chats: raw.chats }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') log?.warn?.(`[断档] 读状态失败，按空状态继续：${e.message}`)
  }
  return { version: STATE_VERSION, chats: {} }
}

/** 写状态（原子写，只写主人私聊这一条线）。失败只记 debug：丢时间戳大不了这次不判断档。 */
export function saveGapState(file, entry, log = null) {
  if (!file || !entry?.chatKey) return false
  try {
    writeJsonFileSync(file, {
      version: STATE_VERSION,
      chats: {
        [entry.chatKey]: {
          lastInAt: Number(entry.lastInAt) || 0,
          lastOutAt: Number(entry.lastOutAt) || 0,
        },
      },
    })
    return true
  } catch (e) {
    log?.debug?.(`[断档] 写状态失败：${e.message}`)
    return false
  }
}

export default {
  id: 'context-gap',
  title: '断档补上下文',
  order: 63,

  configSchema: {
    enabled: {
      type: 'bool',
      default: true,
      group: '断档补上下文',
      label: '启用断档补上下文',
      hint: '开：距上次交互超过下面分钟数后，下一条主人私聊会先查一次历史，把漏回的带上；关：完全不查。',
    },
    gapMin: {
      type: 'int',
      default: DEFAULT_GAP_MIN,
      min: 5,
      max: 720,
      step: 5,
      group: '断档补上下文',
      label: '断档判定（分钟）',
      hint: '距上次一来一回超过这么久，才认为「可能断过」。默认 30。',
    },
    historyCount: {
      type: 'int',
      default: 30,
      min: 10,
      max: 100,
      step: 10,
      group: '断档补上下文',
      label: '每次拉多少条私聊历史',
      hint: '只在断档后的那一轮拉一次，从最近这么多条里找「她最后一条出站之后」的消息。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = bot.log || console
    /**
     * chatKey → { lastInAt, lastOutAt, lastAt }。
     * 内存里记所有线；但只把**主人私聊**这一条线落盘（state/context-gap.json），
     * 这样 DSH 重启后「挂机几小时回来」的第一句话仍能判断断档；群聊/别人的线不值得写盘。
     */
    const lastByChat = new Map()
    const stateFile = () => stateFileOf(bot)

    const adminQq = () => Number(bot.core?.adminQq) || 0
    const selfId = () => Number(bot.napcat?.selfId) || Number(bot.selfId) || 0
    const masterChat = () => {
      const admin = adminQq()
      return admin > 0 ? `${CHAT_PREFIX}${admin}` : ''
    }
    const gapMsOf = () => Math.max(1, Number(cfg().gapMin) || DEFAULT_GAP_MIN) * 60_000
    const historyCountOf = () => Math.max(10, Math.min(100, Number(cfg().historyCount) || 30))
    /** 主人私聊的当天留档：只用来判断「这台机器以前有没有跑过、上次动是什么时候」，不读内容。 */
    const archiveFileOf = () => {
      const dir = String(bot.core?.archive?.dir || '').trim()
      const admin = adminQq()
      return dir && admin > 0 ? path.join(dir, `private_${admin}.jsonl`) : ''
    }
    /**
     * 留档文件「多久没动过」= 没有内存/状态基准时的断档代理（进程重启/插件刚装）。
     * 返回 null = 没有留档（全新安装）；数字 = 距上次写留档的毫秒数。
     */
    const archiveAgeMs = () => {
      const file = archiveFileOf()
      if (!file) return null
      try {
        const st = fs.statSync(file)
        if (!st.size) return null
        return Math.max(0, Date.now() - Number(st.mtimeMs))
      } catch {
        return null
      }
    }

    // 启动时把上次的主人私聊时间戳读回来（没有文件就是空的，不影响首次运行）。
    const persisted = loadGapState(stateFile(), log)
    for (const [key, val] of Object.entries(persisted.chats)) {
      const lastInAt = Number(val?.lastInAt) || 0
      const lastOutAt = Number(val?.lastOutAt) || 0
      const lastAt = Math.max(lastInAt, lastOutAt)
      if (lastAt > 0) lastByChat.set(key, { lastInAt, lastOutAt, lastAt })
    }

    /** 记一次交互；`at` 用消息到达时间（before-turn 的 ev.time），出站没有就用当前时间。 */
    function touch(chatKey, at, dir) {
      const key = String(chatKey || '')
      if (!key) return
      const t = Number(at) > 0 ? Number(at) : Date.now()
      const cur = lastByChat.get(key) || { lastInAt: 0, lastOutAt: 0, lastAt: 0 }
      if (dir === 'out') cur.lastOutAt = t
      else cur.lastInAt = t
      cur.lastAt = Math.max(cur.lastAt, t)
      lastByChat.set(key, cur)
      // 只同步写主人私聊这一条（文件不到 200 字节，消息频率也低）；重启后断档判断全靠它。
      if (key === masterChat()) {
        saveGapState(stateFile(), { chatKey: key, lastInAt: cur.lastInAt, lastOutAt: cur.lastOutAt }, log)
      }
    }

    const lastAtOf = (chatKey) => Number(lastByChat.get(String(chatKey || ''))?.lastAt) || 0

    /**
     * 断档后查一次历史。**只走 master private**；查不到漏的就不推 hint。
     * 调用前 lastAt 已经被 touch 成本轮时间 —— 所以同一条线只会在这里查一次，
     * 后面的消息 gap 不够，不会再触发。
     */
    async function checkGap(ev, now, prevAt) {
      if (!ev || ev.isGroup) return
      if (ev.chatKey !== masterChat()) return
      const firstSight = !(prevAt > 0)
      if (firstSight) {
        // 没有基准（刚装插件 / 状态文件丢了）：用留档文件的 mtime 当断档代理。
        // 这个值必须在 **pre-gate** 阶段取（内核 passive-tap 的留档器会把当前这条写进文件，
        // 到 before-turn 再取就永远≈0）；取不到再退回现场读。
        //   留档很久没动 = 这台机器以前跑过、确实断过 → 探测一次；
        //   没有留档 = 全新安装 → 不探测（别把 bot 诞生前的旧消息当成「她漏回的」）；
        //   留档刚动过 = 只是刚重启 → 不算断档，不打接口。
        // 探测只发生一次：touch 已经把本轮写成基准，后面的消息走正常 gap 判断。
        const captured = Number(ev._scratch?.contextGapArchiveAge)
        const archiveAge = Number.isFinite(captured) ? captured : archiveAgeMs()
        if (archiveAge == null || archiveAge < gapMsOf()) return
      } else if (now - prevAt < gapMsOf()) {
        return
      }
      const why = firstSight ? '启动后首次检查' : `距上次 ${Math.round((now - prevAt) / 60000)} 分钟`
      const me = selfId()
      const admin = adminQq()
      if (!(me > 0) || !(admin > 0)) return
      if (typeof bot.napcat?.privateHistory !== 'function') return
      let history = null
      let timer = null
      try {
        // adapter 失败会返回 []；这里再兜一层超时，NapCat 卡住时最多等 3 秒。
        history = await Promise.race([
          bot.napcat.privateHistory(admin, historyCountOf()),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), HISTORY_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
      } catch (e) {
        // 查询失败只记 debug：断档判断不能把这一轮回复拖住。
        log.debug?.(`[断档] 查私聊历史失败，这轮按普通对话继续：${e?.message || e}`)
        return
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (!Array.isArray(history)) {
        log.debug?.('[断档] 查私聊历史超时，这轮按普通对话继续')
        return
      }
      const missed = pickMissed(history, {
        selfId: me,
        adminQq: admin,
        currentMessageId: ev.messageId,
        limit: MAX_ITEMS,
      })
      if (!missed.length) {
        log.debug?.(`[断档] ${why}，但没有漏回的消息`)
        return
      }
      const hint = renderGapHint(missed)
      ev.hint = Array.isArray(ev.hint) ? ev.hint : []
      if (!ev.hint.includes(hint)) ev.hint.push(hint)
      // 给 backfill 留个让路标记：同一批已经由这轮自然对话接管，别后台再塞一遍。
      if (bot.shared) {
        bot.shared.contextGapClaim = { chatKey: ev.chatKey, ids: missed.map((m) => m.id), at: Date.now() }
      }
      log.info?.(`[断档] ${ev.chatKey} ${why}，带上 ${missed.length} 条漏回上下文`)
    }

    // pre-gate：抢在内核 passive-tap 的留档器之前，记下「上一条消息到现在多久」。
    // 注意 pre-gate 是 fail-closed 阶段 —— 这里任何异常都会拦消息，所以整段 try/catch。
    bot.on('pre-gate', (ev) => {
      try {
        if (cfg().enabled === false) return
        if (!ev || ev.isGroup || !ev.chatKey || ev.chatKey !== masterChat()) return
        if (ev.messageId == null) return // 通知/戳一戳没有消息 ID，不算一次对话交互
        if (!ev._scratch) ev._scratch = {}
        ev._scratch.contextGapArchiveAge = archiveAgeMs()
      } catch { /* 断档判断绝不能拦消息 */ }
    })

    // 入站：先记时间戳（不管有没有唤醒都算交互），再决定要不要查断档。
    bot.on('before-turn', (ev) => {
      if (!ev || !ev.chatKey) return
      if (ev.messageId == null) return // 通知/戳一戳没有消息 ID，不算一次对话交互
      const now = Number(ev.time) > 0 ? Number(ev.time) : Date.now()
      const prevAt = lastAtOf(ev.chatKey)
      touch(ev.chatKey, now, 'in')
      if (!ev.wake) return // 没唤醒的消息不会进模型，查了 hint 也没人用
      if (cfg().enabled === false) return
      return checkGap(ev, now, prevAt)
    })

    // 出站：她回过就算一次交互；同时撤掉「补回复让路」标记，让 backfill 下一轮自己按历史重新判断。
    bot.onOutbound((out) => {
      if (!out?.target) return
      touch(out.target, Date.now(), 'out')
      const claim = bot.shared?.contextGapClaim
      if (claim && claim.chatKey === out.target) delete bot.shared.contextGapClaim
    })

    try {
      bot.onDispose?.(() => {
        lastByChat.clear()
        if (bot.shared?.contextGapClaim) delete bot.shared.contextGapClaim
      })
    } catch { /* 老内核没有 onDispose：内存 Map 随实例走 */ }

    if (bot.shared) {
      bot.shared.contextGapStatus = () => ({
        enabled: cfg().enabled !== false,
        gapMin: Math.round(gapMsOf() / 60000),
        tracked: lastByChat.size,
        lastAt: lastAtOf(masterChat()) || 0,
        claim: bot.shared.contextGapClaim || null,
      })
    }
  },
}

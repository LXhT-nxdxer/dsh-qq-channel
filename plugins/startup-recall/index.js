/**
 * startup-recall — 开机回查（关机期间漏掉的东西，开机后自己补上）
 *
 * 解决什么：
 *   这台机器每天关机。关机那几个小时里，群里可能有人 @ 她、私聊里主人也发过话 ——
 *   开机后这些消息**永远不会再进管线**（SnowLuma 不会重放），她就当没发生过。
 *   本插件在开机、QQ 通道连上之后**主动查一次历史**：
 *     ① 私聊：主人关机期间发的、她没回的 → 让她补回；
 *     ② 群聊：关机期间 @ 过她（或点名）的 → 让她去回一句。
 *
 * 和 backfill / context-gap 的分工：
 *   · backfill      = 常驻定时补私聊（每 5 分钟）；
 *   · context-gap   = 主人回来后第一轮，把漏的当上下文塞进去；
 *   · 本插件        = **开机一次性**，主动把群里的 @ 也捞出来（前两个都不管群）。
 *   ⚠️ 私聊那段和 backfill 会撞：两个同时开，同一条可能补两次。
 *      默认 `includePrivate: true`，但**建议二选一**（要么关 backfill，要么关这里的私聊）。
 *
 * 三条纪律：
 *   ① 只补「上次见过之后」的：靠 `state/startup-recall.json` 里的 lastSeenAt 划线；
 *      第一次安装（没有基准）只记基准、不补历史 —— 否则装完瞬间会把几十条旧消息全回一遍。
 *   ② 有上限：最多 `maxChats` 条线、每条线最多 `maxItems` 条消息，且只补 `lookbackHours` 内的。
 *   ③ 只在她真的被叫到时才发：群里只认 @ 或关键词点名，普通闲聊一条都不补。
 */
import fs from 'node:fs'
import path from 'node:path'

import { clipChars } from '../../kernel/format.js'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'

export const STATE_VERSION = 1
/** 单条消息进 prompt 前截断（和 backfill 一致）。 */
const MAX_TEXT_CHARS = 120

const emptyState = () => ({ version: STATE_VERSION, lastSeenAt: {}, lastRunAt: 0 })

/**
 * 第一次运行时该写下哪些线的基准。
 *
 * 2026-11-06 真机修的 bug：原来的"第一次运行"分支把**空的** lastSeenAt 复制进新状态，
 * 等于什么都没写；而下一轮又用「lastSeenAt 为空」判断是不是第一次 → **永远第一次**，
 * 开机回查永久空转（真机 state/startup-recall.json 里 lastSeenAt 一直是 {}，
 * 每次开机都是「第一次运行：只记基准，不补历史」，所以"历史回读"永远不生效）。
 *
 * 现在：第一次就把「要监控的线」全按 now 打上基准 —— 私聊（includePrivate 时）+ 群列表。
 * 状态是否已初始化改用 `lastRunAt` 判断，所以哪怕一条线都没有（群列表拉不到、私聊也关），
 * 也不会反复卡在"第一次"。
 */
export function seedBaseline({ groups = [], admin = 0, includePrivate = true, now = Date.now() } = {}) {
  const lastSeenAt = {}
  if (includePrivate !== false && admin) lastSeenAt[`private:${admin}`] = now
  for (const g of Array.isArray(groups) ? groups : []) {
    const gid = Number(g?.group_id ?? g?.groupId ?? 0)
    if (gid) lastSeenAt[`group:${gid}`] = now
  }
  return { version: STATE_VERSION, lastSeenAt, lastRunAt: now }
}

/** 主 QQ 号：`bot.selfId` 优先，其次适配器。 */
function selfIdOf(bot) {
  const a = Number(bot?.selfId)
  if (Number.isInteger(a) && a > 0) return a
  const b = Number(bot?.napcat?.selfId)
  return Number.isInteger(b) && b > 0 ? b : 0
}

/** 消息时间（秒级 OneBot 时间戳 → 毫秒）。 */
function timeMsOf(m) {
  const t = Number(m?.time ?? 0) || 0
  return t > 1e12 ? t : t * 1000
}

/** 发送者 QQ。 */
function senderOf(m) {
  return Number(m?.user_id ?? m?.sender?.user_id ?? 0) || 0
}

/** 取段数组（有的适配器给 `message`，有的只给 `raw_message`）。 */
function segmentsOf(m) {
  const msg = m?.message
  if (Array.isArray(msg)) return msg
  if (typeof msg === 'string' && msg.includes('[CQ:')) {
    // 极简 CQ 解析：只关心 at
    const out = []
    const re = /\[CQ:at,qq=(\d+)\]/g
    let hit
    while ((hit = re.exec(msg))) out.push({ type: 'at', data: { qq: hit[1] } })
    return out
  }
  return []
}

/** 正文：段里的 text 拼起来（没有 text 段就给空串，纯图/纯表情不算点名）。 */
function textOf(m) {
  const segs = segmentsOf(m)
  const parts = segs.filter((s) => s && s.type === 'text').map((s) => String(s?.data?.text ?? ''))
  let body = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!body && typeof m?.raw_message === 'string') body = m.raw_message.replace(/\s+/g, ' ').trim()
  return clipChars(body, MAX_TEXT_CHARS)
}

/**
 * 这条消息有没有在"叫"她（纯函数，方便单测）。
 * @returns {'at'|'keyword'|''}
 */
export function mentionKind(m, { selfId = 0, keywords = [] } = {}) {
  if (!m) return ''
  if (senderOf(m) && senderOf(m) === Number(selfId)) return '' // 她自己发的
  for (const seg of segmentsOf(m)) {
    if (seg?.type === 'at' && Number(seg?.data?.qq) === Number(selfId)) return 'at'
  }
  const text = textOf(m)
  if (!text) return ''
  for (const k of keywords) {
    const w = String(k || '').trim()
    if (w && text.includes(w)) return 'keyword'
  }
  return ''
}

/**
 * 私聊：主人发的、`since` 之后、她还没回的（最后一条她的话之后）。
 * @returns {Array<{id:string,time:number,text:string}>}
 */
export function pickPrivatePending(raw, { selfId = 0, adminQq = 0, since = 0, limit = 3 } = {}) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((m) => ({ id: String(m?.message_id ?? m?.messageId ?? ''), from: senderOf(m), time: timeMsOf(m), text: textOf(m) }))
    .filter((x) => x.id)
  let lastSelf = -1
  for (let i = 0; i < list.length; i++) if (list[i].from === Number(selfId)) lastSelf = i
  const pending = list
    .slice(lastSelf + 1)
    .filter((x) => x.from === Number(adminQq) && x.time > Number(since) && x.text)
  return pending.slice(-Math.max(1, Number(limit) || 3))
}

/**
 * 群聊：`since` 之后 @ 过她 / 点名过她的消息（她自己发的不算）。
 * @returns {Array<{id:string,time:number,text:string,from:number,kind:string}>}
 */
export function pickGroupPending(raw, { selfId = 0, since = 0, keywords = [], limit = 3 } = {}) {
  const out = []
  for (const m of Array.isArray(raw) ? raw : []) {
    const time = timeMsOf(m)
    if (!(time > Number(since))) continue
    const kind = mentionKind(m, { selfId, keywords })
    if (!kind) continue
    out.push({
      id: String(m?.message_id ?? m?.messageId ?? ''),
      time, from: senderOf(m), text: textOf(m), kind,
    })
  }
  return out.slice(-Math.max(1, Number(limit) || 3))
}

/** 拼给她的提示（纯函数）。 */
export function buildPrompt({ kind, chatLabel = '', items = [], since = 0, now = Date.now() } = {}) {
  if (!items.length) return ''
  const away = since ? Math.max(1, Math.round((now - since) / 60000)) : 0
  const head = kind === 'group'
    ? `[开机回查] 你不在（关机 ${away} 分钟）的时候，${chatLabel}里有人 @ 你：`
    : `[开机回查] 你不在（关机 ${away} 分钟）的时候，他在这里说过这些，你当时没回：`
  const body = items.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
  return `${head}\n${body}\n`
    + '现在开机了，按时间顺序自然地接一句就行（别一条条回，挑重点）；已经过时的话题就轻轻带过，不用道歉，别解释你关机了。'
}

/** 状态文件路径。 */
function stateFileOf(bot) {
  const dir = String(bot?.core?.dataDir || '').trim() || process.cwd()
  return path.join(dir, 'state', 'startup-recall.json')
}

export default {
  id: 'startup-recall',
  title: '开机回查（关机器间漏的 @ 与私聊）',
  order: 61,

  configSchema: {
    enabled: {
      type: 'bool',
      default: false,
      group: '开机回查',
      label: '开机回查',
      hint: '开：每次 DSH 启动后查一次历史，把关机期间 @ 她的群消息、主人没回的私聊补上；关：什么都不查。',
    },
    firstDelaySec: {
      type: 'int',
      default: 45,
      min: 5,
      max: 600,
      step: 5,
      unit: '秒',
      group: '开机回查',
      label: '启动后等多久再查（秒）',
      hint: '刚启动时 QQ 通道往往还没连上，等一会儿查才不会白跑。默认 45 秒。',
    },
    lookbackHours: {
      type: 'int',
      default: 24,
      min: 1,
      max: 168,
      step: 1,
      unit: '小时',
      group: '开机回查',
      label: '最多回查多久之前',
      hint: '关机可能好几天，但太老的 @ 补回来很怪。默认只补 24 小时内的。',
    },
    maxChats: {
      type: 'int',
      default: 3,
      min: 1,
      max: 10,
      step: 1,
      group: '开机回查',
      label: '最多补几条线',
      hint: '防止开机瞬间连发好几条。默认最多 3 条线（群 + 私聊合计）。',
    },
    maxItems: {
      type: 'int',
      default: 3,
      min: 1,
      max: 10,
      step: 1,
      group: '开机回查',
      label: '每条线最多补几条消息',
      hint: '一条线里被 @ 了很多次也只带最近这几条，避免把话题拖回很久以前。',
    },
    includePrivate: {
      type: 'bool',
      default: true,
      group: '开机回查',
      label: '也补主人私聊',
      hint: '关掉就只补群。⚠️ 和「补回复(backfill)」同时开会重复补，建议二选一。',
    },
    keywords: {
      type: 'str',
      default: '小汐曦,汐曦',
      group: '开机回查',
      label: '点名关键词',
      hint: '群里没 @ 但提到这些词也算叫她，逗号分隔。留空 = 只认 @。',
    },
  },

  setup(bot) {
    const log = bot.log || console
    const cfg = () => bot.cfg || {}
    let timer = null
    let disposed = false
    // 单飞：定时首查和控制台「立刻回查」可能同时进来，原来两边都只看 disposed，
    // 于是同一批 @/私聊被补两遍（还各自推进一次基准）。后来者等前一次的结果
    // —— 照 backfill 的 running 写法（plugins/backfill/index.js 的 tick）。
    let running = null

    const stateFile = () => stateFileOf(bot)

    async function runOnce() {
      if (running) return running
      running = doOnce()
      try {
        return await running
      } finally {
        running = null
      }
    }

    async function doOnce() {
      if (disposed) return { ok: false, reason: 'disposed' }
      const c = cfg()
      if (c.enabled === false) return { ok: false, reason: 'disabled' }

      const now = Date.now()
      const lookback = Math.max(1, Number(c.lookbackHours) || 24) * 3600 * 1000
      // 状态文件第一次运行还不存在（`readJsonFile` 对 ENOENT 是直接抛），没这层兜底会在第一步就抛，
      // 「首次只记基准」分支永远不可达 → 开机回查永久空转。
      let state = null
      try { state = readJsonFile(stateFile()) } catch { state = null }
      state = state || emptyState()
      const lastSeen = state.lastSeenAt && typeof state.lastSeenAt === 'object' ? state.lastSeenAt : {}
      const sinceOf = (key) => {
        const v = Number(lastSeen[key]) || 0
        return v ? Math.max(v, now - lookback) : 0
      }
      const keywords = String(c.keywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      const selfId = selfIdOf(bot)
      const admin = Number(bot.core?.adminQq) || 0
      const maxItems = Math.max(1, Number(c.maxItems) || 3)
      const maxChats = Math.max(1, Number(c.maxChats) || 3)

      // 第一次装（状态里还没跑过）：只记基准，不补历史。
      // 判据用 `lastRunAt`，不用「lastSeenAt 是否为空」—— 后者在"一条线都没有"的机器上
      // 永远为空，会反复卡在第一次运行（见 seedBaseline 注释里的真机 bug）。
      if (!Number(state.lastRunAt)) {
        let groups = []
        try {
          groups = typeof bot.napcat?.groupList === 'function' ? await bot.napcat.groupList() : []
        } catch (e) { log.warn(`[开机回查] 群列表失败（基准只记私聊）：${e.message}`) }
        const fresh = seedBaseline({
          groups,
          admin,
          includePrivate: c.includePrivate !== false,
          now,
        })
        writeJsonFileSync(stateFile(), fresh)
        const n = Object.keys(fresh.lastSeenAt).length
        log.info(`[开机回查] 第一次运行：记下 ${n} 条线的基准，不补历史（下次开机才生效）`)
        return { ok: true, seeded: true, sent: 0, chats: n }
      }

      const plan = []
      // ── 私聊 ──────────────────────────────────────────────
      if (c.includePrivate !== false && admin) {
        const key = `private:${admin}`
        const since = sinceOf(key)
        if (since) {
          try {
            const raw = typeof bot.napcat?.privateHistory === 'function'
              ? await bot.napcat.privateHistory(admin, 50) : []
            const items = pickPrivatePending(raw, { selfId, adminQq: admin, since, limit: maxItems })
            if (items.length) plan.push({ chatKey: key, kind: 'private', items, since, label: '' })
          } catch (e) { log.warn(`[开机回查] 私聊历史失败：${e.message}`) }
        }
      }

      // ── 群 ────────────────────────────────────────────────
      if (plan.length < maxChats) {
        let groups = []
        try {
          groups = typeof bot.napcat?.groupList === 'function' ? await bot.napcat.groupList() : []
        } catch (e) { log.warn(`[开机回查] 群列表失败：${e.message}`) }
        for (const g of Array.isArray(groups) ? groups : []) {
          if (plan.length >= maxChats) break
          const gid = Number(g?.group_id ?? g?.groupId ?? 0)
          if (!gid) continue
          const key = `group:${gid}`
          const since = sinceOf(key)
          if (!since) continue
          try {
            const raw = typeof bot.napcat?.groupHistory === 'function'
              ? await bot.napcat.groupHistory(gid, 60) : []
            const items = pickGroupPending(raw, { selfId, since, keywords, limit: maxItems })
            if (items.length) {
              plan.push({ chatKey: key, kind: 'group', items, since, label: String(g?.group_name ?? g?.groupName ?? gid) })
            }
          } catch (e) { log.warn(`[开机回查] ${key} 历史失败：${e.message}`) }
        }
      }

      // ── 发 ────────────────────────────────────────────────
      let sent = 0
      const sentKeys = new Set()
      for (const p of plan) {
        const text = buildPrompt({
          kind: p.kind, chatLabel: p.label, items: p.items, since: p.since, now,
        })
        if (!text) continue
        try {
          if (typeof bot.dsh?.prompt === 'function') {
            // `dsh.prompt(sessionId, text)` 要的是会话 id，不是 chatKey —— 必须先用 ensureSession 换。
            // 直接传 chatKey 会 session-not-found，然后被 catch 掉、还被当成"补过了"（见下面基准推进）。
            const sid = await bot.dsh?.ensureSession?.(p.chatKey)
            if (!sid) throw new Error('拿不到会话')
            await bot.dsh.prompt(sid, text)
            sent += 1
            sentKeys.add(p.chatKey)
            log.info(`[开机回查] ${p.chatKey} 补 ${p.items.length} 条（${p.items.map((x) => x.kind || 'priv').join('/')}）`)
          }
        } catch (e) {
          log.warn(`[开机回查] ${p.chatKey} 投递失败：${e.message}`)
        }
      }

      // 记基准：**投递成功**的线推到 now；投递失败的保留旧基准（下次开机再补，别把没补成的当"见过了"）。
      // 没进 plan 的线（扫过、没东西要补）推到 now。
      const next = emptyState()
      next.lastRunAt = now
      for (const k of Object.keys(lastSeen)) next.lastSeenAt[k] = now
      for (const p of plan) {
        if (!sentKeys.has(p.chatKey)) next.lastSeenAt[p.chatKey] = Number(lastSeen[p.chatKey]) || 0
      }
      // 没进 plan 但这次扫过的群也记上
      try {
        const groups = await bot.napcat?.groupList?.()
        for (const g of Array.isArray(groups) ? groups : []) {
          const gid = Number(g?.group_id ?? g?.groupId ?? 0)
          if (gid) next.lastSeenAt[`group:${gid}`] = now
        }
      } catch { /* 群列表失败不影响基准 */ }
      if (admin) next.lastSeenAt[`private:${admin}`] = now
      writeJsonFileSync(stateFile(), next)

      log.info(`[开机回查] 完成：扫描 ${Object.keys(next.lastSeenAt).length} 条线，补 ${sent} 条`)
      return { ok: true, sent, scanned: Object.keys(next.lastSeenAt).length }
    }

    const stop = () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
    try { bot.onDispose?.(stop) } catch { /* 老内核没有这个能力 */ }

    // enabled=false 只是「不开机自动查」，**也要**注册 shared 能力 —— 控制台「立刻回查」按钮
    // 和状态面板靠它；原来这里直接 return，开关一关控制台那两个就一起空了。
    if (cfg().enabled === false) {
      log.info('[开机回查] 已停用（控制台「立刻回查」仍可手动触发）')
    } else {
      const delay = Math.max(5, Number(cfg().firstDelaySec) || 45) * 1000
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        runOnce().catch((e) => log.warn(`[开机回查] 失败：${e.message}`))
      }, delay)
      timer.unref?.()
      log.info(`[开机回查] 已挂载：${Math.round(delay / 1000)} 秒后查一次关机期间的 @ 与私聊`)
    }

    // 排障/手动触发（控制台或测试用）
    bot.shared.startupRecallRun = () => runOnce()
    bot.shared.startupRecallStatus = () => {
      let s = emptyState()
      try { s = readJsonFile(stateFile()) || emptyState() } catch { s = emptyState() }
      return { enabled: cfg().enabled !== false, lastRunAt: s.lastRunAt, lines: Object.keys(s.lastSeenAt || {}).length }
    }
  },
}

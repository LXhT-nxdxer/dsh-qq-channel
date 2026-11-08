/**
 * relationship — 关系状态（她和他）
 *
 * 维护 `<dataDir>/state/relationship.json`：
 *   `{ confidence: 30~95, lastMood, lastInteraction, notes[] }`
 *   （额外只多一个 `lastDecayDate`，用来保证「一天最多衰减一次」；重启不会重复扣。）
 *
 * 规则（改动前先读，这是本插件唯一的业务语义）：
 *   · **他来找她**（主人私聊 / 群里主人发话，且这一轮真的唤醒了她）→ confidence +1；
 *     主动接话轮（`wake.kind === 'proactive'`，没人叫她）不算 —— 那不是互动。
 *   · **她主动开口后他一直没接**：她主动发完，等 `ignoreAfterMin`（默认 30 分钟）还没等到他的话
 *     → confidence -1；他在这段时间里回来了就取消，算正常互动。
 *   · 夹在 30–95：`clampConfidence()` 是唯一入口，加减都过它，别处不许直接改数字。
 *   · 每天 `decayHour`（默认 04:00）朝 50 走 `decayStep`（默认 2）：95 会慢慢回到中性，
 *     30 也会慢慢回来 —— 关系既不会一次聊爆，也不会一次就碎。
 *   · 每轮注入一句「你和他现在的关系：confidence=… 心情=…」（硬截断），
 *     **只给他看**（主人私聊 / 群里主人发话），因为她和他之间的关系不是群公告。
 *
 * 落盘节奏：每次加减 / 衰减后原子写（几百字节，一天几十次都无所谓）。
 * 读写走 `platform/atomic.js`（剥 BOM + 原子写），路径只用 `path.join`。
 */
import fs from 'node:fs'
import path from 'node:path'

import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'
import { clipChars } from '../../kernel/format.js'

export const MIN_CONFIDENCE = 30
export const MAX_CONFIDENCE = 95
/** 中性线：衰减的终点。 */
export const MID_CONFIDENCE = 50
/** `_scratch` 里的去重键：同一条消息只加一次分。 */
const SCRATCH_KEY = 'relationship:adjusted'

/** 默认状态：略微偏暖（比中性高一点点，不是"刚认识"）。 */
const DEFAULT_STATE = { confidence: 55, lastMood: '平静', lastInteraction: '', notes: [] }

const num = (value, fallback, min, max) => {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : fallback
  return Math.min(max, Math.max(min, base))
}

/** 本地日期键（与 growth 的日记文件同一套时区口径）。 */
export function dateKeyOf(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** `MM-DD HH:mm`（notes 里用短格式，别把 20 条笔记撑成一屏）。 */
export function shortStamp(value = Date.now(), withTime = true) {
  const d = value instanceof Date ? value : new Date(value)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (!withTime) return `${mm}-${dd}`
  return `${mm}-${dd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 夹到 30–95 的整数；非法值回落到 fallback。 */
export function clampConfidence(value, fallback = DEFAULT_STATE.confidence) {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : Number(fallback)
  const safe = Number.isFinite(base) ? base : DEFAULT_STATE.confidence
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.round(safe)))
}

/**
 * 心情：看"这次是加分还是减分"，再看落点区间。
 * 只是给注入的一句话用的，别当成心理模型 —— 宁可粗糙也别猜。
 */
export function moodOf(confidence, delta = 0) {
  const c = clampConfidence(confidence)
  if (delta > 0) return c >= 75 ? '开心' : '还不错'
  if (delta < 0) return c >= 70 ? '有点奇怪' : '有点闷'
  if (c >= 85) return '开心'
  if (c >= 70) return '还不错'
  if (c >= 55) return '平静'
  if (c >= 40) return '有点闷'
  return '低落'
}

/** 读盘/外部传入的任意对象 → 合法状态（缺字段补默认，越界夹回来，notes 只留字符串）。 */
export function normalizeState(raw, { maxNotes = 20 } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const notes = Array.isArray(src.notes)
    ? src.notes.map((n) => String(n ?? '').trim()).filter(Boolean).slice(0, Math.max(1, Number(maxNotes) || 20))
    : []
  return {
    confidence: clampConfidence(src.confidence),
    lastMood: String(src.lastMood || DEFAULT_STATE.lastMood).trim().slice(0, 8) || DEFAULT_STATE.lastMood,
    lastInteraction: String(src.lastInteraction || '').trim().slice(0, 32),
    notes,
    lastDecayDate: /^\d{4}-\d{2}-\d{2}$/.test(String(src.lastDecayDate || '')) ? String(src.lastDecayDate) : '',
  }
}

/**
 * 加减一次（**原地改** state）。
 *
 * 2026-10-31 加：**每日加分上限**。原来每轮 +1 没有天花板，聊得勤一天就能顶到 95，
 * 机制就被"聊爆"了。现在按自然日计数（`plusDate` / `plusToday`），当天加分额度用完后
 * 再来也只是刷新 `lastInteraction`，confidence 不动；减分不受限制。
 *
 * @returns {{before:number, after:number, delta:number, capped?:boolean}}
 */
export function applyDelta(state, delta, { now = Date.now(), note = '', maxNotes = 20, dailyPlusCap = 5 } = {}) {
  const before = clampConfidence(state.confidence)
  let d = Math.round(Number(delta) || 0)

  // ── 每日加分额度：跨天自动重置；额度用完 d 归 0（不改 confidence，仍算一次互动）──
  let capped = false
  if (d > 0) {
    const dayKey = dateKeyOf(now)
    if (state.plusDate !== dayKey) {
      state.plusDate = dayKey
      state.plusToday = 0
    }
    const cap = Math.max(1, Math.round(Number(dailyPlusCap) || 5))
    const used = Math.max(0, Math.round(Number(state.plusToday) || 0))
    const left = Math.max(0, cap - used)
    if (d > left) {
      d = left
      capped = true
    }
    state.plusToday = used + d
  }

  if (!d) {
    // 额度用完：只记录"他来过"，数字不动
    state.lastInteraction = shortStamp(now)
    return { before, after: before, delta: 0, capped }
  }

  const after = clampConfidence(before + d)
  state.confidence = after
  state.lastMood = moodOf(after, d)
  state.lastInteraction = shortStamp(now)
  const label = String(note || (d >= 0 ? '他来找我了' : '被冷落')).trim().slice(0, 24)
  const line = `${shortStamp(now)} ${label} ${d > 0 ? '+' : ''}${d} → ${after}`
  state.notes = [line, ...(Array.isArray(state.notes) ? state.notes : [])].slice(0, Math.max(1, Number(maxNotes) || 20))
  return { before, after, delta: d, capped }
}

/**
 * 朝 50 走一步（**原地改** state）。一天只该调一次；调用方负责用 lastDecayDate 去重。
 * @returns {{before:number, after:number}}
 */
export function decayTowardMid(state, { now = Date.now(), step = 2, slotKey = dateKeyOf(now), maxNotes = 20 } = {}) {
  const before = clampConfidence(state.confidence)
  const s = Math.max(1, Math.round(Number(step) || 1))
  const after = before > MID_CONFIDENCE
    ? Math.max(MID_CONFIDENCE, before - s)
    : before < MID_CONFIDENCE ? Math.min(MID_CONFIDENCE, before + s) : MID_CONFIDENCE
  state.confidence = after
  state.lastMood = moodOf(after, 0)
  state.lastDecayDate = slotKey || dateKeyOf(now)
  const line = `${shortStamp(now)} 每天往中间走一点 ${before > after ? '-' : '+'}${Math.abs(after - before)} → ${after}`
  state.notes = [line, ...(Array.isArray(state.notes) ? state.notes : [])].slice(0, Math.max(1, Number(maxNotes) || 20))
  return { before, after }
}

/** 注入的那一句（硬截断）。格式是任务卡定的：`你和他现在的关系：confidence=… 心情=…` */
export function buildRelationshipLine(state, maxChars = 120) {
  const s = normalizeState(state)
  const line = `你和他现在的关系：confidence=${s.confidence} 心情=${s.lastMood}`
  return clipChars(line, Math.max(20, Number(maxChars) || 120))
}

/** 最近一次已经过去的 `decayHour:00`（补衰减用；凌晨判断"今天该不该衰减"就靠它）。 */
export function latestDecaySlotAt(now = Date.now(), hour = 4) {
  const base = new Date(now)
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.round(num(hour, 4, 0, 23)), 0, 0, 0)
  if (at.getTime() > Number(now)) at.setDate(at.getDate() - 1)
  return at.getTime()
}

/** 下一次 `decayHour:00`。 */
export function nextDecayAt(now = Date.now(), hour = 4) {
  const base = new Date(now)
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.round(num(hour, 4, 0, 23)), 0, 0, 0)
  if (at.getTime() <= Number(now)) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** 这一轮算不算"他"（主人私聊，或主人本人在群里发话）。 */
export function isMasterTurn(ev, adminQq = 0) {
  if (!ev) return false
  if (ev.sender?.isMaster === true) return true
  const qq = Number(adminQq)
  return qq > 0 && String(ev.chatKey || '') === `private:${qq}`
}

export default {
  id: 'relationship',
  title: '关系状态',
  order: 86,

  configSchema: {
    enabled: {
      type: 'bool',
      default: false,
      group: '关系',
      label: '启用关系状态',
      hint: '开：维护 confidence 并在提示里带一句；关：不读不写也不注入。',
    },
    decayHour: {
      type: 'int',
      default: 4,
      min: 0,
      max: 23,
      group: '关系',
      label: '每天几点衰减（小时）',
      hint: '凌晨 4 点，一天结束后没人聊天的时候。',
    },
    decayStep: {
      type: 'int',
      default: 2,
      min: 1,
      max: 10,
      step: 1,
      group: '关系',
      label: '每次衰减往中间走几点',
      hint: '朝 50 走。默认 2：95 大约 23 天回到中性。',
    },
    ignoreAfterMin: {
      type: 'float',
      default: 30,
      min: 0.01,
      max: 1440,
      group: '关系',
      label: '多久没接话算被冷落（分钟）',
      hint: '她主动开口后，超过这么久他还没说话 → confidence -1。支持小数（排障时可设 0.02 分钟试）。',
    },
    coldEnabled: {
      type: 'bool',
      default: true,
      group: '关系',
      label: '记录被冷落',
      hint: '开：她主动开口后你一直不接，confidence 会 -1；关：只加不减，关系只涨不跌。',
    },
    dailyPlusCap: {
      type: 'int',
      default: 5,
      min: 1,
      max: 50,
      step: 1,
      unit: '点',
      group: '关系',
      label: '每天最多涨多少',
      hint: '防止"聊得勤一天就顶到 95"。按自然日计，跨天自动重置；减分不受这个限制。',
    },
    injectEnabled: {
      type: 'bool',
      default: true,
      group: '关系注入',
      label: '每轮注入一句关系状态',
      hint: '开：每轮告诉她「你和他现在的关系：confidence=… 心情=…」；关：不告诉她。',
    },
    injectChars: {
      type: 'int',
      default: 120,
      min: 30,
      max: 400,
      step: 10,
      group: '关系注入',
      label: '注入上限（字）',
      hint: '硬截断。默认 120 字，别调太大：每轮都要带上，是固定开销。',
    },
    maxNotes: {
      type: 'int',
      default: 20,
      min: 1,
      max: 100,
      group: '关系',
      label: 'notes 保留条数',
      hint: '只影响文件里的备注，不参与判断。',
    },
  },

  setup(bot) {
    const log = bot.log || { info() {}, warn() {}, debug() {} }
    const cfg = () => bot.cfg || {}
    const dataDirOf = () => String(bot.core?.dataDir || '').trim()
    const fileOf = () => path.join(dataDirOf(), 'state', 'relationship.json')
    const adminQqOf = () => Number(bot.core?.adminQq) || 0
    const maxNotesOf = () => Math.round(num(cfg().maxNotes, 20, 1, 100))
    const dailyPlusCapOf = () => Math.round(num(cfg().dailyPlusCap, 5, 1, 50))
    const decayHourOf = () => Math.round(num(cfg().decayHour, 4, 0, 23))

    if (!dataDirOf()) {
      log.warn('[关系] bot.core.dataDir 为空，无法定位 state/relationship.json，插件不工作')
      return
    }

    let state = normalizeState({}, { maxNotes: maxNotesOf() })
    let existed = false
    try {
      existed = fs.existsSync(fileOf())
      state = normalizeState(readJsonFile(fileOf()), { maxNotes: maxNotesOf() })
    } catch (e) {
      // 没有文件是正常的（第一次装）；文件坏了就先用默认值，别让聊天因为一个 json 挂掉
      if (e?.code !== 'ENOENT') log.warn(`[关系] 读 ${fileOf()} 失败，用默认值: ${e.message}`)
    }
    /** 落盘形状就是任务卡要的四个字段 + lastDecayDate。 */
    const publicState = () => ({
      confidence: state.confidence,
      lastMood: state.lastMood,
      lastInteraction: state.lastInteraction,
      notes: [...state.notes],
      lastDecayDate: state.lastDecayDate,
    })
    function save() {
      try {
        writeJsonFileSync(fileOf(), publicState())
      } catch (e) {
        log.warn(`[关系] 写 ${fileOf()} 失败: ${e.message}`)
      }
    }

    let coldTimer = null
    let decayTimer = null

    /** 加减分唯一入口（顺手落盘 + 打日志）。 */
    function adjust(delta, note = '') {
      const { before, after, delta: applied } = applyDelta(state, delta, {
        now: Date.now(),
        note,
        maxNotes: maxNotesOf(),
        dailyPlusCap: dailyPlusCapOf(),
      })
      save()
      if (before !== after) log.info(`[关系] ${before} → ${after}（${note || (delta > 0 ? '他来找我了' : '被冷落')}）`)
      else if (!applied && delta > 0) log.debug?.(`[关系] 今天加分额度已满（${dailyPlusCapOf()} 点），只记互动不加分`)
      return { before, after }
    }

    /** 他主动开口 = 取消"被冷落"计时；超过窗口的那次已经在计时器里扣过了。 */
    function cancelCold() {
      if (!coldTimer) return
      clearTimeout(coldTimer)
      coldTimer = null
    }

    /** 她主动开口后开始等：等不到他说话就 -1（同一时间只留一个计时器）。 */
    function armCold() {
      if (cfg().enabled === false || cfg().coldEnabled === false) return
      cancelCold()
      const minutes = num(cfg().ignoreAfterMin, 30, 0.01, 1440)
      const ms = Math.max(50, Math.round(minutes * 60_000))
      coldTimer = setTimeout(() => {
        coldTimer = null
        adjust(-1, '他半天没接话')
      }, ms)
      coldTimer.unref?.() // 别拖住进程退出
    }

    /** 一天最多衰减一次：按"最近一个已经过去的 04:00"记日期，重启也不会重复扣。 */
    function decayOnce(reason = 'schedule') {
      if (cfg().enabled === false) return { skipped: 'disabled' }
      const hour = decayHourOf()
      const slotKey = dateKeyOf(latestDecaySlotAt(Date.now(), hour))
      if (reason !== 'manual' && state.lastDecayDate === slotKey) return { skipped: 'done', slotKey }
      const { before, after } = decayTowardMid(state, {
        now: Date.now(),
        step: Math.round(num(cfg().decayStep, 2, 1, 10)),
        slotKey,
        maxNotes: maxNotesOf(),
      })
      save()
      log.info(`[关系] 04:00 衰减 ${before} → ${after}（${reason}）`)
      return { before, after, slotKey }
    }

    function scheduleDecay() {
      if (decayTimer) { clearTimeout(decayTimer); decayTimer = null }
      if (cfg().enabled === false) return
      const at = nextDecayAt(Date.now(), decayHourOf())
      decayTimer = setTimeout(() => {
        decayTimer = null
        try { decayOnce('schedule') } finally { scheduleDecay() }
      }, Math.max(1000, at - Date.now()))
      decayTimer.unref?.()
    }

    // 启动补衰减：DSH 关了一整天再开，别把"昨天该走的那一步"漏掉。
    // 但**首次安装不补**：刚认识就先扣 2 分很奇怪，第一次衰减等下一个 04:00。
    const slotKey = dateKeyOf(latestDecaySlotAt(Date.now(), decayHourOf()))
    if (existed && slotKey && state.lastDecayDate !== slotKey) {
      const r = decayOnce('catchup')
      log.info(`[关系] 补衰减 ${r.before ?? '-'} → ${r.after ?? state.confidence}`)
    }
    scheduleDecay()
    log.info(`[关系] 已加载 ${fileOf()}｜confidence=${state.confidence} 心情=${state.lastMood}`)

    // ── 每轮：加分 + 注入；他回来了就取消冷落计时 ────────────────
    bot.on('before-turn', (ev) => {
      if (!ev || !ev.wake) return // 没唤醒的消息不算互动
      const c = cfg()
      if (c.enabled === false) return
      const master = isMasterTurn(ev, adminQqOf())
      if (master && ev.wake.kind !== 'proactive') {
        cancelCold() // 他说话了：这次不算被冷落
        ev._scratch = ev._scratch || Object.create(null)
        if (!ev._scratch[SCRATCH_KEY]) {
          ev._scratch[SCRATCH_KEY] = true
          adjust(+1, '他来找我了')
        }
      }
      if (c.injectEnabled === false || !master) return
      ev.hint = Array.isArray(ev.hint) ? ev.hint : []
      const line = buildRelationshipLine(state, Math.round(num(c.injectChars, 120, 30, 400)))
      if (line && !ev.hint.includes(line)) ev.hint.push(line)
    })

    // ── 出站：她主动开口的轮次 → 开始等他的回应 ──────────────────
    bot.onOutbound((out) => {
      if (!out || cfg().enabled === false) return
      if (out.turnCtx?.wakeKind !== 'proactive') return
      armCold()
    })

    // 控制台/测试/排障入口
    bot.shared.relationshipStatus = () => ({ ...publicState(), file: fileOf() })
    bot.shared.relationshipAdjust = (delta, note = '') => {
      const r = adjust(Number(delta) || 0, note)
      return { ...r, ...publicState() }
    }
    bot.shared.relationshipDecay = () => decayOnce('manual')

    try { bot.onDispose?.(() => {
      cancelCold()
      if (decayTimer) { clearTimeout(decayTimer); decayTimer = null }
    }) } catch { /* 老内核没有 onDispose：两个定时器都 unref 过 */ }
  },
}

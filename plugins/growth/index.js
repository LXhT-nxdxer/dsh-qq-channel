/**
 * growth — 成长日记（每天一篇；第二天她自己"记得"）
 *
 * 干什么：
 *   ① 每天 `hour:minute`（默认 23:00）写一篇当天日记到 `<dataDir>/state/growth/YYYY-MM-DD.md`；
 *   ② 启动时（以及每次写完日记后）读最近 2 天日记进内存，**硬截断 ≤ injectChars（默认 300 字）**，
 *      每轮拼进 prompt —— 她回话时知道自己前一天干了什么。
 *
 * 调度（2026-10-31 改）：定时器**无条件**挂载、30 秒轮询一次，每轮现读 cfg 判断 enabled 并重算
 *   「最近该有的那一篇」。控制台热改开关/时间只会原地同步 bot.cfg、**不会重跑 setup**，
 *   所以不能只在 setup 里排一次班（旧实现因此启动时关着就永远不跑）。
 *
 * 日记由谁生成（选型理由，改动前先看）：
 *   正文走 `bot.dsh.runIsolatedTask`（内核起一个一次性后台会话，返回模型最终文本），**落盘由本插件做**。
 *   不用 `bot.dsh.prompt` 的理由：
 *     · `prompt()` 是往「QQ 线会话」里塞一条消息，**没有返回值**，拿不到日记正文；
 *     · QQ 线用 `qq-chat` preset（cordis.patch.yml），shell / 文件工具全裁掉 —— 模型在那条会话里
 *       根本写不了 `state/growth/*.md`，让它"自己存"等于没存；
 *     · QQ 线里模型只能用 `mcp__qq__*` 回话，让它写日记很容易变成往聊天里发一条日记。
 *   runIsolatedTask 的已知代价：每跑一次会新建一个后台会话（侧栏可能闪一下），跑完立刻归档。
 *   好处是内核把这些会话登记进 `maintSessionIds`，里面的 `mcp__qq__*` 工具一律被拒 ——
 *   日记不可能被误发到聊天里。代价一天一次，可接受。
 *
 * 注入位置（为什么不是"静态 system prompt"）：
 *   子插件契约（contracts.js）只有五个入站阶段，**没有**静态 system prompt 扩展点；
 *   dev 指南又明令「不要每轮改静态系统提示（会毁 KV cache）」。所以按正确姿势走
 *   `before-turn` 的 `ev.hint`：读完缓存成一份文本，每轮只 push 同一份，
 *   `kernel/format.js` 会把它拼在正文 / 群上文之后、尾契约之前。
 *
 * 素材从哪来：
 *   当日聊条留档 `logs/qq_chat/*.jsonl`（内核 `archive` 默认开）。只把「今天、in/out」的记录
 *   按时间顺序截到 `materialChars` 字喂给模型。留档关掉时素材为空 → prompt 里明确说今天很安静，
 *   日记照写（她的一天不只有聊天）。
 *   办公线（plugins/work-line）的东西不算聊天：`//xxx` 指令本身、以及她转述办公结果那一轮
 *   （work-line 写的时间窗）都会被跳过，见 `readDayMaterial`。
 */
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteFileSync, readJsonFile, stripBom } from '../../platform/atomic.js'
import { clipChars } from '../../kernel/format.js'

/** 日记目录（相对 dataDir；路径只用 path.join 拼，跨平台）。 */
const GROWTH_DIR = path.join('state', 'growth')
/** 「最近 2 天」 */
const INJECT_DAYS = 2
/** 兜底日记里每条素材最多引用多少字 */
const FALLBACK_LINE_CHARS = 60
/** 单个留档文件最多往回看多少行（一天的群聊可能几千行，没必要全读） */
const ARCHIVE_MAX_LINES_PER_FILE = 400
/** 素材里一条消息最多留多少字 */
const MATERIAL_LINE_CHARS = 80
/**
 * 到点检查的轮询间隔（30 秒）。
 * 为什么用轮询而不是 setup 里只 setTimeout 一次：
 *   ① 控制台热改 enabled / hour / minute 只会原地同步 bot.cfg，**不会重跑 setup**，
 *      一次性的 setTimeout 会按旧时间睡到天荒地老；
 *   ② 每轮都按当前 cfg 重算「最近该有的那一篇」，热改时间下一轮就生效，不用额外监听配置变更。
 * 日记精确到分钟，30 秒的误差无所谓。
 */
const TICK_MS = 30_000

const num = (value, fallback, min, max) => {
  const n = Number(value)
  const base = Number.isFinite(n) ? n : fallback
  return Math.min(max, Math.max(min, base))
}

/** 本地日期键 `YYYY-MM-DD`（服务器在哪个时区就按哪个时区过一天）。 */
export function dateKeyOf(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 某一天的本地起止毫秒（[00:00, 次日 00:00)），留档按它筛"今天"。 */
export function dayRangeOf(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
  return { start, end: next }
}

/** 日记目录绝对路径。 */
export function growthDirOf(dataDir) {
  const root = String(dataDir || '').trim()
  return root ? path.join(root, GROWTH_DIR) : ''
}

/** 某天的日记文件绝对路径。 */
export function diaryFileOf(dataDir, key) {
  const dir = growthDirOf(dataDir)
  return dir && key ? path.join(dir, `${key}.md`) : ''
}

/** 下一次 `hour:minute` 的毫秒时间戳（今天已过就明天；用 setDate 而不是 +86400000，夏令时不跳）。 */
export function nextRunAt(now = Date.now(), hour = 23, minute = 0) {
  const base = new Date(now)
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0)
  if (at.getTime() <= Number(now)) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** 最近一次已经过去的 `hour:minute` 是哪个时刻（补写用：判断"最近该有的那篇"）。 */
export function latestSlotAt(now = Date.now(), hour = 23, minute = 0) {
  const base = new Date(now)
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0)
  if (at.getTime() > Number(now)) at.setDate(at.getDate() - 1)
  return at.getTime()
}

/**
 * 最近 N 天的日记（按日期倒序，只认 `YYYY-MM-DD.md`，**不认未来日期**）。
 * 读不了 / 空文件直接跳过 —— 少一篇日记不能让注入变成一坨空白。
 * @returns {Array<{key:string, text:string}>}
 */
export function pickRecentDiaries(dir, { today = dateKeyOf(), days = INJECT_DAYS } = {}) {
  const root = String(dir || '').trim()
  if (!root) return []
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return [] // 目录还不存在 = 还没写过第一篇
  }
  const keys = names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((k) => !today || k <= today)
    .sort()
    .reverse()
    .slice(0, Math.max(1, Number(days) || INJECT_DAYS))
  const out = []
  for (const key of keys) {
    try {
      const text = stripBom(fs.readFileSync(path.join(root, `${key}.md`), 'utf8')).trim()
      if (text) out.push({ key, text })
    } catch {
      /* 单篇读失败：跳过 */
    }
  }
  return out
}

/**
 * 拼「最近 N 天日记」注入块。**硬截断**到 maxChars（这是契约里说的「一律硬截断」）。
 * 没日记 / 目录不存在 → 返回 ''（调用方就不要 push 空串）。
 */
export function buildDiaryInject({ dir, today = dateKeyOf(), days = INJECT_DAYS, maxChars = 300 } = {}) {
  const list = pickRecentDiaries(dir, { today, days })
  if (!list.length) return ''
  const head = `[日记·最近${list.length}天，我自己的记录，别复述:`
  // 每条日记的标签是「【YYYY-MM-DD】」，先把标签、换行和右括号让出来，剩下的平摊给正文
  const labelChars = list.reduce((n, d) => n + d.key.length + 3, 0)
  const budget = Math.max(list.length * 16, maxChars - head.length - labelChars - list.length - 1)
  const per = Math.max(16, Math.floor(budget / list.length))
  const body = list.map((d) => `【${d.key}】${clipChars(d.text, per)}`).join('\n')
  const text = `${head}\n${body}]`
  if (text.length <= maxChars) return text
  const cut = Math.max(0, maxChars - 1)
  return `${clipChars(text, cut)}…`
}

/** 素材一条：剥 CQ 码、压空白、去掉整段纯媒体，限长。 */
export function cleanMaterialText(text) {
  const s = String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/\[AT:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return clipChars(s, MATERIAL_LINE_CHARS)
}

/** 办公线（plugins/work-line）写下的时间窗文件（相对实例数据目录）。 */
export const WORK_LINE_SKIP_REL = path.join('state', 'work-line', 'diary-skip.json')

/**
 * 这条留档是不是「办公指令」：主人私聊发 `//xxx` 时，work-line 会在 intercept 截走它，
 * 但留档在 passive-tap（intercept 之前）就写完了 —— 所以 jsonl 里一定有 `//` 原文。
 * 日记素材不该出现「主人: //查下E盘还剩多少」这种话（那是指令，不是聊天）。
 */
export function isWorkCommandText(text) {
  // 与 work-line 的 parseWorkCommand 对齐：`//` 后面允许先来点空白（`// 查下E盘` 也算指令）
  return /^\/\/\s*\S/.test(String(text ?? '').trim())
}

/** ts 是否落在某个时间窗里（窗坏了/字段缺失一律当不命中，宁可多记一条也别漏聊天）。 */
export function inAnyWindow(ts, windows) {
  const t = Number(ts)
  if (!Number.isFinite(t) || !Array.isArray(windows)) return false
  for (const w of windows) {
    const a = Number(w?.from)
    const b = Number(w?.to)
    if (Number.isFinite(a) && Number.isFinite(b) && t >= a && t <= b) return true
  }
  return false
}

/**
 * 读办公线的时间窗（work-line 写，格式见 plugins/work-line/index.js）。
 * 文件缺失/坏了都返回 []：日记照写 —— 过滤是锦上添花，不能因为它的 IO 失败把日记拖死。
 */
export function loadWorkLineSkipWindows(dataDir) {
  const root = String(dataDir || '').trim()
  if (!root) return []
  try {
    const raw = readJsonFile(path.join(root, WORK_LINE_SKIP_REL), { log: { warn() {} } })
    const list = Array.isArray(raw?.windows) ? raw.windows : []
    return list
      .map((w) => ({ from: Number(w?.from), to: Number(w?.to), kind: String(w?.kind || '') }))
      .filter((w) => Number.isFinite(w.from) && Number.isFinite(w.to) && w.to >= w.from)
  } catch {
    return []
  }
}

/**
 * 读当天聊天留档 → 一段「今天她看到/说过的话」（按时间正序，**保留最新的**到字数上限）。
 * 留档结构见 index.js 的 makeArchiver：`{ dir:'in'|'out', ts, sender:{name,card}, text }`。
 * 只给昵称、不带 QQ 号：日记里写号码很怪，也没必要。
 *
 * 办公线（plugins/work-line）隔离：`//xxx` 指令的 in 记录按前缀跳过；
 * `skipWindows` 覆盖的 out 记录（她转述办公结果那一轮）也跳过 —— 办公任务不该进日记。
 */
export function readDayMaterial({
  archiveDir,
  start = dayRangeOf().start,
  end = dayRangeOf().end,
  maxChars = 1500,
  maxLinesPerFile = ARCHIVE_MAX_LINES_PER_FILE,
  skipWindows = [],
} = {}) {
  const root = String(archiveDir || '').trim()
  if (!root) return ''
  let names = []
  try {
    names = fs.readdirSync(root).filter((n) => n.toLowerCase().endsWith('.jsonl'))
  } catch {
    return ''
  }
  const rows = []
  for (const name of names) {
    let raw = ''
    try {
      raw = fs.readFileSync(path.join(root, name), 'utf8')
    } catch {
      continue
    }
    const lines = stripBom(raw).split(/\r?\n/).filter(Boolean)
    const from = Math.max(0, lines.length - Math.max(20, Number(maxLinesPerFile) || ARCHIVE_MAX_LINES_PER_FILE))
    for (let i = from; i < lines.length; i += 1) {
      let rec = null
      try {
        rec = JSON.parse(lines[i])
      } catch {
        continue // 半行（正在写）或坏行：跳过
      }
      const ts = Number(rec?.ts) || 0
      if (!(ts >= start && ts < end)) continue
      const text = cleanMaterialText(rec?.text)
      if (!text) continue
      const dir = String(rec?.dir || '')
      if (dir !== 'in' && dir !== 'out') continue
      // 办公线隔离（plugins/work-line）：工作指令不是聊天，她转述执行结果那一轮也不进日记。
      // 指令的 in 记录靠 `//` 前缀认（留档在 intercept 之前，拦不住）；转述轮靠时间窗。
      if (dir === 'in' && isWorkCommandText(rec?.text)) continue
      if (dir === 'out' && inAnyWindow(ts, skipWindows)) continue
      const who = dir === 'out'
        ? '我'
        : String(rec?.sender?.card || rec?.sender?.name || '').trim().slice(0, 12) || '有人'
      rows.push({ ts, line: `${who}: ${text}` })
    }
  }
  if (!rows.length) return ''
  rows.sort((a, b) => a.ts - b.ts)
  // 从最近往回堆，超预算就停：一条日记里"今天最后发生的事"比上午的寒暄重要
  const picked = []
  let used = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const piece = rows[i].line
    if (used + piece.length + 1 > maxChars) break
    picked.unshift(piece)
    used += piece.length + 1
  }
  if (!picked.length) return clipChars(rows[rows.length - 1].line, maxChars)
  return picked.join('\n')
}

/** 生成日记的提示词（纯函数，测试可断言）。 */
export function buildDiaryPrompt({ dateLabel = dateKeyOf(), material = '', minChars = 200, maxChars = 400 } = {}) {
  const body = material
    ? `下面是你今天在 QQ 上看到的话（可能不全）：\n${material}`
    : '今天几乎没人说话，安安静静的。'
  return [
    `${dateLabel} 到了，写今天这一篇日记。`,
    body,
    '要求：',
    `- 用你自己的口气写，第一人称，短句、口语，别客套、别总结人生道理；`,
    `- ${minChars}–${maxChars} 个字；`,
    '- 只输出日记正文：不要标题、不要日期行、不要 Markdown、不要分条、不要解释；',
    '- 不要调用任何工具，直接说话就行。',
  ].join('\n')
}

/**
 * 清洗模型输出：去代码围栏、去开头那行"标题/日期/日记："、压空行、**硬截断**到 maxChars。
 * 模型很爱先来一句「## 2026-10-31 日记」，落到文件里就成了假标题。
 */
export function sanitizeDiaryText(text, maxChars = 400) {
  let s = stripBom(String(text ?? '')).replace(/\r\n/g, '\n').trim()
  if (!s) return ''
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  const lines = s.split('\n')
  while (lines.length) {
    const first = lines[0].trim()
    if (!first) {
      lines.shift()
      continue
    }
    const isHeading = /^#{1,6}\s/.test(first)
    const isDate = /^\d{4}\s*[-/.年]\s*\d{1,2}/.test(first)
    const isLabel = /^(日记|随笔|周记|日记正文)\s*[:：]?\s*$/.test(first)
    if (isHeading || isDate || isLabel) {
      lines.shift()
      continue
    }
    break
  }
  s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!s) return ''
  return clipChars(s, Math.max(20, Number(maxChars) || 400))
}

/**
 * 模型不可用 / 输出为空时的兜底日记：只写"今天听到了什么"，不编没发生的事。
 * 缺点：字数可能到不了 minChars（安静的一天本来就没什么可写），这是刻意接受的降级。
 */
export function fallbackDiary(material, maxChars = 400) {
  const lines = String(material ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const parts = [lines.length ? '今天过得好快，随手记两句。' : '今天安安静静的，没什么人说话。']
  if (lines.length) {
    parts.push('今天听到的：')
    for (const line of lines.slice(-3)) parts.push(clipChars(line, FALLBACK_LINE_CHARS))
  }
  parts.push(lines.length ? '就这样吧，明天再说。' : '一天就这么过去了，也挺好。')
  return clipChars(parts.join('\n'), Math.max(40, Number(maxChars) || 400))
}

export default {
  id: 'growth',
  title: '成长日记',
  order: 85,

  configSchema: {
    enabled: {
      type: 'bool',
      default: false,
      group: '成长日记',
      label: '启用成长日记',
      hint: '开：每天到点写一篇日记，并把最近两天拼进提示；关：完全不写也不注入。',
    },
    hour: {
      type: 'int',
      default: 23,
      min: 0,
      max: 23,
      group: '成长日记',
      label: '每天几点写（小时）',
      hint: '默认 23 点，一天的事基本都发生完了。',
    },
    minute: {
      type: 'int',
      default: 0,
      min: 0,
      max: 59,
      group: '成长日记',
      label: '分钟',
      hint: '配合上面「小时」用。默认 23:00 写日记；错过会在启动时补写。',
    },
    minChars: {
      type: 'int',
      default: 200,
      min: 80,
      max: 600,
      step: 10,
      group: '成长日记',
      label: '日记最少字数',
      hint: '只是提示词里的目标字数；模型写短了不会重写。',
    },
    maxChars: {
      type: 'int',
      default: 400,
      min: 120,
      max: 1200,
      step: 10,
      group: '成长日记',
      label: '日记最多字数',
      hint: '超过就硬截断（不保留半句话之外的任何东西）。',
    },
    materialChars: {
      type: 'int',
      default: 1500,
      min: 200,
      max: 6000,
      step: 100,
      group: '成长日记',
      label: '喂给模型的聊天素材上限（字）',
      hint: '当天留档里取最近这么多字；越大越贵，1500 够写一篇。',
    },
    timeoutSec: {
      type: 'int',
      default: 120,
      min: 30,
      max: 600,
      step: 10,
      group: '成长日记',
      label: '生成超时（秒）',
      hint: '超时按生成失败处理，走本地兜底。',
    },
    catchUp: {
      type: 'bool',
      default: true,
      group: '成长日记',
      label: '启动时补写错过的日记',
      hint: '开：DSH 启动时如果最近该有的那篇还没写，启动后 30 秒内补一次；失败当天不重试。',
    },
    injectEnabled: {
      type: 'bool',
      default: true,
      group: '成长注入',
      label: '把最近几天的日记拼进提示',
      hint: '开：每轮带一点最近几天的日记（她"记得"自己写过什么）；关：照写但不进对话。',
    },
    injectDays: {
      type: 'int',
      default: 2,
      min: 1,
      max: 30,
      step: 1,
      unit: '天',
      group: '成长注入',
      label: '注入几天',
      hint: '默认 2 天。换了新会话、想把之前的日记"接上"，可以调大（配合注入上限一起加）。',
    },
    injectChars: {
      type: 'int',
      default: 300,
      min: 60,
      max: 1200,
      step: 10,
      group: '成长注入',
      label: '注入上限（字）',
      hint: '硬截断。默认 300，别调太大：这是每轮都要带上的固定开销。',
    },
    injectScope: {
      type: 'enum',
      default: 'masterPrivate',
      options: [
        { value: 'masterPrivate', label: '只主人私聊' },
        { value: 'master', label: '主人（私聊 + 群）' },
        { value: 'all', label: '所有会话' },
      ],
      group: '成长注入',
      label: '注入范围',
      hint: '日记只给自己看：默认只在主人私聊里带；选「所有会话」会让群聊也带上她最近的日记。',
    },
  },

  setup(bot) {
    const log = bot.log || { info() {}, warn() {}, debug() {} }
    const cfg = () => bot.cfg || {}
    const dataDirOf = () => String(bot.core?.dataDir || '').trim()
    const dirOf = () => growthDirOf(dataDirOf())
    const hourOf = () => Math.round(num(cfg().hour, 23, 0, 23))
    const minuteOf = () => Math.round(num(cfg().minute, 0, 0, 59))
    const maxCharsOf = () => Math.round(num(cfg().maxChars, 400, 120, 1200))
    const minCharsOf = () => Math.round(num(cfg().minChars, 200, 80, 600))
    const injectCharsOf = () => Math.round(num(cfg().injectChars, 300, 60, 1200))
    const injectDaysOf = () => Math.round(num(cfg().injectDays, INJECT_DAYS, 1, 30))
    const archiveDirOf = () => String(bot.core?.archive?.dir || '').trim()

    let timer = null
    let running = null
    let disposed = false
    let lastResult = null
    let inject = { text: '', today: '', sig: '' }
    /** 上一次看到的 hour:minute（热改时打一条日志，方便排障）。 */
    let plannedPlan = ''
    /** 启动时日记目录是否已存在：首次安装不给「昨天」编一篇（当天到点照写）。 */
    let dirExistedAtBoot = false
    /** 本进程里已经尝试补写过的日期：一天最多试一次，失败不每分钟重刷模型。 */
    const attemptedKeys = new Set()
    /** 关着时每 30 秒都会 tick 一次，debug 日志最多每小时一条（别刷屏）。 */
    let disabledLoggedAt = 0

    /** 注入缓存的身份：开关 / 上限 / 天数 / 目录，任一变了就重读（控制台热改后不必等重启）。 */
    const injectSigOf = () => [
      cfg().enabled !== false ? 1 : 0,
      cfg().injectEnabled !== false ? 1 : 0,
      injectCharsOf(),
      injectDaysOf(),
      dirOf(),
    ].join('|')

    /** 重读最近两天日记（启动时 / 写完日记 / 跨天 / 注入配置热改时各一次，不是每轮读盘）。 */
    function refreshInject() {
      const today = dateKeyOf()
      const sig = injectSigOf()
      const c = cfg()
      // 「没开」也要把 sig 记下来：之后在控制台打开时，before-turn 靠 sig 变化触发重读，
      // 否则缓存里一直是空串，要到第二天才恢复注入。
      if (c.enabled === false || c.injectEnabled === false) {
        inject = { text: '', today, sig }
        return
      }
      try {
        inject = { text: buildDiaryInject({ dir: dirOf(), today, days: injectDaysOf(), maxChars: injectCharsOf() }), today, sig }
      } catch (e) {
        inject = { text: '', today, sig }
        log.warn(`[成长] 读日记失败，这轮不注入: ${e.message}`)
      }
    }

    /** 注入只给"该看的人"，日记不是群公告。 */
    function scopeOk(ev) {
      const scope = String(cfg().injectScope || 'masterPrivate')
      if (scope === 'all') return true
      if (scope === 'master') return ev.sender?.isMaster === true
      return ev.sender?.isMaster === true && !ev.isGroup
    }

    /**
     * 写一篇日记。单飞（同一时刻只有一个在跑）；`force` = 已经有文件也重写。
     * @returns {Promise<{ok:boolean, file?:string, chars?:number, via?:string, skipped?:string, reason?:string}>}
     */
    async function generate({ reason = 'manual', day = new Date(), force = false } = {}) {
      const c = cfg()
      if (c.enabled === false) return { ok: false, reason: 'disabled' }
      if (!dataDirOf()) return { ok: false, reason: 'no-data-dir' }
      if (running) return running
      running = (async () => {
        const key = dateKeyOf(day)
        if (!key) return { ok: false, reason: 'bad-day' }
        const file = diaryFileOf(dataDirOf(), key)
        if (!force && fs.existsSync(file)) {
          log.debug?.(`[成长] ${key} 的日记已经在，跳过（${reason}）`)
          return { ok: true, skipped: 'exists', file }
        }
        const range = dayRangeOf(day)
        const material = readDayMaterial({
          archiveDir: archiveDirOf(),
          start: range.start,
          end: range.end,
          maxChars: Math.round(num(cfg().materialChars, 1500, 200, 6000)),
          // 办公线（plugins/work-line）标记的「她转述办公结果」时间窗：这段素材不进日记
          skipWindows: loadWorkLineSkipWindows(dataDirOf()),
        })
        const prompt = buildDiaryPrompt({
          dateLabel: key,
          material,
          minChars: minCharsOf(),
          maxChars: maxCharsOf(),
        })
        let text = ''
        let via = 'model'
        let why = ''
        const task = bot.dsh?.runIsolatedTask
        if (typeof task === 'function') {
          try {
            const r = await task({
              name: `成长日记 ${key}`,
              prompt,
              timeoutMs: Math.round(num(cfg().timeoutSec, 120, 30, 600)) * 1000,
            })
            if (r?.ok) text = sanitizeDiaryText(r.text, maxCharsOf())
            else why = String(r?.reason || 'empty')
          } catch (e) {
            why = e.message
            log.warn(`[成长] 生成失败（${key}）: ${e.message}`)
          }
        } else {
          why = 'runIsolatedTask 不可用'
          log.warn('[成长] bot.dsh.runIsolatedTask 不可用，改用本地兜底')
        }
        // 模型偶尔交回一段"好的，以下是日记："之类的东西，或者干脆空手；短得离谱同样当失败
        if (!text || text.length < Math.max(40, Math.floor(minCharsOf() * 0.4))) {
          text = fallbackDiary(material, maxCharsOf())
          via = 'fallback'
        }
        atomicWriteFileSync(file, `${text}\n`)
        refreshInject()
        lastResult = { at: Date.now(), key, file, chars: text.length, via, reason }
        log.info(`[成长] 写好 ${key}（${text.length} 字，${via}${why ? `，原因: ${why}` : ''}）`)
        return { ok: true, file, chars: text.length, via, reason, materialChars: material.length }
      })().catch((e) => {
        log.error?.(`[成长] 写日记抛错: ${e.stack || e.message}`)
        return { ok: false, reason: e.message }
      }).finally(() => { running = null })
      return running
    }

    /** 本地时间戳（日志/状态用，不带 locale 依赖）。 */
    const stampOf = (ts) => {
      const d = new Date(ts)
      return `${dateKeyOf(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    /**
     * 一轮「到点检查 + 补写」。**与 enabled 解耦**：定时器永远挂着，开关只在这里判断。
     * @param {number} now 可注入的时间戳（单测用；默认当前时间）
     */
    async function tick(now = Date.now()) {
      if (disposed) return { skipped: 'disposed' }
      const c = cfg()
      const hour = hourOf()
      const minute = minuteOf()
      const plan = `${hour}:${String(minute).padStart(2, '0')}`
      if (plan !== plannedPlan) {
        const firstPlan = !plannedPlan
        plannedPlan = plan
        if (!firstPlan && c.enabled !== false) {
          log.info(`[成长] 写日记时间改为每天 ${plan}，下一轮按新时间检查`)
        }
      }
      // 关着就安静跳过（debug 级、每小时最多一条）：定时器照样在跑，控制台一开就能接上。
      if (c.enabled === false) {
        if (now - disabledLoggedAt >= 3_600_000) {
          disabledLoggedAt = now
          log.debug?.('[成长] 未启用，本轮跳过（之后每小时最多记一条）')
        }
        return { skipped: 'disabled' }
      }
      if (!dataDirOf()) return { skipped: 'no-data-dir' }
      // 有别的生成在跑（手动 growthSync / 上一轮特别慢）→ 这轮不抢，也不标记「已尝试」。
      if (running) return { skipped: 'busy' }
      // 「最近该有的那一篇」= 已经过去的最近一个 hour:minute（今天到点就是今天，没到点就是昨天）。
      const slot = latestSlotAt(now, hour, minute)
      const key = dateKeyOf(slot)
      if (!key) return { skipped: 'bad-day' }
      // 文件在 = 这天已经写过：**一天绝不写第二篇**（重启/热开/轮询都靠这一条幂等）。
      if (fs.existsSync(diaryFileOf(dataDirOf(), key))) return { skipped: 'exists', key }
      const isToday = key === dateKeyOf(now)
      // 昨天的补写：catchUp 关掉不补；首次安装也不给「昨天」编日记。
      // 今天这个时点只要过了就照写 —— 包含「在控制台把时间改到当前时刻之前」的热改场景。
      if (!isToday && (c.catchUp === false || !dirExistedAtBoot)) return { skipped: 'catchup-off', key }
      // 同一天只尝试一次：生成/落盘失败也等下一天，别每 30 秒重刷一次模型。
      if (attemptedKeys.has(key)) return { skipped: 'attempted', key }
      attemptedKeys.add(key)
      return generate({ reason: isToday ? 'schedule' : 'catchup', day: new Date(slot) })
    }

    // ── 启动：先把最近两天读进来，再把定时器**无条件**挂上 ─────────────
    if (!dataDirOf()) {
      log.warn('[成长] bot.core.dataDir 为空，无法定位 state/growth，插件不工作')
      return
    }
    dirExistedAtBoot = fs.existsSync(dirOf())
    refreshInject()
    const injectKeys = inject.text ? '有' : '无'
    log.info(`[成长] 日记目录 ${dirOf()}｜注入 ${injectKeys}（≤${injectCharsOf()} 字）`)

    // 为什么无条件挂定时器（2026-10-31 真机 bug 修复）：
    //   控制台改 enabled / hour / minute 后走 kernel.reloadConfig，内核只**原地同步 bot.cfg**，
    //   setup 不会重跑。旧实现「setup 时 enabled=false 就 return + nextRunAt 只算一次」→
    //   启动时关着的实例永远没有定时器，后来开开关也只看到「已停用」（真机日志正是如此）。
    // 现在定时器常驻、不看 enabled：每轮 tick 现读 cfg 重算，开关和时间怎么改下一轮都能接上。
    plannedPlan = `${hourOf()}:${String(minuteOf()).padStart(2, '0')}`
    timer = setInterval(() => {
      tick().catch((e) => log.warn?.(`[成长] 定时检查异常: ${e?.message || e}`))
    }, TICK_MS)
    timer.unref?.() // 别让定时器拖住进程退出

    if (cfg().enabled === false) {
      log.debug?.('[成长] 未启用：定时器已挂载，控制台打开后下一轮自动补写/排班')
    } else {
      const now = Date.now()
      const slotKey = dateKeyOf(latestSlotAt(now, hourOf(), minuteOf()))
      const canCatchUp = slotKey === dateKeyOf(now) || (cfg().catchUp !== false && dirExistedAtBoot)
      if (slotKey && canCatchUp && !fs.existsSync(diaryFileOf(dataDirOf(), slotKey))) {
        log.info(`[成长] ${slotKey} 的日记还没写，启动后 ${Math.round(TICK_MS / 1000)} 秒内补一次`)
      } else {
        const at = nextRunAt(now, hourOf(), minuteOf())
        log.info(`[成长] 下次写日记 ${stampOf(at)}（${Math.round((at - now) / 60000)} 分钟后；`
          + `每 ${Math.round(TICK_MS / 1000)} 秒核对一次）`)
      }
    }

    // ── 每轮注入：只 push 缓存的那一份（≤300 字，硬截断已在上游做好） ──
    bot.on('before-turn', (ev) => {
      if (!ev || !ev.wake) return // 没唤醒的消息也会走 before-turn，别给它们添开销
      const c = cfg()
      if (c.enabled === false || c.injectEnabled === false) return
      if (!scopeOk(ev)) return
      // 跨天 / 注入开关或上限被控制台热改 / 刚才还是关着：都重读一次缓存。
      if (inject.today !== dateKeyOf() || inject.sig !== injectSigOf()) refreshInject()
      if (!inject.text) return
      ev.hint = Array.isArray(ev.hint) ? ev.hint : []
      if (!ev.hint.includes(inject.text)) ev.hint.push(inject.text)
    })

    // 控制台/测试/排障入口：手动写一篇、看状态、立刻触发一轮到点检查（不等 30 秒轮询）
    bot.shared.growthSync = (opts = {}) => generate({ ...opts, reason: opts.reason || 'manual' })
    bot.shared.growthTick = (now) => tick(now)
    bot.shared.growthStatus = () => ({
      enabled: cfg().enabled !== false,
      dir: dirOf(),
      hour: hourOf(),
      minute: minuteOf(),
      nextAt: cfg().enabled === false ? 0 : nextRunAt(Date.now(), hourOf(), minuteOf()),
      injected: Boolean(inject.text),
      injectChars: inject.text.length,
      injectLimit: injectCharsOf(),
      lastResult,
    })

    try { bot.onDispose?.(() => {
      disposed = true
      if (timer) { clearInterval(timer); timer = null }
    }) } catch { /* 老内核没有 onDispose：定时器 unref 过，进程退出不受影响 */ }
  },
}

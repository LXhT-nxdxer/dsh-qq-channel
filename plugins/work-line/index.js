/**
 * work-line — 办公线（主人私聊 `//xxx`）
 *
 * 干什么：
 *   ① 主人在私聊里发 `//查下E盘还剩多少` 这类「办公指令」时，这条消息**不进她的会话**
 *      （intercept 阶段就 `ev.stopped`：零 token、不写上下文、不进日记素材）；
 *   ② 指令丢进**独立的办公会话**执行（`work:<主人QQ>`，有全工具：读文件 / 跑命令 / 联网）；
 *   ③ 干完把**结论**（不含指令原文）投回**她自己的会话**，让她用自己的口气回主人。
 *
 * 为什么必须跑在斜杠命令分发之前（内核 index.js 的 intercept order 5）：
 *   内核只取 `t.slice(1)` 的第一个词去 `kernel.commands` 里查 —— `//xxx` 会被当成
 *   「命令名 /xxx」去查，**查不到就静默放过**（当普通聊天进她的会话）。一旦进去，
 *   办公指令就变成她聊天上下文的一部分：烧 token、写进会话历史/日记素材，
 *   而且任务在哪跑、有没有办成主人完全看不到。
 *   所以本插件在 intercept 用 **order 1** 先截：比 owner-commands(3) /
 *   group-command-guard(4) / 内核(5) 都早；且只认「主人私聊 + `//` + 后面有内容」，
 *   其余形态（群里的 `//`、外人的 `//`、光秃秃的 `//`、单斜杠 `/help`）统统放行。
 *
 * 办公会话为什么用 `work:<QQ>` 这个独立命名空间（不是 `private:<QQ>#work`）：
 *   · 工具门（index.js 的 tools.guard）按 `group:` / `private:` 前缀认线，
 *     `work:` 落在「不是 QQ 线」那一支 → **整条放行全工具**（不需要改内核、不用开白名单）；
 *     带 `#work` 的 key 不算 `private:<QQ>` 精确匹配，会被当成外人挡掉，所以不能用它；
 *   · 驱动里的 `presetFor()` 让 `work:` 跟主人私聊用同一套 preset（全工具），
 *     否则用户把全局 preset 配成聊天裁剪版时，办公会话会一个工具都调不动；
 *   · 它和 `private:<QQ>` 是**两条** DSH 会话：她的聊天上下文/记忆不会混进办公任务，
 *     办公任务的过程也不会污染她的会话。
 *
 * 结果怎么回：
 *   不走 deliver 直发（那样是系统回执，没有她的语气），而是往她自己的会话投一条
 *   `[[办公]] 你刚帮他办的事有结果了：<结论>…` 的 prompt，由她正常出站回话。
 *   哨兵 `[[办公]]` 同时是日记过滤的标记（见下）。
 *
 * 日记/记忆隔离：
 *   · 指令本身：进模型前就被截了，她的会话里没有；
 *   · 她的转述轮：写进 `<dataDir>/state/work-line/diary-skip.json` 的时间窗，
 *     growth 取日记素材时跳过窗口内的 out 记录；
 *   · `//` 指令的留档记录：passive-tap 留档跑在 intercept **之前**，拦不住，
 *     所以 growth 额外按「文本以 // 开头」跳过这类 in 记录。
 */

import path from 'node:path'

import { isMasterPrivate } from '../../contracts.js'
import { clipChars } from '../../kernel/format.js'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'

/** 她转述办公结果那一轮的固定哨兵（prompt 开头；会话里一眼能认出来）。 */
export const WORK_SENTINEL = '[[办公]]'
/** 办公会话的 chatKey 命名空间（不是 group:/private:，工具门按「非 QQ 线」整条放行）。 */
export const WORK_KEY_PREFIX = 'work:'
/** 日记过滤时间窗的落盘位置（相对实例数据目录；写方是本插件，读方是 plugins/growth）。 */
export const DIARY_SKIP_REL = path.join('state', 'work-line', 'diary-skip.json')

/** 时间窗只留 2 天：growth 只写当天日记，多留一天够跨零点补写。 */
const KEEP_MS = 2 * 24 * 60 * 60 * 1000
/** 时间窗条数上限：一天几十次办公指令也不会把文件撑大。 */
const MAX_WINDOWS = 200
/** 收到回执那一刻起的窗口余量：覆盖「回执」这条 out 留档（发送有网络抖动）。 */
const ROUTE_WINDOW_MS = 5000

/** 正则转义（命令原文要拼进 RegExp）。 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 认一条「办公指令」：trim 后以 `//` 开头，且 `//` 后面还有内容。
 * @returns {{command:string}|null} null = 不是办公指令（放行，当普通聊天）
 */
export function parseWorkCommand(text) {
  const t = String(text ?? '').trim()
  if (!t.startsWith('//')) return null
  const command = t.slice(2).trim()
  if (!command) return null
  return { command }
}

/** 办公会话的 chatKey（`work:<主人QQ>`）。 */
export function workKeyOf(adminQq) {
  return `${WORK_KEY_PREFIX}${Number(adminQq)}`
}

/**
 * 丢给办公会话的执行提示词。
 * 关键：明确「执行模式」+「最后一条回复只写结论」+「不许发消息/写记忆」。
 * 为什么要说「别用发消息工具」：那条会话有全工具，`mcp__qq__send_message` 也在，
 * 模型顺手一发就把结果以系统口吻糊到主人脸上、绕过她的转述了。
 */
export function buildWorkPrompt(command, { maxChars = 300 } = {}) {
  return [
    '[办公执行] 主人让你办这件事（原文照做，这就是任务本身，不是在跟你聊天）：',
    String(command ?? '').trim(),
    '',
    '要求：',
    '- 现在是执行模式：该查就查、该跑就跑、该改就改，别反问他"要不要"；',
    `- 你的**最后一条回复**只写结论：结果 / 关键数据 / 你做成了什么，尽量 ${maxChars} 字以内；`,
    '- 不要复述他刚才的原话，不要写"好的/收到/我来"，**不要调用 mcp__qq__send_message 或任何发消息工具**'
      + '（结果由系统转达）；',
    '- 这轮不要调用 remember / memory_append 写记忆。',
  ].join('\n')
}

/**
 * 投回她会话的 prompt（她的语气由她自己出，这里只给"结论 + 怎么说"）。
 *
 * 为什么带 `[QQ线:回话须调工具] [QQ会话 …]` 头：内核每轮都会拼这一段（kernel/format.js 的
 * buildPromptText），她靠它知道"要调 mcp__qq__send_message、发到哪个会话"。这条 prompt 是插件
 * 直接投进会话的（不走管线），不带的话：她要是刚被建会话（还没聊过天），就不知道往哪发，
 * 可能只写正文 —— 主人那边一个字都收不到。格式与内核的主动接话轮（messageId=-）一致。
 *
 * 哨兵 `[[办公]]` 必须留在开头：会话里可辨认，日记侧靠它对应的窗口过滤。
 */
export function buildHerPrompt(summary, { chatKey = '' } = {}) {
  const body = String(summary ?? '').trim() || '（具体结论没取到）'
  const head = chatKey ? `[QQ线:回话须调工具] [QQ会话 ${chatKey}｜本条消息ID -] ` : ''
  return `${WORK_SENTINEL} ${head}你刚帮他办的事有结果了：${body}。`
    + '用你的口气简短告诉他，分条发，别提工具/命令/系统/进程这类词。这轮别调 remember。'
}

/** 没办成时投回她会话的 prompt（同样用她的口气说，不要系统腔）。 */
export function buildHerFailPrompt(reason, { chatKey = '' } = {}) {
  const why = clipChars(String(reason ?? '').replace(/\s+/g, ' ').trim() || '不知道为啥', 80)
  const head = chatKey ? `[QQ线:回话须调工具] [QQ会话 ${chatKey}｜本条消息ID -] ` : ''
  return `${WORK_SENTINEL} ${head}他让你办的事没办成（${why}）。`
    + '用你的口气简短告诉他一下，别提工具/命令/系统/进程这类词。这轮别调 remember。'
}

/**
 * 结论清洗：去代码围栏 / 去掉"结果："这类抬头 / 压掉多余空行 / 硬截断。
 * **命令原文一律抹掉**：她"知道办了件事"，但不知道主人的原话。
 */
export function sanitizeSummary(text, { command = '', maxChars = 300 } = {}) {
  let s = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!s) return ''
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  const cmd = String(command ?? '').trim()
  if (cmd) {
    // 长探针先替换（`//完整命令` → 完整命令 → 多行命令的每一行），避免短探针拆坏长串
    const probes = [`//${cmd}`, cmd]
    for (const line of cmd.split('\n')) {
      const one = line.trim()
      if (one.length >= 6) probes.push(one)
    }
    for (const probe of probes.sort((a, b) => b.length - a.length)) {
      if (!probe) continue
      s = s.replace(new RegExp(escapeRe(probe), 'g'), '那件事')
    }
  }
  s = s.replace(/^(结果|结论|答复|汇报|摘要)\s*[:：]\s*/, '')
  s = s.split('\n').map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim()).filter(Boolean).join('\n')
  return clipChars(s, Math.max(20, Number(maxChars) || 300))
}

export default {
  id: 'work-line',
  title: '办公线（// 指令）',
  order: 2,

  configSchema: {
    enabled: {
      type: 'bool',
      default: true,
      group: '办公线',
      label: '启用办公线',
      hint: '开：主人私聊发 //xxx 时，xxx 丢到独立「办公」会话执行，结果由她用自己的口气转达；关：//xxx 当普通聊天。',
    },
    ack: {
      type: 'str',
      default: '收到 我去办',
      group: '办公线',
      label: '收到回执',
      hint: '截下指令后立刻回主人这一句（她的口气，短一点）。留空 = 不回执，主人要等结果才知道收到没有。',
    },
    timeoutSec: {
      type: 'int',
      default: 600,
      min: 60,
      max: 3600,
      step: 30,
      unit: '秒',
      group: '办公线',
      label: '单次办公超时',
      hint: '办公会话超过这么久还没跑完，就按"没拿到结论"收尾并告诉她转达（不无限挂着）。',
    },
    summaryMaxChars: {
      type: 'int',
      default: 300,
      min: 80,
      max: 800,
      step: 20,
      unit: '字',
      group: '办公线',
      label: '结论摘要上限',
      hint: '执行会话的结论截到多少字再交给她转述。太长她一口气说不完，也容易变成念报告。',
    },
    diaryFilter: {
      type: 'bool',
      default: true,
      group: '办公线',
      label: '日记过滤',
      hint: '开：把她转述办公结果那一轮的时间窗写进 state/work-line/diary-skip.json，成长日记取素材时跳过。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = bot.log || { info() {}, warn() {}, debug() {}, error() {} }
    const adminOf = () => Number(bot.core?.adminQq) || 0
    const dataDirOf = () => String(bot.core?.dataDir || '').trim()
    const timeoutMsOf = () => Math.max(60, Math.round(Number(cfg().timeoutSec) || 600)) * 1000
    const summaryMaxOf = () => Math.max(20, Math.round(Number(cfg().summaryMaxChars) || 300))
    const disposers = []

    // ── 日记过滤时间窗（本插件只写；plugins/growth 读）──────────────────
    // 为什么用「时间窗」而不是给消息文本塞标记：她转述的那几条是模型自己说的话，
    // 硬塞 `[[办公]]` 会漏到主人眼前；留档记录（logs/qq_chat/*.jsonl）又只有
    // {dir,ts,text} 三个可判字段 —— 时间窗是唯一不改内核出站/留档代码的办法。
    const skipFileOf = () => {
      const dir = dataDirOf()
      return dir ? path.join(dir, DIARY_SKIP_REL) : ''
    }
    let windows = []
    function loadWindows() {
      const file = skipFileOf()
      if (!file) return []
      try {
        const raw = readJsonFile(file, { log })
        const list = Array.isArray(raw?.windows) ? raw.windows : []
        const now = Date.now()
        return list
          .map((w) => ({ from: Number(w?.from), to: Number(w?.to), kind: String(w?.kind || '') }))
          .filter((w) => Number.isFinite(w.from) && Number.isFinite(w.to) && w.to >= now - KEEP_MS)
          .slice(-MAX_WINDOWS)
      } catch {
        return [] // 首次运行没文件 / 文件坏了：日记照写，过滤失败不能把日记拖死
      }
    }
    function persistWindows() {
      if (cfg().diaryFilter === false) return
      const file = skipFileOf()
      if (!file) return
      const now = Date.now()
      windows = windows.filter((w) => w.to >= now - KEEP_MS).slice(-MAX_WINDOWS)
      try {
        writeJsonFileSync(file, { v: 1, windows })
      } catch (e) {
        log.warn(`[办公] 日记过滤时间窗落盘失败: ${e.message}`)
      }
    }
    /** 记一段「不要进日记」的时间（kind: route=指令+回执 / turnaround=她转述那一轮）。 */
    function recordWindow(from, to, kind) {
      if (cfg().diaryFilter === false) return
      const a = Number(from)
      const b = Number(to)
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return
      windows.push({ from: a, to: b, kind: String(kind || '') })
      persistWindows()
    }
    windows = loadWindows()

    // ── 办公会话：任务队列 + 回合收尾 ────────────────────────────────
    /** sessionId → 待收尾任务数组（DSH 的 prompt 是排队执行的，所以按 FIFO 对 turn/end）。 */
    const workQueues = new Map()
    const watchedWork = new Set()
    const workQueueOf = (sessionId) => {
      const key = String(sessionId || '')
      if (!workQueues.has(key)) workQueues.set(key, [])
      return workQueues.get(key)
    }

    /** 取会话最后一条 assistant 文本；老内核没有这个能力就返回 ''（走"没取到结论"降级）。 */
    async function readText(sessionId) {
      if (!sessionId || typeof bot.dsh?.readLastAssistantText !== 'function') return ''
      try { return String((await bot.dsh.readLastAssistantText(sessionId)) || '').trim() } catch { return '' }
    }

    /** 给办公会话挂一次 turn/end：每结束一轮就收尾队首任务。 */
    function watchWorkSession(sessionId) {
      if (!sessionId || watchedWork.has(sessionId)) return
      if (typeof bot.dsh?.onTurnEnd !== 'function') return // 老内核：只能等超时收尾
      watchedWork.add(sessionId)
      const off = bot.dsh.onTurnEnd(sessionId, () => {
        const task = workQueueOf(sessionId).shift()
        if (!task) return // 这轮不是我们投的任务（比如 GUI 里有人手动说话）：不管
        finishTask(task).catch((e) => log.warn(`[办公] 收尾失败: ${e.message}`))
      })
      if (typeof off === 'function') disposers.push(off)
    }

    /** 办公会话改个名，GUI 侧栏里一眼能认（一个进程只改一次）。 */
    const renamed = new Set()
    function renameOnce(sessionId) {
      if (!sessionId || renamed.has(sessionId) || typeof bot.dsh?.rename !== 'function') return
      renamed.add(sessionId)
      Promise.resolve()
        .then(() => bot.dsh.rename(sessionId, '办公'))
        .catch((e) => log.debug?.(`[办公] 办公会话改名失败（不影响执行）: ${e.message}`))
    }

    // ── 她的转述回合：时间窗从投 prompt 开始，到她那一轮 turn/end 结束 ──
    // 为什么按 turn/start + turn/end 而不是固定 N 秒：固定窗口要么提前关（模型慢）漏掉转述，
    // 要么开太久把主人这期间正常聊天的回复也滤掉。
    const herWindows = []
    const watchedHer = new Set()
    function openHerTurnWindow() {
      const w = { at: Date.now(), startedAt: 0, timer: null }
      herWindows.push(w)
      // 兜底：她一直没出这一轮（或队列被合并成一回合）时别让窗口无限开着滤掉正常聊天。
      // 上限 3 分钟：转述轮通常几秒；真拖过 3 分钟，宁可在日记里多一条她的回复，也别把一小时聊天全滤掉。
      w.timer = setTimeout(() => closeHerWindow(w), Math.min(180000, Math.max(60000, timeoutMsOf())))
      w.timer.unref?.()
      return w
    }
    function closeHerWindow(w) {
      const i = herWindows.indexOf(w)
      if (i >= 0) herWindows.splice(i, 1)
      if (w?.timer) { clearTimeout(w.timer); w.timer = null }
      if (!w) return
      recordWindow(w.at, Date.now(), 'turnaround')
    }
    function watchHerSession(sessionId) {
      if (!sessionId || watchedHer.has(sessionId)) return
      watchedHer.add(sessionId)
      const canStart = typeof bot.dsh?.onTurnStart === 'function'
      if (canStart) {
        const offStart = bot.dsh.onTurnStart(sessionId, () => {
          const w = herWindows[0]
          if (w && !w.startedAt) w.startedAt = Date.now()
        })
        if (typeof offStart === 'function') disposers.push(offStart)
      }
      if (typeof bot.dsh?.onTurnEnd === 'function') {
        const offEnd = bot.dsh.onTurnEnd(sessionId, () => {
          const w = herWindows[0]
          if (!w) return
          // 没有 turn/start 能力时只能按第一个 turn/end 关；有的话要等"注入之后才开始的那轮"，
          // 否则会把注入前就在跑的那一轮的尾巴当成她的转述轮，窗口提前关掉。
          if (canStart && !w.startedAt) return
          closeHerWindow(w)
        })
        if (typeof offEnd === 'function') disposers.push(offEnd)
      }
    }

    /** 把结论（或失败原因）投回她自己的会话，让她用她的口气出站。 */
    async function tellHer(task, summary, { failed = false, reason = '' } = {}) {
      const admin = Number(task?.admin) || adminOf()
      if (!(admin > 0) || typeof bot.dsh?.ensureSession !== 'function') return
      const herKey = `private:${admin}`
      try {
        const herSid = await bot.dsh.ensureSession(herKey)
        if (!herSid) throw new Error('拿不到她的会话')
        watchHerSession(herSid)
        const text = failed
          ? buildHerFailPrompt(reason, { chatKey: herKey })
          : buildHerPrompt(summary, { chatKey: herKey })
        const win = openHerTurnWindow()
        try {
          await bot.dsh.prompt(herSid, text)
        } catch (e) {
          closeHerWindow(win) // 没投出去 = 不会有转述轮，窗口别留着
          throw e
        }
        const chars = String(summary || '').length
        log.info(`[办公] 结论已投回她的会话（${herKey} / ${herSid}，摘要 ${chars} 字${failed ? '，失败' : ''}）`)
      } catch (e) {
        log.warn(`[办公] 投回她的会话失败: ${e.message}`)
      }
    }

    /** 收尾：读结论 → 清洗 → 投回她的会话。只跑一次（超时与 turn/end 可能撞车）。 */
    async function finishTask(task, { timedOut = false } = {}) {
      if (!task || task.done) return
      task.done = true
      if (task.timer) { clearTimeout(task.timer); task.timer = null }
      let summary = ''
      try {
        const text = await readText(task.sessionId)
        // 和"执行前的最后一条"一样 = 这一轮模型没留下文本（只调了工具）：
        // 不能把上一单的结论当这一单的（张冠李戴比"没取到"更糟）。
        if (text && text !== task.baseline) {
          summary = sanitizeSummary(text, { command: task.command, maxChars: summaryMaxOf() })
        }
      } catch (e) {
        log.warn(`[办公] 读执行结论失败: ${e.message}`)
      }
      if (!summary) log.warn(`[办公] 办公会话${timedOut ? '超时' : '没有产出文本结论'}（会话 ${task.sessionId}）`)
      await tellHer(task, summary)
    }

    /** 后台跑一单：建（拿）办公会话 → 记基线 → 投执行提示词。 */
    async function runOfficeTask(task) {
      let sid = ''
      let queued = null
      try {
        sid = await bot.dsh.ensureSession(workKeyOf(task.admin))
        if (!sid) throw new Error('拿不到办公会话')
        task.sessionId = sid
        watchWorkSession(sid)
        renameOnce(sid)
        task.baseline = await readText(sid)
        queued = task
        workQueueOf(sid).push(task)
        task.timer = setTimeout(() => {
          const q = workQueueOf(sid)
          const i = q.indexOf(task)
          if (i >= 0) q.splice(i, 1)
          finishTask(task, { timedOut: true }).catch((e) => log.warn(`[办公] 超时收尾失败: ${e.message}`))
        }, timeoutMsOf())
        task.timer.unref?.()
        await bot.dsh.prompt(sid, buildWorkPrompt(task.command, { maxChars: summaryMaxOf() }))
        log.info(`[办公] 已把指令交给办公会话（${workKeyOf(task.admin)} / ${sid}，指令 ${String(task.command).length} 字）`)
      } catch (e) {
        // 没投出去：把排队项和时间清掉，别让下一个 turn/end 认错任务
        if (queued) {
          const q = workQueueOf(sid)
          const i = q.indexOf(queued)
          if (i >= 0) q.splice(i, 1)
        }
        if (task.timer) { clearTimeout(task.timer); task.timer = null }
        log.warn(`[办公] 办公会话执行失败: ${e.message}`)
        await tellHer(task, '', { failed: true, reason: e.message })
      }
    }

    // ── intercept（order 1：必须早于内核的斜杠命令分发 order 5）──────────
    bot.on('intercept', async (ev) => {
      if (cfg().enabled === false || !ev || ev.stopped) return
      if (ev.isGroup) return // 群里发 // 一律当普通聊天（群里谁都不能碰电脑）
      const admin = adminOf()
      if (!(admin > 0) || !isMasterPrivate(ev.chatKey, admin)) return // 只认主人私聊
      const parsed = parseWorkCommand(ev.text)
      if (!parsed) return

      // 到这里为止这条消息就「不属于聊天」了：不进她的会话、不进模型。
      ev.stopped = true
      ev.stopReason = 'work-line:routed'
      const startedAt = Number(ev.time) > 0 ? Number(ev.time) : Date.now()
      const ack = String(cfg().ack ?? '').trim()
      if (ack) {
        try { await bot.deliver(ev.chatKey, ack) } catch (e) { log.warn(`[办公] 回执发送失败: ${e.message}`) }
      }
      // 指令那条 in 留档在 passive-tap 已经写过了（早于 intercept），拦不住 ——
      // 记一个短窗口让日记跳过「指令 + 回执」这两条；指令本身还有 growth 的 `//` 规则兜底。
      recordWindow(startedAt, Date.now() + ROUTE_WINDOW_MS, 'route')

      const task = { admin, command: parsed.command, sessionId: '', baseline: '', timer: null, done: false, at: Date.now() }
      log.info(`[办公] 截到指令 → 办公会话：${clipChars(String(parsed.command).replace(/\s+/g, ' '), 40)}`)
      // 不能 await：办公任务可能要跑几分钟，管线（含这一条消息的收尾）不能被它堵住
      runOfficeTask(task).catch((e) => log.warn(`[办公] 任务异常: ${e.message}`))
    }, { order: 1 })

    bot.onDispose?.(() => {
      for (const w of [...herWindows]) closeHerWindow(w)
      for (const off of disposers.splice(0)) {
        try { off() } catch { /* 卸载期出错不影响内核 */ }
      }
    })

    log.info('[办公] 已挂载：主人私聊 //xxx → 独立办公会话执行，结果由她转述')
  },
}

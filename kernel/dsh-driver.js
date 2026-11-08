/**
 * kernel/dsh-driver.js — QQ 会话驱动：「一条 QQ 线 ↔ 一条 DSH 会话」收成一套接口。
 *
 * ⚠️ **核心决策（动本文件前先读）**：只保留 **in-process**，必须走
 * `ctx.sessionController.create()` / `ctx.sessionController.prompt()`，
 * **绝对不要裸调 `agent.followup()`**（或 `agent.steer()`）。
 * 因为 sessionController.prompt 内部在 followup 之前还做了四件 QQ 线一刻都缺不得的事，裸调会全部绕过：
 *   ① 图片附件入库：把 base64 转成内容寻址的持久化附件。
 *      绕过它 = 会话历史里只有裸 base64/没有附件引用，GUI 缩略图、图片压缩、冷启动重放全拿不到图。
 *   ② 模型模态检查：当前模型 inputModalities 不含 image 时抛 MODEL_DOES_NOT_SUPPORT_IMAGES。
 *      绕过它 = 图片被塞给不支持的模型，整轮 400，用户看到"机器人哑了"。
 *   ③ 冷会话恢复 + preset 恢复：`resolveAgent()` 会 resume 冷/归档会话，并保证配置的 agentPreset
 *      仍然生效（工具裁剪 + 压缩阈值）。绕过它 = 恢复出来的会话可能带着默认 preset，
 *      QQ 线瞬间长回 bash/文件工具，等于把工具作用域门整个作废。
 *   ④ GUI 侧栏工作区挂载：`create()` 给 workspaceId 时会 `workspace.attachSession()`。
 *      绕过它 = 在 GUI 侧栏里看不到 QQ 线的会话，排障只能翻文件。
 * 一句话：followup() 只是「往 agent 收件箱塞一条消息」这个最底层动作，它上面的准入、
 * 归属、恢复一律没有。所以本文件里**没有任何** `agent.*()` 直调，全部经服务层。
 *
 * 本文件的边界：只负责「会话生命周期 + 提交 prompt + 提问拦截 + 群上文增量注入
 * + 会话级静态前缀」，出站一律走内核 deliver()，这里没有裸发；人设/标题取名/工具实现都不在这里。
 *
 * **会话级静态前缀（L1 常驻层）**：`registerPrefixProvider()` 收「稳定文本」提供者（如 memory 的
 * L2 事实块），驱动在 `agent/pre-step` waterfall 里把拼好的前缀作为**持久 user 消息**注入到
 * 会话历史最前（第一次）或追加一条「前缀更新」（内容变了才发）。为什么走这条路、为什么不能
 * 每轮塞 hint，见下方 `injectPrefixIntoDecision()` 的注释（含内核代码位置）。
 *
 * 平台边界：会话映射/标题状态的落盘走 `platform/atomic.js`（剥 BOM + 原子写），
 * 工作区路径比较走 `platform/paths.js` 的 `normForCompare()`（Windows 忽略大小写）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { extractText, clipChars, toWellFormedText, sanitizePromptUserText } from './format.js'
import { readJsonFile, writeJsonFileSync } from '../platform/atomic.js'
import { normForCompare } from '../platform/paths.js'

/** 群上文最多往回看 30 分钟 —— 更老的对话塞进 prompt 只会干扰当前话题。 */
const GROUP_CONTEXT_MAX_AGE_MS = 30 * 60 * 1000

/** 会话标题同步的节流窗口：触发点是"每条要处理的消息"，群里刷屏时不该反复查群名/改标题。 */
const TITLE_SYNC_THROTTLE_MS = 60 * 1000

/** QQ 端没有可点的选择题界面，收到提问一律用这句代答，让 agent 转成纯文本继续问。 */
const QUESTION_CUSTOM_REPLY = '请在 QQ 里直接用文字列出可选内容'

/**
 * 会话级静态前缀在会话历史里的身份标记（`user/message` 的 `source.kind`）。
 * 为什么不自己另存一份「注入过没有」的文件：会话历史是唯一真源 —— 冷启动重放、
 * 压缩、fork 之后都只有这个标记能说清"前缀还在不在、在哪个版本"。
 * DSH 的 message source 是 merge-extensible 的自定义 kind（`dsh-llm/types/message.d.ts`
 * 写明「每个生产者声明自己的 kind，消费者对未知 kind 直接放行」），`dsh-session` 只校验
 * `source.kind` 是非空字符串，所以 QQ 插件可以合法地加自己的 kind。
 */
const PREFIX_SOURCE_KIND = 'qq-session-prefix'

/**
 * 静态前缀总预算（设计文档 L1 层 1600 字）。
 * 各 provider 自己还要再守自己的预算（memory 的 L2 预算是 800）；这里是最后一道硬闸，
 * 防止某个 provider 把整段历史撑爆。
 */
const PREFIX_MAX_CHARS = 1600

/**
 * 建一个会话驱动。
 * @param {object} opts
 * @param {object} opts.ctx            内核插件的 cordis 上下文（必需）
 * @param {object} opts.log            `{ info, warn, error, debug }`
 * @param {string} opts.sessionsFile   chatKey→sessionId 映射的落盘文件（绝对路径，由宿主按 dataDir 解析）
 * @param {string} opts.workspacePath  QQ 线会话所属工作区目录（建会话时优先挂这个工作区）
 * @param {string} [opts.workspaceId]  已注册的 QQ 工作区 id（由宿主自举后传入；传了就优先用它挂会话）
 * @param {string} opts.agentPreset    全局会话 preset（private 线的兜底；空 = 用 DSH 默认）
 * @param {string} [opts.groupAgentPreset]   群聊线 preset（空 = 沿用全局；宿主默认 qq-chat）
 * @param {string} [opts.privateAgentPreset] 私聊线 preset（空 = 沿用全局）
 * @param {string} [opts.workAgentPreset]   办公线（work:）preset（**空 = DSH 默认全工具**；
 *   不沿用全局/私聊，因为办公线要跑 pwsh/读写，跟聊天线是两回事）
 * @param {object} opts.state          ChatState（群上文水位用）
 * @param {object} [opts.napcat]       NapCat 适配器（群上文用；不传则从内核服务上取）
 */
export function createDshDriver(opts) {
  const { ctx, log } = opts
  // 可热更新的运行配置（控制台改 sessionsFile / workspacePath / agentPreset 后无需重启进程）
  const settings = {
    sessionsFile: String(opts.sessionsFile || ''),
    workspacePath: String(opts.workspacePath || ''),
    workspaceId: String(opts.workspaceId || ''),
    agentPreset: String(opts.agentPreset || ''),
    // 群聊 / 私聊 / 办公分开配：空 = 沿用全局（向后兼容；宿主会给群聊线填 qq-chat）
    groupAgentPreset: typeof opts.groupAgentPreset === 'string' ? opts.groupAgentPreset : '',
    privateAgentPreset: typeof opts.privateAgentPreset === 'string' ? opts.privateAgentPreset : '',
    // 办公线（work:）**默认空 = DSH 默认全工具**：它要跑 pwsh/读写，不能跟着私聊线被裁成纯聊天
    workAgentPreset: typeof opts.workAgentPreset === 'string' ? opts.workAgentPreset : '',
  }

  /**
   * 一条 QQ 线该跑哪个 preset。**这是"群聊不能碰电脑"的第一道门**：
   *   · group:* → groupAgentPreset（宿主默认 qq-chat：裁掉 shell/文件/任务/技能类工具）
   *   · private:* → privateAgentPreset，没配就沿用全局（保持全工具）
   *   · work:* → 办公线（主人私聊 `//xxx` 跑在独立会话里，见 plugins/work-line）：
   *     **必须全工具**，所以默认空 = DSH 默认（不沿用私聊/全局）。
   *     2026-11-01 真机事故：早先写成"跟主人私聊同一套 preset"，结果把私聊线设成
   *     qq-chat（让她只聊天）之后，办公线跟着被裁成纯聊天 → 办公会话没有 pwsh，
   *     `//c盘还有多少空间` 直接查不出来。要裁剪它只能显式配 `dsh.workAgentPreset`。
   *   · 其他 → 全局
   * 空串 = 明确"沿用全局"，不是"没有"；各分支都不会把空串当 preset 传给内核。
   */
  function presetFor(chatKey) {
    const key = String(chatKey || '')
    if (key.startsWith('group:')) return settings.groupAgentPreset || settings.agentPreset
    if (key.startsWith('private:')) return settings.privateAgentPreset || settings.agentPreset
    if (key.startsWith('work:')) return settings.workAgentPreset || ''   // 办公线：默认全工具，不吃 private 的设置
    return settings.agentPreset
  }

  /** 后台任务会话用的 preset：优先群聊线的裁剪版（只回文本，不需要电脑工具）。 */
  function isolatedPreset() {
    return settings.groupAgentPreset || settings.agentPreset
  }

  const sessions = new Map()      // chatKey -> sessionId
  const creating = new Map()      // chatKey -> Promise<sessionId>（同一条线并发时只建一个会话）
  const turnEndFns = new Map()    // sessionId -> Set<fn>
  const turnStartFns = new Map()  // sessionId -> Set<fn>
  const unsubs = []               // ctx.on(...) 的 disposer

  // ── 会话级静态前缀的状态 ──────────────────────────────────────
  // providers：谁有"稳定文本"要常驻（memory 的 L2 事实块），id → { id, order, provide }
  const prefixProviders = new Map()
  // sessionId → { present, parts: {providerId: version}, seqs: [注入消息的 seq] }
  // 只缓存"会话历史里实际有什么"；压缩/替换把消息挤掉时靠 session/event 的 sourceEventSeqs 作废。
  const prefixStates = new Map()

  // 会话标题同步的状态（每次 sync 都读写这个小文件，不塞进会话映射里 —— 两者生命周期不同）
  let autoTitlesFile = path.join(path.dirname(settings.sessionsFile), 'session-titles.json')
  let autoTitles = loadAutoTitles()   // chatKey -> { sessionId, title }: 上次**我们**自动设的标题
  let lastTitleSyncAt = 0             // 60s 节流（触发点是每条要处理的消息）

  loadSessions()

  // ── 会话映射落盘（格式沿用旧版 sessions.json：{ chatKey: sessionId }）──
  function loadSessions() {
    try {
      const data = readJsonFile(settings.sessionsFile)
      for (const [chatKey, sessionId] of Object.entries(data || {})) {
        if (typeof sessionId === 'string') sessions.set(chatKey, sessionId)
      }
      log.info(`已加载会话映射 ${sessions.size} 条 (${settings.sessionsFile})`)
    } catch (e) {
      // 首次运行没有文件属于正常路径；真正的坏文件要留下痕迹，不然映射丢了都不知道为什么
      if (e?.code !== 'ENOENT') log.warn(`会话映射读取失败（按首次运行处理）: ${e.message}`)
    }
  }

  function saveSessions() {
    try {
      writeJsonFileSync(settings.sessionsFile, Object.fromEntries(sessions))
    } catch (e) {
      log.warn(`保存会话映射失败: ${e.message}`)
    }
  }

  /** 反向映射：防抢答网页的题（远端事件里的 agentId 就是 sessionId）。 */
  function findChatKeyBySession(sessionId) {
    for (const [chatKey, sid] of sessions) if (sid === sessionId) return chatKey
    return null
  }

  /**
   * 删掉一条线的映射（`/reset` 用），返回旧 sessionId 供调用方归档；下次消息自动建新会话。
   * 归档不在这里做：归档可能因会话正忙而失败，调用方要自己决定失败后怎么处理。
   */
  function forgetSession(chatKey) {
    const sessionId = sessions.get(chatKey)
    if (!sessionId) return null
    sessions.delete(chatKey)
    prefixStates.delete(sessionId)   // 旧会话不再驱动，前缀缓存跟着扔（/reset 后是新会话）
    saveSessions()
    return sessionId
  }

  // ── 会话级静态前缀（L1 常驻层） ──────────────────────────────
  /**
   * 注册一个「稳定文本」提供者。子插件（memory）在 setup 里调 `bot.dsh.registerPrefixProvider(...)`。
   *
   * 契约（v1 故意收窄，别贪）：
   *   · `provide(chatKey)` 同步返回 `null` 或 `{ text, version }`；
   *   · `text` 必须是**稳定**内容（同样的记忆状态 → 同样的字符串），别掺时间/随机数；
   *   · `version` 是内容指纹（变了才刷新）。不给就按 text 的 sha1 现算。
   * 返回 disposer（插件卸载时摘掉，HMR 重载不会叠两个 provider）。
   * @param {{id:string, order?:number, provide:(chatKey:string)=>null|{text:string,version?:string}|string}} def
   */
  function registerPrefixProvider(def) {
    const id = String(def?.id || '').trim()
    if (!id) throw new Error('registerPrefixProvider 需要 id')
    if (typeof def?.provide !== 'function') throw new Error(`前缀提供者「${id}」需要 provide(chatKey)`)
    prefixProviders.set(id, { id, order: Number(def.order) || 100, provide: def.provide })
    log.info(`[前缀] 注册提供者 ${id}（order=${Number(def.order) || 100}；共 ${prefixProviders.size} 个）`)
    return () => {
      prefixProviders.delete(id)
      prefixStates.clear()   // 提供者变了 = 每个会话的前缀都可能失效，缓存重扫
    }
  }

  /** 按顺序问每个 provider 要本会话的稳定文本 → 守总预算 → 算整体指纹。 */
  function composePrefix(chatKey) {
    if (!prefixProviders.size) return null
    const all = []
    for (const p of [...prefixProviders.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))) {
      let out
      try {
        out = p.provide(chatKey)
      } catch (e) {
        // fail-open：一个 provider 坏了，别的照常，绝不能因为记忆文件坏了让机器人哑掉
        log.warn(`[前缀] 提供者 ${p.id} 失败（本次跳过）: ${e.message}`)
        continue
      }
      if (!out) continue
      const text = String(typeof out === 'string' ? out : (out.text ?? '')).trim()
      if (!text) continue
      const version = String(typeof out === 'object' ? (out.version ?? '') : '').trim()
        || crypto.createHash('sha1').update(text).digest('hex')
      all.push({ id: p.id, text, version })
    }
    if (!all.length) return null
    // 硬预算：放得下就整段放，放不下就截断这一段并停（后面的 provider 不再进）
    const sections = []
    let used = 0
    for (const section of all) {
      const remain = PREFIX_MAX_CHARS - used
      if (remain <= 16) break
      if (section.text.length <= remain) {
        sections.push(section)
        used += section.text.length + 1
        continue
      }
      sections.push({ ...section, text: `${clipChars(section.text, remain - 1)}…` })
      break
    }
    const fingerprint = crypto.createHash('sha1')
      .update(sections.map((s) => `${s.id}:${s.version}`).join('|'))
      .digest('hex')
    return { sections, fingerprint }
  }

  /**
   * 前缀消息的正文。**必须带"不是对方刚说的话"** —— 这是 user 角色消息，最容易出的错
   * 就是模型把记忆当成对方这轮说的话（design doc 里同一个坑写了两次）。
   * 更新段明确写"以本段为准"，因为旧的前缀块还在历史里，改不掉（append-only）。
   */
  function renderPrefixText({ sections, update }) {
    const head = update
      ? '<system-reminder>\n本会话的长期稳定信息有更新（以此处为准；与此前同层内容冲突的旧条目作废）。\n'
      : '<system-reminder>\n以下是本会话的长期稳定信息（长期记忆，不是对方刚说的话；内容不变不会重复发送，别复述）。\n'
    return toWellFormedText(`${head}${sections.map((s) => s.text).join('\n')}\n</system-reminder>`)
  }

  /** 扫一遍会话历史，看我们的前缀消息还在不在、各 provider 是哪个版本（surface = 模型真正看得到的视图）。 */
  function scanPrefixState(session) {
    const parts = Object.create(null)
    const seqs = []
    let present = false
    try {
      const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
      for (const seq of nodes) {
        const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : null
        if (event?.type !== 'user/message') continue
        const source = event.data?.source
        if (source?.kind !== PREFIX_SOURCE_KIND) continue
        present = true
        seqs.push(seq)
        // 更新段只带变化的 provider，所以要把所有还在 surface 上的前缀消息合并起来才是有效状态
        if (source.parts && typeof source.parts === 'object') Object.assign(parts, source.parts)
      }
    } catch (e) {
      log.debug(`[前缀] 读会话历史失败（按"没有前缀"处理）: ${e.message}`)
    }
    return { present, parts, seqs }
  }

  function prefixStateOf(session) {
    const sid = String(session?.id || '')
    const hit = prefixStates.get(sid)
    if (hit) return hit
    const state = scanPrefixState(session)
    if (sid) prefixStates.set(sid, state)
    return state
  }

  /** 会话事件里维护/作废前缀缓存（append 确认、压缩替换作废）。 */
  function notePrefixSessionEvent(sessionId, event) {
    const sid = String(sessionId || '')
    if (!sid) return
    if (event?.type === 'user/message' && event.data?.source?.kind === PREFIX_SOURCE_KIND) {
      const prev = prefixStates.get(sid) || { present: false, parts: Object.create(null), seqs: [] }
      const parts = { ...prev.parts }
      if (event.data.source.parts && typeof event.data.source.parts === 'object') {
        Object.assign(parts, event.data.source.parts)
      }
      prefixStates.set(sid, { present: true, parts, seqs: [...(prev.seqs || []), Number(event.seq)] })
      return
    }
    // 压缩/替换：sourceEventSeqs 里出现我们注入消息的 seq = 它已被挤出 surface，缓存作废重扫
    const seqs = prefixStates.get(sid)?.seqs
    if (!Array.isArray(event?.sourceEventSeqs) || !seqs?.length) return
    if (event.sourceEventSeqs.some((seq) => seqs.includes(seq))) {
      prefixStates.delete(sid)
      log.debug(`[前缀] 会话 ${sid} 的前缀消息被压缩/替换，缓存作废（下次回复前重扫）`)
    }
  }

  /**
   * 把前缀塞进本轮 pre-step 的消息列表。
   *
   * 为什么是 `agent/pre-step`（而不是 prompt 里拼、也不是每轮 hint）：
   *   · `sessionController.prompt()` 只能入队一条 user 消息，**没有**"改系统提示/静态上下文"的参数
   *     （`dsh-api-session-controller` 的 `SessionCreateRequest` 只有 workspaceId/cwd/sessionId/agentPreset）；
   *   · 每轮 hint 拼在 prompt 末尾，每一轮都是**新 token**（历史前缀永远命中不了它，因为新消息在末尾），
   *     这正是现状费钱的原因；
   *   · `agent/pre-step` 是内核公开的 waterfall（`dsh-agent` 的 `runtime-types.d.ts` 有事件签名与
   *     "replace the messages that enter it" 的说明），DSH 自带的 `dsh-agent-instructions` 就是用它把
   *     AGENTS.md 注入成**持久 user 消息**的（它自己叫 baseline）。我们走同一条路：首步把前缀放在
   *     用户消息**之前** → 进入会话历史最前 → 之后每轮都吃缓存，不再重复付费。
   * 改不了已写入的旧消息（历史 append-only）：所以"刷新"是追加一条只带变化段的更新消息。
   */
  function injectPrefixIntoDecision(payload, decision) {
    if (!prefixProviders.size) return decision
    if (decision?.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    // 只跟着"这一步有用户消息"注入：工具循环的中间步别插嘴；内容变了就等下一次用户消息前刷新
    if (!messages.length) return decision
    const session = payload?.agent?.session
    const sessionId = String(session?.id || '')
    if (!sessionId) return decision
    const chatKey = findChatKeyBySession(sessionId)
    if (!chatKey) return decision   // 后台任务会话 / 网页会话：不碰
    const desired = composePrefix(chatKey)
    if (!desired?.sections?.length) return decision
    const current = prefixStateOf(session)
    const changed = desired.sections.filter((s) => current.parts[s.id] !== s.version)
    if (!changed.length) return decision
    const update = current.present
    const parts = { ...current.parts }
    for (const s of changed) parts[s.id] = s.version
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: renderPrefixText({ sections: changed, update }) }],
      source: {
        kind: PREFIX_SOURCE_KIND,
        parts,                                  // 有效版本表：重启/压缩后靠它算"缺哪段"
        fingerprint: desired.fingerprint,
        at: Date.now(),
      },
    }
    const chars = [...message.content[0].text].length
    log.info(`[前缀] ${chatKey} ${update ? '刷新' : '注入'}会话静态前缀 ${chars} 字`
      + `（${changed.map((s) => `${s.id}@${s.version.slice(0, 8)}`).join(',')}）`)
    // 不知道旧版本 = 历史里没有（或已被压缩挤出）→ 整段放最前；否则更新段也放最前，让用户消息仍在最后
    return { ...decision, messages: [message, ...messages] }
  }

  // ── 本轮开始 / 结束回调 ──────────────────────────────────────
  function fireTurnEnd(sessionId, event) {
    for (const fn of turnEndFns.get(sessionId) ?? []) {
      try { fn(event) } catch (e) { log.warn(`turn/end 回调异常 (${sessionId}): ${e.message}`) }
    }
  }

  function fireTurnStart(sessionId, event) {
    for (const fn of turnStartFns.get(sessionId) ?? []) {
      try { fn(event) } catch (e) { log.warn(`turn/start 回调异常 (${sessionId}): ${e.message}`) }
    }
  }

  /**
   * 订阅某会话的「一轮开始」。返回取消函数。
   * 为什么需要它：`sessionController.prompt()` 只做**入队 admission**，模型真正开始跑
   * 是之后才发生的；引用锚必须等 turn/start 才能绑定到正确的模型回合（而不是"最后一个提交的回合"）。
   */
  function onTurnStart(sessionId, fn) {
    let set = turnStartFns.get(sessionId)
    if (!set) turnStartFns.set(sessionId, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }

  /**
   * 订阅某会话的「一轮结束」。返回取消函数。
   * 只认 `turn/end`：DSH 保证每轮（含出错/被取消、以及一步都没走就结束）都留一条配平的
   * turn/end，比盯 agent/status 更准 —— status 是运行时态，冷会话恢复、排队等场景都不发。
   */
  function onTurnEnd(sessionId, fn) {
    let set = turnEndFns.get(sessionId)
    if (!set) turnEndFns.set(sessionId, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }

  // ── 会话创建 ────────────────────────────────────────────────
  /**
   * 会话若被**归档**就先解档：DSH 的 archived-session 门禁在每一步前拒掉 pre-step，
   * turn 直接 `blocked` 结束（模型一步都不跑）—— QQ 线上表现为"消息收到了、机器人一声不响"。
   * 幂等（未归档时接口不写盘）；失败只记 debug、绝不挡回话。
   */
  async function ensureUnarchived(sessionId) {
    try {
      const reg = ctx.get('workspaceRegistry')
      if (reg?.archivedSessionIds?.includes(sessionId)) await reg.unarchiveSession(sessionId)
    } catch (e) {
      log.debug(`解除会话归档失败 (${sessionId}): ${e.message}`)
    }
  }

  /**
   * 获取（或懒创建）一条 QQ 线对应的会话。
   * nameHint 只用于日志：会话标题要用**群名 / 好友昵称**（得打 NapCat 取），取名不归驱动层；
   * 需要改标题的调用方直接用下面的 rename()。
   */
  async function ensureSession(chatKey, nameHint = '') {
    const existing = sessions.get(chatKey)
    if (existing) {
      await ensureUnarchived(existing)   // 被归档的会话 = 每步都被门禁挡死，先解档再说
      return existing
    }
    const inflight = creating.get(chatKey)
    if (inflight) return inflight      // 同一条线两条消息同秒进来时，别建出两条会话
    const task = (async () => {
      const created = await ipCreateSession(chatKey)
      sessions.set(chatKey, created.sessionId)
      saveSessions()
      log.info(`为 ${chatKey} 创建 DSH 会话: ${created.sessionId}（${nameHint || '无名'}）preset=${created.agentPreset || '默认'}`)
      // 新建会话后**异步**补一次标题（取群名要打 NapCat，别拖慢第一条消息）。
      // force 跳过节流：不然刚建的会话要等下一轮消息（最多再等 60s）才在侧栏显示成「群名 (群号)」。
      syncSessionTitles({ force: true }).catch(() => {})
      return created.sessionId
    })().finally(() => creating.delete(chatKey))
    creating.set(chatKey, task)
    return task
  }

  /** preset 不存在/损坏（profile 把内置 preset 关了、或装的是旧 bundle）—— 不能因此让整条线哑掉。 */
  function isPresetFailure(e) {
    const text = [e?.code, e?.name, e?.message, e?.details?.code, e?.details?.reason].filter(Boolean).join(' ')
    return /agent-preset\/(not-found|invalid)|unknown agent preset|preset.*not.?found/i.test(text)
  }

  /** 建会话：优先挂进已注册的 QQ 工作区（GUI 侧栏分组）；未注册则退回 cwd 建并留一条 warn。 */
  async function ipCreateSession(chatKey) {
    const registry = ctx.get('workspaceRegistry')
    let workspaceId = String(settings.workspaceId || '')
    // 工作区被删/改名后 registry 里就没有这个 id 了。继续拿旧 id 建会话，DSH 会直接抛
    // （新建会话全部失败）；所以每次建会话前校验一次，失效就清空并按路径重新解析。
    // 没有 list()（老宿主/测试桩）时无法校验，保持原样不动。
    if (workspaceId && typeof registry?.list === 'function') {
      let alive = true
      try {
        alive = registry.list().some((w) => String(w?.id) === workspaceId)
      } catch (e) {
        log.debug(`工作区列表查询失败（按原 workspaceId 继续）: ${e.message}`)
      }
      if (!alive) {
        log.warn(`QQ 工作区 id 已失效（${workspaceId}）：清空并按路径重新解析`)
        settings.workspaceId = ''
        workspaceId = ''
      }
    }
    if (!workspaceId && settings.workspacePath) {
      const wanted = normForCompare(path.resolve(settings.workspacePath))
      // 路径比较跨平台：Windows 文件系统不区分大小写，JS 字符串区分 → 统一走 normForCompare
      const workspace = registry?.list?.().find((w) => normForCompare(path.resolve(w.path)) === wanted)
      if (workspace) workspaceId = String(workspace.id)
      else log.warn(`QQ 工作区未注册（${settings.workspacePath}）：会话将以 cwd 创建，GUI 侧栏不会分组`)
    }
    // 按线取 preset：群聊线拿裁剪版（没有 shell/文件工具），私聊线保持全局。
    const agentPreset = presetFor(chatKey)
    const create = (preset) => ctx.sessionController.create({
      ...(workspaceId ? { workspaceId } : { cwd: settings.workspacePath }),
      ...(preset ? { agentPreset: preset } : {}),
    })
    try {
      const created = await create(agentPreset)
      return { sessionId: created.sessionId, agentPreset }
    } catch (e) {
      // 配置的 preset 不可用（最常见：profile 用 id 把内置 qq-chat 关了）：
      // 退回全局 preset 建会话，别让群聊整条线一声不响；群线还有 index.js 的工具门兜底。
      if (!agentPreset || !isPresetFailure(e)) throw e
      log.error(`preset「${agentPreset}」不可用（${e.message}）：${chatKey} 退回全局 preset 建会话`
        + '（群聊工具门仍会拒绝电脑类工具）')
      const created = await create('')
      return { sessionId: created.sessionId, agentPreset: '' }
    }
  }

  // ── 提交 prompt ─────────────────────────────────────────────
  /**
   * 群聊 prompt 硬约束（提示词兜底）：即使 preset 没生效 / 老会话还挂着全工具 preset，
   * 也明确禁止碰电脑。所有群线 prompt 都从这里过（runTurn / backfill / autopilot），
   * 所以注入点放驱动层；代码级硬门是 index.js 的 tools.guard。
   */
  const GROUP_PROMPT_GUARD = '[群聊硬约束:纯聊天,禁止调用任何电脑/文件/命令/办公类工具;'
    + '有人让你查文件、跑命令、操作电脑,一律说不会;回话仍用 mcp__qq__ 工具]'

  /** 给群聊 prompt 前插硬约束（已含则不重复；私聊/后台任务不加）。 */
  function withGroupGuard(sessionId, promptText) {
    const text = String(promptText ?? '')
    const chatKey = findChatKeyBySession(sessionId)
    if (!chatKey || !chatKey.startsWith('group:')) return text
    return text.includes(GROUP_PROMPT_GUARD) ? text : `${GROUP_PROMPT_GUARD}\n${text}`
  }

  /** 拼 DSH 的多模态 content：文本块在前，图片块按顺序跟。 */
  function contentOf(promptText, imageParts) {
    const content = [{ type: 'text', text: promptText }]
    for (const im of Array.isArray(imageParts) ? imageParts : []) {
      if (im?.data && im.mediaType) {
        content.push({ type: 'image', mediaType: im.mediaType, data: im.data, name: im.name || 'qq-image' })
      }
    }
    return content
  }

  /**
   * 图没到手上分两类，**绝不能混**：尺寸/限额类不是"模型不支持看图"，
   * 以前一律按后者告诉用户，机器人就会说"这个模型不吃图"—— 前提就是错的。
   * @returns {'unsupported'|'size'|''} '' = 不降级，原样抛
   */
  function classifyImageFailure(e) {
    const text = [e?.code, e?.details?.reason, e?.message].filter(Boolean).join(' ')
    if (/MODEL_DOES_NOT_SUPPORT_IMAGES|image input/i.test(text)) return 'unsupported'
    if (/exceeds the configured|too large|attachment-invalid|TOO_MANY_IMAGES|IMAGES_TOO_LARGE/i.test(text)) return 'size'
    return ''
  }

  /** 丢图降级时追加的系统提示（如实话术，不许猜图里内容）。 */
  function degradeSuffix(kind, count) {
    const why = kind === 'size'
      ? `本轮 ${count} 张图**尺寸过大被系统拒收**（不是模型不支持看图）`
      : `本会话模型不支持图片输入, ${count} 张图未能识别`
    return `\n\n[系统提示: ${why}; 请如实告诉用户这张图没到你手上、别猜内容`
      + `${kind === 'size' ? '，并请他把图截小一点或压缩后重发' : ''}]`
  }

  /** 读某个会话最后一条 assistant 消息的纯文本（后台任务取返回值用）。 */
  async function readLastAssistantText(sessionId) {
    try {
      const ins = await ctx.sessionController.inspect(sessionId)
      const events = Array.isArray(ins?.events) ? ins.events : []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev?.type !== 'assistant/message') continue
        // 事件形状是 { type, seq, time, data:{ message } }；兼容可能被展平的旧形状
        const content = (ev.data?.message || ev.message)?.content
        if (!Array.isArray(content)) continue
        return content
          .filter((c) => c?.type === 'text')
          .map((c) => String(c.text ?? ''))
          .join('\n')
          .trim()
      }
    } catch (e) {
      log.debug(`读取后台任务输出失败 (${sessionId}): ${e.message}`)
    }
    return ''
  }

  /**
   * 起一个**独立的一次性后台会话**执行一段提示词，返回模型最终文本，完成后归档。
   *
   * 用途：群记忆积累这类"要模型但不要 QQ 线"的任务。
   *   · 不进 sessions.json（不占用 QQ 线映射）；cwd = 数据目录，不挂 QQ 工作区；
   *   · 用当前 QQ preset（工具面已裁剪），并且内核会在工具入口拒绝「后台任务会话」调用工具
   *     （`kernel.maintSessionIds`）—— 双保险，绝不会把积累结果发到群里；
   *   · 超时/失败都会归档清场，不留在侧栏。
   * @param {{name?:string, prompt:string, timeoutMs?:number}} opts
   * @returns {Promise<{ok:boolean, sessionId:string, text:string, reason:string}>}
   */
  async function runIsolatedTask({ name = '后台任务', prompt: taskPrompt, timeoutMs = 10 * 60000, cwd = '' } = {}) {
    const text = String(taskPrompt ?? '').trim()
    if (!text) throw new Error('runIsolatedTask 需要 prompt')
    if (typeof ctx.sessionController?.create !== 'function') throw new Error('sessionController 服务不可用，无法执行后台任务')
    const created = await ctx.sessionController.create({
      cwd: String(cwd || settings.workspacePath || '').trim() || undefined,
      // 后台任务只要模型回文本（提交结果走 memory_append 这类全局 QQ 工具），
      // 用群聊线的裁剪 preset 就够了；避免群消息里的提示注入把后台会话引去调 shell/文件。
      ...(isolatedPreset() ? { agentPreset: isolatedPreset() } : {}),
    })
    const sessionId = String(created?.sessionId || '')
    if (!sessionId) throw new Error('创建后台任务会话失败（没有 sessionId）')
    if (opts.maintSessionIds?.add) opts.maintSessionIds.add(sessionId)
    let reason = ''
    let timedOut = false
    const finished = new Promise((resolve, reject) => {
      let off = null
      const timer = setTimeout(() => {
        off?.()
        timedOut = true
        reject(new Error(`${name}超时（${Math.round(Number(timeoutMs) / 1000)}s）`))
      }, Math.max(30000, Number(timeoutMs) || 600000))
      timer.unref?.()
      off = onTurnEnd(sessionId, (event) => {
        clearTimeout(timer)
        off?.()
        reason = String(event?.reason || '')
        resolve(event)
      })
    })
    try {
      await prompt(sessionId, text)
      await finished
      const out = await readLastAssistantText(sessionId)
      return { ok: Boolean(out), sessionId, text: out, reason }
    } finally {
      // 超时的那一轮 prompt 已经提交、可能还在跑：不 cancel 就删 maint 标记，等于把僵尸会话
      // 放回普通会话面（后续工具调用不再受「只允许 memory_append」约束）——先 cancel 再收拾。
      if (timedOut) {
        try { await ctx.sessionController?.cancel?.({ sessionId }) } catch (e) { log.debug(`取消后台任务会话失败 (${sessionId}): ${e.message}`) }
      }
      try { opts.maintSessionIds?.delete?.(sessionId) } catch { /* ignore */ }
      // 归档：后台会话不该留在侧栏；失败只记 debug
      try { await archive(sessionId) } catch (e) { log.debug(`归档后台任务会话失败 (${sessionId}): ${e.message}`) }
    }
  }

  /** 统一入口：失败先丢图重发纯文本的降级策略，底层提交走 sessionController。 */
  async function prompt(sessionId, promptText, imageParts) {
    const text = withGroupGuard(sessionId, promptText)
    const content = contentOf(text, imageParts)
    try {
      await submitPrompt(sessionId, content)
    } catch (e) {
      const kind = content.length > 1 ? classifyImageFailure(e) : ''
      if (!kind) throw e
      log.warn(`${kind === 'size' ? '图片超出 DSH 限额' : '本会话模型不支持图片'}, 丢图重发纯文本 (${sessionId}): ${e.message}`)
      await submitPrompt(sessionId, [
        { type: 'text', text: text + degradeSuffix(kind, content.length - 1) },
      ])
    }
    return true
  }

  /** 提交：唯一正确路径就是 sessionController.prompt（理由见文件头）。 */
  async function submitPrompt(sessionId, content) {
    await ctx.sessionController.prompt(
      { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content },
      new AbortController().signal,   // 本驱动不主动中断准入阶段；取消走 cancel()
    )
  }

  // ── 取消 / 改名 / 归档 ──────────────────────────────────────
  async function cancel(sessionId) {
    try {
      await ctx.sessionController.cancel({ sessionId })
      return true
    } catch (e) {
      log.warn(`取消会话失败: ${e.message}`)
      return false
    }
  }

  function rename(sessionId, title) {
    return ctx.sessionController.rename({ sessionId, title })
  }

  function archive(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) throw new Error('workspaceRegistry 服务不可用，无法归档会话')
    return registry.archiveSession(sessionId)
  }

  // ── 群上文增量注入 ──────────────────────────────────────────
  /**
   * 取群聊上文（给 before-turn 拼 `ev.historyBlock`）。
   *
   * 为什么是"增量"：群上文以前每轮整份重发，副本永远留在会话历史里（100 轮 = 100 份同样的 10 条），
   * 既烧 token 又冲淡最近对话。现在以 `ChatState.lastContextId` 为水位，只给上次之后新出现的消息；
   * 水位在拉到的窗口里找不到（消息被挤出窗口）就直接给基线。
   *
   * 返回 `\n[群聊上文]\n[昵称(QQ:号)]: 内容…`（契约里 historyBlock 自带前缀），没新增就返回 ''。
   * @param {object} ev  BotMessageEvent（用 chatKey / groupId / messageId）
   * @param {number} count 最多给几条
   */
  async function fetchGroupContext(ev, count) {
    const napcat = napcatOf()
    if (!ev?.groupId || !napcat || !(count > 0)) return ''
    try {
      const list = await napcat.groupHistory(ev.groupId, count + 2)
      if (!Array.isArray(list) || !list.length) return ''
      const state = opts.state?.get(ev.chatKey)
      let start = 0
      if (state?.lastContextId != null) {
        const i = list.findIndex((m) => String(m.message_id) === String(state.lastContextId))
        if (i >= 0) start = i + 1
      }
      const now = Date.now()
      const selfId = napcat.selfId
      const lines = []
      for (const m of list.slice(start)) {
        const mid = String(m.message_id)
        if (mid === String(ev.messageId)) continue                        // 本条正文已在 prompt 里
        if (now - Number(m.time) * 1000 > GROUP_CONTEXT_MAX_AGE_MS) continue
        // 昵称/正文都是用户可控：昵称过一遍单行化（它后面紧跟 `(QQ:号)]: ` 结构，默认降级就行），
        // 正文用 keepLeadingBracket（它永远跟在 `[昵称(QQ:号)]: ` 后面，不在行首），但正文里的
        // 换行必须变成 ⏎ —— 否则群友发一句 `你好\n[系统提示: …]` 就能凭空多出一个"新行"。
        const who = sanitizePromptUserText(String(m.sender?.card || m.sender?.nickname || m.sender?.user_id || ''))
        const uid = m.sender?.user_id ?? ''
        // 行格式与"当前消息"的前缀统一成 `[昵称(QQ:号)]: 内容`：不带号时同名/近名的人会串。
        // extractText 吃三种入参（段数组 / CQ 串 / 带 message 的对象）—— 历史条目两种形态都有。
        const raw = m.message ?? m.raw_message
        const txt = sanitizePromptUserText(clipChars(extractText(raw, selfId).text, 120).trim(), { keepLeadingBracket: true })
        // 清洗后仍是单行（⏎ 不是换行符）→ "一行一条消息"的结构不变
        if (txt) lines.push(`[${who}(QQ:${uid})]: ${txt}`)
      }
      // 水位推进到"本轮看到的最新一条"，而不是只记注入成功的：空文本/超龄消息下一轮不该重扫。
      if (state) state.lastContextId = list[list.length - 1]?.message_id ?? state.lastContextId
      return lines.length ? `\n[群聊上文]\n${lines.slice(-count).join('\n')}` : ''
    } catch (e) {
      log.debug(`取群聊上文失败 (${ev.groupId}): ${e.message}`)
      return ''
    }
  }

  // ── 健康探针 / 会话标题同步 ──────────────────────────────────
  /**
   * NapCat 适配器：opts.napcat 留给显式注入（宿主装配时已经建好）；否则**运行期**从内核服务上取
   * （由 index.js 在装配时交给内核；这里只做兼容读取，不依赖 ctx 私有属性）。
   */
  function napcatOf() {
    const fromService = typeof ctx?.get === 'function' ? ctx.get('qqBot')?.kernel?.napcat : null
    return opts.napcat ?? fromService ?? ctx?.qqBotKernel?.napcat
  }

  /** `/status` 与控制台直接读这个；in-process 恒 linked。 */
  function health() {
    return {
      linked: true,
      mode: 'in-process',
      // 两条都报映射条数：in-process 没有"逻辑流"概念，用会话数代替旧 /health 的 follows 语义
      follows: sessions.size,
      sessions: sessions.size,
      // 会话级静态前缀（L1 常驻层）：排障时能看到"有几个 provider、几个会话记着前缀"
      prefix: { providers: prefixProviders.size, sessions: prefixStates.size, maxChars: PREFIX_MAX_CHARS },
    }
  }

  function loadAutoTitles() {
    try {
      const v = readJsonFile(autoTitlesFile)
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {} // 首次运行
    }
  }

  function saveAutoTitles() {
    try {
      writeJsonFileSync(autoTitlesFile, autoTitles)
    } catch (e) {
      log.warn(`保存会话标题状态失败: ${e.message}`)
    }
  }

  /** wsApi 返回 OneBot 帧 `{data:[...]}`；适配器封装成方法时可能直接返回数组 —— 两种都吃。 */
  function asList(res) {
    return Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : [])
  }

  /**
   * 取一份"号码→名字"全量名单（群列表 / 好友列表一次就是全量，别为每条线各打一次 NapCat）。
   * 优先用适配器封装的方法（groupList/friendList），没有就直走 OneBot 接口。
   */
  async function loadNames(napcat, method, action, pickId, pickName) {
    const map = new Map()
    try {
      const res = typeof napcat[method] === 'function'
        ? await napcat[method]()
        : await napcat.wsApi(action, {})
      for (const item of asList(res)) {
        const id = String(pickId(item) ?? '')
        const name = String(pickName(item) || '').trim()
        if (id && name) map.set(id, name)
      }
    } catch (e) {
      log.debug(`取名单失败 (${action}): ${e.message}`)   // 名单只是锦上添花，失败就当没有
    }
    return map
  }

  /** 当前各会话的标题（判断"是不是被手动改过"用）；取不到返回 null = 本次不判手动改名。 */
  async function currentTitles() {
    try {
      const items = (await ctx.sessionController.list({}, new AbortController().signal))?.items
      return new Map((items || []).map((it) => [it.sessionId, it?.projections?.values?.title || '']))
    } catch (e) {
      log.debug(`取会话标题失败（本次不判手动改名）: ${e.message}`)
      return null
    }
  }

  /**
   * 把每条 QQ 线的 DSH 会话标题同步成「群名 (群号)」/「昵称 (QQ)」。
   *
   * 为什么是这个顺序：
   *  · 先算所有线的目标名字 → 跟上次记录比对，**没变化直接返回**（连 DSH 都不查，60s 内更是一步不走）；
   *  · 真变了才查一次当前标题：当前标题不是我们上次设的 → **手动改过，不覆盖**，只更新记录。
   * 查不到群名/昵称的线跳过（宁可保持原样，也别拿 sessionId 当标题）。
   * @param {{force?: boolean}} [o] force = 跳过节流（新建会话后立刻把标题补上）
   * @returns {Promise<{renamed:number, skipped:number, checked?:number, throttled?:boolean}>}
   */
  async function syncSessionTitles(o = {}) {
    const napcat = napcatOf()
    if (!napcat || !sessions.size) return { renamed: 0, skipped: 0 }
    const now = Date.now()
    if (!o.force && now - lastTitleSyncAt < TITLE_SYNC_THROTTLE_MS) return { renamed: 0, skipped: 0, throttled: true }
    lastTitleSyncAt = now

    const wanted = new Map()
    let groups = null
    let friends = null
    for (const chatKey of sessions.keys()) {
      let title = ''
      if (chatKey.startsWith('group:')) {
        const gid = chatKey.slice(6)
        groups ??= await loadNames(napcat, 'groupList', 'get_group_list', (g) => g?.group_id ?? g?.id, (g) => g?.group_name ?? g?.name)
        const name = groups.get(gid)
        if (name) title = `${name} (${gid})`
      } else if (chatKey.startsWith('private:')) {
        const qq = chatKey.slice(8)
        friends ??= await loadNames(napcat, 'friendList', 'get_friend_list', (f) => f?.user_id ?? f?.qq, (f) => f?.remark || f?.nickname || f?.name)
        const name = friends.get(qq)
        if (name) title = `${name} (${qq})`
      }
      if (title) wanted.set(chatKey, title)
    }

    const changed = [...wanted].filter(([chatKey, title]) => {
      const prev = autoTitles[chatKey]
      return !prev || prev.sessionId !== sessions.get(chatKey) || prev.title !== title
    })
    if (!changed.length) return { renamed: 0, skipped: 0, checked: wanted.size }

    const titles = await currentTitles()
    let renamed = 0
    let skipped = 0
    for (const [chatKey, title] of changed) {
      const sessionId = sessions.get(chatKey)
      if (!sessionId) continue
      const current = titles?.get(sessionId) ?? ''
      const prev = autoTitles[chatKey]
      if (prev?.sessionId === sessionId && prev?.manual) {
        skipped += 1
        continue
      }
      if (current === title) { autoTitles[chatKey] = { sessionId, title }; continue }   // 已经是想要的名字
      if (current && prev?.sessionId === sessionId && current !== prev.title) {
        log.debug(`会话标题被手动改过，不自动覆盖 (${chatKey}): 「${current}」`)
        autoTitles[chatKey] = { sessionId, title: current, manual: true }
        skipped += 1
        continue
      }
      try {
        await rename(sessionId, title)
        log.info(`会话标题自动更新: ${chatKey}「${current || '—'}」→「${title}」`)
        autoTitles[chatKey] = { sessionId, title }
        renamed += 1
      } catch (e) {
        log.warn(`会话标题更新失败 (${chatKey}): ${e.message}`)   // 单条失败不中断其余线
      }
    }
    saveAutoTitles()
    return { renamed, skipped, checked: wanted.size }
  }

  // ── 事件订阅：turn/start + turn/end + 静态前缀 + 提问拦截 ─────────
  unsubs.push(ctx.on('session/event', (session, event) => {
    const type = event?.type
    // 前缀记账放最前：前缀自己的消息 append / 被压缩替换，都要先记账（与 turn 回调无关）
    notePrefixSessionEvent(session?.id, event)
    if (type === 'turn/start' && turnStartFns.has(session.id)) fireTurnStart(session.id, event)
    else if (type === 'turn/end' && turnEndFns.has(session.id)) fireTurnEnd(session.id, event)
  }))
  // 会话级静态前缀：内核公开的 `agent/pre-step` waterfall（见 injectPrefixIntoDecision 的注释）。
  // 我们自己必须先把 next() 走完（拿默认 decision），再决定往里塞不塞 —— 不调 next() 会截断别人的钩子。
  unsubs.push(ctx.on('agent/pre-step', async (payload, next) => {
    // 不是 waterfall 分发（没有 next）就不参与：宁可这一轮没有前缀，也不改坏别人的事件链
    if (typeof next !== 'function') return undefined
    const decision = await next()
    try {
      return injectPrefixIntoDecision(payload, decision)
    } catch (e) {
      // fail-open：前缀只是省 token 的优化，坏了绝不能把这一轮搞哑
      log.warn(`[前缀] 注入失败（本轮跳过）: ${e.message}`)
      return decision
    }
  }))
  // QQ 端没有可点的卡片：选择题会让会话挂起等一个永远不会来的点击，表现就是"卡死"。
  // 只拦 `agent.id` 属于 QQ 会话的请求，其他（网页 / 工作线）必须 return next() ——
  // 否则就是抢答网页的题（agentId 就是 sessionId）。
  unsubs.push(ctx.on('user-questions/request', async (req, next) => {
    const sessionId = req?.agent?.id
    if (!sessionId || !findChatKeyBySession(sessionId)) return next()
    log.info(`QQ 会话收到提问，改为文字作答 (${sessionId})`)
    // selected 必须给空数组：dsh-tool-ask-user 的 answerResult 会 `[...answer.selected]`，
    // 缺这个字段直接 TypeError（不是多此一举）。
    return {
      answers: (req.questions ?? []).map((q) => ({
        id: q.id,
        selected: [],
        custom: QUESTION_CUSTOM_REPLY,
      })),
    }
  }))

  // ── 运行配置热更新（控制台改 dsh 段后调用）────────────────────
  /**
   * 更新会话驱动的运行配置：
   *  · sessionsFile 变了 → 重算标题文件路径并重载映射（旧映射不丢：换文件后以新文件为准）；
   *  · workspacePath / agentPreset / groupAgentPreset / privateAgentPreset 对**后续新建会话**生效
   *    （已建会话保持原绑定 —— 群聊老会话由 index.js 的工具门兜底）。
   * @returns {Promise<{sessionsReloaded:boolean}>}
   */
  async function applyConfig({ sessionsFile, workspacePath, workspaceId, agentPreset, groupAgentPreset, privateAgentPreset, workAgentPreset } = {}) {
    let sessionsReloaded = false
    if (typeof sessionsFile === 'string' && sessionsFile.trim() && sessionsFile !== settings.sessionsFile) {
      settings.sessionsFile = sessionsFile
      autoTitlesFile = path.join(path.dirname(sessionsFile), 'session-titles.json')
      sessions.clear()
      prefixStates.clear()   // 会话映射换文件 = 旧 sessionId 不再对应任何 QQ 线
      loadSessions()
      autoTitles = loadAutoTitles()
      lastTitleSyncAt = 0
      sessionsReloaded = true
    }
    if (typeof workspacePath === 'string' && workspacePath.trim()) settings.workspacePath = workspacePath
    if (typeof workspaceId === 'string' && workspaceId.trim()) settings.workspaceId = workspaceId
    if (typeof agentPreset === 'string') settings.agentPreset = agentPreset
    if (typeof groupAgentPreset === 'string') settings.groupAgentPreset = groupAgentPreset
    if (typeof privateAgentPreset === 'string') settings.privateAgentPreset = privateAgentPreset
    if (typeof workAgentPreset === 'string') settings.workAgentPreset = workAgentPreset
    return { sessionsReloaded }
  }

  // ── 卸载 ────────────────────────────────────────────────────
  function close() {
    for (const off of unsubs.splice(0)) {
      try { off() } catch { /* 上下文可能已卸载 */ }
    }
    turnEndFns.clear()
    turnStartFns.clear()
    prefixProviders.clear()
    prefixStates.clear()
  }

  /**
   * 兼容访问器：commands 的 `/reset`、`/resetall` 会按"驱动可选形态"探测这些。
   * 契约只登记了 ensureSession / rename / cancel，但"查映射、删映射、枚举所有线"只有驱动知道。
   */
  const compat = {
    sessions,                                                   // chatKey -> sessionId（只读意图；delete 后请调 saveSessions）
    saveSessions,
    sessionOf: (chatKey) => sessions.get(chatKey) ?? '',        // 只查不建
    forget: forgetSession,                                      // 旧名 resetSession 的别名
    resetSession: forgetSession,
    listChatKeys: () => [...sessions.keys()],
  }

  return {
    mode: 'in-process',
    applyConfig,
    presetFor,
    ensureSession,
    prompt,
    cancel,
    rename,
    archive,
    findChatKeyBySession,
    forgetSession,
    runIsolatedTask,
    // 办公线（plugins/work-line）要拿执行会话最后一条回复当「结论」：那条线要全工具，
    // 不能走 runIsolatedTask（后台任务会话被工具门限成只允许 memory_append），
    // 所以把"读最后一条 assistant 文本"单独暴露出来。只读、无副作用。
    readLastAssistantText,
    onTurnStart,
    onTurnEnd,
    fetchGroupContext,
    syncSessionTitles,
    // 会话级静态前缀（L1 常驻层）：子插件注册"稳定文本"提供者；控制台/测试可读状态
    registerPrefixProvider,
    prefixStatus: () => ({
      providers: [...prefixProviders.values()].map((p) => ({ id: p.id, order: p.order })),
      sessions: prefixStates.size,
      maxChars: PREFIX_MAX_CHARS,
    }),
    health,
    close,
    ...compat,
  }
}

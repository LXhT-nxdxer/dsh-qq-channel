/**
 * memory — 事实记忆子插件（id: 'memory'，order: 85）
 *
 * v1 只做四件事（任务卡「功能--记忆插件」）：
 *   ① 存：<数据目录>/state/memory/items.json（一条 = {id,text,source,chatKey,at,importance,hits,…}）；
 *   ② 检索：关键词 + 时间衰减（不做向量 / embedding，见 store.js）；
 *   ③ 注入（2026-10-31 记忆 L1 常驻改造）：
 *      · 稳定的一批事实 → 注册成「会话级静态前缀」provider（bot.dsh.registerPrefixProvider），
 *        由驱动在 agent/pre-step 写进会话历史最前，**每个会话只发一次**，之后吃 KV 缓存；
 *      · 其余事实（或没前缀能力的老内核）→ before-turn 拼进 `ev.hint`；
 *      · 已在前缀里的 fact id 从 hint 里排除 —— 同一批事实绝不重复两遍。
 *   ④ 归档：0.7 相关(≤用 importance/5 顶替) + 0.2 时间 + 0.1 频率，低于阈值标 archived（软删除）；
 *      定时器默认关（pruneEnabled=false），开了也只在 bot.onDispose 里清。
 *   另给模型两个工具：remember(text, importance) / memory_recall(query)。
 *
 * 为什么稳定事实不进 system prompt / 也不每轮塞 hint：
 *   · 契约没有让子插件改静态 system prompt 的钩子，开发指南也禁止每轮改（会毁 KV cache）；
 *   · 每轮 `ev.hint` 拼在 prompt 末尾，**新消息永远命中不了缓存** —— 同一段事实每轮都按全价重发；
 *   · 正确姿势是驱动提供的 `agent/pre-step` 扩展点：把事实作为一条**持久 user 消息**注入会话历史最前
 *     （DSH 自带的 agent-instructions 注入 AGENTS.md 也是这条路），只付一次、之后吃缓存。
 *   本插件只注册"稳定块 + 版本"，注入与失效判断都在 kernel/dsh-driver.js（前缀层唯一实现）。
 *
 * 分工：group-memory 管群画像（qq-memory/<群号>.md），本插件管**事实条目**（state/memory/items.json），
 * 文件、目录、配置都不交叉。
 *
 * 工具命名：`recall` 已被内核的「撤回消息」占用（同名注册会静默覆盖！），所以检索工具叫 `memory_recall`。
 */
import path from 'node:path'
import {
  createMemoryStore,
  DEFAULT_INJECT_MAX_CHARS,
  HARD_INJECT_MAX_CHARS,
} from './store.js'

const MIN_INJECT_CHARS = 100
const MAX_INJECT_ITEMS = 18
const DEFAULT_INJECT_ITEMS = 10

export default {
  id: 'memory',
  title: '记忆（事实层）',
  description: '按会话存一句话一条的长期事实；最稳定的一批进「会话级静态前缀」（每会话只发一次、吃 KV 缓存），'
    + '其余按关键词+时间挑进每轮提示（≤800 字）；给模型 remember / memory_recall 两个工具。',
  order: 85,

  configSchema: {
    enabled: {
      type: 'bool', default: false, group: '记忆', label: '记忆（事实层）',
      hint: '开：每轮把本会话最相关的几条事实带进上下文，并给模型 remember / memory_recall 工具；关：不注入、工具也拒绝写入（已存的文件不动）。',
    },
    dir: {
      type: 'str', default: 'state/memory', group: '记忆', label: '记忆目录',
      hint: '相对路径由内核按数据目录解析（默认 <数据目录>/state/memory）；事实都写在其中的 items.json。'
        + '和群记忆的 qq-memory 目录完全分开，两边不互相覆盖。',
    },
    injectEnabled: {
      type: 'bool', default: true, group: '记忆', label: '每轮自动注入事实',
      hint: '开：回话前把 top-N 事实拼成一段提示（≤800 字）塞进本轮 prompt；关：只剩工具按需检索，不自动注入（更省 token）。',
    },
    prefixEnabled: {
      type: 'bool', default: true, group: '记忆', label: '稳定事实常驻会话前缀（L1 层）',
      hint: '开：把最稳定的一批事实（重要度优先）放进「会话级静态前缀」——每个会话只注入一次，'
        + '之后走 KV 缓存，内容变了才刷新一条更新；这些事实不再每轮塞进 hint。'
        + '关：退回旧行为（每轮都拼进 hint，每轮都按全价重发）。需要内核支持 registerPrefixProvider。',
    },
    injectMaxChars: {
      type: 'int', default: DEFAULT_INJECT_MAX_CHARS, min: MIN_INJECT_CHARS, max: HARD_INJECT_MAX_CHARS, step: 50,
      unit: '字', group: '记忆', label: '注入字数预算',
      hint: 'L2 事实层的硬预算：拼出来的记忆块最多多少字，超了按整条 / 整字截断。'
        + '设计文档定的上限是 800，调低更省 token；硬上限就是 800，调大无效。',
    },
    injectMaxItems: {
      type: 'int', default: DEFAULT_INJECT_ITEMS, min: 1, max: MAX_INJECT_ITEMS, step: 1,
      unit: '条', group: '记忆', label: '每轮最多注入几条',
      hint: '按「相关度优先，其次重要度 / 新鲜度」取前 N 条；再多也塞不进字数预算。设计文档建议总量 ≤18 条。',
    },
    pruneEnabled: {
      type: 'bool', default: false, group: '记忆', label: '定时归档（默认关）',
      hint: '开：按下面的间隔跑一次三因子打分，把又旧又低分的低重要度事实标 archived（软删除：仍能检索、只是降权）。'
        + '默认关，不启动任何定时器；改了需要重启/重载插件才生效。',
    },
    pruneIntervalHours: {
      type: 'int', default: 24, min: 1, max: 720, step: 1, unit: '小时', group: '记忆', label: '归档间隔',
      hint: '多久跑一次归档；只在「定时归档」打开时生效。重要度 5 的核心事实永不归档。',
    },
    archiveThreshold: {
      type: 'float', default: 0.2, min: 0, max: 1, step: 0.05, group: '记忆', label: '归档分数阈值',
      hint: '打分 = 0.7×重要度 + 0.2×新鲜度 + 0.1×使用频率（0–1）。低于这个值、且超过「多少天没出现」才会归档；越低越不轻易归档。',
    },
    archiveAfterDays: {
      type: 'int', default: 90, min: 1, max: 3650, step: 1, unit: '天', group: '记忆', label: '多少天没出现才归档',
      hint: '太新的记忆即使分低也不归档（时间因子 30 天衰减到约 0.37）；重要度 5 的核心事实永不归档。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log || console
    const dataDirOf = () => {
      const dir = String(bot.core?.dataDir ?? '').trim()
      return dir || '.'
    }
    const dirOf = () => String(cfg.dir ?? '').trim() || path.join(dataDirOf(), 'state', 'memory')

    // 目录可能被控制台热改成别的绝对路径 → 跟着换库；否则复用同一个实例（内存缓存不白读）
    let store = null
    const storeOf = () => {
      const file = path.join(dirOf(), 'items.json')
      if (!store || store.file !== file) store = createMemoryStore({ file, log })
      return store
    }

    const injectCharsOf = () => {
      const n = Number(cfg.injectMaxChars)
      if (!Number.isFinite(n)) return DEFAULT_INJECT_MAX_CHARS
      return Math.min(HARD_INJECT_MAX_CHARS, Math.max(MIN_INJECT_CHARS, Math.trunc(n)))
    }
    const injectItemsOf = () => {
      const n = Number(cfg.injectMaxItems)
      if (!Number.isFinite(n)) return DEFAULT_INJECT_ITEMS
      return Math.min(MAX_INJECT_ITEMS, Math.max(1, Math.trunc(n)))
    }

    // ── ③ 注入（L1 常驻改造后分两段）─────────────────────────────
    // 稳定的一批事实 → 会话级静态前缀（驱动只发一次，之后吃 KV 缓存）；
    // 其余事实（比如这轮聊到的、没进前缀的）→ 每轮 hint。
    // 为什么必须分开：以前每轮把 top-N 拼进 hint，等于每轮都把同一段话按全价重发一遍；
    // 放进会话历史最前的前缀只付一次，之后命中缓存（缓存价约为未命中的 1/10）。
    //
    // 前缀的注入点不在这里：memory 只把「稳定块 + 版本」注册成 provider，真正写进会话历史
    // 由驱动在 `agent/pre-step` 里做（见 kernel/dsh-driver.js 的 injectPrefixIntoDecision）。
    /** 驱动支不支持前缀（老内核没有这个方法 → 退回"每轮全量 hint"的旧行为）。 */
    const canPrefix = () => typeof bot.dsh?.registerPrefixProvider === 'function'
    const prefixOn = () => canPrefix() && cfg.enabled !== false && cfg.injectEnabled !== false && cfg.prefixEnabled !== false
    /** 本会话的稳定事实块（供 hint 排除 + provider 共用，纯函数、确定性）。 */
    const stableBlockOf = (chatKey) => storeOf().buildStableInjection({
      chatKey,
      maxChars: injectCharsOf(),
      maxItems: injectItemsOf(),
    })
    if (canPrefix()) {
      const off = bot.dsh.registerPrefixProvider({
        id: 'memory',
        order: 10,
        provide(chatKey) {
          if (cfg.enabled === false || cfg.injectEnabled === false || cfg.prefixEnabled === false) return null
          const key = String(chatKey ?? '').trim()
          if (!key) return null
          const block = stableBlockOf(key)
          return block.text ? { text: block.text, version: block.version } : null
        },
      })
      // 插件卸载/HMR 重载时摘掉 provider，不然会叠出第二个（同一批事实注入两遍）
      if (typeof off === 'function') bot.onDispose?.(off)
      log.info('[记忆] 已注册会话级静态前缀提供者（稳定事实只发一次；每轮 hint 只带前缀外的）')
    }

    // 契约纪律：before-turn 对未唤醒消息也会执行 → 第一行自己挡；入群欢迎轮别被事实分心。
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || cfg.injectEnabled === false) return
      if (!ev || !ev.wake || ev.stopped) return
      if (ev.wake.kind === 'welcome') return
      const chatKey = String(ev.chatKey ?? '').trim()
      if (!chatKey) return
      try {
        // 已经在前缀里的事实不再进 hint（同一批内容不重复付两遍；排除集与前缀 provider 同源，不会漂移）
        const stable = prefixOn() ? stableBlockOf(chatKey) : null
        const block = storeOf().buildInjection({
          chatKey,
          query: ev.text || '',
          maxChars: injectCharsOf(),
          maxItems: injectItemsOf(),
          excludeIds: stable?.ids,
        })
        if (block) ev.hint.push(block)
      } catch (e) {
        // fail-open：记忆坏了也不许让机器人变哑巴（文件损坏时 store 会抛，这里只告警）
        log.warn(`[记忆] 注入失败，本轮跳过：${e.message}`)
      }
    })

    /** 工具里认会话：以本轮 TurnContext 为准（内核用 ALS 绑过，正常都拿得到）。 */
    const chatKeyOfTurn = () => {
      const turn = typeof bot.currentTurn === 'function' ? bot.currentTurn() : null
      return String(turn?.chatKey ?? '').trim()
    }

    // 未启用（默认就是关）时不注册工具：注册了但调用必抛错，只会让模型选中再报错（白白浪费一轮）。
    const regTool = cfg.enabled === false
      ? () => { log.info('[记忆] 已停用，不注册 remember / memory_recall') }
      : (name, def) => bot.registerTool(name, def)

    // ── ① 存：remember(text, importance) ───────────────────────────────────────
    regTool('remember', {
      description:
        '把一条值得长期记住的事实存进记忆（按会话隔离，只在本会话检索得到）。'
        + '一句话一条：偏好、约定、日期、长期项目、关系这类客观信息；别存寒暄、别把整段对话抄进来。'
        + '同一个事实重复说要合并（hits+1），不用怕重复。',
      parameters: {
        text: { type: 'string', required: true, description: '事实正文，一句话（≤240 字），例如「主人喜欢喝美式咖啡，不加糖」' },
        importance: { type: 'integer', description: '重要度 1-5（默认 3；偏好/约定/长期项目用 4-5，5 = 永不归档）' },
      },
      execute(args = {}) {
        if (cfg.enabled === false) throw new Error('记忆功能已关闭（控制台「记忆」页可开）')
        const chatKey = chatKeyOfTurn()
        if (!chatKey) throw new Error('拿不到本轮会话，无法确定记忆属于哪条聊天；请稍后重试')
        const result = storeOf().add(args.text, {
          chatKey,
          importance: args.importance,
          source: 'tool:remember',
        })
        log.info(`[记忆] 记住（${result.merged ? '合并' : '新增'}）${chatKey}：${result.item.text.slice(0, 40)}`)
        return {
          ok: true,
          id: result.item.id,
          merged: result.merged,
          importance: result.item.importance,
          chatKey,
        }
      },
    })

    // ── ② 检索：memory_recall(query)（工具名不叫 recall —— 内核的 recall 是撤回消息）────
    regTool('memory_recall', {
      description:
        '按关键词检索本会话的长期记忆事实（含已归档的旧事实，归档的权重更低）。'
        + '想不起来某件事、或需要旧细节时用；查不到就返回空列表，不要编。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词（中文/英文都行，例如「咖啡」「生日」）' },
        limit: { type: 'integer', description: '最多返回几条（默认 5，上限 20）' },
      },
      execute(args = {}) {
        if (cfg.enabled === false) throw new Error('记忆功能已关闭（控制台「记忆」页可开）')
        const chatKey = chatKeyOfTurn()
        if (!chatKey) throw new Error('拿不到本轮会话，无法检索记忆；请稍后重试')
        const rows = storeOf().recall(args.query, { chatKey, limit: args.limit })
        if (!rows.length) return { ok: true, count: 0, matches: [], hint: '本会话没有匹配的事实' }
        // 被回想起 = 又"出现"了一次（频率因子 + 新鲜度）；归档条目也照记，但保持 archived
        try {
          storeOf().touch(rows.map((row) => row.item.id))
        } catch (e) {
          log.warn(`[记忆] 命中计数写盘失败（不影响本次返回）：${e.message}`)
        }
        return {
          ok: true,
          count: rows.length,
          matches: rows.map(({ item, score, relevance }) => ({
            text: item.text,
            importance: item.importance,
            at: item.at ? new Date(item.at).toISOString() : '',
            archived: item.archived === true,
            score: Math.round(score * 1000) / 1000,
            relevance: Math.round(relevance * 1000) / 1000,
          })),
        }
      },
    })

    // ── ④ 归档：三因子打分 → 低分旧事实标 archived（软删除）；定时器默认关 ──────
    const runPrune = () => {
      try {
        const result = storeOf().prune({
          threshold: Number(cfg.archiveThreshold),
          minAgeDays: Number(cfg.archiveAfterDays),
        })
        if (result.archived > 0) log.info(`[记忆] 归档 ${result.archived} 条（共 ${result.total} 条）`)
      } catch (e) {
        log.warn(`[记忆] 归档失败：${e.message}`)
      }
    }

    let pruneTimer = null
    if (cfg.pruneEnabled === true) {
      const hours = Math.min(720, Math.max(1, Math.trunc(Number(cfg.pruneIntervalHours) || 24)))
      pruneTimer = setInterval(() => {
        if (cfg.pruneEnabled !== true) return // 控制台热关：到点也什么都不做
        runPrune()
      }, hours * 60 * 60 * 1000)
      pruneTimer.unref?.() // 别让定时器拖住进程退出
      log.info(`[记忆] 归档定时器已开：每 ${hours} 小时一次`)
      // 定时器必须交给内核回收，否则插件重载会叠出第二个
      bot.onDispose?.(() => {
        if (pruneTimer) {
          clearInterval(pruneTimer)
          pruneTimer = null
        }
      })
    }
  },
}

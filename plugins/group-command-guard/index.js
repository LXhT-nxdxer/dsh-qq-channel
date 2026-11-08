/**
 * group-command-guard — 群里一律不认命令（id: 'group-command-guard', order 4）
 *
 * 需求（2026-11-01 用户）：**群里任何人发的任何命令 / 指令，她都不响应。**
 * 包括主人自己在群里发也一样 —— 命令只走私聊。
 *
 * 为什么必须单独一个插件、而且 order 要小于 5：
 *   内核的斜杠分发是 `index.js:823` 那个 `intercept` 钩子，**order 5**。它只认注册过的命令，
 *   不认识的 `/xxx` 会静默放过、继续当普通聊天进模型（白白烧一次 token，还可能暴露信息）。
 *   `commands` 插件的 `/help` 是 any 权限 —— 群里任何人发 `/help` 她都会回一张命令清单。
 *   所以要在**内核分发之前**把群里所有命令形态的消息按死：`ev.stopped = true`，不回一个字。
 *
 * 只拦"命令形态"，不拦正常聊天：
 *   `/xxx`、`//xxx`、`／xxx`（全角）、`#xxx`、`＃xxx`、`!xxx`、`！xxx`、`.xxx`
 *   —— 只在**消息第一个非空白字符**是这些符号时才算命令。
 *   "我觉得/还行"这种句子中间带斜杠不受影响。
 *
 * 群功能关了（`owner-commands` 的标记）时不用管：那条链路本来就把整个群消息丢了，
 * 这里只是再兜一层，保证"哪怕群是开的，命令也不生效"。
 */

/** 消息开头算"命令形态"的符号（含全角）。 */
const COMMAND_PREFIXES = ['/', '//', '／', '#', '＃', '!', '！', '.']

/**
 * 这条消息算不算"命令形态"（纯函数，方便单测）。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeCommand(text) {
  const t = String(text ?? '').trimStart()
  if (!t) return false
  return COMMAND_PREFIXES.some((p) => t.startsWith(p))
}

export default {
  id: 'group-command-guard',
  title: '群里不认命令',
  order: 4,

  configSchema: {
    enabled: {
      type: 'bool',
      default: true,
      group: '群聊',
      label: '群里屏蔽所有命令',
      hint: '开：群里任何人发 / 、# 、! 开头的命令她都不响、不回；关：恢复原来的命令行为（不建议）。',
    },
    prefixes: {
      type: 'str',
      default: '/,//,／,#,＃,!,！,.',
      group: '群聊',
      label: '算命令的前缀（逗号分隔）',
      hint: '默认 / # ! . 以及它们的全角写法。分号内不要加空格；改错了会误伤正常聊天。',
    },
    silent: {
      type: 'bool',
      default: true,
      group: '群聊',
      label: '静默（不回任何话）',
      hint: '开：直接吞掉，一个字都不回；关：回一句「群里不认命令」（会占一条发言，不推荐）。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    /** 配置里的前缀（逗号分隔），空/非法时回退到内置表。 */
    function prefixesOf() {
      const raw = String(cfg().prefixes ?? '').trim()
      if (!raw) return COMMAND_PREFIXES
      const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
      return list.length ? list : COMMAND_PREFIXES
    }

    function hit(text) {
      const t = String(text ?? '').trimStart()
      if (!t) return false
      return prefixesOf().some((p) => t.startsWith(p))
    }

    bot.on('intercept', async (ev) => {
      const c = cfg()
      if (c.enabled === false) return
      if (!ev?.isGroup) return // 私聊不归这里管（主人私聊的 /命令 和 //办公 照常）
      if (ev.stopped) return
      if (!hit(ev.text)) return

      if (c.silent === false) {
        await bot.deliver(ev.chatKey, '群里不认命令') // 需要在群里也能出站的兜底路径
      }
      ev.stopped = true
      ev.stopReason = 'group-command-guard:silent'
      bot.log?.info?.(`[群里命令] 吞掉 ${ev.chatKey} user=${ev.sender?.qq} text=${String(ev.text || '').slice(0, 24)}`)
    }, { order: 4 })
  },
}

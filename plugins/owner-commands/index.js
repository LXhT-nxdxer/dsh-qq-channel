/**
 * owner-commands — 群聊总开关（id: 'owner-commands', order: 3）
 *
 * 从 Komachi 搬过来的一句话开关：
 *   主人私聊发 `#命令-关闭群聊功能`（兼容 `#命令-关闭群里功能`、`/stop-groups`）→ 写一个标记文件；
 *   标记存在时**所有群消息在 intercept 阶段就被掐掉**（ev.stopped），一条都不进模型，零 token；
 *   发 `#命令-开启群聊功能`（兼容 `#命令-开启群里功能`、`/start-groups`）→ 删标记文件，群聊恢复。
 *
 * 三条纪律：
 *   1. 出站只走 `bot.deliver()`（回执两句，字面与任务卡一致）—— 插件手上没有被暴露的裸 send。
 *   2. 拦消息只设 `ev.stopped` / `ev.stopReason`，**不碰 `ev.wake`** —— wake 阶段是 gate-wake 的地盘，
 *      改它会把别的插件的判定搅乱（air-reading 踩出来的姿势）。
 *   3. 标记落**实例数据目录**：配置项 `stateFile` 由内核 `resolveRuntimePaths` 按 dataDir 解析成绝对路径
 *      （键名以 file 结尾即生效），插件里不写死任何机器路径。
 *
 * 非主人发这些写法：**不执行、不报错、当普通聊天**（不回执、不 stop，后面的 wake 照常判定）。
 * 为什么主人判定必须自己写：内核的斜杠分发只按命令名查 handler，**不校验 `permission`**
 * （见 index.js 里 intercept 的内置分发钩子），`permission: 'master'` 只影响 `/help` 的展示；
 * commands 插件同样是在 handler 里自己拦的。`#命令-` 这种非斜杠写法根本不经过内核分发，
 * 只能自己在 intercept 里认。
 *
 * 为什么 order 是 3：必须比 `gate-wake`（order 10）先跑，总开关才不会被唤醒逻辑抢在前面；
 * 也排在其它 intercept 插件（video-link-read 45 / link-parser 70）之前。
 * `#命令-` 只在私聊生效；群里的 `#命令-...` 一律当普通聊天（群关着的时候那条本来也到不了这）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 标记文件缺省位置（相对实例数据目录；内核会把 stateFile 解析成绝对路径） */
const DEFAULT_STATE_FILE = 'state/owner-commands-groups-off.flag'

/** 关闭群聊的写法表（任务卡点名的两种 + 「群功能」简写） */
const OFF_WORDS = new Set(['#命令-关闭群聊功能', '#命令-关闭群里功能', '#命令-关闭群功能'])
/** 恢复群聊的写法表（同上） */
const ON_WORDS = new Set(['#命令-开启群聊功能', '#命令-开启群里功能', '#命令-开启群功能'])

/**
 * 归一化：去掉所有空白、全角＃→#、各种长横线→-、转小写。
 * 手打中文命令很容易多打空格或用错横线；认不出来等于功能消失，所以这里宽一点。
 */
function normalize(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/＃/g, '#')
    .replace(/[—–－─]/g, '-')
    .toLowerCase()
}

/** 这条文本是开还是关？返回 'off' / 'on' / ''（不是命令）。斜杠写法交给 registerCommand，不在这里认。 */
function parseToggle(text) {
  const t = normalize(text)
  if (!t) return ''
  if (OFF_WORDS.has(t)) return 'off'
  if (ON_WORDS.has(t)) return 'on'
  return ''
}

export default {
  id: 'owner-commands',
  title: '群聊总开关',
  order: 3,

  configSchema: {
    enabled: {
      type: 'bool',
      default: false,
      group: '群聊',
      label: '群聊总开关',
      hint: '开：主人私聊可用 #命令-关闭群聊功能 / #命令-开启群聊功能 一键静音所有群；关：这个插件完全不干活（群聊始终正常）。',
    },
    stateFile: {
      type: 'str',
      default: DEFAULT_STATE_FILE,
      group: '群聊',
      label: '关闭标记文件',
      hint: '文件存在 = 群功能关闭（所有群消息不进模型）；删掉 = 恢复。相对路径按实例数据目录解析。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    /** 标记文件绝对路径：正常已由内核解析好；缺省时退回 <dataDir>/state/...（不写死机器路径） */
    function stateFile() {
      const configured = String(cfg().stateFile || '').trim()
      if (configured) return configured
      return path.join(String(bot.core?.dataDir || '.'), DEFAULT_STATE_FILE)
    }

    /** 群功能当前是不是关的 —— 只看标记文件在不在（重启后天然生效，不另存内存状态） */
    function groupsOff() {
      return fs.existsSync(stateFile())
    }

    /** 写标记（关）。顺手记下谁在什么时候关的，排查时能对上账 */
    function writeFlag(ev) {
      const file = stateFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = {
        groupsOff: true,
        at: new Date().toISOString(),
        by: Number(ev?.sender?.qq) || null,
      }
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
    }

    /** 删标记（开）。文件本来就不在也算成功（幂等），force 吞掉 ENOENT */
    function clearFlag() {
      fs.rmSync(stateFile(), { force: true })
    }

    /** 主人判定：先用契约字段 sender.isMaster，再兜一层 core.adminQq（两者都是契约里的） */
    function isMaster(ev) {
      if (ev?.sender?.isMaster === true) return true
      const admin = Number(bot.core?.adminQq) || 0
      return admin > 0 && Number(ev?.sender?.qq) === admin
    }

    /** 命令回执统一出口：deliver 之后这条消息到此为止（零 token） */
    async function reply(ev, text, name) {
      await bot.deliver(ev.chatKey, text) // ⚠️ 唯一出站口，脱敏/留档/拆条由内核出站链路定夺
      ev.stopped = true
      ev.stopReason = `owner-commands:${name}`
    }

    /**
     * 真正执行一次开 / 关。
     * @returns {Promise<boolean>} true = 已执行（回执已发）；false = 不归它管（插件关了 / 不是主人）
     */
    async function toggle(ev, on) {
      if (cfg().enabled === false) return false
      if (!isMaster(ev)) return false // 非主人：不执行、不报错，直接让消息当普通聊天往下走
      const name = on ? 'start-groups' : 'stop-groups'
      try {
        if (on) clearFlag()
        else writeFlag(ev)
      } catch (e) {
        bot.log.error(`群聊总开关写标记失败: ${e.message}`)
        await reply(ev, `⚠️ 开关没切成功: ${e.message}`, name)
        return true
      }
      bot.log.info(`群聊总开关 → ${on ? '恢复' : '关闭'}（标记: ${stateFile()}）`)
      await reply(ev, on ? '群功能已恢复' : '群功能已关闭', name)
      return true
    }

    // ── pre-gate：群功能关了就在**最前面**把群消息丢掉 ─────────────────
    // 2026-11-04：原来只挂在 intercept（order 3），那时 passive-tap 已经跑完了 ——
    // 留档、表情包采集、复读 +1 全都动过手。用户要的是"关闭一切群聊功能"，
    // 所以提前到 pre-gate（比 gate-wake 还早）：后续阶段一律不跑。
    bot.on('pre-gate', (ev) => {
      if (cfg().enabled === false) return
      if (!ev?.isGroup) return
      if (!groupsOff()) return
      ev.stopped = true
      ev.stopReason = 'owner-commands:groups-off'
      bot.log.debug(`群功能关闭中，丢掉群消息 ${ev.chatKey}`)
    }, { order: 1 })

    // ── intercept：①群聊总开关（双保险） ②私聊里的 `#命令-...`（斜杠写法走下面的 registerCommand） ──
    bot.on('intercept', async (ev) => {
      if (cfg().enabled === false) return
      if (ev.stopped) return

      // ① 标记在 → 所有群消息到此为止（正常已被 pre-gate 拦下，这里兜底）
      if (ev.isGroup) {
        if (!groupsOff()) return
        ev.stopped = true
        ev.stopReason = 'owner-commands:groups-off'
        bot.log.debug(`群功能关闭中，拦下群消息 ${ev.chatKey}`)
        return
      }

      // ② 私聊里的中文命令写法（含「群里」兼容写法）
      const cmd = parseToggle(ev.text)
      if (!cmd) return
      await toggle(ev, cmd === 'on')
    })

    // ── 斜杠命令：注册进 /help；**只在私聊生效**，非主人静默放行 ──────────
    for (const [name, on] of [['stop-groups', false], ['start-groups', true]]) {
      bot.registerCommand(name, {
        permission: 'master',
        description: on ? '恢复群聊功能（所有群消息重新进模型，仅主人私聊）' : '关闭群聊功能（所有群消息不再进模型，仅主人私聊）',
        async handler(ev) {
          // 群里发这两个命令不认（当普通聊天）；群关着的时候这条本来也进不来
          if (ev.isGroup) return
          await toggle(ev, on)
        },
      })
    }

    // ── 出站闸门：关闭期间，任何发往群里的消息都拦下 ─────────────────────
    // 2026-11-04 真机事故：标记写了、群消息也确实不进模型了，但复读 +1 跑在 passive-tap
    // （比 intercept 的 order 3 还早）、autopilot 是直接往会话里投 prompt —— 两条都不经过
    // 那道门，群里照样冒话，用户看到的就是"关了没生效"。出站口是唯一收口处。
    bot.onOutbound?.((out) => {
      if (cfg().enabled === false) return
      if (!String(out?.target || '').startsWith('group:')) return
      if (!groupsOff()) return
      out.blocked = true
      out.blockReason = '群功能已关闭（owner-commands）'
    })
  },
}

/**
 * group-repeat — 复读 +1（id: 'group-repeat', order: 35）
 *
 * 规则（2026-10-31 按用户要求改）：
 *   **群里出现「+1」就点。** QQ 的 +1 是「连着两个人发了同一句话」时冒出来的按钮，
 *   所以她要做的事就是：看到别人重复了上一条 → 跟着点一下，发同一句。
 *
 *   即：上一条消息和她这条**归一化后完全相同**、且**不是同一个人**发的 →
 *   等价于群里出现了 +1 → 直接跟发（默认 100%，可调）。
 *
 * 和旧版的区别（别改回去）：
 *   · 旧版是「30 秒窗口内凑够 3 条、2 个人」再掷 35% 的骰子 —— 那不是 +1，
 *     是"过一会儿跟着复读"，用户明确否掉了。
 *   · 新版只看**连续链**：中间插一句别的就断了；同一个人连发不累加（QQ 也不给同一个人显示 +1）。
 *   · 默认 100% 命中即点；靠每群 60 秒冷却防"一条链被刷十几次她全跟"。
 *
 * 为什么挂 `passive-tap` 而不是 `wake`：
 *   +1 绝大多数发生在"没人叫她"的闲聊里，等到 wake 阶段就只剩被 @ 的那几条了。
 *   `passive-tap` 对每条过门禁的消息都跑，且 **fail-open + fire-and-forget**，不会拖慢主链路。
 *
 * 三条纪律：
 *   ① 计数只认**归一化正文**（空白/标点/全角/大小写），但跟发时发**触发那条的原文**。
 *   ② 被 @ 的那条不参与、并且**打断链**（她本来就要正常回一轮，再 +1 太吵）。
 *   ③ 冷却按群算，状态只放 `bot.state.get(chatKey)._scratch`，不开全局 Map。
 */

/** scratch 槽位名（带插件前缀，避免和其他插件抢 key）。 */
const CHAIN = 'group-repeat:chain'
const COOLDOWN = 'group-repeat:cooldown'

/**
 * 严格同字指纹（默认口径）：只去掉首尾空白和零宽字符，别的**一个字都不改**。
 *
 * 为什么不用 repeatKey：QQ 的 +1 图标只在"整句完全相同"时出现。
 * 归一化会把「笑死！！」和「笑死」当成同一句 → 她会去点，但 QQ 上根本没有那个图标。
 * 2026-11-02 主人明确要求：QQ 上出现 +1 才点。
 */
export function exactKey(text) {
  return String(text ?? '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .trim()
}

/**
 * 归一化指纹：只用于"是不是同一句话"的判断，不用于发送。
 * 比 anti-repeat 的 fingerprint 少一步"连续同字压缩"：+1 要的是同一句，
 * 「哈」和「哈哈哈」在群里通常不被当成同一条链。
 */
export function repeatKey(text) {
  let t = String(text ?? '')
  // 去 ZeroWidth / BOM 之类肉眼不可见的字符（有人靠这个让两句"看起来一样"）
  t = t.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
  // 全角 → 半角（数字/字母/标点），「ａ」和「a」、「！」和「!」算同一个
  t = t.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  t = t.toLowerCase()
  // 标点、符号、emoji、空格全去（\p{P} 标点 \p{S} 符号 \p{Z} 分隔）
  t = t.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
  return t
}

/**
 * 这条消息配不配被"复读"。
 *
 * 2026-11-01 真机事故：群友连发两张**表情包**，OneBot 把图转成占位文本 `[表情]`，
 * 归一化后两条一模一样 → 复读插件当成"同一句话"，直接跟发了一行字面量 `[表情]`
 * （群里看到的是一条写着"[表情]"的文字消息，很蠢）。
 *
 * 所以：**占位符不算一句话**。去掉 CQ 码和 `[...]` 占位后没剩真实字符的，一律不参与。
 * 句子中间带个表情（如「笑死[表情]」）仍然可以复读——去掉占位还剩"笑死"。
 */
export function isRepeatableText(text) {
  const t = String(text ?? '')
  if (!t.trim()) return false
  const cleaned = t
    .replace(/\[CQ:[^\]]*\]/g, '')     // CQ 码
    .replace(/\[[^[\]]{1,10}\]/g, '')  // [表情] [图片] [动画表情] 这类占位
    .trim()
  return cleaned.length > 0
}

/**
 * 协议端自动发的状态广播（`#sl` 的产物）。
 *
 * 2026-11-01 真机事故：群里有人敲 SnowLuma 的 `#sl`，几台机器人各自回一条
 * 一模一样的「SnowLuma 状态 / 版本: … / 运行时长: …」。这几条凑成 +1 链，
 * 她去跟发一条 → 看着像"她接了这个命令"，其实是复读。
 *
 * 判据只认**开头**：`SnowLuma 状态` / `NapCat 状态`（大小写、空格都宽）。
 * 「snowluma 这插件挺好用的」这种正常聊天不命中 —— 不能因为提到名字就不复读。
 */
export function isProtocolStatus(text) {
  return /^(snowluma|napcat)\s*状态/i.test(String(text ?? '').trim())
}

/**
 * 命令形态的消息（`/help`、`#sl`、`!xxx`、`.status`、`//办公` …）。
 *
 * 2026-11-02：群里有人发 `#sl`，两台以上机器各回一条状态（或有人跟发同一个命令）时，
 * 复读插件把它当成"同一句话"点了 +1 —— 群里看到的是她跟着回了一条 `#sl`。
 * 代码级拦截（group-command-guard）只挡"进模型"，passive-tap 阶段的复读它管不到，
 * 所以这里要按同一套前缀再挡一次。前缀表与 group-command-guard 保持一致。
 */
const COMMAND_PREFIXES = ['/', '//', '／', '#', '＃', '!', '！', '.']

export function looksLikeCommandText(text) {
  const t = String(text ?? '').trimStart()
  if (!t) return false
  return COMMAND_PREFIXES.some((p) => t.startsWith(p))
}

/**
 * 掷骰子：`percent` 百分比命中返回 true。
 * 独立导出是为了测试能用固定随机值验证边界（100% 就是 `r*100 < 100`）。
 * 100% / 0% 不消耗随机数，直接给确定结果。
 */
export function rollHit(percent, random = Math.random) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0))
  if (p <= 0) return false
  if (p >= 100) return true
  try {
    return Number(random()) * 100 < p
  } catch {
    return false
  }
}

/**
 * 推进连续链（纯函数，方便单测）。
 *
 * @param {{key:string, sender:number, streak:number, senders:number[], at:number}|null} prev 上一条链状态
 * @param {{key:string, sender:number}} cur 这一条
 * @param {number} now
 * @param {number} windowMs 两条之间最长间隔
 * @returns {{key:string, sender:number, streak:number, senders:number[], at:number}}
 */
export function advanceChain(prev, cur, now, windowMs) {
  const fresh = { key: cur.key, sender: cur.sender, streak: 1, senders: [cur.sender], at: now }
  if (!prev || prev.key !== cur.key) return fresh
  if (now - Number(prev.at || 0) > windowMs) return fresh // 隔太久，新链
  if (prev.sender === cur.sender) {
    // 同一个人连发：QQ 不会给自己显示 +1，链长度不涨，但时间要往前推
    return { key: cur.key, sender: cur.sender, streak: prev.streak, senders: prev.senders.slice(), at: now }
  }
  const senders = prev.senders.includes(cur.sender) ? prev.senders.slice() : [...prev.senders, cur.sender]
  return { key: cur.key, sender: cur.sender, streak: Number(prev.streak || 0) + 1, senders, at: now }
}

/** 取本线 scratch（懒建；`bot.state` 不可用时退化为临时对象，不影响聊天）。 */
function scratchOf(bot, chatKey) {
  const st = bot.state?.get?.(chatKey) ?? {}
  return (st._scratch ||= Object.create(null))
}

/** 秒 → 毫秒（配置里是秒；非法值走调用方给的默认值）。 */
function secToMs(value, fallbackSec) {
  const n = Number(value)
  return (Number.isFinite(n) && n >= 0 ? n : fallbackSec) * 1000
}

export default {
  id: 'group-repeat',
  title: '复读 +1',
  order: 35,

  configSchema: {
    enabled: {
      type: 'bool', default: false, group: '复读',
      label: '复读 +1',
      hint: '开：群里出现「连续同句、不同人」时，像点 QQ 的 +1 那样跟一句；关：完全不参与。',
    },
    windowSec: {
      type: 'int', default: 120, min: 5, max: 600, step: 5, unit: '秒', group: '复读',
      label: '连续链最长间隔（秒）',
      hint: '两条相同的话隔太久就不算同一条链了（默认 120 秒）。+1 本来就是连着刷才出现的。',
    },
    minCount: {
      type: 'int', default: 2, min: 2, max: 20, step: 1, group: '复读',
      label: '连续几条算 +1',
      hint: '默认 2：别人发一条、再来一个人发同一条，QQ 这时就会显示 +1，她去点。',
    },
    exactMatch: {
      type: 'bool', default: true, group: '复读',
      label: '严格同字（QQ 显示 +1 才点）',
      hint: '开：整句必须一模一样（只忽略首尾空格）——这才是 QQ 显示 +1 图标的条件；关：忽略标点/空格/全角差异（更宽松，可能 QQ 没 +1 她也跟一句）。',
    },
    minSenders: {
      type: 'int', default: 2, min: 2, max: 20, step: 1, group: '复读',
      label: '至少几个不同的人',
      hint: '同一个人自己刷同一句不算 +1（QQ 也不会给同一个人显示）。默认 2。',
    },
    repeatPercent: {
      type: 'int', default: 100, min: 0, max: 100, step: 5, unit: '%', group: '复读',
      label: '点击概率（%）',
      hint: '出现 +1 时真的点的概率。默认 100% = 看到就点；想让她偶尔才点就调低。',
    },
    cooldownSec: {
      type: 'int', default: 60, min: 0, max: 3600, step: 10, unit: '秒', group: '复读',
      label: '每群冷却（秒）',
      hint: '同一个群点过一次后，这段时间内不再点（防止一条链被刷十几次她全跟上）。默认 60 秒。',
    },
    maxChars: {
      type: 'int', default: 50, min: 5, max: 500, step: 5, unit: '字', group: '复读',
      label: '超长不跟（字）',
      hint: '超过这个字数的消息当成正文/公告，不参与复读。默认 50 字。',
    },
    ignoreProtocolStatus: {
      type: 'bool', default: true, group: '复读',
      label: '不跟协议端状态广播',
      hint: '开：群里有机器人自动回「SnowLuma 状态 / 版本 / 运行时长」这类消息时不参与复读（否则几台机器刷同一句，她会跟着抄一条）；关：照旧参与。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    bot.on('passive-tap', (ev) => {
      const c = cfg()
      if (c.enabled === false) return

      // ── 只处理群聊；私聊永不触发 ──────────────────────────────
      if (!ev?.isGroup) return
      const chatKey = String(ev.chatKey || '')
      if (!chatKey.startsWith('group:')) return

      // ── 她自己发的消息不计入（内核 normalizeEvent 已滤一次，这里再兜一层）──
      const qq = Number(ev.sender?.qq)
      if (!Number.isInteger(qq) || qq <= 0) return
      if (ev.sender?.isSelf === true) return
      const selfId = Number(bot.selfId ?? bot.napcat?.selfId)
      if (Number.isInteger(selfId) && selfId > 0 && qq === selfId) return

      const scratch = scratchOf(bot, chatKey)

      // ── 被 @ 的那条不参与，并且打断链：她本来就要正常回一轮，再 +1 太吵 ──
      if (ev.mentionedSelf === true) {
        delete scratch[CHAIN]
        return
      }

      // ── 正文门槛：空文本 / 命令形态 / 协议端状态广播 / 超长公告都不参与 ──
      const text = String(ev.text ?? '').trim()
      if (!text) return
      // 命令形态（含 `#sl`）不是聊天内容：不参与 +1，并打断链。
      if (looksLikeCommandText(text)) {
        delete scratch[CHAIN]
        return
      }
      // 协议端自动应答（`#sl` 的「SnowLuma 状态 …」）：不是人在说话，别凑成 +1。
      // 命中时还要断链 —— 免得前后两条真话被中间一串状态广播接起来。
      if (c.ignoreProtocolStatus !== false && isProtocolStatus(text)) {
        delete scratch[CHAIN]
        return
      }
      // 占位符（`[表情]` `[图片]` CQ 码…）不是"一句话"：群友连发表情包时不能跟一行字面量。
      // 同时把链打断，免得前后两条表情把链凑起来。
      if (!isRepeatableText(text)) { delete scratch[CHAIN]; return }
      const maxChars = Math.max(1, Number(c.maxChars) || 50)
      if (text.length > maxChars) return

      // 指纹：默认**严格同字**——QQ 只有"整句一模一样"才会显示那个 +1 图标，
      // 标点/空格差一点它不显示，那时她也不该点（2026-11-02 主人要求）。
      // 想放宽（忽略标点/空格/全角）把控制台「严格同字」关掉即可。
      const key = c.exactMatch === false ? repeatKey(text) : exactKey(text)
      if (!key) return // 纯标点/纯 emoji：没法定"同一句"，不跟

      const now = Date.now()
      const windowMs = secToMs(c.windowSec, 120)
      const cooldownMs = secToMs(c.cooldownSec, 60)
      const minCount = Math.max(2, Number(c.minCount) || 2)
      const minSenders = Math.max(2, Number(c.minSenders) || 2)

      // ── ① 冷却中：不计数（刚跟过一句，别连跟）───────────────
      const cd = scratch[COOLDOWN]
      if (cd && Number(cd.until) > now) return

      // ── ② 推进连续链 ────────────────────────────────────────
      const chain = advanceChain(scratch[CHAIN] || null, { key, sender: qq }, now, windowMs)
      scratch[CHAIN] = chain

      // ── ③ 门槛：连续条数够 + 不同人够 → 等于群里出现了 +1 ──────
      if (chain.streak < minCount) return
      if (chain.senders.length < minSenders) return
      if (!rollHit(c.repeatPercent)) return

      // ── ④ 先占冷却再发：失败也不重试，避免偶发失败变成连发 ──────
      scratch[COOLDOWN] = { until: now + cooldownMs, at: now }
      bot.log?.info?.(`[复读] ${chatKey}「${text}」连续 ${chain.streak} 条/${chain.senders.length} 人 → 点了 +1，冷却 ${Math.round(cooldownMs / 1000)} 秒`)
      return bot.deliver(chatKey, text, { turnCtx: null })
        .catch((e) => bot.log?.warn?.(`[复读] 跟发失败（不影响后续）：${e.message}`))
    })
  },
}

/**
 * humanizer — 拟人化（回复延迟 + 偶尔错字）
 *
 * 从 AstrBot 的 group_chat_plus 移植两项：
 *   · **回复延迟**：按字数模拟打字速度，别秒回（真人要一边想一边打）
 *   · **打字错误**：小概率随机重复一个字（真人手滑）
 *
 * 为什么单独一个子插件而不是改内核：
 *   这两项都只是「出站前改一下」，挂 `bot.onOutbound` 即可。
 *   deliver 的 decorate 钩子是 `await fn(out)` 调用的（见 kernel/state-pipeline.js），
 *   所以钩子里可以 await —— 延迟合法。
 *
 * 纪律：
 *   ① **只对"模型回复"生效**（out.turnCtx 存在）—— 命令回执、答应声、冷却提示不加，
 *      否则 `/help` 要等 1 秒、戳一戳回个「？」要等 200ms，很怪。
 *   ② **延迟封顶**：默认 4 秒。长回复不该让人等 10 秒。
 *   ③ **错字只重复一个字**，不做拼音替换（拼音库太重，且容易改出怪词）。
 *   ④ 钩子抛错不会吞话（deliver 内部 try/catch 后继续发）。
 */

export default {
  id: 'humanizer',
  title: '拟人化（回复延迟 + 偶尔错字）',
  order: 50,

  configSchema: {
    enabled: {
      type: 'bool',
      default: true,
      group: '拟人化',
      label: '启用拟人化',
      hint: '开：模型回复会按字数延迟发送、偶尔手滑打错字；关：照原样秒发。',
    },
    delayPerChar: {
      type: 'int',
      default: 90,
      min: 0,
      max: 500,
      step: 10,
      group: '拟人化',
      label: '每字延迟（毫秒）',
      hint: '按回复字数模拟打字速度。90ms/字 ≈ 每分钟 660 字。设 0 = 不延迟。',
    },
    delayMax: {
      type: 'int',
      default: 4000,
      min: 0,
      max: 30000,
      step: 500,
      group: '拟人化',
      label: '延迟上限（毫秒）',
      hint: '再长也不超过这个数。默认 4 秒。',
    },
    typoPercent: {
      type: 'int',
      default: 2,
      min: 0,
      max: 20,
      step: 1,
      group: '拟人化',
      label: '错字概率（%）',
      hint: '每条消息有百分之几的概率手滑重复一个字。默认 2%。设 0 = 不打错。',
    },
    onlyModelReply: {
      type: 'bool',
      default: true,
      group: '拟人化',
      label: '只对模型回复生效',
      hint: '开：命令回执/答应声/冷却提示照常秒发，只有模型生成的回复才延迟。建议保持开。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    bot.onOutbound(async (out) => {
      const c = cfg()
      if (c.enabled === false) return
      // 只对"模型回复"生效：命令回执没有 turnCtx
      if (c.onlyModelReply !== false && !out.turnCtx) return
      // 媒体消息不处理（图/视频延迟很奇怪）
      if (out.mode === 'media') return
      // 被前面钩子拦下的不处理
      if (out.blocked) return

      const text = String(out.text || '')
      if (!text) return

      // ── ① 错字：随机重复一个字 ──────────────────────────────
      // 按**码点**取/拼：text[i] 是 UTF-16 单元，emoji 会被切成半个代理对（发出去变乱码）。
      // Array.from 把 🌕 当一个字符，复制整颗码点，绝不落在代理对中间。
      const pct = Number(c.typoPercent ?? 2)
      const chars = Array.from(text)
      if (pct > 0 && chars.length > 3 && Math.random() * 100 < pct) {
        const i = Math.floor(Math.random() * chars.length)
        out.text = chars.slice(0, i).join('') + chars[i] + chars.slice(i).join('')
        bot.log?.debug?.(`[拟人化] 手滑：在 ${i} 处重复了一个字`)
      }

      // ── ② 延迟：按字数模拟打字 ──────────────────────────────
      const per = Number(c.delayPerChar ?? 90)
      const max = Number(c.delayMax ?? 4000)
      if (per <= 0 || max <= 0) return
      const ms = Math.min(max, String(out.text).length * per)
      if (ms > 200) {
        bot.log?.debug?.(`[拟人化] 延迟 ${ms}ms（${String(out.text).length} 字）`)
        await new Promise((r) => setTimeout(r, ms))
      }
    })

    bot.log?.info?.('[拟人化] 已挂载（延迟 + 错字）')
  },
}

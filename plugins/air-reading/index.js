/**
 * air-reading — 读空气（规则版，不调模型）
 *
 * 补 `pacing.reply` 那 9 个权重算不出来的几种情况：
 *   ① **超长消息**（>150 字）：像公告/长文，不是聊天，别接
 *   ② **连续对聊**：最近 3 条都是同一对人你来我往（没有她），别插嘴
 *   ③ **深夜**（2–6 点）：人少了，降低接话意愿（但不归零）
 *   ④ **纯转发/纯图片**：没有文字内容，没得接
 *
 * 为什么不调模型（方案 A 的代价）：
 *   子插件调模型只能走 `bot.dsh.runIsolatedTask`，它**每判断一次就建一个会话再归档**，
 *   侧栏会被大量后台会话刷脏，而且每次多 2–5 秒延迟。规则版零成本、零副作用。
 *
 * 纪律：
 *   · **只在"要回复"的时候拦**（ev.wake 有值）—— 不能拦住 @ 和私聊
 *   · **@ 她 / 私聊 / 引用她** 一律放行（这三类是明确叫她）
 *   · 拦下只设 `stopped`，不改 `wake`（不干扰别的插件判断）
 */

export default {
  id: 'air-reading',
  title: '读空气（规则版）',
  order: 90,

  configSchema: {
    enabled: {
      type: 'bool',
      default: true,
      group: '读空气',
      label: '启用读空气',
      hint: '开：补几条"这时候别接话"的规则；关：完全交给 pacing 的权重模型。',
    },
    maxChars: {
      type: 'int',
      default: 150,
      min: 50,
      max: 1000,
      step: 10,
      group: '读空气',
      label: '超长消息门槛（字）',
      hint: '超过这个字数的消息当成公告/长文，不接。默认 150。',
    },
    quietHours: {
      type: 'str',
      default: '2-6',
      group: '读空气',
      label: '深夜时段',
      hint: '形如 2-6（凌晨 2 点到 6 点），这段时间降低接话意愿。留空 = 不启用。',
    },
    quietPenalty: {
      type: 'int',
      default: 60,
      min: 0,
      max: 100,
      step: 10,
      group: '读空气',
      label: '深夜拦截比例（%）',
      hint: '深夜时段有百分之几的概率直接不接。默认 60%。',
    },
    monologueWindow: {
      type: 'int',
      default: 3,
      min: 2,
      max: 10,
      step: 1,
      group: '读空气',
      label: '连续对聊判定条数',
      hint: '最近这么多条都是同一个人/同一对人，且没有她 → 不插嘴。默认 3。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    /** 深夜判断：把 "2-6" 解析成小时集合 */
    const inQuietHours = (spec) => {
      const s = String(spec || '').trim()
      if (!s) return false
      const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(s)
      if (!m) return false
      const from = Number(m[1])
      const to = Number(m[2])
      const h = new Date().getHours()
      // 跨零点（如 22-6）
      if (from <= to) return h >= from && h < to
      return h >= from || h < to
    }

    /** 最近几条群消息（拿不到就返回空，不影响判断） */
    const recentHistory = async (groupId) => {
      try {
        if (typeof bot.napcat?.groupHistory !== 'function') return []
        const list = await bot.napcat.groupHistory(groupId, 10)
        return Array.isArray(list) ? list : []
      } catch {
        return []
      }
    }

    bot.on('wake', async (ev) => {
      const c = cfg()
      if (c.enabled === false) return
      if (ev.stopped) return

      // ── 明确叫她的一律放行：私聊 / @ 她 / 引用她 / 唤醒词 ──────────────
      // keyword 也是「有人在喊她」，深夜与连续对聊都不该拦（被她自己的唤醒词叫起来还装没听见，最假）
      const kind = ev.wake?.kind || ''
      if (kind === 'private' || kind === 'at' || kind === 'quote' || kind === 'followup' || kind === 'keyword') return
      // 入群欢迎是**合成轮**（没有正文，`wake.kind='welcome'`），不是闲聊，别按"没文字"拦掉 ——
      // 拦了新人进群她就不打招呼了（audit-group-welcome 里那条失败的用例就是这个）。
      if (kind === 'welcome') return
      // 私聊兜底（有些路径不设 wake.kind）
      if (!ev.isGroup) return
      // @ 兜底
      if (ev.mentionedSelf) return

      const stop = (why) => {
        ev.stopped = true
        ev.stopReason = `air-reading:${why}`
        bot.log?.debug?.(`[读空气] ${ev.chatKey} 不接（${why}）`)
      }

      // ── ① 超长消息：像公告，不接 ────────────────────────────
      const text = String(ev.text || '').trim()
      const maxChars = Math.max(50, Number(c.maxChars) || 150)
      if (text.length > maxChars) return stop(`too-long(${text.length})`)

      // ── ② 没有文字内容（纯图/纯表情）：没得接 ────────────────
      if (!text) return stop('no-text')

      // ── ③ 连续对聊：最近 N 条没有她，且是同一对人你来我往 ────
      //     目标：别人俩聊得热乎，别硬插嘴
      const windowN = Math.max(2, Number(c.monologueWindow) || 3)
      if (ev.groupId) {
        const hist = await recentHistory(ev.groupId)
        if (hist.length >= windowN) {
          const recent = hist.slice(-windowN)
          const selfId = String(bot.selfId || bot.napcat?.selfId || '')
          const speakers = recent.map((m) => String(m?.sender?.qq ?? m?.user_id ?? ''))
          const hasSelf = selfId && speakers.includes(selfId)
          const distinct = new Set(speakers.filter(Boolean))
          // 最近 N 条里没有她，且说话的人 <= 2 个 → 是别人在对聊
          if (!hasSelf && distinct.size <= 2 && speakers.filter(Boolean).length >= windowN) {
            return stop(`monologue(${distinct.size}人)`)
          }
        }
      }

      // ── ④ 深夜：概率性降低 ──────────────────────────────────
      const quiet = String(c.quietHours || '').trim()
      if (quiet && inQuietHours(quiet)) {
        const pct = Math.min(100, Math.max(0, Number(c.quietPenalty ?? 60)))
        if (Math.random() * 100 < pct) return stop(`quiet-hours(${quiet})`)
      }
    })

    bot.log?.info?.('[读空气] 已挂载（规则版：超长 / 纯图 / 连续对聊 / 深夜）')
  },
}

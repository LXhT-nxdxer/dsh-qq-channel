/**
 * autopilot — 自主循环（她自己的时间）
 *
 * 干什么：每隔一段时间，往 QQ 线注入一条「自由时间」提示，把她唤醒。醒来做什么由她自己决定
 * （刷东西 / 想事 / 找人说话 / 什么都不做）。
 *
 * 为什么走 `bot.dsh.prompt` 而不是 `dsh-schedule`：
 *   dsh-schedule 只能投递回「创建它的那个会话」（README 第 157 行明确写不支持跨会话投递），
 *   而我们要的恰恰是「从插件侧主动唤醒 QQ 线」。`bot.dsh` 暴露了 ensureSession + prompt，
 *   正好是「拿会话 + 往会话里塞一条消息」，且走的是真实管线（工具、人格、记忆全都正常）。
 *
 * 三条纪律：
 *   ① **别频繁**：默认 60 分钟一次。每次唤醒 = 一次真实模型调用，别几分钟一次烧钱。
 *   ② **可以先醒一次再定周期**：启动后 firstDelayMin 分钟先醒一次（方便验证是否通）。
 *   ③ **unref 定时器**：不让这个定时器拖住进程退出。
 */

export default {
  id: 'autopilot',
  title: '自主循环（她自己的时间）',
  order: 60,

  configSchema: {
    enabled: {
      type: 'bool',
      default: true,
      group: '自主循环',
      label: '启用自主循环',
      hint: '开：每隔一段时间把她唤醒，做什么由她自己决定；关：只在被 @ / 私聊时醒。',
    },
    intervalMin: {
      type: 'int',
      default: 60,
      min: 10,
      max: 720,
      step: 10,
      group: '自主循环',
      label: '间隔（分钟）',
      hint: '多久醒一次。每次唤醒 = 一次真实模型调用，别设太短。',
    },
    target: {
      type: 'str',
      default: '',
      group: '自主循环',
      label: '唤醒哪条线',
      hint: '形如 private:<QQ号> 或 group:<群号>。留空 = 自动用主人私聊（private:<adminQq>），别把号写死在仓库里。',
    },
    prompt: {
      type: 'str',
      default: '现在是你的自由时间。想干什么自己决定：刷点东西看看、想点事、找主人说两句、或者就发呆。不想说话就不说。',
      group: '自主循环',
      label: '唤醒词',
      hint: '每次唤醒时塞给她的那句话。写「做什么由你决定」，别写成具体任务。',
    },
    firstDelayMin: {
      type: 'int',
      default: 2,
      min: 0,
      max: 120,
      step: 1,
      group: '自主循环',
      label: '启动后首次延迟（分钟）',
      hint: 'DSH 启动后多久先醒一次（方便验证是否通）。设 0 = 立即醒。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    let timer = null
    let disposed = false
    let ticks = 0

    /** 目标线：配置优先；留空时自动落到主人私聊（仓库里不写死 QQ 号，`check:secrets` 才过）。 */
    // 必须放在 tick() 外面：armNext() 也要用它打日志（曾经放在 tick 里 → 启动 2 分钟后
    // 第一个 setTimeout 里抛 ReferenceError → uncaughtException → 整个 DSH 进程退出）。
    const targetOf = () => {
      const c = cfg()
      const raw = String(c.target || '').trim()
      if (raw) return raw
      const admin = Number(bot.core?.adminQq) || 0
      return admin ? `private:${admin}` : ''
    }

    const tick = async () => {
      const c = cfg()
      if (c.enabled === false) return
      try {
        const target = targetOf()
        if (!target) { bot.log?.warn?.('[自主] target 为空，跳过'); return }

        // 拿（或建）那条线的会话
        const sid = await bot.dsh?.ensureSession?.(target)
        if (!sid) { bot.log?.warn?.('[自主] 拿不到会话，跳过本轮'); return }

        const text = String(c.prompt || '').trim()
          || '现在是你的自由时间。想干什么自己决定，不想说话就不说。'

        // 往会话里塞一条（走真实管线：人格、工具、记忆都正常）
        await bot.dsh.prompt(sid, text)

        ticks += 1
        bot.log?.info?.(`[自主] 第 ${ticks} 次唤醒 ${target}（会话 ${sid}）`)
      } catch (e) {
        bot.log?.warn?.(`[自主] 唤醒失败: ${e.message}`)
      }
    }

    /**
     * 装下一次唤醒。用 setTimeout 链而不是 setInterval：
     * setInterval 的间隔在创建时就定死了，控制台把 intervalMin 热改后不生效（原来只在首 tick 后
     * reschedule 一次，之后永远按老间隔走）。现在每轮唤醒结束都按**当前配置**重新装。
     */
    const arm = (delayMs) => {
      if (disposed) return
      if (timer) { clearTimeout(timer); timer = null }
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        tick()
          .catch((e) => bot.log?.warn?.(`[自主] 唤醒失败: ${e.message}`))
          .finally(() => {
            if (disposed) return
            armNext()
          })
      }, Math.max(0, delayMs))
      timer.unref?.()   // 不拖住进程退出
    }

    /** 下一轮间隔：每次现读 intervalMin（enabled 由 tick 内部现读，所以定时器常驻）。 */
    const armNext = () => {
      const c = cfg()
      const minutes = Math.max(10, Number(c.intervalMin) || 60)
      bot.log?.info?.(`[自主] 每 ${minutes} 分钟检查一次（当前${c.enabled === false ? '已停用' : '启用'}，目标 ${targetOf() || '（未配置）'}）`)
      arm(minutes * 60_000)
    }

    const stop = () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
    // 卸载时清定时器：插件重载会叠出第二个实例，旧实例继续 tick = 双倍唤醒 + 双倍 token
    // （onDispose 是内核能力，老内核没有 → 可选调用）。
    try { bot.onDispose?.(stop) } catch { /* 老内核没有这个能力 */ }

    // 首次：启动后 firstDelayMin 分钟（这一项只在启动时读一次，之后按 intervalMin 走）
    const firstDelay = Math.max(0, Number(cfg().firstDelayMin ?? 2)) * 60_000
    arm(firstDelay)

    bot.log?.info?.(`[自主] 已挂载，${Math.round(firstDelay / 60_000)} 分钟后首次唤醒`)
  },
}

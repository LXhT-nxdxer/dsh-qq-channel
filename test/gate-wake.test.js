/**
 * test/gate-wake.test.js — gate-wake（门禁与唤醒，order 10）专属测试：只补已有套件没测的缺口。
 *
 * 本文件覆盖（都是 audit-* / integration 里找不到断言的）：
 *   · 门禁细节：通知事件(notice) 只受 ①②（群内黑名单 / 群屏蔽）管，③④（群内白名单 / 全局允许用户）
 *     这类"用户级"白名单不套在入群通知上；群内白/黑名单**只作用于本群**；JSON 对象形态与
 *     `群号:QQ,QQ;群号:QQ` 字符串形态等价；`allowedUsers` 的逗号串形态；③ 先于 ④；
 *     这些值在同一个 kernel 里热改后**下一条消息立即生效**。
 *   · groupAtRequired：默认 true = 群里必须被叫才唤醒（不 @ 不唤醒）；false = 整群当对话态；
 *     热切回 true 立即失效；宽松模式**不绕过门禁**。
 *   · 唤醒顺序细节：@本机 + 带引用但没正文 → 直接按被引内容答（不答应、不开窗），且 @ 优先于
 *     "引用的不是本机"；纯引用本机无正文 → 答应 + 开窗，补正文时把挂起的被引 id 并进来。
 *   · 唤醒词/窗口：纯呼名（名字 + 语气词/标点）→ 答应并开窗、**不参与关键词冷却**
 *     （既不被冷却挡，也不写冷却时间戳）；关键词冷却中只记日志不唤醒且不 stopped；
 *     热改冷却立即恢复；接续窗口优先于关键词唤醒。
 *   · 接续窗口（groupFollowUpMs）：续期（再接一次纯 @ 推后截止时间，且 20s 内不重复答应）、
 *     过期后不唤醒、只接一次（答完就关）、只接同一人、0 = 关窗（照样答应）。
 *   · callAck：关掉时不吭声但窗口照开；同一人 20s 内只答应一次，换人独立去重；热开立即恢复。
 *   · pokeBack：关掉时连回戳都不做；同一人 3s 内只回戳一次、换人照回；
 *     适配器 poke 返回 false / 抛错时退化成回一句话。
 *   · 私聊：空正文（只剩 @/卡片段）不唤醒；只有图也算有正文 → wake=private。
 *   · 总开关 enabled=false：@ 与戳一戳都不响应；热开立即恢复。
 *   · 唤醒词热链路：控制台写盘 + kernel.reloadConfig() 后新词立即生效、旧词失效。
 *
 * 刻意**不重复**（已由别处覆盖）：
 *   · 四级门禁优先级 黑名单>群屏蔽>群白名单>全局白名单（audit-wake-commands GATE-1）；
 *     主人白名单豁免/黑名单连主人也拦（GATE-3）；runtimeIgnore（GATE-4）；
 *     黑名单不写留档/不触发模型（GATE-2）。
 *   · @+正文唤醒、纯@答应+接续窗口、关键词唤醒、人设词与配置词合并、@别人但含唤醒词、
 *     引用本机/引用别人不越界（audit-wake-commands WAKE-A/A2/C/U/U2/S/D/E；
 *     纯@+接续全链路 integration #3）。
 *   · 戳一戳默认回戳、戳别人不理（WAKE-POKE）；撤回权限与"同一条只试一次"（WAKE-RECALL）。
 *   · 入群欢迎固定句池/模型模式/屏蔽群不欢迎（audit-group-welcome）；群命令策略（group-command-guard.test.js）。
 *   · 控制台把 gate-wake 的 configSchema 渲染成哪几组（audit-console-groups）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  bootKernel, emitRaw, tapInbound, waitFor,
  ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent, privateEvent,
} from './helpers.mjs'

const OTHER_QQ = 30001
const NEWCOMER = 40001
/** helpers.stubNapcat 里固定的本机 QQ */
const SELF_QQ = 999999
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统一装配：关掉会干扰判定的旁路插件（合批/读空气/群命令策略/拆条），tap 入站事件用。 */
async function boot(t, { gate = {}, pluginConfig = {}, config = {} } = {}) {
  const h = await bootKernel({
    config: {
      ...config,
      archive: config.archive || { enabled: false, dir: 'logs/qq_chat' },
      pacing: { merge: { enabled: false }, ...(config.pacing || {}) },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        // 读空气按真实时钟判深夜（2-6 点随机拦），不关会让"是否唤醒"随运行时间变化
        'air-reading': { enabled: false },
        // 群里不认命令是独立策略层，本文件只测门禁/唤醒
        'group-command-guard': { enabled: false },
        'gate-wake': { adminQq: ADMIN_QQ, ...gate },
        ...pluginConfig,
      },
    },
  })
  t.after(() => h.dispose())
  return { ...h, tap: tapInbound(h.kernel) }
}

const gateCfg = (h) => h.kernel.plugins.find((p) => p.id === 'gate-wake').cfg
/** 出站 wire 去掉 CQ 码后的正文（判断"回了句话"用，别把 CQ 段当正文） */
const plain = (wire) => String(wire || '').replace(/\[CQ:[^\]]*\]/g, '').trim()

/** 群里一条普通消息（不 @）。 */
function groupText(text, { id = 1, qq = MEMBER_QQ, groupId = GROUP_ID } = {}) {
  const ev = groupAtEvent({ text, at: false, userId: qq, messageId: id })
  ev.group_id = groupId
  return ev
}

/** 群里「只 @ 本机」（可带引用、可完全没文字）。 */
function atSelf({ id = 5001, qq = MEMBER_QQ, replyTo = null } = {}) {
  return groupAtEvent({ text: '', at: true, messageId: id, userId: qq, replyTo })
}

/** 群里「只引用一条消息」（不 @、没正文）。 */
function quoteOnly({ id = 5100, qq = MEMBER_QQ, replyTo = 777 } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '群友' },
    message: [{ type: 'reply', data: { id: String(replyTo) } }],
  }
}

/** 戳一戳通知（默认戳本机）。 */
function pokeNotice({ qq = MEMBER_QQ, id = 6000, target = SELF_QQ } = {}) {
  return {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: GROUP_ID,
    user_id: qq,
    message_id: id,
    target_id: target,
    sender: { user_id: qq, nickname: '群友' },
  }
}

/** 入群通知（群级 notice，正文恒为空）。 */
function increaseNotice({ qq = NEWCOMER, id = 7001 } = {}) {
  return {
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'approve',
    group_id: GROUP_ID,
    user_id: qq,
    target_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '新人' },
  }
}

/** 私聊只发一张图（没有文字）。 */
function privateImage({ qq = ADMIN_QQ, id = 6101 } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '主人' },
    message: [{ type: 'image', data: { file: 'not-downloaded.jpg' } }],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 门禁细节（四级顺序本身已在 audit-wake-commands GATE-1 测过）
// ─────────────────────────────────────────────────────────────────────────────

test('GATE-N 通知事件只受 ①② 管：③④ 用户级白名单不套在入群通知上', async (t) => {
  const h = await boot(t, {
    gate: { groupUserAllowlist: `${GROUP_ID}:${ADMIN_QQ}`, allowedUsers: [ADMIN_QQ] },
    // 欢迎插件会在 intercept 阶段就把入群通知处理掉，这里只想看门禁/唤醒怎么判
    pluginConfig: { 'group-welcome': { enabled: false } },
  })

  await emitRaw(h.kernel, increaseNotice())
  const ev = h.tap.last()
  assert.equal(
    ev.stopReason,
    'gate-wake:notice(group_increase/approve)',
    '③④ 跳过后走到唤醒阶段，被"通知一律不唤醒"停掉',
  )
  assert.equal(ev.stopped, true)
  assert.equal(ev.wake, null)
  assert.equal(h.ctx._prompts.length, 0, '通知不烧模型')

  // 但 ① 是"用户黑名单"、② 是"群屏蔽"，都是群级/用户级语义，对通知同样成立
  gateCfg(h).groupUserBlocklist = `${GROUP_ID}:${NEWCOMER}`
  await emitRaw(h.kernel, increaseNotice({ id: 7002 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:blocklist', '黑名单用户入群也被拦')

  gateCfg(h).groupUserBlocklist = ''
  gateCfg(h).ignoreGroups = [GROUP_ID]
  await emitRaw(h.kernel, increaseNotice({ id: 7003 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:ignore-group', '被屏蔽的群连入群通知也不处理')
})

test('GATE-A 群内白名单只作用于本群、JSON/字符串两种形态；③ 先于 ④', async (t) => {
  const otherGroup = GROUP_ID + 1
  const h = await boot(t, {
    gate: {
      // 只给"别的群"配了白名单（JSON 对象形态 = 旧配置写法）
      groupUserAllowlist: { [String(otherGroup)]: [ADMIN_QQ] },
      allowedUsers: String(ADMIN_QQ), // 逗号串形态（控制台写法的底层存储）
    },
  })
  const gw = gateCfg(h)

  await emitRaw(h.kernel, groupText('随便聊聊', { id: 1 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:allowed-users', '别群的白名单不影响本群，落到 ④')

  gw.groupUserAllowlist = `${GROUP_ID}:${ADMIN_QQ}` // 字符串形态（控制台存法）
  await emitRaw(h.kernel, groupText('再说一句', { id: 2 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:group-allowlist', '③ 命中就报 ③，不报 ④')

  gw.groupUserAllowlist = ''
  await emitRaw(h.kernel, groupText('又说一句', { id: 3 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:allowed-users', '③ 清空后回到 ④')

  gw.allowedUsers = [ADMIN_QQ, MEMBER_QQ]
  await emitRaw(h.kernel, groupText('现在可以说了', { id: 4 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '名单内放行 → 只是没被叫')
})

test('GATE-B 群内黑名单：JSON 对象形态与逗号串形态都对；别群不串群', async (t) => {
  const otherGroup = GROUP_ID + 1
  const h = await boot(t, { gate: { groupUserBlocklist: { [String(GROUP_ID)]: [OTHER_QQ] } } })
  const gw = gateCfg(h)

  await emitRaw(h.kernel, groupText('随便聊聊', { id: 1, qq: OTHER_QQ }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:blocklist', 'JSON 对象形态（旧配置）')

  gw.groupUserBlocklist = `${otherGroup}:${OTHER_QQ}`
  await emitRaw(h.kernel, groupText('随便聊聊', { id: 2, qq: OTHER_QQ }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '别群的黑名单不串群')

  gw.groupUserBlocklist = `${GROUP_ID}:${OTHER_QQ},${MEMBER_QQ}`
  await emitRaw(h.kernel, groupText('随便聊聊', { id: 3, qq: MEMBER_QQ }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:blocklist', '逗号串里第二个人也拦')
})

// ─────────────────────────────────────────────────────────────────────────────
// 唤醒顺序细节
// ─────────────────────────────────────────────────────────────────────────────

test('WAKE-ATQ @本机 + 带引用但没正文 → 直接按被引内容答：不答应、不开窗', async (t) => {
  const h = await boot(t)
  // 被引的是别人说的：@ 优先级最高，不因"引用的不是本机"降级
  h.kernel.napcat.msgById = async (id) => ({
    message_id: Number(id), sender: { user_id: OTHER_QQ, nickname: '别人' }, message: '别人那条',
  })

  await emitRaw(h.kernel, atSelf({ id: 5400, replyTo: 777 }))
  const ev = h.tap.last()
  assert.equal(ev.wake.kind, 'at', '纯 @ + 带引用 = 直接答（引用本身就是"我在说这条"）')
  assert.equal(ev.stopped, false)
  assert.equal(h.sent.length, 0, '不是"只喊名字"，不该发罐头话')
  await waitFor(() => h.ctx._prompts[0], { label: '@+引用进模型' })

  await emitRaw(h.kernel, groupText('紧接着补一句', { id: 5401 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '这条没开接续窗口')
})

test('WAKE-Q 纯引用本机（无正文）→ 答应一声 + 开窗；补正文沿用挂起的被引 id', async (t) => {
  const h = await boot(t)
  h.kernel.napcat.msgById = async (id) => ({
    message_id: Number(id), sender: { user_id: SELF_QQ, nickname: '测试机器人' }, message: '我上一条',
  })

  await emitRaw(h.kernel, quoteOnly({ id: 5500, replyTo: 777 }))
  const first = h.tap.last()
  assert.equal(first.stopReason, 'gate-wake:followup(纯引用(无正文))')
  assert.equal(first.stopped, true, '不进模型')
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.sent.length, 1, '先答应一声')
  assert.ok(h.sent[0].wire.includes('[CQ:reply,id=5500]'), '答应对着"只引用"那条')

  await emitRaw(h.kernel, groupText('就是这条，我说说', { id: 5501 }))
  const ev = h.tap.last()
  assert.equal(ev.wake.kind, 'followup')
  assert.equal(Number(ev.replyToId), 777, '只引用那条挂起的 replyToId 要并进补正文这条（否则被引图/内容丢）')
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: '接续进模型' })
  assert.ok(prompt.content[0].text.includes('[接上条]'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 唤醒词 / 冷却 / 窗口优先级
// ─────────────────────────────────────────────────────────────────────────────

test('WAKE-NAME 纯呼名（名字+语气词/标点）→ 答应 + 开窗；不参与冷却；窗口优先于关键词', async (t) => {
  const h = await boot(t, { gate: { keywords: '*: 小助手', keywordCooldownMs: 60000 } })

  // ① 纯呼名（别人）不写冷却时间戳：紧接着另一个人用「关键词+正文」照常能唤醒
  await emitRaw(h.kernel, groupText('小助手呀？！', { id: 5600, qq: OTHER_QQ }))
  const named = h.tap.last()
  assert.equal(named.wake, null, '剥掉唤醒词只剩语气词/标点 → 不算正文')
  assert.equal(named.stopped, true)
  assert.equal(h.sent.length, 1, '纯呼名照样答应一声')
  assert.equal(h.ctx._prompts.length, 0, '纯呼名不进模型')

  await emitRaw(h.kernel, groupText('小助手 帮我看看这个', { id: 5601, qq: MEMBER_QQ }))
  assert.equal(h.tap.last().wake.kind, 'keyword', '纯呼名没写冷却 → 关键词照常唤醒')
  await waitFor(() => h.ctx._prompts[0], { label: '关键词唤醒' })

  // ② 冷却已点亮：另一个人纯呼名仍要答应（纯呼名不参与冷却的"不被拦"）
  await emitRaw(h.kernel, groupText('小助手呀？', { id: 5602, qq: MEMBER_QQ }))
  assert.equal(h.tap.last().wake, null)
  assert.equal(h.sent.length, 2, '冷却中纯呼名也不该被挡')

  // ③ 纯呼名开的窗口优先于关键词：补正文按接续算
  await emitRaw(h.kernel, groupText('我想问问天气', { id: 5603, qq: MEMBER_QQ }))
  assert.equal(h.tap.last().wake.kind, 'followup', '接续窗口优先于关键词')
})

test('WAKE-CD 关键词冷却：冷却中只记日志不唤醒；热改冷却=0 立即恢复', async (t) => {
  const h = await boot(t, { gate: { keywords: '*: 小助手', keywordCooldownMs: 60000 } })
  const gw = gateCfg(h)

  await emitRaw(h.kernel, groupText('小助手 第一件事', { id: 5700 }))
  assert.equal(h.tap.last().wake.kind, 'keyword')
  await waitFor(() => h.ctx._prompts[0], { label: '首次命中' })

  await emitRaw(h.kernel, groupText('小助手 第二件事', { id: 5701 }))
  const blocked = h.tap.last()
  assert.equal(blocked.wake, null, '冷却中不唤醒')
  assert.equal(blocked.stopReason, 'gate-wake:keyword-cooldown')
  assert.equal(blocked.stopped, false, '只记日志：不 stopped，留给下游主动接话')
  assert.equal(h.ctx._prompts.length, 1, '冷却期不进模型')

  gw.keywordCooldownMs = 0
  await emitRaw(h.kernel, groupText('小助手 第三件事', { id: 5702 }))
  assert.equal(h.tap.last().wake.kind, 'keyword', '热改冷却 0 下一条立即生效')
  await waitFor(() => h.ctx._prompts[1], { label: '热改后再次唤醒' })
})

// ─────────────────────────────────────────────────────────────────────────────
// groupAtRequired
// ─────────────────────────────────────────────────────────────────────────────

test('GROUP-AT groupAtRequired=false = 整群当对话态；热切回立即失效；宽松不绕过门禁', async (t) => {
  const h = await boot(t)
  const gw = gateCfg(h)

  await emitRaw(h.kernel, groupText('随便聊聊今天', { id: 5800 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '默认必须被叫')

  gw.groupAtRequired = false
  await emitRaw(h.kernel, groupText('那就接着说', { id: 5801 }))
  assert.equal(h.tap.last().wake.kind, 'at', '关掉后没人叫也接话')
  await waitFor(() => h.ctx._prompts[0], { label: '宽松模式进模型' })

  gw.groupUserAllowlist = `${GROUP_ID}:${ADMIN_QQ}`
  await emitRaw(h.kernel, groupText('白名单外的人', { id: 5802 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:group-allowlist', '宽松模式不绕过门禁')

  gw.groupUserAllowlist = ''
  gw.groupAtRequired = true
  await emitRaw(h.kernel, groupText('切回来就别接了', { id: 5803 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '热切回 true 立即失效')
})

// ─────────────────────────────────────────────────────────────────────────────
// 接续窗口（groupFollowUpMs）
// ─────────────────────────────────────────────────────────────────────────────

test('WINDOW-ONCE 接续窗口只接一次：答完就关，不顺延', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, atSelf({ id: 5900 }))
  assert.equal(h.sent.length, 1, '纯 @ 先答应')

  await emitRaw(h.kernel, groupText('这么个事', { id: 5901 }))
  assert.equal(h.tap.last().wake.kind, 'followup')
  await waitFor(() => h.ctx._prompts[0], { label: '接上一次' })

  await emitRaw(h.kernel, groupText('还有下文', { id: 5902 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '窗口只接一条')
  assert.equal(h.ctx._prompts.length, 1)
})

test('WINDOW-OTHER 接续窗口只认同一人', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, atSelf({ id: 6000, qq: MEMBER_QQ }))
  assert.equal(h.sent.length, 1)

  await emitRaw(h.kernel, groupText('路过插一句', { id: 6001, qq: OTHER_QQ }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '别人补正文不算接续')

  await emitRaw(h.kernel, groupText('是我要补的', { id: 6002, qq: MEMBER_QQ }))
  assert.equal(h.tap.last().wake.kind, 'followup', '原呼叫者仍然接得上')
})

test('WINDOW-RENEW 再接一次纯 @ 会把窗口续期（20s 内不重复答应，但窗口照开）', async (t) => {
  // 注意 msOf：<1000 会被当"秒"，所以 1.2 秒窗口要写 1200
  const h = await boot(t, { gate: { groupFollowUpMs: 1200 } })

  await emitRaw(h.kernel, atSelf({ id: 6100 }))
  assert.equal(h.sent.length, 1)

  await sleep(700)
  await emitRaw(h.kernel, atSelf({ id: 6101 }))
  assert.equal(h.sent.length, 1, '同一人 20s 内不重复答应')

  // 距第一次呼叫已 1.4s > 原窗口 1.2s；距第二次 0.7s < 续期后的 1.2s
  await sleep(700)
  await emitRaw(h.kernel, groupText('现在补上正文', { id: 6102 }))
  assert.equal(h.tap.last().wake.kind, 'followup', '窗口被续期（否则这里已经过期）')
})

test('WINDOW-EXPIRE 窗口过期后补正文不唤醒', async (t) => {
  const h = await boot(t, { gate: { groupFollowUpMs: 1000 } })
  await emitRaw(h.kernel, atSelf({ id: 6200 }))
  assert.equal(h.sent.length, 1, '先答应一声')

  await sleep(1200)
  await emitRaw(h.kernel, groupText('现在才想起说正文', { id: 6201 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '超时后不算接续')
  assert.equal(h.ctx._prompts.length, 0)
})

test('WINDOW-OFF groupFollowUpMs=0：照样答应，但不开窗', async (t) => {
  const h = await boot(t, { gate: { groupFollowUpMs: 0 } })
  await emitRaw(h.kernel, atSelf({ id: 6300 }))
  assert.equal(h.sent.length, 1, '答应了')

  await emitRaw(h.kernel, groupText('那我说正文了', { id: 6301 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '0 = 不挂接续窗口')
})

// ─────────────────────────────────────────────────────────────────────────────
// callAck / pokeBack
// ─────────────────────────────────────────────────────────────────────────────

test('CALLACK-OFF callAck=false：不吭声但窗口照开；热开立即恢复答应', async (t) => {
  const h = await boot(t, { gate: { callAck: false } })
  const gw = gateCfg(h)

  await emitRaw(h.kernel, atSelf({ id: 6400 }))
  assert.equal(h.sent.length, 0, '关掉时不答应')
  assert.equal(h.tap.last().stopped, true, '仍然按"等补正文"停住')

  await emitRaw(h.kernel, groupText('那我把事说一下', { id: 6401 }))
  assert.equal(h.tap.last().wake.kind, 'followup', '窗口照开（只是不说话）')
  await waitFor(() => h.ctx._prompts[0], { label: '窗口内补正文' })

  gw.callAck = true
  await emitRaw(h.kernel, atSelf({ id: 6402, qq: OTHER_QQ }))
  assert.equal(h.sent.length, 1, '热开 callAck 后下一条立即答应')
})

test('CALLACK-DEDUPE 同一人 20s 内只答应一次；换人各自答应', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, atSelf({ id: 6500, qq: MEMBER_QQ }))
  assert.equal(h.sent.length, 1)

  await emitRaw(h.kernel, atSelf({ id: 6501, qq: MEMBER_QQ }))
  assert.equal(h.sent.length, 1, '同一人连点两下只答应一次')

  await emitRaw(h.kernel, atSelf({ id: 6502, qq: OTHER_QQ }))
  assert.equal(h.sent.length, 2, '换人独立去重')
  assert.ok(h.sent[1].wire.includes('[CQ:reply,id=6502]'), '答应对着新呼叫那条')
})

test('POKE-OFF pokeBack=false：被戳连回戳都不做；热开恢复', async (t) => {
  const h = await boot(t, { gate: { pokeBack: false } })
  const gw = gateCfg(h)
  const pokes = []
  h.kernel.napcat.poke = async (chatKey, qq) => { pokes.push({ chatKey, qq }); return true }

  await emitRaw(h.kernel, pokeNotice({ id: 6600 }))
  assert.deepEqual(pokes, [], '关掉时不回戳')
  assert.equal(h.sent.length, 0, '也不发话')
  assert.equal(h.tap.last().stopReason, 'gate-wake:poke', '戳一戳到此为止（不进模型）')

  gw.pokeBack = true
  await emitRaw(h.kernel, pokeNotice({ id: 6601 }))
  assert.equal(pokes.length, 1, '热开下一条立即回戳')
  assert.equal(h.ctx._prompts.length, 0, '戳一戳永远不进模型')
})

test('POKE-FALLBACK 适配器 poke 返回 false / 抛错 → 退化成回一句话', async (t) => {
  const h = await boot(t)
  let calls = 0
  h.kernel.napcat.poke = async () => {
    calls += 1
    if (calls === 1) return false // 本机 QQ 版本不支持 send_poke 时适配器的行为
    throw new Error('send_poke 不支持')
  }

  await emitRaw(h.kernel, pokeNotice({ qq: MEMBER_QQ, id: 6700 }))
  assert.equal(calls, 1)
  assert.equal(h.sent.length, 1, 'poke 返回 false → 回一句')
  assert.ok(plain(h.sent[0].wire).length > 0, '回的是非空一句话')

  await emitRaw(h.kernel, pokeNotice({ qq: OTHER_QQ, id: 6701 }))
  assert.equal(calls, 2)
  assert.equal(h.sent.length, 2, 'poke 抛错 → 也回一句')
  assert.equal(h.ctx._prompts.length, 0)
})

test('POKE-COOLDOWN 同一人 3s 内只回戳一次，换人照回', async (t) => {
  const h = await boot(t)
  const poked = []
  h.kernel.napcat.poke = async (chatKey, qq) => { poked.push(qq); return true }

  await emitRaw(h.kernel, pokeNotice({ qq: MEMBER_QQ, id: 6800 }))
  await emitRaw(h.kernel, pokeNotice({ qq: MEMBER_QQ, id: 6801 }))
  assert.deepEqual(poked, [MEMBER_QQ], '同一人冷却内不重复回戳')

  await emitRaw(h.kernel, pokeNotice({ qq: OTHER_QQ, id: 6802 }))
  assert.deepEqual(poked, [MEMBER_QQ, OTHER_QQ], '换人不受影响')
})

// ─────────────────────────────────────────────────────────────────────────────
// 私聊 / 总开关 / 唤醒词热链路
// ─────────────────────────────────────────────────────────────────────────────

test('PRIVATE 私聊空正文不唤醒；只有图也算有正文', async (t) => {
  const h = await boot(t)

  await emitRaw(h.kernel, privateEvent({ text: '', id: 6900 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:private-empty')
  assert.equal(h.tap.last().stopped, true)
  assert.equal(h.ctx._prompts.length, 0, '空正文不烧模型')

  await emitRaw(h.kernel, privateImage({ id: 6901 }))
  assert.equal(h.tap.last().wake.kind, 'private', '只有图也算被叫')
  await waitFor(() => h.ctx._prompts[0], { label: '私聊图片进模型' })
})

test('ENABLED 总开关关掉：@ 与戳一戳都不响应；热开立即恢复', async (t) => {
  const h = await boot(t, { gate: { enabled: false } })
  const gw = gateCfg(h)
  const poked = []
  h.kernel.napcat.poke = async (chatKey, qq) => { poked.push(qq); return true }

  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 7000 }))
  assert.equal(h.tap.last().wake, null, '关掉后 @ 也不唤醒')
  assert.equal(h.tap.last().stopped, false)
  assert.equal(h.sent.length, 0)

  await emitRaw(h.kernel, pokeNotice({ id: 7001 }))
  assert.deepEqual(poked, [], '关掉后不回戳')
  assert.equal(h.sent.length, 0, '关掉后戳一戳也不发话')

  gw.enabled = true
  await emitRaw(h.kernel, groupAtEvent({ text: '现在呢', messageId: 7002 }))
  assert.equal(h.tap.last().wake.kind, 'at', '热开立即恢复唤醒')
  await emitRaw(h.kernel, pokeNotice({ id: 7003 }))
  assert.equal(poked.length, 1, '热开立即恢复回戳')
  await waitFor(() => h.ctx._prompts[0], { label: '恢复后进模型' })
})

test('WAKE-HOT 控制台改唤醒词：写盘 + reloadConfig 后新词立即生效、旧词失效', async (t) => {
  const h = await boot(t, { gate: { keywords: '*: 小助手', keywordCooldownMs: 0 } })

  await emitRaw(h.kernel, groupText('小助手 看看这个', { id: 7100 }))
  assert.equal(h.tap.last().wake.kind, 'keyword')

  const raw = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  raw.pluginConfig['gate-wake'].keywords = '*: 新助手'
  fs.writeFileSync(h.configPath, `${JSON.stringify(raw, null, 4)}\n`)
  await h.kernel.reloadConfig()

  await emitRaw(h.kernel, groupText('小助手 还在吗', { id: 7101 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:not-woken', '旧词失效')

  await emitRaw(h.kernel, groupText('新助手 在吗', { id: 7102 }))
  assert.equal(h.tap.last().wake.kind, 'keyword', '新词立即生效')
})

/**
 * test/preset-split.test.js — 群聊 / 私聊分线 preset + 群聊工具门（纯聊天，不碰电脑）。
 *
 * 对应需求：群里任何人都能让她操作电脑（实测「E盘还有多少空间」被 shell 执行）→
 *   ① group:* 新建会话必须带 qq-chat（裁掉 shell/文件/任务/技能等工具）；
 *   ② private:<admin> 保持全局 preset（DSH 默认 = 全工具），不受影响；
 *   ③ 群聊 prompt 带硬约束（preset 没生效时的提示词兜底）；
 *   ④ tools.guard 代码级硬挡：即使老群会话还挂着 standard，非聊天/联网工具也一律拒绝。
 *
 * 全部打桩：mock sessionController / tools，不启动真 DSH 内核。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent, privateEvent,
} from './helpers.mjs'

async function boot(t, opts = {}) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      dsh: { agentPreset: '', groupAgentPreset: 'qq-chat', privateAgentPreset: '' },
    },
    ...opts,
  })
  t.after(() => h.dispose())
  return h
}

const groupKey = `group:${GROUP_ID}`
const privateKey = `private:${ADMIN_QQ}`

test('1. presetFor：group 走 groupAgentPreset，private 走 privateAgentPreset，空 = 沿用全局', async (t) => {
  const h = await boot(t)
  assert.equal(h.kernel.dsh.presetFor(groupKey), 'qq-chat')
  assert.equal(h.kernel.dsh.presetFor(privateKey), '', '私聊没配 → 沿用全局（空 = DSH 默认全工具）')
  assert.equal(h.kernel.dsh.presetFor('private:other'), '')
  // 热改配置：后续新建会话按新值走
  await h.kernel.dsh.applyConfig({ groupAgentPreset: 'chat-only', privateAgentPreset: 'standard' })
  assert.equal(h.kernel.dsh.presetFor(groupKey), 'chat-only')
  assert.equal(h.kernel.dsh.presetFor(privateKey), 'standard')
  // 群聊显式留空 = 沿用全局，而不是把空串当 preset
  await h.kernel.dsh.applyConfig({ agentPreset: 'standard', groupAgentPreset: '' })
  assert.equal(h.kernel.dsh.presetFor(groupKey), 'standard')
})

test('2. 按线建会话：群聊拿 qq-chat，私聊不带 preset（全工具）', async (t) => {
  const h = await boot(t)
  const gsid = await h.kernel.dsh.ensureSession(groupKey, '测试群')
  const psid = await h.kernel.dsh.ensureSession(privateKey, '主人')
  assert.equal(h.ctx._sessions.get(gsid).agentPreset, 'qq-chat', '群聊会话必须用纯聊天 preset')
  assert.equal(h.ctx._sessions.get(psid).agentPreset, undefined, '私聊不加 preset → 走 DSH 默认（全工具）')
})

/**
 * 真机回归（2026-11-01）：把私聊线设成 qq-chat（让她只聊天）之后，
 * 办公线 `work:` 曾经跟着继承成纯聊天 → 办公会话没有 pwsh，
 * `//c盘还有多少空间` 直接"没查出来"。
 *
 * 判据：**work 线不吃 privateAgentPreset**；默认空 = DSH 默认全工具，
 * 只有显式配 `workAgentPreset` 才裁剪。
 */
test('2b. 办公线（work:）不吃私聊 preset：私聊设成纯聊天，办公线仍然全工具', async (t) => {
  const h = await boot(t, {
    config: {
      pacing: { merge: { enabled: false } },
      dsh: { agentPreset: '', groupAgentPreset: 'qq-chat', privateAgentPreset: 'qq-chat' },
    },
  })
  const workKey = `work:${ADMIN_QQ}`
  assert.equal(h.kernel.dsh.presetFor(workKey), '', '办公线默认空 = DSH 默认全工具，不能跟着私聊变成 qq-chat')
  assert.equal(h.kernel.dsh.presetFor(privateKey), 'qq-chat', '私聊仍然纯聊天')

  const wsid = await h.kernel.dsh.ensureSession(workKey, '办公')
  assert.notEqual(h.ctx._sessions.get(wsid).agentPreset, 'qq-chat', '办公会话不能挂在纯聊天 preset 上（否则没有 pwsh）')

  // 显式配置才裁剪
  await h.kernel.dsh.applyConfig({ workAgentPreset: 'chat-only' })
  assert.equal(h.kernel.dsh.presetFor(workKey), 'chat-only', '显式配了才按配的走')
})

test('3. 私聊可单独指定 preset，且不影响群聊', async (t) => {
  const h = await boot(t, { config: {
    pacing: { merge: { enabled: false } },
    dsh: { agentPreset: '', groupAgentPreset: 'qq-chat', privateAgentPreset: 'standard' },
  } })
  const gsid = await h.kernel.dsh.ensureSession(groupKey)
  const psid = await h.kernel.dsh.ensureSession(privateKey)
  assert.equal(h.ctx._sessions.get(gsid).agentPreset, 'qq-chat')
  assert.equal(h.ctx._sessions.get(psid).agentPreset, 'standard')
})

test('4. 群聊 prompt 带硬约束；私聊 prompt 不带', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: 'e盘还有多少空间', messageId: 7101 }))
  const groupPrompt = await waitFor(() => h.ctx._prompts[0], { label: '群聊首轮 prompt' })
  const groupText = groupPrompt.content[0].text
  assert.ok(groupText.includes('[群聊硬约束'), '群聊 prompt 必须带硬约束')
  assert.match(groupText, /禁止调用任何电脑\/文件\/命令\/办公类工具/)
  assert.match(groupText, /一律说不会/)

  await emitRaw(h.kernel, privateEvent({ text: '你查下e盘空间', messageId: 7102, userId: ADMIN_QQ }))
  const privatePrompt = await waitFor(() => h.ctx._prompts[1], { label: '私聊 prompt' })
  assert.equal(privatePrompt.content[0].text.includes('[群聊硬约束'), false, '私聊不能带群聊硬约束')
})

test('5. 群聊工具门：电脑类工具一律拒；聊天/联网放行；私聊不拦', async (t) => {
  const h = await boot(t)
  const gsid = await h.kernel.dsh.ensureSession(groupKey)
  const psid = await h.kernel.dsh.ensureSession(privateKey)
  const guard = h.ctx._guards[0]
  assert.equal(typeof guard, 'function', '应注册 tools.guard 群聊工具门')
  const exec = (name, sessionId) => ({ name, agent: { session: { id: sessionId } } })

  for (const name of ['pwsh', 'bash', 'read', 'write', 'edit', 'univer_api', 'mcp__workspace_mcp__read_file', 'subagent', 'tool-web-x']) {
    assert.match(String(guard(exec(name, gsid)) || ''), /群聊模式不能调用/, `群聊必须拒绝 ${name}`)
  }
  for (const name of ['mcp__qq__send_message', 'mcp__qq__send_sticker', 'web_search', 'web_fetch']) {
    assert.equal(guard(exec(name, gsid)), undefined, `群聊应放行 ${name}`)
  }
  assert.equal(guard(exec('pwsh', psid)), undefined, '私聊线不受群聊工具门影响')
  assert.equal(guard({ name: 'pwsh', agent: { session: { id: 'web-session-1' } } }), undefined, '非 QQ 线不拦')
  assert.equal(guard({ name: 'pwsh' }), undefined, '没有 agent 的调用不拦（不误伤宿主）')
})

test('6. 老群会话（已按 standard 建好）仍被工具门挡住 —— 不依赖 preset 重建', async (t) => {
  const h = await boot(t)
  // 模拟升级前就存在的群会话：映射里先放一个用 standard 建的会话
  const legacy = await h.ctx.sessionController.create({ cwd: h.dataDir, agentPreset: 'standard' })
  h.kernel.dsh.sessions.set(groupKey, legacy.sessionId)
  assert.equal(h.kernel.dsh.sessionOf(groupKey), legacy.sessionId)
  // 新消息直接复用它（不会再建会话、不会改 preset）
  await emitRaw(h.kernel, groupAtEvent({ text: 'c盘呢', messageId: 7201 }))
  await waitFor(() => h.ctx._prompts[0], { label: '复用老会话' })
  assert.equal(h.ctx._sessions.get(legacy.sessionId).agentPreset, 'standard', '老会话 preset 不变')
  // 工具门照样按 chatKey 认线
  const guard = h.ctx._guards[0]
  assert.match(String(guard({ name: 'pwsh', agent: { session: { id: legacy.sessionId } } }) || ''), /群聊模式不能调用/)
  assert.equal(guard({ name: 'mcp__qq__send_message', agent: { session: { id: legacy.sessionId } } }), undefined)
})

test('7. 群友（非主人）在群里提问也只是普通会话 —— 群里没有人能拿到工具', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '帮我删了c盘', messageId: 7301, userId: MEMBER_QQ }))
  const sid = await waitFor(() => h.kernel.dsh.sessionOf(groupKey), { label: '建群会话' })
  assert.equal(h.ctx._sessions.get(sid).agentPreset, 'qq-chat')
  const guard = h.ctx._guards[0]
  assert.match(String(guard({ name: 'pwsh', agent: { session: { id: sid } } }) || ''), /群聊模式不能调用/)
})

test('8. preset 不可用（profile 把 qq-chat 关了/旧 bundle）→ 退回全局建会话，不哑线', async (t) => {
  const h = await boot(t)
  const origCreate = h.ctx.sessionController.create.bind(h.ctx.sessionController)
  h.ctx.sessionController.create = async (req) => {
    if (req.agentPreset === 'qq-chat') {
      const err = new Error('Unknown agent preset: qq-chat')
      err.code = 'agent-preset/not-found'
      throw err
    }
    return origCreate(req)
  }
  const sid = await h.kernel.dsh.ensureSession(groupKey)
  assert.ok(sid, '应该照样建出会话')
  assert.equal(h.ctx._sessions.get(sid).agentPreset, undefined, '退回全局 preset（不是 qq-chat）')
  // 退回全局后，工具门仍然按 group:* 硬挡
  const guard = h.ctx._guards[0]
  assert.match(String(guard({ name: 'pwsh', agent: { session: { id: sid } } }) || ''), /群聊模式不能调用/)
})

test('9. 直调 dsh.prompt（backfill/autopilot 路径）也会给群线加硬约束、且不重复', async (t) => {
  const h = await boot(t)
  const gsid = await h.kernel.dsh.ensureSession(groupKey)
  await h.kernel.dsh.prompt(gsid, '补一句群历史')
  await h.kernel.dsh.prompt(gsid, '再补一句')
  const first = h.ctx._prompts[0].content[0].text
  const second = h.ctx._prompts[1].content[0].text
  assert.ok(first.startsWith('[群聊硬约束'), '驱动层给群线 prompt 前插硬约束')
  assert.equal(second.split('[群聊硬约束').length - 1, 1, '已经带约束就不重复插')

  const psid = await h.kernel.dsh.ensureSession(privateKey)
  await h.kernel.dsh.prompt(psid, '私聊补一句')
  assert.equal(h.ctx._prompts[2].content[0].text.includes('群聊硬约束'), false, '私聊不加')
})

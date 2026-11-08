/**
 * test/admin-preset-display.test.js — 控制台显示层：**群聊线与私聊线各自的 agent preset**。
 *
 * 背景：驱动已按线选 preset（group:* → groupAgentPreset，默认 qq-chat；private:* →
 * privateAgentPreset，空 = 沿用全局 / DSH 默认），但控制台曾把两条线都回显全局
 * `dsh.agentPreset`，diagnostics 也只看全局值 → 群聊明明配了 qq-chat 仍误报「未指定 preset」。
 *
 * 本套件断言（全部打桩，不碰真 DSH / NapCat）：
 *   1. status.preset 按线输出：群聊 / 私聊可以是不同 preset；
 *   2. 配置里没写 groupAgentPreset 时，插件自举落盘 qq-chat → 面板群聊显示 qq-chat；
 *   3. 私聊线空 = 沿用全局（全局也空 → 面板显示「(默认)」）；
 *   4. diagnose 不再误报「未指定」，且群聊=qq-chat 时文案写明纯聊天（无 shell / 文件工具）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createAdminEndpoints } from '../admin/endpoints.js'
import { createConfigStore } from '../admin/store.js'
import { runDiagnostics } from '../admin/diagnostics.js'
import { bootKernel, ADMIN_QQ } from './helpers.mjs'

const quiet = () => ({ info() {}, warn() {}, error() {}, debug() {} })

async function boot(t, dsh = {}) {
  const h = await bootKernel({
    config: {
      adminQq: ADMIN_QQ,
      pacing: { merge: { enabled: false } },
      dsh,
    },
  })
  t.after(() => h.dispose())
  return h
}

function endpointsOf(h) {
  return createAdminEndpoints({
    kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null,
  })
}

async function diagnoseOf(h) {
  const store = createConfigStore({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet() })
  const result = await runDiagnostics({ kernel: h.kernel, store, log: quiet() })
  return { result, check: result.checks.find((c) => c.id === 'agentPreset') }
}

// ── 控制台 status 回显 ────────────────────────────────────────

test('status：群聊线与私聊线各显示自己的 preset（不再都回显全局）', async (t) => {
  const h = await boot(t, { agentPreset: '', groupAgentPreset: 'qq-chat', privateAgentPreset: 'standard' })
  const st = await endpointsOf(h).handle('status', {})
  assert.equal(st.ok, true)
  assert.equal(st.preset.group, 'qq-chat', '群聊线显示 groupAgentPreset')
  assert.equal(st.preset.private, 'standard', '私聊线显示 privateAgentPreset')
  assert.notEqual(st.preset.group, st.preset.private, '两条线可以不同')
  assert.equal(st.preset.builtin?.id, 'qq-chat', '内置 preset 状态照旧带回')
})

test('status：没配 groupAgentPreset 时群聊显示内置默认 qq-chat（插件启动已落盘），私聊显示「(默认)」', async (t) => {
  const h = await boot(t, { agentPreset: '' })
  // 前置：初始配置没写 groupAgentPreset，插件自举把默认值落盘（否则面板会读成空）
  const disk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(disk.dsh.groupAgentPreset, 'qq-chat', '前置：群聊线默认 preset 应落盘')
  assert.equal(disk.dsh.privateAgentPreset, '', '前置：私聊线默认空串（= 沿用全局/DSH 默认）')
  const st = await endpointsOf(h).handle('status', {})
  assert.equal(st.preset.group, 'qq-chat', '群聊线显示内置默认 qq-chat')
  assert.equal(st.preset.private, '(默认)', '私聊线留空 → 面板显示「(默认)」')
})

test('status：私聊线空 = 沿用全局值（不是空白）', async (t) => {
  const h = await boot(t, { agentPreset: 'standard', groupAgentPreset: 'qq-chat', privateAgentPreset: '' })
  const st = await endpointsOf(h).handle('status', {})
  assert.equal(st.preset.private, 'standard', '私聊线空 → 回显全局 agentPreset')
  assert.equal(st.preset.group, 'qq-chat', '群聊线不受全局影响')
})

// ── 一键诊断：按线判定 + 不再误报 ────────────────────────────

test('diagnose：群聊=qq-chat、私聊=DSH 默认 → 不再误报「未指定 preset」', async (t) => {
  const h = await boot(t, { agentPreset: '' })
  const { result, check } = await diagnoseOf(h)
  assert.ok(check, 'diagnose 应包含 agentPreset 检查项')
  assert.equal(check.ok, true, `群线已解析到 qq-chat 就不算未指定：${check.detail}`)
  assert.doesNotMatch(check.detail, /未指定 preset/, '旧的误报文案不应再出现')
  assert.match(check.detail, /群聊="qq-chat"/)
  assert.match(check.detail, /纯聊天/, '群聊=qq-chat 时要能看出是纯聊天')
  assert.match(check.detail, /无 shell \/ 文件工具/, '文案要说明裁掉了 shell / 文件工具')
  assert.match(check.detail, /私聊=DSH 默认/, '私聊留空是有意的默认，不算未指定')
  assert.equal(result.summary.fail, result.checks.filter((c) => !c.ok && c.required !== false).length,
    'summary.fail 只统计必填项失败')
})

test('diagnose：两条线各自解析（群聊 qq-chat / 私聊 standard）都出现在文案里', async (t) => {
  const h = await boot(t, { agentPreset: '', groupAgentPreset: 'qq-chat', privateAgentPreset: 'standard' })
  const { check } = await diagnoseOf(h)
  assert.equal(check.ok, true, check.detail)
  assert.match(check.detail, /群聊="qq-chat"/)
  assert.match(check.detail, /私聊="standard"/)
  assert.doesNotMatch(check.detail, /未指定 preset/)
})

test('diagnose：群聊线 preset 名字不存在时单独指出（按线校验）', async (t) => {
  // 全局 qq-chat 存在（内核能回列表），群线却填了不存在的 chat-only
  const h = await boot(t, { agentPreset: 'qq-chat', groupAgentPreset: 'chat-only', privateAgentPreset: '' })
  const { result, check } = await diagnoseOf(h)
  assert.equal(result.ok, true)
  assert.equal(check.ok, false, '群线 preset 不存在应判失败')
  assert.match(check.detail, /chat-only/)
  assert.match(check.detail, /不存在/)
  assert.equal(check.required, true, 'agentPreset 仍是必填检查项')
})

test('diagnose：群线显式留空且全局也空 → 才判「未指定」（真正的风险场景）', async (t) => {
  const h = await boot(t, { agentPreset: '', groupAgentPreset: '', privateAgentPreset: '' })
  const { check } = await diagnoseOf(h)
  assert.equal(check.ok, false, '两条线都没有可用 preset 时才失败')
  assert.match(check.detail, /未指定 preset/)
  assert.match(check.detail, /群聊线会继承 DSH profile/, '失败文案要说清群线风险')
})

test('status + diagnose 对齐：同一份配置，面板显示的群线 preset 与诊断解析一致', async (t) => {
  const h = await boot(t, { agentPreset: 'standard', groupAgentPreset: '', privateAgentPreset: '' })
  h.ctx._agentPresets.presets.push('standard') // 让宿主认识全局 standard（群聊线会沿用它）
  // 群线显式留空 = 沿用全局 standard（与驱动 presetFor 同口径）
  const st = await endpointsOf(h).handle('status', {})
  assert.equal(st.preset.group, '(默认)', '面板：群线没配自己的值 → (默认)')
  const { check } = await diagnoseOf(h)
  assert.equal(check.ok, true, '群线沿用全局 standard 可以解析，不算未指定')
  assert.match(check.detail, /群聊="standard"/, '诊断按驱动口径解析到全局值')
  assert.match(check.detail, /私聊="standard"/)
})

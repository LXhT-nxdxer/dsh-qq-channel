/**
 * test/audit-workspace-bootstrap.test.js — 「单开 QQ 工作区」自举 + 内置 qq-chat preset。
 *
 * 目标行为（对应控制台「DSH 连接」页）：
 *   1. 插件启动（= 安装后第一次加载）就按 dsh.qqWorkspacePath 创建「QQ 聊天」工作区；
 *   2. 已有同路径工作区时复用，绝不重复创建；
 *   3. 之后每条 QQ 线建会话都挂在这个工作区里（GUI 侧栏分组，不再落「未分组」）；
 *   4. 配置里没写 dsh.agentPreset 时，内置 qq-chat 存在就自动启用（纯聊天 + 联网，无 shell/文件工具）；
 *   5. 宿主缺 workspaceRegistry / agentPresets 时降级不崩（会话退回 cwd 建）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { createAdminEndpoints } from '../admin/endpoints.js'
import { defaultConfig } from '../kernel/config-store.js'
import { bootKernel, createMockCtx, emitRaw, waitFor, groupAtEvent } from './helpers.mjs'

const quiet = () => ({ info() {}, warn() {}, error() {}, debug() {} })

async function boot(t, opts = {}) {
  const h = await bootKernel(opts)
  t.after(() => h.dispose())
  return h
}

test('默认配置：私聊 preset 留空（全工具）、群聊 preset = qq-chat、工作区名称 = 「QQ 聊天」', () => {
  const cfg = defaultConfig()
  assert.equal(cfg.dsh.agentPreset, '', '私聊线不能默认套纯聊天：主人要能让她干活')
  assert.equal(cfg.dsh.groupAgentPreset, 'qq-chat', '群聊线默认纯聊天')
  assert.equal(cfg.dsh.workspaceTitle, 'QQ 聊天')
  assert.equal(cfg.dsh.qqWorkspacePath, 'workspace')
})

test('工作区自举：没有已注册工作区时按路径创建「QQ 聊天」（幂等）', async (t) => {
  // 自定义 ctx 且不给 workspacePath → 夹具注册表为空，走真正的 create 分支
  const ctx = createMockCtx({})
  const h = await boot(t, { ctx })

  const ws = h.kernel.qqWorkspace
  assert.ok(ws?.id, '应记录 QQ 工作区 id')
  assert.equal(ws.title, 'QQ 聊天')
  assert.equal(path.resolve(ws.path), path.resolve(h.dataDir, 'workspace'))
  assert.equal(ws.created, true, '首次应为创建')
  assert.equal(h.ctx._workspaceRegistry.created.length, 1, '只创建一个工作区')

  // 再跑一次：复用同一个，不重复创建
  const again = await h.kernel.ensureQqWorkspace()
  assert.equal(again.created, false)
  assert.equal(again.id, ws.id)
  assert.equal(h.ctx._workspaceRegistry.created.length, 1, '幂等：不重复创建')
})

test('工作区自举：已注册同路径工作区时复用（不重复创建）', async (t) => {
  const h = await boot(t) // 夹具默认已注册 ws-qq → <dataDir>/workspace
  assert.equal(h.kernel.qqWorkspace.created, false)
  assert.equal(h.kernel.qqWorkspace.id, 'ws-qq')
  assert.equal(h.ctx._workspaceRegistry.created.length, 0)
})

test('QQ 会话挂进自举工作区（建会话带 workspaceId，群聊线带 qq-chat）', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: 'ping' }))
  const session = await waitFor(() => [...h.ctx._sessions.values()][0], { label: '创建 QQ 会话' })
  assert.equal(session.workspaceId, h.kernel.qqWorkspace.id, '会话应挂在 QQ 工作区里')
  assert.equal(session.agentPreset, 'qq-chat', '群聊线会话应带内置纯聊天 preset')
  assert.equal(h.kernel.runtime.dsh.groupAgentPreset, 'qq-chat', '群聊线默认 preset 落进 runtime')
  assert.equal(h.kernel.runtime.dsh.agentPreset, '', '私聊线全局 preset 保持空（DSH 默认 = 全工具）')
})

test('群聊 preset 留空（未配置）时自动启用内置 qq-chat（并落盘）', async (t) => {
  const h = await boot(t, { config: { dsh: { agentPreset: '' } } })
  assert.equal(h.kernel.runtime.dsh.groupAgentPreset, 'qq-chat', '只给群聊线补默认')
  assert.equal(h.kernel.runtime.dsh.agentPreset, '', '私聊线不能被一起切成纯聊天')
  const disk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(disk.dsh.groupAgentPreset, 'qq-chat', '应落盘，否则控制台面板显示为空')
  assert.equal(disk.dsh.agentPreset, '', '全局 preset 保持用户配置')
})

test('宿主没有 qq-chat preset 时：不写配置，建会话自动退回全局（工具门兜底）', async (t) => {
  const ctx = createMockCtx({ presets: [] })
  // 默认配置里 groupAgentPreset 就是 qq-chat，这里显式留空，才走到"宿主探测不到 preset"的分支
  const h = await boot(t, { ctx, config: { dsh: { agentPreset: '', groupAgentPreset: '' } } })
  assert.equal(h.kernel.runtime.dsh.agentPreset, '')
  assert.notEqual(h.kernel.runtime.dsh.groupAgentPreset, 'qq-chat', '探测不到 preset 就不自动填成 qq-chat')
  // 真实宿主里 create 会抛 agent-preset/not-found；这里打桩复现，验证驱动退回全局而不是哑线
  const origCreate = ctx.sessionController.create.bind(ctx.sessionController)
  ctx.sessionController.create = async (req) => {
    if (req.agentPreset === 'qq-chat') {
      const err = new Error('Unknown agent preset: qq-chat')
      err.code = 'agent-preset/not-found'
      throw err
    }
    return origCreate(req)
  }
  await emitRaw(h.kernel, groupAtEvent({ text: 'ping' }))
  const session = await waitFor(() => [...h.ctx._sessions.values()][0], { label: '降级建群会话' })
  assert.equal(session.agentPreset, undefined, 'preset 不存在时群聊退回全局建会话')
})

test('宿主缺 workspaceRegistry / agentPresets 时降级不崩（会话退回 cwd 建）', async (t) => {
  const ctx = createMockCtx({})
  const origGet = ctx.get
  ctx.get = (name) => (name === 'workspaceRegistry' || name === 'agentPresets' ? undefined : origGet(name))
  const h = await boot(t, { ctx })

  assert.equal(h.kernel.qqWorkspace, undefined, '没有注册表就不记录工作区')
  assert.equal(h.kernel.runtime.dsh.agentPreset, '', '探测不到 preset 就留空')
  await emitRaw(h.kernel, groupAtEvent({ text: 'ping' }))
  const session = await waitFor(() => [...h.ctx._sessions.values()][0], { label: '降级建会话' })
  assert.equal(session.workspaceId, undefined, '没有工作区时退回 cwd')
  assert.ok(session.cwd, '应带 cwd 建会话')
})

test('控制台动作 ensure-workspace：幂等返回工作区信息', async (t) => {
  const ctx = createMockCtx({})
  const h = await boot(t, { ctx })
  const endpoints = createAdminEndpoints({
    kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null,
  })
  const first = await endpoints.handle('action', { id: 'ensure-workspace' })
  assert.equal(first.ok, true)
  assert.equal(first.workspace.created, false, '启动时已创建 → 动作应是复用')
  assert.match(first.message, /已就绪/)
})

test('宿主依赖自检：必需项全绿 + 可选项明细（「安装即用」）', async (t) => {
  const h = await boot(t)
  const r = await h.kernel.checkHostDeps()
  assert.equal(r.ok, true)
  const byId = Object.fromEntries(r.items.map((it) => [it.id, it]))
  for (const id of ['sessionController', 'tools', 'dataDirWritable']) {
    assert.equal(byId[id].ok, true, `${id} 应就绪`)
  }
  assert.equal(byId['preset:qq-chat'].ok, true, '内置 preset 应已注册')
  assert.equal(byId.qqWorkspace.ok, true, '工作区应已自举')
  assert.ok(r.env.dataDir && r.env.node, '应带环境信息')
})

test('宿主依赖自检：缺可选服务时不算硬失败，但给出修复建议', async (t) => {
  const ctx = createMockCtx({})
  const orig = ctx.get
  ctx.get = (name) => (name === 'workspaceRegistry' || name === 'agentPresets' ? undefined : orig(name))
  const h = await boot(t, { ctx })
  const r = await h.kernel.checkHostDeps()
  assert.equal(r.ok, true, '可选服务缺失不应判硬失败')
  const byId = Object.fromEntries(r.items.map((it) => [it.id, it]))
  assert.equal(byId.workspaceRegistry.ok, false)
  assert.ok(byId.workspaceRegistry.hint.length > 0, '应给出安装建议')
  assert.equal(byId['preset:qq-chat'].ok, null, '探测不到服务时记 null（不谎报）')
})

test('控制台动作 check-host-deps：返回明细与结论', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({
    kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null,
  })
  const r = await endpoints.handle('action', { id: 'check-host-deps' })
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.items) && r.items.length >= 6, '应有逐项明细')
  assert.match(r.message, /运行环境就绪/)
})

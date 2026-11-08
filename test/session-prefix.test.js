/**
 * test/session-prefix.test.js — 会话级静态前缀（L1 常驻层）+ memory 注入降级。
 *
 * 盯的是「记忆 L1 常驻」的四条硬要求：
 *   ① 前缀只生成一次：同一份内容重复执行 pre-step 不产生第二条消息；
 *   ② 内容变了才刷新：provider 版本变了，下一次有用户消息的 pre-step 追加一条"更新"（只带变化段）；
 *   ③ 重复执行不叠加：冷启动重扫会话历史 / 压缩把前缀挤掉后的重注，都不会出现两份同样内容；
 *   ④ hint 不重复塞：已进前缀的 fact id 从 before-turn 的 hint 里排除。
 *
 * 不启动真 DSH / NapCat：用假 ctx + 假 agent.session 调驱动挂在 `agent/pre-step` 上的监听器，
 * 形状照 `@deepseek-ai/dsh-agent` 的事件签名（waterfall：listener(payload, next)）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDshDriver } from '../kernel/dsh-driver.js'
import plugin from '../plugins/memory/index.js'
import { createMemoryStore, charLength, PREFIX_HEADER } from '../plugins/memory/store.js'
import { withDefaults } from '../contracts.js'

const GROUP = 'group:20001'
const PRIVATE = 'private:10001'
const SID = 'mock-session-1'

/** 可被驱动 pre-step 读写的假 agent.session（surface.nodes + eventAt + append）。 */
function makeSession(id = SID) {
  const events = []
  const session = {
    id,
    events,
    surface: { nodes: [] },
    eventAt(seq) { return events[seq] },
    /** 模拟内核 step() 把 decision.messages 落进历史（append + session/event）。 */
    append(event) {
      const withSeq = { ...event, seq: events.length }
      events.push(withSeq)
      session.surface.nodes.push(withSeq.seq)
      return withSeq
    },
  }
  return session
}

/** 模拟内核压缩：旧节点被 replacement 顶掉（surface 只剩 replacement）。 */
function replaceSurface(session, shadowedSeqs, replacement) {
  session.surface.nodes = session.surface.nodes.filter((seq) => !shadowedSeqs.includes(seq))
  session.surface.nodes.push(replacement.seq)
}

/** 最小假 Cordis ctx：只模拟驱动用到的服务面（事件订阅 / sessionController / get）。 */
function makeCtx() {
  const listeners = new Map()
  let seq = 0
  const created = []
  const ctx = {
    get() { return null },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const list = listeners.get(event) || []
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    },
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) || [])]) fn(...args)
    },
    sessionController: {
      async create(req) {
        const id = `mock-session-${++seq}`
        created.push({ ...req, id })
        return { sessionId: id }
      },
      async prompt() { return { accepted: true } },
      async list() { return { items: [] } },
      async rename() { return { title: '', seq: 0 } },
      async cancel() { return { accepted: true } },
      async inspect() { return { events: [] } },
    },
    _listeners: listeners,
    _created: created,
  }
  return ctx
}

function makeLog() {
  const lines = []
  const push = (level) => (m) => lines.push(`${level} ${m}`)
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/** 建驱动 + 一个已映射的 QQ 会话；返回驱动、ctx、log 和调 pre-step 的便捷函数。 */
async function makeDriver(tag, { chatKey = GROUP } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qq-prefix-${tag}-`))
  const ctx = makeCtx()
  const log = makeLog()
  const driver = createDshDriver({
    ctx,
    log,
    sessionsFile: path.join(root, 'sessions.json'),
    workspacePath: root,
    state: { get: () => ({}) },
  })
  const sessionId = await driver.ensureSession(chatKey)
  const session = makeSession(sessionId)

  /** 调驱动挂上的 agent/pre-step（waterfall：必须先 next() 拿默认 decision，再让驱动改）。 */
  async function preStep({ messages = [], step = 1 } = {}) {
    const handler = (ctx._listeners.get('agent/pre-step') || [])[0]
    assert.ok(handler, '驱动必须挂 agent/pre-step')
    let nextCalled = false
    const claimed = messages.map((m) => ({ ...m }))
    const decision = await handler(
      { agent: { session }, messages: claimed, turn: 1, step, signal: { aborted: false } },
      async () => { nextCalled = true; return { kind: 'enter', messages: claimed } },
    )
    return { decision, nextCalled }
  }

  /** 把 decision 里的消息按内核 step() 的方式落进历史，并通知 session/event。 */
  function commit(decision) {
    for (const message of decision.messages) {
      const event = session.append({ type: 'user/message', time: Date.now(), data: message })
      ctx.emit('session/event', session, event)
    }
    return decision
  }

  const userMsg = (text = '在吗') => ({ id: `u-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  return { root, ctx, log, driver, sessionId, session, preStep, commit, userMsg }
}

/** 假记忆 provider：text 由外部变量控制，version 显式给。 */
function makeProvider(store = { text: '[长期记忆·事实]\n- 主人喜欢喝美式咖啡', version: 'v1', order: 10 }) {
  const calls = []
  return {
    calls,
    def: {
      id: 'memory',
      order: store.order,
      provide(chatKey) {
        calls.push(chatKey)
        return store.off ? null : { text: store.text, version: store.version }
      },
    },
    store,
  }
}

// ── ① 前缀只生成一次 ─────────────────────────────────────────
test('前缀：第一次 pre-step 注入一条持久消息（在用户消息之前），内容不变再跑不产生第二条', async () => {
  const h = await makeDriver('once')
  const p = makeProvider()
  h.driver.registerPrefixProvider(p.def)

  const first = await h.preStep({ messages: [h.userMsg('第一句')] })
  assert.equal(first.nextCalled, true, '必须先把 next() 走完（不截断别的 pre-step 钩子）')
  assert.equal(first.decision.messages.length, 2, '前缀 + 用户消息')
  const prefix = first.decision.messages[0]
  assert.equal(prefix.role, 'user')
  assert.equal(prefix.source.kind, 'qq-session-prefix')
  assert.deepEqual(prefix.source.parts, { memory: 'v1' })
  assert.match(prefix.content[0].text, /主人喜欢喝美式咖啡/, '前缀里是 provider 的稳定文本')
  assert.match(prefix.content[0].text, /不是对方刚说的话/, '必须标明不是对方刚说的话')
  assert.equal(first.decision.messages[1].content[0].text, '第一句', '用户消息仍在最后')
  h.commit(first.decision)

  // 同一份内容再跑：不注入
  const second = await h.preStep({ messages: [h.userMsg('第二句')] })
  assert.equal(second.decision.messages.length, 1, '内容没变就不重建')
  assert.equal(second.decision.messages[0].content[0].text, '第二句')
  assert.equal(h.log.lines.filter((l) => l.includes('[前缀]') && l.includes('注入')).length, 1, '只注入一次')
})

test('前缀：provider 返回同一版本时，冷启动重扫历史也不会重复注入（幂等）', async () => {
  const h = await makeDriver('cold')
  const p = makeProvider()
  h.driver.registerPrefixProvider(p.def)
  h.commit((await h.preStep({ messages: [h.userMsg('第一句')] })).decision)
  const historyEvents = [...h.session.events]

  // 新进程：新驱动（同一份会话映射）+ 从历史重放出来的同一会话
  const ctx2 = makeCtx()
  const root2 = h.root
  const driver2 = createDshDriver({
    ctx: ctx2,
    log: makeLog(),
    sessionsFile: path.join(root2, 'sessions.json'),
    workspacePath: root2,
    state: { get: () => ({}) },
  })
  const replay = makeSession(h.sessionId)
  for (const ev of historyEvents) replay.append({ type: ev.type, data: ev.data })
  driver2.registerPrefixProvider(makeProvider().def)
  const handler = (ctx2._listeners.get('agent/pre-step') || [])[0]
  const claimed = [h.userMsg('第二句')]
  const decision = await handler(
    { agent: { session: replay }, messages: claimed, turn: 2, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.equal(decision.messages.length, 1, '历史里已有同版本前缀 → 不再注入')
  driver2.close()
})

// ── ② 内容变了才刷新 ─────────────────────────────────────────
test('前缀：版本变了 → 下一次回复前刷新一次（只带变化段），之后同版本不再发', async () => {
  const h = await makeDriver('refresh')
  const a = makeProvider({ text: '[事实A]\n- A 内容', version: 'a1' })
  const b = makeProvider({ text: '[事实B]\n- B 内容', version: 'b1', order: 20 })
  b.def.id = 'diary'
  h.driver.registerPrefixProvider(a.def)
  h.driver.registerPrefixProvider(b.def)
  h.commit((await h.preStep({ messages: [h.userMsg('第一句')] })).decision)

  // 只有 A 变了
  a.store.version = 'a2'
  a.store.text = '[事实A]\n- A 内容（新版）'
  const updated = await h.preStep({ messages: [h.userMsg('第二句')] })
  assert.equal(updated.decision.messages.length, 2, '变化 → 追加一条更新')
  const update = updated.decision.messages[0]
  assert.match(update.content[0].text, /有更新/, '更新段要明确写"以本段为准"')
  assert.match(update.content[0].text, /A 内容（新版）/)
  assert.equal(update.content[0].text.includes('B 内容'), false, '没变的段不重发')
  assert.deepEqual(update.source.parts, { memory: 'a2', diary: 'b1' }, '版本表合并（A 新、B 旧）')
  h.commit(updated.decision)

  const quiet = await h.preStep({ messages: [h.userMsg('第三句')] })
  assert.equal(quiet.decision.messages.length, 1, '同一版本不再发')
})

test('前缀：一路重复执行不叠加（10 次同版本 pre-step 只留 1 条前缀消息）', async () => {
  const h = await makeDriver('stack')
  h.driver.registerPrefixProvider(makeProvider().def)
  for (let i = 0; i < 10; i += 1) h.commit((await h.preStep({ messages: [h.userMsg(`第${i}句`)] })).decision)
  const prefixEvents = h.session.events.filter((ev) => ev.data?.source?.kind === 'qq-session-prefix')
  assert.equal(prefixEvents.length, 1, `实际 ${prefixEvents.length} 条`)
})

// ── ③ 压缩 / 边界 ───────────────────────────────────────────
test('前缀：被压缩挤掉后能检测到，并在下一轮重注一次（内容不变也不丢）', async () => {
  const h = await makeDriver('compact')
  h.driver.registerPrefixProvider(makeProvider().def)
  h.commit((await h.preStep({ messages: [h.userMsg('第一句')] })).decision)
  const prefixSeq = h.session.events.find((ev) => ev.data?.source?.kind === 'qq-session-prefix').seq

  // 模拟压缩：replacement user/message 顶掉 [prefix, 第一句]
  const replacement = h.session.append({
    type: 'user/message',
    data: { id: 'compact-1', role: 'user', content: [{ type: 'text', text: '（压缩摘要）' }], source: { kind: 'user' } },
  })
  // 驱动看到的 session/event 带 sourceEventSeqs（内核压缩事件就是这个形状）
  const replacementWithSources = { ...replacement, sourceEventSeqs: [prefixSeq, 1], surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }
  replaceSurface(h.session, [prefixSeq, 1], replacementWithSources)
  h.ctx.emit('session/event', h.session, replacementWithSources)

  const again = await h.preStep({ messages: [h.userMsg('第二句')] })
  assert.equal(again.decision.messages.length, 2, '前缀没了 → 重注')
  assert.match(again.decision.messages[0].content[0].text, /主人喜欢喝美式咖啡/)
  assert.equal(again.decision.messages[0].content[0].text.includes('有更新'), false, '重注的是完整前缀，不是更新段')
})

test('前缀：工具循环中间步（没有用户消息）不插前缀；非 QQ 会话完全不动', async () => {
  const h = await makeDriver('scope')
  h.driver.registerPrefixProvider(makeProvider().def)
  const toolStep = await h.preStep({ messages: [] })
  assert.equal(toolStep.decision.messages.length, 0, '没有用户消息的步不注入')

  const other = makeSession('web-session-1')
  const handler = (h.ctx._listeners.get('agent/pre-step') || [])[0]
  const claimed = [h.userMsg('网页的话')]
  const decision = await handler(
    { agent: { session: other }, messages: claimed, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.equal(decision.messages.length, 1, '不是 QQ 会话 → 不碰')
})

test('前缀：总预算硬截断；provider 抛错 fail-open 不影响本轮', async () => {
  const h = await makeDriver('budget')
  h.driver.registerPrefixProvider({
    id: 'huge',
    provide: () => ({ text: `[大块]\n- ${'甲'.repeat(3000)}`, version: 'v1' }),
  })
  h.driver.registerPrefixProvider({ id: 'broken', provide: () => { throw new Error('boom') } })
  const r = await h.preStep({ messages: [h.userMsg('第一句')] })
  assert.equal(r.decision.messages.length, 2, '坏 provider 不挡注入')
  const text = r.decision.messages[0].content[0].text
  assert.ok(charLength(text) < 1900, `总预算应守住（实际 ${charLength(text)} 字）`)
  assert.ok(text.includes('…'), '超预算要有截断标记')
  assert.match(h.log.lines.join('\n'), /broken.*失败/, '坏 provider 要留 warn')
})

// ── ④ hint 不重复塞（memory 插件联动）────────────────────────
const DAY = 24 * 60 * 60 * 1000

function makeMemoryHarness(tag, { overrides = {}, withPrefixApi = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `qq-prefix-mem-${tag}-`))
  const cfg = withDefaults(plugin.configSchema, {
    enabled: true,
    dir: path.join(dataDir, 'facts'),
    ...overrides,
  })
  const hooks = new Map()
  const disposers = []
  const providers = new Map()
  const bot = {
    id: 'memory',
    cfg,
    core: { dataDir },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(stage, fn) {
      if (!hooks.has(stage)) hooks.set(stage, [])
      hooks.get(stage).push(fn)
    },
    registerTool() {},
    onDispose(fn) { disposers.push(fn) },
    currentTurn: () => ({ chatKey: GROUP }),
  }
  if (withPrefixApi) {
    bot.dsh = {
      registerPrefixProvider(def) {
        providers.set(def.id, def)
        return () => providers.delete(def.id)
      },
    }
  } else {
    bot.dsh = { ensureSession() {}, rename() {}, cancel() {} }
  }
  plugin.setup(bot)
  const store = createMemoryStore({ file: path.join(dataDir, 'facts', 'items.json') })
  return { bot, cfg, hooks, providers, disposers, store }
}

test('memory：已进前缀的事实不再进 hint，前缀外的事实仍按需进 hint', () => {
  const h = makeMemoryHarness('dedupe', { overrides: { injectMaxItems: 1 } })
  h.store.add('主人喜欢喝美式咖啡，不加糖', { chatKey: GROUP, importance: 5 })
  h.store.add('周末要去爬香山', { chatKey: GROUP, importance: 2 })

  const provider = h.providers.get('memory')
  assert.ok(provider, 'memory 应注册前缀 provider')
  const block = provider.provide(GROUP)
  assert.deepEqual(block.text.includes('美式咖啡'), true, '重要度最高的进前缀')
  assert.equal(block.text.includes('香山'), false, 'maxItems=1 时另一条不进前缀')
  assert.match(block.text, new RegExp(PREFIX_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const ev = { chatKey: GROUP, text: '香山好玩吗', wake: { kind: 'at' }, hint: [], stopped: false }
  h.hooks.get('before-turn')[0](ev)
  assert.equal(ev.hint.length, 1, '前缀外的事实仍进 hint')
  assert.match(ev.hint[0], /香山/)
  assert.equal(ev.hint[0].includes('美式咖啡'), false, '前缀里的事实不再进 hint（不付两遍）')

  // 前缀里的事实被问到：hint 里不能再出现它（它已经在会话历史里）；没进前缀的那条按旧逻辑兜底
  const ev2 = { chatKey: GROUP, text: '我喜欢喝什么咖啡', wake: { kind: 'at' }, hint: [], stopped: false }
  h.hooks.get('before-turn')[0](ev2)
  assert.equal(ev2.hint.join('').includes('美式咖啡'), false, '前缀内事实不再进 hint（不付两遍）')
})

test('memory：没有前缀能力（老内核）/配置关掉前缀 → 退回每轮全量 hint', () => {
  const noApi = makeMemoryHarness('noapi', { withPrefixApi: false })
  noApi.store.add('主人喜欢喝美式咖啡，不加糖', { chatKey: GROUP, importance: 5 })
  const ev = { chatKey: GROUP, text: '咖啡', wake: { kind: 'at' }, hint: [], stopped: false }
  noApi.hooks.get('before-turn')[0](ev)
  assert.equal(ev.hint.length, 1, '老内核：照旧每轮注入')
  assert.match(ev.hint[0], /美式咖啡/)

  const off = makeMemoryHarness('off', { overrides: { prefixEnabled: false } })
  off.store.add('主人喜欢喝美式咖啡，不加糖', { chatKey: GROUP, importance: 5 })
  assert.equal(off.providers.get('memory').provide(GROUP), null, '关掉前缀 → provider 不提供')
  const ev2 = { chatKey: GROUP, text: '咖啡', wake: { kind: 'at' }, hint: [], stopped: false }
  off.hooks.get('before-turn')[0](ev2)
  assert.match(ev2.hint[0], /美式咖啡/, '关掉后 hint 恢复全量')
})

test('memory：稳定块确定性（同状态同版本、增事实就换版本、归档不进前缀）', () => {
  const h = makeMemoryHarness('stable')
  const a = h.store.add('A 事实', { chatKey: GROUP, importance: 3 })
  h.store.add('B 事实', { chatKey: GROUP, importance: 5 })
  const first = h.store.buildStableInjection({ chatKey: GROUP })
  const second = h.store.buildStableInjection({ chatKey: GROUP })
  assert.equal(first.text, second.text)
  assert.equal(first.version, second.version, '同状态版本必须稳定')
  assert.ok(first.text.indexOf('B 事实') < first.text.indexOf('A 事实'), '重要度高的排前面')
  assert.deepEqual(first.ids.length, 2)

  h.store.add('C 事实', { chatKey: GROUP, importance: 1, at: Date.now() - 400 * DAY })
  const changed = h.store.buildStableInjection({ chatKey: GROUP })
  assert.notEqual(changed.version, first.version, '内容变了版本必须变')

  // 归档的不进前缀（软删除只降权，不再占常驻位）
  h.store.prune({ threshold: 0.2, minAgeDays: 0 })
  const after = h.store.buildStableInjection({ chatKey: GROUP })
  assert.equal(after.text.includes('C 事实'), false, '归档条目不进前缀')
})

test('memory：前缀总预算遵守 800 字（store 层）+ provider 版本随内容变化', () => {
  const h = makeMemoryHarness('budget')
  for (let i = 0; i < 12; i += 1) {
    h.store.add(`第${i}条：${'乙'.repeat(90)}`, { chatKey: GROUP, importance: 5 })
  }
  const block = h.store.buildStableInjection({ chatKey: GROUP, maxChars: 800, maxItems: 18 })
  assert.ok(charLength(block.text) <= 800, `实际 ${charLength(block.text)} 字`)
  assert.ok(block.text.endsWith('…'), '超预算带截断标记')
  assert.ok(block.ids.length < 12, '截断的条目不算"已在前缀里"')
})

// ── ⑤ 真装配：bot.dsh 通路 + pre-step 钩子确实挂上 ─────────────
test('装配：真 apply() 下 memory 的 provider 经驱动 pre-step 注入一条前缀消息（端到端）', async (t) => {
  const { bootKernel } = await import('./helpers.mjs')
  const h = await bootKernel({
    config: { pluginConfig: { memory: { enabled: true, prefixEnabled: true } } },
  })
  t.after(() => h.dispose())

  const status = h.kernel.dsh.prefixStatus()
  assert.deepEqual(status.providers.map((p) => p.id), ['memory'], `实际 ${JSON.stringify(status.providers)}`)
  assert.ok((h.ctx._listeners.get('agent/pre-step') || []).length >= 1, '驱动必须挂 pre-step 钩子')
  assert.ok(status.maxChars >= 800)

  // 直接落一条事实（memory 的 store 是懒加载的，setup 时还没读盘）
  const fact = {
    id: 'm-test-1', text: '主人喜欢喝美式咖啡，不加糖', source: 'test', chatKey: GROUP,
    at: Date.now(), importance: 5, hits: 0, lastHitAt: Date.now(), archived: false, archivedAt: null,
  }
  const memFile = path.join(h.dataDir, 'state', 'memory', 'items.json')
  fs.mkdirSync(path.dirname(memFile), { recursive: true })
  fs.writeFileSync(memFile, JSON.stringify({ version: 1, updatedAt: '', items: [fact] }))

  const sid = await h.kernel.dsh.ensureSession(GROUP)
  const session = makeSession(sid)
  const claimed = [{ id: 'u-e2e', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } }]
  const handler = (h.ctx._listeners.get('agent/pre-step') || [])[0]
  const decision = await handler(
    { agent: { session }, messages: claimed, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.equal(decision.messages.length, 2, '端到端应注入前缀')
  assert.match(decision.messages[0].content[0].text, /美式咖啡/)
  assert.equal(decision.messages[0].source.kind, 'qq-session-prefix')
  assert.match(decision.messages[0].content[0].text, /长期记忆·常驻事实/)
})

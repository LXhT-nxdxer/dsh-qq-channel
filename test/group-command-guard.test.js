/**
 * test/group-command-guard.test.js — 群里不认命令。
 *
 * 需求：群里**任何人**发任何命令形态的消息，她都不响应、不回一个字。
 * 私聊不受影响（主人私聊的 /命令、//办公 照常）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import plugin, { looksLikeCommand } from '../plugins/group-command-guard/index.js'
import { withDefaults } from '../contracts.js'

function makeBot(overrides = {}) {
  const cfg = withDefaults(plugin.configSchema, { enabled: true, ...overrides })
  const handlers = []
  const delivered = []
  const bot = {
    id: plugin.id,
    cfg,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    on(stage, fn, opts) { handlers.push({ stage, fn, opts }) },
    deliver: async (target, text) => { delivered.push({ target, text }) },
    state: { get: () => ({}) },
  }
  plugin.setup(bot)
  return {
    cfg,
    delivered,
    handlers,
    async emit(ev) {
      for (const h of handlers.filter((x) => x.stage === 'intercept')) await h.fn(ev)
    },
  }
}

function groupEvent({ text = '', userId = 10001 } = {}) {
  return {
    chatKey: 'group:123456',
    isGroup: true,
    groupId: 123456,
    text,
    sender: { qq: userId, name: '群友', isMaster: false },
    stopped: false,
    stopReason: '',
    hint: [],
  }
}

function privateEvent({ text = '', userId = 10001 } = {}) {
  return {
    chatKey: `private:${userId}`,
    isGroup: false,
    groupId: null,
    text,
    sender: { qq: userId, name: '主人', isMaster: true },
    stopped: false,
    stopReason: '',
    hint: [],
  }
}

// ── 群里：各种命令形态都要吞掉 ──────────────────────────────────
test('GUARD 群里 /help 被吞（原来任何人发她都会回命令清单）', async () => {
  const h = makeBot()
  const ev = groupEvent({ text: '/help' })
  await h.emit(ev)
  assert.equal(ev.stopped, true)
  assert.match(ev.stopReason, /group-command-guard/)
  assert.equal(h.delivered.length, 0, '静默模式下不回任何话')
})

test('GUARD 群里 //办公、#命令、!x、.x 全吞', async () => {
  for (const text of ['//查下E盘', '#命令-关闭群聊功能', '!help', '.status', '／help', '＃命令-开启群聊功能', '！help']) {
    const h = makeBot()
    const ev = groupEvent({ text })
    await h.emit(ev)
    assert.equal(ev.stopped, true, `${text} 应被吞`)
  }
})

test('GUARD 群里主人自己发命令也吞（命令只走私聊）', async () => {
  const h = makeBot()
  const ev = groupEvent({ text: '/status', userId: 10001 })
  ev.sender.isMaster = true
  await h.emit(ev)
  assert.equal(ev.stopped, true)
})

// ── 正常聊天不能被误伤 ──────────────────────────────────────────
test('GUARD 正常群聊不受影响（含句子中间带斜杠）', async () => {
  for (const text of ['今天天气不错', '我觉得/还行', '哈哈哈', '？', '在吗']) {
    const h = makeBot()
    const ev = groupEvent({ text })
    await h.emit(ev)
    assert.equal(ev.stopped, false, `${text} 不该被吞`)
  }
})

// ── 私聊不管 ────────────────────────────────────────────────────
test('GUARD 私聊的 /命令 与 //办公 不受影响', async () => {
  for (const text of ['/reset', '//查下E盘']) {
    const h = makeBot()
    const ev = privateEvent({ text })
    await h.emit(ev)
    assert.equal(ev.stopped, false, `${text} 在私聊不该被吞`)
  }
})

// ── 开关 ────────────────────────────────────────────────────────
test('GUARD 关掉开关后不再吞', async () => {
  const h = makeBot({ enabled: false })
  const ev = groupEvent({ text: '/help' })
  await h.emit(ev)
  assert.equal(ev.stopped, false)
})

test('GUARD silent=false 时回一句但仍拦下（不让她继续处理）', async () => {
  const h = makeBot({ silent: false })
  const ev = groupEvent({ text: '/help' })
  await h.emit(ev)
  assert.equal(ev.stopped, true)
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].target, 'group:123456')
})

// ── 纯函数与契约 ────────────────────────────────────────────────
test('GUARD looksLikeCommand 只认开头', () => {
  assert.equal(looksLikeCommand('/help'), true)
  assert.equal(looksLikeCommand('   /help'), true)
  assert.equal(looksLikeCommand('我觉得/还行'), false)
  assert.equal(looksLikeCommand('你好'), false)
  assert.equal(looksLikeCommand(''), false)
})

test('GUARD 契约：order 必须小于 5（要抢在内核命令分发之前）', () => {
  assert.equal(plugin.id, 'group-command-guard')
  assert.ok(plugin.order < 5, 'order 必须 < 5，否则内核先把命令处理掉了')
  assert.equal(plugin.configSchema.enabled.default, true)
  for (const [field, def] of Object.entries(plugin.configSchema)) {
    assert.ok(def.group && def.label, `${field} 缺 group/label`)
    assert.ok(String(def.hint || '').trim().length > 0, `${field} 缺 hint`)
  }
})

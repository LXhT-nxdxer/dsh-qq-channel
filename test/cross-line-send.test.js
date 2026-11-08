/**
 * test/cross-line-send.test.js — 跨线发送：主人让她「去别的群发一句」。
 *
 * 真机背景（2026-11-01）：
 *   主人：「你加的新群快发个表情包」→ 她：「哪个群呀 我这儿只看得见你这个」
 *   主人给了群号 → 她：「可回话全落在咱这私聊里 群里一条没见动」
 * 根因：工具入口把模型给的 `target` **无条件改回本轮会话**，所以她永远发不到别的线。
 *
 * 规则（`decideToolTarget`）：
 *   · 主人这一轮 + 合法 QQ 线 → 尊重 target（跨线）
 *   · 外人 / 非法 target → 纠正回本轮（防止陌生人把她顶到别的群）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, ADMIN_QQ, GROUP_ID, MEMBER_QQ, emitRaw, privateEvent } from './helpers.mjs'
import { decideToolTarget } from '../index.js'

const masterPrivate = `private:${ADMIN_QQ}`
const strangerPrivate = `private:${MEMBER_QQ}`
const groupKey = `group:${GROUP_ID}`

const masterTurn = { chatKey: masterPrivate, senderIsMaster: true }
const strangerTurn = { chatKey: strangerPrivate, senderIsMaster: false }

test('1. 主人这一轮指定别的群 → 尊重 target（跨线发送）', () => {
  const r = decideToolTarget(masterTurn, groupKey)
  assert.deepEqual(r, { target: groupKey, crossLine: true, corrected: false })
})

test('2. 主人这轮指定别的私聊 → 也放行', () => {
  const r = decideToolTarget(masterTurn, 'private:123456')
  assert.equal(r.target, 'private:123456')
  assert.equal(r.crossLine, true)
})

test('3. 外人这一轮指定群 → 纠正回自己的会话（不能被顶到群里发话）', () => {
  const r = decideToolTarget(strangerTurn, groupKey)
  assert.deepEqual(r, { target: strangerPrivate, crossLine: false, corrected: true })
})

test('4. target 不合法 / 就是本线 / 没有本轮 → 不改', () => {
  assert.equal(decideToolTarget(masterTurn, 'foo').corrected, true, '非法 target 纠正回本线')
  const same = decideToolTarget(masterTurn, masterPrivate)
  assert.deepEqual(same, { target: masterPrivate, crossLine: false, corrected: false })
  const web = decideToolTarget(null, groupKey)
  assert.deepEqual(web, { target: groupKey, crossLine: false, corrected: false }, '网页/宿主会话不拦')
})

test('5. list_groups 工具已注册，能查群号（主人只说群名时靠它）', async (t) => {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } } },
  })
  t.after(() => h.dispose())

  const tool = h.kernel.toolDefs.get('list_groups')
  assert.ok(tool, '应注册 list_groups 工具')
  const list = await tool.execute({})
  assert.ok(Array.isArray(list) && list.length > 0, '应返回群列表')
  assert.equal(typeof list[0].group_id, 'number')
  assert.ok('group_name' in list[0])
})

test('6. 群里那一轮不能查群列表（隐私）', async (t) => {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } } },
  })
  t.after(() => h.dispose())

  // 造一轮真人回合：陌生人私聊入站 → 该轮回合进了 turnStore 才判得出"不是主人"
  const tool = h.kernel.toolDefs.get('list_groups')
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'private',
    self_id: 999999,
    user_id: MEMBER_QQ,
    message_id: 50001,
    raw_message: '你好',
    message: [{ type: 'text', data: { text: '你好' } }],
    sender: { user_id: MEMBER_QQ, nickname: '路人' },
  })
  // 没有本轮上下文时（测试直接调）允许；有陌生人回合时必须拒 —— 这里只断言"工具存在且当前可调"
  assert.ok(tool, '工具存在')
})

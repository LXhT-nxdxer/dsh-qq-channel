/**
 * test/startup-recall.test.js — 开机回查：纯函数行为（不启内核、不碰 NapCat）。
 *
 * 覆盖：
 *   · mentionKind：@ 她 / 关键词点名 / 她自己发的 / 普通闲聊
 *   · pickPrivatePending：只取「她最后一条之后」+「since 之后」+ 条数上限
 *   · pickGroupPending：只认 @ 或关键词，自己发的不算，条数上限取最近 N 条
 *   · buildPrompt：有离机分钟数、有条数、没有内容时返回空串
 *   · 配置完整性：每个开关都有 group/label/hint（控制台规范）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import plugin, {
  buildPrompt, mentionKind, pickGroupPending, pickPrivatePending, seedBaseline,
} from '../plugins/startup-recall/index.js'

const SELF = 3695704702
const ADMIN = 10001

/** 造一条 OneBot 历史（段数组）。 */
function msg({ id = 1, from = 10001, text = '在吗', time = 1700000000, at = null } = {}) {
  const message = []
  if (at) message.push({ type: 'at', data: { qq: String(at) } })
  if (text) message.push({ type: 'text', data: { text } })
  return { message_id: id, user_id: from, time, message }
}

test('MENTION @ 她 → at；点名 → keyword；她自己发的和闲聊都不算', () => {
  assert.equal(mentionKind(msg({ at: SELF, text: '过来' }), { selfId: SELF, keywords: ['小汐曦'] }), 'at')
  assert.equal(mentionKind(msg({ text: '小汐曦 你在吗' }), { selfId: SELF, keywords: ['小汐曦'] }), 'keyword')
  assert.equal(mentionKind(msg({ from: SELF, text: '小汐曦' }), { selfId: SELF, keywords: ['小汐曦'] }), '', '她自己发的不算')
  assert.equal(mentionKind(msg({ text: '今天吃什么' }), { selfId: SELF, keywords: ['小汐曦'] }), '')
  assert.equal(mentionKind(msg({ at: 12345, text: '你好' }), { selfId: SELF, keywords: [] }), '', '@ 别人不算')
})

test('PRIVATE 只取她最后一条回复之后、since 之后、最多 N 条', () => {
  const raw = [
    msg({ id: 1, from: ADMIN, text: '早上好', time: 1700000001000 }),
    msg({ id: 2, from: SELF, text: '早呀', time: 1700000001100 }),
    msg({ id: 3, from: ADMIN, text: '旧消息', time: 1700000001200 }),
    msg({ id: 4, from: ADMIN, text: '关机时发的A', time: 1700000005000 }),
    msg({ id: 5, from: ADMIN, text: '关机时发的B', time: 1700000005100 }),
  ]
  const got = pickPrivatePending(raw, { selfId: SELF, adminQq: ADMIN, since: 1700000002000, limit: 2 })
  assert.deepEqual(got.map((x) => x.text), ['关机时发的A', '关机时发的B'])
  // since 之前的不补
  const older = pickPrivatePending(raw, { selfId: SELF, adminQq: ADMIN, since: 1700000006000, limit: 5 })
  assert.deepEqual(older, [], 'since 之后没有消息就不补')
  // 她回过之后的不算漏
  const replied = [...raw, msg({ id: 9, from: SELF, text: '回了', time: 1700000009000 })]
  assert.deepEqual(pickPrivatePending(replied, { selfId: SELF, adminQq: ADMIN, since: 1700000002000, limit: 5 }), [])
})

test('GROUP 只认 @ 或关键词，自己发的不算，取最近 N 条', () => {
  const raw = [
    msg({ id: 1, from: 100, text: '随便聊聊', time: 1700000006000 }),
    msg({ id: 2, from: 101, text: '有人吗', time: 1700000006100, at: SELF }),
    msg({ id: 3, from: SELF, text: '我在', time: 1700000006200 }),
    msg({ id: 4, from: 102, text: '小汐曦 出来', time: 1700000006300 }),
    msg({ id: 5, from: 103, text: '又 @ 一次', time: 1700000006400, at: SELF }),
  ]
  const got = pickGroupPending(raw, { selfId: SELF, since: 1700000005000, keywords: ['小汐曦'], limit: 2 })
  assert.equal(got.length, 2, '上限 2 条')
  assert.deepEqual(got.map((x) => x.text), ['小汐曦 出来', '又 @ 一次'])
  assert.deepEqual(got.map((x) => x.kind), ['keyword', 'at'])

  // since 之前的 @ 不补
  assert.deepEqual(pickGroupPending(raw, { selfId: SELF, since: 1700000007000, keywords: ['小汐曦'], limit: 3 }), [])
})

test('PROMPT 带离机分钟数、条数；没内容返回空串', () => {
  const text = buildPrompt({
    kind: 'group',
    chatLabel: '测试群',
    items: [{ text: '@ 你一下' }, { text: '小汐曦 在吗' }],
    since: 0,
    now: 90 * 60 * 1000,
  })
  assert.match(text, /开机回查/)
  assert.match(text, /测试群/)
  assert.match(text, /1\. @ 你一下/)
  assert.match(text, /2\. 小汐曦 在吗/)

  const priv = buildPrompt({
    kind: 'private',
    items: [{ text: '你睡了吗' }],
    since: 0,
    now: 30 * 60 * 1000,
  })
  assert.match(priv, /你当时没回/)

  assert.equal(buildPrompt({ kind: 'group', items: [] }), '')
})

test('配置完整性：默认关 + 每个开关都有 group/label/hint', () => {
  const schema = plugin.configSchema
  assert.equal(plugin.id, 'startup-recall')
  assert.equal(schema.enabled.default, false, '默认关：要用户在控制台显式打开')
  for (const [field, def] of Object.entries(schema)) {
    assert.ok(def.group && def.label, `${field} 缺 group/label`)
    assert.ok(String(def.hint || '').trim().length > 0, `${field} 缺悬停解释`)
    assert.ok(['bool', 'int', 'float', 'str', 'text', 'enum'].includes(def.type), `${field} 控件类型非法`)
  }
})

// ── 2026-11-06 真机回归：开机回查永久空转 ────────────────────────────
// 旧实现：第一次运行写进去的是**空** lastSeenAt，下一轮又拿"lastSeenAt 为空"判第一次，
// 于是永远停在"第一次运行：只记基准"。结果就是"历史回读又没了"。
test('seedBaseline：第一次运行真的写下基准（私聊 + 每个群）', () => {
  const now = 1_700_000_000_000
  const s = seedBaseline({
    groups: [{ group_id: 111, group_name: 'A' }, { groupId: 222 }],
    admin: 10001,
    includePrivate: true,
    now,
  })
  assert.equal(s.version, 1)
  assert.equal(s.lastRunAt, now)
  assert.equal(s.lastSeenAt['private:10001'], now)
  assert.equal(s.lastSeenAt['group:111'], now)
  assert.equal(s.lastSeenAt['group:222'], now)
  assert.equal(Object.keys(s.lastSeenAt).length, 3)
})

test('seedBaseline：includePrivate=false 只记群', () => {
  const s = seedBaseline({ groups: [{ group_id: 9 }], admin: 10001, includePrivate: false, now: 5 })
  assert.deepEqual(Object.keys(s.lastSeenAt), ['group:9'])
  assert.equal(s.lastSeenAt['private:10001'], undefined)
})

test('seedBaseline：群号是脏数据就跳过，但 lastRunAt 照旧写上（避免又卡在第一次）', () => {
  const s = seedBaseline({ groups: [{ group_id: 'abc' }, { group_id: 0 }, null, { groupId: 7 }], admin: 0, now: 42 })
  assert.deepEqual(Object.keys(s.lastSeenAt), ['group:7'])
  assert.equal(s.lastRunAt, 42)
})

test('seedBaseline：一条线都没有也写 lastRunAt —— 判据是它，不是 lastSeenAt', () => {
  const s = seedBaseline({ groups: [], admin: 0, includePrivate: false, now: 77 })
  assert.deepEqual(s.lastSeenAt, {})
  assert.ok(s.lastRunAt > 0, '有 lastRunAt 才算"跑过"，否则永远第一次')
})

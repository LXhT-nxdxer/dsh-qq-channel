/**
 * test/owner-commands.test.js — 群聊总开关（plugins/owner-commands）的行为测试。
 *
 * 覆盖任务卡要的那几条：
 *   · 关闭：主人私聊 `#命令-关闭群聊功能` → 回执 + 标记落盘 + 之后群消息一条都不进模型（私聊不受影响）
 *   · 开启：`#命令-开启群聊功能` → 回执 + 标记删除 + 群消息恢复进模型
 *   · 兼容写法：`#命令-关闭群里功能` / `#命令-开启群里功能`；`/stop-groups` / `/start-groups`
 *   · 非主人：不执行、不报错、当普通聊天（不回执、不写标记、照常进模型）
 *   · 重启后：上一轮留下的标记文件照样生效（状态在文件里，不在内存里）
 *
 * 夹具照 audit-plugin-additions.test.js：bootKernel 起临时数据目录 + mock ctx，看 h.sent / h.ctx._prompts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  bootKernel, emitRaw, tapInbound, waitFor, tmpDir,
  MEMBER_QQ, GROUP_ID, ADMIN_QQ, groupAtEvent, privateEvent,
} from './helpers.mjs'

/** 关掉合批，出站别被 pacing 攒着（照 audit 套件的写法）；本插件已改成默认关，测试里显式打开 */
const mergeOff = { pacing: { merge: { enabled: false } }, pluginConfig: { 'owner-commands': { enabled: true } } }
/** 非主人用例的放行名单：不然 private-friend-gate 会把 MEMBER_QQ 当陌生人拦掉 */
const allowMember = {
  ...mergeOff,
  pluginConfig: { ...mergeOff.pluginConfig, 'private-friend-gate': { allowList: [MEMBER_QQ] } },
}

/** 标记文件的缺省相对位置（与插件 configSchema 里 stateFile 的默认值一致） */
const FLAG_REL = path.join('state', 'owner-commands-groups-off.flag')
const flagOf = (h) => path.join(h.dataDir, FLAG_REL)
/** 所有出站文本拼一份，断言回执用 */
const sentText = (h) => h.sent.map((s) => String(s.wire ?? '')).join('\n')

// ── 关闭 ─────────────────────────────────────────────────────
test('OWNER-CMD 主人私聊 #命令-关闭群聊功能 → 回执 + 标记落盘 + 群消息不再进模型', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 1 }))
  await waitFor(() => sentText(h).includes('群功能已关闭'), { label: '关闭回执' })

  assert.ok(fs.existsSync(flagOf(h)), '标记应落在实例数据目录')
  assert.equal(JSON.parse(fs.readFileSync(flagOf(h), 'utf8')).groupsOff, true, '标记内容应标明群功能关闭')
  assert.equal(tap.last().stopReason, 'owner-commands:stop-groups')
  assert.equal(h.ctx._prompts.length, 0, '命令本身零 token，不进模型')

  // 群里 @ 她：拦在 intercept，一条都不进模型
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 2 }))
  await waitFor(() => tap.last()?.stopReason === 'owner-commands:groups-off', { label: '群消息被拦' })
  assert.equal(h.ctx._prompts.length, 0, '群消息不应进模型')

  // 只关群，不关私聊
  await emitRaw(h.kernel, privateEvent({ text: '你好', messageId: 3 }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '私聊照常进模型' })
})

// ── 开启 ─────────────────────────────────────────────────────
test('OWNER-CMD 主人私聊 #命令-开启群聊功能 → 回执 + 标记删除 + 群消息恢复进模型', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 1 }))
  await waitFor(() => sentText(h).includes('群功能已关闭'), { label: '先关闭' })
  assert.ok(fs.existsSync(flagOf(h)))

  await emitRaw(h.kernel, privateEvent({ text: '#命令-开启群聊功能', messageId: 2 }))
  await waitFor(() => sentText(h).includes('群功能已恢复'), { label: '恢复回执' })
  assert.equal(fs.existsSync(flagOf(h)), false, '标记应被删掉')
  assert.equal(tap.last().stopReason, 'owner-commands:start-groups')

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 3 }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '群消息恢复进模型' })
  assert.equal(tap.last().stopped, false, '恢复后群消息不该被拦')
  assert.equal(tap.last().stopReason, '', '恢复后不该有 stopReason')
})

// ── 兼容写法：中文「群里」 ────────────────────────────────────
test('OWNER-CMD 兼容 #命令-关闭群里功能 / #命令-开启群里功能', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群里功能', messageId: 1 }))
  await waitFor(() => sentText(h).includes('群功能已关闭'), { label: '关闭回执（群里写法）' })
  assert.ok(fs.existsSync(flagOf(h)))

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 2 }))
  await waitFor(() => tap.last()?.stopReason === 'owner-commands:groups-off', { label: '群消息被拦' })
  assert.equal(h.ctx._prompts.length, 0)

  await emitRaw(h.kernel, privateEvent({ text: '#命令-开启群里功能', messageId: 3 }))
  await waitFor(() => sentText(h).includes('群功能已恢复'), { label: '恢复回执（群里写法）' })
  assert.equal(fs.existsSync(flagOf(h)), false)
})

// ── 兼容写法：斜杠命令 ───────────────────────────────────────
test('OWNER-CMD 兼容 /stop-groups 与 /start-groups', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, privateEvent({ text: '/stop-groups', messageId: 1 }))
  await waitFor(() => sentText(h).includes('群功能已关闭'), { label: '关闭回执（斜杠）' })
  assert.ok(fs.existsSync(flagOf(h)), '/stop-groups 也要写标记')
  assert.equal(tap.last().stopReason, 'owner-commands:stop-groups')

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 2 }))
  await waitFor(() => tap.last()?.stopReason === 'owner-commands:groups-off', { label: '群消息被拦' })
  assert.equal(h.ctx._prompts.length, 0)

  await emitRaw(h.kernel, privateEvent({ text: '/start-groups', messageId: 3 }))
  await waitFor(() => sentText(h).includes('群功能已恢复'), { label: '恢复回执（斜杠）' })
  assert.equal(fs.existsSync(flagOf(h)), false)

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 4 }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '群消息恢复进模型' })
})

// ── 非主人 ───────────────────────────────────────────────────
test('OWNER-CMD 非主人发这些 → 不执行、不报错、当普通聊天', async (t) => {
  const h = await bootKernel({ config: allowMember })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  // 非主人私聊 #命令-关闭群聊功能：当普通聊天进模型
  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '非主人消息照常进模型' })
  assert.equal(fs.existsSync(flagOf(h)), false, '非主人不该写标记')
  assert.equal(h.sent.length, 0, '不该有任何回执')
  assert.equal(tap.last().stopped, false, '不该拦这条消息')

  // 非主人私聊 /stop-groups：一样当普通聊天
  await emitRaw(h.kernel, privateEvent({ text: '/stop-groups', messageId: 2, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 2, { label: '/stop-groups 也当普通聊天' })
  assert.equal(fs.existsSync(flagOf(h)), false)
  assert.equal(h.sent.length, 0)

  // 群聊完全没受影响
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 3 }))
  await waitFor(() => h.ctx._prompts.length === 3, { label: '群聊照常进模型' })
})

// ── 重启后：标记文件是唯一状态 ───────────────────────────────
test('OWNER-CMD 上一轮留下的标记文件 → 重启后群功能仍是关的，主人私聊可恢复', async (t) => {
  const dataDir = tmpDir('owner-cmd')
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'state', 'owner-commands-groups-off.flag'), '{"groupsOff":true}\n')
  const h = await bootKernel({ dataDir, config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 1 }))
  await waitFor(() => tap.last()?.stopReason === 'owner-commands:groups-off', { label: '遗留标记生效' })
  assert.equal(h.ctx._prompts.length, 0, '标记在 → 群消息不进模型')

  // 主人私聊照样能恢复
  await emitRaw(h.kernel, privateEvent({ text: '#命令-开启群聊功能', messageId: 2 }))
  await waitFor(() => sentText(h).includes('群功能已恢复'), { label: '恢复回执' })
  assert.equal(fs.existsSync(flagOf(h)), false)

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 3 }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '群消息恢复进模型' })
})

// ── 2026-11-04 真机：关了之后她还在群里说话 ───────────────────
// 拦「群消息进模型」只挡住了模型这一条路；复读 +1 跑在 passive-tap（比 intercept 早），
// autopilot 是直接投 prompt —— 两条都不经过那道门，用户看到的还是"关了还在冒话"。
test('OWNER-CMD 关闭后，发往群里的出站也拦（复读/主动接话/表情包）', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())

  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 1 }))
  await waitFor(() => sentText(h).includes('群功能已关闭'), { label: '关闭回执' })
  const before = h.sent.length

  await assert.rejects(
    () => h.kernel.deliver(`group:${GROUP_ID}`, '复读来的话'),
    /群功能已关闭/,
    '关着的时候不准往群里发',
  )

  // 私聊不受影响（回执/日常都要能发）
  await h.kernel.deliver(`private:${ADMIN_QQ}`, '私聊照样能说')
  assert.equal(h.sent.length, before + 1, '只有私聊那一条出去了')

  // 恢复后群里又能发
  await emitRaw(h.kernel, privateEvent({ text: '#命令-开启群聊功能', messageId: 2 }))
  await waitFor(() => sentText(h).includes('群功能已恢复'), { label: '恢复回执' })
  const rec = await h.kernel.deliver(`group:${GROUP_ID}`, '现在能说了')
  assert.ok(String(rec.wire ?? '').includes('现在能说了'))
})

// 关闭要"关一切"：连留档 / 表情采集这些 passive-tap 的活儿都不该再干。
test('OWNER-CMD 关闭后，群消息连留档都不写（pre-gate 就丢）', async (t) => {
  const h = await bootKernel({
    dataDir: tmpDir('owner-cmd-pregate'),
    config: { ...mergeOff, archive: { enabled: true, dir: 'logs/qq_chat' } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 1 }))
  await waitFor(() => sentText(h).includes('群功能已关闭'), { label: '关闭回执' })

  await emitRaw(h.kernel, groupAtEvent({ text: '关闭期间的群消息', messageId: 2 }))
  await waitFor(() => tap.last()?.stopReason === 'owner-commands:groups-off', { label: '群消息被丢' })

  const file = path.join(h.dataDir, 'logs', 'qq_chat', `group_${GROUP_ID}.jsonl`)
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  assert.ok(!body.includes('关闭期间的群消息'), `关闭期间不该写留档：${body.slice(-200)}`)
})

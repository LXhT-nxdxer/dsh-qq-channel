/**
 * test/context-gap.test.js — 断档补上下文（plugins/context-gap）单测。
 *
 * 覆盖需求里的五条：
 *   ① gap 内不查（含“第一次见这条线”没有基准时不查）；
 *   ② gap 后查一次，且只查一次；
 *   ③ 查到漏回 → 推 hint（排除当前这条新消息）；
 *   ④ 没漏 → 不推 hint（但确实查过一次）；
 *   ⑤ 群聊 / 非主人私聊不触发。
 * 另加：pickMissed / renderGapHint 的纯函数边界。
 *
 * 不 boot 内核：假 bot 只给 before-turn / onOutbound / privateHistory，
 * 时间用 ev.time 注入，测试不依赖真实时钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin, { pickMissed, renderGapHint } from '../plugins/context-gap/index.js'

const ADMIN_QQ = 10001
const SELF_ID = 999999
const CHAT_KEY = `private:${ADMIN_QQ}`
const BASE = new Date(2026, 9, 31, 10, 0, 0).getTime() // 本地 2026-10-31 10:00
const MIN = 60_000

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一条 OneBot 历史条目（段数组形态，time 是秒）。 */
function textMsg(id, from, text, atMs) {
  return {
    message_id: id,
    user_id: from,
    sender: { user_id: from },
    time: Math.floor(atMs / 1000),
    message: [{ type: 'text', data: { text } }],
  }
}

/** 假 bot：只给断档补上下文用到的能力面。 */
function makeBot({ history = [], adminQq = ADMIN_QQ, selfId = SELF_ID, cfg = {}, dataDir = '', archiveDir = '' } = {}) {
  const stages = []
  const outs = []
  const fetched = []
  const bot = {
    id: 'context-gap',
    cfg: { enabled: true, gapMin: 30, historyCount: 30, ...cfg },
    log: quiet,
    core: { adminQq, dataDir, archive: { dir: archiveDir, enabled: Boolean(archiveDir) } },
    napcat: {
      get selfId() { return selfId },
      async privateHistory(userId, count) {
        fetched.push({ userId, count })
        return typeof history === 'function' ? await history(userId, count) : history
      },
    },
    shared: {},
    on(stage, fn) { stages.push([stage, fn]) },
    onOutbound(fn) { outs.push(fn) },
    onDispose() {},
  }
  return { bot, stages, outs, fetched }
}

const hookOf = (stages, name = 'before-turn') => stages.find(([s]) => s === name)?.[1]

/** 一条主人私聊入站消息（time 用毫秒，模拟 ev.time）。 */
function evAt(t, extra = {}) {
  return {
    chatKey: CHAT_KEY,
    isGroup: false,
    sender: { isMaster: true },
    wake: { kind: 'private' },
    messageId: 100,
    time: t,
    text: '新消息',
    hint: [],
    _scratch: {},
    ...extra,
  }
}

test('CONTEXT-GAP gap 内不查：第一次见只记基准，10 分钟后也不打接口', async () => {
  const history = [
    textMsg(1, SELF_ID, '在的', BASE - MIN),
    textMsg(2, ADMIN_QQ, '我问你的那个事', BASE + 30_000),
  ]
  const { bot, stages, fetched } = makeBot({ history })
  plugin.setup(bot)
  const hook = hookOf(stages)

  const first = evAt(BASE)
  await hook(first)
  assert.equal(fetched.length, 0, '第一次见这条线没有基准，不许查')
  assert.equal(first.hint.length, 0)

  const soon = evAt(BASE + 10 * MIN, { messageId: 3 })
  await hook(soon)
  assert.equal(fetched.length, 0, 'gap=10 分钟 < 30，不许查')
  assert.equal(soon.hint.length, 0)
})

test('CONTEXT-GAP gap 后查一次并推 hint：排除当前新消息，只查这一次', async () => {
  const history = [
    textMsg(1, SELF_ID, '在的', BASE - 5 * MIN),
    textMsg(2, ADMIN_QQ, '我下午问你的那个事', BASE + MIN),
    textMsg(3, ADMIN_QQ, '你人呢', BASE + 40 * MIN),
    textMsg(4, ADMIN_QQ, '这句是现在的新消息', BASE + 50 * MIN),
  ]
  const { bot, stages, fetched } = makeBot({ history })
  plugin.setup(bot)
  const hook = hookOf(stages)

  await hook(evAt(BASE)) // 建基准
  assert.equal(fetched.length, 0)

  const back = evAt(BASE + 50 * MIN, { messageId: 4, text: '这句是现在的新消息' })
  await hook(back)

  assert.equal(fetched.length, 1, 'gap=50 分钟，应当查一次')
  assert.deepEqual(fetched[0], { userId: ADMIN_QQ, count: 30 })
  assert.equal(back.hint.length, 1, '查到漏回要推 hint')
  const hint = back.hint[0]
  assert.match(hint, /\[断档补上下文\]/)
  assert.match(hint, /我下午问你的那个事/)
  assert.match(hint, /你人呢/)
  assert.doesNotMatch(hint, /这句是现在的新消息/, '当前这条新消息不是“漏回的”')
  assert.match(hint, /先回应这些/)
  assert.match(hint, /别重复补/, '要告诉模型 backfill 可能也看到同一批')

  const claim = bot.shared.contextGapClaim
  assert.ok(claim, '要留让路标记给 backfill')
  assert.equal(claim.chatKey, CHAT_KEY)
  assert.deepEqual(claim.ids, ['2', '3'])

  // 紧接着再发一条：距上次交互只有 1 分钟 → 不许再查
  const next = evAt(BASE + 51 * MIN, { messageId: 5 })
  await hook(next)
  assert.equal(fetched.length, 1, 'gap 后只查一次，后续消息不再打接口')
  assert.equal(next.hint.length, 0)
})

test('CONTEXT-GAP 没漏不推：她最后一条回复之后主人没说话 → hint 为空', async () => {
  const history = [
    textMsg(1, ADMIN_QQ, '在吗', BASE - 2 * MIN),
    textMsg(2, SELF_ID, '在啊', BASE - MIN),
  ]
  const { bot, stages, fetched } = makeBot({ history })
  plugin.setup(bot)
  const hook = hookOf(stages)

  await hook(evAt(BASE)) // 建基准
  const back = evAt(BASE + 2 * 60 * MIN, { messageId: 3 }) // 两小时后
  await hook(back)

  assert.equal(fetched.length, 1, '断档了就该查这一次')
  assert.equal(back.hint.length, 0, '没有漏回就什么都不推')
  assert.equal(bot.shared.contextGapClaim, undefined, '没有漏回不写让路标记')
})

test('CONTEXT-GAP 群聊 / 非主人私聊不触发', async () => {
  const { bot, stages, fetched } = makeBot({ history: [] })
  plugin.setup(bot)
  const hook = hookOf(stages)

  const group = evAt(BASE, { chatKey: 'group:20001', isGroup: true })
  await hook(group)
  await hook(evAt(BASE + 2 * 60 * MIN, { chatKey: 'group:20001', isGroup: true, messageId: 2 }))
  assert.equal(fetched.length, 0, '群聊一句都不查')

  const other = evAt(BASE, { chatKey: 'private:88888', sender: { isMaster: false } })
  await hook(other)
  await hook(evAt(BASE + 2 * 60 * MIN, { chatKey: 'private:88888', sender: { isMaster: false }, messageId: 2 }))
  assert.equal(fetched.length, 0, '别人的私聊不查')
})

test('CONTEXT-GAP 开关关着：gap 再大也不查', async () => {
  const history = [textMsg(1, SELF_ID, '在', BASE - MIN), textMsg(2, ADMIN_QQ, '漏了', BASE)]
  const { bot, stages, fetched } = makeBot({ history, cfg: { enabled: false } })
  plugin.setup(bot)
  const hook = hookOf(stages)

  await hook(evAt(BASE))
  const back = evAt(BASE + 3 * 60 * MIN, { messageId: 3 })
  await hook(back)
  assert.equal(fetched.length, 0, 'enabled=false 时不许查')
  assert.equal(back.hint.length, 0)
})

test('CONTEXT-GAP 重启后仍能判断档：主人私聊时间戳落盘，重启第一条消息就接上', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-context-gap-'))
  const history = [
    textMsg(1, SELF_ID, '在的', BASE - 10 * MIN),
    textMsg(2, ADMIN_QQ, '我挂机前问你的那个事', BASE - 5 * MIN),
  ]

  // 第一个实例：10:00 记一次基准（没有漏回、不查），时间戳同步落盘
  const first = makeBot({ history, dataDir })
  plugin.setup(first.bot)
  await hookOf(first.stages)(evAt(BASE, { messageId: 20 }))
  assert.equal(first.fetched.length, 0)
  const stateFile = path.join(dataDir, 'state', 'context-gap.json')
  assert.ok(fs.existsSync(stateFile), '主人私聊的时间戳要落盘，重启后才能判断档')
  assert.ok(fs.readFileSync(stateFile, 'utf8').includes(CHAT_KEY))

  // 第二个实例 = DSH 重启：两小时后回来，应拿落盘的基准查出挂机前漏问的那句
  const second = makeBot({ history, dataDir })
  plugin.setup(second.bot)
  const back = evAt(BASE + 2 * 60 * MIN, { messageId: 3, text: '我回来了' })
  await hookOf(second.stages)(back)
  assert.equal(second.fetched.length, 1, '重启后第一条消息也要能判断档')
  assert.equal(back.hint.length, 1)
  assert.match(back.hint[0], /我挂机前问你的那个事/)

  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('CONTEXT-GAP 刚装插件/状态丢了：留档很久没动才探测；刚重启/全新安装不探测', async () => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-context-gap-archive-'))
  const archiveFile = path.join(archiveDir, `private_${ADMIN_QQ}.jsonl`)
  fs.writeFileSync(archiveFile, '{"dir":"in","ts":1}\n')
  // 留档两小时没动过 = 确实断过（mtime 是“没有基准时”的断档代理）
  const old = new Date(Date.now() - 2 * 60 * MIN)
  fs.utimesSync(archiveFile, old, old)

  const history = [
    textMsg(1, SELF_ID, '在的', BASE - 10 * MIN),
    textMsg(2, ADMIN_QQ, '我挂机前问你的那个事', BASE - 5 * MIN),
  ]

  // 有留档且很久没动 → 第一条消息做一次启动探测（解决“部署后重启第一条没人判断档”）
  const had = makeBot({ history, archiveDir })
  plugin.setup(had.bot)
  const first = evAt(BASE + 2 * 60 * MIN, { messageId: 3 })
  await hookOf(had.stages, 'pre-gate')(first) // 抢在留档器写当前消息之前抓 mtime
  // 模拟内核 passive-tap 把当前这条写进留档：mtime 变成“现在”，不能用它判断档
  const nowDate = new Date()
  fs.utimesSync(archiveFile, nowDate, nowDate)
  await hookOf(had.stages)(first)
  assert.equal(had.fetched.length, 1, '留档很久没动，第一条消息要探测一次')
  assert.equal(first.hint.length, 1)
  assert.match(first.hint[0], /我挂机前问你的那个事/)

  // 紧接着下一条：已有基准且 gap 不够 → 不许再打接口
  const next = evAt(BASE + 2 * 60 * MIN + MIN, { messageId: 4 })
  await hookOf(had.stages)(next)
  assert.equal(had.fetched.length, 1, '启动探测只发生一次')
  assert.equal(next.hint.length, 0)

  // 留档刚动过（只是刚重启）→ 不算断档，不探测
  const freshRestartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-context-gap-recent-'))
  const recentFile = path.join(freshRestartDir, `private_${ADMIN_QQ}.jsonl`)
  fs.writeFileSync(recentFile, '{"dir":"in","ts":1}\n') // mtime = 现在
  const recent = makeBot({ history, archiveDir: freshRestartDir })
  plugin.setup(recent.bot)
  await hookOf(recent.stages)(evAt(BASE + 2 * 60 * MIN, { messageId: 3 }))
  assert.equal(recent.fetched.length, 0, '刚重启（留档刚动过）不许探测')

  // 完全没有留档 = 全新安装：不许把 bot 诞生前的旧消息当成“漏回”
  const fresh = makeBot({ history })
  plugin.setup(fresh.bot)
  const freshEv = evAt(BASE + 2 * 60 * MIN, { messageId: 3 })
  await hookOf(fresh.stages)(freshEv)
  assert.equal(fresh.fetched.length, 0, '全新安装第一条消息不探测')
  assert.equal(freshEv.hint.length, 0)

  fs.rmSync(archiveDir, { recursive: true, force: true })
  fs.rmSync(freshRestartDir, { recursive: true, force: true })
})

test('CONTEXT-GAP 纯函数：排除当前消息、空正文不补、空列表返回空串', () => {
  const history = [
    textMsg(1, SELF_ID, '在', BASE - MIN),
    textMsg(2, ADMIN_QQ, '漏了这句', BASE),
    { message_id: 3, user_id: ADMIN_QQ, time: Math.floor((BASE + MIN) / 1000), message: [{ type: 'face', data: { id: '1' } }] },
    textMsg(4, ADMIN_QQ, '现在这句', BASE + 2 * MIN),
  ]
  const missed = pickMissed(history, {
    selfId: SELF_ID,
    adminQq: ADMIN_QQ,
    currentMessageId: '4',
    limit: 5,
  })
  assert.deepEqual(missed.map((m) => m.id), ['2'], '空正文（纯表情）不补，当前消息排除')

  assert.equal(renderGapHint([]), '')
  const hint = renderGapHint([{ id: '2', time: Math.floor(BASE / 1000), text: '漏了这句' }])
  assert.match(hint, /10:00 主人：漏了这句/)
})

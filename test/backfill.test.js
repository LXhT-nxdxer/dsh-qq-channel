/**
 * test/backfill.test.js — 补回复（plugins/backfill）行为测试。
 *
 * 四条主用例对着任务卡的验收（有漏消息要补 / 没漏不动 / 同一条不补两次 / 超过 5 条只补最近 5 条），
 * 另外补三条边界：首次运行只播种、提交失败不标记已处理、历史条目形态（图片 / raw_message）与截断。
 *
 * 不启动内核：直接调 `runBackfill` + 假 bot（NapCat 历史 / dsh.prompt 都是桩），
 * 这样这套测试不依赖 @deepseek-ai/schemastery，也不碰真网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import backfill, {
  CONTEXT_GAP_CLAIM_MS, emptyState, FAIL_COOLDOWN_MS, FAIL_THRESHOLD, nextFailureState,
  normalizeHistory, pickPending, pruneIds, renderPrompt, runBackfill,
} from '../plugins/backfill/index.js'

const ADMIN_QQ = 10001
const SELF_ID = 999999
const CHAT_KEY = `private:${ADMIN_QQ}`

/** 造一条 OneBot 历史条目（段数组形态，与 NapCat 返回一致）。 */
function textMsg(id, from, text, time = 1700000000) {
  return {
    message_id: id,
    user_id: from,
    sender: { user_id: from, nickname: from === SELF_ID ? '她自己' : '主人' },
    time,
    message: [{ type: 'text', data: { text } }],
  }
}

/** 假 bot：只给补回复用到的能力面。返回的 prompts / ensured / fetched 方便断言。 */
function makeBot({ history = [], selfId = SELF_ID, adminQq = ADMIN_QQ } = {}) {
  const prompts = []
  const ensured = []
  const fetched = []
  const bot = {
    core: { adminQq, dataDir: '' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    shared: {},
    napcat: {
      get selfId() { return selfId },
      async privateHistory(userId, count) {
        fetched.push({ userId, count })
        return typeof history === 'function' ? await history(userId, count) : history
      },
    },
    dsh: {
      async ensureSession(chatKey) {
        ensured.push(chatKey)
        return 'sess-backfill-1'
      },
      async prompt(sessionId, text) {
        prompts.push({ sessionId, text })
        return { accepted: true }
      },
    },
  }
  return { bot, prompts, ensured, fetched }
}

/** 已初始化过的状态（等价于「第二次启动」：账本存在，只是还没有 doneIds）。 */
function seededState(doneIds = []) {
  return { version: 1, chats: { [CHAT_KEY]: { doneIds, updatedAt: 0 } } }
}

// ── 主用例 ─────────────────────────────────────────────────────
test('BACKFILL 有漏消息要补：她最后一条回复之后主人发的两条 → 一次性塞回会话', async () => {
  const history = [
    textMsg(1, SELF_ID, '在的'),
    textMsg(2, ADMIN_QQ, '你在吗'),
    textMsg(3, ADMIN_QQ, '我刚说的那个你看了没'),
  ]
  const { bot, prompts, ensured, fetched } = makeBot({ history })
  const state = seededState()

  const r = await runBackfill({ bot, state })

  assert.equal(r.action, 'fill')
  assert.equal(r.chatKey, CHAT_KEY)
  assert.equal(r.count, 2)
  assert.equal(r.sessionId, 'sess-backfill-1')
  assert.deepEqual(fetched, [{ userId: ADMIN_QQ, count: 30 }], '按主人 QQ 拉私聊历史')
  assert.deepEqual(ensured, [CHAT_KEY], '会话 key 必须是 private:<主人QQ>')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /你在吗/)
  assert.match(prompts[0].text, /我刚说的那个你看了没/)
  assert.ok(prompts[0].text.indexOf('你在吗') < prompts[0].text.indexOf('我刚说的那个'), '旧→新顺序')
  assert.match(prompts[0].text, new RegExp(CHAT_KEY), '告诉模型发到哪条线')
  assert.deepEqual(state.chats[CHAT_KEY].doneIds, ['2', '3'], '补成功才记账')
})

test('BACKFILL 没漏不动：历史以她的回复收尾 → 一条都不补、不调 prompt', async () => {
  const history = [
    textMsg(1, ADMIN_QQ, '在吗'),
    textMsg(2, SELF_ID, '在啊'),
  ]
  const { bot, prompts, ensured } = makeBot({ history })
  const state = seededState()

  const r = await runBackfill({ bot, state })

  assert.equal(r.action, 'none')
  assert.equal(prompts.length, 0)
  assert.equal(ensured.length, 0, '没漏消息就不该建/拿会话')
  assert.deepEqual(state.chats[CHAT_KEY].doneIds, [])
})

test('BACKFILL 同一条不补两次：连跑两轮，第二轮静默', async () => {
  const history = [
    textMsg(1, SELF_ID, '在的'),
    textMsg(2, ADMIN_QQ, '那条推送你看到了吗'),
  ]
  const { bot, prompts } = makeBot({ history })
  const state = seededState()

  const first = await runBackfill({ bot, state })
  const second = await runBackfill({ bot, state })

  assert.equal(first.action, 'fill')
  assert.equal(first.count, 1)
  assert.equal(second.action, 'none', '同一条不许补第二次')
  assert.equal(prompts.length, 1)
  assert.deepEqual(state.chats[CHAT_KEY].doneIds, ['2'])
})

test('BACKFILL 超过 5 条只补最近 5 条：更早的两条这次放弃（dropped=2）', async () => {
  const history = [textMsg(1, SELF_ID, '在的')]
  for (let i = 2; i <= 8; i += 1) history.push(textMsg(i, ADMIN_QQ, `第${i - 1}条消息`)) // 共 7 条：第1..第7
  const { bot, prompts } = makeBot({ history })
  const state = seededState()

  const r = await runBackfill({ bot, state })

  assert.equal(r.action, 'fill')
  assert.equal(r.count, 5)
  assert.equal(r.dropped, 2)
  const text = prompts[0].text
  for (const kept of ['第3条消息', '第4条消息', '第5条消息', '第6条消息', '第7条消息']) {
    assert.match(text, new RegExp(kept), `应补进来的：${kept}`)
  }
  assert.doesNotMatch(text, /第1条消息|第2条消息/, '更早的两条不该出现在 prompt 里')
  assert.equal(state.chats[CHAT_KEY].doneIds.length, 5)
})

// ── 边界 ───────────────────────────────────────────────────────
test('BACKFILL 首次运行只播种：装插件瞬间不补旧消息，下一轮才开始工作', async () => {
  const history = [
    textMsg(1, SELF_ID, '在的'),
    textMsg(2, ADMIN_QQ, '你没回我这条'),
  ]
  const { bot, prompts } = makeBot({ history })
  const state = emptyState()

  const seed = await runBackfill({ bot, state })
  assert.equal(seed.action, 'seed')
  assert.equal(seed.seeded, 2)
  assert.equal(prompts.length, 0, '首次运行不许补')
  assert.deepEqual(state.chats[CHAT_KEY].doneIds, ['1', '2'])

  const again = await runBackfill({ bot, state })
  assert.equal(again.action, 'none')
  assert.equal(prompts.length, 0)
})

test('BACKFILL 首次运行可关掉播种：seedFirstRun=false 时第一次就补', async () => {
  const history = [textMsg(1, SELF_ID, '在的'), textMsg(2, ADMIN_QQ, '你没回我这条')]
  const { bot, prompts } = makeBot({ history })
  const state = emptyState()

  const r = await runBackfill({ bot, state, cfg: { seedFirstRun: false } })
  assert.equal(r.action, 'fill')
  assert.equal(r.count, 1)
  assert.equal(prompts.length, 1)
})

test('BACKFILL 提交失败不标记已处理：下一轮还会再补', async () => {
  const history = [textMsg(1, SELF_ID, '在的'), textMsg(2, ADMIN_QQ, '这条漏了')]
  const state = seededState()

  const boom = makeBot({ history })
  boom.bot.dsh.prompt = async () => { throw new Error('sessionController 挂了') }
  const failed = await runBackfill({ bot: boom.bot, state })
  assert.equal(failed.action, 'fail')
  assert.match(failed.reason, /提交会话失败/)
  assert.deepEqual(state.chats[CHAT_KEY].doneIds, [], '失败不许记账')

  const ok = makeBot({ history })
  const retry = await runBackfill({ bot: ok.bot, state })
  assert.equal(retry.action, 'fill', '下一轮要能补回来')
  assert.equal(ok.prompts.length, 1)
  assert.deepEqual(state.chats[CHAT_KEY].doneIds, ['2'])
})

test('BACKFILL 能力缺失时安静跳过：没连上 / 没有 privateHistory / 没有 bot.dsh', async () => {
  const state = seededState()
  const missing = await runBackfill({ bot: { core: { adminQq: ADMIN_QQ } }, state })
  assert.equal(missing.action, 'skip')
  assert.match(missing.reason, /selfId/)

  const offline = makeBot({ history: [] })
  offline.bot.napcat = { get selfId() { return 0 }, privateHistory: async () => [] }
  assert.match((await runBackfill({ bot: offline.bot, state })).reason, /selfId/)

  const noApi = makeBot({ history: [] })
  noApi.bot.napcat = { get selfId() { return SELF_ID } }
  assert.match((await runBackfill({ bot: noApi.bot, state })).reason, /privateHistory/)

  const noDsh = makeBot({ history: [] })
  noDsh.bot.dsh = {}
  assert.match((await runBackfill({ bot: noDsh.bot, state })).reason, /bot\.dsh/)
})

test('BACKFILL 历史条目形态：图片→[图片]、raw_message 兜底、纯 face 不进补回复', async () => {
  const raw = [
    { message_id: 11, sender: { user_id: ADMIN_QQ }, message: [{ type: 'image', data: { file: 'a.jpg' } }] },
    { message_id: 12, sender: { user_id: ADMIN_QQ }, message: '[CQ:face,id=1]', raw_message: '文字在 raw_message 里' },
    { message_id: 13, sender: { user_id: ADMIN_QQ }, message: [{ type: 'reply', data: { id: '9' } }] },
  ]
  const list = normalizeHistory(raw)
  assert.equal(list[0].text, '[图片]')
  assert.equal(list[1].text, '文字在 raw_message 里')
  assert.equal(list[2].text, '', '纯引用段没有正文')
  assert.equal(list[0].from, ADMIN_QQ)

  const picked = pickPending(
    [textMsg(1, SELF_ID, '在的'), ...raw],
    { selfId: SELF_ID, adminQq: ADMIN_QQ, doneIds: [], limit: 5 },
  )
  assert.deepEqual(picked.pending.map((m) => m.id), ['11', '12'], '空正文那条不补，其余照补')

  // 认不出自己 = 认不出「她回过没有」→ 一条都不碰
  assert.equal(pickPending([textMsg(1, SELF_ID, '在的')], { selfId: 0, adminQq: ADMIN_QQ }).pending.length, 0)
})

test('BACKFILL doneIds 只留最近 200 条（老账本不会无限长）', () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(i + 1))
  const pruned = pruneIds(ids)
  assert.equal(pruned.length, 200)
  assert.equal(pruned[0], '51')
  assert.equal(pruned[199], '250')
})

test('BACKFILL renderPrompt：带 chatKey、按序号、空了返回空串', () => {
  const text = renderPrompt([{ text: '第一句' }, { text: '第二句' }], CHAT_KEY)
  assert.match(text, /1\. 第一句/)
  assert.match(text, /2\. 第二句/)
  assert.match(text, new RegExp(CHAT_KEY))
  assert.equal(renderPrompt([], CHAT_KEY), '')
})

test('BACKFILL setup：先等 60 秒再跑第一次，定时器进 onDispose（重载不叠实例）', () => {
  const disposers = []
  const { bot, fetched } = makeBot({ history: [] })
  bot.onDispose = (fn) => { disposers.push(fn) }
  bot.cfg = { enabled: true, intervalMin: 5 }

  backfill.setup(bot)

  assert.equal(fetched.length, 0, 'setup 不许同步就去查历史（要等 60 秒）')
  assert.equal(disposers.length, 1, '定时器必须交给 onDispose')
  assert.equal(backfill.configSchema.firstDelaySec.default, 60)
  assert.equal(backfill.configSchema.intervalMin.default, 5)
  assert.equal(backfill.id, 'backfill')

  disposers[0]()   // 卸载：清掉未触发的首次定时器，进程/测试能立刻退出
})

// ── 控制台热开（2026-10-31 真机 bug）──────────────────────────────
test('BACKFILL enabled 从 false 变 true：定时器常驻，关着 tick 安静跳过，开了下一个 tick 就补', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-backfill-'))
  const history = [
    textMsg(1, SELF_ID, '在的'),
    textMsg(2, ADMIN_QQ, '这条你没回我'),
  ]
  const { bot, prompts, fetched } = makeBot({ history })
  bot.core.dataDir = dataDir
  bot.cfg = { enabled: false, intervalMin: 5, seedFirstRun: false }   // 启动时是关的（默认配置）
  const disposers = []
  bot.onDispose = (fn) => { disposers.push(fn) }

  backfill.setup(bot)
  // 关键：关着也必须挂上定时器/触发入口（旧实现这里直接 return，之后开开关永远没人跑）
  assert.equal(typeof bot.shared.backfillTick, 'function', '关着的时候定时器也要挂上')

  // ① 关着：tick 不查历史、不建会话、不落状态文件
  await bot.shared.backfillTick()
  assert.equal(fetched.length, 0, '关着不许查历史')
  assert.equal(prompts.length, 0, '关着不许往会话里塞东西')
  assert.equal(fs.existsSync(path.join(dataDir, 'state', 'backfill.json')), false, '关着不许写状态文件')

  // ② 控制台热开：内核只原地改 bot.cfg（不重跑 setup），下一个 tick 必须真的干活
  bot.cfg.enabled = true
  await bot.shared.backfillTick()
  assert.equal(fetched.length, 1, '开起来后下一个 tick 要查历史')
  assert.equal(prompts.length, 1, '发现漏消息要真的塞回会话')
  assert.match(prompts[0].text, /这条你没回我/)
  assert.ok(fs.existsSync(path.join(dataDir, 'state', 'backfill.json')), '开起来后状态文件要落盘')

  disposers.forEach((fn) => fn())
})

test('BACKFILL 断档上下文刚接管：让自然对话先回，window 过完再兜底', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-backfill-gap-'))
  const history = [
    textMsg(1, SELF_ID, '在的'),
    textMsg(2, ADMIN_QQ, '这条你还没回'),
  ]
  const { bot, prompts, fetched } = makeBot({ history })
  bot.core.dataDir = dataDir
  bot.cfg = { enabled: true, seedFirstRun: false }
  bot.shared.contextGapClaim = { chatKey: CHAT_KEY, ids: ['2'], at: Date.now() }
  const disposers = []
  bot.onDispose = (fn) => { disposers.push(fn) }
  backfill.setup(bot)

  // 让路窗口内：不查历史、不塞补回复（同一批已经在 context-gap 的 hint 里了）
  await bot.shared.backfillTick()
  assert.equal(fetched.length, 0, '让路期间不许查历史')
  assert.equal(prompts.length, 0, '同一批不许补两遍')

  // 窗口过完还没回：补回复照常兜底，消息不会丢
  bot.shared.contextGapClaim.at = Date.now() - CONTEXT_GAP_CLAIM_MS - 1000
  await bot.shared.backfillTick()
  assert.equal(fetched.length, 1)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /这条你还没回/)

  disposers.forEach((fn) => fn())
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ── 失败退避（2026-10-31 加）────────────────────────────────────
test('BACKFILL 连续失败 3 次进入 30 分钟冷却，触发后连击清零', () => {
  const now = 1_800_000_000_000
  const r1 = nextFailureState({ failStreak: 0, cooldownUntil: 0 }, now)
  assert.equal(r1.count, 1)
  assert.equal(r1.tripped, false)
  assert.equal(r1.failStreak, 1)

  const r2 = nextFailureState(r1, now)
  assert.equal(r2.count, 2)
  assert.equal(r2.tripped, false)

  const r3 = nextFailureState(r2, now)
  assert.equal(r3.count, 3)
  assert.equal(r3.tripped, true, '第 3 次连续失败触发退避')
  assert.equal(r3.failStreak, 0, '触发后连击清零')
  assert.equal(r3.cooldownUntil, now + FAIL_COOLDOWN_MS, '冷却 = 30 分钟')
  assert.equal(FAIL_THRESHOLD, 3)
})

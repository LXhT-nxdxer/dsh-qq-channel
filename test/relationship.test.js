/**
 * test/relationship.test.js — 关系状态（plugins/relationship）单测。
 *
 * 同样只测本插件：临时 dataDir + 最小 bot 夹具，不 boot 内核。
 *
 * 覆盖验收要求的五条：
 *   ① 加分：他来找她 → +1（并落盘 + 心情变化）；
 *   ② 减分：她主动开口后他一直没接 → -1（真计时器，窗口调成 0.01 分钟）；
 *   ③ 上下限：夹在 30–95，非法值回落默认；
 *   ④ 衰减：每天 04:00 朝 50 走一步，且一天只走一次（重启不重复扣）；
 *   ⑤ 注入文案：`你和他现在的关系：confidence=… 心情=…`，硬截断、只给主人。
 * 另加：落盘形状与「不跟 growth 共用同一个 json」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin, {
  MAX_CONFIDENCE,
  MIN_CONFIDENCE,
  applyDelta,
  buildRelationshipLine,
  clampConfidence,
  dateKeyOf,
  decayTowardMid,
  latestDecaySlotAt,
  moodOf,
  normalizeState,
} from '../plugins/relationship/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const ADMIN_QQ = 10001
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-rel-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最小 bot：只实现 relationship 用到的能力。 */
function makeBot({ dataDir, cfg = {} } = {}) {
  const stages = []
  const outbounds = []
  const disposers = []
  const shared = {}
  const bot = {
    id: 'relationship',
    cfg: { enabled: true, ...cfg },
    log: quiet,
    core: { dataDir, adminQq: ADMIN_QQ },
    shared,
    state: { get: () => undefined },
    on(stage, fn) { stages.push([stage, fn]) },
    onOutbound(fn) { outbounds.push(fn) },
    onDispose(fn) { disposers.push(fn) },
    currentTurn: () => null,
  }
  return { bot, stages, outbounds, disposers, shared }
}

const hookOf = (stages, name) => stages.find(([s]) => s === name)?.[1]
const fileOf = (dataDir) => path.join(dataDir, 'state', 'relationship.json')

/** 预置一份状态文件（模拟"昨天就有了"）。 */
function seedState(dataDir, state) {
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true })
  fs.writeFileSync(fileOf(dataDir), `${JSON.stringify(state, null, 4)}\n`)
}

/** 主人私聊的一轮（真的唤醒了她）。 */
function masterPrivateEv() {
  return { chatKey: `private:${ADMIN_QQ}`, isGroup: false, wake: { kind: 'private' }, hint: [], sender: { qq: ADMIN_QQ, isMaster: true } }
}

test('RELATIONSHIP 加分：他来找她 → +1，写 note、更新心情与落盘', () => {
  const dataDir = tmp()
  const h = makeBot({ dataDir })
  plugin.setup(h.bot)
  assert.equal(h.bot.shared.relationshipStatus().confidence, 55, '首次安装用默认值，不预扣分')

  const hook = hookOf(h.stages, 'before-turn')
  const ev = masterPrivateEv()
  hook(ev)
  const st = h.bot.shared.relationshipStatus()
  assert.equal(st.confidence, 56, '正面互动 +1')
  assert.equal(st.lastMood, '还不错')
  assert.match(st.notes[0], /他来找我了 \+1 → 56/)

  const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'))
  assert.equal(raw.confidence, 56)
  for (const key of ['confidence', 'lastMood', 'lastInteraction', 'notes']) {
    assert.ok(key in raw, `落盘必须有 ${key}`)
  }

  // 同一条消息只加一次（_scratch 去重）
  hook(ev)
  assert.equal(h.bot.shared.relationshipStatus().confidence, 56)
})

test('RELATIONSHIP 减分：主动开口后一直没接 → -1（真计时器）+ note', async () => {
  const dataDir = tmp()
  // 0.01 分钟 = 600ms，测起来不用等半分钟
  const h = makeBot({ dataDir, cfg: { ignoreAfterMin: 0.01 } })
  plugin.setup(h.bot)

  h.outbounds[0]({ turnCtx: { wakeKind: 'proactive' } }) // 她主动说了一句
  assert.equal(h.bot.shared.relationshipStatus().confidence, 55, '刚开口还没扣')

  const started = Date.now()
  while (Date.now() - started < 4000 && h.bot.shared.relationshipStatus().confidence === 55) await sleep(30)
  const st = h.bot.shared.relationshipStatus()
  assert.equal(st.confidence, 54, '被冷落 -1')
  assert.match(st.lastMood, /有点闷/)
  assert.match(st.notes[0], /他半天没接话 -1 → 54/)
})

test('RELATIONSHIP 上下限：夹在 30–95，非法值回落默认', () => {
  assert.equal(clampConfidence(999), MAX_CONFIDENCE)
  assert.equal(clampConfidence(-999), MIN_CONFIDENCE)
  assert.equal(clampConfidence(72.6), 73)
  assert.equal(clampConfidence('x'), 55)
  assert.equal(normalizeState({ confidence: 999 }).confidence, MAX_CONFIDENCE, '读盘越界也要夹回来')

  const high = normalizeState({ confidence: 95 })
  assert.equal(applyDelta(high, +5).after, MAX_CONFIDENCE, '99 也不许超 95')
  const low = normalizeState({ confidence: 30 })
  assert.equal(applyDelta(low, -5).after, MIN_CONFIDENCE, '再被冷落也不许低于 30')

  const s = normalizeState({ confidence: 88, notes: Array.from({ length: 50 }, (_, i) => `n${i}`) }, { maxNotes: 5 })
  assert.equal(s.notes.length, 5, 'notes 只留 N 条')
  applyDelta(s, 1, { maxNotes: 5 })
  assert.equal(s.notes.length, 5, '加分也不许把 notes 撑爆')
})

test('RELATIONSHIP 衰减：朝 50 走、双向都夹住，且一天只走一次', () => {
  const s90 = normalizeState({ confidence: 90 })
  assert.equal(decayTowardMid(s90, { step: 2 }).after, 88)
  const s40 = normalizeState({ confidence: 40 })
  assert.equal(decayTowardMid(s40, { step: 2 }).after, 42, '低于 50 也要往回走')
  const s50 = normalizeState({ confidence: 50 })
  assert.equal(decayTowardMid(s50, { step: 2 }).after, 50)
  assert.equal(moodOf(88, 0), '开心')

  // 插件层：今天已经衰减过 → 重启不再扣
  const doneDir = tmp()
  seedState(doneDir, {
    confidence: 90, lastMood: '开心', lastInteraction: '10-30 22:00', notes: [],
    lastDecayDate: dateKeyOf(latestDecaySlotAt(Date.now(), 4)),
  })
  const done = makeBot({ dataDir: doneDir })
  plugin.setup(done.bot)
  assert.equal(done.bot.shared.relationshipStatus().confidence, 90, '同一天重启不该重复衰减')

  // 欠了一天的 → 启动补衰减一次
  const oldDir = tmp()
  seedState(oldDir, { confidence: 90, lastMood: '开心', lastInteraction: '10-01 22:00', notes: [], lastDecayDate: '2000-01-01' })
  const old = makeBot({ dataDir: oldDir })
  plugin.setup(old.bot)
  const st = old.bot.shared.relationshipStatus()
  assert.equal(st.confidence, 88, '错过了该有的衰减，启动时补一次')
  assert.ok(st.lastDecayDate, '补完要记下衰减日期，防止反复补')
})

test('RELATIONSHIP 注入文案：格式固定、硬截断、只给主人', () => {
  assert.equal(
    buildRelationshipLine({ confidence: 72, lastMood: '开心' }),
    '你和他现在的关系：confidence=72 心情=开心',
  )
  assert.ok(buildRelationshipLine({ confidence: 72, lastMood: '开心' }, 20).length <= 20, '硬截断')
  assert.equal(buildRelationshipLine({ confidence: 72, lastMood: '开心' }, 10).length, 20, '下限 20 字：再短就没信息量了')

  const dataDir = tmp()
  const h = makeBot({ dataDir, cfg: { injectChars: 120 } })
  plugin.setup(h.bot)
  const hook = hookOf(h.stages, 'before-turn')

  const ev = masterPrivateEv()
  hook(ev)
  assert.equal(ev.hint.length, 1)
  assert.match(ev.hint[0], /^你和他现在的关系：confidence=56 心情=/)

  const groupMember = { chatKey: 'group:20001', isGroup: true, wake: { kind: 'at' }, hint: [], sender: { qq: 10002, isMaster: false } }
  hook(groupMember)
  assert.equal(groupMember.hint.length, 0, '群友的轮次不注入（关系不是群公告）')

  const notWoken = { chatKey: 'group:20001', isGroup: true, wake: null, hint: [], sender: { qq: ADMIN_QQ, isMaster: true } }
  hook(notWoken)
  assert.equal(notWoken.hint.length, 0, '没唤醒的轮次不动')
})

test('RELATIONSHIP 落盘：自己的 json、不跟 growth 日记共用', () => {
  const dataDir = tmp()
  const h = makeBot({ dataDir })
  plugin.setup(h.bot)
  h.bot.shared.relationshipAdjust(+1)

  const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'))
  assert.equal(raw.confidence, 56)
  assert.deepEqual(Object.keys(raw).sort(), ['confidence', 'lastDecayDate', 'lastInteraction', 'lastMood', 'notes'].sort())
  assert.equal(fs.existsSync(path.join(dataDir, 'state', 'growth')), false, 'growth 的日记目录不该被这里创建')
  assert.ok(!fs.existsSync(path.join(dataDir, 'state', 'growth.json')), '两个插件别共用同一个 json')
})

test('RELATIONSHIP 冷落计时：他回来了就取消，不扣分', async () => {
  const dataDir = tmp()
  const h = makeBot({ dataDir, cfg: { ignoreAfterMin: 0.01 } })
  plugin.setup(h.bot)
  h.outbounds[0]({ turnCtx: { wakeKind: 'proactive' } })
  hookOf(h.stages, 'before-turn')(masterPrivateEv()) // 他 600ms 内说话了
  assert.equal(h.bot.shared.relationshipStatus().confidence, 56)

  await sleep(900) // 超过原定窗口
  assert.equal(h.bot.shared.relationshipStatus().confidence, 56, '他回来过，就不该再扣')
})

// ── 每日加分上限（2026-10-31 加）────────────────────────────────
test('RELATIONSHIP 每日加分上限：一天最多 +5，跨天自动重置', () => {
  const state = { confidence: 50, lastMood: '平静', lastInteraction: '', notes: [] }
  const day1 = Date.parse('2026-10-31T10:00:00+08:00')
  for (let i = 0; i < 8; i++) applyDelta(state, 1, { now: day1 })
  assert.equal(state.confidence, 55, '同一天加 8 次也只涨 5 点')

  const day2 = Date.parse('2026-11-01T10:00:00+08:00')
  applyDelta(state, 1, { now: day2 })
  assert.equal(state.confidence, 56, '跨天额度重置，可以再加')

  // 减分不受额度限制
  applyDelta(state, -3, { now: day2 })
  assert.equal(state.confidence, 53, '减分照常生效')
})

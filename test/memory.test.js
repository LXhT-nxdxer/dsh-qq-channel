/**
 * test/memory.test.js — 记忆（事实层）子插件的行为测试。
 *
 * 盯的是任务卡 v1 的四件事 + 两条硬约束：
 *   ① 存（items.json 字段齐全 / 重复合并）  ② 检索（关键词命中 / 会话隔离 / 时间衰减）
 *   ③ 注入（before-turn → ev.hint，≤800 字硬截断，不切碎 emoji）
 *   ④ 归档（三因子公式 / 软删除仍可检索但降权 / 定时器默认关）
 *   硬约束：原子写（rename 失败旧文件完好、无半截临时文件）、文件损坏不覆盖。
 *
 * 全部用 os.tmpdir() 下的临时目录；不启动内核、不碰真实数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/memory/index.js'
import { withDefaults } from '../contracts.js'
import {
  ARCHIVED_WEIGHT,
  HARD_INJECT_MAX_CHARS,
  charLength,
  createMemoryStore,
  decayScore,
  freqScore,
  rankScore,
  relevanceOf,
  timeScore,
  tokenize,
} from '../plugins/memory/store.js'

const DAY = 24 * 60 * 60 * 1000
const GROUP = 'group:123456789'
const OTHER_GROUP = 'group:987654321'

/** 临时目录 + 可控时钟的 store。 */
function makeStore(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qq-memory-${tag}-`))
  const file = path.join(root, 'state', 'memory', 'items.json')
  const clock = { t: Date.UTC(2026, 5, 1, 12, 0, 0) }
  const store = createMemoryStore({ file, now: () => clock.t })
  return { root, file, clock, store }
}

/** 造一个只有契约能力的假 bot（不启内核、不碰 NapCat）。 */
function makeBot(tag, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `qq-memory-bot-${tag}-`))
  const cfg = withDefaults(plugin.configSchema, { enabled: true, dir: path.join(dataDir, 'facts'), ...overrides })
  const hooks = new Map()
  const tools = new Map()
  const disposers = []
  let turn = { chatKey: GROUP }
  const bot = {
    id: 'memory',
    cfg,
    core: { dataDir, toolPrefix: 'mcp__qq__' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(stage, fn) {
      if (!hooks.has(stage)) hooks.set(stage, [])
      hooks.get(stage).push(fn)
    },
    registerTool(name, def) { tools.set(name, def) },
    onDispose(fn) { disposers.push(fn) },
    currentTurn: () => turn,
  }
  plugin.setup(bot)
  return { bot, cfg, hooks, tools, disposers, dataDir, setTurn: (value) => { turn = value } }
}

// ── ① 存 ──────────────────────────────────────────────────────
test('FEAT-1 写入：一条记录字段齐全、落盘可读回；重复事实合并（hits+1、重要度取高）', () => {
  const { file, clock, store } = makeStore('add')
  const { item, merged } = store.add('主人喜欢喝美式咖啡，不加糖', {
    chatKey: GROUP, importance: 4, source: 'tool:remember',
  })
  assert.equal(merged, false)
  assert.match(item.id, /^m-/)
  assert.equal(item.text, '主人喜欢喝美式咖啡，不加糖')
  assert.equal(item.source, 'tool:remember')
  assert.equal(item.chatKey, GROUP)
  assert.equal(item.at, clock.t)
  assert.equal(item.importance, 4)
  assert.equal(item.hits, 0)
  assert.equal(item.archived, false)

  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(raw.version, 1)
  assert.equal(raw.items.length, 1)
  for (const key of ['id', 'text', 'source', 'chatKey', 'at', 'importance', 'hits']) {
    assert.ok(Object.hasOwn(raw.items[0], key), `落盘记录应有 ${key}`)
  }

  const again = store.add('主人喜欢喝美式咖啡，不加糖', { chatKey: GROUP, importance: 2 })
  assert.equal(again.merged, true)
  assert.equal(again.item.hits, 1, '重复提及只累加 hits')
  assert.equal(again.item.importance, 4, '重要度取高')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 1, '不重复建条目')
})

// ── ② 检索 ────────────────────────────────────────────────────
test('FEAT-2 检索：关键词命中、会话不串线、查不到就空（不拿不相关的糊弄）', () => {
  const { store } = makeStore('recall')
  store.add('主人喜欢喝美式咖啡，不加糖', { chatKey: GROUP })
  store.add('主人养了一只叫团子的猫', { chatKey: GROUP })
  store.add('咖啡因过敏，不能喝太多', { chatKey: OTHER_GROUP })

  const rows = store.recall('咖啡', { chatKey: GROUP })
  assert.equal(rows.length, 1, '只返回本会话命中的那条')
  assert.match(rows[0].item.text, /美式咖啡/)
  assert.ok(rows[0].relevance > 0)

  assert.deepEqual(store.recall('量子力学', { chatKey: GROUP }), [], '无关键词命中 = 空数组')
  const other = store.recall('咖啡', { chatKey: OTHER_GROUP })
  assert.equal(other.length, 1)
  assert.match(other[0].item.text, /咖啡因过敏/)
})

test('FEAT-2b 时间衰减：同等相关时新事实排前面；30 天衰减到约 0.37', () => {
  const { clock, store } = makeStore('time')
  store.add('项目代号是白鹭', { chatKey: GROUP, importance: 3, at: clock.t - 120 * DAY })
  store.add('项目代号是青鸟', { chatKey: GROUP, importance: 3, at: clock.t - 1 * DAY })

  const rows = store.recall('项目代号', { chatKey: GROUP })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].relevance, rows[1].relevance, '前提：相关性相同')
  assert.match(rows[0].item.text, /青鸟/, '新的应排前面')
  assert.ok(rows[0].score > rows[1].score)

  assert.ok(Math.abs(timeScore(clock.t - 30 * DAY, clock.t) - Math.exp(-1)) < 1e-9, '30 天 ≈ 0.3679')
  assert.equal(freqScore(0), 0)
  assert.equal(freqScore(19), 1, 'hits=19 时频率因子封顶 1')
  assert.ok(freqScore(5) > 0 && freqScore(5) < 1)
})

test('FEAT-4a 打分公式：0.7×相关 + 0.2×时间 + 0.1×频率；归档整分 ×0.4', () => {
  const now = Date.UTC(2026, 0, 31)
  const item = {
    text: '喜欢喝美式咖啡', at: now - 30 * DAY, lastHitAt: now - 30 * DAY,
    hits: 19, importance: 3, archived: false,
  }
  const tokens = tokenize('咖啡')
  assert.deepEqual(tokens, ['咖啡'], '中文按 2-gram 切')
  assert.equal(relevanceOf(tokens, item.text), 1)

  const expected = 0.7 * 1 + 0.2 * Math.exp(-1) + 0.1 * 1
  assert.ok(Math.abs(rankScore(item, tokens, now) - expected) < 1e-9)
  assert.ok(Math.abs(rankScore({ ...item, archived: true }, tokens, now) - expected * ARCHIVED_WEIGHT) < 1e-9)

  const decayExpected = 0.7 * (3 / 5) + 0.2 * Math.exp(-1) + 0.1 * 1
  assert.ok(Math.abs(decayScore(item, now) - decayExpected) < 1e-9, '归档分用 importance/5 顶替相关')
})

// ── ③ 注入 ────────────────────────────────────────────────────
test('FEAT-3 注入预算：≤800 字硬截断、不切碎 emoji、没记忆不产生空提示', () => {
  const { store } = makeStore('budget')
  for (let i = 0; i < 12; i += 1) {
    store.add(`第${i}条很长的事实：${'甲'.repeat(90)}`, { chatKey: GROUP, importance: 5 })
  }

  const block = store.buildInjection({ chatKey: GROUP, query: '', maxChars: 800, maxItems: 18 })
  assert.ok(block.length > 0)
  assert.ok(charLength(block) <= HARD_INJECT_MAX_CHARS, `实际 ${charLength(block)} 字`)
  assert.ok(block.endsWith('…'), '超出预算时要带截断标记')

  const small = store.buildInjection({ chatKey: GROUP, maxChars: 120, maxItems: 18 })
  assert.ok(charLength(small) <= 120, `小预算也守住：${charLength(small)}`)

  // emoji 截断点落在代理对中间时，不许切出半个字符
  const emoji = makeStore('emoji').store
  emoji.add('😀'.repeat(100), { chatKey: GROUP, importance: 5 })
  const emojiBlock = emoji.buildInjection({ chatKey: GROUP, maxChars: 50, maxItems: 18 })
  assert.ok(charLength(emojiBlock) <= 50)
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  assert.equal(loneSurrogate.test(emojiBlock), false, '不许切出半个 emoji')

  assert.equal(store.buildInjection({ chatKey: OTHER_GROUP, query: '咖啡' }), '', '没记忆 = 空串')
})

// ── ④ 归档 ────────────────────────────────────────────────────
test('FEAT-4b 归档：低分旧事实标 archived、仍可检索但降权；importance=5 永不归档', () => {
  const { file, clock, store } = makeStore('prune')
  const old = store.add('随口提过想去哈尔滨看雪', { chatKey: GROUP, importance: 1, at: clock.t - 200 * DAY })
  const fresh = store.add('想再去哈尔滨看雪', { chatKey: GROUP, importance: 5, at: clock.t - 1 * DAY })
  const core = store.add('重要度 5 的核心事实', { chatKey: GROUP, importance: 5, at: clock.t - 1000 * DAY })

  const result = store.prune({ threshold: 0.2, minAgeDays: 90 })
  assert.equal(result.archived, 1)

  const byId = new Map(store.all().map((row) => [row.id, row]))
  assert.equal(byId.get(old.item.id).archived, true)
  assert.equal(byId.get(fresh.item.id).archived, false)
  assert.equal(byId.get(core.item.id).archived, false, 'importance=5 永不归档')

  const rows = store.recall('哈尔滨', { chatKey: GROUP })
  assert.equal(rows.length, 2, '归档的仍然能被检索到')
  const archivedRow = rows.find((row) => row.item.id === old.item.id)
  const freshRow = rows.find((row) => row.item.id === fresh.item.id)
  assert.equal(archivedRow.item.archived, true)
  assert.ok(archivedRow.score < freshRow.score, '归档条目降权')

  const block = store.buildInjection({ chatKey: GROUP, query: '哈尔滨' })
  assert.match(block, /想再去哈尔滨看雪/)
  assert.equal(block.includes('随口提过想去哈尔滨看雪'), false, '归档条目不再进每轮注入')

  // 落盘的是 archived（不是只存在内存里）
  const reopened = createMemoryStore({ file, now: () => clock.t })
  assert.equal(reopened.all().find((row) => row.id === old.item.id).archived, true)

  // 再次明确提到 → 复活（软删除不是永久拉黑）
  const revived = store.add('随口提过想去哈尔滨看雪', { chatKey: GROUP, importance: 2 })
  assert.equal(revived.merged, true)
  assert.equal(revived.item.archived, false)
})

test('FEAT-4c 归档定时器默认关闭；开启时才注册 onDispose 清理', () => {
  const off = makeBot('timer-off')
  assert.equal(off.disposers.length, 0, '默认不挂任何定时器')

  const on = makeBot('timer-on', { pruneEnabled: true, pruneIntervalHours: 1 })
  assert.equal(on.disposers.length, 1, '开了才挂清理回调')
  assert.doesNotThrow(() => on.disposers[0]())
})

// ── 钩子与工具 ────────────────────────────────────────────────
test('FEAT-1b 钩子：remember 存进本会话；before-turn 拼进 ev.hint（≤800 字）；未唤醒/别的会话不注入', () => {
  const h = makeBot('hook')
  assert.equal(typeof h.tools.get('remember')?.execute, 'function')
  assert.equal(typeof h.tools.get('memory_recall')?.execute, 'function')
  assert.equal(h.tools.has('recall'), false, 'recall 是内核「撤回消息」，不能同名覆盖')

  const saved = h.tools.get('remember').execute({ text: '主人喜欢喝美式咖啡，不加糖', importance: 4 })
  assert.equal(saved.ok, true)
  assert.equal(saved.merged, false)
  assert.equal(saved.chatKey, GROUP)

  const hook = h.hooks.get('before-turn')[0]
  const ev = { chatKey: GROUP, text: '想喝点咖啡提神', wake: { kind: 'at' }, hint: [], stopped: false }
  hook(ev)
  assert.equal(ev.hint.length, 1)
  assert.match(ev.hint[0], /美式咖啡/)
  assert.ok(charLength(ev.hint[0]) <= HARD_INJECT_MAX_CHARS)

  const skipped = [
    { chatKey: GROUP, text: '咖啡', wake: null, hint: [], stopped: false },          // 没唤醒
    { chatKey: GROUP, text: '咖啡', wake: { kind: 'at' }, hint: [], stopped: true }, // 已被拦下
    { chatKey: OTHER_GROUP, text: '咖啡', wake: { kind: 'at' }, hint: [], stopped: false }, // 别的会话
    { chatKey: GROUP, text: '', wake: { kind: 'welcome' }, hint: [], stopped: false },      // 入群欢迎轮
  ]
  for (const evx of skipped) hook(evx)
  assert.deepEqual(skipped.map((evx) => evx.hint.length), [0, 0, 0, 0])

  h.cfg.injectEnabled = false
  const evOff = { chatKey: GROUP, text: '咖啡', wake: { kind: 'at' }, hint: [], stopped: false }
  hook(evOff)
  assert.equal(evOff.hint.length, 0, '控制台关掉注入后不再拼')
})

test('FEAT-2c 工具：memory_recall 按关键词取回并累加 hits（频率因子），查不到返回空', () => {
  const h = makeBot('recall-tool')
  const remember = h.tools.get('remember')
  const memoryRecall = h.tools.get('memory_recall')

  remember.execute({ text: '周末要去爬香山', importance: 3 })
  remember.execute({ text: '不喜欢吃香菜', importance: 2 })

  const first = memoryRecall.execute({ query: '香山' })
  assert.equal(first.ok, true)
  assert.equal(first.count, 1)
  assert.match(first.matches[0].text, /香山/)
  assert.equal(first.matches[0].archived, false)

  const file = path.join(h.dataDir, 'facts', 'items.json')
  const hitsAfter = () => JSON.parse(fs.readFileSync(file, 'utf8')).items.find((item) => item.text.includes('香山')).hits
  assert.equal(hitsAfter(), 1, '被回忆一次 hits+1')

  memoryRecall.execute({ query: '香山' })
  assert.equal(hitsAfter(), 2)

  const miss = memoryRecall.execute({ query: '量子力学' })
  assert.deepEqual(miss.matches, [])
  assert.equal(miss.count, 0)
})

test('工具：拿不到本轮会话时明确报错（别把记忆写到别的会话）', () => {
  const h = makeBot('no-turn')
  h.setTurn(null)
  assert.throws(() => h.tools.get('remember').execute({ text: '不该存进去', importance: 3 }), /拿不到本轮会话/)
  assert.throws(() => h.tools.get('memory_recall').execute({ query: '存' }), /拿不到本轮会话/)
})

// ── 目录 / 配置 / 健壮性 ──────────────────────────────────────
test('目录：cfg.dir 为空时回落到 <dataDir>/state/memory/items.json', () => {
  const h = makeBot('fallback', { dir: '' })
  h.tools.get('remember').execute({ text: '兜底目录测试', importance: 3 })
  const file = path.join(h.dataDir, 'state', 'memory', 'items.json')
  assert.equal(fs.existsSync(file), true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 1)
})

test('配置：默认预算 800、目录 state/memory、归档定时器关；控件都有 group/label/hint', () => {
  const cfg = withDefaults(plugin.configSchema, {})
  assert.equal(plugin.id, 'memory')
  assert.equal(plugin.order, 85)
  assert.equal(cfg.injectMaxChars, 800)
  assert.equal(cfg.dir, 'state/memory')
  assert.equal(cfg.pruneEnabled, false)

  for (const [field, def] of Object.entries(plugin.configSchema)) {
    assert.ok(def.group && def.label, `${field} 缺 group/label`)
    assert.ok(String(def.hint || '').trim().length > 0, `${field} 缺悬停解释`)
    assert.ok(['bool', 'int', 'float', 'str', 'text', 'enum', 'group'].includes(def.type), `${field} 控件类型非法`)
  }
})

test('原子写：rename 失败时旧文件原样、无半截临时文件、内存状态不前进', () => {
  const { file, store } = makeStore('atomic')
  store.add('第一条事实', { chatKey: GROUP })
  const before = fs.readFileSync(file, 'utf8')
  assert.equal(store.all().length, 1)

  const realRename = fs.renameSync
  fs.renameSync = () => {
    const err = new Error('mock: rename denied')
    err.code = 'EIO'
    throw err
  }
  try {
    assert.throws(() => store.add('第二条事实', { chatKey: GROUP }), /mock: rename denied/)
  } finally {
    fs.renameSync = realRename
  }

  assert.equal(fs.readFileSync(file, 'utf8'), before, '旧文件必须原样（不能出现半截 JSON）')
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '失败后不许留下临时文件')
  assert.equal(store.all().length, 1, '写失败时内存状态不前进')
  assert.equal(createMemoryStore({ file }).all().length, 1, '重新读盘也只有 1 条')
})

test('健壮性：items.json 损坏 → 读操作抛错、绝不覆盖原文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-corrupt-'))
  const file = path.join(root, 'items.json')
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const store = createMemoryStore({ file })

  assert.throws(() => store.recall('咖啡', { chatKey: GROUP }), /无法读取\/解析/)
  assert.throws(() => store.add('新事实', { chatKey: GROUP }), /无法读取\/解析/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ 这不是 JSON', '损坏文件不允许被自动覆盖')
  assert.deepEqual(fs.readdirSync(root), ['items.json'])
})

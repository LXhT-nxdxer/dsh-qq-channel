/**
 * test/growth.test.js — 成长日记（plugins/growth）单测。
 *
 * 只测本插件：用临时 dataDir + 最小 bot 夹具，不 boot 整个内核
 * （并行改仓库时，别的插件半成品不该把这两个测试带红；也不碰网络 / NapCat）。
 *
 * 覆盖验收要求的三条：
 *   ① 到点生成：写 `state/growth/YYYY-MM-DD.md`，正文来自 runIsolatedTask，提示词带当天素材；
 *   ② 文件命名：本地 `YYYY-MM-DD.md`，日期按本地时区；
 *   ③ 注入截断：最近 2 天、硬截断 ≤300 字、无日记时返回空串、只给该看的人。
 * 另加：已有当天文件不重写（不重复烧模型）、模型失败落本地兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin, {
  buildDiaryInject,
  buildDiaryPrompt,
  dateKeyOf,
  diaryFileOf,
  latestSlotAt,
  nextRunAt,
  pickRecentDiaries,
  readDayMaterial,
  sanitizeDiaryText,
} from '../plugins/growth/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-growth-'))

/** 最小 bot：只实现 growth 用到的能力。 */
function makeBot({ dataDir, archiveDir = '', cfg = {}, runner } = {}) {
  const stages = []
  const disposers = []
  const shared = {}
  const bot = {
    id: 'growth',
    cfg: { enabled: true, ...cfg },
    log: quiet,
    core: { dataDir, archive: { dir: archiveDir, enabled: Boolean(archiveDir) } },
    shared,
    state: { get: () => undefined },
    dsh: runner ? { runIsolatedTask: runner } : {},
    on(stage, fn) { stages.push([stage, fn]) },
    onOutbound() {},
    onDispose(fn) { disposers.push(fn) },
    currentTurn: () => null,
  }
  return { bot, stages, shared, disposers }
}

const hookOf = (stages, name) => stages.find(([s]) => s === name)?.[1]

test('GROWTH 到点生成：状态目录下写 YYYY-MM-DD.md，正文走模型、清掉标题', async () => {
  const dataDir = tmp()
  const day = new Date(2026, 9, 31, 23, 0, 0) // 本地 2026-10-31 23:00
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(
    path.join(archiveDir, 'group_20001.jsonl'),
    `${JSON.stringify({ dir: 'in', ts: day.getTime() - 60_000, sender: { name: '阿甲' }, text: '今天好累啊' })}\n`,
  )
  const prompts = []
  const runner = async ({ prompt }) => {
    prompts.push(prompt)
    return { ok: true, text: `\`\`\`\n# 2026-10-31 日记\n今天阿甲说好累，我劝了两句。${'好'.repeat(260)}\n\`\`\`` }
  }
  const { bot } = makeBot({ dataDir, archiveDir, runner })
  plugin.setup(bot)

  const r = await bot.shared.growthSync({ day })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'model', '正常路径应走模型')
  const file = path.join(dataDir, 'state', 'growth', '2026-10-31.md')
  assert.equal(r.file, file, '文件名必须是本地 YYYY-MM-DD.md')
  assert.ok(fs.existsSync(file), '到点应当落盘')

  const text = fs.readFileSync(file, 'utf8').trim()
  assert.ok(text.length <= 400, `日记硬截断到 400 字以内，实际 ${text.length}`)
  assert.ok(!text.startsWith('#'), '模型给的「# 日期 日记」标题应被清掉')
  assert.ok(text.includes('阿甲'), '正文应保留模型写的内容')

  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes('阿甲: 今天好累啊'), '提示词要带当天留档素材（昵称: 正文）')
  assert.match(prompts[0], /2026-10-31/)
  assert.match(prompts[0], /200–400 个字/, '提示词要写清目标字数')
})

test('GROWTH 调度：下一次是当天 23:00，过点就顺延到明天；status 与定时器同源', () => {
  const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi, 0, 0).getTime()
  assert.equal(nextRunAt(at(2026, 10, 31, 10, 0), 23, 0), at(2026, 10, 31, 23, 0))
  assert.equal(nextRunAt(at(2026, 10, 31, 23, 0), 23, 0), at(2026, 11, 1, 23, 0), '刚好到点也要排明天，不能立刻重跑')
  assert.equal(nextRunAt(at(2026, 10, 31, 23, 30), 23, 0), at(2026, 11, 1, 23, 0))
  assert.equal(latestSlotAt(at(2026, 10, 31, 3, 0), 23, 0), at(2026, 10, 30, 23, 0), '凌晨 3 点：最近该有的是昨晚那篇')
  assert.equal(latestSlotAt(at(2026, 10, 31, 23, 5), 23, 0), at(2026, 10, 31, 23, 0))

  const { bot } = makeBot({ dataDir: tmp() })
  plugin.setup(bot)
  const st = bot.shared.growthStatus()
  assert.equal(st.enabled, true)
  const next = new Date(st.nextAt)
  assert.equal(next.getHours(), 23)
  assert.equal(next.getMinutes(), 0)
  assert.ok(st.nextAt > Date.now(), '下一次必须是将来的时间')
})

// ── 控制台热开 / 补写（2026-10-31 真机 bug）──────────────────────
test('GROWTH enabled 从 false 变 true：定时器常驻，关着 tick 不写文件不调模型，热改时间后下一个 tick 就写', async () => {
  const dataDir = tmp()
  const now = new Date(2026, 9, 31, 16, 36, 0) // 假时间：10-31 16:36
  let calls = 0
  const { bot } = makeBot({
    dataDir,
    cfg: { enabled: false, hour: 23, minute: 0 }, // 启动时关着、时间是 23:00
    runner: async () => { calls += 1; return { ok: true, text: '今天被逗笑了。'.repeat(20) } },
  })
  plugin.setup(bot)
  assert.equal(typeof bot.shared.growthTick, 'function', '关着的时候定时器也要挂上')

  // ① 关着：tick 只做判断，不建 state/growth、不调模型
  const off = await bot.shared.growthTick(now.getTime())
  assert.equal(off.skipped, 'disabled')
  assert.equal(calls, 0, '关着不许调模型')
  assert.equal(fs.existsSync(path.join(dataDir, 'state', 'growth')), false, '关着不许建目录/写文件')

  // ② 控制台热开 + 把写日记时间改到「当前时刻之前」（内核只原地改 bot.cfg，不重跑 setup）
  bot.cfg.enabled = true
  bot.cfg.hour = 16
  bot.cfg.minute = 36
  const on = await bot.shared.growthTick(now.getTime())
  assert.equal(on.ok, true, '开了之后下一个 tick 要真的写')
  assert.equal(calls, 1)
  const file = path.join(dataDir, 'state', 'growth', '2026-10-31.md')
  assert.ok(fs.existsSync(file), '按热改后的新时间补写当天这一篇')
  assert.ok(fs.readFileSync(file, 'utf8').includes('被逗笑'), '正文要落盘')

  // ③ 再 tick：同一天已经有文件 → 不写第二篇
  const again = await bot.shared.growthTick(now.getTime())
  assert.equal(again.skipped, 'exists')
  assert.equal(calls, 1, '一天不许写两篇')
})

test('GROWTH catchUp：启动补「最近该有」的那篇，同一天只补一次，绝不写第二篇', async () => {
  const dataDir = tmp()
  const dir = path.join(dataDir, 'state', 'growth')
  fs.mkdirSync(dir, { recursive: true }) // 目录已存在 = 不是首次安装
  const now = new Date(2026, 9, 31, 8, 0, 0) // 10-31 早上 8 点，23:00 还没到 → 该补 10-30 那篇
  let calls = 0
  const { bot } = makeBot({
    dataDir,
    cfg: { hour: 23, minute: 0, catchUp: true },
    runner: async () => { calls += 1; return { ok: true, text: '昨天的事。'.repeat(40) } },
  })
  plugin.setup(bot)

  const first = await bot.shared.growthTick(now.getTime())
  assert.equal(first.ok, true, '错过的那篇要补')
  assert.equal(calls, 1)
  const missed = path.join(dir, '2026-10-30.md')
  assert.ok(fs.existsSync(missed), '补写的是最近该有的 10-30 那篇')
  assert.equal(fs.existsSync(path.join(dir, '2026-10-31.md')), false, '当天还没到点，不许提前写今天')

  // 第二轮：文件已在 → 不重写、不再调模型；这一天永远只有一篇
  const second = await bot.shared.growthTick(now.getTime())
  assert.equal(second.skipped, 'exists')
  assert.equal(calls, 1, 'catchUp 不许重复写同一天')
})

test('GROWTH 注入：最近两天、硬截断 ≤300 字、不读更早的、没日记返回空串', () => {
  const dataDir = tmp()
  const dir = path.join(dataDir, 'state', 'growth')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-10-31.md'), '甲'.repeat(500))
  fs.writeFileSync(path.join(dir, '2026-10-30.md'), '乙'.repeat(500))
  fs.writeFileSync(path.join(dir, '2026-10-28.md'), '丙'.repeat(500))
  const today = '2026-10-31'

  assert.deepEqual(pickRecentDiaries(dir, { today, days: 2 }).map((d) => d.key), ['2026-10-31', '2026-10-30'])

  const text = buildDiaryInject({ dir, today, days: 2, maxChars: 300 })
  assert.ok(text.length > 0)
  assert.ok(text.length <= 300, `注入必须硬截断到 300 字以内，实际 ${text.length}`)
  assert.ok(text.endsWith(']'), '预算够的时候要保住括号结构，不能被截断成半块')
  assert.ok(text.includes('2026-10-31') && text.includes('2026-10-30'), '两天都要带标签')
  assert.ok(!text.includes('丙'), '第三天的日记不该被读进来')

  // 目录还不存在 / 一篇都没有 → 空串（调用方不该 push 空块）
  assert.equal(buildDiaryInject({ dir: path.join(dataDir, 'nope'), today }), '')

  // 预算再小也不许超（硬截断是契约要求）
  const tight = buildDiaryInject({ dir, today, days: 2, maxChars: 60 })
  assert.ok(tight.length <= 60, `预算 60 时也必须 ≤60，实际 ${tight.length}`)
})

test('GROWTH before-turn：只给该看的人注入、同一轮不重复、未唤醒不动', () => {
  const dataDir = tmp()
  const dir = path.join(dataDir, 'state', 'growth')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${dateKeyOf()}.md`), '今天挺好。'.repeat(60))
  const { bot, stages } = makeBot({ dataDir, cfg: { injectScope: 'masterPrivate' } })
  plugin.setup(bot)
  const hook = hookOf(stages, 'before-turn')
  assert.equal(typeof hook, 'function', '必须挂 before-turn（唯一允许拼 prompt 的阶段）')

  const masterPrivate = { wake: { kind: 'private' }, hint: [], isGroup: false, sender: { isMaster: true } }
  hook(masterPrivate)
  assert.equal(masterPrivate.hint.length, 1)
  assert.ok(masterPrivate.hint[0].length <= 300, '注入块 ≤300 字')
  hook(masterPrivate)
  assert.equal(masterPrivate.hint.length, 1, '同一轮重复调用不该 push 两次')

  const groupMember = { wake: { kind: 'at' }, hint: [], isGroup: true, sender: { isMaster: false } }
  hook(groupMember)
  assert.equal(groupMember.hint.length, 0, '默认只在主人私聊注入，群友的轮次不带')

  const groupMaster = { wake: { kind: 'at' }, hint: [], isGroup: true, sender: { isMaster: true } }
  hook(groupMaster)
  assert.equal(groupMaster.hint.length, 0, "scope=masterPrivate 时群里主人也不带")

  const notWoken = { wake: null, hint: [], isGroup: false, sender: { isMaster: true } }
  hook(notWoken)
  assert.equal(notWoken.hint.length, 0, '没唤醒的消息不做注入')
})

test('GROWTH 幂等与兜底：当天已有文件不重调模型；模型失败也落一篇本地兜底', async () => {
  const dataDir = tmp()
  const day = new Date(2026, 9, 31, 10, 0, 0)
  const first = makeBot({ dataDir, runner: async () => ({ ok: true, text: '今天过得挺好。'.repeat(30) }) })
  plugin.setup(first.bot)
  const written = await first.bot.shared.growthSync({ day })
  assert.equal(written.ok, true)

  let calls = 0
  const second = makeBot({ dataDir, runner: async () => { calls += 1; return { ok: true, text: '不该被调用' } } })
  plugin.setup(second.bot)
  const again = await second.bot.shared.growthSync({ day })
  assert.equal(again.skipped, 'exists', '当天已有日记应当跳过')
  assert.equal(calls, 0, '跳过时不许调模型')

  const third = makeBot({ dataDir, runner: async () => { throw new Error('模型挂了') } })
  plugin.setup(third.bot)
  const r = await third.bot.shared.growthSync({ day, force: true })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'fallback', '模型失败要走本地兜底，日记不能空着')
  assert.ok(r.chars > 0)
  assert.ok(fs.readFileSync(diaryFileOf(dataDir, '2026-10-31'), 'utf8').trim().length > 0)
})

test('GROWTH 纯函数：清洗模型输出 / 读当天素材 / 提示词兜底', () => {
  // 清洗：代码围栏 + 标题 + 日期行都去掉，空行压紧，超长硬截断
  const dirty = '```markdown\n## 日记\n2026-10-31\n\n\n今天被逗笑了\n```'
  assert.equal(sanitizeDiaryText(dirty, 400), '今天被逗笑了')
  assert.equal(sanitizeDiaryText('长'.repeat(900), 400).length, 400)
  assert.equal(sanitizeDiaryText('   ', 400), '')

  // 素材：只取当天、按时间正序、剥 CQ 码、超预算保留最新的
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(archiveDir, { recursive: true })
  const day = new Date(2026, 9, 31, 12, 0, 0)
  const rows = [
    { dir: 'in', ts: day.getTime() - 3 * 3600_000, sender: { name: '阿甲' }, text: '[CQ:at,qq=1] 早上好' },
    { dir: 'in', ts: day.getTime() - 30_000, sender: { name: '阿乙' }, text: '晚上吃啥' },
    { dir: 'in', ts: day.getTime() - 2 * 86400_000, sender: { name: '阿丙' }, text: '前天的话' },
    { dir: 'out', ts: day.getTime() - 20_000, text: '你猜' },
  ]
  fs.writeFileSync(path.join(archiveDir, 'group_20001.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'))
  const material = readDayMaterial({ archiveDir, start: day.getTime() - 86400_000, end: day.getTime() + 86400_000, maxChars: 200 })
  assert.ok(material.includes('阿甲: 早上好'), '应剥掉 CQ 码只留正文')
  assert.ok(material.includes('阿乙: 晚上吃啥'))
  assert.ok(material.includes('我: 你猜'), '自己说过的话也算素材')
  assert.ok(!material.includes('前天的话'), '不在当天的不要')
  assert.ok(material.indexOf('阿甲') < material.indexOf('阿乙'), '素材按时间正序')

  // 安静的一天：提示词也要能写（别因为没素材就不生成）
  const p = buildDiaryPrompt({ dateLabel: '2026-10-31', material: '', minChars: 200, maxChars: 400 })
  assert.match(p, /安安静静/)
  assert.match(p, /200–400 个字/)
})

/**
 * test/group-repeat.test.js — 复读 +1 子插件行为测试。
 *
 * 规则（2026-10-31 改）：群里出现「连续同句、不同人」= QQ 冒出了 +1 按钮 → 她点一下。
 *
 * 覆盖：
 *   · 两个人连发同一句 → 第 2 条就点
 *   · 同一个人刷 4 条不算；第 2 个人加入才点
 *   · 每群 60 秒最多一次；跨群互不影响
 *   · 中间插一句别的 → 链断，重新计数
 *   · 两条间隔超过窗口 → 不算同一条链
 *   · 私聊永不触发；她自己发的消息不计入
 *   · 被 @ 的那条不参与，并且打断链
 *   · 斜杠命令 / 超长 / 空文本不参与
 *   · 概率 0 不点、100 一定点；指纹归一化
 *
 * 写法：直接打桩契约里的 `bot` 能力对象（开发指南建议），不启动内核、不碰 NapCat。
 * 冷却通过 `node:test` 的 Date mock 控制。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import plugin, { advanceChain, exactKey, isRepeatableText, repeatKey, rollHit } from '../plugins/group-repeat/index.js'
import { withDefaults } from '../contracts.js'

const GROUP_ID = 20001
const GROUP_KEY = `group:${GROUP_ID}`
const SELF_QQ = 999999

/** 最小 bot 桩：只实现本插件用到的契约成员（cfg / state / deliver / on / selfId）。 */
function makeBot(overrides = {}) {
  const cfg = withDefaults(plugin.configSchema, { enabled: true, ...overrides })
  const handlers = []
  const delivered = []
  const states = new Map()

  const bot = {
    id: plugin.id,
    cfg,
    selfId: SELF_QQ,
    contractVersion: 1,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on(stage, fn) { handlers.push({ stage, fn }) },
    onOutbound() {},
    deliver: async (target, text, opts = {}) => {
      delivered.push({ target, text, opts })
    },
    sendMedia() {},
    state: {
      get(chatKey) {
        let st = states.get(chatKey)
        if (!st) {
          st = {}
          states.set(chatKey, st)
        }
        return st
      },
    },
    napcat: { selfId: SELF_QQ },
  }

  plugin.setup(bot)
  return {
    bot,
    cfg,
    delivered,
    states,
    handlers,
    async emit(ev) {
      for (const h of handlers) await h.fn(ev)
    },
  }
}

function groupEvent({ text = '草', userId = 10002, messageId = 1, groupId = GROUP_ID } = {}) {
  return {
    chatKey: `group:${groupId}`,
    isGroup: true,
    groupId,
    messageId,
    sender: { qq: userId, name: `群友${userId}`, card: null, isMaster: false },
    time: Date.now(),
    text,
    rawSegments: [],
    mentionedSelf: false,
    replyToId: null,
    images: [],
    files: [],
    cards: [],
    wake: null,
    hint: [],
    imageParts: [],
    imagePaths: [],
    historyBlock: '',
    rawText: text,
    stopped: false,
    stopReason: '',
    _scratch: Object.create(null),
    turnCtx: null,
  }
}

function privateEvent({ text = '草', userId = 10002, messageId = 1 } = {}) {
  return {
    ...groupEvent({ text, userId, messageId }),
    chatKey: `private:${userId}`,
    isGroup: false,
    groupId: null,
  }
}

// ── 核心：两个人连发同一句就点 ──────────────────────────────────
test('GROUP-REPEAT 两个人连发同一句 → 第 2 条就点（等于出现 +1）', async () => {
  const h = makeBot()
  await h.emit(groupEvent({ text: '笑死', userId: 10002, messageId: 1 }))
  assert.equal(h.delivered.length, 0, '只有一条时不点（还没有 +1）')

  await h.emit(groupEvent({ text: '笑死', userId: 10003, messageId: 2 }))
  assert.equal(h.delivered.length, 1, '第二个人发同一句 → 点 +1')
  assert.deepEqual(h.delivered[0], { target: GROUP_KEY, text: '笑死', opts: { turnCtx: null } })
})

test('GROUP-REPEAT 同一个人刷 4 条不算；第 2 个人加入才点', async () => {
  const h = makeBot()
  for (let i = 0; i < 4; i++) {
    await h.emit(groupEvent({ text: '笑死', userId: 10002, messageId: i + 1 }))
  }
  assert.equal(h.delivered.length, 0, '自己连刷不给 +1')

  await h.emit(groupEvent({ text: '笑死', userId: 10003, messageId: 9 }))
  assert.equal(h.delivered.length, 1, '换一个人重复 → 点')
})

test('GROUP-REPEAT 每群 60 秒最多一次；冷却过后可以再点', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  return (async () => {
    const h = makeBot()
    await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
    await h.emit(groupEvent({ text: '笑死', userId: 2, messageId: 2 }))
    assert.equal(h.delivered.length, 1)

    await h.emit(groupEvent({ text: '离谱', userId: 1, messageId: 3 }))
    await h.emit(groupEvent({ text: '离谱', userId: 2, messageId: 4 }))
    assert.equal(h.delivered.length, 1, '60 秒内不再点')

    t.mock.timers.tick(61_000)
    await h.emit(groupEvent({ text: '离谱', userId: 1, messageId: 5 }))
    await h.emit(groupEvent({ text: '离谱', userId: 2, messageId: 6 }))
    assert.equal(h.delivered.length, 2, '冷却过后可以再点')
  })()
})

test('GROUP-REPEAT 中间插一句别的 → 链断，要重新凑', async () => {
  const h = makeBot()
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: '别的', userId: 2, messageId: 2 }))
  await h.emit(groupEvent({ text: '笑死', userId: 3, messageId: 3 }))
  assert.equal(h.delivered.length, 0, '被别的消息打断，不算连续')

  await h.emit(groupEvent({ text: '笑死', userId: 4, messageId: 4 }))
  assert.equal(h.delivered.length, 1, '重新连续 2 条才点')
})

test('GROUP-REPEAT 两条间隔超过窗口 → 不算同一条链', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  return (async () => {
    const h = makeBot({ windowSec: 30 })
    await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
    t.mock.timers.tick(31_000)
    await h.emit(groupEvent({ text: '笑死', userId: 2, messageId: 2 }))
    assert.equal(h.delivered.length, 0, '隔了 31 秒，不算连续')

    t.mock.timers.tick(1_000)
    await h.emit(groupEvent({ text: '笑死', userId: 3, messageId: 3 }))
    assert.equal(h.delivered.length, 1, '紧跟着的第 3 条才凑成新链')
  })()
})

test('GROUP-REPEAT 冷却按群隔离：A 群点过不影响 B 群', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  return (async () => {
    const h = makeBot()
    await h.emit(groupEvent({ text: '笑死', userId: 1, groupId: 111, messageId: 1 }))
    await h.emit(groupEvent({ text: '笑死', userId: 2, groupId: 111, messageId: 2 }))
    assert.equal(h.delivered.length, 1)

    await h.emit(groupEvent({ text: '笑死', userId: 1, groupId: 222, messageId: 3 }))
    await h.emit(groupEvent({ text: '笑死', userId: 2, groupId: 222, messageId: 4 }))
    assert.equal(h.delivered.length, 2, '另一个群照常点')
  })()
})

test('GROUP-REPEAT 私聊刷再多也不点', async () => {
  const h = makeBot()
  for (let i = 0; i < 5; i++) {
    await h.emit(privateEvent({ text: '笑死', userId: 10002 + (i % 2), messageId: i + 1 }))
  }
  assert.equal(h.delivered.length, 0)
})

test('GROUP-REPEAT 她自己发的消息不计入', async () => {
  const h = makeBot()
  await h.emit(groupEvent({ text: '笑死', userId: SELF_QQ, messageId: 1 }))
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 2 }))
  assert.equal(h.delivered.length, 0, '自机那条不进链')
  await h.emit(groupEvent({ text: '笑死', userId: 2, messageId: 3 }))
  assert.equal(h.delivered.length, 1)
})

test('GROUP-REPEAT 被 @ 的那条不参与，而且打断链', async () => {
  const h = makeBot()
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))

  const at = groupEvent({ text: '笑死', userId: 2, messageId: 2 })
  at.mentionedSelf = true
  await h.emit(at)
  assert.equal(h.delivered.length, 0, '@ 她的那条不算进链')

  await h.emit(groupEvent({ text: '笑死', userId: 3, messageId: 3 }))
  assert.equal(h.delivered.length, 0, '打断后只有 1 条，不够')
  await h.emit(groupEvent({ text: '笑死', userId: 4, messageId: 4 }))
  assert.equal(h.delivered.length, 1, '重新凑够 2 条才点')
})

test('GROUP-REPEAT 斜杠命令 / 超长 / 空文本不参与', async () => {
  const h = makeBot({ maxChars: 10 })
  for (const text of ['/help', '这是一句特别特别长的公告不该参与', '   ']) {
    await h.emit(groupEvent({ text, userId: 1, messageId: 1 }))
    await h.emit(groupEvent({ text, userId: 2, messageId: 2 }))
  }
  assert.equal(h.delivered.length, 0)
})

test('GROUP-REPEAT 概率 0 不点；100 一定点', async () => {
  const h0 = makeBot({ repeatPercent: 0 })
  await h0.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h0.emit(groupEvent({ text: '笑死', userId: 2, messageId: 2 }))
  assert.equal(h0.delivered.length, 0)

  const h1 = makeBot({ repeatPercent: 100 })
  await h1.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h1.emit(groupEvent({ text: '笑死', userId: 2, messageId: 2 }))
  assert.equal(h1.delivered.length, 1)
})

// ── 纯函数边界 ──────────────────────────────────────────────────
test('GROUP-REPEAT 指纹归一化：空白/标点/全角/大小写算同一句', () => {
  assert.equal(repeatKey('笑死！！'), repeatKey('笑死'))
  assert.equal(repeatKey('  A b '), repeatKey('ab'))
  assert.equal(repeatKey('笑死'), repeatKey('笑 死'))
  assert.notEqual(repeatKey('哈'), repeatKey('哈哈哈'))
})

test('GROUP-REPEAT advanceChain：同人连发不涨、换人 +1、换句重置、超时重置', () => {
  const t0 = 1_800_000_000_000
  const a = advanceChain(null, { key: 'k', sender: 1 }, t0, 120_000)
  assert.deepEqual({ streak: a.streak, senders: a.senders }, { streak: 1, senders: [1] })

  const same = advanceChain(a, { key: 'k', sender: 1 }, t0 + 1000, 120_000)
  assert.equal(same.streak, 1, '同一个人不涨')

  const other = advanceChain(same, { key: 'k', sender: 2 }, t0 + 2000, 120_000)
  assert.equal(other.streak, 2, '换人 +1')
  assert.deepEqual(other.senders, [1, 2])

  const reset = advanceChain(other, { key: 'z', sender: 3 }, t0 + 3000, 120_000)
  assert.equal(reset.streak, 1, '换句重置')

  const expired = advanceChain(other, { key: 'k', sender: 4 }, t0 + 200_000, 120_000)
  assert.equal(expired.streak, 1, '超时重置')
})

test('GROUP-REPEAT 契约字段与默认值', () => {
  assert.equal(plugin.id, 'group-repeat')
  assert.equal(plugin.title, '复读 +1')
  assert.equal(typeof plugin.setup, 'function')

  const cfg = withDefaults(plugin.configSchema)
  assert.equal(cfg.enabled, false, '默认关：要用户在控制台显式打开')
  assert.equal(cfg.minCount, 2, '+1 是第二条就点')
  assert.equal(cfg.repeatPercent, 100, '看到就点')
  assert.equal(cfg.windowSec, 120)
  assert.equal(cfg.cooldownSec, 60)

  for (const [field, def] of Object.entries(plugin.configSchema)) {
    assert.ok(def.group && def.label, `${field} 缺 group/label`)
    assert.ok(String(def.hint || '').trim().length > 0, `${field} 缺 hint`)
  }
})

test('GROUP-REPEAT rollHit 边界', () => {
  assert.equal(rollHit(100, () => 0.999), true)
  assert.equal(rollHit(0, () => 0), false)
  assert.equal(rollHit(50, () => 0.4999), true)
  assert.equal(rollHit(50, () => 0.5), false)
})

// ── 真机回归（2026-11-01）：占位符不算一句话 ─────────────────────
test('GROUP-REPEAT 群友连发表情包（[表情]）不会被复读成一行字', async () => {
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: '[表情]', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: '[表情]', userId: 2, messageId: 2 }))
  assert.equal(h.delivered.length, 0, '两张表情包不是"同一句话"，不能跟发 [表情] 这行字')
})

test('GROUP-REPEAT [图片]/[动画表情]/CQ 码同样不算', async () => {
  for (const text of ['[图片]', '[动画表情]', '[CQ:face,id=178]', '[CQ:image,file=abc.jpg]']) {
    const h = makeBot({ repeatPercent: 100 })
    await h.emit(groupEvent({ text, userId: 1, messageId: 1 }))
    await h.emit(groupEvent({ text, userId: 2, messageId: 2 }))
    assert.equal(h.delivered.length, 0, `${text} 不该被复读`)
  }
})

test('GROUP-REPEAT 句子里带表情仍可复读（去掉占位还剩真字）', async () => {
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: '笑死[表情]', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: '笑死[表情]', userId: 2, messageId: 2 }))
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].text, '笑死[表情]', '发原文，不做改写')
})

test('GROUP-REPEAT isRepeatableText 纯函数边界', () => {
  assert.equal(isRepeatableText('笑死'), true)
  assert.equal(isRepeatableText('笑死[表情]'), true)
  assert.equal(isRepeatableText('[表情]'), false)
  assert.equal(isRepeatableText('[表情][表情]'), false)
  assert.equal(isRepeatableText('[CQ:face,id=1]'), false)
  assert.equal(isRepeatableText('   '), false)
  assert.equal(isRepeatableText(''), false)
})

// ── 真机回归（2026-11-02）：协议端状态广播不是人在说话 ──────────
/**
 * 事故：群里有人敲 SnowLuma 的 `#sl`，几台机器人各自回一条一模一样的
 * 「SnowLuma 状态 / 版本: … / 运行时长: …」。这几条凑成 +1 链，她去跟发一条，
 * 于是看起来像"她接了这个命令"（2026-11-01 17:51:16 实测）。
 * 这类是协议端自动应答，不是群友的聊天内容，必须不参与复读链。
 */
test('GROUP-REPEAT 多台机器刷「SnowLuma 状态」不跟发', async () => {
  const status = 'SnowLuma 状态\n版本: 2.3.2\n平台: win32-x64\n运行时长: 30分钟 1秒'
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: status, userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: status, userId: 2, messageId: 2 }))
  await h.emit(groupEvent({ text: status, userId: 3, messageId: 3 }))
  assert.equal(h.delivered.length, 0, '协议端状态广播不能被她复读')
})

test('GROUP-REPEAT 状态广播还要打断链，不能把前后两条真话接起来', async () => {
  const status = 'SnowLuma 状态\n版本: 2.2.1\n平台: win32-x64\n运行时长: 32分钟 3秒'
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: status, userId: 2, messageId: 2 }))
  await h.emit(groupEvent({ text: '笑死', userId: 3, messageId: 3 }))
  assert.equal(h.delivered.length, 0, '中间插了状态广播 → 链断，不能凑成 +1')
})

test('GROUP-REPEAT 普通聊天里提到 snowluma 不算广播', async () => {
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: 'snowluma 这插件挺好用的', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: 'snowluma 这插件挺好用的', userId: 2, messageId: 2 }))
  assert.equal(h.delivered.length, 1, '只是聊到名字，仍按正常 +1 处理')
})

// ── 同一现场的上一层：`#sl` 这条命令本身也不能被复读 ────────────
test('GROUP-REPEAT 命令形态（#sl / !help / .status）不参与复读', async () => {
  for (const text of ['#sl', '＃sl', '!help', '.status', '//查下E盘', '/help']) {
    const h = makeBot({ repeatPercent: 100 })
    await h.emit(groupEvent({ text, userId: 1, messageId: 1 }))
    await h.emit(groupEvent({ text, userId: 2, messageId: 2 }))
    assert.equal(h.delivered.length, 0, `${text} 是命令形态，不能被复读`)
  }
})

// ── 2026-11-02 主人要求：QQ 上出现 +1 图标才点（严格同字）──────────────
test('GROUP-REPEAT 严格同字：标点差一点就不算（QQ 不会显示 +1）', async () => {
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: '笑死！', userId: 2, messageId: 2 }))
  assert.equal(h.delivered.length, 0, '「笑死」和「笑死！」在 QQ 上是两条，不显示 +1')
})

test('GROUP-REPEAT 严格同字：一模一样才点（含首尾空格无所谓）', async () => {
  const h = makeBot({ repeatPercent: 100 })
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: '  笑死  ', userId: 2, messageId: 2 }))
  assert.equal(h.delivered.length, 1, '整句相同（只差首尾空格）→ QQ 显示 +1 → 她点')
})

test('GROUP-REPEAT 关掉「严格同字」才回到老的宽松口径', async () => {
  const h = makeBot({ repeatPercent: 100, exactMatch: false })
  await h.emit(groupEvent({ text: '笑死', userId: 1, messageId: 1 }))
  await h.emit(groupEvent({ text: '笑死！', userId: 2, messageId: 2 }))
  assert.equal(h.delivered.length, 1, '宽松模式：忽略标点后算同一句')
})

test('GROUP-REPEAT exactKey 只去首尾空白和零宽字符', () => {
  assert.equal(exactKey(' 笑死 '), '笑死')
  assert.equal(exactKey('笑死\u200b'), '笑死')
  assert.notEqual(exactKey('笑死'), exactKey('笑死！'))
  assert.notEqual(exactKey('笑死'), exactKey('笑 死'))
})

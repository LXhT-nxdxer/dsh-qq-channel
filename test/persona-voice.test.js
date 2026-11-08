/**
 * test/persona-voice.test.js — `plugins/persona-voice`（人设句池 / 拆条，order 40）的专属测试。
 *
 * 分工（只补缺口，不重复既有套件）：
 *  · test/audit-voice-spontaneous.test.js 已覆盖：句池三级回落的端到端 poke 回话、改文件热读、
 *    quoteEnforce 抹掉「引用刚触发消息」、拆条端到端两条、插件热关时 pick() 返回空。
 *  · test/audit-quote-turn.test.js 已覆盖：引用锚跟随 DSH turn/start → turn/end（A/B/C 引对人）。
 *  · test/audit-wake-commands.test.js 已覆盖：人设 wake.txt 与配置词表的合并 / 来源快照。
 *  · 本文件补：句池解析细节（分节 / 中文节名别名 / 老格式 / 空文件 / 坏文件 / 空节）、
 *    优先级（人设 > _default > 内置兜底）、mtime+size 缓存语义、activePersona 热切换与缺失降级、
 *    人设指针切换、pickSplitPoint 边界（不拦腰 / 不丢字）、拆条第二条不再拆、
 *    quoteEnforce 达门槛保留引用 / 关闭时不约束。
 *
 * 全部走 test/helpers.mjs 的 mock 内核（autoConnect=false），不启真 DSH / NapCat。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { pickSplitPoint } from '../kernel/format.js'
import plugin, { collapseParallel, hasKaomoji, pickKaomoji, replaceBanned } from '../plugins/persona-voice/index.js'
import {
  bootKernel, emitRaw, waitFor, tmpDir,
  ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent,
} from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 源码 LINES_FALLBACK 的契约值（人设 / 底池都没有时兜底；改了要同步本表）。 */
const BUILTIN = {
  poke: ['嗯？', '在', '怎么了？', '别戳', '有事说事'],
  callAck: ['在', '嗯？', '怎么了？', '听着呢'],
  imageAck: ['在画了，稍等'],
  imageBusy: ['画不过来，等会儿再叫'],
  imageFail: ['画失败了…等会儿再试'],
}

/**
 * mock 内核：关合并；humanizer 的按字数延迟/错字清零（默认会睡 1~4 秒，拖慢断言）。
 * persona-voice 的配置按用例覆盖。
 */
async function boot(t, { dataDir, pacingStyle = null, outbound = null, persona = {}, extraPluginConfig = {} } = {}) {
  const h = await bootKernel({
    dataDir,
    config: {
      pacing: { merge: { enabled: false }, ...(pacingStyle ? { reply: { style: pacingStyle } } : {}) },
      ...(outbound ? { outbound } : {}),
      pluginConfig: {
        'link-parser': { enabled: false },
        humanizer: { delayPerChar: 0, typoPercent: 0 },
        'persona-voice': { personaDir: 'personas', ...persona },
        'gate-wake': { adminQq: ADMIN_QQ },
        ...extraPluginConfig,
      },
    },
  })
  t.after(() => h.dispose())
  // 临时数据目录用完就删（dispose 先注册先跑；删不掉也不影响断言）
  t.after(() => {
    try { fs.rmSync(h.dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  return h
}

/** 临时数据目录 + 人设文件（可选 workspace 投递文件）→ 起 mock 内核；用完删目录。 */
async function setupPersona(t, { files = {}, workspaceFiles = null, persona = {}, ...rest } = {}) {
  const dataDir = tmpDir('persona-voice')
  const personaDir = path.join(dataDir, 'personas')
  fs.mkdirSync(personaDir, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(personaDir, name), text)
  if (workspaceFiles) {
    const ws = path.join(dataDir, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    for (const [name, text] of Object.entries(workspaceFiles)) fs.writeFileSync(path.join(ws, name), text)
  }
  const h = await boot(t, { dataDir, persona, ...rest })
  return { h, dataDir, personaDir }
}

const pick = (h, section) => h.kernel.shared.linesPool.pick(section)
const source = (h) => h.kernel.shared.linesPool.source()

test('句池解析：## 分节、中文节名别名、BOM/CRLF、注释都不进食', async (t) => {
  const { h } = await setupPersona(t, {
    persona: { activePersona: 'tester' },
    files: {
      'tester.lines.txt': '\uFEFF# 顶部说明（注释不进池）\r\n'
        + '## poke\r\n专属戳A\r\n专属戳B\r\n# 段内注释\r\n'
        + '## 戳一戳\r\n中文节名C\r\n'
        + '## callAck\r\n应A\r\n'
        + '## imagegenAck\r\n画A\r\n',
    },
  })
  // 注释被跳过 + 别名「戳一戳」并进 poke → 计数确定（不靠随机覆盖来证明）
  assert.deepEqual(source(h).persona, { poke: 3, callAck: 1, imageAck: 1 })
  const pokeSeen = new Set()
  for (let i = 0; i < 40; i += 1) pokeSeen.add(pick(h, 'poke'))
  for (const line of pokeSeen) {
    assert.ok(['专属戳A', '专属戳B', '中文节名C'].includes(line), `poke 池混入了别的行：${line}`)
  }
  assert.equal(pick(h, 'callAck'), '应A')
  assert.equal(pick(h, 'imageAck'), '画A')
  assert.equal(pick(h, 'imagegenAck'), '画A', '旧节名 imagegenAck → 规范节名 imageAck')
  assert.deepEqual(source(h).effective, { poke: 3, callAck: 1, imageAck: 1, imageBusy: 1, imageFail: 1 })
})

test('老格式句池（没有 ## 分节）：整份当 poke；不凭空造出 callAck 节', async (t) => {
  const { h } = await setupPersona(t, {
    persona: { activePersona: 'old' },
    files: {
      'old.lines.txt': '# 老句池：没有分节，整份都是戳一戳回话\n老格式第一句\n老格式第二句\n',
    },
  })
  assert.deepEqual(source(h).persona, { poke: 2 })
  for (let i = 0; i < 20; i += 1) {
    assert.ok(['老格式第一句', '老格式第二句'].includes(pick(h, 'poke')))
  }
  assert.ok(BUILTIN.callAck.includes(pick(h, 'callAck')), '老格式里没有 callAck 节 → 走内置兜底')
  // callAck 的内置兜底是 4 句，其余兜底节各 1 句
  assert.deepEqual(source(h).effective, { poke: 2, callAck: 4, imageAck: 1, imageBusy: 1, imageFail: 1 })
})

test('空句池 / 读不了的句池：不崩，回落内置兜底', async (t) => {
  const { h, personaDir } = await setupPersona(t, {
    persona: { activePersona: 'tester' },
    files: { 'tester.lines.txt': '\uFEFF\r\n\r\n' },
  })
  assert.ok(BUILTIN.poke.includes(pick(h, 'poke')), '空文件 → 内置兜底')
  assert.deepEqual(source(h).persona, {}, '空文件解析成空表')

  // 换成同名目录：stat 成功但 readFileSync 抛 EISDIR → 走 catch 降级（warn），插件不许崩
  const file = path.join(personaDir, 'tester.lines.txt')
  fs.rmSync(file)
  fs.mkdirSync(file)
  assert.ok(BUILTIN.poke.includes(pick(h, 'poke')), '读不了的人设句池 → 内置兜底')
  assert.equal(source(h).persona, null, '读不了的人设句池在状态源里报 null')
  assert.ok(BUILTIN.imageFail.includes(pick(h, 'imageFail')))
})

test('句池优先级：人设节 > _default 节 > 内置兜底；空节不遮蔽底池；未知节返回空', async (t) => {
  const { h } = await setupPersona(t, {
    persona: { activePersona: 'tester' },
    files: {
      'tester.lines.txt': '## poke\n专属戳\n## imageBusy\n专属忙\n## callAck\n',
      '_default.lines.txt': '# 共享底池\n## poke\n底池戳\n## callAck\n底池应\n## imageFail\n底池画失\n',
    },
  })
  assert.equal(pick(h, 'poke'), '专属戳', '人设有的节，底池不参与')
  assert.equal(pick(h, 'callAck'), '底池应', '人设里只有空节 → 回落底池')
  assert.equal(pick(h, 'imageBusy'), '专属忙', '只写在人设里的节也能取到')
  assert.equal(pick(h, 'imageFail'), '底池画失')
  assert.equal(pick(h, 'imageAck'), '在画了，稍等', '两边都没有 → 内置兜底')
  assert.equal(pick(h, '拼错的节'), '', '没有兜底的未知节返回空串（不硬凑）')

  const src = source(h)
  assert.equal(path.basename(src.personaFile), 'tester.lines.txt')
  assert.equal(path.basename(src.baseFile), '_default.lines.txt')
  assert.deepEqual(src.persona, { poke: 1, imageBusy: 1, callAck: 0 })
  assert.deepEqual(src.base, { poke: 1, callAck: 1, imageFail: 1 })
  assert.deepEqual(src.effective, { poke: 1, callAck: 1, imageAck: 1, imageBusy: 1, imageFail: 1 })
})

test('activePersona 热改（reloadConfig）→ 句池立刻换；人设文件缺失 → 底池/内置兜底', async (t) => {
  const { h } = await setupPersona(t, {
    persona: { activePersona: 'alpha' },
    files: {
      'alpha.lines.txt': '## poke\nALPHA\n',
      'beta.lines.txt': '## poke\nBETA\n',
      '_默认.lines.txt': '## poke\n底池\n## callAck\n底池应\n',
    },
  })
  assert.equal(pick(h, 'poke'), 'ALPHA')

  const switchTo = async (name) => {
    const raw = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
    raw.pluginConfig['persona-voice'].activePersona = name
    fs.writeFileSync(h.configPath, `${JSON.stringify(raw, null, 4)}\n`)
    assert.equal((await h.kernel.reloadConfig()).ok, true)
  }
  await switchTo('beta')
  assert.equal(pick(h, 'poke'), 'BETA', '控制台改 activePersona → 下一次取句就是新句池')
  assert.equal(path.basename(source(h).personaFile), 'beta.lines.txt')

  await switchTo('ghost') // 人设库里没有这个名字
  assert.equal(pick(h, 'poke'), '底池', '人设句池缺失 → 回落 _默认.lines.txt')
  assert.equal(pick(h, 'callAck'), '底池应')
  assert.equal(pick(h, 'imageAck'), '在画了，稍等', '底池也没有 → 内置兜底')
  const src = source(h)
  assert.equal(src.personaFile, '', '缺失人设没有句池文件')
  assert.equal(path.basename(src.baseFile), '_默认.lines.txt', '两种底池文件名都认')
  assert.equal(src.persona, null)
})

test('人设指针 .persona.json 变化 → 句池跟着换（不重启、不改配置）', async (t) => {
  const pointer = (name) => `${JSON.stringify({ name, mode: 'copy' })}\n`
  const { h, dataDir } = await setupPersona(t, {
    persona: { activePersona: '' }, // 留空 = 按 qq-lines 工作区的指针解析
    files: {
      'alpha.lines.txt': '## poke\nALPHA\n',
      'beta.lines.txt': '## poke\nBETA\n',
    },
    workspaceFiles: { '.persona.json': pointer('alpha') },
  })
  assert.equal(h.kernel.plugins.find((p) => p.id === 'persona-voice').cfg.activePersona, '')
  assert.equal(pick(h, 'poke'), 'ALPHA')

  fs.writeFileSync(path.join(dataDir, 'workspace', '.persona.json'), pointer('beta'))
  assert.equal(pick(h, 'poke'), 'BETA', '换投递文件/指针 = 换人设，下一次取句立即生效')
  assert.equal(path.basename(source(h).personaFile), 'beta.lines.txt')
})

test('句池缓存：mtime+size 没变不重读；版本号一变立刻换新版', async (t) => {
  const { h, personaDir } = await setupPersona(t, { persona: { activePersona: 'tester' } })
  const file = path.join(personaDir, 'tester.lines.txt')
  // 整个秒的时间戳：utimes 还原时不丢小数毫秒（否则“同版本号”的前提不成立）
  const mtime0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000)
  const stamp = () => {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  }
  const write = (text) => {
    fs.writeFileSync(file, text)
    fs.utimesSync(file, mtime0, mtime0)
  }

  write('旧句')
  const v1 = stamp()
  assert.equal(pick(h, 'poke'), '旧句')

  write('新句') // 同长度 + 同 mtime → 版本号与 v1 完全一样
  assert.equal(stamp(), v1, '前提：mtime+size 与上次一致')
  assert.equal(pick(h, 'poke'), '旧句', '版本号没变 → 吃缓存，不重读')

  write('新句子啦') // 同 mtime、size 变了 → size 也是版本号的一部分
  assert.notEqual(stamp(), v1)
  assert.equal(pick(h, 'poke'), '新句子啦')
  const v2 = stamp()

  write('改句子啦') // 与「新句子啦」同长度 + 同 mtime → 仍命中缓存
  assert.equal(stamp(), v2)
  assert.equal(pick(h, 'poke'), '新句子啦', '版本号没变 → 仍吃缓存')

  const mtime1 = new Date(mtime0.getTime() + 1000)
  fs.utimesSync(file, mtime1, mtime1) // 只动 mtime
  assert.notEqual(stamp(), v2)
  assert.equal(pick(h, 'poke'), '改句子啦', 'mtime 一变 → 立刻重读换新版')
})

test('pickSplitPoint：断点只能落在句末标点，首句 ≤13 字、余下 ≥8 字；否则 null（不拦腰）', () => {
  const longTail = '后面还有很长的正话内容足够拆'
  // 13 字首句（上限）可拆；14 字首句不拆（宁可单条也不拦腰）
  assert.deepEqual(pickSplitPoint(`${'字'.repeat(13)}。${longTail}`), [`${'字'.repeat(13)}。`, longTail])
  assert.equal(pickSplitPoint(`${'字'.repeat(14)}。${longTail}`), null, '首句超长不拆')

  // 余下不足 8 字不拆
  assert.equal(pickSplitPoint(`好呀。${'话'.repeat(7)}`), null, '正话太短不拆')
  assert.deepEqual(pickSplitPoint(`好呀。${'话'.repeat(8)}`), ['好呀。', '话话话话话话话话'])

  // 没有句末标点 / 首句里带换行（跨行不算“短反应”）→ null
  assert.equal(pickSplitPoint('这是一句没有句末标点的很长的话'), null)
  assert.equal(pickSplitPoint('第一行没标点\n第二行有句号。后面还有很长的正话内容'), null, '首句不能跨行')

  // 多个断点取第一个；两段拼起来不丢字
  const text = '好呀！今天天气不错哦。我们出去玩吧要不要一起'
  const parts = pickSplitPoint(text)
  assert.deepEqual(parts, ['好呀！', '今天天气不错哦。我们出去玩吧要不要一起'])
  assert.equal(parts[0] + parts[1], text)

  // 首尾空白被 trim（只丢空白，不丢正文）
  assert.deepEqual(pickSplitPoint(`  ${text}  `), parts)
  assert.equal(pickSplitPoint(''), null)
  assert.equal(pickSplitPoint(null), null)
})

test('拆条：短反应 + 正话两条都走 deliver；第二条不再被二次拆；两段拼起来不丢字', async (t) => {
  const h = await boot(t, {
    pacingStyle: { splitEnabled: true, splitProbability: 1, splitMinLen: 6, splitDelayMs: 0 },
  })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  // 正话自己也能拆（“今天天气不错哦。” + 余下 ≥8 字），正好验 pendingTails 的“不二次拆”
  const text = '好呀。今天天气不错哦。我们出去玩吧要不要一起'
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7001 }))
  await waitFor(() => h.sent.length >= 2, { label: '拆成两条' })
  await sleep(120)
  assert.equal(h.sent.length, 2, '第二条被 pendingTails 认出来 → 不再拆，只有两条')
  assert.equal(h.sent[0].wire, '好呀。', '第一条 = 短反应，整句发（不砍半句）')
  assert.equal(h.sent[1].wire, '今天天气不错哦。我们出去玩吧要不要一起')
  assert.equal(h.sent[0].wire + h.sent[1].wire, text, '两段拼起来 = 原文，一个字不丢')
})

test('quoteEnforce：唤醒后插话达到门槛（arrived ≥ quoteAfterMsgs）→ 引用保留', async (t) => {
  const h = await boot(t, {
    outbound: { quoteAfterMsgs: 1 },
    pacingStyle: { splitEnabled: false },
  })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  let sid = ''
  h.ctx.setPromptHandler(async (req) => { sid = req.sessionId })
  await emitRaw(h.kernel, groupAtEvent({ text: '触发一轮', messageId: 8001 }))
  await waitFor(() => sid, { label: '第一轮已 admission' })

  // 唤醒之后、回复之前同群又插了一句 → 引用有信息量，不该被抹
  await emitRaw(h.kernel, groupAtEvent({ text: '群里又说了一句', messageId: 8002, at: false, userId: MEMBER_QQ }))
  h.ctx.emit('session/event', { id: sid }, { type: 'turn/start' })
  const turn = h.kernel.turnBySession.get(sid)
  assert.ok(turn, 'turn/start 后本轮上下文已绑定（否则引用门槛根本不跑，断言会假绿）')
  assert.equal(turn.arrivedDuringTurn, 1, '前提：门槛只差 1 条就到了（need=1）')
  await send.execute({ target: `group:${GROUP_ID}`, text: '回你', reply_to: 8001 }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=8001]'), `达到门槛应保留引用：${h.sent.at(-1).wire}`)
})

test('quoteEnforce=false：插话没到门槛也照常引用（关掉 = 不拦引用）', async (t) => {
  const h = await boot(t, {
    outbound: { quoteAfterMsgs: 3 },
    pacingStyle: { splitEnabled: false },
    persona: { quoteEnforce: false },
  })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  let sid = ''
  h.ctx.setPromptHandler(async (req) => { sid = req.sessionId })
  await emitRaw(h.kernel, groupAtEvent({ text: '触发一轮', messageId: 9001 }))
  await waitFor(() => sid, { label: '第一轮已 admission' })
  h.ctx.emit('session/event', { id: sid }, { type: 'turn/start' })
  const turn = h.kernel.turnBySession.get(sid)
  assert.ok(turn, 'turn/start 后本轮上下文已绑定（否则 quoteEnforce 根本不跑）')
  assert.equal(turn.arrivedDuringTurn, 0, '前提：0 条插话 < 门槛 3；开成 on 的话这条引用会被抹')
  await send.execute({ target: `group:${GROUP_ID}`, text: '回你', reply_to: 9001 }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=9001]'), `关掉后不拦引用：${h.sent.at(-1).wire}`)
})

// ── 并列句式收口（2026-11-02：人设第一条「不并列」靠提示词拦不住）──────────
test('collapseParallel：并列/对比只留一个分句', () => {
  const cases = [
    ['不是我不发 是这条路断了', '这条路断了'],
    ['看着像我接话 其实那不是我', '那不是我'],
    ['既想笑又有点想哭', '有点想哭'],
    ['一边吃饭一边刷手机', '刷手机'],
    ['不仅晚了 还没带钥匙', '没带钥匙'],
    ['虽然困 但是得爬起来', '得爬起来'],
    ['我吃过 而不是他', '我吃过'],
  ]
  for (const [input, want] of cases) {
    assert.equal(collapseParallel(input), want, `「${input}」应收口成「${want}」`)
  }
})

test('collapseParallel：不该动的别动', () => {
  // 正常短句、单句、带 CQ 码的（拆开就坏消息）都原样返回
  assert.equal(collapseParallel('好耶'), '好耶')
  assert.equal(collapseParallel('今天好累'), '今天好累')
  assert.equal(collapseParallel(''), '')
  assert.equal(collapseParallel('[CQ:image,file=a.png]'), '[CQ:image,file=a.png]')
  // 收口后只剩 1 个字 → 不划算，保持原样
  assert.equal(collapseParallel('不是A 是B'), '不是A 是B')
})

test('出站钩子：并列句式在发出去之前就被收口', async (t) => {
  const h = await boot(t, { pacingStyle: { splitEnabled: false, splitProbability: 0 } })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '看着像我接话 其实那不是我' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7101 }))
  await waitFor(() => h.sent.length >= 1, { label: '出站' })
  assert.equal(h.sent.at(-1).wire, '那不是我', '发出去之前就只留后半句')
})

test('出站钩子：开关关掉就原样发', async (t) => {
  const h = await boot(t, { pacingStyle: { splitEnabled: false, splitProbability: 0 }, persona: { singleClause: false } })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '看着像我接话 其实那不是我' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7102 }))
  await waitFor(() => h.sent.length >= 1, { label: '出站' })
  assert.equal(h.sent.at(-1).wire, '看着像我接话 其实那不是我')
})

// ── 颜文字节奏（2026-11-02：人设要求每 5–6 条一个，纯提示词实测 56 条只出 1 个）──
test('kaomojiEvery=1：模型没带就补一个', async (t) => {
  const h = await boot(t, { pacingStyle: { splitEnabled: false, splitProbability: 0 }, persona: { kaomojiEvery: 1 } })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '好耶' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7201 }))
  await waitFor(() => h.sent.length >= 1, { label: '出站' })
  const wire = h.sent.at(-1).wire
  assert.ok(wire.startsWith('好耶'), '正文不变')
  assert.ok(wire.length > 2, '后面补了颜文字')
})

test('kaomojiEvery=0：不补', async (t) => {
  const h = await boot(t, { pacingStyle: { splitEnabled: false, splitProbability: 0 }, persona: { kaomojiEvery: 0 } })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '好耶' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7202 }))
  await waitFor(() => h.sent.length >= 1, { label: '出站' })
  assert.equal(h.sent.at(-1).wire, '好耶')
})

test('自己已经带了颜文字就不再叠一个', async (t) => {
  const h = await boot(t, { pacingStyle: { splitEnabled: false, splitProbability: 0 }, persona: { kaomojiEvery: 1 } })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '好耶（跑）' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7203 }))
  await waitFor(() => h.sent.length >= 1, { label: '出站' })
  assert.equal(h.sent.at(-1).wire, '好耶（跑）')
})

test('hasKaomoji / pickKaomoji 边界', () => {
  assert.equal(hasKaomoji('好耶'), false)
  assert.equal(hasKaomoji('好耶（跑）'), true)
  assert.equal(hasKaomoji('qwq'), true)
  assert.equal(hasKaomoji('(//▽//)'), true)
  assert.equal(typeof pickKaomoji(), 'string')
  assert.ok(pickKaomoji().length > 0, '取出来的颜文字不能是空串')
})

// ── 禁语（2026-11-07：主人点名不要「我记下了」这类记账腔）──────────
test('replaceBanned：「我记下了」这类汇报句换成反应句，正常话不动', () => {
  assert.equal(replaceBanned('我记下了'), '记住啦')
  assert.equal(replaceBanned('记下了 以后绕开它'), '记住啦 以后绕开它')
  assert.equal(replaceBanned('我明白了'), '懂了懂了')
  assert.equal(replaceBanned('我知道了'), '懂啦')
  assert.equal(replaceBanned('笑死'), '笑死', '正常话不许改')
  assert.equal(replaceBanned('我记性不太好'), '我记性不太好', '别误伤「记性」')
})

test('出站禁语收口：她说了「我记下了」也发不出去', async (t) => {
  const h = await boot(t, { pacingStyle: { splitEnabled: false, splitProbability: 0 }, persona: { kaomojiEvery: 0 } })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '我记下了 以后绕开它' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 7301 }))
  await waitFor(() => h.sent.length >= 1, { label: '出站' })
  const wire = h.sent.at(-1).wire
  assert.ok(!wire.includes('我记下了'), `禁语漏出去了：${wire}`)
  assert.ok(wire.includes('记住啦'), `应换成反应句：${wire}`)
})

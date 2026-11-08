/**
 * test/stickers.test.js — 表情包插件（plugins/stickers，order 80）**专属**测试。
 *
 * 分工（只补缺口，不重复已锁的行为）：
 *   · audit-data-admin.test.js：入站采集的**协议判据**（sub_type=1 收、0 不收）、GIF 魔数跳过、只在群里收；
 *   · sticker-offer.test.js：主动提醒（offer）私聊/群聊都要掷骰、offerInPrivate 开关；
 *   · regression-baseline.test.js B7：vendor `resolve()` 的「lastUsed 升序」（直接测 vendor 核心）；
 *   · 本文件：插件上层自己做的事 ——
 *       ① 打标答案解析（看/用/词、多一行、缺一行、带编号）与 sanitize（BLOCK/真人照片中性化）；
 *       ② `pick()`：tag 命中、lastUsed 升序（不是 uses/send_count）、关键词没命中回退随机、点名没找到明说没合适的；
 *       ③ 内容去重（重复本地文件 / 不同 URL 同内容 → 一条）；
 *       ④ `ensureFace`：本地没进 QQ 收藏时当场补、失败回退本地图、已有映射不重复补；
 *       ⑤ `availableMenu`：菜单词按出现次数取前 6、过滤 blocked/adult/1 字/超 6 字；
 *       ⑥ `enabled=false` 明确拒绝（不是"随机挑一张"）；
 *       ⑦ `sticker_retag` 退回重打标（不丢旧标签、跳过 blocked/adult、limit 生效）。
 *
 * 不碰真实网络/NapCat：
 *   · HTTP 层（视觉打标 / 收藏表情 API）用 globalThis.fetch 桩；出站仍用 helpers.mjs 的 stubNapcat。
 *   · 打标走**真实链路**：真 TAG_PROMPT → vision.describeImage → plugins 的 sanitizeTag → vendor 解析，
 *     所以这里锁的是端到端解析结果，不是复制一份正则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootKernel, emitRaw, waitFor, tmpDir, privateEvent, ADMIN_QQ, GROUP_ID, MEMBER_QQ } from './helpers.mjs'

const STICKER_DIR = 'qq-stickers'

// ── 夹具 ─────────────────────────────────────────────────────────────────────

let msgSeq = 9000
const nextMessageId = () => ++msgSeq

/** 最小合法 PNG（魔数 + 填充到 >1KB，过 vendor 的 minBytes 闸）。seed 不同 → 内容哈希不同。 */
function pngBytes(seed = 1, size = 1400) {
  const head = Buffer.from('89504e470d0a1a0a', 'hex')
  const body = Buffer.alloc(Math.max(16, size - head.length))
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + seed * 97) & 0xff
  return Buffer.concat([head, body])
}

/** 一条 index.json 条目的基线（字段名与 vendor 一致；没有 send_count 这种字段）。 */
function item(over = {}) {
  return {
    id: 1,
    hash: 'h1',
    file: '1-h1.png',
    ts: 1,
    uses: 0,
    lastUsed: 0,
    desc: '',
    use: '',
    tags: [],
    tagged: true,
    tagVer: 1,
    blocked: false,
    adult: false,
    seenCount: 1,
    ...over,
  }
}

/** 造/覆盖表情库：写 index.json + 每条的图片文件（内容按 id 区分）+ 可选 qq-faces.json。 */
function seedItems(dataDir, items, { faces = null } = {}) {
  const dir = path.join(dataDir, STICKER_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const nextId = items.reduce((max, it) => Math.max(max, Number(it.id) || 0), 0) + 1
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items, nextId }))
  for (const it of items) {
    if (!it.file) continue
    fs.writeFileSync(path.join(dir, it.file), pngBytes(Number(it.id) || 1))
  }
  if (faces) fs.writeFileSync(path.join(dir, 'qq-faces.json'), JSON.stringify(faces))
  return dir
}

function readIndexOrNull(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STICKER_DIR, 'index.json'), 'utf8'))
  } catch {
    return null
  }
}

function readIndex(dataDir) {
  const data = readIndexOrNull(dataDir)
  assert.ok(data, 'index.json 应存在')
  return data
}

const indexById = (dataDir, id) => readIndex(dataDir).items.find((i) => i.id === id)

/** OneBot 图片段事件（表情判据用协议字段 sub_type，不看 summary）。 */
function stickerEvent({ messageId = nextMessageId(), file = '', url = '', subType = 1, group = true } = {}) {
  const raw = {
    post_type: 'message',
    message_type: group ? 'group' : 'private',
    user_id: MEMBER_QQ,
    message_id: messageId,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'image', data: { file, url, sub_type: subType, summary: '[动画表情]' } }],
  }
  if (group) raw.group_id = GROUP_ID
  return raw
}

/** 换掉 globalThis.fetch（测试后恢复），记录每次请求。 */
function mockFetch(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), opts }
    calls.push(call)
    return handler(call.url, opts, calls.length)
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

const visionResponse = (text) => jsonResponse({ choices: [{ message: { content: text } }] })

const callsOf = (calls, action) => calls.filter((c) => c.url.split('/').pop() === action)
const bodyOf = (call) => JSON.parse(String(call?.opts?.body || '{}'))

/** 收藏表情协议端（SnowLuma 那组 HTTP 接口）打桩：不打真实网络。 */
function mockCustomFaceApi(t, { supports = true, add = { status: 'ok', data: { emoji_id: '777' } } } = {}) {
  return mockFetch(t, (url) => {
    const action = url.split('/').pop()
    if (action === 'fetch_custom_face_detail') {
      return supports ? jsonResponse({ status: 'ok', data: [] }) : jsonResponse({ status: 'failed', wording: 'unsupported' })
    }
    if (action === 'add_custom_face') return jsonResponse(add)
    if (action === 'send_custom_face') return jsonResponse({ status: 'ok', data: { message_id: 4242 } })
    return jsonResponse({ status: 'failed', wording: 'unexpected' }, 404)
  })
}

async function boot(t, { stickers = {}, pacingStyle = 0, vision = null } = {}) {
  const h = await bootKernel({
    config: {
      pacing: {
        merge: { enabled: false },
        reply: {
          // splitProbability=0 是权威值（buildPluginCfg 会用它覆盖 persona-voice），避免出站拆条拖慢断言
          style: { splitEnabled: false, splitProbability: 0, splitDelayMs: 0, stickerEnabled: true, stickerProbability: pacingStyle },
        },
      },
      ...(vision ? { vision } : {}),
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: true, qqFavorite: false, ...stickers },
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

/** 等表情插件的串行队列把已排的任务跑完（启动对账是异步排进去的）。 */
async function flushStickers(h) {
  const q = h.kernel.state?.stickersQueue
  if (q && typeof q.push === 'function') {
    await q.push(async () => {})
    return
  }
  await new Promise((r) => setTimeout(r, 50))
}

/** 起一轮真实回合，在 prompt 回调里拿到本轮的 exec（工具 wrapper 靠它认轮）。 */
async function inTurn(h, fn, { text = '在吗' } = {}) {
  let failure = null
  h.ctx.setPromptHandler(async (req) => {
    try {
      await fn({ agent: { session: { id: req.sessionId } } }, req)
    } catch (e) {
      failure = e
    }
  })
  await emitRaw(h.kernel, privateEvent({ text, messageId: nextMessageId() }))
  if (failure) throw failure
}

/** 在本轮里调一个 QQ 工具（工具名不带 mcp__qq__ 前缀）。 */
async function callToolInTurn(h, name, args = {}) {
  const tool = h.ctx._registeredTools.get(`mcp__qq__${name}`)
  assert.ok(tool, `工具 ${name} 应已注册`)
  let out
  await inTurn(h, async (exec) => { out = await tool.execute(args, exec) })
  return out
}

const mediaSent = (h) => h.sent.filter((s) => s.kind === 'media')

// ─────────────────────────────────────────────────────────────────────────────
// ① 打标输出解析
// ─────────────────────────────────────────────────────────────────────────────

test('打标解析：「看/用/词」三行 → desc/use/tags；多余一行忽略、缺「用」留空、词数与词长截断', async (t) => {
  const h = await boot(t, {
    vision: { enabled: true, baseUrl: 'https://vision.invalid/v1', apiKey: 'test-key', model: 'glm-4v-flash' },
    stickers: { tagging: true, qqFavorite: false },
  })
  seedItems(h.dataDir, [
    item({ id: 1, hash: 'h1', file: '1-h1.png', tags: [], tagged: false, tagVer: 0 }),
    item({ id: 2, hash: 'h2', file: '2-h2.png', tags: [], tagged: false, tagVer: 0 }),
    item({ id: 3, hash: 'h3', file: '3-h3.png', tags: [], tagged: false, tagVer: 0 }),
  ])

  // 三次看图按条目顺序返回；第三张故意缺「用」行。
  const replies = [
    '看：一只橘猫在哭，眼睛湿了\n用：被问住了 替「说不出话」\n词：崩溃, 泪目, 阴阳怪气到底了, 说不出话, 第五个',
    '看：一只狗头\n用：夸人 替「牛」\n词：狗头, 看戏\n备注：多出来的一行不该进标签',
    '看：一张摆手的小人\n词：告辞, 摆烂',
  ]
  let n = 0
  mockFetch(t, (url) => {
    assert.ok(url.endsWith('/chat/completions'), `打标只能请求视觉接口，实际 ${url}`)
    const content = replies[Math.min(n, replies.length - 1)]
    n += 1
    return visionResponse(content)
  })

  // 触发被动采集（这条段取不到字节会被跳过），但同一入口里的 maybeTag 会把积压的 3 张打掉
  await emitRaw(h.kernel, stickerEvent({ messageId: nextMessageId() }))
  await waitFor(() => {
    const idx = readIndexOrNull(h.dataDir)
    return idx && idx.items.length === 3 && idx.items.every((i) => i.tagged) ? idx : null
  }, { label: '三张都打完标' })

  const one = indexById(h.dataDir, 1)
  assert.equal(one.desc, '一只橘猫在哭，眼睛湿了')
  assert.equal(one.use, '被问住了 替「说不出话」')
  assert.deepEqual(one.tags, ['崩溃', '泪目', '阴阳怪气到底', '说不出话'], '最多 4 个词、每个最多 6 字')
  assert.equal(one.adult, false, '没给「脏」行就不是成人图')
  assert.equal(one.blocked, false)

  const two = indexById(h.dataDir, 2)
  assert.equal(two.desc, '一只狗头')
  assert.equal(two.use, '夸人 替「牛」')
  assert.deepEqual(two.tags, ['狗头', '看戏'], '多出来的「备注」行直接忽略，不混进标签')

  const three = indexById(h.dataDir, 3)
  assert.equal(three.desc, '一张摆手的小人')
  assert.equal(three.use, '', '缺「用」行就留空，不把「词」行硬塞进去')
  assert.deepEqual(three.tags, ['告辞', '摆烂'])
})

test('打标兜底：带编号 → 退回按行拆（现状：desc 带标签、tags 为空）；BLOCK/真人照片被中性化，不永久拦图', async (t) => {
  const h = await boot(t, {
    vision: { enabled: true, baseUrl: 'https://vision.invalid/v1', apiKey: 'test-key', model: 'glm-4v-flash' },
    stickers: { tagging: true, qqFavorite: false },
  })
  seedItems(h.dataDir, [
    item({ id: 1, hash: 'h1', file: '1-h1.png', tags: [], tagged: false, tagVer: 0 }),
    item({ id: 2, hash: 'h2', file: '2-h2.png', tags: [], tagged: false, tagVer: 0 }),
    item({ id: 3, hash: 'h3', file: '3-h3.png', tags: [], tagged: false, tagVer: 0 }),
  ])

  const replies = [
    '1. 看：一只猫在笑\n2. 用：看戏 替「哈哈哈」\n3. 词：看戏, 哈哈哈',
    'BLOCK',
    '看：真人照片里的橘猫，表情无语\n用：无语 替「啊这」\n词：无语, 真人',
  ]
  let n = 0
  mockFetch(t, () => visionResponse(replies[Math.min(n++, replies.length - 1)]))

  await emitRaw(h.kernel, stickerEvent({ messageId: nextMessageId() }))
  await waitFor(() => {
    const idx = readIndexOrNull(h.dataDir)
    return idx && idx.items.every((i) => i.tagged) ? idx : null
  }, { label: '三张都打完标' })

  // 带编号：三个字段名都认不出来（行首是「1.」）→ vendor 的按行兜底。
  // 现状：desc 保留整行（含「看：」标签），词行完全失效 → tags 为空。
  // 这不是崩溃（图还在、还能随机挑），但关键词挑不到它；改提示词/加后处理时这条会红，属预期。
  const numbered = indexById(h.dataDir, 1)
  assert.equal(numbered.tagged, true)
  assert.equal(numbered.desc, '看：一只猫在笑')
  assert.deepEqual(numbered.tags, [], '编号输出：词行认不出 → 没有标签（按行兜底的现状）')

  // 「BLOCK」是上游安全线的答案；本插件提示词不产安全线 → sanitizeTag 把它中性化成「（无）」，
  // 绝不能因此把整张图永久 block 掉（见插件文件头 BLOCK_NEUTRALIZE）。
  const blockedAnswer = indexById(h.dataDir, 2)
  assert.equal(blockedAnswer.blocked, false, 'BLOCK 答案不许把图永久拦掉')
  assert.equal(blockedAnswer.tagged, true)
  assert.equal(blockedAnswer.desc, '（无）')

  // 模型在「看」里写「真人照片」同样会被 vendor 的 BLOCK 正则命中 → 先中性化成「真人素材」。
  const photo = indexById(h.dataDir, 3)
  assert.equal(photo.blocked, false, '「真人照片」是描述用词，不是内容拦截理由')
  assert.match(photo.desc, /真人素材/)
  assert.equal(photo.desc.includes('真人照片'), false, '触发词必须已被替换')
  assert.deepEqual(photo.tags, ['无语', '真人'])
})

// ─────────────────────────────────────────────────────────────────────────────
// ② pick：tag 命中 / lastUsed 升序 / 没命中回退 / 点名没找到
// ─────────────────────────────────────────────────────────────────────────────

test('pick(query)：tag 命中 + lastUsed 升序（最久没露脸的先挑，不是 uses/send_count）', async (t) => {
  const h = await boot(t, { stickers: { qqFavorite: false } })
  seedItems(h.dataDir, [
    item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['猫'], lastUsed: 10_000, uses: 0 }),
    item({ id: 2, hash: 'h2', file: '2-h2.png', tags: ['猫'], lastUsed: 0, uses: 99 }),
    item({ id: 3, hash: 'h3', file: '3-h3.png', tags: ['猫'], lastUsed: 5_000, uses: 1 }),
  ])
  const originalRandom = Math.random
  Math.random = () => 0 // vendor 从「lastUsed 最小的 5 张」里随机 → 固定取第一张
  t.after(() => { Math.random = originalRandom })

  const out = await callToolInTurn(h, 'send_sticker', { query: '猫' })
  assert.equal(out.ok, true)
  assert.equal(out.pick.id, 2, 'lastUsed=0 的那张最久没用应先挑（按 uses 会挑 id=1，按 send_count 同理）')
  assert.deepEqual(out.pick.tags, ['猫'])

  const idx = readIndex(h.dataDir)
  assert.equal(idx.items.find((i) => i.id === 2).uses, 100, '被挑中后 uses +1')
  assert.ok(idx.items.find((i) => i.id === 2).lastUsed > 0, '被挑中后 lastUsed 刷新')
  assert.equal(idx.items.find((i) => i.id === 1).uses, 0, '没被挑中的不许记使用')

  const media = mediaSent(h)
  assert.equal(media.length, 1)
  assert.ok(media[0].wire.includes('2-h2.png'), `应发挑中的那张：${media[0].wire}`)
})

test('pick(query)：关键词没命中 → 回退随机（连刚收未打标的那张也能挑）', async (t) => {
  const h = await boot(t, { stickers: { qqFavorite: false } })
  seedItems(h.dataDir, [
    item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['猫'] }),
    item({ id: 2, hash: 'h2', file: '2-h2.png', tags: [], tagged: false, tagVer: 0 }),
  ])
  const originalRandom = Math.random
  Math.random = () => 0.99 // pickRandom 取池子最后一个（未打标的 #2）
  t.after(() => { Math.random = originalRandom })

  const out = await callToolInTurn(h, 'send_sticker', { query: '库里根本没有的词' })
  assert.equal(out.ok, true, '关键词没命中要随便给一张，不能空手')
  assert.equal(out.pick.id, 2)
  assert.equal(out.pick.untagged, true, '上游 usableItems 只算打过标的 → 随机池必须自己带上未打标的')
  assert.equal(mediaSent(h).length, 1)
})

test('pick(query)：点名 #N 不存在 → 明确「没合适的」，绝不随机补一张；失败不占每轮额度', async (t) => {
  const h = await boot(t, { stickers: { qqFavorite: false } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['猫'] })])

  const results = []
  await inTurn(h, async (exec) => {
    const tool = h.ctx._registeredTools.get('mcp__qq__send_sticker')
    assert.ok(tool)
    results.push(await tool.execute({ query: '#99' }, exec))
    results.push(await tool.execute({ query: '#99' }, exec))
    results.push(await tool.execute({ query: '#1' }, exec))
  })

  assert.equal(results[0].ok, false)
  assert.equal(results[0].reason, '没合适的')
  assert.equal(results[1].reason, '没合适的', '上一把没发出去 → 每轮额度必须回滚（不能变成「这轮已经发过」）')
  assert.equal(results[2].ok, true)
  assert.equal(results[2].pick.id, 1)
  assert.equal(mediaSent(h).length, 1, '两次点名失败绝不能退化成随机发一张')
})

test('enabled=false：明确拒绝「表情库没开」，不是随机挑一张', async (t) => {
  const h = await boot(t, { stickers: { enabled: false, qqFavorite: false } })
  // 库里有能用的图：如果实现误走随机路径，这里就会发出去
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['猫'] })])

  const results = []
  await inTurn(h, async (exec) => {
    const tool = h.ctx._registeredTools.get('mcp__qq__send_sticker')
    results.push(await tool.execute({ query: '' }, exec))
    results.push(await tool.execute({ query: '猫' }, exec))
  })

  for (const r of results) {
    assert.equal(r.ok, false)
    assert.equal(r.reason, '表情库没开')
  }
  assert.equal(mediaSent(h).length, 0, '关掉了还发图 = 没关')
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 去重：同一张图只留一条
// ─────────────────────────────────────────────────────────────────────────────

test('去重：同一张图重复入库（重复本地文件 / 不同 URL 同内容）只留一条，只涨 seenCount', async (t) => {
  const src = path.join(tmpDir('stk-src'), 'same.png')
  const png = pngBytes(42)
  fs.writeFileSync(src, png)

  const h = await boot(t, {
    stickers: { qqFavorite: false, skipGif: true, collectGroupsOnly: true },
  })
  mockFetch(t, (url) => {
    if (url === 'https://example.invalid/a.png') return new Response(png, { status: 200 })
    return new Response('not found', { status: 404 })
  })

  await emitRaw(h.kernel, stickerEvent({ messageId: nextMessageId(), file: src }))
  await emitRaw(h.kernel, stickerEvent({ messageId: nextMessageId(), file: src }))
  await emitRaw(h.kernel, stickerEvent({ messageId: nextMessageId(), url: 'https://example.invalid/a.png' }))

  const idx = await waitFor(() => {
    const data = readIndexOrNull(h.dataDir)
    return data?.items?.length === 1 && data.items[0].seenCount === 3 ? data : null
  }, { label: '三次同内容只入一条' })

  assert.equal(idx.items.length, 1, '内容哈希相同 → 复用它，不再写第二条')
  assert.equal(idx.items[0].seenCount, 3, '每见一次 seenCount +1')
  assert.equal(idx.items[0].uses, 0, '入库不等于用过')

  const files = fs.readdirSync(path.join(h.dataDir, STICKER_DIR)).filter((f) => f.endsWith('.png'))
  assert.equal(files.length, 1, '磁盘上也只留一份（URL 那条按内容哈希认出来了）')
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ ensureFace：发之前当场补进 QQ 收藏；失败回退本地图
// ─────────────────────────────────────────────────────────────────────────────

test('ensureFace：本地还没进收藏 → 当场 add_custom_face 并记映射，发成真表情（不发本地图）', async (t) => {
  const calls = mockCustomFaceApi(t)
  const h = await boot(t, { stickers: { qqFavorite: true } })
  await flushStickers(h) // 启动对账在空库上先跑完，别把测试种的图提前补进去
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])

  const out = await callToolInTurn(h, 'send_sticker', { query: '#1' })
  assert.equal(out.ok, true)
  assert.equal(out.pick.id, 1)

  const addCalls = callsOf(calls, 'add_custom_face')
  assert.equal(addCalls.length, 1, '没有映射就当场补一次')
  assert.ok(String(bodyOf(addCalls[0]).file).endsWith('1-h1.png'), `补的必须是刚挑中的那张：${JSON.stringify(bodyOf(addCalls[0]))}`)

  const faceCalls = callsOf(calls, 'send_custom_face')
  assert.equal(faceCalls.length, 1)
  assert.equal(bodyOf(faceCalls[0]).emoji_id, '777')
  assert.equal(mediaSent(h).length, 0, '能发真表情时不许回退发本地图')

  const facesFile = path.join(h.dataDir, STICKER_DIR, 'qq-faces.json')
  const faces = JSON.parse(fs.readFileSync(facesFile, 'utf8'))
  assert.equal(faces.h1.emoji_id, '777')
  assert.equal(faces.h1.from, 'on-demand', '来源要标成「临时补的」')

  // 第二轮（新回合）：映射已在 → 直接发，不再重复上传
  const out2 = await callToolInTurn(h, 'send_sticker', { query: '#1' })
  assert.equal(out2.ok, true)
  assert.equal(callsOf(calls, 'add_custom_face').length, 1, '已有映射就别再 add_custom_face')
  assert.equal(callsOf(calls, 'send_custom_face').length, 2)
})

test('ensureFace：补收藏失败 → 回退发本地图（话不能吞），且不写假映射', async (t) => {
  const calls = mockCustomFaceApi(t, { add: { status: 'failed', wording: '不支持' } })
  const h = await boot(t, { stickers: { qqFavorite: true } })
  await flushStickers(h)
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])

  const out = await callToolInTurn(h, 'send_sticker', { query: '#1' })
  assert.equal(out.ok, true, '收藏表情补不上也不能把这张图吞了')
  assert.equal(callsOf(calls, 'add_custom_face').length, 1)
  assert.equal(callsOf(calls, 'send_custom_face').length, 0, '没拿到 emoji_id 就不能发 send_custom_face')

  const media = mediaSent(h)
  assert.equal(media.length, 1)
  assert.ok(media[0].wire.includes('1-h1.png'), `回退发本地图：${media[0].wire}`)

  const facesFile = path.join(h.dataDir, STICKER_DIR, 'qq-faces.json')
  const faces = fs.existsSync(facesFile) ? JSON.parse(fs.readFileSync(facesFile, 'utf8')) : {}
  assert.equal(faces.h1, undefined, '失败不许留一条假映射（下次会以为已收藏）')
})

test('ensureFace：已有收藏映射 → 直接发收藏表情，不重复 add_custom_face', async (t) => {
  const calls = mockCustomFaceApi(t)
  const h = await boot(t, { stickers: { qqFavorite: true } })
  await flushStickers(h)
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })], {
    faces: { h1: { emoji_id: '999', at: 1, file: '1-h1.png', from: 'qq' } },
  })

  const out = await callToolInTurn(h, 'send_sticker', { query: '#1' })
  assert.equal(out.ok, true)
  assert.equal(callsOf(calls, 'add_custom_face').length, 0, '映射按 hash 存 → 已有就别再传')
  const faceCalls = callsOf(calls, 'send_custom_face')
  assert.equal(faceCalls.length, 1)
  assert.equal(bodyOf(faceCalls[0]).emoji_id, '999')
  assert.equal(mediaSent(h).length, 0)
})

test('协议端不支持收藏表情 → 全程静默回退本地图，不尝试 add_custom_face', async (t) => {
  const calls = mockCustomFaceApi(t, { supports: false })
  const h = await boot(t, { stickers: { qqFavorite: true } })
  await flushStickers(h)
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])

  const out = await callToolInTurn(h, 'send_sticker', { query: '#1' })
  assert.equal(out.ok, true)
  assert.equal(callsOf(calls, 'add_custom_face').length, 0, '协议端没这接口就别白传一遍文件')
  assert.equal(callsOf(calls, 'send_custom_face').length, 0)
  assert.equal(mediaSent(h).length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ availableMenu：菜单词（按出现次数取前 N，过滤 blocked/adult）
// ─────────────────────────────────────────────────────────────────────────────

test('availableMenu：菜单词按出现次数取前 6，过滤 blocked/adult、1 字词与超 6 字词', async (t) => {
  const h = await boot(t, {
    stickers: { qqFavorite: false, offerPercent: 100, offerCooldownMs: 0, offerInPrivate: true },
    pacingStyle: 1, // 权威开关：100% 必掷中（99.99 < 100 恒成立）
  })

  // 第 1–9 条正常可用；第 10/11 条分别 blocked / adult；第 12 条本身可用，但它的词都不合法。
  // 「喵」1 字、「超长标签七个字」7 字都重复 6 次：**如果没被长度过滤，它们会顶掉正常的词**，
  // 所以「它们不在菜单里」这条断言同时钉住了 2–6 字的长度闸。
  const lib = [
    { tags: ['无语', '猫咪', '看戏', '狗头'] },
    { tags: ['无语', '猫咪', '看戏', '狗头'] },
    { tags: ['无语', '猫咪', '看戏', '狗头'] },
    { tags: ['无语', '猫咪', '看戏'] },
    { tags: ['无语', '猫咪', '摆烂'] },
    { tags: ['摆烂', '夸人'] },
    { tags: ['夸人'] },
    { tags: ['附和'] },
    { tags: ['告辞'] },
    { tags: ['成人向', '成人向', '成人向'], blocked: true },
    { tags: ['成人向', '成人向', '成人向'], adult: true },
    { tags: ['喵', '喵', '喵', '喵', '喵', '喵', '超长标签七个字', '超长标签七个字', '超长标签七个字', '超长标签七个字', '超长标签七个字', '超长标签七个字'] },
  ]
  seedItems(h.dataDir, lib.map((entry, i) => item({
    id: i + 1,
    hash: `h${i + 1}`,
    file: `${i + 1}-h${i + 1}.png`,
    tags: entry.tags,
    blocked: !!entry.blocked,
    adult: !!entry.adult,
  })))

  const counts = new Map()
  for (const entry of lib) {
    if (entry.blocked || entry.adult) continue
    for (const w of entry.tags) {
      if (w.length >= 2 && w.length <= 6) counts.set(w, (counts.get(w) || 0) + 1)
    }
  }

  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })
  await emitRaw(h.kernel, privateEvent({ text: '在吗', messageId: nextMessageId() }))
  await waitFor(() => prompts.length >= 1, { label: '本轮 prompt' })
  const text = prompts[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

  assert.ok(text.includes('[表情:'), `掷骰命中应有表情提示：${text}`)
  // 没对上语境时提示形如「…｜能表达：a/b/c → send_sticker("想表达的那个")…」；对上语境则菜单后面直接是 `]`。
  const menuText = /｜能表达：([^\]\n]+?)(?:\s*→|\])/.exec(text)
  assert.ok(menuText, `提示里应带可表达的菜单：${text}`)
  const menu = menuText[1].split('/')

  assert.equal(menu.length, 6, '只给前 6 个词，别把整库标签倒给模型')
  assert.deepEqual(
    [...menu].sort(),
    ['无语', '猫咪', '看戏', '狗头', '摆烂', '夸人'].sort(),
    '按出现次数取前 6（第 6 名计数 2，第 7 名只有 1）',
  )
  for (const absent of ['成人向', '喵', '超长标签七个字', '附和', '告辞']) {
    assert.equal(menu.includes(absent), false, `不该出现在菜单里：${absent}`)
  }
  for (const w of menu) {
    assert.ok(w.length >= 2 && w.length <= 6, `菜单词长度必须在 2–6 字：${w}`)
  }
  for (let i = 0; i < menu.length - 1; i++) {
    assert.ok(counts.get(menu[i]) >= counts.get(menu[i + 1]), `菜单应按出现次数降序：${menu.join('/')}`)
  }
  assert.equal(Math.min(...menu.map((w) => counts.get(w))), 2, '出现 1 次的词（附和/告辞）进不了前 6')
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ sticker_retag：退回重打标
// ─────────────────────────────────────────────────────────────────────────────

test('sticker_retag：只退回 tagged 条目（保留旧标签），跳过 blocked/adult/未打标，limit 生效', async (t) => {
  const h = await boot(t, { stickers: { qqFavorite: false } })
  const lib = []
  for (let i = 1; i <= 5; i++) {
    lib.push(item({ id: i, hash: `h${i}`, file: `${i}-h${i}.png`, tags: [`旧${i}`] }))
  }
  lib.push(item({ id: 6, hash: 'h6', file: '6-h6.png', tags: ['拦'], blocked: true }))
  lib.push(item({ id: 7, hash: 'h7', file: '7-h7.png', tags: ['成人'], adult: true }))
  lib.push(item({ id: 8, hash: 'h8', file: '8-h8.png', tags: [], tagged: false, tagVer: 0 }))
  seedItems(h.dataDir, lib)

  const tool = h.ctx._registeredTools.get('mcp__qq__sticker_retag')
  assert.ok(tool, 'sticker_retag 应已注册')

  const r1 = await tool.execute({ limit: 3 })
  assert.equal(r1.ok, true)
  assert.equal(r1.requeued, 3, 'limit=3 只退前 3 条')
  // pending 是**全库欠打标数**（不止本次退回的）：#8 本来就没打标，也一直算在里面。
  assert.equal(r1.pending, 4, '退回 3 张 + 原本未打标的 #8 = 欠 4 张')
  assert.match(String(r1.note), /45 秒/, '给模型的说明里要有重看节奏')

  let idx = readIndex(h.dataDir)
  for (const id of [1, 2, 3]) {
    const it = idx.items.find((x) => x.id === id)
    assert.equal(it.tagged, false, `#${id} 应退回未打标`)
    assert.deepEqual(it.tags, [`旧${id}`], '只翻 tagged 标志，不清旧标签（重看失败也不至于变瞎）')
  }
  for (const id of [4, 5, 6, 7]) {
    assert.equal(idx.items.find((x) => x.id === id).tagged, true, `#${id} 不在本批里，不许动`)
  }
  assert.equal(idx.items.find((x) => x.id === 6).blocked, true, 'blocked 的永远不重打')
  assert.equal(idx.items.find((x) => x.id === 7).adult, true, '成人图永远不重打')
  assert.equal(idx.items.find((x) => x.id === 8).tagged, false, '原本就没打标的不用再退')

  const r2 = await tool.execute({ limit: 3 })
  assert.equal(r2.requeued, 2, '第二批只剩 #4/#5')
  assert.equal(r2.pending, 6, '退回的 #1–#5 + 原本未打标的 #8 = 欠 6 张')

  const r3 = await tool.execute({ limit: 3 })
  assert.equal(r3.ok, true)
  assert.equal(r3.requeued, 0)
  assert.equal(r3.note, '没有可重打标的条目')
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 入口 ①b：群里大家在发表情包 → 她也跟一张（2026-11-01 真机）
//    起因：群友连发表情包，OneBot 转成占位文本 [表情]，复读插件跟发了一行字。
//    复读侧已改成"占位符不算一句话"，这里补更像人的反应：她也挑一张真表情发出去。
// ─────────────────────────────────────────────────────────────────────────────

let mirrorMsgId = 9100
function groupStickerMsg(h, qq, text = '[表情]') {
  // 群消息可能触发内核回合；不挂 prompt 桩的话 emitRaw 会一直等模型返回（测试会挂住）
  h.ctx.setPromptHandler(async () => {})
  return emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    self_id: 999999,
    group_id: GROUP_ID,
    user_id: qq,
    message_id: ++mirrorMsgId,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: qq, nickname: `U${qq}` },
  })
}

test('群里两个人发表情包 → 她也跟一张', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: true, mirrorWindowSec: 60, mirrorCooldownSec: 30 } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  await groupStickerMsg(h, MEMBER_QQ)
  await groupStickerMsg(h, 10003)
  await flushStickers(h)

  assert.equal(mediaSent(h).length, 1, '两个人发表情包 → 跟一张')
  assert.equal(mediaSent(h)[0].target, `group:${GROUP_ID}`)
})

test('同一个人连发两条表情包 → 不跟（不是"大家在发"）', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: true } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  await groupStickerMsg(h, MEMBER_QQ)
  await groupStickerMsg(h, MEMBER_QQ)
  await flushStickers(h)

  assert.equal(mediaSent(h).length, 0)
})

test('正常文字消息不算"在发表情包"', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: true } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  await groupStickerMsg(h, MEMBER_QQ, '哈哈哈哈')
  await groupStickerMsg(h, 10003, '笑死')
  await flushStickers(h)

  assert.equal(mediaSent(h).length, 0)
})

test('开关关掉就不跟', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: false } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  await groupStickerMsg(h, MEMBER_QQ)
  await groupStickerMsg(h, 10003)
  await flushStickers(h)

  assert.equal(mediaSent(h).length, 0)
})

test('冷却期内不重复跟（连刷也只发一张）', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: true, mirrorCooldownSec: 300 } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  await groupStickerMsg(h, MEMBER_QQ)
  await groupStickerMsg(h, 10003)
  await flushStickers(h)
  await groupStickerMsg(h, 10004)
  await groupStickerMsg(h, 10005)
  await flushStickers(h)

  assert.equal(mediaSent(h).length, 1, '冷却 5 分钟 → 第二轮不跟')
})

// ── 2026-11-01 真机第二轮：不 @ 也能往群里发表情 ────────────────────────────
test('没有本轮上下文时，send_sticker 用显式 target 也能发（不必等群里 @）', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: false } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  const tool = h.ctx._registeredTools.get('mcp__qq__send_sticker')
  assert.ok(tool, 'send_sticker 应已注册')
  // 不带任何回合上下文：模拟"主人在私聊让她去群里发一张"
  const r = await tool.execute({ target: `group:${GROUP_ID}` }, { agent: { session: { id: 'no-turn-session' } } })
  assert.equal(r?.ok, true, '应能发出去')
  assert.equal(mediaSent(h).length, 1)
  assert.equal(mediaSent(h)[0].target, `group:${GROUP_ID}`)
})

test('send_sticker 既没本轮也没 target → 明确报错（不要静默）', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: false } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  const tool = h.ctx._registeredTools.get('mcp__qq__send_sticker')
  const r = await tool.execute({}, { agent: { session: { id: 'no-turn-session' } } })
  assert.equal(r?.ok, false)
  assert.match(String(r?.reason), /target/)
})

test('send_image 不许发表情库里的图（否则群里变成大图）', async (t) => {
  const h = await boot(t, { stickers: { mirrorGroupStickers: false } })
  seedItems(h.dataDir, [item({ id: 1, hash: 'h1', file: '1-h1.png', tags: ['无语'] })])
  await flushStickers(h)

  const tool = h.ctx._registeredTools.get('mcp__qq__send_image')
  const stickerFile = path.join(h.dataDir, STICKER_DIR, '1-h1.png')
  await assert.rejects(
    () => tool.execute({ target: `group:${GROUP_ID}`, file: stickerFile }, { agent: { session: { id: 's' } } }),
    /send_sticker/,
    '应提示改用 send_sticker，而不是当图片发出去',
  )
})

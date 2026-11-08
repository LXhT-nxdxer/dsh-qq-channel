/**
 * 回归：识图钩子（pipeline before-turn, order 900 / kernel:vision）
 *
 * 钉死的是一条硬契约：**图能看见时，模型收到的必须是文字描述，且不再带 image 块**。
 *
 * 为什么重要：这条线的会话模型（deepseek-flash）不收图片输入。带图提交 → DSH 400
 * (`MODEL_DOES_NOT_SUPPORT_IMAGES`) → 内核丢图降级 → 机器人只能说"图片我收不到"。
 * 所以"把图换成文字、再把图从提交里摘掉"这一步是整条表情包链路的地基：
 * 它没了，上面的识别/打标/挑图全都不成立。
 *
 * 反面同样要测：识图**失败**时必须原样保留图片块（走原来的老实降级），
 * 不许因为识图挂了就把图吞掉、更不许凭空编内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { bootKernel, emitRaw, privateEvent, waitFor, ADMIN_QQ } from './helpers.mjs'
import { createVision } from '../kernel/vision.js'

/** 最小 JPEG 头（够 detectImageMediaType 认成 image/jpeg；sharp 解不开会原样返回，不影响流程）。 */
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])

function tmpImage() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vision-img-')), 'pic.jpg')
  fs.writeFileSync(file, FAKE_JPEG)
  return file
}

/** 假视觉服务：记录请求体，返回固定描述。 */
async function fakeVision({ status = 200, content = '一只橘猫张嘴打哈欠 / 图上的字：早安' } = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { calls.push(JSON.parse(raw)) } catch { calls.push({ raw }) }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status === 200
        ? { choices: [{ message: { content } }] }
        : { error: { message: 'boom' } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { baseUrl, calls, close: () => new Promise((r) => server.close(r)) }
}

async function boot(t, { baseUrl }) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      vision: { enabled: true, baseUrl, apiKey: 'test-key', model: 'test-vl', maxTokens: 200 },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: false },
      },
    },
  })
  t.after(() => h.dispose())
  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })
  return { ...h, prompts }
}

test('私聊发图：描述进 prompt，图不再塞给模型', async (t) => {
  const vision = await fakeVision()
  t.after(() => vision.close())
  const { kernel, prompts } = await boot(t, { baseUrl: vision.baseUrl })

  const img = tmpImage()
  const ev = privateEvent({ text: '看看这个', messageId: 6101 })
  ev.message.push({ type: 'image', data: { file: img, url: '', sub_type: 0 } })
  await emitRaw(kernel, ev)

  await waitFor(() => prompts.length >= 1, { label: '私聊 prompt' })
  const content = prompts[0].content
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

  assert.equal(vision.calls.length, 1, '应该只问视觉接口一次')
  assert.ok(String(vision.calls[0].messages[0].content[0].image_url.url).startsWith('data:image/jpeg;base64,'),
    '图片要以 data URL 传过去')
  assert.ok(text.includes('[图的内容'), `prompt 里应带识图结果：${text}`)
  assert.ok(text.includes('橘猫'), '识图结果要原样带上')
  assert.equal(content.filter((c) => c.type === 'image').length, 0, '识图成功后不该再有 image 块')
})

test('识图失败：图原样保留，走老实降级（不吞图、不编内容）', async (t) => {
  const vision = await fakeVision({ status: 500 })
  t.after(() => vision.close())
  const { kernel, prompts } = await boot(t, { baseUrl: vision.baseUrl })

  const img = tmpImage()
  const ev = privateEvent({ text: '看看这个', messageId: 6102 })
  ev.message.push({ type: 'image', data: { file: img, url: '', sub_type: 0 } })
  await emitRaw(kernel, ev)

  await waitFor(() => prompts.length >= 1, { label: '私聊 prompt（失败路径）' })
  const content = prompts[0].content
  assert.equal(content.filter((c) => c.type === 'image').length, 1, '识图失败必须保住图片块')
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  assert.ok(!text.includes('[图的内容'), '没看到就不许编描述')
})

test('关掉识图（enabled:false）：行为回到改之前，图片照旧塞给模型', async (t) => {
  const vision = await fakeVision()
  t.after(() => vision.close())
  const { kernel, prompts } = await boot(t, { baseUrl: vision.baseUrl })

  const img = tmpImage()
  const ev = privateEvent({ text: '看看这个', messageId: 6103 })
  ev.message.push({ type: 'image', data: { file: img, url: '', sub_type: 0 } })
  // 热开关：控制台写盘后 reloadConfig 会重建 vision 实例
  await kernel.applyRuntimeConfig({ ...kernel.runtime, vision: { enabled: false, baseUrl: vision.baseUrl, apiKey: '' } })
  await emitRaw(kernel, ev)

  await waitFor(() => prompts.length >= 1, { label: '私聊 prompt（关掉识图）' })
  assert.equal(vision.calls.length, 0, '关掉后不应再请求视觉接口')
  assert.equal(prompts[0].content.filter((c) => c.type === 'image').length, 1, '图仍按原样交给模型')
})

test('describeImage：默认提问压成一行，自定义提问（打标）必须保留换行', async (t) => {
  const multiline = '看：橘猫打哈欠，图上的字「早安」\n用：早上打招呼用\n词：早安,元气,猫'
  const vision = await fakeVision({ content: multiline })
  t.after(() => vision.close())
  const log = { info() {}, warn() {}, debug() {}, error() {} }
  const v = createVision({ cfg: { enabled: true, baseUrl: vision.baseUrl, apiKey: 'k', model: 'm' }, log })

  const img = tmpImage()
  const custom = await v.describeImage(img, '按三行输出：看/用/词')
  assert.equal(custom, multiline, '打标要按行解析，换行不能被压掉')

  const auto = await v.describeImage(img)                       // 默认提示词 → 压成一行
  assert.ok(auto.includes(' / '), `默认描述应压成一行：${auto}`)

  assert.equal(await v.describeImage('C:\\no\\such\\file.jpg'), null, '读不到文件要返回 null，不许抛')
})

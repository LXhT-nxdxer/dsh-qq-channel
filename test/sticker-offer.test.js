/**
 * 回归：「主动想起表情包」在**私聊**也要掷骰。
 *
 * 事故：原实现里 `if (!ev.isGroup) return` —— 主人日常全在私聊，结果这条线一次都没提醒过，
 * 日志里 `[表情包] 掷骰命中` 恒为 0，表情包发出次数 0（主人原话："表情包频率要和颜文字差不多"）。
 * 现在私聊默认也提醒（`offerInPrivate` 可关），这条测试盯的就是"别又悄悄只给群聊开"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootKernel, emitRaw, privateEvent, waitFor, groupAtEvent, tmpDir, ADMIN_QQ } from './helpers.mjs'

/** 造一个只有 1 张图的库（掷骰只看 index.json，不碰像素）。 */
function seedLibrary(dataDir) {
  const dir = path.join(dataDir, 'qq-stickers')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    items: [{ id: 1, hash: 'h1', file: '1.jpg', tags: ['无语'], tagged: true, blocked: false, adult: false }],
  }))
}

async function boot(t, dataDir) {
  const h = await bootKernel({
    dataDir,
    config: {
      pacing: { merge: { enabled: false }, reply: { style: { stickerEnabled: true, stickerProbability: 1 } } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: true, offerPercent: 100 },
      },
    },
  })
  t.after(() => h.dispose())
  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })
  return { ...h, prompts }
}

const promptText = (p) => p.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

test('私聊：掷骰命中 → 提示里有「配一张表情包」', async (t) => {
  const dataDir = tmpDir('offer-private')
  seedLibrary(dataDir)
  const { kernel, prompts } = await boot(t, dataDir)

  await emitRaw(kernel, privateEvent({ text: '好无语', messageId: 7001 }))
  await waitFor(() => prompts.length >= 1, { label: '私聊 prompt' })
  const text = promptText(prompts[0])
  assert.ok(text.includes('[表情:'), `私聊也该提醒发表情：${text}`)
  assert.ok(text.includes('send_sticker'), '提示要告诉它调哪个工具')
  assert.ok(text.includes('无语'), '语境里能对上标签就该点名那一个')
})

test('群里：照样提醒（别把群聊那条路弄丢）', async (t) => {
  const dataDir = tmpDir('offer-group')
  seedLibrary(dataDir)
  const { kernel, prompts } = await boot(t, dataDir)

  await emitRaw(kernel, groupAtEvent({ text: '好无语啊', messageId: 7002 }))
  await waitFor(() => prompts.length >= 1, { label: '群聊 prompt' })
  assert.ok(promptText(prompts[0]).includes('[表情:'), '群里也要提醒')
})

test('offerInPrivate=false：私聊不提醒，群聊照旧', async (t) => {
  const dataDir = tmpDir('offer-off')
  seedLibrary(dataDir)
  const { kernel, prompts } = await boot(t, dataDir)
  await kernel.applyRuntimeConfig({
    ...kernel.runtime,
    pluginConfig: { ...kernel.runtime.pluginConfig, stickers: { ...(kernel.runtime.pluginConfig?.stickers || {}), offerInPrivate: false, offerPercent: 100 } },
  })

  await emitRaw(kernel, privateEvent({ text: '好无语', messageId: 7003 }))
  await waitFor(() => prompts.length >= 1, { label: '私聊 prompt（关掉提醒）' })
  assert.ok(!promptText(prompts[0]).includes('[表情:'), '关了就该安静')
})

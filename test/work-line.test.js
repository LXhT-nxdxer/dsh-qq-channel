/**
 * test/work-line.test.js — 办公线（主人私聊 `//xxx`）。
 *
 * 覆盖需求（任务卡「办公线」）：
 *   ① `//x` 被截停（ev.stopped / stopReason）且**不进她的会话**；
 *   ② 单斜杠 `/x`、群里 `//x`、外人私聊 `//x`、光秃秃 `//` 一律不拦；
 *   ③ 指令丢到独立办公会话（work:<主人QQ>）执行，执行结果会投回**她的会话**转述；
 *   ④ 结果摘要**不带命令原文**；她转述那轮 prompt 带哨兵 `[[办公]]`；
 *   ⑤ 办公会话工具门整条放行（work: 是"非 QQ 线"分支），群/外人仍被挡；
 *   ⑥ 日记素材过滤：`//` 指令与她转述轮都不进日记。
 *
 * 全部用 mock 宿主（test/helpers.mjs），不启动真 DSH / NapCat。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  bootKernel, emitRaw, waitFor, tapInbound, tmpDir,
  ADMIN_QQ, MEMBER_QQ, groupAtEvent, privateEvent,
} from './helpers.mjs'
import {
  WORK_SENTINEL, parseWorkCommand, buildWorkPrompt, buildHerPrompt, sanitizeSummary, workKeyOf,
} from '../plugins/work-line/index.js'
import {
  readDayMaterial, loadWorkLineSkipWindows, isWorkCommandText, inAnyWindow,
} from '../plugins/growth/index.js'

const masterKey = `private:${ADMIN_QQ}`
const workKey = workKeyOf(ADMIN_QQ)

/** 统一的测试装配：关掉合批（否则要等窗口）和人设拆条（会多出出站）。 */
async function boot(t, extra = {}) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'persona-voice': { splitReplyEnabled: false } },
      ...extra,
    },
  })
  t.after(() => h.dispose())
  return h
}

const promptTextOf = (p) => String(p?.content?.[0]?.text || '')
const workPromptsOf = (h) => h.ctx._prompts.filter((p) => promptTextOf(p).includes('[办公执行]'))
const herPromptsOf = (h) => h.ctx._prompts.filter((p) => promptTextOf(p).startsWith(WORK_SENTINEL))

test('1. 纯函数：认指令 / 出提示词 / 洗结论（命令原文必须抹掉）', () => {
  assert.deepEqual(parseWorkCommand('//查下E盘还剩多少'), { command: '查下E盘还剩多少' })
  assert.deepEqual(parseWorkCommand('   //  整理下载文件夹  '), { command: '整理下载文件夹' })
  assert.equal(parseWorkCommand('//'), null, '光秃秃 // 不算指令')
  assert.equal(parseWorkCommand('//   '), null, '// 后面只有空白也不算')
  assert.equal(parseWorkCommand('/help'), null, '单斜杠是内核命令，不是办公指令')
  assert.equal(parseWorkCommand('今天天气怎么样'), null)
  assert.equal(parseWorkCommand(null), null)

  const work = buildWorkPrompt('查下E盘还剩多少', { maxChars: 200 })
  assert.ok(work.includes('查下E盘还剩多少'), '执行会话必须知道任务原文')
  assert.ok(work.includes('不要调用 mcp__qq__send_message'), '执行会话不能直接发消息（否则绕过她的转述）')

  const her = buildHerPrompt('E 盘还剩 123 GB', { chatKey: masterKey })
  assert.ok(her.startsWith(WORK_SENTINEL), '她转述那轮必须带哨兵')
  assert.ok(her.includes('E 盘还剩 123 GB'))
  assert.ok(her.includes('这轮别调 remember'), '办公转述轮不写记忆')
  assert.ok(her.includes(`[QQ会话 ${masterKey}`), '要告诉她是哪条线（否则新会话不知道往哪发）')
  assert.ok(her.includes('[QQ线:回话须调工具]'), '要带"回话须调工具"头')

  const dirty = '结果：E 盘还剩 123 GB（按 //查下E盘还剩多少 查的）'
  const clean = sanitizeSummary(dirty, { command: '查下E盘还剩多少', maxChars: 300 })
  assert.ok(clean.includes('123 GB'))
  assert.ok(!clean.includes('查下E盘还剩多少'), '摘要不能带命令原文')
  assert.ok(!clean.includes('//'), '摘要不能带 // 指令')
  assert.equal(sanitizeSummary('', {}), '')
  assert.ok(sanitizeSummary('x'.repeat(400), { maxChars: 300 }).length <= 300, '超长硬截断')
})

test('2. 主人私聊 // 指令：截停 + 回执 + 办公会话执行 + 结果投回她转述', async (t) => {
  const h = await boot(t)
  const inbound = tapInbound(h.kernel)
  // readLastAssistantText：第 1 次是「执行前基线」，第 2 次才是这一单的结论
  let reads = 0
  h.kernel.dsh.readLastAssistantText = async () => {
    reads += 1
    return reads === 1 ? '' : 'E 盘还剩 123 GB（按 //查下E盘还剩多少 查的）'
  }

  await emitRaw(h.kernel, privateEvent({ text: '//查下E盘还剩多少', messageId: 7001 }))
  const ev = await waitFor(() => inbound.events.find((e) => e.messageId === 7001), { label: '指令入站' })
  assert.equal(ev.stopped, true, '指令必须被截停（不进她的会话）')
  assert.equal(ev.stopReason, 'work-line:routed')

  // 立刻回一句轻的，主人知道收到了
  await waitFor(() => h.sent.length >= 1, { label: '收到回执' })
  assert.ok(String(h.sent[0].wire).includes('收到 我去办'), '截下后先回一句轻回执')
  assert.ok(!String(h.sent[0].wire).includes('查下E盘'), '回执里不能带指令原文')

  // 指令进的是办公会话，不是她的会话
  const workPrompt = await waitFor(() => workPromptsOf(h)[0], { label: '办公会话 prompt' })
  const workSid = h.kernel.dsh.sessions.get(workKey)
  assert.ok(workSid, `办公会话应建在 ${workKey}`)
  assert.equal(workPrompt.sessionId, workSid)
  assert.ok(promptTextOf(workPrompt).includes('查下E盘还剩多少'), '执行会话要拿到任务原文')
  assert.equal(h.kernel.dsh.sessions.has(masterKey), false, '指令被截停 → 她的会话不该因此被建')

  // 办公会话跑完（模拟 turn/end）→ 结论投回她的会话
  h.ctx.emit('session/event', { id: workSid }, { type: 'turn/end', turn: 1, reason: 'success' })
  const herPrompt = await waitFor(() => herPromptsOf(h)[0], { label: '她转述的 prompt' })
  const herText = promptTextOf(herPrompt)
  assert.ok(herText.includes('E 盘还剩 123 GB'), '结论要带给她')
  assert.ok(!herText.includes('查下E盘还剩多少'), '结果摘要不带命令原文')
  assert.ok(!herText.includes('//'), '结果摘要不带 // 指令')
  assert.ok(herText.includes(WORK_SENTINEL), '她转述那轮带哨兵（日记过滤靠它对应的窗口）')
  assert.equal(herPrompt.sessionId, h.kernel.dsh.sessions.get(masterKey), '转述要投进她自己的会话')
})

test('3. 不该拦的四种形态：// 空 / 单斜杠 / 群里 / 外人私聊', async (t) => {
  const h = await boot(t, { plugins: { 'private-friend-gate': false } })
  const inbound = tapInbound(h.kernel)
  const routed = () => inbound.events.filter((e) => e.stopReason === 'work-line:routed')

  await emitRaw(h.kernel, privateEvent({ text: '//', messageId: 7101 }))
  await emitRaw(h.kernel, privateEvent({ text: '/help', messageId: 7102 }))
  await emitRaw(h.kernel, groupAtEvent({ text: '//查下E盘还剩多少', messageId: 7103 }))
  await emitRaw(h.kernel, privateEvent({ text: '//查下E盘还剩多少', messageId: 7104, userId: MEMBER_QQ }))
  await new Promise((r) => setTimeout(r, 80))

  assert.equal(routed().length, 0, '这四种都不该被办公线拦')
  assert.equal(workPromptsOf(h).length, 0, '不该投办公会话')
  const helpEv = inbound.events.find((e) => e.messageId === 7102)
  assert.notEqual(helpEv?.stopReason, 'work-line:routed', '单斜杠仍归内核命令分发')
})

test('4. 办公会话全工具：work:<QQ> 走工具门「非 QQ 线」分支整条放行（不是绕过门的后门）', async (t) => {
  const h = await boot(t)
  const guard = h.ctx._guards.find((g) => typeof g === 'function')
  assert.ok(guard, '内核应注册 tools.guard')
  const sidWork = 'sid-work'
  h.kernel.dsh.sessions.set(workKey, sidWork)
  const execOf = (name, sessionId) => ({ name, agent: { session: { id: sessionId } } })

  for (const name of ['pwsh', 'bash', 'read', 'write', 'edit', 'univer_api',
    'mcp__qq__send_message', 'mcp__qq__remember']) {
    assert.equal(guard(execOf(name, sidWork)), undefined, `办公会话应放行 ${name}`)
  }
  // 对照：不是 QQ 线特权——群聊 / 外人私聊照样被挡
  h.kernel.dsh.sessions.set(`private:${MEMBER_QQ}`, 'sid-stranger')
  h.kernel.dsh.sessions.set('group:20001', 'sid-group')
  assert.match(String(guard(execOf('pwsh', 'sid-stranger')) || ''), /私聊模式（非主人）不能调用/)
  assert.match(String(guard(execOf('pwsh', 'sid-group')) || ''), /群聊模式不能调用/)
})

test('4b. 办公线的 preset 独立于私聊线（默认全工具），且 readLastAssistantText 在内核暴露', async (t) => {
  const h = await boot(t, { dsh: { privateAgentPreset: 'chat-only', groupAgentPreset: 'qq-chat' } })
  // 2026-11-01 修正：办公线**不再**跟主人私聊同一档。
  // 真机事故：私聊线被设成纯聊天后，办公会话也跟着没 pwsh，`//c盘还有多少空间` 查不出来。
  assert.equal(h.kernel.dsh.presetFor(workKey), '', '办公线默认空 = DSH 默认全工具')
  assert.equal(h.kernel.dsh.presetFor(masterKey), 'chat-only', '私聊线按配置裁剪成纯聊天')
  // 要裁剪办公线必须显式配
  await h.kernel.dsh.applyConfig({ workAgentPreset: 'full-tools' })
  assert.equal(h.kernel.dsh.presetFor(workKey), 'full-tools', '显式配了才按配的走')
  assert.equal(h.kernel.dsh.presetFor('group:20001'), 'qq-chat')
  assert.equal(typeof h.kernel.dsh.readLastAssistantText, 'function', '办公线读执行结论要靠它')
})

test('5. 日记素材过滤：// 指令与她转述轮都不进日记，正常聊天照留', () => {
  const dir = tmpDir('diary')
  const archive = path.join(dir, 'logs')
  fs.mkdirSync(archive, { recursive: true })
  const now = Date.now()
  const rows = [
    { dir: 'in', ts: now - 60000, sender: { name: '主人' }, text: '今天好累' },
    { dir: 'in', ts: now - 50000, sender: { name: '主人' }, text: '//查下E盘还剩多少' },
    { dir: 'out', ts: now - 40000, messageId: 1, text: '查到了 还有 123G' },
    { dir: 'out', ts: now - 30000, messageId: 2, text: '晚安呀' },
  ]
  fs.writeFileSync(path.join(archive, 'private_10001.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
  const windows = [{ from: now - 45000, to: now - 35000, kind: 'turnaround' }]

  const material = readDayMaterial({
    archiveDir: archive,
    start: now - 120000,
    end: now + 120000,
    skipWindows: windows,
  })
  assert.ok(material.includes('今天好累'), '正常聊天要留着')
  assert.ok(material.includes('晚安呀'), '窗口外的出站要留着')
  assert.ok(!material.includes('//查下'), '办公指令不进日记素材')
  assert.ok(!material.includes('查到了'), '她转述办公结果的轮次不进日记素材')

  assert.equal(isWorkCommandText('//查下E盘还剩多少'), true)
  assert.equal(isWorkCommandText('   //查下'), true)
  assert.equal(isWorkCommandText('// 查下'), true, '// 后带空白也算指令（与 parseWorkCommand 对齐）')
  assert.equal(isWorkCommandText('//'), false, '光秃秃的 // 不是指令')
  assert.equal(isWorkCommandText('/help'), false, '单斜杠不是办公指令')
  assert.equal(inAnyWindow(now, windows), false)
  assert.equal(inAnyWindow(now - 40000, windows), true)
})

test('6. 时间窗落盘：办公线写、growth 读（route + turnaround 两段都在）', async (t) => {
  const h = await boot(t)
  let reads = 0
  h.kernel.dsh.readLastAssistantText = async () => {
    reads += 1
    return reads === 1 ? '' : '下载文件夹整理好了'
  }
  await emitRaw(h.kernel, privateEvent({ text: '//整理下下载文件夹', messageId: 7201 }))
  // 等任务真的进了队列（prompt 投出去 = 队列已 push，turn/end 才收得到尾）
  await waitFor(() => workPromptsOf(h)[0], { label: '办公会话 prompt' })
  const workSid = h.kernel.dsh.sessions.get(workKey)
  assert.ok(workSid)
  h.ctx.emit('session/event', { id: workSid }, { type: 'turn/end', turn: 1, reason: 'success' })
  await waitFor(() => herPromptsOf(h)[0], { label: '她转述的 prompt' })

  // 她那一轮真的跑了 → turn/start 之后 turn/end 才关窗
  const herSid = h.kernel.dsh.sessions.get(masterKey)
  assert.ok(herSid)
  h.ctx.emit('session/event', { id: herSid }, { type: 'turn/start', turn: 1 })
  h.ctx.emit('session/event', { id: herSid }, { type: 'turn/end', turn: 1, reason: 'success' })

  const windows = loadWorkLineSkipWindows(h.dataDir)
  assert.ok(windows.some((w) => w.kind === 'route'), `应有指令+回执窗口：${JSON.stringify(windows)}`)
  const ta = windows.find((w) => w.kind === 'turnaround')
  assert.ok(ta, `应有转述轮窗口：${JSON.stringify(windows)}`)
  assert.ok(ta.to >= ta.from)
  assert.equal(inAnyWindow((ta.from + ta.to) / 2, windows), true)
})

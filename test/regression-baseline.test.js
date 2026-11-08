/**
 * test/regression-baseline.test.js — 「30 题回归基线」：确定性、离线、不调真模型。
 *
 * ── 这份基线管什么 ────────────────────────────────────────────────
 * 只管「规则有没有断」：
 *   · 人设文件（AGENTS.local.md）的硬规则 / 禁词 / 权限 / 与 personas 同源；
 *   · 说话格式（拆条、长度上限、[AT:]、六项脱敏、颜文字/表情包频率）；
 *   · 插件契约（id、order 装配、configSchema、插件数、群/私聊 preset、群聊工具门）；
 *   · 行为规则（复读链、关系分、记忆召回、补回复幂等、断档、总开关、挑图、注入预算）。
 *
 * ── 这份基线不管什么 ──────────────────────────────────────────────
 * **不管“像不像人”、不管回复质量**。它不启动真 DSH 进程 / 不连 NapCat / 不调任何模型 /
 * 不碰网络；只调纯函数、读配置文件、跑 mock-ctx 内核装配（autoConnect:false）。
 * 所以它快、可重复，也只能证明“规则没被改坏”，证明不了“她回得好”。
 *
 * ── 红了怎么办 ────────────────────────────────────────────────────
 * 红 = 这条规则现在真的破了。**不要改断言让它变绿**：
 * 要么修源码/配置，要么明确记录“这条是真实缺陷”。基线就是拿来挡“顺手改坏”的。
 *
 * 数据目录解析（人设 / 实例配置）：优先 $DSH_QQ_DATA_DIR，其次仓库旁的部署目录，
 * 最后 $DSH_HOME/dsh-onebot-qq（含旧名 dsh-qq-bot）。换机器跑时设 DSH_QQ_DATA_DIR 即可。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { defaultConfig } from '../kernel/config-store.js'
import { SENSITIVE_KINDS } from '../contracts.js'
import {
  pickSplitPoint, splitLongText, clipChars, extractAtMarkers, sanitizeSensitive,
} from '../kernel/format.js'
import { advanceChain, rollHit, repeatKey } from '../plugins/group-repeat/index.js'
import {
  MIN_CONFIDENCE, MAX_CONFIDENCE, clampConfidence, applyDelta, buildRelationshipLine,
} from '../plugins/relationship/index.js'
import { createMemoryStore, renderInjection, tokenize, charLength } from '../plugins/memory/store.js'
import { pickPending } from '../plugins/backfill/index.js'
import { pickMissed } from '../plugins/context-gap/index.js'
import { buildDiaryInject } from '../plugins/growth/index.js'
import { createShelf } from '../vendor/dsh-sticker-shelf.mjs'
import { resolveDshHome } from '../platform/paths.js'
import { bootKernel, emitRaw, waitFor, privateEvent, ADMIN_QQ, GROUP_ID } from './helpers.mjs'

// ============================================================
// 夹具：仓库 / 插件清单 / 部署数据目录
// ============================================================
const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugins')

const PLUGIN_IDS = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((id) => fs.existsSync(path.join(PLUGIN_DIR, id, 'index.js')))
  .sort()

/** 静态导入全部子插件（只读 module，不执行 setup；能暴露“导入就炸”/id 漂移）。 */
const PLUGIN_DEFS = await Promise.all(PLUGIN_IDS.map(async (id) => {
  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, id, 'index.js')).href)
  return { id, def: mod.default }
}))

/** 找实例数据目录：候选目录里必须有 workspace/AGENTS.local.md。 */
function findDataDir() {
  const candidates = [
    process.env.DSH_QQ_DATA_DIR,
    path.resolve(REPO_ROOT, '../../dsh/dsh-onebot-qq'),
    path.join(resolveDshHome(), 'dsh-onebot-qq'),
    path.join(resolveDshHome(), 'dsh-qq-bot'),
  ].filter(Boolean).map((p) => path.resolve(String(p)))
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'workspace', 'AGENTS.local.md'))) return dir
  }
  throw new Error(
    '找不到实例数据目录（需要 workspace/AGENTS.local.md）。已尝试：\n  '
    + candidates.join('\n  ')
    + '\n请设置环境变量 DSH_QQ_DATA_DIR 指向 QQ 机器人的实例目录（含 workspace/ 与 personas/）。',
  )
}

function dataDir() {
  return findDataDir()
}

function readPersonaText() {
  return fs.readFileSync(path.join(dataDir(), 'workspace', 'AGENTS.local.md'), 'utf8')
}

/**
 * 读人设文本；**读不到就返回 null**（开源后别人 clone 下来没有数据目录，不能因此 CI 红）。
 * 依赖人设的用例统一用它 + `t.skip`，保证"换台机器/没有部署"时跳过而不是失败。
 */
function readPersonaTextOrNull() {
  try {
    const t = readPersonaText()
    return t && t.trim() ? t : null
  } catch {
    return null
  }
}

/** 读到人设才跑，否则跳过并说明原因。 */
function personaText(t) {
  const text = readPersonaTextOrNull()
  if (!text) {
    t.skip('本机没有部署数据目录（没有人设文件）→ 跳过；设置 DSH_QQ_DATA_DIR 后可跑')
    return null
  }
  return text
}

/** 两份人设比较前的归一：BOM / 换行 / 行尾空白不算漂移。 */
function normPersona(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * 人设相关用例的开关（开源后可移植性）：
 * 别人 clone 下来没有数据目录，读不到人设 → 这些用例应**跳过**而不是失败。
 * 自己机器上想跑：设 DSH_QQ_DATA_DIR 指向部署目录。
 */
const HAS_PERSONA = readPersonaTextOrNull() !== null
const SKIP_PERSONA = '本机没有部署数据目录（没有人设 / config）→ 跳过；设 DSH_QQ_DATA_DIR 指向部署目录后可跑'
const personaTest = HAS_PERSONA ? test : (name, fn) => test(name, { skip: SKIP_PERSONA }, fn)
/** 兼容各种破折号写法的正则片段（人设里用的是 en dash）。 */
const DASH = '[–—\\-~～]'

/** 登记 mock 内核的收尾：先卸载（跑 effect），再删临时数据目录。 */
function trackKernel(t, h) {
  t.after(() => {
    try {
      h.dispose()
    } finally {
      fs.rmSync(h.dataDir, { recursive: true, force: true })
    }
  })
  return h
}

// ============================================================
// 一、人设（8 条）
// ============================================================

personaTest('P1 workspace/AGENTS.local.md 存在且 ≤1600 汉字', () => {
  const file = path.join(dataDir(), 'workspace', 'AGENTS.local.md')
  assert.ok(fs.existsSync(file), `人设文件不存在：${file}`)
  const text = fs.readFileSync(file, 'utf8')
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  assert.ok(cjk > 500, `人设正文太短（汉字 ${cjk}），像被截断了`)
  assert.ok(cjk <= 1600, `人设汉字 ${cjk} 超过 1600：上下文预算会被撑爆，先精简`)
})

personaTest('P2 六条硬规则关键词一条不缺', () => {
  const text = readPersonaText()
  const start = text.indexOf('六条硬规则')
  assert.ok(start >= 0, '找不到「六条硬规则」小节')
  const end = text.indexOf('\n---', start)
  const section = text.slice(start, end === -1 ? undefined : end)
  for (const kw of ['不并列', '不陈述', '不自证', '不叫称呼', '分条发', '颜文字是情绪']) {
    assert.ok(section.includes(kw), `六条硬规则里缺「${kw}」`)
  }
  assert.equal((section.match(/^\s*\d\.\s/gm) || []).length, 6, '硬规则必须是 6 条编号项')
})

personaTest('P3 禁词只出现在“禁说”语境，不拿「主人」当称呼', () => {
  const text = readPersonaText()
  const lines = text.split(/\r?\n/)
  let inForbiddenSection = false
  const hits = []
  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      inForbiddenSection = heading[1].includes('她不会说的话')
      continue
    }
    if (inForbiddenSection) continue
    if (/不叫称呼|不叫主人|不会说|禁说/.test(line)) continue
    if (line.includes('人家') || line.includes('您') || line.includes('好的呢')) hits.push(line)
    // 「主人」可以作第三人称（权限规则里），但不能当称呼：行首/标点后 + 标点/语气词收尾
    if (/(^|[\s「『“"（(])主人(?=[，,。.!！?？、~～\s]|$)/.test(line)) hits.push(line)
  }
  assert.deepEqual(hits, [], `禁词被当成正常说法了（要么是称呼，要么是客服腔）：\n${hits.join('\n')}`)
})

personaTest('P4 AGENTS.local.md 与 personas/小汐曦.md 同源（防两份漂移）', () => {
  const workspaceFile = path.join(dataDir(), 'workspace', 'AGENTS.local.md')
  const personaFile = path.join(dataDir(), 'personas', '小汐曦.md')
  assert.ok(fs.existsSync(personaFile), `人设源文件不存在：${personaFile}`)
  const a = normPersona(fs.readFileSync(workspaceFile, 'utf8'))
  const b = normPersona(fs.readFileSync(personaFile, 'utf8'))
  assert.equal(a, b, 'workspace/AGENTS.local.md 与 personas/小汐曦.md 内容不一致：改一处必须同步另一处')
})

personaTest('P5 权限：只帮主人（人设里写明主人 QQ）', () => {
  const text = readPersonaText()
  // 不校验具体号码（仓库公开，号码属于部署方自己的）
  assert.match(text, /\b\d{5,12}\b/, '权限规则里必须写明主人的 QQ 号')
})

personaTest('P6 权限：别人让操作电脑 → 装傻', () => {
  const text = readPersonaText()
  assert.match(text, /装傻/, '缺少“装傻”这条规则')
  for (const line of ['我不会弄这个', '你找别人吧', '我就一聊天的']) {
    assert.ok(text.includes(line), `装傻话术缺「${line}」`)
  }
  assert.match(text, /一律「不能」「我哪会」/, '别人问权限时必须回「不能」「我哪会」')
})

personaTest('P7 权限：主人命令必须服从，不反问条件', () => {
  const text = readPersonaText()
  assert.match(text, /必须服从/, '缺少「主人的命令必须服从」')
  assert.match(text, /不许拒绝/, '缺少“不许拒绝”')
  assert.match(text, /直接做/, '缺少“直接做”')
  assert.match(text, /不讲条件/, '缺少“不讲条件”')
  assert.match(text, /不许反问「要不要我帮你」/, '必须明确禁止反问「要不要我帮你」')
})

personaTest('P8 权限：会伤害主人的事前先问「你确定？」', () => {
  const text = readPersonaText()
  assert.match(text, /你确定/, '缺少「你确定？」这道例外闸门')
  assert.match(text, /删重要数据/, '例外要包含“删重要数据”')
  assert.match(text, /转钱/, '例外要包含“转钱”')
  assert.match(text, /发隐私/, '例外要包含“发隐私”')
})

// ============================================================
// 二、说话格式（6 条）
// ============================================================

personaTest('F1 拆条：一条 10–15 字、句末不打句号；拆分只拆“短反应 + 正话”', () => {
  const text = readPersonaText()
  assert.match(text, new RegExp(`一条\\s*10\\s*${DASH}\\s*15\\s*字`), '人设里必须写「一条 10–15 字」')
  assert.match(text, /句末不打句号/, '人设里必须写「句末不打句号」')

  // 现状没有“把长句切成多条 10–15 字”的函数：10–15 字靠人设约束，
  // pickSplitPoint 只负责把「短开头 + 正话」拆两条，且绝不拦腰砍句。
  const parts = pickSplitPoint('好耶。今天去吃了火锅还挺开心的')
  assert.deepEqual(parts, ['好耶。', '今天去吃了火锅还挺开心的'])
  assert.match(parts[0], /^[^。！？!?…～~\n]{1,13}[。！？!?…～~]$/, '第一条必须是 ≤13 字的短反应')
  assert.ok([...parts[1]].length >= 8, '第二条（正话）至少 8 字，太短不许拆')
  assert.equal(parts.join(''), '好耶。今天去吃了火锅还挺开心的', '拆条不许丢字')

  assert.equal(pickSplitPoint('这是一句没有任何自然断点的很长很长的句子'), null, '没有自然断点必须单条发')
  assert.equal(pickSplitPoint('短。'), null, '太短不许拆')
})

test('F2 回复长度上限：默认 3000 字，超长按上限分片且一字不丢', () => {
  const cfg = defaultConfig()
  assert.equal(cfg.outbound.replyMaxLength, 3000, '出口上限默认必须是 3000 字')

  const original = '字'.repeat(7000)
  const parts = splitLongText(original, { max: cfg.outbound.replyMaxLength })
  assert.ok(parts.length >= 2, '7000 字必须被分片')
  for (const part of parts) assert.ok([...part].length <= 3000, `分片超上限：${[...part].length}`)
  assert.equal(parts.join(''), original, '分片必须无损（拼接回原文）')

  // 长度截断按码点，绝不切出半个 emoji（切出孤立代理会让之后每轮请求 400）
  assert.equal(clipChars('😀'.repeat(10), 3), '😀😀😀')
})

test('F3 [AT:] 提取：qq= 号码 / 名字，不误伤普通方括号', () => {
  assert.deepEqual(extractAtMarkers('[AT:qq=123456] 你好'), { text: '你好', qq: [123456], names: [] })
  assert.deepEqual(extractAtMarkers('[AT:奶茶] 在吗'), { text: '在吗', qq: [], names: ['奶茶'] })
  assert.deepEqual(extractAtMarkers('[普通] 文字'), { text: '[普通] 文字', qq: [], names: [] }, '普通方括号不许当 @')
})

// 2026-11-04 真机：她在群里发过「[已隐去]  你不可爱」——
// 正文里手写的 `@号码` 没被抽成 @ 段，下一步脱敏把它当隐私换掉了。
test('F3b 正文里手写的 @号码 / ＠号码 也要变成真 @', () => {
  assert.deepEqual(extractAtMarkers('@10002 你不可爱'), { text: '你不可爱', qq: [10002], names: [] })
  assert.deepEqual(extractAtMarkers('＠10002 你不可爱'), { text: '你不可爱', qq: [10002], names: [] })
  assert.deepEqual(extractAtMarkers('@10002你不可爱'), { text: '你不可爱', qq: [10002], names: [] })
  assert.deepEqual(extractAtMarkers('@123 你好'), { text: '@123 你好', qq: [], names: [] }, '位数不够不是 QQ 号，别改原文')
  assert.deepEqual(extractAtMarkers('user@123456789'), { text: 'user@123456789', qq: [], names: [] }, '邮箱形态不许当 @')
})

test('F4 六项脱敏：qq/ip/port/rootCred/password/apiKey + 主人私聊豁免', () => {
  const samples = [
    ['qq', 'QQ 987654321'],
    ['ip', '10.0.0.1:8080'],
    ['port', '端口 8080'],
    ['rootCred', 'root 密码是 abc123'],
    ['password', '密码：abc'],
    ['apiKey', 'api_key=sk-abcdefgh123'],
  ]
  const seen = new Set()
  for (const [kind, raw] of samples) {
    const r = sanitizeSensitive(raw)
    assert.ok(r.hits.includes(kind), `${kind} 样例没命中：${raw}`)
    assert.match(r.text, /\[已隐去\]/, `${kind} 命中后必须替换成 [已隐去]`)
    for (const h of r.hits) seen.add(h)
  }
  assert.deepEqual([...seen].sort(), [...SENSITIVE_KINDS].sort(), '六项脱敏必须与契约 SENSITIVE_KINDS 完全一致')

  // 唯一豁免：主人私聊（别的地方 exempt=true 就是漏洞）
  assert.equal(sanitizeSensitive('QQ 987654321', { exempt: true }).text, 'QQ 987654321')
  assert.equal(sanitizeSensitive('QQ 987654321').text, '[已隐去]')

  // 别误伤日常数字（等级 / 人数 / 时间）
  assert.deepEqual(sanitizeSensitive('2026-10-31 10:30 等级 42 人数 7').hits, [])
})

// 2026-11-06：用户嫌可爱度不够、颜文字太少，频率从「每 5–6 条」提到「每 2–3 条」。
personaTest('F5 颜文字频率默认：每 2–3 条一个', () => {
  const text = readPersonaText()
  assert.match(text, new RegExp(`颜文字[^\\n]{0,20}每\\s*2\\s*${DASH}\\s*3\\s*条一个`), '颜文字频率必须是「每 2–3 条一个」')
  assert.match(text, /连着两条别都用/, '必须写清“连着两条别都用”')
})

personaTest('F6 表情包频率默认：每 4–6 条一张、每轮最多 1 张', () => {
  const text = readPersonaText()
  // 只锁事实（同一行里既有「表情包」又有「每 4–6 条…一张」），不锁顺序和字数：
  // 这段措辞改过两次（"带一张"→"当文字用"），顺序也会变，硬绑位置等于给自己造红。
  assert.match(text, new RegExp(`^.*表情包.*每\\s*4\\s*${DASH}\\s*6\\s*条[^\\n]{0,8}一张.*$`, 'm'), '表情包频率必须是「每 4–6 条一张」')

  const stickers = PLUGIN_DEFS.find((p) => p.id === 'stickers')?.def
  assert.ok(stickers, '找不到 stickers 插件')
  assert.equal(stickers.configSchema.offerPercent.default, 80, '主动想起概率默认 80%')
  assert.equal(stickers.configSchema.maxPerTurn.default, 1, '每轮最多 1 张')
})

// ============================================================
// 三、插件契约（8 条）
// ============================================================

test('C1 每个插件目录都有默认导出：id === 目录名、setup 是函数', () => {
  assert.ok(PLUGIN_IDS.length >= 20, `子插件数量异常：${PLUGIN_IDS.length}`)
  for (const { id, def } of PLUGIN_DEFS) {
    assert.ok(def && typeof def === 'object', `${id}: 没有默认导出的插件对象`)
    assert.equal(String(def.id), id, `${id}: def.id=${def.id} 与目录名不一致`)
    assert.equal(typeof def.setup, 'function', `${id}: 缺少 setup(bot)`)
    assert.ok(def.configSchema && typeof def.configSchema === 'object', `${id}: 缺少 configSchema`)
  }
})

test('C2 装配顺序：order 非递减（同 order 按 id 稳定，重复是设计如此）', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  trackKernel(t, h)

  const seq = h.kernel.pluginDefs.map((p) => [Number(p.order) || 100, p.id])
  assert.equal(seq.length, PLUGIN_IDS.length, '装配清单必须覆盖全部插件目录')
  // 允许同 order 并列（同阶段）；并列组必须按 id 稳定排序，否则装配结果依赖目录读取顺序。
  const sorted = [...seq].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
  assert.deepEqual(seq, sorted, '插件装配顺序必须 order 非递减、同 order 按 id 稳定')

  const idx = (id) => seq.findIndex((x) => x[1] === id)
  assert.ok(idx('owner-commands') < idx('gate-wake'), '群聊总开关必须早于门禁/唤醒')
  assert.ok(idx('gate-wake') < idx('persona-voice'), '门禁必须早于人设拆条')
  assert.ok(idx('persona-voice') < idx('stickers'), '拆条必须早于表情包')
})

test('C3 装配用的 order 与插件自己声明的 order 一致（发现层不许偷偷改序）', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  trackKernel(t, h)

  const declared = new Map(PLUGIN_DEFS.map(({ id, def }) => [id, Number(def.order) || 100]))
  const mismatched = []
  for (const def of h.kernel.pluginDefs) {
    const want = declared.get(def.id)
    if (want === undefined) mismatched.push(`${def.id}: 目录里没有对应插件定义`)
    else if ((Number(def.order) || 100) !== want) mismatched.push(`${def.id}: 声明 ${want} / 装配 ${def.order}`)
  }
  assert.deepEqual(mismatched, [], `order 被改建：\n${mismatched.join('\n')}`)
  // 同 order 是允许的（同阶段并列）；装配层只负责稳定排序，见 C2。
  const orders = PLUGIN_DEFS.map(({ def }) => Number(def.order) || 100)
  assert.ok(orders.every((o) => Number.isInteger(o) && o >= 0), 'order 必须是非负整数')
})

test('C4 configSchema 字段的 type 都在控制台支持集内', () => {
  // 控制台（admin/schema.js JSDoc + client.js 控件）实际支持的类型。
  // 注意：'string' 不合法 —— 前端会掉进数字输入框，文本字段直接编辑不了。
  const LEGAL = new Set(['bool', 'int', 'float', 'str', 'text', 'enum', 'group', 'info'])
  const bad = []
  for (const { id, def } of PLUGIN_DEFS) {
    for (const [key, field] of Object.entries(def.configSchema || {})) {
      if (!LEGAL.has(field?.type)) bad.push(`${id}.${key} = type:'${field?.type}'`)
    }
  }
  assert.deepEqual(bad, [], `configSchema 有不合法 type：\n${bad.join('\n')}`)
})

test('C5 configSchema 字段有 group/label/hint（info 用 text；被内核接管的隐藏字段除外）', () => {
  // 这四个拆条字段在 admin/schema.js 的 HIDDEN_PLUGIN_FIELDS 里，控制台由
  // pacing.reply.style.* 的权威控件渲染，插件侧不渲染 → 不要求 hint。
  // （stickers.offerPercent 同理。）
  const HIDDEN_HINT_FIELDS = {
    'persona-voice': new Set(['splitReplyEnabled', 'splitReplyProbability', 'splitReplyMinLen', 'splitReplyDelayMs']),
    stickers: new Set(['offerPercent']),
  }
  const missing = []
  for (const { id, def } of PLUGIN_DEFS) {
    for (const [key, field] of Object.entries(def.configSchema || {})) {
      const where = `${id}.${key}`
      if (!field?.group) missing.push(`${where}: 缺 group`)
      if (field?.type === 'info') {
        if (!field.text) missing.push(`${where}: info 块缺 text`)
        continue
      }
      if (!field?.label) missing.push(`${where}: 缺 label`)
      const hidden = HIDDEN_HINT_FIELDS[id]?.has(key)
      if (!hidden && !field?.hint) missing.push(`${where}: 缺 hint`)
    }
  }
  assert.deepEqual(missing, [], `configSchema 字段不完整：\n${missing.join('\n')}`)
})

test('C6 插件数量 == pluginDefs 数量（无静默跳过、无加载错误）', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  trackKernel(t, h)

  assert.equal(h.kernel.pluginDefs.length, PLUGIN_IDS.length, 'pluginDefs 漏了插件（发现阶段静默跳过）')
  assert.equal(h.kernel.plugins.length, h.kernel.pluginDefs.length, 'pluginDefs 数量与实际加载数量不一致')
  assert.equal(h.kernel.pluginErrors.size, 0, `有插件加载失败：${[...h.kernel.pluginErrors.keys()].join(',')}`)
  const loadedIds = new Set(h.kernel.plugins.map((p) => p.id))
  for (const def of h.kernel.pluginDefs) {
    assert.equal(def.loaded, true, `${def.id}: pluginDefs 显示未加载`)
    assert.equal(def.error, null, `${def.id}: ${def.error}`)
    assert.ok(loadedIds.has(def.id), `${def.id}: 不在已加载插件表里`)
  }
})

personaTest('C7 群线 preset = qq-chat，私聊 = 默认（读实例 config + 装配结果）', async (t) => {
  const cfgFile = path.join(dataDir(), 'config.json')
  assert.ok(fs.existsSync(cfgFile), `实例配置不存在：${cfgFile}`)
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  assert.ok(cfg.dsh && typeof cfg.dsh === 'object', '实例配置缺 dsh 段')

  // 私聊线：空 = 沿用 DSH 默认（全工具）。私聊不能被群聊 preset 一起切走。
  assert.equal(String(cfg.dsh.agentPreset ?? ''), '', '私聊线必须走默认（agentPreset 留空），不能套群聊的 qq-chat')
  // 群聊线：显式配了就必须是 qq-chat；没配则内核回落到内置 qq-chat（下面用装配结果验证回落）。
  if (Object.prototype.hasOwnProperty.call(cfg.dsh, 'groupAgentPreset')) {
    assert.equal(String(cfg.dsh.groupAgentPreset || ''), 'qq-chat', '群聊线 preset 必须是 qq-chat（纯聊天+联网）')
  }

  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } }, dsh: { agentPreset: '' } } })
  trackKernel(t, h)
  assert.equal(h.kernel.dsh.presetFor(`group:${GROUP_ID}`), 'qq-chat', '群聊新建会话必须带内置 qq-chat')
  assert.equal(h.kernel.dsh.presetFor(`private:${ADMIN_QQ}`), '', '私聊新建会话不指定 preset（DSH 默认全工具）')
})

test('C8 群聊工具门：只放行 mcp__qq__*（记忆写入除外）与 web_search/web_fetch', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } }, dsh: { agentPreset: '' } } })
  trackKernel(t, h)

  const guard = h.ctx._guards.find((g) => typeof g === 'function')
  assert.ok(guard, '内核没有注册 tools.guard 群聊工具门')
  const groupSession = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  const privateSession = await h.kernel.dsh.ensureSession(`private:${ADMIN_QQ}`)
  const exec = (name, sessionId) => ({ name, agent: { session: { id: sessionId } } })

  assert.ok(h.kernel.toolDefs.size > 0, '内核没注册任何 QQ 工具')
  // 记忆写入（remember / memory_append …）和普通聊天工具不同：它改长期记忆，只有主人回合能调，
  // 所以不在"群聊全放行"的循环里；下面单独断言外人回合拒绝、主人回合放行。
  const MEMORY_WRITE = new Set(['remember', 'memory_append', 'memory_forget', 'memory_delete'])
  for (const name of h.kernel.toolDefs.keys()) {
    if (MEMORY_WRITE.has(name)) continue
    assert.equal(guard(exec(`mcp__qq__${name}`, groupSession)), undefined, `群聊应放行 mcp__qq__${name}`)
  }
  for (const name of ['web_search', 'web_fetch']) {
    assert.equal(guard(exec(name, groupSession)), undefined, `群聊应放行 ${name}`)
  }
  for (const name of ['pwsh', 'bash', 'read', 'write', 'edit', 'univer_api', 'subagent', 'mcp__workspace_mcp__read_file']) {
    assert.match(String(guard(exec(name, groupSession)) || ''), /群聊模式不能调用/, `群聊必须拒绝 ${name}`)
  }
  // 记忆写入：没有本轮身份（认不出是谁）→ 按外人拒绝；主人群聊回合（turnCtx 标了）→ 放行。
  assert.match(String(guard(exec('mcp__qq__remember', groupSession)) || ''), /记忆只能由主人写入/)
  h.kernel.turnBySession.set(groupSession, { chatKey: `group:${GROUP_ID}`, senderIsMaster: true })
  assert.equal(guard(exec('mcp__qq__remember', groupSession)), undefined, '主人群聊回合可以写记忆')
  assert.equal(guard(exec('pwsh', privateSession)), undefined, '私聊线不受群聊工具门影响')
  assert.equal(guard({ name: 'pwsh' }), undefined, '没有 agent 的调用不拦（不误伤宿主）')
})

// ============================================================
// 四、行为（8 条）
// ============================================================

test('B1 复读：连续同句 + 不同人才触发（advanceChain）', () => {
  const t0 = 1_000_000
  const a = advanceChain(null, { key: '哈哈', sender: 1 }, t0, 120000)
  assert.equal(a.streak, 1)
  assert.deepEqual(a.senders, [1])

  const b = advanceChain(a, { key: '哈哈', sender: 2 }, t0 + 1000, 120000)
  assert.equal(b.streak, 2, '不同人接同一句 = +1，链长涨')
  assert.deepEqual(b.senders, [1, 2])

  const c = advanceChain(b, { key: '哈哈', sender: 2 }, t0 + 2000, 120000)
  assert.equal(c.streak, 2, '同一个人连发不涨链（QQ 不给同一个人显示 +1）')
  assert.deepEqual(c.senders, [1, 2])

  const d = advanceChain(c, { key: '另一句', sender: 1 }, t0 + 3000, 120000)
  assert.equal(d.streak, 1, '中间插一句别的就断链')

  const e = advanceChain(b, { key: '哈哈', sender: 3 }, t0 + 1000 + 120000 + 1, 120000)
  assert.equal(e.streak, 1, '超过窗口就重新建链')

  assert.equal(rollHit(100), true)
  assert.equal(rollHit(0), false)
  assert.equal(repeatKey('好耶！'), repeatKey('好耶'), '标点/全角不该把同一句拆成两句')
})

test('B2 关系：dailyPlusCap 生效，confidence 夹在 30–95', () => {
  const day = new Date(2026, 9, 31, 12, 0, 0).getTime()
  const state = { confidence: 50, notes: [] }

  applyDelta(state, 1, { now: day, dailyPlusCap: 2 })
  assert.equal(state.confidence, 51)
  applyDelta(state, 1, { now: day, dailyPlusCap: 2 })
  assert.equal(state.confidence, 52)

  const capped = applyDelta(state, 1, { now: day, dailyPlusCap: 2 })
  assert.equal(state.confidence, 52, '每日加分额度用完不许再涨')
  assert.equal(capped.capped, true)
  assert.equal(capped.delta, 0)

  applyDelta(state, -1, { now: day, dailyPlusCap: 2 })
  assert.equal(state.confidence, 51, '减分不受每日加分上限限制')

  const nextDay = new Date(2026, 10, 1, 12, 0, 0).getTime()
  applyDelta(state, 1, { now: nextDay, dailyPlusCap: 2 })
  assert.equal(state.confidence, 52, '跨天额度必须重置')

  assert.equal(clampConfidence(100), MAX_CONFIDENCE, '上限 95')
  assert.equal(clampConfidence(0), MIN_CONFIDENCE, '下限 30')
  assert.equal(clampConfidence(72.6), 73, '取整')
})

test('B3 记忆：没有 embedding 时走关键词召回', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-baseline-mem-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'items.json')
  const store = createMemoryStore({ file, now: () => Date.now() })
  store.add('主人喜欢喝美式咖啡，不加糖', { chatKey: 'private:1', importance: 4 })
  store.add('主人养了一只叫团子的猫', { chatKey: 'private:1', importance: 3 })
  store.add('群里的人爱聊原神', { chatKey: 'group:2', importance: 2 })

  const hit = store.recall('咖啡', { chatKey: 'private:1' })
  assert.equal(hit.length, 1, '关键词召回必须命中咖啡那条')
  assert.match(hit[0].item.text, /咖啡/)
  assert.deepEqual(store.recall('量子力学', { chatKey: 'private:1' }), [], '没命中就必须返回空，不许拿不相关的糊弄')

  assert.deepEqual(tokenize('美式咖啡'), ['美式', '式咖', '咖啡'], '中文按 2-gram 切')

  // 换一个实例从盘上读：召回仍然靠关键词，不依赖任何 embedding 服务
  const fresh = createMemoryStore({ file, now: () => Date.now() })
  assert.equal(fresh.recall('团子', { chatKey: 'private:1' }).length, 1)

  const injection = store.buildInjection({ chatKey: 'private:1', query: '咖啡', maxChars: 800 })
  assert.ok(injection.includes('咖啡'))
  assert.ok(charLength(injection) <= 800, '注入硬上限 800 字')
})

test('B4 补回复：doneIds 幂等（补过的不再补）', () => {
  const history = [
    { message_id: 1, user_id: 9, time: 1, message: [{ type: 'text', data: { text: 'a' } }] },
    { message_id: 2, user_id: 7, time: 2, message: [{ type: 'text', data: { text: 'r' } }] },
    { message_id: 3, user_id: 9, time: 3, message: [{ type: 'text', data: { text: 'b' } }] },
    { message_id: 4, user_id: 9, time: 4, message: [{ type: 'text', data: { text: 'c' } }] },
  ]
  const opts = { selfId: 7, adminQq: 9 }

  assert.deepEqual(pickPending(history, opts).pending.map((m) => m.id), ['3', '4'])
  assert.deepEqual(pickPending(history, { ...opts, doneIds: ['3'] }).pending.map((m) => m.id), ['4'])
  assert.deepEqual(pickPending(history, { ...opts, doneIds: new Set(['3', '4']) }).pending, [], '全补过 → 空')
  assert.deepEqual(pickPending(history, { ...opts, doneIds: ['4', '4'], limit: 1 }).pending.map((m) => m.id), ['3'], 'done 去重 + limit 取最新一条')
  assert.deepEqual(pickPending(history.slice(0, 2), opts).pending, [], '她最后一条之后没有主人消息 → 不补')
})

test('B5 断档：pickMissed 只取“她最后一条出站之后”的', () => {
  const history = [
    { message_id: 1, user_id: 9, time: 1, message: [{ type: 'text', data: { text: 'before-self' } }] },
    { message_id: 2, user_id: 7, time: 2, message: [{ type: 'text', data: { text: 'reply' } }] },
    { message_id: 3, user_id: 9, time: 3, message: [{ type: 'text', data: { text: 'after-self' } }] },
    { message_id: 4, user_id: 9, time: 4, message: [{ type: 'text', data: { text: 'current' } }] },
  ]
  const opts = { selfId: 7, adminQq: 9 }

  assert.deepEqual(pickMissed(history, { ...opts, currentMessageId: 4 }).map((m) => m.id), ['3'], '她出站前的主人的话不许算漏回')
  assert.deepEqual(pickMissed(history, opts).map((m) => m.id), ['3', '4'], '没传当前消息时当前这条也在历史里')
  assert.deepEqual(pickMissed(history, { ...opts, currentMessageId: 4, limit: 1 }).map((m) => m.id), ['3'])
  assert.deepEqual(pickMissed(history, { selfId: 0, adminQq: 9 }), [], '认不出她 → 不猜')
  assert.deepEqual(pickMissed(history, { selfId: 7, adminQq: 0 }), [], '认不出主人 → 不猜')
})

test('B6 命令：#命令-关闭群聊功能 主人私聊识别，非主人无效', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'owner-commands': { enabled: true } },
      dsh: { agentPreset: '' },
    },
  })
  trackKernel(t, h)
  const flag = path.join(h.dataDir, 'state', 'owner-commands-groups-off.flag')

  // 主人：关闭 → 标记落盘 + 一句回执
  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 9001, userId: ADMIN_QQ }))
  await waitFor(() => fs.existsSync(flag), { label: '主人关闭标记落盘' })
  assert.equal(h.sent.at(-1)?.wire, '群功能已关闭')

  // 主人：开启 → 标记删除
  await emitRaw(h.kernel, privateEvent({ text: '#命令-开启群聊功能', messageId: 9002, userId: ADMIN_QQ }))
  await waitFor(() => !fs.existsSync(flag), { label: '主人开启标记删除' })
  assert.equal(h.sent.at(-1)?.wire, '群功能已恢复')

  // 非主人：同样的命令必须无效（不写标记、不回复）
  const sentBefore = h.sent.length
  await emitRaw(h.kernel, privateEvent({ text: '#命令-关闭群聊功能', messageId: 9003, userId: 123456 }))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(fs.existsSync(flag), false, '非主人不许关群聊')
  assert.equal(h.sent.length, sentBefore, '非主人发命令不该收到回执')
})

test('B7 表情包挑图：优先最久没用过的（least-used 升序）', (t) => {
  // 索引里的字段是 uses / lastUsed（没有 send_count）；实际排序键是 lastUsed 升序，
  // 也就是“用得最少/最久没露脸的先被挑”，这里锁的是这个可观察行为。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-baseline-shelf-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const items = [
    { id: 1, hash: 'a', file: '1-a.png', ts: 1, uses: 5, lastUsed: 200, tags: ['猫'], tagged: true, blocked: false, adult: false, seenCount: 1 },
    { id: 2, hash: 'b', file: '2-b.png', ts: 1, uses: 0, lastUsed: 0, tags: ['狗'], tagged: true, blocked: false, adult: false, seenCount: 1 },
    { id: 3, hash: 'c', file: '3-c.png', ts: 1, uses: 2, lastUsed: 100, tags: ['猫'], tagged: true, blocked: false, adult: false, seenCount: 1 },
  ]
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items, nextId: 4 }))
  const shelf = createShelf({ dir, describe: async () => '' })
  assert.equal(shelf.stats().usable, 3)

  const originalRandom = Math.random
  Math.random = () => 0 // 固定“从最少用的候选里取第一个”，让顺序确定
  try {
    assert.equal(shelf.resolve('随机').id, 2, '从没用过的（lastUsed=0）先挑')
    assert.equal(shelf.resolve('随机').id, 3)
    assert.equal(shelf.resolve('随机').id, 1)
  } finally {
    Math.random = originalRandom
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  assert.equal(saved.items.find((i) => i.id === 2).uses, 1, '挑中后使用次数要 +1')
})

test('B8 关系/成长/记忆注入 ≤ 各自预算字数', (t) => {
  const relationshipLine = buildRelationshipLine({ confidence: 95, lastMood: '开心' }, 120)
  assert.ok([...relationshipLine].length <= 120, '关系注入必须 ≤120 字')
  assert.match(relationshipLine, /^你和他现在的关系：confidence=\d+ 心情=/)
  assert.ok([...buildRelationshipLine({ confidence: 95, lastMood: '开心' }, 20)].length <= 20, '小预算也必须截断')

  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-baseline-diary-'))
  t.after(() => fs.rmSync(diaryDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(diaryDir, '2026-10-30.md'), '今天很开心'.repeat(60))
  fs.writeFileSync(path.join(diaryDir, '2026-10-31.md'), '今天也很开心'.repeat(60))
  const diary = buildDiaryInject({ dir: diaryDir, today: '2026-10-31', days: 2, maxChars: 300 })
  assert.ok(diary.length > 0, '有日记时必须产出注入块')
  assert.ok([...diary].length <= 300, '成长日记注入必须 ≤300 字')

  const memoryBlock = renderInjection(
    [{ item: { text: '长'.repeat(300) } }, { item: { text: '长'.repeat(300) } }],
    { maxChars: 800, maxItems: 10 },
  )
  assert.ok(charLength(memoryBlock) <= 800, '记忆注入硬上限 800 字')
})

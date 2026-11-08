/**
 * stickers — 表情包子插件（id: 'stickers'，order: 80）
 *
 * 上游核心是随包的 vendor `dsh-sticker-shelf.mjs`（哈希去重 / 删除黑名单 / 大小闸 / index.json /
 * catalog+resolve），我们只补它不做的三件事：① QQ 入站采集；② GIF 按魔数过滤；
 * ③ 失败降级（任何异常都不打扰聊天）。
 *
 * 四条纪律（旧代码注释与事故记录，别改）：
 *  ① **判据只看协议字段**：`emoji_id` 有值 或 `sub_type != 0`；**绝不看 summary 字符串** ——
 *     实测有真人照片/截图带 `[文件名]` 式 summary，靠字符串猜会把照片灌进表情库（手册 §21.1）。
 *  ② **单写者**：index.json 只由本插件**进程内这一条串行队列**写（采集/打标/删条目/记使用全排队）。
 *     旧实现靠"人工冻结采集 → 注入 → 再恢复"才没打架（§21.8 双实例实测整份覆盖、日志无痕）——
 *     这次从结构上根治：本文件不存在第二条写索引的路，外部脚本也不该再写它。
 *  ③ **挑不到就明说，不硬塞**：点名 `#N` 没找到 → 如实返回"没合适的"；关键词没命中才随便给一张。
 *  ④ **自我降级**：库初始化失败 / 取图失败 / 库满 → 只记日志，聊天一个字都不能受影响。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'
import { cqImage } from '../../platform/cq-file.js'
import { normForCompare } from '../../platform/paths.js'

// 用随包自带的 vendor 核心（保证移植时零外部路径依赖），可通过环境变量覆盖（本地调试上游用）。
const BUNDLED_VENDOR = fileURLToPath(new URL('../../vendor/dsh-sticker-shelf.mjs', import.meta.url))
const VENDOR = process.env.QQ_STICKER_VENDOR || BUNDLED_VENDOR
const TAG_INTERVAL_MS = 15 * 60 * 1000 // 打标节流：旧实现靠 cron */15；这里被聊天顺带触发，节奏一样
const TAG_BATCH = 3 // 一次最多 3 张（一张 ≈ 一次看图往返，别堵队列）

/** 打标提示词：只有「看/用/词」三行，**不带安全线**（群聊场景不需要额外的内容过滤词）。 */
const TAG_PROMPT =
  '这是一张 QQ 群里用的表情包（可能是动图，按整体感觉判断）。请严格按三行输出，不要解释、不要编号：\n' +
  '看：这张图上画的是什么（40 字以内，图上的字照抄；看清是笑还是哭、什么表情再写）\n' +
  '用：什么场合/什么心情会发它，以及**它在替哪句话**（合计 20 字以内；例：被问住了 替「说不出话」）\n' +
  '词：2-4 个中文关键词，用逗号分隔，要落在**情绪/氛围/场合/梗**上（如 无语、震惊、夸人、摆烂、投降、撒娇、阴阳怪气、看戏、狗头），' +
  '**其中至少 1 个必须是它替的那句话本身**（如 哈哈哈、？、牛、告辞、离谱、我裂开）；' +
  '每个词覆盖不同角度（画面动作 / 情绪 / 场合梗），彼此不能同义重复（「崩溃/破防/泪目」只能留一个）；' +
  '不要用「可爱/搞笑/表情包/二次元」这类没有区分度的万能词'

// 上游 tagPending 自带 BLOCK 闸（/BLOCK|真人照片|色情|违法/i 命中就永久 block）；我们不要安全线 →
// 在把模型答案交给它之前把触发词中性化（改 vendor 就没法跟上游同步了）。
const BLOCK_NEUTRALIZE = [[/真人照片/gi, '真人素材'], [/色情/gi, '成人向'], [/违法/gi, '违规'], [/\bblock\b/gi, '（无）']]
function sanitizeTag(text) {
  let t = String(text || '')
  for (const [re, to] of BLOCK_NEUTRALIZE) t = t.replace(re, to)
  return t
}

/** 是不是 GIF（GIF87a / GIF89a）。**按内容魔数判，不看扩展名** —— 扩展名改成 .jpg 也拦得住。 */
function isGif(buf) {
  if (!buf || buf.length < 6) return false
  const head = buf.subarray(0, 6).toString('latin1')
  return head === 'GIF87a' || head === 'GIF89a'
}

/**
 * 「这一段是不是一张表情」的**唯一判据**（采集与提示共用）。
 * 判据 = **协议字段**：`emoji_id` 有值 / `sub_type` 非 0（QQ 实测 1=动画表情、7/11=收藏表情类）。
 * 不用上游 `isSticker()`：它只认 `sub_type === '1'`（字符串），7/11 会被静默滤掉。
 * **不看 summary 字符串**：真人照片/截图也带 `[文件名]` 式 summary，靠字符串猜会把照片灌进库。
 */
function isStickerSeg(seg) {
  const d = (seg && seg.data) || seg || {}
  if (d.emoji_id != null && String(d.emoji_id) !== '') return true
  const st = Number(d.sub_type ?? 0)
  return Number.isFinite(st) && st !== 0
}

/**
 * 交给上游 `harvest()` 前把段"翻译"成它认的形态（它只认 `sub_type === '1'` / `emoji_id`）。
 * ⚠️ 必须是**拷贝**：原事件对象后面还要拼 prompt / 发引用，不许被改脏。
 */
function normalizeForUpstream(segs) {
  return (Array.isArray(segs) ? segs : []).map((seg) => {
    if (!seg || seg.type !== 'image' || !isStickerSeg(seg)) return seg
    const d = seg.data || {}
    if ((d.emoji_id != null && String(d.emoji_id) !== '') || String(d.sub_type) === '1') return seg
    return { ...seg, data: { ...d, sub_type: '1' } }
  })
}

/**
 * 串行队列 = **单写者**。index.json 整个库只有一份索引 → 队列必须**进程内唯一**
 * （放 ChatState.get(chatKey) 里会变成每群一条 → 又是并发写）。前一个失败不挡后一个。
 */
class AsyncQueue {
  #tail = Promise.resolve()
  push(fn) {
    const run = this.#tail.then(() => fn())
    this.#tail = run.catch(() => {})
    return run
  }
}

/** 只读索引（写侧是 vendor 的原子替换；读侧剥 BOM，Windows 编辑器另存不会把库读崩）。 */
function readIndex(dir) {
  try {
    const data = readJsonFile(path.join(dir, 'index.json'))
    return data && typeof data === 'object' ? data : { items: [] }
  } catch {
    return { items: [] }
  }
}

export default {
  id: 'stickers',
  title: '表情包',
  order: 80,

  configSchema: {
    enabled: { type: 'bool', default: true, group: '表情包', label: '表情包库（群里自动收 + 挑图发）', hint: '开：自动收集群里的表情包，回话时可以挑一张发；关：不用表情包。' },
    dir: { type: 'str', default: 'qq-stickers', group: '表情包', label: '库目录',
      hint: '相对路径由内核按数据目录解析；index.json 与图片都在这里。**只由本插件一条串行队列写**，别再让外部脚本写它' },
    max: { type: 'int', default: 200, min: 10, max: 2000, step: 10, group: '表情包', label: '库上限（张）',
      hint: '满了跳过新图（不淘汰旧的）；要换血就手动删几张' },
    // 「自动打标」要「看图」：内核现在已注入 bot.describeImage（kernel/vision.js，走 OpenAI 兼容视觉接口）。
    // 没配视觉接口时这一项是死开关 —— setup() 里会 warn 一句「只收不打」，不会静默失效。
    tagging: { type: 'bool', default: true, group: '表情包', label: '自动打标（看图写标签）',
      hint: '新收的表情包自动看图打「看/用/词」标签，挑图时才按情绪/场合挑；需要内核的识图接口（config.json 的 vision 段）配好，没配就只收不打。' },
    skipGif: { type: 'bool', default: true, group: '表情包', label: '跳过 GIF（只收静态图）',
      hint: '按内容魔数判（GIF87a/GIF89a），扩展名改成 .jpg 也拦得住；只挡新收的图' },
    collectGroupsOnly: { type: 'bool', default: true, group: '表情包', label: '只在群里收', hint: '开：只收群聊里的表情；关：私聊里的也收。' },
    offerPercent: { type: 'int', default: 80, min: 0, max: 100, step: 1, unit: '%', group: '表情包', label: '主动想起概率',
      hint: '每轮"提醒它可以发一张"的概率（0=关）；它仍可拒绝 → 实际发出率会低于这个数' },
    offerCooldownMs: { type: 'int', default: 20, min: 0, max: 3600, step: 1, unit: '秒', scale: 1000, group: '表情包', label: '想起冷却',
      hint: '同一会话两次"提醒发表情"的最小间隔' },
    offerInPrivate: { type: 'bool', default: true, group: '表情包', label: '私聊也提醒（默认开）',
      hint: '开：私聊回话也会提醒她"这轮配一张表情"；关：只在群里提醒。私聊是主要聊天场景，关了基本等于不发。' },
    maxPerTurn: { type: 'int', default: 1, min: 1, max: 5, step: 1, group: '表情包', label: '每轮最多几张', hint: '一轮回话最多发几张表情（1 张最自然）。' },
    mirrorGroupStickers: { type: 'bool', default: true, group: '表情包', label: '群里发表情包时她也跟一张',
      hint: '开：群里连着两个人发表情包（纯表情，没有文字）时，她也挑一张真表情发出去；关：只在被提醒/被点名时发。' },
    mirrorWindowSec: { type: 'int', default: 60, min: 5, max: 600, step: 5, unit: '秒', group: '表情包', label: '跟表情的判定窗口',
      hint: '这段时间内至少两个人发了纯表情，才算"大家在发表情包"。默认 60 秒。' },
    mirrorCooldownSec: { type: 'int', default: 300, min: 30, max: 3600, step: 30, unit: '秒', group: '表情包', label: '每个群最短间隔',
      hint: '同一个群刚跟过一张，这段时间内不再跟，防止刷屏。默认 5 分钟。' },
    qqFavorite: { type: 'bool', default: true, group: '表情包', label: '存进她 QQ 的「收藏表情」',
      hint: '开：收到新表情时顺便存进这个 QQ 账号的收藏表情（腾讯那边），发出去就是真表情样式，你手机 QQ 里也能看到；关：只存本地。需要协议端支持 add_custom_face（SnowLuma 有，原版 NapCat 没有）。' },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    // 目录只在建库时定：**不做热迁移**。队列、库句柄、收藏映射全绑在这个路径上，运行中硬切
    // 会变成两个库实例各写各的 index.json（单写者纪律直接被破）。只提示「需重启生效」。
    const dirOf = () => String(cfg.dir || '').trim() || path.join(String(bot.core?.dataDir || '.'), 'qq-stickers')
    const dir = dirOf() // 本次运行实际用的目录（setup 时定下，之后不变）
    let dirChangeWarned = false
    function warnIfDirChanged() {
      if (dirChangeWarned) return
      const configured = dirOf()
      if (!configured || configured === dir) return
      let same = false
      try { same = normForCompare(path.resolve(configured)) === normForCompare(path.resolve(dir)) } catch { same = false }
      if (same) return
      dirChangeWarned = true // 只提示一次，别每条消息刷日志
      log.info(`[表情] 库目录配置已改为「${configured}」，但本次运行仍用「${dir}」：目录变更需重启插件生效`)
    }
    // 单位口径（与 admin-bridge 一致）：schema 写 unit:'秒' + scale:1000 ⇒ 配置存**人话单位（秒）**，
    // 用的时候乘回毫秒。全文件只有这一处换算 —— 内核若改成存毫秒，只改这一行。
    const cooldownMs = () => Math.max(0, Number(cfg.offerCooldownMs) || 0) * 1000
    const maxPerTurn = () => Math.max(1, Number(cfg.maxPerTurn) || 1)
    // 库上限每次现读（vendor 是在建库时把它捕获进闭包的，改配置后必须重建句柄才生效）。
    const maxItemsNow = () => Math.max(1, Number(cfg.max) || 200)

    // 单写者队列。挂到 bot.state 上只是让内核/自检能看见并 await 它；队列本身进程内唯一。
    const queue = new AsyncQueue()
    if (bot.state && typeof bot.state === 'object') bot.state.stickersQueue = queue

    let shelfPromise = null
    let shelfMaxItems = 0
    let lastTagAt = 0
    let prunedAt = 0
    const offerAt = new Map() // chatKey -> 上次提醒时间（丢了也只会早提醒一次，不值得进 ChatState）
    // send_sticker 正在飞的那张「主动接话条数」占位（turn → 条数）。**必须和 turn.proactiveMessages 分开**：
    // 走 deliver 的那条会被内核出站钩子自己数（index.js 的主动接话钩子），我们再 +1 就是一条消息数两遍，
    // 还会让钩子误判「超 2 条」把本该发的这张挡掉；只有不走 deliver 的收藏表情要我们自己补计数。
    const inflightProactive = new WeakMap()

    if (cfg.tagging && typeof bot.describeImage !== 'function') {
      log.warn('[表情] 打标已开，但内核没注入看图能力（bot.describeImage）→ 只收不打；这是契约缺口，找内核补')
    }

    /** 懒加载上游核心；初始化失败就永久降级（返回 null），绝不影响聊天。 */
    function shelf() {
      warnIfDirChanged()
      const wantMax = maxItemsNow()
      // 上限改了：丢掉旧句柄，下一次操作按新值重建（正在跑的那次任务继续用旧句柄，不受影响）。
      // 所有 shelf 使用都在同一条串行队列里（单写者），重建不会出现两个库同时写 index.json。
      if (shelfPromise && wantMax !== shelfMaxItems) {
        log.info(`[表情] 库上限 ${shelfMaxItems} → ${wantMax} 张：重建表情库句柄（下一次操作生效）`)
        shelfPromise = null
      }
      if (!shelfPromise) {
        shelfMaxItems = wantMax
        shelfPromise = import(pathToFileURL(VENDOR).href)
          .then((m) => m.createShelf({
            dir,
            // 打标要"看图"：契约的 bot 上没有视觉方法 → 内核要支持打标就注入 bot.describeImage(file, prompt)。
            describe: async (file, prompt) => {
              if (typeof bot.describeImage !== 'function') throw new Error('内核未注入看图能力 bot.describeImage')
              return sanitizeTag(await bot.describeImage(file, prompt))
            },
            prompt: TAG_PROMPT,
            maxItems: wantMax,
            maxBytes: 2 * 1024 * 1024, // 单张 ≤2MB（旧实现同值；表情常见 1~2MB）
            minBytes: 1024, // 挡掉 icon 那种几十字节的垃圾
            log: (...a) => log.info('[表情] ' + a.join(' ')),
          }))
          .catch((e) => {
            log.warn(`[表情] 库初始化失败，本功能降级（聊天不受影响）: ${e.message}`)
            return null
          })
      }
      return shelfPromise
    }

    // ── QQ 收藏表情（"她收藏在 QQ 里"这条要求）──────────────────────────
    //
    // 本地 `qq-stickers/` 只是索引 + 标签；真身放这个 QQ 账号的「收藏表情」（腾讯服务端），
    // 这样：① 她发出去是**真表情样式**（不是一张带白底的图）；② 你手机 QQ 里能看到同一批。
    // 映射存**旁挂文件** `qq-faces.json`（hash → emoji_id）：index.json 的唯一写者是上游 vendor，
    // 我们绝不写它 —— 这是那套"单写者"纪律，破了两边会互相覆盖。
    const FACE_MAP = 'qq-faces.json'

    function readFaceMap() {
      try {
        const m = readJsonFile(path.join(dir, FACE_MAP))
        return m && typeof m === 'object' && !Array.isArray(m) ? m : {}
      } catch { return {} }
    }
    function writeFaceMap(map) {
      try { writeJsonFileSync(path.join(dir, FACE_MAP), map) } catch (e) { log.warn(`[表情] 写收藏映射失败: ${e.message}`) }
    }
    const faceIdOfHash = (hash) => (hash && readFaceMap()[hash]?.emoji_id) || ''
    /** 编号 → 上游 index 里的哈希（send_sticker 只拿到 id，收藏映射是按 hash 存的）。 */
    const hashOfId = (id) => (readIndex(dir).items.find((i) => Number(i.id) === Number(id)) || {}).hash || ''

    /** 协议端支不支持收藏表情（SnowLuma 有；原版 NapCat 没有 → 全程静默降级）。 */
    // 探测失败**不能永久缓存**：启动早期 NapCat 可能还没连上/没登录，那一下探失败会把
    // 「收藏表情」整条链永久废掉（适配器那层已经改成 60 秒重探，这里也要跟着，不然白改）。
    let faceApiReady = null
    let faceApiRetryAt = 0
    async function faceApi() {
      if (cfg.qqFavorite === false) return false
      if (faceApiReady === true) return true
      if (faceApiRetryAt && Date.now() < faceApiRetryAt) return false
      try {
        faceApiReady = typeof bot.napcat?.hasCustomFaceApi === 'function'
          ? await bot.napcat.hasCustomFaceApi().catch(() => false)
          : false
      } catch { faceApiReady = false }
      if (faceApiReady !== true) faceApiRetryAt = Date.now() + 60000
      return faceApiReady === true
    }

    /** 本地库里还没进 QQ 收藏的，补进去（每轮最多 10 张，失败就下次再说）。 */
    async function pushToQqFavorites(limit = 10) {
      if (!(await faceApi())) return 0
      const map = readFaceMap()
      const todo = readIndex(dir).items.filter((i) => i.file && i.hash && !map[i.hash] && !i.blocked)
      if (!todo.length) return 0
      let added = 0
      for (const it of todo.slice(0, limit)) {
        const p = path.join(dir, it.file)
        if (!fs.existsSync(p)) continue
        const id = await bot.napcat.addCustomFace(p)
        if (!id) continue
        map[it.hash] = { emoji_id: id, at: Date.now(), file: it.file }
        added += 1
      }
      if (added) {
        writeFaceMap(map)
        log.info(`[表情] 已存进 QQ 收藏表情 +${added}（累计 ${Object.keys(map).length} 张）`)
      }
      return added
    }

    /**
     * 发之前发现这张还没进 QQ 收藏 → **当场补进去**。
     *
     * 为什么要有：`pushToQqFavorites` 每轮只补 10 张，新收的表情包可能还没轮到；
     * 这时如果直接回退发本地图，主人看到的就是一张带白底的图片，不是 QQ 表情。
     * 要求是「发 QQ 的表情包」，所以宁可多一次 `add_custom_face`，也要发成真表情。
     */
    async function ensureFace(hit) {
      if (!(await faceApi())) return ''
      const hash = hashOfId(hit?.id)
      if (!hash) return ''
      const existing = faceIdOfHash(hash)
      if (existing) return existing
      if (!hit?.path || !fs.existsSync(hit.path)) return ''
      try {
        const id = await bot.napcat.addCustomFace(hit.path)
        if (!id) return ''
        const map = readFaceMap()
        map[hash] = { emoji_id: id, at: Date.now(), file: path.basename(hit.path), from: 'on-demand' }
        writeFaceMap(map)
        log.info(`[表情] 临时补进 QQ 收藏 #${hit.id}（原来还没轮到同步）`)
        return id
      } catch (e) {
        log.warn(`[表情] 临时补收藏失败（回退发本地图）: ${e.message}`)
        return ''
      }
    }

    /**
     * 拉账号里已有的收藏表情：能对上本地文件的补映射；对不上的下载下来入库（下次打标就认识它了）。
     * 这样"她 QQ 里收藏的"和"她能发的"是同一批。
     */
    async function syncFromQqFavorites() {
      if (!(await faceApi())) return { linked: 0, imported: 0 }
      let faces = []
      try { faces = await bot.napcat.fetchCustomFaces() } catch { return { linked: 0, imported: 0 } }
      if (!Array.isArray(faces) || !faces.length) return { linked: 0, imported: 0 }

      const map = readFaceMap()
      const known = new Set(Object.values(map).map((v) => String(v.emoji_id)))
      const need = faces.filter((f) => f?.emoji_id && f?.md5 && !known.has(String(f.emoji_id)))
      if (!need.length) return { linked: 0, imported: 0 }

      // 本地文件 md5 表（只在有未映射的 QQ 表情时才算，别每次启动都读一遍全库）
      const items = readIndex(dir).items.filter((i) => i.file && i.hash)
      const md5Of = new Map()
      for (const it of items) {
        const p = path.join(dir, it.file)
        try { md5Of.set(crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').toUpperCase(), it.hash) } catch { /* 文件没了就算了 */ }
      }

      let linked = 0
      const orphans = []
      for (const f of need) {
        const hash = md5Of.get(String(f.md5).toUpperCase())
        if (hash && !map[hash]) {
          map[hash] = { emoji_id: String(f.emoji_id), at: Date.now(), from: 'qq' }
          linked += 1
        } else if (!hash) {
          orphans.push(f)
        }
      }
      if (linked) writeFaceMap(map)

      // QQ 里有、本地没有的：下载入库（上游按 hash 去重，重复跑也不会灌两份）
      let imported = 0
      if (orphans.length) {
        const s = await shelf()
        if (s) {
          const segs = orphans.slice(0, 10).map((f) => ({ type: 'image', data: { url: String(f.url || ''), file: '', sub_type: '1', emoji_id: String(f.emoji_id) } }))
          const md5ToEmoji = new Map() // 下载时记下 md5 → emoji_id，入库后按 md5 补映射（否则下次启动会重复推一遍）
          const r = await s.harvest(segs, { nick: 'QQ收藏', uid: 'qq-favorite' }, async (seg) => {
            const url = String(seg?.data?.url || '')
            if (!/^https?:\/\//.test(url)) return null
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
            if (!res.ok) return null
            const buf = Buffer.from(await res.arrayBuffer())
            if (!buf.length) return null
            const md5 = crypto.createHash('md5').update(buf).digest('hex').toUpperCase()
            if (seg?.data?.emoji_id) md5ToEmoji.set(md5, String(seg.data.emoji_id))
            return buf
          })
          imported = Number(r?.added) || 0
          if (imported) log.info(`[表情] 从 QQ 收藏表情拉回 ${imported} 张入库`)
          // 刚入库的文件按 md5 认领 emoji_id（同一份文件 md5 一定一样）
          if (md5ToEmoji.size) {
            let filled = 0
            for (const it of readIndex(dir).items.filter((i) => i.file && i.hash && !map[i.hash])) {
              try {
                const md5 = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, it.file))).digest('hex').toUpperCase()
                const eid = md5ToEmoji.get(md5)
                if (!eid) continue
                map[it.hash] = { emoji_id: eid, at: Date.now(), from: 'qq' }
                filled += 1
              } catch { /* 文件读不到就算了 */ }
            }
            if (filled) { writeFaceMap(map); linked += filled }
          }
        }
      }
      return { linked, imported }
    }

    /**
     * 取图字节：① 段里的 file 是现成本地文件就直接读；② 原始 url 直链兜底。
     * 旧实现第二级是 `napcat.get_file` 溯源（老引用图只有 file 哈希名）；新适配器没暴露 getFile
     * （契约只有 groupHistory/memberInfo/recall/fetchAvatar）→ 老图收不到。passive-tap 本来就只收
     * 当轮新消息（url 新鲜），不为这点在适配器上开洞；失败就跳过这一张。
     */
    async function fetchBytes(file, url) {
      const tried = []
      const local = String(file || '')
      if (local && fs.existsSync(local)) {
        try { if (fs.statSync(local).isFile()) return fs.readFileSync(local) } catch (e) { tried.push(`本地读取失败 ${e.message}`) }
      }
      if (local && !/^https?:\/\//.test(local) && typeof bot.napcat?.getFile === 'function') {
        try {
          const info = await bot.napcat.getFile(local)
          if (info?.file && fs.existsSync(info.file) && fs.statSync(info.file).isFile()) return fs.readFileSync(info.file)
          if (info?.url && /^https?:\/\//.test(info.url)) {
            const r = await fetch(info.url, { signal: AbortSignal.timeout(15000) })
            if (r.ok) return Buffer.from(await r.arrayBuffer())
            tried.push(`溯源直链 HTTP ${r.status}`)
          }
        } catch (e) { tried.push(`get_file ${e.message}`) }
      }
      const link = /^https?:\/\//.test(String(url || '')) ? url : (/^https?:\/\//.test(local) ? local : '')
      if (link) {
        const res = await fetch(link, { signal: AbortSignal.timeout(15000) })
        if (res.ok) return Buffer.from(await res.arrayBuffer())
        tried.push(`直链 HTTP ${res.status}`)
      }
      throw new Error(tried.join(' / ') || '没有可用的图片来源')
    }

    /** 采集一批表情段（已在队列里跑）。 */
    async function harvest(segs, ev) {
      const s = await shelf()
      if (!s) return
      const nick = String(ev.sender?.name || ev.sender?.card || '')
      let gifSkipped = 0 // 我们自己挡掉的 gif（上游只回总数，扣掉它免得"有表情没入库"重复报一遍）
      const r = await s.harvest(normalizeForUpstream(segs), { nick, uid: String(ev.sender?.qq ?? '') }, async (seg) => {
        const d = (seg && seg.data) || {}
        const bytes = await fetchBytes(d.file, d.url)
        // 返回 null = 上游按「跳过」计数（不写索引、不报警告、不算错）
        if (cfg.skipGif !== false && isGif(bytes)) { log.debug('[表情] 跳过 gif（设置了不收动图）'); gifSkipped++; return null }
        return bytes
      })
      if (!r.added && !r.seen) {
        // 静默丢弃路径要留声（旧实现踩过：sub_type 7/11 被上游滤掉、日志一个字都没有）
        const other = r.skipped - gifSkipped
        if (other > 0) log.debug(`[表情] 有表情但没入库：跳过 ${other} 张（取字节失败 / 超出 1KB~2MB 闸 / 格式不认识）`)
        return
      }
      log.info(`[表情] 入库 +${r.added}（已有 ${r.seen}，跳过 ${r.skipped}）${nick ? ' ← ' + nick : ''}`)
      // 新收的顺手存进她 QQ 的收藏表情（已经在队列里 → 天然串行，不会两个采集抢着写映射）
      if (r.added) {
        try { await pushToQqFavorites() } catch (e) { log.warn(`[表情] 存进 QQ 收藏失败（不影响聊天）: ${e.message}`) }
      }
    }

    /** 还等着打标的张数（重打标会把它顶上去 → 打标节奏跟着加快）。 */
    function pendingTagCount() {
      try {
        return readIndex(dir).items.filter((i) => i && i.file && !i.tagged && !i.blocked && !i.adult).length
      } catch { return 0 }
    }

    /**
     * 重打标：把「已打标」的条目退回未打标，让 vendor 用**当前提示词**重看一遍。
     *
     * 为什么需要：打标提示词 2026-10-31 改过一次（多要了「这张图替哪句话」），
     * 老条目还是旧标签（只有可爱/害羞这类情绪词），新提示词对它们不生效。
     * 只翻 `tagged` 标志、**不清旧标签**：重看不成功时旧标签还在，不至于变瞎。
     *
     * 为什么在队列里做：index.json 的唯一写者是 vendor，harvest/tagPending 都在这条队列里跑；
     * 我们的写入也排进去，才不会和它们撞车。
     */
    async function requeueForRetag(limit) {
      return queue.push(async () => {
        const idx = readIndex(dir)
        const items = Array.isArray(idx?.items) ? idx.items : []
        const max = Math.max(1, Number(limit) || 80)
        const targets = items.filter((i) => i && i.tagged && i.file && !i.blocked && !i.adult).slice(0, max)
        if (!targets.length) return { ok: true, requeued: 0, note: '没有可重打标的条目' }
        const set = new Set(targets.map((i) => i.id))
        const next = { ...idx, items: items.map((i) => (set.has(i.id) ? { ...i, tagged: false } : i)) }
        writeJsonFileSync(path.join(dir, 'index.json'), next)
        // ⚠️ 光写盘不够：vendor 的 cache **只在启动 load 一次**，harvest/save 还会把整份内存
        // cache 写回磁盘（把我们刚写的 tagged:false 冲掉），tagPending 也从内存里过滤 → 重打标全部作废。
        // 这里在**队列里**（单写者，此刻没有 harvest/tagPending 在跑）丢掉旧句柄，
        // 下一次 shelf() 会重新 import/load 磁盘上的新状态（vendor 不可改，这是最小可靠做法）。
        shelfPromise = null
        log.info(`[表情] 退回重打标 ${targets.length} 张（后台分批重看，表情库句柄已按新磁盘状态重建）`)
        return { ok: true, requeued: targets.length, pending: pendingTagCount() }
      })
    }

    /** 打标（tagging=true 时）：节流 + 与采集同一条队列（同一写者）。积压 ≥20 张时自动提速。 */
    function maybeTag() {
      if (!cfg.tagging || typeof bot.describeImage !== 'function') return
      const now = Date.now()
      const backlog = pendingTagCount()
      const interval = backlog >= 20 ? 45_000 : TAG_INTERVAL_MS
      const batch = backlog >= 20 ? 5 : TAG_BATCH
      if (now - lastTagAt < interval) return
      lastTagAt = now
      queue.push(async () => {
        const s = await shelf()
        if (!s) return
        const n = await s.tagPending(batch)
        if (n) log.info(`[表情] 打标 ${n} 张（还欠 ${pendingTagCount()}）`)
      }).catch((e) => log.warn(`[表情] 打标失败（不影响聊天）: ${e.message}`))
    }

    /**
     * 清理「文件被手删」的条目（节流 60s）。必须连标签、连哈希一起删 —— 上游可用判据不查文件是否存在，
     * 留着条目就可能挑中一个磁盘上已经没有的路径；哈希进黑名单后同一张再被发进群也收不回来。
     */
    async function pruneLocked(s) {
      const now = Date.now()
      if (now - prunedAt < 60000) return
      prunedAt = now
      const gone = readIndex(dir).items.filter((i) => i.file && !fs.existsSync(path.join(dir, i.file)))
      for (const it of gone) s.remove(it.id, '本地文件被手动删了')
      if (gone.length) log.info(`[表情] 清理 ${gone.length} 条「文件已被手删」的条目（标签一并删掉，hash 已拉黑）：#${gone.map((i) => i.id).join(' #')}`)
    }

    /** 点名 `#N`：只认库里真有的那张，没找到就 null（**绝不换一张别的** —— 严格性是踩坑换来的）。 */
    function pickById(s, q) {
      const n = Number(String(q).replace(/^#/, '')) // ⚠️ 必须剥 #：Number('#3') 是 NaN
      if (!Number.isFinite(n)) return null
      const it = readIndex(dir).items.find((x) => x.id === n)
      if (!it || it.blocked || it.adult || !it.file) return null
      const p = path.join(dir, it.file)
      if (!fs.existsSync(p)) return null
      if (it.tagged) { const r = s.resolve('#' + it.id); if (r && r.path) return r } // 打过标走上游 → 它记 uses/lastUsed
      return { id: it.id, file: it.file, path: p, desc: it.desc || '', use: it.use || '', tags: it.tags || [], untagged: !it.tagged }
    }

    /**
     * 随便挑一张**可用**的（真随机，不防重复 —— 表情包重复用也是一种聊天方法）。
     * 池子包含"刚收未打标"的图：上游 usableItems 只算打过标的，照它挑会永远只用旧图（旧实现真踩过）。
     */
    function pickRandom(s) {
      const usable = readIndex(dir).items.filter((i) => !i.blocked && !i.adult && i.file)
      if (!usable.length) return null
      const it = usable[Math.floor(Math.random() * usable.length)]
      const p = path.join(dir, it.file)
      if (!fs.existsSync(p)) return null // 手删的（prune 通常已清掉，这里只挡竞态）
      if (it.tagged) { const r = s.resolve('#' + it.id); if (r && r.path) return r }
      return { id: it.id, file: it.file, path: p, desc: '', use: '', tags: [], untagged: true }
    }

    /** 挑一张（在队列里跑）。关键词没命中 → 随便给一张；点名没找到 → 如实说没合适的。 */
    async function pickLocked(s, query) {
      await pruneLocked(s)
      const q = String(query || '').trim()
      const pointed = /^#?\d{1,4}$/.test(q) // `#12` / `12` = 点名
      const wantsRandom = !q || q === '随机' || q === '随便'
      let hit = pointed || wantsRandom ? null : s.resolve(q) // 关键词只在"打过标"的池里找
      if ((!hit || !hit.path) && pointed) hit = pickById(s, q)
      if ((!hit || !hit.path) && !pointed) hit = pickRandom(s)
      if (!hit || !hit.path) return { ok: false, reason: '没合适的' }
      return { ok: true, id: hit.id, path: hit.path, untagged: !!hit.untagged, desc: hit.desc || '', use: hit.use || '', tags: hit.tags || [] }
    }

    /** 清单（模型主动问时才给）：刚收未打标的排最前，后面接上游那份（旧图照旧）。 */
    async function catalogLocked(s, limit) {
      const lim = Number(limit) || 30
      await pruneLocked(s)
      const fresh = readIndex(dir).items
        .filter((i) => !i.blocked && !i.adult && i.file && !i.tagged)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, Math.max(1, Math.round(lim / 3)))
        .map((i) => `#${i.id} （刚收的，还没打标 · 可当语气图随便用）`)
      const body = s.catalog(lim) || ''
      return fresh.concat(body ? [body] : []).join('\n')
    }

    /** 随机池大小（只读盘，不排队）：掷骰前置判断"挑得到才提示"。 */
    const pickableCount = () => readIndex(dir).items.filter((i) => !i.blocked && !i.adult && i.file).length

    /** 从上下文里找一个能对上的表情标签（给"主动想起"的提示用；找不到返回 ''） */
    function matchContextTag(ev) {
      let ctx = String(ev?.text || '')
      if (ev?.historyBlock) ctx += '\n' + String(ev.historyBlock)
      if (!ctx.trim()) return ''
      let items = []
      try { items = readIndex(dir).items } catch { return '' }
      const seen = new Set()
      const tags = []
      for (const it of items) {
        if (!it || it.blocked || it.adult || !it.file) continue
        for (const t of (Array.isArray(it.tags) ? it.tags : [])) {
          const w = String(t || '').trim()
          if (w.length >= 2 && !seen.has(w)) { seen.add(w); tags.push(w) }
        }
      }
      for (const w of tags) if (ctx.includes(w)) return w
      return ''
    }

    /** 库里能表达什么（按出现次数取前 N 个词）—— 给"主动想起"的提示用，让模型知道语义空间。 */
    function availableMenu(limit = 6) {
      const counts = new Map()
      let items = []
      try { items = readIndex(dir).items } catch { return [] }
      for (const it of items) {
        if (!it || it.blocked || it.adult || !it.file) continue
        for (const t of (Array.isArray(it.tags) ? it.tags : [])) {
          const w = String(t || '').trim()
          if (w.length >= 2 && w.length <= 6) counts.set(w, (counts.get(w) || 0) + 1)
        }
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([w]) => w)
    }

    /** 挑图（工具与自检共用；所有触碰索引的动作都走这条队列）。 */
    async function pick(query) {
      if (cfg.enabled === false) return { ok: false, reason: '表情库没开' }
      return queue.push(async () => {
        const s = await shelf()
        if (!s) return { ok: false, reason: '表情库不可用' }
        try { return await pickLocked(s, query) } catch (e) {
          log.warn(`[表情] 挑图失败: ${e.message}`)
          return { ok: false, reason: '挑图出错' }
        }
      })
    }

    // ── 入口 ①：旁路采集（fire-and-forget，任何异常只记日志） ──────────────────
    bot.on('passive-tap', (ev) => {
      if (cfg.enabled === false) return
      if (cfg.collectGroupsOnly !== false && !ev.isGroup) return
      // 直接从**原始段**读协议字段：这条判据是我们自己钉的，不借道适配器算好的 ev.images[].isSticker（防它改宽）
      const segs = (ev.rawSegments || []).filter((s) => s && s.type === 'image' && isStickerSeg(s))
      if (!segs.length) return
      queue.push(() => harvest(segs, ev)).catch((e) => log.warn(`[表情] 采集失败（不影响聊天）: ${e.message}`))
      maybeTag()
    })

    // ── 入口 ①b：群里大家在发表情包 → 她也跟一张真表情（2026-11-01）───────────
    // 起因：群友连发表情包，OneBot 把图转成 `[表情]` 占位文本；复读插件把它当"同一句话"，
    // 于是群里冒出一条字面量「[表情]」——很难看。复读那边已经改成"占位符不算一句话"，
    // 这里补上更像人的反应：既然大家在发表情，她也挑一张发出去（不是复读那行字）。
    //
    // 判据：同一群、窗口内、**两个人以上**发了"纯占位符"消息（没有任何文字）；每群有冷却。
    const mirrorState = new Map() // chatKey -> { senders:Set, firstAt, lastFiredAt }
    bot.on('passive-tap', (ev) => {
      if (cfg.enabled === false || cfg.mirrorGroupStickers === false) return
      if (!ev?.isGroup) return
      if (ev.sender?.isSelf === true) return
      const qq = Number(ev.sender?.qq)
      if (!Number.isInteger(qq) || qq <= 0) return
      if (!isPlaceholderOnly(ev.text)) return
      const key = String(ev.chatKey || '')
      if (!key) return

      const now = Date.now()
      const winMs = Math.max(5, Number(cfg.mirrorWindowSec) || 60) * 1000
      const cdMs = Math.max(30, Number(cfg.mirrorCooldownSec) || 300) * 1000
      let st = mirrorState.get(key)
      if (!st) { st = { senders: new Set(), firstAt: now, lastFiredAt: 0 }; mirrorState.set(key, st) }
      if (now - st.firstAt > winMs) { st.senders.clear(); st.firstAt = now }
      if (now - Number(st.lastFiredAt || 0) < cdMs) return
      st.senders.add(qq)
      if (st.senders.size < 2) return

      // 触发一次：先占冷却再动手，失败不回滚（宁可少发一张，也不要把冷却弄丢导致连发）
      st.senders.clear()
      st.firstAt = now
      st.lastFiredAt = now
      // ⚠️ 这里**不能**再用 queue.push 包一层：`pick()` 内部本身就是 queue.push，
      // 套进去就是"自己等自己"→ 永久死锁（2026-11-01 写测试时踩到，测试直接挂住）。
      ;(async () => {
        try {
          const hit = await pick('')
          if (!hit?.ok) return
          const asFace = await sendHitTo(key, hit)
          log.info(`[表情] 群里在发表情包 → 跟一张 #${hit.id}${asFace ? '(QQ收藏表情)' : '(本地图)'} → ${key}`)
        } catch (e) {
          log.warn(`[表情] 跟发表情包失败（不影响聊天）: ${e.message}`)
        }
      })()
    })

    /**
     * 整条消息是不是"只有占位符"（表情/图片/CQ 码），没有任何文字。
     * 纯图片消息在 OneBot 里 text 可能是 `[图片]`/`[表情]`，也可能是空串 —— 两种都算。
     */
    function isPlaceholderOnly(text) {
      const t = String(text ?? '')
      if (!t.trim()) return true
      const cleaned = t
        .replace(/\[CQ:[^\]]*\]/g, '')
        .replace(/\[[^[\]]{1,10}\]/g, '')
        .trim()
      return cleaned.length === 0
    }

    /**
     * 把一张图发到某条线：优先 QQ 收藏表情（真表情样式），失败回退本地图。
     * 和 `send_sticker` 工具同一套策略，但**不占每轮额度**——这是插件自己跟的一张，
     * 不是模型回话，走不到 turn.stickersSent 那套计数里。
     * @returns {Promise<boolean>} true = 发成了真表情
     */
    async function sendHitTo(chatKey, hit) {
      const faceId = (await faceApi())
        ? (faceIdOfHash(hashOfId(hit.id)) || (await ensureFace(hit)))
        : ''
      if (faceId) {
        try {
          await bot.napcat.sendCustomFace(chatKey, faceId)
          return true
        } catch (e) {
          log.warn(`[表情] 跟发收藏表情失败，回退本地图: ${e.message}`)
        }
      }
      await bot.sendMedia(chatKey, cqImage(hit.path), '')
      return false
    }

    // ── 入口 ②：主动想起（内核管概率、模型管语境、本插件管挑图） ───────────────    // 命中只往 hint 加一行短标记；发不发、发什么由模型定 —— 内核不懂语境，绝不替它直发。
    // 前置（任一不满足就不掷、零成本）：库开着 / 概率>0 / 这条线允许提醒 / 冷却已过 / 库里有可挑的图。
    //
    // ⚠️ 2026-10-31 改：**私聊也提醒**。原来是 `!ev.isGroup` 直接 return，结果主人天天在私聊聊，
    //   一次都没提醒过 → 表情包发出次数为 0（日志里"掷骰命中"是 0 条）。主人要求"表情包频率和颜文字差不多"，
    //   那私聊必须算在内；不想在私聊提醒就把 offerInPrivate 关掉。
    bot.on('before-turn', (ev) => {
      warnIfDirChanged() // 目录配置变了就留一条「需重启」提示（只一次）
      if (cfg.enabled === false || !ev.wake) return // 没唤醒的消息不该掷骰（也别白推进冷却）
      if (ev.wake.kind === 'welcome') return // 入群欢迎轮只发欢迎语，别塞"发表情包"提醒分心
      const pct = Number(cfg.offerPercent) || 0
      if (!(pct > 0) || (!ev.isGroup && cfg.offerInPrivate === false)) return
      const now = Date.now()
      const cd = cooldownMs()
      if (cd > 0 && now - (offerAt.get(ev.chatKey) || 0) < cd) return
      const pool = pickableCount()
      if (!(pool > 0) || Math.random() * 100 >= pct) return // 挑得到才提示（免得模型白跑一趟）
      offerAt.set(ev.chatKey, now)
      // 结合语境：能从最近聊天里对上一个标签就点名，比"随便发一张"更容易被用上。
      // 措辞要**像任务**而不是"要不要"：问句模型很容易跳过，直接说发它才动。
      const tag = matchContextTag(ev)
      const menu = availableMenu(6)
      const menuText = menu.length ? `｜能表达：${menu.join('/')}` : ''
      ev.hint.push(tag
        ? `[表情:这轮配一张（表情包=用图替一句话）｜对上了「${tag}」→ send_sticker("${tag}")${menuText}]`
        : `[表情:这轮可以配一张（表情包=用图替一句话）${menuText} → send_sticker("想表达的那个")；没贴的就别发]`)
      log.info(`[表情包] 掷骰命中 (${ev.chatKey}, p=${pct}%, 可挑 ${pool} 张${tag ? `, 语境标签=${tag}` : ''}) → 本轮提示「发一张」`)
      maybeTag()
    })

    // ── 入口 ③：工具 send_sticker（一轮最多 maxPerTurn 张；target 取当前 TurnContext，不信模型传） ──
    bot.registerTool('send_sticker', {
      description: '发一张 QQ 收藏表情。**表情包是当文字用的**：一张图就能替掉一句话（无语、？？？、牛、告辞、夸人、看戏…），'
        + '所以用法是「这句我想说的，正好有张图能替」——不是给文字配图。'
        + '库里都是她真发过、真收藏在 QQ 里的表情，发出去是表情样式，不是图片。'
        + '**每 4–6 条回话就该用一张**，跟颜文字差不多频繁；一轮最多一张；图片不算正文，别在正文里解释它。'
        + 'query 填"你想表达的那个意思/那句话"（如「无语」「哈哈哈哈」「牛」「夸人」）或 `#12` 点名；'
        + '不填 = 随机挑一张。关键词没命中会随便给一张；只有点名找不到才返回 ok:false —— 那时别改发别的图，也别在正文里解释。',
      // DSH `defineTool` 的 parameters 是**扁平**的「属性名 → 值 schema」映射（不是 JSON Schema 的
      // `{type:'object',properties}`）；required 写在属性上 `required: true`。
      parameters: {
        query: { type: 'string', description: '关键词/心情（如「无语」「猫」「夸人」），或 `#12` 点名编号；不传 = 随便挑一张' },
        text: { type: 'string', description: '随图发的一句文字，一般不用给' },
        target: { type: 'string', description: '发到哪条线（group:<群号> / private:<QQ号>）—— 只有本轮没有进行中会话时**才需要**填（比如主人让你去某个群发一张）' },
      },
      async execute(args) {
        const turn = bot.currentTurn()
        // target：优先本轮会话；本轮没有（主人从私聊说「去群里发个表情」、或主动发起）就接受显式
        // target —— 否则直接拒「没有进行中的会话」，模型只能绕道 send_image，群里就变成一张大图。
        const turnTarget = String(turn?.chatKey || '')
        const argTarget = String(args?.target || '').trim()
        const target = turnTarget || argTarget
        if (!/^(group|private):\d+$/.test(target)) {
          return { ok: false, reason: '没有进行中的会话，也没给 target（send_sticker 需要 target: group:<群号> 或 private:<QQ号>）' }
        }
        const cap = maxPerTurn()
        if (turn && (turn.stickersSent || 0) >= cap) return { ok: false, reason: `这轮已经发过 ${turn.stickersSent} 张了（每轮上限 ${cap}）` }
        // 主动接话一轮最多 2 条（与内核出站钩子同一条规矩；表情包也算一条）。
        // 判断要把「正在发、还没数进 proactiveMessages 的那张」一起算上，否则并行调用会双双放行。
        const proactive = turn?.wakeKind === 'proactive'
        if (proactive && (Number(turn.proactiveMessages) || 0) + (inflightProactive.get(turn) || 0) >= 2) {
          return { ok: false, reason: '主动接话这轮已经发满 2 条了，别再发' }
        }
        // **先占位再动手**：模型可能在同一轮并行调两次本工具，下面每个 await 之后才 +1 的话，
        // 两次调用会双双通过上面的上限判断 → 一轮发出两张（check-then-act）。占位失败再回滚。
        if (turn) turn.stickersSent = (turn.stickersSent || 0) + 1
        if (proactive) inflightProactive.set(turn, (inflightProactive.get(turn) || 0) + 1)
        const rollback = () => {
          if (turn) turn.stickersSent = Math.max(0, (Number(turn.stickersSent) || 0) - 1)
        }
        try {
          const hit = await pick(args?.query ?? args?.mood ?? '')
          if (!hit.ok) { rollback(); return hit }
          // **优先发她 QQ 收藏表情里的那张**（QQ 里是真表情样式，不是一张带白底的图）；
          // 没有映射 / 发送失败 → 回退发本地图（宁可发张图，也不能把话吞了）。
          // 说明文字原样交给内核（脱敏 / CQ 转义是 sendMedia → deliver 的事，插件不写第二份）
          const text = args?.text || ''
          let sentAsFace = false
          // 要发的是 **QQ 收藏表情**（真表情样式），不是图库里的一张图：
          // 没映射就当场补进收藏再发；协议端不支持收藏表情时才回退本地图。
          const faceId = (await faceApi())
            ? (faceIdOfHash(hashOfId(hit.id)) || (await ensureFace(hit)))
            : ''
          if (faceId) {
            try {
              if (text) await bot.deliver(target, text) // 收藏表情挂不了说明文字，先单独发字
              // ⚠️ 这条**不走 deliver**（收藏表情只能走协议端的 send_custom_face，deliver 没有对应出口），
              // 所以内核的 onAfterSend 不认它：不进 out 留档、不 markSent / markProactiveSent、
              // 不参与「自己发言占比」。插件侧不伪造那个钩子（伪造会把留档写歪），只补一条可查的日志；
              // 要真正接上留档链得内核给 sendCustomFace 一个出站口。
              const faceMsgId = await bot.napcat.sendCustomFace(target, faceId)
              sentAsFace = true
              // 收藏表情不走 deliver → 内核钩子不数这一条，只能我们补进「主动接话已发条数」
              // （上面的文字若发了，那条是 deliver 数的）。
              if (proactive) turn.proactiveMessages = (Number(turn.proactiveMessages) || 0) + 1
              log.info(`[表情] 收藏表情直发 ${target} (messageId=${faceMsgId ?? '?'}, emoji=${faceId})：未经 deliver，无出站留档`)
            } catch (e) {
              log.warn(`[表情] 发收藏表情失败，回退发本地图: ${e.message}`)
            }
          }
          if (!sentAsFace) await bot.sendMedia(target, cqImage(hit.path), text)
          log.info(`[表情] 发出 #${hit.id}${sentAsFace ? '(QQ收藏表情)' : '(本地图)'}${hit.untagged ? '(新收未打标)' : ''} → ${target} (${(hit.tags || []).join('/') || hit.desc || '无标注'})`)
          return { ok: true, target, pick: { id: hit.id, desc: hit.desc, use: hit.use, tags: hit.tags, untagged: hit.untagged } }
        } catch (e) {
          rollback() // 没发出去就别占这轮的额度
          throw e
        } finally {
          // 占位只管「这轮还能不能发」；发完/失败都要放掉，真正的计数已经在 proactiveMessages 里。
          if (proactive) inflightProactive.set(turn, Math.max(0, (inflightProactive.get(turn) || 0) - 1))
        }
      },
    })

    // ── 入口 ④：工具 sticker_catalog（先看看有什么，不占每轮 token） ─────────────
    bot.registerTool('sticker_catalog', {
      description: '列出库里可用表情包的清单（编号 · 画面 · 什么场合用 · 关键词）与库现状。'
        + '想先看看有什么再挑、或要按编号点名（send_sticker 传 query:"#12"）时用它；不用每轮都看。',
      parameters: {
        limit: { type: 'number', description: '最多列几条，默认 30' },
      },
      execute: async (args) => queue.push(async () => {
        const s = await shelf()
        // 只回目录名（不含盘符/绝对路径）：模型不需要服务器路径，返回绝对路径只是徒增外泄面。
        const dirName = path.basename(dir)
        if (!s) return { ok: true, catalog: '', stats: { enabled: cfg.enabled !== false, dirName, ok: false } }
        try {
          await pruneLocked(s)
          return {
            ok: true,
            catalog: await catalogLocked(s, args?.limit),
            stats: { enabled: cfg.enabled !== false, dirName, ok: true, ...s.stats(), pickable: pickableCount() },
          }
        } catch (e) {
          return { ok: true, catalog: '', stats: { enabled: cfg.enabled !== false, dirName, ok: false, err: e.message } }
        }
      }),
    })

    // ── 入口 ⑤：工具 sticker_retag（换过打标规则后，把老图重看一遍）──────────
    bot.registerTool('sticker_retag', {
      description: '把库里已经打过标的图退回「未打标」，让后台用当前打标规则重看一遍 —— '
        + '用于打标规则升级后给老图补语义（比如"这张图替哪句话"）。'
        + '会花几十次看图（几分钟，按批次慢慢跑），跑完图还在，标签会被更新。'
        + '只在换过打标提示词后需要跑一次，平时别调。',
      parameters: {
        limit: { type: 'number', description: '最多退回多少张重打（默认 80，够覆盖整个库）' },
      },
      execute: async (args) => {
        const r = await requeueForRetag(args?.limit)
        if (!r.ok || !r.requeued) return r
        maybeTag() // 立刻踢一脚，别等下一次聊天
        return { ...r, note: '已退回未打标；后台每 45 秒重看 5 张，进度看日志「[表情] 打标」' }
      },
    })

    // ── 启动对账（延后到队列里跑，绝不挡启动）──────────────────────────────
    //  ① 把她 QQ 里已有的收藏表情拉回来（本地没有的下载入库 → 她能发）
    //  ② 把本地已有、还没进收藏的推上去（第一次跑会把之前攒的 15 张补进去）
    queue.push(async () => {
      try {
        const r = await syncFromQqFavorites()
        if (r.linked || r.imported) log.info(`[表情] 启动对账：补映射 ${r.linked} 张，从 QQ 收藏拉回 ${r.imported} 张`)
      } catch (e) {
        log.warn(`[表情] 启动对账失败（不影响聊天）: ${e.message}`)
      }
      try { await pushToQqFavorites(30) } catch (e) { log.warn(`[表情] 补推收藏失败: ${e.message}`) }
    }).catch(() => {})
  },
}

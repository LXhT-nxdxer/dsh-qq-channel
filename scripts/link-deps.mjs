#!/usr/bin/env node
/**
 * scripts/link-deps.mjs — 把三个 peer 依赖链进本地 node_modules（换机 / 重装后一条命令重建）。
 *
 * 为什么需要：本仓库不提交 node_modules（见 .gitignore），而 index.js 直接 import
 * @deepseek-ai/{schemastery,cordis,dsh-tools}；这三个包由 DSH 本体自带，开发时用软链指过来
 * （Windows 用 junction，Linux/macOS 用 symlink），否则 node --test 一上来就 ERR_MODULE_NOT_FOUND。
 *
 * 依赖来源按优先级探测：
 *   1. 环境变量 DSH_DEPS_DIR（可指到 dsh 包目录、dsh/node_modules、某个 node_modules 或 @deepseek-ai 作用域）；
 *   2. require.resolve('@deepseek-ai/dsh/package.json') 反推（插件装在 DSH 里、或 NODE_PATH 已配时直接命中）；
 *   3. dsh 的全局安装位置：PATH 上的 <bin>/node_modules、PATH 上一级的 node_modules；
 *   4. 常见全局 node_modules（npm prefix、%APPDATA%\npm、/usr/local/lib/node_modules …）。
 *
 * 幂等：已链好（链接实际指向来源目录）就跳过；链断了（指向不存在）或指向别处就删掉重建；
 * node_modules 里若是真实安装目录（npm install 装的）一律不动。三个都就绪时不产生任何写操作。
 *
 * 用法：npm run link-deps  /  node scripts/link-deps.mjs
 * 退出码：0 = 三个依赖都就绪；1 = 找不到来源 / 链接失败（会打印下一步）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@deepseek-ai'
/** 需要链进来的三个 peer 依赖（顺序 = 报告顺序）。 */
const DEPS = ['schemastery', 'cordis', 'dsh-tools']
const IS_WIN = process.platform === 'win32'
const REQUIRE = createRequire(import.meta.url)

/** 目标目录：仓库自己的 node_modules/@deepseek-ai（gitignore，不进库）。 */
const TARGET_DIR = path.join(ROOT, 'node_modules', SCOPE)

function log(msg) { console.log(`[link-deps] ${msg}`) }
function fail(msg) { console.error(`[link-deps] ${msg}`) }

// ============================================================
// 路径小工具
// ============================================================

/** 绝对化并规范化（Windows 大小写不敏感，比较时统一小写）。 */
function normPath(value) {
  const abs = path.resolve(value)
  return IS_WIN ? abs.toLowerCase() : abs
}

function samePath(a, b) {
  return normPath(a) === normPath(b)
}

/** realpath，失败退回绝对路径（不抛）。 */
function realPath(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** 目录是不是一个可用的 npm 包（有 package.json；跟随链接）。 */
function isPackageDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile()
  } catch {
    return false
  }
}

/**
 * 在一个候选目录里找某个依赖，兼容四种常见布局：
 *   <base>/@deepseek-ai/<name>               base = 某个 node_modules
 *   <base>/<name>                            base = @deepseek-ai 作用域目录
 *   <base>/node_modules/@deepseek-ai/<name>  base = dsh 包目录 / 仓库根
 */
function probeDep(base, name) {
  for (const dir of [
    path.join(base, SCOPE, name),
    path.join(base, name),
    path.join(base, 'node_modules', SCOPE, name),
  ]) {
    if (isPackageDir(dir)) return dir
  }
  return null
}

/** 从文件往上找最近的包目录（最多 8 层，避免一路跑到盘符根）。 */
function findPackageRoot(file) {
  let dir = path.dirname(file)
  for (let i = 0; i < 8; i += 1) {
    if (isPackageDir(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ============================================================
// 来源探测（按优先级拼候选目录，notes 留作报错时的现场）
// ============================================================

/** 从 require.resolve 反推 DSH 包目录（exports 里没有 ./package.json 时，用入口文件往上找）。 */
function resolveDshDirs() {
  const dirs = []
  let error = null
  for (const spec of [`${SCOPE}/dsh/package.json`, `${SCOPE}/dsh`]) {
    let file
    try {
      file = REQUIRE.resolve(spec)
    } catch (err) {
      error = error || err
      continue
    }
    const dir = path.basename(file) === 'package.json' ? path.dirname(file) : findPackageRoot(file)
    if (dir) dirs.push(dir)
  }
  return { dirs, error }
}

/** PATH 上 dsh 的全局安装位置（npm 全局 bin 目录本身 / 它的上一级 node_modules）。 */
function dshDirsFromPath() {
  const dirs = []
  const entries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const raw of entries) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1') // PATH 里偶有带引号的项
    if (!entry) continue
    dirs.push(path.join(entry, 'node_modules', SCOPE, 'dsh'))
    dirs.push(path.join(entry, '..', 'node_modules', SCOPE, 'dsh'))
  }
  return { dirs, count: entries.length }
}

/** 常见全局 node_modules 位置（按平台，只列通用的，不写站点私有路径）。 */
function globalRoots() {
  const roots = []
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX
  if (prefix) roots.push(IS_WIN ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules'))
  if (IS_WIN) {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
    roots.push(path.join(path.dirname(process.execPath), 'node_modules'))
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'))
  } else {
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
    roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'))
  }
  return roots
}

/**
 * 汇总候选来源：[{ label, dir }] 已按优先级排好，同目录只留一份。
 * 报错时用 notes 说明每个来源探过没有。
 */
function collectSources() {
  const sources = []
  const seen = new Set()
  const notes = []

  // 一个候选目录同时展开成「它自己」和「它下面的 @deepseek-ai/dsh」：
  // 前者管 node_modules 根，后者管「依赖躺在 dsh 包自带的 node_modules 里」这种最常见的情况
  const add = (label, dir) => {
    if (!dir) return
    const abs = path.resolve(dir)
    for (const candidate of [abs, path.join(abs, SCOPE, 'dsh')]) {
      const key = normPath(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      sources.push({ label, dir: candidate })
    }
  }

  // 1) 显式指定最优先
  const envDir = String(process.env.DSH_DEPS_DIR || '').trim()
  if (envDir) {
    const abs = path.resolve(envDir)
    add('DSH_DEPS_DIR', abs)
    notes.push(`DSH_DEPS_DIR=${abs}${fs.existsSync(abs) ? '' : '（目录不存在）'}`)
  } else {
    notes.push('DSH_DEPS_DIR 未设置')
  }

  // 2) NODE_PATH（有些环境靠它找全局包）
  for (const dir of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (dir.trim()) add('NODE_PATH', dir.trim())
  }
  if (process.env.NODE_PATH) notes.push(`NODE_PATH=${process.env.NODE_PATH}`)

  // 3) 从 @deepseek-ai/dsh 反推
  const resolved = resolveDshDirs()
  for (const dir of resolved.dirs) add('require.resolve(@deepseek-ai/dsh)', dir)
  if (resolved.dirs.length) {
    notes.push(`require.resolve('@deepseek-ai/dsh') → ${resolved.dirs[0]}`)
  } else {
    const reason = resolved.error ? String(resolved.error.message).split('\n')[0] : '未解析到'
    notes.push(`require.resolve('@deepseek-ai/dsh') 失败：${reason}`)
  }

  // 4) PATH 上的 dsh 全局安装
  const fromPath = dshDirsFromPath()
  const pathHits = fromPath.dirs.filter((dir) => isPackageDir(dir))
  for (const dir of pathHits) add('PATH 上的 dsh', dir)
  notes.push(pathHits.length
    ? `PATH 上的 dsh → ${pathHits[0]}`
    : `PATH 上没找到 dsh（扫描 ${fromPath.count} 个目录）`)

  // 5) 常见全局 node_modules
  const roots = globalRoots()
  const rootHits = roots
    .map((root) => path.join(root, SCOPE, 'dsh'))
    .filter((dir) => isPackageDir(dir))
  for (const dir of rootHits) add('全局 node_modules', dir)
  notes.push(rootHits.length
    ? `全局 node_modules → ${rootHits[0]}`
    : `常见全局路径未命中（${roots.join('、') || '无'}）`)

  return { sources, notes }
}

/** 按优先级找某个依赖，返回第一个命中的包目录。 */
function findSource(sources, name) {
  for (const { label, dir } of sources) {
    const found = probeDep(dir, name)
    if (found) return { dir: found, label }
  }
  return null
}

// ============================================================
// 链接状态 / 建链 / 拆链
// ============================================================

/**
 * 看 node_modules/@deepseek-ai/<name> 现在是什么状态：
 *   missing = 没有；link = 正常链接；broken = 链接但指向不存在；
 *   real    = 真实安装目录（npm install 装的）；junk = 同名普通文件或没有 package.json 的目录。
 */
function inspectTarget(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return { state: 'missing' }
  }
  if (stat.isSymbolicLink()) {
    // Windows 的 junction 在 lstat 里也算 symlink；realpath 抛 ENOENT 就是断链
    try {
      return { state: 'link', real: fs.realpathSync(target) }
    } catch {
      return { state: 'broken' }
    }
  }
  if (stat.isDirectory()) return isPackageDir(target) ? { state: 'real' } : { state: 'junk' }
  return { state: 'junk' }
}

/** 删掉一条链接：只删链接本身，绝不碰目标内容。 */
function removeLink(target) {
  try {
    fs.unlinkSync(target)
  } catch {
    // 个别 Windows 文件系统不接受 unlink junction；rmdir 只移除重解析点，不会删目标内容
    fs.rmdirSync(target)
  }
}

/** 建链接：Windows 用 junction（不需要管理员 / 开发者模式），其余平台用目录 symlink。 */
function createLink(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(source, target, IS_WIN ? 'junction' : 'dir')
}

/** 建链 + 自检；成功返回 null，失败返回一句可打印的问题描述。 */
function linkInto(source, target) {
  try {
    createLink(source, target)
  } catch (err) {
    return `创建链接失败（${err.code || err.message}）：${target} → ${source}`
  }
  if (!isPackageDir(target)) return `链接已建但读不到 package.json：${target}（来源 ${source} 可能不完整）`
  return null
}

// ============================================================
// 主流程
// ============================================================

function main() {
  log(`仓库：${ROOT}`)
  const { sources, notes } = collectSources()

  const missing = [] // 完全找不到来源的依赖
  const problems = [] // 需要人工处理的（同名文件 / 建链失败）
  let ready = 0
  let created = 0
  let relinked = 0

  for (const name of DEPS) {
    const label = `${SCOPE}/${name}`
    const target = path.join(TARGET_DIR, name)
    const status = inspectTarget(target)

    if (status.state === 'real') {
      log(`跳过 ${label}（node_modules 里是真实安装目录，不动它）`)
      ready += 1
      continue
    }

    if (status.state === 'junk') {
      problems.push(`${label} 的位置不是链接、也不是有效包目录；为避免误删请手工处理：${target}`)
      continue
    }

    const source = findSource(sources, name)

    if (status.state === 'link') {
      if (!source) {
        // 链接本身可用，只是这台机器上探不到来源：保持现状，不折腾
        log(`跳过 ${label}（现有链接可用，但没探测到来源，无法校验指向）`)
        ready += 1
        continue
      }
      if (samePath(status.real, realPath(source.dir))) {
        log(`跳过 ${label}（已链好 → ${source.dir}）`)
        ready += 1
        continue
      }
      log(`重建 ${label}（原链接指向 ${status.real}）`)
      removeLink(target)
      const problem = linkInto(source.dir, target)
      if (problem) problems.push(problem)
      else { relinked += 1; ready += 1; log(`  已链到 ${source.dir}（来源：${source.label}）`) }
      continue
    }

    // missing / broken
    if (!source) {
      missing.push(name)
      continue
    }
    log(status.state === 'broken' ? `重建 ${label}（原链接已失效）` : `新建 ${label}`)
    if (status.state === 'broken') removeLink(target)
    const problem = linkInto(source.dir, target)
    if (problem) problems.push(problem)
    else {
      if (status.state === 'broken') relinked += 1
      else created += 1
      ready += 1
      log(`  已链到 ${source.dir}（来源：${source.label}）`)
    }
  }

  if (missing.length || problems.length) {
    if (missing.length) fail(`找不到这些 peer 依赖的来源：${missing.map((n) => `${SCOPE}/${n}`).join('、')}`)
    for (const problem of problems) fail(problem)
    if (missing.length) {
      fail('探测记录：')
      for (const note of notes) fail(`  · ${note}`)
      fail('下一步（任选其一）：')
      fail('  1) 先装 DSH 本体，再重跑本脚本：npm i -g @deepseek-ai/dsh')
      fail('  2) 已有 DSH 安装目录（含 @deepseek-ai/{schemastery,cordis,dsh-tools}）就直接指过去：')
      fail('       DSH_DEPS_DIR=<dsh 安装目录> npm run link-deps')
      fail('       DSH_DEPS_DIR 可以指到 dsh 包目录、dsh/node_modules、某个 node_modules 或 @deepseek-ai 作用域')
      if (IS_WIN) {
        fail('     PowerShell 写法：$env:DSH_DEPS_DIR = "<dsh 安装目录>"; npm run link-deps')
      } else {
        fail('     bash 写法：DSH_DEPS_DIR=<dsh 安装目录> npm run link-deps')
      }
      fail('  3) 只跑单文件测试时也可先把三个包 npm i 进来（不推荐：仓库不提交 node_modules）')
    } else {
      fail('处理完上面这些路径后重跑：npm run link-deps')
    }
    process.exit(1)
  }

  const detail = [
    created ? `新建 ${created} 个` : '',
    relinked ? `重建 ${relinked} 个` : '',
  ].filter(Boolean).join('，')
  log(`OK ${ready}/${DEPS.length} 个 peer 依赖就绪${detail ? `（${detail}）` : '（无需改动）'}`)
  process.exit(0)
}

main()

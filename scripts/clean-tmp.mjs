/**
 * scripts/clean-tmp.mjs — 清理测试留下的临时目录。
 *
 * 为什么需要：各测试文件自己 `fs.mkdtempSync(os.tmpdir()/qqbot-*)`，跑完不删。
 * 2026-11-01 一天就攒了 15981 个（每个几百字节，但会把 %TEMP% 塞成一片）。
 *
 * 为什么不在测试进程里自动扫（踩过的坑）：
 *   node --test 是**并行跑测试文件的**，任何"进程退出时扫全目录"的写法都会把
 *   兄弟进程刚建的目录删掉——实测一次全量直接红 14 条。所以清理做成独立脚本，
 *   只在**没有测试在跑**的时候手动/定时执行，并且只删「够旧」的（默认 6 小时前）。
 *
 * 用法：
 *   node scripts/clean-tmp.mjs                # 删 6 小时前的
 *   node scripts/clean-tmp.mjs --hours=1      # 改阈值
 *   node scripts/clean-tmp.mjs --dry          # 只看，不删
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const hoursArg = args.find((a) => a.startsWith('--hours='))
// 注意：不能用 `Number(x) || 6` —— `--hours=0` 会被 0 这个 falsy 值吞掉变回 6
const rawHours = hoursArg === undefined ? '6' : hoursArg.split('=')[1]
const parsed = Number(rawHours)
const hours = Number.isFinite(parsed) ? Math.max(0, parsed) : 6
const cutoff = Date.now() - hours * 3600_000

const tmp = os.tmpdir()
let names = []
try { names = fs.readdirSync(tmp) } catch (e) {
  console.error(`读不到临时目录 ${tmp}: ${e.message}`)
  process.exit(1)
}

let deleted = 0
let bytes = 0
let skipped = 0
for (const name of names) {
  if (!name.startsWith('qqbot-')) continue
  const full = path.join(tmp, name)
  let st
  try { st = fs.statSync(full) } catch { continue }
  if (!st.isDirectory()) continue
  let mtime = Number(st.mtimeMs) || 0
  // 目录自己的 mtime 只在内容变化时更新；用里面最新的文件时间更准
  try {
    for (const f of fs.readdirSync(full)) {
      const s = fs.statSync(path.join(full, f))
      if (Number(s.mtimeMs) > mtime) mtime = Number(s.mtimeMs)
    }
  } catch { /* 空目录或没权限：就用目录本身 mtime */ }
  if (mtime > cutoff) { skipped++; continue }

  let size = 0
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else { try { size += fs.statSync(p).size } catch { /* ignore */ } }
      }
    }
    walk(full)
  } catch { /* ignore */ }

  if (dry) {
    deleted++
    bytes += size
    continue
  }
  try {
    fs.rmSync(full, { recursive: true, force: true })
    deleted++
    bytes += size
  } catch (e) {
    console.warn(`删不掉 ${name}: ${e.message}`)
  }
}

const mb = (bytes / 1048576).toFixed(2)
console.log(`[clean-tmp] ${dry ? '将删除' : '已删除'} ${deleted} 个 qqbot-* 临时目录，${mb} MB`
  + `（阈值 ${hours} 小时前；跳过 ${skipped} 个较新的）`)

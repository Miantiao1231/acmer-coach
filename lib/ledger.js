// 跨进程账本写入保护。
//
// 两个 dsh 进程（web + desktop）可能同时拿着旧快照。SQLite 事务把
// 「核对指纹 → 原子替换」串行化；后写者发现过期就拒绝覆盖。
// 进程异常退出时 SQLite 自行释放锁，不留下需要手工清理的锁文件。
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const STAMP = Symbol('acmer-coach.ledgerStamp')
export const textStamp = (raw) => createHash('sha256').update(raw).digest('hex')

export function fileStamp(path) {
  try {
    return textStamp(readFileSync(path))
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent'
    throw err
  }
}

/** 在刚读出的对象上记下文件指纹。非枚举，不污染 YAML/deepEqual。 */
export function bindStamp(doc, path, seen = fileStamp(path)) {
  if (doc && typeof doc === 'object') {
    Object.defineProperty(doc, STAMP, { value: seen, enumerable: false, configurable: true })
  }
  return doc
}

/** 派生对象（spread / structuredClone）会丢掉不可枚举的指纹，写之前把它接回来。 */
export function copyStamp(to, from) {
  const seen = from?.[STAMP]
  if (seen !== undefined && to && typeof to === 'object') {
    Object.defineProperty(to, STAMP, { value: seen, enumerable: false, configurable: true })
  }
  return to
}

export function assertUnchanged(doc, path) {
  const seen = doc?.[STAMP]
  // 没经过 bindStamp 的对象（测试夹具、命令行一次性写入）不拦 ——
  // 这条路径没有「读旧快照」的风险，只是没有可比对的基准。
  if (seen === undefined) return
  if (fileStamp(path) === seen) return
  throw new Error(
    `账本「${basename(path)}」在你读取后被另一个进程改过（常见原因：同时开着 dsh web 和 desktop）。` +
    '本次没有覆盖；重新读取后再操作。别同时开两个窗口写同一份教练数据。')
}

/** 原子写 + 冲突检测。成功后就地把指纹更新到刚写的文件上。 */
export function writeLedger(path, text, doc) {
  // SQLite releases this cross-process lock after a crash; the stamp check and rename must share it.
  const lock = new DatabaseSync(join(dirname(path), '.coach-ledger-lock.sqlite'))
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  let moved = false, locked = false
  try {
    lock.exec('PRAGMA busy_timeout = 5000')
    lock.exec('BEGIN IMMEDIATE')
    locked = true
    assertUnchanged(doc, path)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    moved = true
    if (doc && typeof doc === 'object') {
      Object.defineProperty(doc, STAMP, { value: fileStamp(path), enumerable: false, configurable: true })
    }
    lock.exec('COMMIT')
    locked = false
  } finally {
    if (locked) { try { lock.exec('ROLLBACK') } catch { /* close releases the lock */ } }
    lock.close()
    if (!moved) {
      try { unlinkSync(tmp) } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
  }
}

// 跨进程租约：web/desktop 两个 profile 同时开时，只让一个 worker 发消息。
// 租约文件比进程内锁可靠：崩溃后最多 5 分钟别人可以接管。
import { closeSync, fstatSync, statSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'proactive-worker.lock'

// Renewal must never create a missing lease or take another worker's lease.
export function renewLease(dataDir, owner, now = new Date(), ttlMs = 5 * 60000) {
  const path = join(dataDir, FILE)
  let fd = null
  try {
    fd = openSync(path, 'r+')
    const current = JSON.parse(readFileSync(fd, 'utf8'))
    const at = Date.parse(current?.at)
    if (current?.owner !== owner || !Number.isFinite(at) || now.getTime() - at > ttlMs
      || fstatSync(fd).ino !== statSync(path).ino) return false
    const body = JSON.stringify({ owner, at: now.toISOString() })
    writeSync(fd, body, 0, 'utf8')
    ftruncateSync(fd, Buffer.byteLength(body))
    return JSON.parse(readFileSync(path, 'utf8'))?.owner === owner
  } catch { return false }
  finally { if (fd !== null) try { closeSync(fd) } catch { /* best effort */ } }
}

function writeNew(path, owner, stamp) {
  // 先写满内容，再用硬链接原子占位。直接 open('wx') 会有一个空文件窗口，
  // 另一个进程读到空内容会把它当“过期锁”抢走。
  const tmp = `${path}.new-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const body = JSON.stringify({ owner, at: stamp })
  writeFileSync(tmp, body, 'utf8')
  try {
    linkSync(tmp, path)
  } catch (error) {
    // 少数文件系统不支持硬链接：退回旧写法，至少别把主动联系整个关掉。
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL', 'EXDEV'].includes(error?.code)) throw error
    const fd = openSync(path, 'wx')
    try { writeFileSync(fd, body) } finally { closeSync(fd) }
  } finally {
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

// 抢占过期锁不能用「读旧时间 → 直接覆盖」：两个进程会同时读到同一个过期值，
// 然后都写、都以为自己拿到了。这里先把旧文件 rename 到唯一名字（只有一个进程
// 能 rename 成功），再用 'wx' 新建；抢输的进程拿不到新锁就返回 false。
function takeOver(path, owner, stamp) {
  const stale = `${path}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  try { renameSync(path, stale) } catch { return false }
  try {
    writeNew(path, owner, stamp)
    return true
  } catch {
    return false
  } finally {
    try { unlinkSync(stale) } catch { /* another takeover may have consumed it */ }
  }
}

export function acquireLease(dataDir, owner, now = new Date(), ttlMs = 5 * 60 * 1000) {
  if (!owner) return false
  const path = join(dataDir, FILE)
  const stamp = now.toISOString()
  try {
    mkdirSync(dataDir, { recursive: true })
    writeNew(path, owner, stamp)
    return true
  } catch (error) {
    if (error?.code !== 'EEXIST') return false
  }
  let raw = null
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { raw = null }
  const at = Date.parse(raw?.at)
  if (raw?.owner === owner) {
    // 同一进程续租。必须写回原来打开的那个 inode：
    // 如果这期间别人把锁 rename 走并新建了文件，按路径写会覆盖别人的租约。
    let fd = null
    try {
      fd = openSync(path, 'r+')
      const current = JSON.parse(readFileSync(path, 'utf8'))
      if (current?.owner !== owner) return false
      const body = JSON.stringify({ owner, at: stamp })
      writeFileSync(fd, body)
      ftruncateSync(fd, Buffer.byteLength(body))
      return true
    } catch {
      return false
    } finally {
      if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
    }
  }
  if (!Number.isFinite(at) || now.getTime() - at > ttlMs) return takeOver(path, owner, stamp)
  return false
}

export function releaseLease(dataDir, owner) {
  try {
    const path = join(dataDir, FILE)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw?.owner === owner) unlinkSync(path)
  } catch { /* best effort */ }
}

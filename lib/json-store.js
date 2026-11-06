// Shared locked JSON file store. The older modules each carry their own copy of
// this lock; new modules use this one instead of adding a seventh.
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const STALE_MS = 5000

export function readJsonFile(dataDir, file) {
  try {
    return JSON.parse(readFileSync(join(dataDir, file), 'utf8'))
  } catch {
    return null
  }
}

export function writeJsonFile(dataDir, file, value) {
  try {
    mkdirSync(dataDir, { recursive: true })
    const path = join(dataDir, file)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

function acquireLock(dataDir, file) {
  const path = join(dataDir, `${file}.lock`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, JSON.stringify({ owner: OWNER, at: Date.now() })) }
      catch (error) {
        try { closeSync(fd) } catch { /* ignore */ }
        try { unlinkSync(path) } catch { /* ignore */ }
        throw error
      }
      return { fd, path, ino: statSync(path).ino }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) unlinkSync(path)
      } catch { /* another process just removed it */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch { /* ignore */ }
    }
  }
  return null
}

function releaseLock(lock) {
  if (!lock) return
  try { closeSync(lock.fd) } catch { /* ignore */ }
  try {
    if (statSync(lock.path).ino !== lock.ino) return
    const raw = JSON.parse(readFileSync(lock.path, 'utf8'))
    if (raw?.owner === OWNER) unlinkSync(lock.path)
  } catch { /* not ours or already gone */ }
}

// Read-modify-write under a lock. `mutate` gets the freshly-read value and
// returns the next value, or null to leave the file untouched.
export function updateJsonFile(dataDir, file, mutate, normalize = (value) => value) {
  const lock = acquireLock(dataDir, file)
  if (!lock) return { ok: false, value: null }
  try {
    const current = normalize(readJsonFile(dataDir, file))
    const next = mutate(current)
    if (next === null) return { ok: true, value: current }
    if (!writeJsonFile(dataDir, file, next)) return { ok: false, value: current }
    return { ok: true, value: next }
  } finally {
    releaseLock(lock)
  }
}

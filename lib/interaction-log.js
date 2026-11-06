// Timestamps of real user messages, kept only as long as workload needs them.
// The original derives workload from the last 24h of private messages; dsh does
// not expose that count, so we record one line per user turn ourselves.
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const FILE = 'interaction-log.json'
const LOCK = 'interaction-log.lock'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 1
const RETENTION_MS = 48 * 3600 * 1000
// State maintenance looks back three days (the original's maintenance context
// window), so the text-bearing entries live longer than the workload counters.
const TEXT_RETENTION_MS = 72 * 3600 * 1000
const MAX_MESSAGES = 1000
const MAX_ENTRIES = 240
const TEXT_LIMIT = 600

const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT)

export function emptyInteractionLog() {
  return { version: VERSION, messages: [], entries: [] }
}

export function normalizeInteractionLog(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return emptyInteractionLog()
  const end = now.getTime()
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map(stamp).filter((at) => at !== null && end - at <= RETENTION_MS)
    .sort((a, b) => a - b).slice(-MAX_MESSAGES)
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map((entry) => {
      const at = stamp(entry?.at)
      const text = cleanText(entry?.text)
      return at !== null && text && end - at <= TEXT_RETENTION_MS ? { at, text } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_ENTRIES)
  return {
    version: VERSION,
    messages: messages.map((at) => new Date(at).toISOString()),
    entries: entries.map((entry) => ({ at: new Date(entry.at).toISOString(), text: entry.text })),
  }
}

export function loadInteractionLog(dataDir, now = new Date()) {
  try {
    return normalizeInteractionLog(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')), now)
  } catch {
    return emptyInteractionLog()
  }
}

function acquireLock(dataDir) {
  const path = join(dataDir, LOCK)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, JSON.stringify({ owner: LOCK_OWNER, at: Date.now() })) }
      catch (error) { try { closeSync(fd) } catch { /* ignore */ } try { unlinkSync(path) } catch { /* ignore */ } throw error }
      return { fd, path, ino: statSync(path).ino }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > 5000) unlinkSync(path)
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
    if (raw?.owner === LOCK_OWNER) unlinkSync(lock.path)
  } catch { /* not ours or already gone */ }
}

export function recordUserMessage(dataDir, now = new Date(), text = '') {
  const lock = acquireLock(dataDir)
  if (!lock) return loadInteractionLog(dataDir, now)
  try {
    const log = loadInteractionLog(dataDir, now)
    const last = log.messages.at(-1)
    const value = cleanText(text)
    const delta = last ? now.getTime() - Date.parse(last) : Infinity
    // A re-entered pre-step for the same turn must not double count. Only a
    // forward gap inside one second is that re-entry; a timestamp earlier than
    // the last one is a new (out-of-order) record, not a duplicate.
    if (!(delta >= 0 && delta < 1000)) {
      log.messages.push(now.toISOString())
      if (value) log.entries.push({ at: now.toISOString(), text: value })
    } else if (value && log.entries.at(-1)?.text !== value) {
      log.entries[log.entries.length - 1] = { at: now.toISOString(), text: value }
    }
    if (log.messages.length > MAX_MESSAGES) log.messages = log.messages.slice(-MAX_MESSAGES)
    if (log.entries.length > MAX_ENTRIES) log.entries = log.entries.slice(-MAX_ENTRIES)
    const path = join(dataDir, FILE)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    writeFileSync(tmp, JSON.stringify(log, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    return log
  } catch {
    return loadInteractionLog(dataDir, now)
  } finally {
    releaseLock(lock)
  }
}

export function messageCountSince(log, { since = null, now = new Date() } = {}) {
  const end = now.getTime()
  const start = since instanceof Date ? since.getTime() : stamp(since)
  const from = start === null ? end - 24 * 3600 * 1000 : start
  return (log?.messages ?? []).filter((at) => {
    const value = Date.parse(at)
    return value >= from && value <= end
  }).length
}

// Text-bearing slice for the maintenance context: newest last, bounded by
// count and total characters so a chatty day cannot blow the prompt budget.
export function recentMessages(log, {
  since = null, now = new Date(), limit = 32, maxChars = 10000,
} = {}) {
  const end = now.getTime()
  const start = since instanceof Date ? since.getTime() : stamp(since)
  const from = start === null ? end - TEXT_RETENTION_MS : start
  const picked = []
  let chars = 0
  for (const entry of [...(log?.entries ?? [])].reverse()) {
    const at = Date.parse(entry.at)
    if (!(at >= from && at <= end)) continue
    if (picked.length >= limit) break
    // Always keep the newest message, even when it alone exceeds the character
    // budget: an empty context is worse than one long sentence.
    if (picked.length && chars + entry.text.length > maxChars) break
    picked.push({ at: entry.at, text: entry.text })
    chars += entry.text.length
  }
  return picked.reverse()
}

export { RETENTION_MS, TEXT_RETENTION_MS, MAX_MESSAGES, MAX_ENTRIES }

// Tool side-effect idempotency.
//
// Port of companion_v2's operation_id + parameter hash + replayed reply. A tool
// call is only deduplicated when the caller passes `operation_id` explicitly:
// hashing arguments alone would swallow legitimate repeats (`companion read`
// twice in a row is not a duplicate).
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'tool-operations.json'
const VERSION = 1
const MAX_ENTRIES = 200
const KEEP_MS = 7 * 24 * 3600 * 1000
const MAX_RESULT_CHARS = 6000

const clean = (value) => String(value ?? '').trim()
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

export function emptyOperationLog() {
  return { version: VERSION, entries: [] }
}

export function normalizeOperationLog(raw) {
  const base = emptyOperationLog()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter((entry) => entry && clean(entry.key) && stamp(entry.at) !== null)
    .map((entry) => ({
      key: clean(entry.key).slice(0, 160),
      tool: clean(entry.tool).slice(0, 60),
      digest: clean(entry.digest).slice(0, 64),
      at: new Date(stamp(entry.at)).toISOString(),
      phase: ['running', 'uncached'].includes(entry.phase) ? entry.phase : 'done',
      result: entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result) ? entry.result : null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at))
  return { version: VERSION, entries: entries.slice(-MAX_ENTRIES) }
}

// The hash covers everything except the id itself, so reusing one id with
// different arguments is visible instead of silently replaying the wrong value.
export function argsDigest(args = {}) {
  const { operation_id: _ignored, ...rest } = args ?? {}
  // A replacer key list also filters nested objects; sort objects without dropping their fields.
  const text = JSON.stringify(rest, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

function prune(log, now) {
  const cut = now.getTime() - KEEP_MS
  return {
    version: VERSION,
    entries: log.entries.filter((entry) => (stamp(entry.at) ?? 0) >= cut).slice(-MAX_ENTRIES),
  }
}

export function replayOperation(dataDir, { tool, args, now = new Date() } = {}) {
  const key = clean(args?.operation_id)
  if (!key) return null
  const log = normalizeOperationLog(readJsonFile(dataDir, FILE))
  const entry = log.entries.find((item) => item.key === key && item.tool === tool)
  if (!entry || !entry.result || entry.result.ok === false || entry.result.accepted === false) return null
  if ((stamp(entry.at) ?? 0) < now.getTime() - KEEP_MS) return null
  // Same id, different arguments: not a replay, let the call run.
  if (entry.digest !== argsDigest(args)) return null
  return entry.result
}

export function recordOperation(dataDir, { tool, args, result, now = new Date() } = {}) {
  const key = clean(args?.operation_id)
  if (!key) return false
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  // A failed call may succeed on retry; only successes are cached.
  if (result.ok === false || result.accepted === false) return false
  let serialized = ''
  try { serialized = JSON.stringify(result) } catch { return false }
  if (!serialized || serialized.length > MAX_RESULT_CHARS) return false

  const digest = argsDigest(args)
  const written = updateJsonFile(dataDir, FILE, (current) => {
    const log = prune(normalizeOperationLog(current), now)
    const rest = log.entries.filter((entry) => !(entry.key === key && entry.tool === tool))
    rest.push({ key: key.slice(0, 160), tool: String(tool ?? '').slice(0, 60), digest, at: now.toISOString(), result })
    return { version: VERSION, entries: rest.slice(-MAX_ENTRIES) }
  }, normalizeOperationLog)
  return written.ok
}

// The SQLite transaction is only a mutex: no user data lives in this database.
// busy_timeout=0 keeps a second async call from blocking the first call's event loop.
async function lockOperations(dataDir, signal) {
  mkdirSync(dataDir, { recursive: true })
  const lock = new DatabaseSync(join(dataDir, '.coach-tool-operations-lock.sqlite'))
  try {
    lock.exec('PRAGMA busy_timeout = 0')
    for (;;) {
      signal?.throwIfAborted?.()
      try { lock.exec('BEGIN IMMEDIATE'); return lock }
      catch (error) {
        if (![5, 6].includes(error.errcode)) throw error
        await sleep(25, undefined, { signal })
      }
    }
  } catch (error) { lock.close(); throw error }
}

function markOperation(dataDir, tool, args, phase) {
  const key = clean(args.operation_id)
  const now = new Date()
  return updateJsonFile(dataDir, FILE, current => {
    const log = prune(normalizeOperationLog(current), now)
    const previous = log.entries.find(entry => entry.key === key && entry.tool === tool)
    if (phase === 'running' && previous && ['running', 'uncached'].includes(previous.phase)) {
      throw new Error('上次操作的执行结果无法确认或未缓存；先查询实际状态，不自动重复写入。需要新操作时使用新的 operation_id。')
    }
    const entries = log.entries.filter(entry => !(entry.key === key && entry.tool === tool))
    if (phase) entries.push({ key, tool, digest: argsDigest(args), at: now.toISOString(), phase, result: null })
    return { version: VERSION, entries: entries.slice(-MAX_ENTRIES) }
  }, normalizeOperationLog).ok
}

// Wrap a registry-ready tool. `operation_id` is declared so the model knows it
// exists, and the wrapper is transparent when it is absent.
//
// `isReadOnly(args)` marks calls with no side effects: replaying a cached reply
// for a read would serve yesterday's state (a context read at 23:59 reused at
// 00:01), so reads always execute again. Writes keep the idempotency guard.
export function withOperationId(tool, dataDir, isReadOnly = null) {
  if (!tool || typeof tool.execute !== 'function' || !tool.parameters?.properties) return tool
  if (tool.parameters.properties.operation_id) return tool
  tool.parameters.properties.operation_id = {
    type: 'string',
    description: '可选幂等键，最多160字符；同键同参的成功结果在7天内重放，并发执行会串行核对。只读查询不重放，总是重新计算。中断或回执未缓存时先查状态，不自动重复写入。',
  }
  const run = tool.execute
  tool.execute = async (args = {}, exec) => {
    const key = clean(args?.operation_id)
    if (!key) return run(args, exec)
    if (typeof isReadOnly === 'function' && isReadOnly(args)) return run(args, exec)
    if (key.length > 160) throw new Error('operation_id 最多160字符。')
    const replayed = replayOperation(dataDir, { tool: tool.name, args })
    if (replayed) return replayed
    const lock = await lockOperations(dataDir, exec?.signal)
    try {
      const previous = replayOperation(dataDir, { tool: tool.name, args })
      if (previous) return previous
      if (!markOperation(dataDir, tool.name, args, 'running')) throw new Error('去重记录无法写入，本次未执行；请检查数据目录后重试。')
      // A thrown error may occur after a write; keep the marker until the outcome is checked.
      const result = await run(args, exec)
      let cached = false
      try { cached = recordOperation(dataDir, { tool: tool.name, args, result }) } catch { /* keep the execution marker */ }
      if (!cached) markOperation(dataDir, tool.name, args,
        result?.ok === false || result?.accepted === false ? '' : 'uncached')
      return result
    } finally {
      try { lock.exec('ROLLBACK') } finally { lock.close() }
    }
  }
  return tool
}

export { MAX_ENTRIES, KEEP_MS }

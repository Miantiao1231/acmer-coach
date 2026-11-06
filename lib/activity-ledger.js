// Durable role activities: reading, journal and dream tasks.
//
// Port of companion_v2's role_work activity rows, without the SQLite host:
//   · every mutation bumps the ledger revision and the activity revision
//   · an active run only advances while a heartbeat is fresh; after a restart
//     the elapsed gap is NOT turned into completion (it is paused at the last
//     heartbeat, exactly like the original recovery worker)
//   · completed runs keep their wall-clock segments so workload can count only
//     the minutes actually spent reading
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const FILE = 'activities.json'
const LOCK = 'activities.lock'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 1
const MAX_ACTIVITIES = 200
const MAX_SEGMENTS = 100
const HEARTBEAT_STALE_MS = 10 * 60 * 1000
const KINDS = new Set(['reading', 'journal', 'dream'])
const STATES = new Set(['planned', 'active', 'paused', 'completed', 'cancelled'])

const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value)))
const clean = (value) => String(value ?? '').trim()
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}
const iso = (ms) => new Date(ms).toISOString()
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)

export function emptyActivityLedger() {
  return { version: VERSION, revision: 0, activities: [] }
}

function normalizeSegment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const from = stamp(raw.from)
  const to = stamp(raw.to)
  if (from === null || to === null || to <= from) return null
  return { from: iso(from), to: iso(to) }
}

const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null

function normalizeSource(raw) {
  if (!plainObject(raw)) return null
  return {
    bookId: clean(raw.bookId).slice(0, 120), title: clean(raw.title).slice(0, 120),
    kind: ['excerpt', 'note', 'title'].includes(raw.kind) ? raw.kind : 'title',
    hash: clean(raw.hash).slice(0, 64), text: String(raw.text ?? '').slice(0, 6000),
    contentHash: clean(raw.contentHash).slice(0, 64),
    start: Math.max(0, Math.trunc(Number(raw.start) || 0)),
    end: Math.max(0, Math.trunc(Number(raw.end) || 0)),
    total: Math.max(0, Math.trunc(Number(raw.total) || 0)),
    scope: ['article', 'chapter', 'excerpt'].includes(raw.scope) ? raw.scope : 'excerpt',
  }
}

function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = clean(raw.id)
  const kind = KINDS.has(raw.kind) ? raw.kind : null
  const state = STATES.has(raw.state) ? raw.state : null
  if (!id || !kind || !state) return null
  const created = stamp(raw.createdAt)
  const updated = stamp(raw.updatedAt)
  if (created === null || updated === null) return null
  const segments = (Array.isArray(raw.segments) ? raw.segments : []).map(normalizeSegment).filter(Boolean).slice(-MAX_SEGMENTS)
  const minutes = segments.reduce((total, segment) => total + (Date.parse(segment.to) - Date.parse(segment.from)) / 60000, 0)
  return {
    id: id.slice(0, 120),
    kind,
    state,
    revision: Math.max(0, Math.round(Number(raw.revision) || 0)),
    plannedMinutes: clamp(Number(raw.plannedMinutes) || 0, 0, 1440),
    title: clean(raw.title).slice(0, 120),
    note: clean(raw.note).slice(0, 400),
    createdAt: iso(created),
    updatedAt: iso(updated),
    startedAt: stamp(raw.startedAt) === null ? '' : iso(stamp(raw.startedAt)),
    endedAt: stamp(raw.endedAt) === null ? '' : iso(stamp(raw.endedAt)),
    heartbeatAt: stamp(raw.heartbeatAt) === null ? '' : iso(stamp(raw.heartbeatAt)),
    reason: clean(raw.reason).slice(0, 80),
    segments,
    minutes: Math.round(minutes * 10) / 10,
    source: normalizeSource(raw.source),
    receipt: plainObject(raw.receipt) ? raw.receipt : null,
  }
}

export function normalizeActivityLedger(raw) {
  const base = emptyActivityLedger()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const activities = (Array.isArray(raw.activities) ? raw.activities : [])
    .map(normalizeActivity).filter(Boolean)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return {
    version: VERSION,
    revision: Math.max(0, Math.round(Number(raw.revision) || 0)),
    activities: activities.slice(-MAX_ACTIVITIES),
  }
}

export function loadActivityLedger(dataDir) {
  try {
    return normalizeActivityLedger(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')))
  } catch {
    return emptyActivityLedger()
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

function writeActivityLedger(dataDir, ledger) {
  try {
    const path = join(dataDir, FILE)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    writeFileSync(tmp, JSON.stringify(normalizeActivityLedger(ledger), null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function updateActivityLedger(dataDir, mutator) {
  const lock = acquireLock(dataDir)
  if (!lock) return { ok: false, ledger: null }
  try {
    const current = loadActivityLedger(dataDir)
    const next = mutator(current)
    if (next === null) return { ok: true, ledger: current }
    next.revision = (Number(next.revision) || 0) + 1
    if (!writeActivityLedger(dataDir, next)) return { ok: false, ledger: current }
    return { ok: true, ledger: next }
  } finally {
    releaseLock(lock)
  }
}

export function activeActivity(ledger, kind = '') {
  return ledger?.activities?.find((activity) => activity.state === 'active'
    && (!kind || activity.kind === kind)) ?? null
}

export function currentActivity(ledger) {
  return ledger?.activities?.find((activity) => activity.state === 'active' || activity.state === 'paused') ?? null
}

export function planActivity(ledger, {
  kind = 'reading', title = '', note = '', plannedMinutes = 25, now = new Date(), id = '', source = null,
} = {}) {
  const selected = KINDS.has(kind) ? kind : 'reading'
  const existing = ledger.activities.find((activity) => activity.kind === selected
    && (activity.state === 'planned' || activity.state === 'active' || activity.state === 'paused'))
  if (existing) return { ok: false, reject: '同一类活动已经在进行中', activity: existing }
  const activity = {
    id: clean(id) || `${selected}-${digest(`${now.toISOString()}:${selected}:${ledger.activities.length}`)}`,
    kind: selected,
    state: 'planned',
    revision: 1,
    plannedMinutes: clamp(plannedMinutes, 0, 1440),
    title: clean(title).slice(0, 120),
    note: clean(note).slice(0, 400),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    startedAt: '', endedAt: '', heartbeatAt: '', reason: '', segments: [], minutes: 0,
    source: normalizeSource(source),
    receipt: null,
  }
  ledger.activities.push(activity)
  if (ledger.activities.length > MAX_ACTIVITIES) ledger.activities = ledger.activities.slice(-MAX_ACTIVITIES)
  return { ok: true, activity }
}

function touch(activity, now) {
  activity.revision = (Number(activity.revision) || 0) + 1
  activity.updatedAt = now.toISOString()
}

function addSegment(activity, fromMs, toMs) {
  if (!(toMs > fromMs)) return
  activity.segments.push({ from: iso(fromMs), to: iso(toMs) })
  if (activity.segments.length > MAX_SEGMENTS) activity.segments = activity.segments.slice(-MAX_SEGMENTS)
  activity.minutes = Math.round(activity.segments
    .reduce((total, segment) => total + (Date.parse(segment.to) - Date.parse(segment.from)) / 60000, 0) * 10) / 10
}

export function startActivity(ledger, id, { now = new Date() } = {}) {
  const activity = ledger.activities.find((item) => item.id === id)
  if (!activity) return { ok: false, reject: '活动不存在' }
  if (activity.state !== 'planned' && activity.state !== 'paused') {
    return { ok: false, reject: `活动状态是 ${activity.state}，不能开始` }
  }
  activity.state = 'active'
  activity.startedAt = activity.startedAt || now.toISOString()
  touch(activity, now)
  activity.heartbeatAt = now.toISOString()
  return { ok: true, activity }
}

export function heartbeatActivity(ledger, id, { now = new Date() } = {}) {
  const activity = ledger.activities.find((item) => item.id === id)
  if (!activity || activity.state !== 'active') return { ok: false, reject: '没有正在进行的活动' }
  // Credit only the interval the worker was known to be alive. A long gap
  // between heartbeats is never silently counted as reading.
  const previous = stamp(activity.heartbeatAt)
  if (previous !== null && now.getTime() > previous) addSegment(activity, previous, now.getTime())
  activity.heartbeatAt = now.toISOString()
  touch(activity, now)
  return { ok: true, activity }
}

export function pauseActivity(ledger, id, { now = new Date(), reason = '', at = null } = {}) {
  const activity = ledger.activities.find((item) => item.id === id)
  if (!activity || activity.state !== 'active') return { ok: false, reject: '没有正在进行的活动' }
  const heartbeat = stamp(activity.heartbeatAt) ?? stamp(activity.updatedAt) ?? now.getTime()
  const end = at !== null ? Math.min(now.getTime(), Math.max(heartbeat, Number(at) || 0)) : now.getTime()
  addSegment(activity, heartbeat, end)
  activity.state = 'paused'
  touch(activity, now)
  activity.heartbeatAt = ''
  activity.reason = clean(reason).slice(0, 80)
  return { ok: true, activity }
}

export function finishActivity(ledger, id, { now = new Date(), outcome = '' } = {}) {
  const activity = ledger.activities.find((item) => item.id === id)
  if (!activity) return { ok: false, reject: '活动不存在' }
  if (activity.state === 'active') {
    const heartbeat = stamp(activity.heartbeatAt) ?? stamp(activity.updatedAt) ?? now.getTime()
    addSegment(activity, heartbeat, now.getTime())
  }
  if (!['active', 'paused'].includes(activity.state)) return { ok: false, reject: `活动状态是 ${activity.state}，不能结束` }
  activity.state = 'completed'
  activity.endedAt = now.toISOString()
  touch(activity, now)
  activity.heartbeatAt = ''
  if (outcome) activity.note = `${activity.note}${activity.note ? '；' : ''}${clean(outcome)}`.slice(0, 400)
  return { ok: true, activity }
}

// A receipt is the proof a run produced something: reading takeaway, dream
// text, journal text. It is attached once and never silently replaced.
export function attachActivityReceipt(ledger, id, receipt, { now = new Date() } = {}) {
  const activity = ledger.activities.find((item) => item.id === id)
  if (!activity) return { ok: false, reject: '活动不存在' }
  if (!plainObject(receipt)) return { ok: false, reject: '回执为空' }
  if (activity.receipt) return { ok: false, reject: '回执已存在' }
  activity.receipt = receipt
  touch(activity, now)
  return { ok: true, activity }
}

export function cancelActivity(ledger, id, { now = new Date(), reason = '' } = {}) {
  const activity = ledger.activities.find((item) => item.id === id)
  if (!activity) return { ok: false, reject: '活动不存在' }
  if (activity.state === 'active') {
    const heartbeat = stamp(activity.heartbeatAt) ?? stamp(activity.updatedAt) ?? now.getTime()
    addSegment(activity, heartbeat, now.getTime())
  }
  if (activity.state === 'completed' || activity.state === 'cancelled') {
    return { ok: false, reject: `活动状态是 ${activity.state}，不能取消` }
  }
  activity.state = 'cancelled'
  activity.endedAt = now.toISOString()
  touch(activity, now)
  activity.heartbeatAt = ''
  activity.reason = clean(reason).slice(0, 80)
  return { ok: true, activity }
}

// Restart recovery: an active run with a stale heartbeat is paused at the last
// heartbeat. Its wall-clock gap is never counted as reading.
export function recoverActivities(ledger, { now = new Date(), staleMs = HEARTBEAT_STALE_MS } = {}) {
  const recovered = []
  for (const activity of ledger.activities) {
    if (activity.state !== 'active') continue
    const heartbeat = stamp(activity.heartbeatAt) ?? stamp(activity.updatedAt)
    if (heartbeat === null || now.getTime() - heartbeat <= staleMs) continue
    addSegment(activity, heartbeat, heartbeat)
    activity.state = 'paused'
    touch(activity, now)
    activity.heartbeatAt = ''
    activity.reason = 'recovered'
    recovered.push(activity)
  }
  return recovered
}

export function readingMinutesBetween(ledger, { from, to = new Date() } = {}) {
  const start = from instanceof Date ? from.getTime() : stamp(from)
  const end = to instanceof Date ? to.getTime() : stamp(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  let minutes = 0
  for (const activity of ledger?.activities ?? []) {
    if (activity.kind !== 'reading') continue
    for (const segment of activity.segments ?? []) {
      const a = Math.max(start, Date.parse(segment.from))
      const b = Math.min(end, Date.parse(segment.to))
      if (b > a) minutes += (b - a) / 60000
    }
  }
  return Math.round(minutes * 10) / 10
}

export { HEARTBEAT_STALE_MS }

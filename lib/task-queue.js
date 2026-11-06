// Durable background tasks.
//
// Port of companion_v2's task admission: every background job has a row, a lane,
// a lease and a fence token, so a restart (or a second dsh process on the same
// data dir) cannot silently lose it or run it twice. What the original keeps in
// SQLite lives in one locked JSON document here — the plugin has no database of
// its own and adding one for eight rows would be the tail wagging the dog.
//
// The queue schedules nothing by itself: the 60s tick asks "is this job due?",
// claims it, runs it, and reports the outcome. Scheduling stays where the facts
// are (archive entries, sleep ledger, day boundaries).
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'tasks.json'
const VERSION = 1
const MAX_TASKS = 200
const KEEP_FINISHED_MS = 3 * 24 * 3600 * 1000
// A crashed run keeps its lease until this expires; the next tick reclaims it.
export const DEFAULT_LEASE_MS = 15 * 60000
const BACKOFF_MS = [60 * 1000, 5 * 60000, 15 * 60000, 60 * 60000]
const MAX_ATTEMPTS = 4

const STATES = ['queued', 'claimed', 'done', 'failed', 'cancelled']

const clean = (value) => String(value ?? '').trim()
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}
const iso = (value) => {
  const at = stamp(value)
  return at === null ? '' : new Date(at).toISOString()
}

export function emptyTaskQueue() {
  return { version: VERSION, tasks: [] }
}

export function normalizeTaskQueue(raw) {
  const base = emptyTaskQueue()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .map((task) => {
      if (!task || typeof task !== 'object') return null
      const kind = clean(task.kind).slice(0, 60)
      const id = clean(task.id).slice(0, 80)
      const createdAt = stamp(task.createdAt)
      if (!kind || !id || createdAt === null) return null
      return {
        id,
        kind,
        key: clean(task.key).slice(0, 120),
        lane: clean(task.lane).slice(0, 30) || 'life',
        payload: task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload) ? task.payload : null,
        state: STATES.includes(task.state) ? task.state : 'queued',
        runAt: iso(task.runAt) || new Date(createdAt).toISOString(),
        createdAt: new Date(createdAt).toISOString(),
        claimedAt: iso(task.claimedAt),
        leaseUntil: iso(task.leaseUntil),
        fence: Math.max(0, Number(task.fence) || 0),
        attempts: Math.max(0, Number(task.attempts) || 0),
        maxAttempts: Math.max(1, Number(task.maxAttempts) || MAX_ATTEMPTS),
        lastError: clean(task.lastError).slice(0, 240),
        finishedAt: iso(task.finishedAt),
        result: task.result && typeof task.result === 'object' && !Array.isArray(task.result) ? task.result : null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { version: VERSION, tasks: tasks.slice(-MAX_TASKS) }
}

export function loadTaskQueue(dataDir) {
  return normalizeTaskQueue(readJsonFile(dataDir, FILE))
}

function mutate(dataDir, fn) {
  let picked = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeTaskQueue(current)
    const next = fn(store)
    if (!next) return null
    picked = next.picked ?? picked
    return { version: VERSION, tasks: next.tasks.slice(-MAX_TASKS) }
  }, normalizeTaskQueue)
  return { ok: result.ok, picked, store: result.value ?? null }
}

// Finished rows older than three days go away; active rows never do, so a
// crash cannot erase the only evidence that something was running.
function prune(tasks, now) {
  const cut = now.getTime() - KEEP_FINISHED_MS
  return tasks.filter((task) => ['queued', 'claimed', 'failed'].includes(task.state) || (stamp(task.finishedAt) ?? 0) >= cut)
}

// Lease expiry is the restart story: a claimed row whose owner died becomes
// claimable again after the lease, no matter who killed the process.
export function recoverExpiredTasks(dataDir, { now = new Date() } = {}) {
  let recovered = 0
  const result = mutate(dataDir, (store) => {
    let changed = false
    for (const task of store.tasks) {
      if (task.state !== 'claimed') continue
      const until = stamp(task.leaseUntil)
      if (until !== null && until > now.getTime()) continue
      task.state = task.attempts >= task.maxAttempts ? 'failed' : 'queued'
      if (task.state === 'failed') task.finishedAt = now.toISOString()
      task.claimedAt = ''
      task.leaseUntil = ''
      task.lastError = '上一次运行没跑完（进程中断）'
      recovered += 1
      changed = true
    }
    return changed ? { tasks: prune(store.tasks, now) } : null
  })
  return result.ok ? recovered : 0
}

function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, attempts - 1))]
}

// Create-or-claim by (kind, key). Returns `claimed:false` when someone else
// holds a live lease, when the task already finished, or when it is backing off
// after a failure — the caller just skips this tick.
export function claimTask(dataDir, {
  kind, key = '', lane = 'life', payload = null, now = new Date(),
  leaseMs = DEFAULT_LEASE_MS, maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const wanted = clean(kind)
  if (!wanted) return { ok: false, claimed: false, reason: '没有任务类型', task: null }
  recoverExpiredTasks(dataDir, { now })
  const taskKey = clean(key)
  const at = now.toISOString()
  const result = mutate(dataDir, (store) => {
    let task = store.tasks.find((item) => item.kind === wanted && item.key === taskKey
      && ['queued', 'claimed'].includes(item.state))
    // A stable key identifies one job; periodic jobs without a key may start a new cycle.
    const finished = !task && taskKey
      ? store.tasks.findLast((item) => item.kind === wanted && item.key === taskKey) : null
    if (finished) return { tasks: store.tasks, picked: { claimed: false, reason: finished.state, task: finished } }
    if (!task) {
      store.tasks = prune(store.tasks, now)
      if (store.tasks.length >= MAX_TASKS) {
        const oldestFinished = store.tasks.findIndex(item => ['done', 'cancelled'].includes(item.state))
        if (oldestFinished >= 0) store.tasks.splice(oldestFinished, 1)
      }
      if (store.tasks.length >= MAX_TASKS) return { tasks: store.tasks, picked: { claimed: false, reason: 'queue-full', task: null } }
      task = {
        id: `t-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: wanted, key: taskKey, lane: clean(lane) || 'life',
        payload: payload && typeof payload === 'object' ? payload : null,
        state: 'queued', runAt: at, createdAt: at,
        claimedAt: '', leaseUntil: '', fence: 0, attempts: 0,
        maxAttempts: Math.max(1, Math.min(10, Number(maxAttempts) || MAX_ATTEMPTS)),
        lastError: '', finishedAt: '', result: null,
      }
      store.tasks.push(task)
    }
    if (task.state === 'claimed') {
      const until = stamp(task.leaseUntil)
      if (until !== null && until > now.getTime()) return { tasks: store.tasks, picked: { claimed: false, reason: 'leased', task } }
    }
    if ((stamp(task.runAt) ?? 0) > now.getTime()) {
      return { tasks: store.tasks, picked: { claimed: false, reason: 'backoff', task } }
    }
    if (task.attempts >= task.maxAttempts) {
      task.state = 'failed'
      task.finishedAt = at
      task.claimedAt = ''
      task.leaseUntil = ''
      return { tasks: store.tasks, picked: { claimed: false, reason: 'failed', task } }
    }
    task.state = 'claimed'
    task.claimedAt = at
    task.leaseUntil = new Date(now.getTime() + Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString()
    task.fence += 1
    task.attempts += 1
    return { tasks: store.tasks, picked: { claimed: true, reason: 'claimed', task } }
  })
  if (!result.ok) return { ok: false, claimed: false, reason: '写入失败', task: null }
  return { ok: result.picked?.reason !== 'queue-full', claimed: result.picked?.claimed === true, reason: result.picked?.reason ?? '', task: result.picked?.task ?? null }
}

export function completeTask(dataDir, id, { now = new Date(), fence = null, result = null } = {}) {
  return finish(dataDir, id, { now, fence, state: 'done', patch: { lastError: '', result } })
}

export function failTask(dataDir, id, { now = new Date(), fence = null, error = '' } = {}) {
  return finish(dataDir, id, { now, fence, state: 'retry', patch: { lastError: clean(error).slice(0, 240) } })
}

function finish(dataDir, id, { now, fence, state, patch }) {
  const wanted = clean(id)
  let outcome = 'missing'
  const result = mutate(dataDir, (store) => {
    const task = store.tasks.find((item) => item.id === wanted)
    if (!task) return null
    // The fence is the "someone else took it over" check: a late finisher from
    // an old run must not overwrite the row the new run is holding.
    if (Number.isInteger(fence) && task.fence !== fence) { outcome = 'stale'; return null }
    if (!['queued', 'claimed'].includes(task.state)) { outcome = 'finished'; return null }
    Object.assign(task, patch)
    if (state === 'done') {
      task.state = 'done'
      task.finishedAt = now.toISOString()
      task.leaseUntil = ''
    } else if (task.attempts >= task.maxAttempts) {
      task.state = 'failed'
      task.finishedAt = now.toISOString()
      task.leaseUntil = ''
    } else {
      task.state = 'queued'
      task.runAt = new Date(now.getTime() + backoffFor(task.attempts)).toISOString()
      task.claimedAt = ''
      task.leaseUntil = ''
    }
    outcome = task.state
    return { tasks: prune(store.tasks, now) }
  })
  // ok 只在这一行真的被这次调用改写了才是 true：missing / stale / finished
  // 都说明「调用方以为的结束」没有发生，调用方需要知道。
  const transitioned = ['done', 'queued', 'failed'].includes(outcome)
  return { ok: result.ok && transitioned, state: result.ok ? outcome : 'write-failed' }
}

export function cancelTask(dataDir, id, { now = new Date() } = {}) {
  const wanted = clean(id)
  let cancelled = null
  const result = mutate(dataDir, (store) => {
    const task = store.tasks.find((item) => item.id === wanted)
    if (!task || !['queued', 'claimed', 'failed'].includes(task.state)) return null
    task.state = 'cancelled'
    task.finishedAt = now.toISOString()
    task.leaseUntil = ''
    cancelled = task
    return { tasks: store.tasks }
  })
  return result.ok && cancelled ? { ok: true, task: cancelled } : { ok: false, reject: result.ok ? '没有可取消的任务。' : '任务取消未能写入。' }
}

// Put a task back at the front of the queue: clears a backoff window, or
// revives one that already gave up (after the provider was fixed).
export function retryTask(dataDir, id, { now = new Date() } = {}) {
  const wanted = clean(id)
  let picked = null
  const result = mutate(dataDir, (store) => {
    const task = store.tasks.find((item) => item.id === wanted)
    if (!task || !['queued', 'failed'].includes(task.state)) return null
    task.state = 'queued'
    task.runAt = now.toISOString()
    task.claimedAt = ''
    task.leaseUntil = ''
    task.finishedAt = ''
    if (task.attempts >= task.maxAttempts) task.attempts = 0
    task.lastError = ''
    picked = task
    return { tasks: store.tasks }
  })
  return result.ok && picked ? { ok: true, task: picked } : { ok: false, reject: result.ok ? '没有可重试的任务。' : '任务重试未能写入。' }
}

export function listTasks(dataDir, { limit = 20 } = {}) {
  const store = loadTaskQueue(dataDir)
  const active = store.tasks.filter((task) => ['queued', 'claimed'].includes(task.state))
  const finished = store.tasks.filter((task) => !['queued', 'claimed'].includes(task.state)).slice(-limit)
  return { active, finished }
}

export { MAX_TASKS, MAX_ATTEMPTS, BACKOFF_MS, KEEP_FINISHED_MS }

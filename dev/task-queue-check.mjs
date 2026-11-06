import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import {
  claimTask, completeTask, failTask, cancelTask, listTasks, loadTaskQueue, retryTask,
  recoverExpiredTasks, DEFAULT_LEASE_MS,
} from '../lib/task-queue.js'

const at = (value) => new Date(value)

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'task-queue-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('expired and legacy queued tasks cannot exceed attempts without explicit retry', () => {
  const t = tmp()
  try {
    const now = at('2026-11-02T10:00:00')
    const first = claimTask(t.dir, { kind: 'journal.write', key: 'crash', now, maxAttempts: 1, leaseMs: 1000 })
    const later = at('2026-11-02T10:00:02')
    assert.equal(recoverExpiredTasks(t.dir, { now: later }), 1)
    const exhausted = claimTask(t.dir, { kind: 'journal.write', key: 'crash', now: later })
    assert.equal(exhausted.claimed, false)
    assert.equal(exhausted.task.state, 'failed')
    assert.equal(exhausted.task.attempts, 1)
    assert.equal(retryTask(t.dir, first.task.id, { now: later }).ok, true)
    assert.equal(claimTask(t.dir, { kind: 'journal.write', key: 'crash', now: later }).task.attempts, 1)
    const queue = loadTaskQueue(t.dir)
    queue.tasks[0].state = 'queued'
    writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify(queue))
    assert.equal(claimTask(t.dir, { kind: 'journal.write', key: 'crash', now: later }).claimed, false)
  } finally { t.done() }
})

test('finish cancel and retry report disk failure rather than a durable transition', () => {
  const t = tmp(), originalRename = fs.renameSync
  try {
    const now = at('2026-11-02T10:00:00')
    const a = claimTask(t.dir, { kind: 'fixture', key: 'a', now }).task
    const b = claimTask(t.dir, { kind: 'fixture', key: 'b', now }).task
    failTask(t.dir, b.id, { now, fence: b.fence })
    const before = fs.readFileSync(join(t.dir, 'tasks.json'), 'utf8')
    fs.renameSync = (source, destination) => {
      if (destination === join(t.dir, 'tasks.json')) throw new Error('fixture disk unavailable')
      return originalRename(source, destination)
    }
    syncBuiltinESMExports()
    assert.equal(recoverExpiredTasks(t.dir, { now: at('2026-11-02T10:20:00') }), 0)
    assert.equal(completeTask(t.dir, a.id, { now, fence: a.fence }).ok, false)
    assert.equal(failTask(t.dir, a.id, { now, fence: a.fence }).ok, false)
    assert.equal(cancelTask(t.dir, a.id, { now }).ok, false)
    assert.equal(retryTask(t.dir, b.id, { now }).ok, false)
    assert.equal(fs.readFileSync(join(t.dir, 'tasks.json'), 'utf8'), before)
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); t.done() }
})

test('a live lease keeps the second claimer out', () => {
  const t = tmp()
  try {
    const first = claimTask(t.dir, { kind: 'journal.write', key: '2026-11-02', now: at('2026-11-02T23:50:00') })
    assert.equal(first.claimed, true)
    assert.equal(first.task.attempts, 1)
    assert.equal(first.task.fence, 1)
    const second = claimTask(t.dir, { kind: 'journal.write', key: '2026-11-02', now: at('2026-11-02T23:51:00') })
    assert.equal(second.claimed, false)
    assert.equal(second.reason, 'leased')
    // 不同 key 是另一件事，不互相挡。
    const other = claimTask(t.dir, { kind: 'journal.write', key: '2026-11-03', now: at('2026-11-02T23:51:00') })
    assert.equal(other.claimed, true)
  } finally { t.done() }
})

test('a full queue rejects new work without discarding an active lease', () => {
  const t = tmp()
  try {
    const now = at('2026-11-02T10:00:00')
    const initial = claimTask(t.dir, { kind: 'fixture', key: 'job-0', now }).task
    writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify({ version: 1,
      tasks: Array.from({ length: 200 }, (_, i) => ({ ...initial, id: `fixture-${i}`, key: `job-${i}` })) }))
    const before = loadTaskQueue(t.dir).tasks.map(task => task.id)
    const denied = claimTask(t.dir, { kind: 'fixture', key: 'overflow', now })
    assert.equal(denied.ok, false)
    assert.equal(denied.claimed, false)
    assert.deepEqual(loadTaskQueue(t.dir).tasks.map(task => task.id), before)
    assert.equal(claimTask(t.dir, { kind: 'fixture', key: 'job-0', now }).reason, 'leased')
    const full = loadTaskQueue(t.dir)
    full.tasks.forEach(task => { task.state = 'failed'; task.finishedAt = now.toISOString() })
    writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify(full))
    assert.equal(claimTask(t.dir, { kind: 'fixture', key: 'overflow', now }).reason, 'queue-full')
    assert.equal(loadTaskQueue(t.dir).tasks.length, 200)
    full.tasks.forEach((task, i) => { task.state = i === 0 ? 'cancelled' : 'done' })
    writeFileSync(join(t.dir, 'tasks.json'), JSON.stringify(full))
    assert.equal(claimTask(t.dir, { kind: 'fixture', key: 'overflow', now }).claimed, true)
    const remaining = loadTaskQueue(t.dir).tasks
    assert.equal(remaining.length, 200)
    assert.equal(remaining.some(task => task.id === initial.id), false)
    assert.equal(remaining.some(task => task.id === 'fixture-0'), false)
  } finally { t.done() }
})

test('a crashed run is reclaimed after its lease expires', () => {
  const t = tmp()
  try {
    const first = claimTask(t.dir, { kind: 'journal.write', key: 'd1', now: at('2026-11-02T23:50:00'), leaseMs: 60000 })
    assert.equal(first.claimed, true)
    // 进程挂了：没人 complete，也没人 fail。
    const later = claimTask(t.dir, { kind: 'journal.write', key: 'd1', now: at('2026-11-02T23:52:00') })
    assert.equal(later.claimed, true)
    assert.equal(later.task.attempts, 2)
    assert.equal(later.task.fence, 2)
    assert.match(later.task.lastError, /中断/)
  } finally { t.done() }
})

test('a late finisher from an old run cannot close the new run', () => {
  const t = tmp()
  try {
    const first = claimTask(t.dir, { kind: 'state.maintain', now: at('2026-11-02T10:00:00'), leaseMs: 60000 })
    const second = claimTask(t.dir, { kind: 'state.maintain', now: at('2026-11-02T10:02:00') })
    assert.equal(second.claimed, true)
    assert.equal(completeTask(t.dir, first.task.id, { fence: first.task.fence, now: at('2026-11-02T10:03:00') }).state, 'stale')
    assert.equal(completeTask(t.dir, second.task.id, { fence: second.task.fence, now: at('2026-11-02T10:03:00') }).state, 'done')
    assert.equal(loadTaskQueue(t.dir).tasks[0].state, 'done')
  } finally { t.done() }
})

test('failures back off, then give up and stay visible', () => {
  const t = tmp()
  try {
    const now = at('2026-11-02T10:00:00')
    const first = claimTask(t.dir, { kind: 'journal.write', key: 'd2', now, maxAttempts: 2 })
    assert.equal(failTask(t.dir, first.task.id, { fence: first.task.fence, now, error: '模型超时' }).state, 'queued')
    const task = loadTaskQueue(t.dir).tasks[0]
    assert.equal(task.attempts, 1)
    assert.ok(Date.parse(task.runAt) > now.getTime(), '退避窗口内不再重试')
    assert.equal(task.lastError, '模型超时')
    // 退避期内 claim 不到。
    assert.equal(claimTask(t.dir, { kind: 'journal.write', key: 'd2', now: at('2026-11-02T10:00:30') }).claimed, false)

    const retry = claimTask(t.dir, { kind: 'journal.write', key: 'd2', now: at('2026-11-02T10:05:00'), maxAttempts: 2 })
    assert.equal(retry.claimed, true)
    assert.equal(retry.task.attempts, 2)
    assert.equal(failTask(t.dir, retry.task.id, { fence: retry.task.fence, now: at('2026-11-02T10:05:00'), error: '还是失败' }).state, 'failed')
    const stopped = claimTask(t.dir, { kind: 'journal.write', key: 'd2', now: at('2026-11-02T11:00:00') })
    assert.equal(stopped.claimed, false, '失败上限必须对同一个工作生效，不能新建任务清零')
    assert.equal(stopped.reason, 'failed')
    assert.equal(stopped.task.id, retry.task.id)
  } finally { t.done() }
})

test('keyed terminal jobs stay stopped while unkeyed maintenance can run again', () => {
  const t = tmp()
  try {
    const now = at('2026-11-02T10:00:00')
    for (const state of ['done', 'cancelled']) {
      const job = claimTask(t.dir, { kind: 'journal.write', key: state, now })
      if (state === 'done') completeTask(t.dir, job.task.id, { now, fence: job.task.fence })
      else cancelTask(t.dir, job.task.id, { now })
      const repeated = claimTask(t.dir, { kind: 'journal.write', key: state, now })
      assert.equal(repeated.claimed, false)
      assert.equal(repeated.reason, state)
    }
    const maintenance = claimTask(t.dir, { kind: 'state.maintain', now })
    completeTask(t.dir, maintenance.task.id, { now, fence: maintenance.task.fence })
    assert.equal(claimTask(t.dir, { kind: 'state.maintain', now }).claimed, true)
  } finally { t.done() }
})

test('cancel stops a queued task and shows up in the listing', () => {
  const t = tmp()
  try {
    const claimed = claimTask(t.dir, { kind: 'journal.write', key: 'd3', now: at('2026-11-02T10:00:00') })
    assert.equal(cancelTask(t.dir, claimed.task.id, { now: at('2026-11-02T10:01:00') }).ok, true)
    assert.equal(cancelTask(t.dir, claimed.task.id).ok, false)
    const listed = listTasks(t.dir)
    assert.equal(listed.active.length, 0)
    assert.equal(listed.finished.at(-1).state, 'cancelled')
    assert.equal(completeTask(t.dir, claimed.task.id, { now: at('2026-11-02T10:02:00') }).ok, false)
  } finally { t.done() }
})

test('recovery turns every expired claim back into a queued row', () => {
  const t = tmp()
  try {
    claimTask(t.dir, { kind: 'journal.write', key: 'a', now: at('2026-11-02T10:00:00'), leaseMs: 60000 })
    claimTask(t.dir, { kind: 'state.maintain', key: 'b', now: at('2026-11-02T10:00:00'), leaseMs: 60000 })
    assert.equal(recoverExpiredTasks(t.dir, { now: at('2026-11-02T10:00:30') }), 0)
    assert.equal(recoverExpiredTasks(t.dir, { now: at('2026-11-02T10:02:00') }), 2)
    assert.ok(loadTaskQueue(t.dir).tasks.every((task) => task.state === 'queued'))
  } finally { t.done() }
})

test('retry clears a backoff and revives a task that gave up', () => {
  const t = tmp()
  try {
    const now = at('2026-11-02T10:00:00')
    const first = claimTask(t.dir, { kind: 'journal.write', key: 'r1', now })
    failTask(t.dir, first.task.id, { fence: first.task.fence, now, error: '超时' })
    assert.equal(retryTask(t.dir, first.task.id, { now: at('2026-11-02T10:00:10') }).ok, true)
    assert.equal(claimTask(t.dir, { kind: 'journal.write', key: 'r1', now: at('2026-11-02T10:00:10') }).claimed, true, '退避被清掉了')

    const second = claimTask(t.dir, { kind: 'state.maintain', key: 'r2', now, maxAttempts: 1 })
    failTask(t.dir, second.task.id, { fence: second.task.fence, now, error: '炸了' })
    assert.equal(loadTaskQueue(t.dir).tasks.find((task) => task.id === second.task.id).state, 'failed')
    assert.equal(retryTask(t.dir, second.task.id, { now: at('2026-11-02T10:30:00') }).ok, true)
    assert.equal(claimTask(t.dir, { kind: 'state.maintain', key: 'r2', now: at('2026-11-02T10:30:00') }).claimed, true)
  } finally { t.done() }
})

test('the default lease is long enough for a model call', () => {
  assert.ok(DEFAULT_LEASE_MS >= 5 * 60000)
})

test('an explicitly cancelled failed task no longer remains an unresolved failure', () => {
  const t = tmp()
  try {
    const now = at('2026-11-05T12:00:00')
    const task = claimTask(t.dir, { kind: 'memory.retain', key: 'discard', maxAttempts: 1, now }).task
    failTask(t.dir, task.id, { now, fence: task.fence, error: 'HTTP 503' })
    assert.equal(cancelTask(t.dir, task.id, { now }).ok, true)
    assert.equal(loadTaskQueue(t.dir).tasks[0].state, 'cancelled')
    assert.equal(claimTask(t.dir, { kind: 'memory.retain', key: 'discard', now }).claimed, false)
  } finally { t.done() }
})

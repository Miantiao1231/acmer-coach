import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyActivityLedger, planActivity, startActivity, heartbeatActivity, pauseActivity,
  finishActivity, cancelActivity, recoverActivities, readingMinutesBetween, loadActivityLedger,
  updateActivityLedger, normalizeActivityLedger,
} from '../lib/activity-ledger.js'
import { settleActivities } from '../lib/activity-runtime.js'
import {
  recordUserMessage, messageCountSince, loadInteractionLog, normalizeInteractionLog,
  MAX_MESSAGES, RETENTION_MS, TEXT_RETENTION_MS,
} from '../lib/interaction-log.js'

const at = (value) => new Date(value)
const NOW = at('2026-11-02T12:00:00')

function startedReading(ledger, { minutes = 25, now = NOW } = {}) {
  const planned = planActivity(ledger, { kind: 'reading', title: '《书》', plannedMinutes: minutes, now })
  assert.equal(planned.ok, true)
  assert.equal(startActivity(ledger, planned.activity.id, { now }).ok, true)
  return planned.activity
}

test('a reading run credits only the heartbeats it actually saw', () => {
  const ledger = emptyActivityLedger()
  const activity = startedReading(ledger)
  assert.equal(activity.state, 'active')
  assert.equal(activity.revision, 2, 'plan + start')
  heartbeatActivity(ledger, activity.id, { now: at('2026-11-02T12:05:00') })
  heartbeatActivity(ledger, activity.id, { now: at('2026-11-02T12:10:00') })
  assert.equal(activity.minutes, 10)
  assert.equal(finishActivity(ledger, activity.id, { now: at('2026-11-02T12:12:00') }).ok, true)
  assert.equal(activity.state, 'completed')
  assert.equal(activity.minutes, 12)
  assert.equal(activity.endedAt, at('2026-11-02T12:12:00').toISOString())
})

test('pausing credits the run, and cancelling closes a planned item', () => {
  const ledger = emptyActivityLedger()
  const activity = startedReading(ledger)
  pauseActivity(ledger, activity.id, { now: at('2026-11-02T12:03:00'), reason: 'sleep' })
  assert.equal(activity.state, 'paused')
  assert.equal(activity.minutes, 3)
  assert.equal(startActivity(ledger, activity.id, { now: at('2026-11-02T12:10:00') }).ok, true)
  heartbeatActivity(ledger, activity.id, { now: at('2026-11-02T12:12:00') })
  assert.equal(finishActivity(ledger, activity.id, { now: at('2026-11-02T12:15:00') }).ok, true)
  assert.equal(activity.minutes, 8, '3 min before the pause + 5 min after it')

  const other = planActivity(ledger, { kind: 'journal', title: '日记', now: NOW })
  assert.equal(cancelActivity(ledger, other.activity.id, { now: NOW, reason: 'not needed' }).ok, true)
  assert.equal(other.activity.state, 'cancelled')
})

test('a stale worker is paused at its last heartbeat, never completed by elapsed time', () => {
  const ledger = emptyActivityLedger()
  const activity = startedReading(ledger)
  heartbeatActivity(ledger, activity.id, { now: at('2026-11-02T12:05:00') })
  const recovered = recoverActivities(ledger, { now: at('2026-11-02T13:00:00') })
  assert.equal(recovered.length, 1)
  assert.equal(activity.state, 'paused')
  assert.equal(activity.reason, 'recovered')
  assert.equal(activity.minutes, 5, 'the one-hour gap is not reading')
})

test('only one live activity of each kind, and reading minutes cross-check segments', () => {
  const ledger = emptyActivityLedger()
  const activity = startedReading(ledger, { minutes: 25 })
  assert.equal(planActivity(ledger, { kind: 'reading', title: '另一本', now: NOW }).ok, false)
  heartbeatActivity(ledger, activity.id, { now: at('2026-11-02T12:10:00') })
  finishActivity(ledger, activity.id, { now: at('2026-11-02T12:15:00') })
  assert.equal(readingMinutesBetween(ledger, { from: at('2026-11-02T11:50:00'), to: at('2026-11-02T12:20:00') }), 15)
  assert.equal(readingMinutesBetween(ledger, { from: at('2026-11-02T12:12:00'), to: at('2026-11-02T12:13:00') }), 1)
  assert.equal(readingMinutesBetween(ledger, { from: at('2026-11-02T13:00:00'), to: at('2026-11-02T14:00:00') }), 0)
})

test('the ledger is revisioned, durable and tolerates a damaged file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-act-'))
  try {
    const result = updateActivityLedger(dir, (ledger) => {
      startedReading(ledger, { now: NOW })
      return ledger
    })
    assert.equal(result.ok, true)
    assert.equal(result.ledger.revision, 1)
    assert.equal(result.ledger.activities[0].revision, 2)

    const second = updateActivityLedger(dir, (ledger) => {
      heartbeatActivity(ledger, ledger.activities[0].id, { now: at('2026-11-02T12:05:00') })
      return ledger
    })
    assert.equal(second.ledger.revision, 2)
    assert.equal(second.ledger.activities[0].revision, 3)
    assert.equal(loadActivityLedger(dir).activities[0].minutes, 5)

    writeFileSync(join(dir, 'activities.json'), '{broken', 'utf8')
    assert.deepEqual(loadActivityLedger(dir), emptyActivityLedger())
    assert.deepEqual(normalizeActivityLedger({ version: 9 }), emptyActivityLedger())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the runtime plans, pauses, resumes and completes a reading day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-act-'))
  const person = { library: [{ title: '具体数学', state: 'reading', note: '第二章' }] }
  try {
    settleActivities(dir, { now: NOW, presence: { mode: 'normal' }, person })
    let ledger = loadActivityLedger(dir)
    assert.equal(ledger.activities.length, 1)
    assert.equal(ledger.activities[0].state, 'planned')
    assert.equal(ledger.activities[0].plannedMinutes, 25)

    settleActivities(dir, { now: NOW, presence: { mode: 'normal' }, person })
    ledger = loadActivityLedger(dir)
    assert.equal(ledger.activities[0].state, 'active')

    for (let minute = 5; minute <= 25; minute += 5) {
      settleActivities(dir, { now: new Date(NOW.getTime() + minute * 60000), presence: { mode: 'normal' }, person })
    }
    ledger = loadActivityLedger(dir)
    assert.equal(ledger.activities[0].state, 'completed')
    assert.ok(ledger.activities[0].minutes >= 25)

    settleActivities(dir, { now: new Date(NOW.getTime() + 26 * 60000), presence: { mode: 'sleep' }, person })
    assert.equal(loadActivityLedger(dir).activities[0].state, 'completed', 'sleep does not reopen a finished run')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the runtime pauses reading for sleep and resumes it on waking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-act-'))
  const person = { library: [{ title: '具体数学', state: 'reading' }] }
  try {
    settleActivities(dir, { now: NOW, presence: { mode: 'normal' }, person })
    settleActivities(dir, { now: NOW, presence: { mode: 'normal' }, person })
    settleActivities(dir, { now: new Date(NOW.getTime() + 5 * 60000), presence: { mode: 'sleep' }, person })
    let ledger = loadActivityLedger(dir)
    assert.equal(ledger.activities[0].state, 'paused')
    assert.equal(ledger.activities[0].reason, 'sleep')

    settleActivities(dir, { now: new Date(NOW.getTime() + 10 * 60000), presence: { mode: 'normal' }, person })
    ledger = loadActivityLedger(dir)
    assert.equal(ledger.activities[0].state, 'active')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dreams and journal entries settle once per source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-act-'))
  const person = { library: [{ title: '具体数学', state: 'reading' }] }
  const sleepLedger = {
    episodes: [{
      id: 'night-1', kind: 'night', state: 'completed',
      startedAt: '2026-11-01T23:30:00', updatedAt: '2026-11-02T07:30:00',
      endedAt: '2026-11-02T07:30:00', sleptSeconds: 8 * 3600,
    }],
  }
  const journal = { day: '2026-11-02', text: '今天看了两页书。', at: NOW.toISOString() }
  const dream = { id: 'dream-night-1', day: '2026-11-02', text: '梦见书页自己在翻。', nightId: 'night-1' }
  try {
    settleActivities(dir, { now: NOW, presence: { mode: 'normal' }, person, sleepLedger, journal, dream })
    settleActivities(dir, { now: NOW, presence: { mode: 'normal' }, person, sleepLedger, journal, dream })
    const ledger = loadActivityLedger(dir)
    assert.equal(ledger.activities.filter((a) => a.kind === 'dream').length, 1)
    assert.equal(ledger.activities.filter((a) => a.kind === 'journal').length, 1)
    assert.equal(ledger.activities.find((a) => a.kind === 'dream').state, 'completed')
    assert.equal(ledger.activities.find((a) => a.kind === 'dream').receipt.text, '梦见书页自己在翻。')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the interaction log counts only real recent messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-act-'))
  try {
    recordUserMessage(dir, at('2026-11-02T11:00:00'))
    recordUserMessage(dir, at('2026-11-02T11:00:00.500'))
    recordUserMessage(dir, at('2026-11-02T11:10:00'))
    recordUserMessage(dir, at('2026-10-30T11:00:00'))
    const log = loadInteractionLog(dir, NOW)
    assert.equal(log.messages.length, 2, 'same-turn duplicate is not counted, old message is pruned')
    assert.equal(messageCountSince(log, { now: NOW, since: at('2026-11-02T10:00:00') }), 2)
    assert.equal(messageCountSince(log, { now: NOW }), 2)
    assert.ok(log.messages.length <= MAX_MESSAGES)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('interaction log retention uses the supplied clock at both expiry boundaries', () => {
  const now = at('2000-01-10T12:00:00Z')
  const iso = (age) => new Date(now.getTime() - age).toISOString()
  const log = normalizeInteractionLog({
    version: 1,
    messages: [iso(RETENTION_MS + 1), iso(RETENTION_MS)],
    entries: [
      { at: iso(TEXT_RETENTION_MS + 1), text: 'expired' },
      { at: iso(TEXT_RETENTION_MS), text: 'still retained' },
    ],
  }, now)
  assert.deepEqual(log.messages, [iso(RETENTION_MS)])
  assert.deepEqual(log.entries, [{ at: iso(TEXT_RETENTION_MS), text: 'still retained' }])
})

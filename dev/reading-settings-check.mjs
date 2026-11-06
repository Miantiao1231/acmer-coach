import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as stateApi from '../lib/proactive-state.js'
import { createProactiveWorker } from '../lib/proactive-worker.js'

const AT = new Date(2026, 10, 6, 10)
const fixture = t => { const dir = mkdtempSync(join(tmpdir(), 'coach-reading-settings-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

test('autonomous reading defaults off and reserves a separate durable two-call budget', t => {
  const dir = fixture(t)
  assert.equal(stateApi.emptyState(AT).settings.autonomousReading, false)
  assert.equal(stateApi.reserveReading(dir, AT), '')
  const state = stateApi.loadState(dir, AT)
  state.settings.autonomousReading = true
  state.settings.backgroundLlm = false
  state.settings.lifeImprov = false
  state.enabled = false
  assert.equal(stateApi.saveState(dir, state), true)
  const before = stateApi.readingStatus(dir, AT)
  assert.deepEqual(before, { enabled: true, dailyLimit: 2, callsToday: 0, requestsToday: 0, requestLimit: 8, nextAt: '' })
  const first = stateApi.reserveReading(dir, AT)
  const second = stateApi.reserveReading(dir, AT)
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first, second, 'each real reading session reserves one call')
  assert.equal(stateApi.reserveReading(dir, new Date(AT.getTime() + 3600000)), '')
  assert.equal(stateApi.readingStatus(dir, AT).callsToday, 2)
  assert.equal(stateApi.loadState(dir, AT).readingBudget.calls, 2, 'restart and model failure cannot refund reservations')
  const nextDay = new Date(2026, 10, 7, 10)
  assert.equal(stateApi.readingStatus(dir, nextDay).callsToday, 0)
  assert.equal(stateApi.loadState(dir, nextDay).readingBudget.day, '2026-11-06', 'status reads do not rewrite budget')
  assert.ok(stateApi.reserveReading(dir, nextDay))
})

test('reading status explains cadence and the worker exposes only an explicit independent opt-in', t => {
  const dir = fixture(t)
  const worker = createProactiveWorker({ dataDir: dir, ctx: {}, now: () => AT, env: { COACH_BACKGROUND_LLM: '0' } })
  assert.equal(worker.status().effective.autonomousReading, false)
  assert.equal(worker.setSettings({ autonomousReading: 'true' }).ok, false)
  assert.equal(worker.setSettings({ autonomousReading: true }).ok, true)
  assert.equal(worker.status().effective.autonomousReading, true)
  assert.equal(worker.status().enabled, false)
  assert.ok(stateApi.reserveReading(dir, AT))
  assert.equal(stateApi.readingStatus(dir, AT).nextAt, new Date(AT.getTime() + 30 * 60000).toISOString())
  assert.equal(worker.status().readingCallsToday, 1)
  assert.equal(worker.status().readingNextAt, new Date(AT.getTime() + 30 * 60000).toISOString())
  assert.equal(worker.setSettings({ autonomousReading: false }).ok, true)
  assert.equal(stateApi.reserveReading(dir, AT), '')
  assert.equal(stateApi.readingStatus(dir, AT).callsToday, 1)
})

test('model requests are charged one by one and stop when the day is spent', t => {
  const dir = fixture(t)
  const state = stateApi.emptyState(AT)
  state.settings.autonomousReading = true
  stateApi.saveState(dir, state)
  assert.equal(stateApi.reserveReadingRequest(dir, AT), true)
  assert.equal(stateApi.readingStatus(dir, AT).requestsToday, 1)
  assert.equal(stateApi.readingStatus(dir, AT).callsToday, 0, 'requests do not consume the session cadence')
  for (let i = 1; i < 8; i += 1) assert.equal(stateApi.reserveReadingRequest(dir, AT), true)
  assert.equal(stateApi.reserveReadingRequest(dir, AT), false)
  assert.equal(stateApi.readingStatus(dir, AT).requestsToday, 8)
  // A closed switch never charges, even mid-session.
  stateApi.updateState(dir, current => { current.settings.autonomousReading = false; return current }, AT)
  assert.equal(stateApi.reserveReadingRequest(dir, AT), false)
  // The counter is per day.
  assert.equal(stateApi.readingStatus(dir, new Date(2026, 10, 7, 10)).requestsToday, 0)
})

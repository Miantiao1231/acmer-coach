import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptySleepLedger, startSleepEpisode, interruptSleepEpisode, resumeDueSleep,
  finishSleepEpisode, finishDueSleep, sleepProfile, sleepQualityRange,
  recommendedSleepMinutes, nightSleepReady, napReady, loadSleepLedger, updateSleepLedger,
  ensureAutoNights,
} from '../lib/sleep-ledger.js'
import { settleSleep, sleepMinutesBetween } from '../lib/sleep-runtime.js'
import { DEFAULT_SLEEP_SETTINGS } from '../lib/sleep-settings.js'

// Tests pin the schedule: the production default adds a deterministic ±30 min
// jitter, which is correct behavior but would make these windows drift.
const FIXED = { ...DEFAULT_SLEEP_SETTINGS, time: '23:30', minutes: 480, variationMinutes: 0 }

const at = (value) => new Date(value)

function completedEpisode({ id = 'e1', kind = 'night', start = '2026-10-30T23:00:00', minutes = 480,
  base = 480, qualityMin = 82, qualityMax = 95, workloadScore = 0 } = {}) {
  return {
    id, kind, state: 'completed',
    startedAt: at(start).toISOString(),
    updatedAt: at(new Date(at(start).getTime() + minutes * 60000)).toISOString(),
    endedAt: at(new Date(at(start).getTime() + minutes * 60000)).toISOString(),
    dueAt: '',
    baseNeedMinutes: base, targetMinutes: minutes,
    sleptSeconds: minutes * 60, interruptions: 0, earlyInterruptions: 0,
    qualityMin, qualityMax, wakeUntil: '', oversleepMinutes: 0, workloadScore,
  }
}

test('a sleep episode can be interrupted, resumed and finished', () => {
  const ledger = emptySleepLedger(0)
  const started = startSleepEpisode(ledger, { kind: 'night', baseNeedMinutes: 480, targetMinutes: 480, now: at('2026-10-30T23:00:00') })
  assert.equal(started.ok, true)
  const paused = interruptSleepEpisode(ledger, started.episode.id, { now: at('2026-10-30T23:30:00'), graceMinutes: 30 })
  assert.equal(paused.ok, true)
  assert.equal(paused.episode.state, 'paused')
  assert.equal(paused.episode.sleptSeconds, 30 * 60)
  assert.equal(paused.episode.interruptions, 1)
  assert.equal(paused.episode.earlyInterruptions, 0)
  assert.equal(paused.episode.wakeUntil, at('2026-10-31T00:00:00').toISOString())

  const resumed = resumeDueSleep(ledger, { now: at('2026-10-31T00:05:00') })
  assert.equal(resumed.length, 1)
  assert.equal(started.episode.state, 'active')
  assert.equal(started.episode.dueAt, at('2026-10-31T07:35:00').toISOString())

  const finished = finishSleepEpisode(ledger, started.episode.id, { now: at('2026-10-31T07:35:00') })
  assert.equal(finished.ok, true)
  assert.equal(finished.episode.state, 'completed')
  assert.equal(finished.episode.sleptSeconds, 8 * 3600)
  assert.equal(finished.episode.interruptions, 1)
})

test('sleep debt is settled from completed receipts, not from awake time', () => {
  assert.equal(sleepProfile({ ...emptySleepLedger(0), episodes: [completedEpisode({ minutes: 480 })] }).sleepDebtMinutes, 0)
  assert.equal(sleepProfile({ ...emptySleepLedger(0), episodes: [completedEpisode({ minutes: 360 })] }).sleepDebtMinutes, 120)
  assert.equal(sleepProfile({ ...emptySleepLedger(100), episodes: [completedEpisode({ minutes: 540 })] }).sleepDebtMinutes, 60)
  const nap = completedEpisode({ kind: 'nap', start: '2026-10-30T13:00:00', minutes: 30, base: 30 })
  assert.ok(sleepProfile({ ...emptySleepLedger(100), episodes: [nap] }).sleepDebtMinutes < 100)
})

test('sleep pressure grows with awake minutes and debt', () => {
  const episode = completedEpisode({ start: '2026-10-31T00:00:00', minutes: 480 })
  const profile = sleepProfile({ ...emptySleepLedger(120), episodes: [episode] }, {
    now: at('2026-10-31T10:00:00'), workloadScore: 50,
  })
  assert.equal(profile.awakeMinutes, 120)
  assert.equal(profile.sleepPressure, Math.min(100, Math.round(120 / 60 * 4 + 120 * 0.14 + 50 * 0.12)))
  assert.equal(profile.hasSleepHistory, true)
})

test('sleep quality and recommended duration follow the original ranges', () => {
  const low = sleepQualityRange(0, 0)
  assert.ok(low.min >= 25 && low.max <= 98)
  const highLoad = sleepQualityRange(100, 720, 5, 2)
  assert.ok(highLoad.min <= low.min)
  assert.ok(recommendedSleepMinutes(480, 0, 0) >= 480)
  assert.ok(recommendedSleepMinutes(480, 120, 80) >= 560)
})

test('a due manual sleep completes without oversleeping', () => {
  const ledger = emptySleepLedger(0)
  const started = startSleepEpisode(ledger, { kind: 'manual', baseNeedMinutes: 30, targetMinutes: 30, now: at('2026-10-31T13:00:00') })
  const finished = finishDueSleep(ledger, { now: at('2026-10-31T13:30:00') })
  assert.equal(finished.length, 1)
  assert.equal(started.episode.state, 'completed')
  assert.equal(started.episode.sleptSeconds, 30 * 60)
})

test('night and nap readiness use the original pressure gates', () => {
  assert.equal(nightSleepReady({ sleepPressure: null }), true)
  assert.equal(nightSleepReady({ sleepPressure: 70, workloadScore: 0, sleepDebtMinutes: 0 }), true)
  assert.equal(nightSleepReady({ sleepPressure: 40, workloadScore: 100, sleepDebtMinutes: 200 }), false)
  assert.equal(napReady({ hasSleepHistory: true, awakeMinutes: 300, sleepPressure: 40, workloadScore: 40, sleepDebtMinutes: 0 }, { localMinutes: 800 }), true)
  assert.equal(napReady({ hasSleepHistory: true, awakeMinutes: 299, sleepPressure: 80, workloadScore: 80, sleepDebtMinutes: 100 }, { localMinutes: 800 }), false)
})

test('an absent overnight window becomes one completed auto night', () => {
  const ledger = emptySleepLedger(0)
  const created = ensureAutoNights(ledger, {
    from: at('2026-10-30T20:00:00'), to: at('2026-10-31T08:00:00'),
  })
  assert.equal(created.length, 1)
  assert.equal(created[0].kind, 'night')
  assert.equal(created[0].sleptSeconds, 480 * 60)
  const short = emptySleepLedger(0)
  ensureAutoNights(short, { from: at('2026-10-31T00:30:00'), to: at('2026-10-31T08:00:00') })
  assert.equal(short.episodes.length, 1)
  assert.equal(short.episodes[0].sleptSeconds, 7 * 3600)
  assert.equal(sleepProfile(short).sleepDebtMinutes, 60)
  const manual = emptySleepLedger(0)
  manual.episodes.push(completedEpisode({ start: '2026-10-30T23:00:00', minutes: 480 }))
  assert.equal(ensureAutoNights(manual, { from: at('2026-10-30T20:00:00'), to: at('2026-10-31T08:00:00') }).length, 0)
})

test('the runtime settles an absent night and starts a presence sleep without instant recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-sleep-'))
  try {
    const auto = settleSleep(dir, {
      now: at('2026-10-31T08:00:00'), from: at('2026-10-30T20:00:00'),
      presenceMode: 'auto', openingDebt: 0, settings: FIXED,
    })
    assert.ok(auto)
    assert.equal(auto.episodes.length, 1)
    assert.equal(sleepMinutesBetween(auto, at('2026-10-30T20:00:00'), at('2026-10-31T08:00:00')), 480)
    assert.equal(sleepProfile(auto).sleepDebtMinutes, 0)

    const dir2 = mkdtempSync(join(tmpdir(), 'coach-sleep-'))
    const started = settleSleep(dir2, {
      now: at('2026-10-31T23:00:00'), from: at('2026-10-31T23:00:00'),
      presenceMode: 'sleep', presenceSince: '2026-10-31T23:00:00', openingDebt: 0, settings: FIXED,
    })
    assert.ok(started)
    assert.equal(started.episodes.length, 1)
    assert.equal(started.episodes[0].state, 'active')
    assert.equal(sleepMinutesBetween(started, at('2026-10-31T23:00:00'), at('2026-10-31T23:00:00')), 0)
    const interrupted = settleSleep(dir2, {
      now: at('2026-10-31T23:30:00'), from: at('2026-10-31T23:00:00'),
      presenceMode: 'sleep', presenceSince: '2026-10-31T23:00:00', userMessage: true,
      settings: FIXED,
    })
    assert.equal(interrupted.episodes[0].state, 'paused')
    assert.equal(interrupted.episodes[0].interruptions, 1)
    rmSync(dir2, { recursive: true, force: true })

    const dir3 = mkdtempSync(join(tmpdir(), 'coach-sleep-'))
    const legacy = settleSleep(dir3, {
      now: at('2026-10-31T23:00:00'), from: at('2026-10-31T23:00:00'),
      presenceMode: 'sleep', presenceSince: '', openingDebt: 0, settings: FIXED,
    })
    updateSleepLedger(dir3, (ledger) => {
      finishSleepEpisode(ledger, legacy.episodes[0].id, { now: at('2026-11-01T07:00:00') })
      return ledger
    })
    const afterFinish = settleSleep(dir3, {
      now: at('2026-11-01T07:00:00'), from: at('2026-10-31T23:00:00'),
      presenceMode: 'sleep', presenceSince: '', openingDebt: 0, settings: FIXED,
    })
    assert.equal(afterFinish.episodes.length, 1, 'a finished legacy sleep must not restart every turn')
    assert.equal(afterFinish.episodes[0].state, 'completed')
    rmSync(dir3, { recursive: true, force: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the runtime starts a night sleep by readiness, without a manual button', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-sleep-'))
  try {
    const ledger = settleSleep(dir, {
      now: at('2026-10-31T23:45:00'), from: at('2026-10-31T23:00:00'),
      presenceMode: 'auto', lastUserAt: at('2026-10-31T23:00:00').toISOString(),
      workloadScore: 0, openingDebt: 0, settings: FIXED,
    })
    assert.equal(ledger.episodes.length, 1)
    assert.equal(ledger.episodes[0].kind, 'night')
    assert.equal(ledger.episodes[0].state, 'active')
    assert.equal(ledger.episodes[0].startedAt, at('2026-10-31T23:30:00').toISOString())
    assert.equal(sleepMinutesBetween(ledger, at('2026-10-31T23:00:00'), at('2026-10-31T23:45:00')), 15)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('automatic night sleep survives idle ticks, finishes when due, and explicit wake still clears its marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-auto-sleep-'))
  try {
    const firstAt = at('2000-01-10T23:45:00')
    const first = settleSleep(dir, { now: firstAt, from: at('2000-01-10T23:00:00'),
      presenceMode: 'auto', lastUserAt: at('2000-01-10T23:00:00').toISOString(), settings: FIXED })
    const id = first.episodes[0].id
    const second = settleSleep(dir, { now: at('2000-01-10T23:46:00'), from: firstAt,
      presenceMode: 'auto', settings: FIXED })
    assert.equal(second.episodes.length, 1)
    assert.equal(second.episodes[0].id, id)
    assert.equal(second.episodes[0].state, 'active', 'an idle tick is not an explicit wake request')
    assert.equal(second.episodes[0].endedAt, '')

    let morning = settleSleep(dir, { now: new Date(second.episodes[0].dueAt), from: firstAt,
      presenceMode: 'auto', settings: FIXED })
    // Keep the existing one-time oversleep extension, if this night receives one.
    if (morning.episodes[0].state === 'active') {
      morning = settleSleep(dir, { now: new Date(morning.episodes[0].dueAt), from: firstAt,
        presenceMode: 'auto', settings: FIXED })
    }
    assert.equal(morning.episodes.length, 1)
    assert.equal(morning.episodes[0].id, id)
    assert.equal(morning.episodes[0].state, 'completed')
    assert.ok(Date.parse(morning.episodes[0].endedAt) >= Date.parse(second.episodes[0].dueAt))

    const since = at('2000-01-11T23:30:00')
    const explicit = settleSleep(dir, { now: since, from: since, presenceMode: 'sleep',
      presenceSince: since.toISOString(), settings: FIXED })
    const explicitId = explicit.episodes.at(-1).id
    const awake = settleSleep(dir, { now: at('2000-01-11T23:40:00'), from: since,
      presenceMode: 'auto', autoSleep: false, settings: FIXED })
    assert.equal(awake.presenceStarted, '')
    assert.equal(awake.episodes.find(episode => episode.id === explicitId).state, 'completed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the ledger persists through the locked update path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-sleep-'))
  try {
    const result = updateSleepLedger(dir, (ledger) => {
      startSleepEpisode(ledger, { kind: 'night', baseNeedMinutes: 480, targetMinutes: 480, now: at('2026-10-30T23:00:00') })
      return ledger
    }, { openingDebt: 0 })
    assert.equal(result.ok, true)
    const loaded = loadSleepLedger(dir)
    assert.equal(loaded.episodes.length, 1)
    assert.equal(loaded.episodes[0].state, 'active')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SLEEP_SETTINGS, loadSleepSettings, saveSleepSettings, sanitizeSleepSettings,
  parseClock, parseRestWindows, localParts, localMinutes, restWindowActive,
  bedtimeForDate, bedtimeAround, nextBedtime, sleepWindow,
} from '../lib/sleep-settings.js'

const at = (value) => new Date(value)

test('the clock parser accepts the shapes the panel and env use', () => {
  assert.deepEqual(parseClock('07:05'), { hour: 7, minute: 5, minutes: 425, text: '07:05' })
  assert.equal(parseClock('7:5').text, '07:05')
  assert.equal(parseClock('25:99').text, '01:59')
  assert.equal(parseClock('nonsense').text, '23:30')
  assert.deepEqual(parseRestWindows('23:00-08:30,12:20-13:40'), [[1380, 1950], [740, 820]])
})

test('sanitize clamps every numeric option and keeps unknown modes on probability', () => {
  const value = sanitizeSleepSettings({
    time: '22:00', minutes: 9999, windowMinutes: -1, variationMinutes: 999,
    napMinutes: 0, restProbability: 500, restThreshold: 0, restMode: 'telepathy',
    restGraceMinutes: -3, restBacklog: 999, maxDeferSeconds: 0,
  })
  assert.equal(value.time, '22:00')
  assert.equal(value.minutes, 1440)
  assert.equal(value.windowMinutes, 0)
  assert.equal(value.variationMinutes, 120)
  assert.equal(value.napMinutes, 5)
  assert.equal(value.restProbability, 100)
  assert.equal(value.restThreshold, 1)
  assert.equal(value.restMode, 'probability')
  assert.equal(value.restGraceMinutes, 0)
  assert.equal(value.restBacklog, 32)
  assert.equal(value.maxDeferSeconds, 5)
})

test('the file is the base and env only overrides the keys it names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-settings-'))
  try {
    assert.equal(loadSleepSettings(dir).time, DEFAULT_SLEEP_SETTINGS.time)
    writeFileSync(join(dir, 'sleep-settings.json'),
      JSON.stringify({ time: '22:15', minutes: 420, restGate: false }), 'utf8')
    const stored = loadSleepSettings(dir, {})
    assert.equal(stored.time, '22:15')
    assert.equal(stored.minutes, 420)
    assert.equal(stored.restGate, false)
    assert.equal(stored.napMinutes, DEFAULT_SLEEP_SETTINGS.napMinutes)
    const env = loadSleepSettings(dir, { COACH_SLEEP_TIME: '01:00', COACH_REST_GATE: '1' })
    assert.equal(env.time, '01:00')
    assert.equal(env.minutes, 420)
    assert.equal(env.restGate, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('save is atomic and round-trips through the sanitizer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-settings-'))
  try {
    assert.equal(saveSleepSettings(dir, { time: '21:45', minutes: 400 }), true)
    const loaded = loadSleepSettings(dir, {})
    assert.equal(loaded.time, '21:45')
    assert.equal(loaded.minutes, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('timezone changes the local wall clock without changing the instant', () => {
  const instant = at('2026-11-01T16:30:00Z')
  assert.deepEqual(localParts(instant, 'UTC'), { year: 2026, month: 11, day: 1, hour: 16, minute: 30 })
  assert.deepEqual(localParts(instant, 'Asia/Shanghai'), { year: 2026, month: 11, day: 2, hour: 0, minute: 30 })
  assert.equal(localMinutes(instant, 'Asia/Shanghai'), 30)
})

test('the rest window follows the configured timezone', () => {
  const settings = sanitizeSleepSettings({ restWindows: '22:00-06:00', timezone: 'Asia/Shanghai' })
  assert.equal(restWindowActive(settings, at('2026-11-01T15:00:00Z')), true)  // 23:00 Shanghai
  assert.equal(restWindowActive(settings, at('2026-11-01T04:00:00Z')), false) // 12:00 Shanghai
  assert.equal(restWindowActive(sanitizeSleepSettings({ restWindows: '' }), at('2026-11-01T04:00:00Z')), true)
})

test('the per-day jitter is deterministic and bounded', () => {
  const settings = sanitizeSleepSettings({ time: '23:30', variationMinutes: 30 })
  const day = { year: 2026, month: 11, day: 1, hour: 12, minute: 0 }
  const first = bedtimeForDate(day, settings)
  const second = bedtimeForDate(day, settings)
  assert.equal(first.getTime(), second.getTime())
  const base = new Date(2026, 10, 1, 23, 30)
  assert.ok(Math.abs(first.getTime() - base.getTime()) <= 30 * 60000,
    `bedtime drifted ${(first - base) / 60000} min`)
  const next = bedtimeForDate({ ...day, day: 2 }, settings)
  assert.ok(Math.abs(next.getTime() - first.getTime() - 86400000) <= 61 * 60000)
})

test('bedtimeAround picks the most recent bedtime and nextBedtime the next one', () => {
  const settings = sanitizeSleepSettings({ time: '23:30', variationMinutes: 0 })
  const after = bedtimeAround(at('2026-11-02T01:00:00'), settings)
  assert.equal(after.getDate(), 1)
  assert.equal(after.getHours(), 23)
  const before = bedtimeAround(at('2026-11-01T20:00:00'), settings)
  assert.equal(before.getDate(), 31)
  assert.equal(before.getMonth(), 9)
  const next = nextBedtime(at('2026-11-01T20:00:00'), settings)
  assert.equal(next.getDate(), 1)
  assert.equal(next.getHours(), 23)
  assert.equal(nextBedtime(at('2026-11-02T00:30:00'), settings).getDate(), 2)
  const window = sleepWindow(at('2026-11-02T01:00:00'), settings)
  assert.equal(window.start.getDate(), 1)
  assert.equal(window.end.getDate(), 2)
  assert.equal(window.end.getHours(), 7)
})

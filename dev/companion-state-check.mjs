import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyCompanionState, loadCompanionState, saveCompanionState,
  timeLine, modeLine, advanceLife, lifeLine,
} from '../lib/companion-state.js'
import { emptyBody, advanceBody, bodyLines, applySocialEmotion } from '../lib/body-state.js'
import { emptySleepLedger, startSleepEpisode, finishSleepEpisode } from '../lib/sleep-ledger.js'

const NOW = new Date('2026-10-30T12:00:00')

test('missing or corrupt companion state falls back to empty without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-companion-'))
  try {
    assert.deepEqual(loadCompanionState(dir, NOW), emptyCompanionState(NOW))
    writeFileSync(join(dir, 'companion-state.json'), '{not json', 'utf8')
    assert.deepEqual(loadCompanionState(dir, NOW), emptyCompanionState(NOW))
    writeFileSync(join(dir, 'companion-state.json'), JSON.stringify({ version: 99, lastUserAt: 'x' }), 'utf8')
    assert.deepEqual(loadCompanionState(dir, NOW), emptyCompanionState(NOW))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('companion state round-trips the last user time and body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-companion-'))
  try {
    const body = emptyBody(NOW)
    body.energy = 42
    saveCompanionState(dir, { lastUserAt: '2026-10-30T11:00:00.000Z', body })
    const loaded = loadCompanionState(dir, NOW)
    assert.equal(loaded.lastUserAt, '2026-10-30T11:00:00.000Z')
    assert.equal(loaded.body.energy, 42)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('time line separates first meeting, minutes, hours and days', () => {
  assert.match(timeLine({ lastUserAt: '' }, NOW), /上次对话时间未知/)
  assert.match(timeLine({ lastUserAt: '2026-10-30T11:50:00' }, NOW), /10 分钟前/)
  assert.match(timeLine({ lastUserAt: '2026-10-30T09:00:00' }, NOW), /3 小时前/)
  const days = timeLine({ lastUserAt: '2026-10-28T09:00:00' }, NOW)
  assert.match(days, /2 天前/)
  assert.match(days, /上次 2026-10-28 09:00/)
})

test('native request time leaves only the last interaction gap in companion context', () => {
  const text = timeLine({ lastUserAt: '2026-10-30T11:50:00' }, NOW, { includeClock: false })
  assert.match(text, /10 分钟前/)
  assert.doesNotMatch(text, /时间：|2026-10-30 12:00/)
  assert.match(timeLine({ lastUserAt: '' }, NOW, { includeClock: false }), /上次对话时间未知/)
})

test('auto life reflects recent conversation instead of a day-long idle chore', () => {
  const now = new Date('2026-11-04T12:00:00+08:00')
  const chatting = advanceLife(emptyCompanionState(now).life, {
    now, presence: { mode: 'normal' }, person: { library: [] }, lastUserAt: now.toISOString(),
  })
  assert.equal(chatting.kind, 'chatting')
  assert.match(chatting.description, /聊天/)
  assert.equal(chatting.source, 'conversation')
  const idle = advanceLife(chatting, { now: new Date(now.getTime() + 15 * 60000), person: { library: [] } })
  assert.equal(idle.kind, 'idle')
  assert.equal(idle.source, 'ambient')
  const sameSlot = advanceLife(idle, { now: new Date(now.getTime() + 16 * 60000), person: { library: [] } })
  assert.equal(sameSlot.description, idle.description)
  const later = advanceLife(idle, { now: new Date(now.getTime() + 2 * 3600000), person: { library: [] } })
  assert.notEqual(later.description, idle.description)
  assert.match(later.description, /想/)
})

test('body state advances with sleep, checks and absence', () => {
  const passed = advanceBody(emptyBody(NOW), {
    now: NOW,
    progress: { nodes: { A: { checks: [{ date: '2026-10-30', outcome: 'passed' }] } } },
    presence: { mode: 'normal' },
  })
  assert.ok(passed.joy > 6)
  assert.match(bodyLines(passed)[0], /精力/)

  const failed = advanceBody(emptyBody(NOW), {
    now: NOW,
    progress: { nodes: { A: { checks: [{ date: '2026-10-30', outcome: 'failed' }] } } },
    presence: { mode: 'normal' },
  })
  assert.ok(failed.sorrow > 1)

  const slept = advanceBody(emptyBody(NOW), { now: new Date('2026-10-31T08:00:00'), presence: { mode: 'sleep' } })
  assert.ok(slept.energy >= 70)
  assert.ok(slept.fatigue <= 20)

  const absent = advanceBody(emptyBody(NOW), { now: NOW, lastUserAt: '2026-10-25T12:00:00', presence: { mode: 'normal' } })
  assert.ok(absent.joy > 6)
})

test('an overnight absence recovers body instead of draining the whole night as awake', () => {
  const body = emptyBody(new Date('2026-10-30T23:00:00'))
  body.energy = 20
  body.fatigue = 80
  body.sleepDebt = 400
  const morning = new Date('2026-10-31T08:00:00')
  const next = advanceBody(body, {
    now: morning, lastUserAt: '2026-10-30T23:00:00',
    presence: { mode: 'normal' }, presenceExplicit: false,
  })
  assert.ok(next.energy > 20, `energy should recover, got ${next.energy}`)
  assert.ok(next.fatigue < 80, `fatigue should fall, got ${next.fatigue}`)
  assert.ok(next.sleepDebt < 400, `an 8h night against a 7h base should repay debt, got ${next.sleepDebt}`)

  const again = advanceBody(next, {
    now: morning, lastUserAt: '2026-10-30T23:00:00',
    presence: { mode: 'normal' }, presenceExplicit: false,
  })
  assert.equal(again.energy, next.energy)
  assert.equal(again.fatigue, next.fatigue)
  assert.equal(again.sleepDebt, next.sleepDebt, 'the same absence must not be counted twice')
})

test('a daytime absence drains but does not manufacture sleep debt', () => {
  const body = emptyBody(new Date('2026-10-31T08:00:00'))
  body.energy = 80
  body.fatigue = 20
  body.sleepDebt = 300
  const noon = advanceBody(body, {
    now: new Date('2026-10-31T12:00:00'), lastUserAt: '2026-10-31T08:00:00',
    presence: { mode: 'normal' }, presenceExplicit: false,
  })
  assert.ok(noon.energy < 80)
  assert.ok(noon.fatigue > 20)
  assert.equal(noon.sleepDebt, 300)
})

test('a short night adds sleep debt while still restoring some energy', () => {
  const body = emptyBody(new Date('2026-10-30T23:00:00'))
  body.energy = 20
  body.fatigue = 80
  body.sleepDebt = 300
  const short = advanceBody(body, {
    now: new Date('2026-10-31T05:00:00'), lastUserAt: '2026-10-30T23:00:00',
    presence: { mode: 'normal' }, presenceExplicit: false,
  })
  assert.ok(short.sleepDebt > 300, `a 5.5h night should add debt, got ${short.sleepDebt}`)
  assert.ok(short.fatigue < 80)
  assert.ok(short.energy > 20)
})

test('a completed sleep episode drives energy and fatigue without per-turn debt', () => {
  const ledger = emptySleepLedger(0)
  const started = startSleepEpisode(ledger, {
    kind: 'night', baseNeedMinutes: 480, targetMinutes: 480,
    now: new Date('2026-10-30T23:00:00'),
  })
  finishSleepEpisode(ledger, started.episode.id, { now: new Date('2026-10-31T07:00:00') })
  const body = emptyBody(new Date('2026-10-30T23:00:00'))
  body.energy = 20
  body.fatigue = 80
  const next = advanceBody(body, {
    now: new Date('2026-10-31T07:00:00'), sleepLedger: ledger, workloadScore: 0,
  })
  assert.ok(next.energy > 20, `energy should recover, got ${next.energy}`)
  assert.ok(next.fatigue < 80, `fatigue should fall, got ${next.fatigue}`)
  assert.equal(next.sleepDebt, 0)
  assert.equal(next.sleepPressure, 0)
})

test('an active sleep episode recovers only the time actually slept', () => {
  const ledger = emptySleepLedger(0)
  startSleepEpisode(ledger, {
    kind: 'night', baseNeedMinutes: 480, targetMinutes: 480,
    now: new Date('2026-10-30T23:00:00'),
  })
  const body = emptyBody(new Date('2026-10-30T23:00:00'))
  body.energy = 20
  body.fatigue = 80
  const same = advanceBody(body, { now: new Date('2026-10-30T23:00:00'), sleepLedger: ledger })
  assert.equal(same.energy, 20)
  assert.equal(same.fatigue, 80)
  const halfHour = advanceBody(body, { now: new Date('2026-10-30T23:30:00'), sleepLedger: ledger })
  assert.ok(halfHour.energy > 20 && halfHour.energy < 40, `got ${halfHour.energy}`)
  assert.ok(halfHour.fatigue < 80)
})

test('mode line names the teaching state', () => {
  assert.match(modeLine({ lesson: { node: '区间 DP' } }, null, NOW), /执教态.*区间 DP/)
  assert.match(modeLine({ pending: { node: '二分' } }, null, NOW), /执教态.*二分/)
  assert.match(modeLine({}, { from: '09:00', to: '13:00', weekdays: [NOW.getDay()] }, NOW), /执教态.*上课时段/)
  assert.match(modeLine({}, { from: '14:00', to: '16:00', weekdays: [NOW.getDay()] }, NOW), /日常态/)
  assert.match(modeLine({}, null, NOW), /日常态/)
})

test('her own life follows presence and the book, not invented events', () => {
  const reading = advanceLife(emptyCompanionState(NOW).life, {
    now: NOW,
    presence: { mode: 'normal' },
    person: { library: [{ title: '算法导论', state: 'reading', progress: 0.35 }] },
  })
  assert.equal(reading.kind, 'reading')
  assert.match(reading.description, /算法导论/)
  assert.match(reading.description, /35%/)
  const line = lifeLine(reading, NOW)
  assert.match(line, /你现在/)
  assert.match(line, /不要每轮报/)

  const asleep = advanceLife(reading, { now: NOW, presence: { mode: 'sleep' }, person: { library: [] } })
  assert.equal(asleep.kind, 'resting')
  assert.match(asleep.description, /补觉/)

  const tomorrow = advanceLife(asleep, {
    now: new Date('2026-10-31T09:00:00'),
    presence: { mode: 'normal' },
    person: { library: [] },
  })
  assert.equal(tomorrow.day, '2026-10-31')
  assert.equal(tomorrow.kind, 'idle')
  assert.notEqual(tomorrow.startedAt, asleep.startedAt)
})

test('life round-trips in companion state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-companion-'))
  try {
    const life = advanceLife(emptyCompanionState(NOW).life, {
      now: NOW,
      presence: { mode: 'normal' },
      person: { library: [{ title: '海', state: 'reading', progress: 0.1 }] },
    })
    saveCompanionState(dir, { lastUserAt: '', body: emptyBody(NOW), life })
    const loaded = loadCompanionState(dir, NOW)
    assert.equal(loaded.life.kind, 'reading')
    assert.match(loaded.life.description, /海/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('social messages move the mood axes without becoming facts', () => {
  const body = emptyBody(NOW)
  const before = body.joy
  applySocialEmotion(body, '你好厉害，谢谢', NOW)
  assert.ok(body.joy > before)
  const annoyed = emptyBody(NOW)
  applySocialEmotion(annoyed, '笨蛋，讨厌', NOW)
  assert.ok(annoyed.anger > 1)
  const sorry = emptyBody(NOW)
  sorry.anger = 6
  applySocialEmotion(sorry, '对不起，我错了', NOW)
  assert.ok(sorry.anger < 6)
  const late = emptyBody(new Date('2026-10-30T03:00:00'))
  applySocialEmotion(late, '还醒着', new Date('2026-10-30T03:00:00'))
  assert.ok(late.fear > 1)
})

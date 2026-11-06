import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordUserMessage, loadInteractionLog, recentMessages, TEXT_RETENTION_MS,
} from '../lib/interaction-log.js'
import {
  loadPatrol, patrolCatchUpDay, recordPatrol, normalizePatrol, KEEP_DAYS,
} from '../lib/state-patrol.js'
import { applyModelMood, normalizeMoodAxes, moodAxesOf } from '../lib/state-maintenance.js'
import { createLifeTick } from '../lib/life-tick.js'
import { loadCompanionState, saveCompanionState } from '../lib/companion-state.js'
import { loadJournalArchive, journalFor } from '../lib/journal.js'
import { buildGrowthNote, addGrowthNote, acceptGrowthNote, loadGrowth, growthLine } from '../lib/growth.js'
import { loadTaskQueue } from '../lib/task-queue.js'
import { backgroundModelsEnabled, emptyState, normalizeState, saveState } from '../lib/proactive-state.js'
import { emptyPerson, savePerson } from '../lib/person.js'
import { settleSleep } from '../lib/sleep-runtime.js'
import { currentSleep, loadSleepLedger } from '../lib/sleep-ledger.js'

const at = (value) => new Date(value)
const at2355 = at('2026-11-02T23:55:00')

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'life-tick-check-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const fakeLlm = (text) => ({
  stream: () => (async function* () {
    yield { type: 'text-delta', text }
  })(),
})

test('idle ticks preserve explicit sleep and nap until their presence expires', async () => {
  for (const mode of ['sleep', 'nap']) {
    const t = tmp()
    try {
      const begin = at('2026-11-02T20:00:00')
      const person = emptyPerson(begin)
      person.presence = { mode, since: begin.toISOString(), until: at('2026-11-02T20:10:00').toISOString(), reason: '' }
      savePerson(t.dir, person)
      saveCompanionState(t.dir, { body: { updatedAt: begin.toISOString() } })
      settleSleep(t.dir, { now: begin, from: begin, presenceMode: mode, presenceSince: begin.toISOString(), autoSleep: false })
      const id = currentSleep(loadSleepLedger(t.dir)).id
      const tick = createLifeTick({ dataDir: t.dir, allowModel: () => false })
      const asleep = await tick(at('2026-11-02T20:01:00'))
      assert.equal(currentSleep(loadSleepLedger(t.dir))?.id, id)
      assert.equal(asleep.presence, mode)
      const awake = await tick(at('2026-11-02T20:11:00'))
      assert.equal(currentSleep(loadSleepLedger(t.dir)), null)
      assert.equal(awake.presence, 'normal')
    } finally { t.done() }
  }
})

test('legacy manual presence without an episode uses its full future deadline', async () => {
  for (const [mode, minutes, inspectAfter] of [['nap', 120, 31], ['sleep', 600, 481]]) {
    const t = tmp()
    try {
      const begin = at('2026-11-02T20:00:00')
      const until = new Date(begin.getTime() + minutes * 60000)
      const person = emptyPerson(begin)
      person.presence = { mode, since: begin.toISOString(), until: until.toISOString(), reason: '旧状态尚无睡眠片段' }
      savePerson(t.dir, person)
      saveCompanionState(t.dir, { body: { updatedAt: begin.toISOString() } })
      assert.equal(currentSleep(loadSleepLedger(t.dir)), null)
      const tick = createLifeTick({ dataDir: t.dir, allowModel: () => false })
      await tick(begin)
      const episode = currentSleep(loadSleepLedger(t.dir))
      assert.equal(episode.targetMinutes, minutes)
      await tick(new Date(begin.getTime() + inspectAfter * 60000))
      assert.equal(currentSleep(loadSleepLedger(t.dir))?.id, episode.id, 'the default nap/night length cannot end a longer manual deadline')
      await tick(new Date(until.getTime() + 60000))
      assert.equal(loadSleepLedger(t.dir).episodes.find(x => x.id === episode.id).state, 'completed')
    } finally { t.done() }
  }
})

test('manual recovery keeps defaults for absent or invalid deadlines and leaves existing episodes unchanged', () => {
  for (const presenceUntil of ['', 'not-a-date']) {
    const t = tmp()
    try {
      const begin = at('2026-11-02T20:00:00')
      const options = { now: begin, from: begin, presenceMode: 'nap', presenceSince: begin.toISOString(),
        presenceUntil, autoSleep: false, settings: { minutes: 480, napMinutes: 25 } }
      settleSleep(t.dir, options)
      const episode = currentSleep(loadSleepLedger(t.dir))
      assert.equal(episode.targetMinutes, 25)
      settleSleep(t.dir, { ...options, now: new Date(begin.getTime() + 60000),
        presenceUntil: new Date(begin.getTime() + 120 * 60000).toISOString() })
      assert.equal(currentSleep(loadSleepLedger(t.dir))?.id, episode.id)
      assert.equal(currentSleep(loadSleepLedger(t.dir))?.targetMinutes, 25, 'an existing episode is not reconfigured by the recovery path')
    } finally { t.done() }
  }
})

test('background model authorization defaults off and honors explicit environment overrides', () => {
  const t = tmp()
  try {
    assert.equal(emptyState().settings.backgroundLlm, false)
    assert.equal(normalizeState({ settings: { arbiter: true } }).settings.backgroundLlm, false)
    assert.equal(backgroundModelsEnabled(t.dir, {}), false)
    assert.equal(backgroundModelsEnabled(t.dir, { COACH_BACKGROUND_LLM: '1' }), true)
    const state = emptyState()
    state.settings.backgroundLlm = true
    assert.equal(saveState(t.dir, state), true)
    assert.equal(backgroundModelsEnabled(t.dir, {}), true)
    assert.equal(backgroundModelsEnabled(t.dir, { COACH_BACKGROUND_LLM: '0' }), false)
    assert.deepEqual(loadTaskQueue(t.dir).tasks, [])
  } finally { t.done() }
})

test('the interaction log keeps three days of text and the newest slice wins', () => {
  const t = tmp()
  try {
    recordUserMessage(t.dir, at('2026-11-01T10:00:00'), '第一天的消息')
    recordUserMessage(t.dir, at('2026-11-02T10:00:00'), '今天有点累')
    recordUserMessage(t.dir, at('2026-11-02T10:01:00'), '还有一道题没写完')
    recordUserMessage(t.dir, at('2026-10-20T10:00:00'), '太旧了')
    const log = loadInteractionLog(t.dir, at('2026-11-02T12:00:00'))
    const recent = recentMessages(log, { now: at('2026-11-02T12:00:00') })
    assert.deepEqual(recent.map((item) => item.text), ['第一天的消息', '今天有点累', '还有一道题没写完'])
    const limited = recentMessages(log, { now: at('2026-11-02T12:00:00'), limit: 1 })
    assert.deepEqual(limited.map((item) => item.text), ['还有一道题没写完'])
    assert.deepEqual(recentMessages(log, { now: at('2026-11-02T12:00:00'), maxChars: 5 }).map((item) => item.text), ['还有一道题没写完'])
    assert.ok(TEXT_RETENTION_MS === 72 * 3600 * 1000)
  } finally { t.done() }
})

test('the 04:00 patrol fires once per day and keeps 30 days', () => {
  const t = tmp()
  try {
    assert.equal(patrolCatchUpDay(loadPatrol(t.dir), at('2026-11-02T03:00:00')), '2026-11-01')
    assert.equal(patrolCatchUpDay(loadPatrol(t.dir), at('2026-11-02T04:00:00')), '2026-11-02')
    assert.equal(patrolCatchUpDay(loadPatrol(t.dir), at('2026-11-02T05:00:00')), '2026-11-02')
    const recorded = recordPatrol(t.dir, {
      now: at('2026-11-02T05:00:00'), body: { energy: 55, sleepDebt: 90 }, roleState: { mood: '平静' }, journal: { text: 'x' },
    })
    assert.equal(recorded.ok, true)
    assert.equal(recorded.day, '2026-11-02')
    assert.equal(patrolCatchUpDay(loadPatrol(t.dir), at('2026-11-02T06:00:00')), '')
    assert.equal(recordPatrol(t.dir, { now: at('2026-11-02T06:00:00') }).ok, false)

    const many = normalizePatrol({
      version: 1,
      entries: Array.from({ length: 40 }, (_, index) => ({
        day: new Date(Date.parse('2026-01-01T00:00:00') + index * 86400000).toISOString().slice(0, 10),
      })),
    })
    assert.equal(many.entries.length, KEEP_DAYS)
  } finally { t.done() }
})

test('model mood moves at most three steps per axis', () => {
  assert.deepEqual(normalizeMoodAxes({ joy: 8, anger: 0, sorrow: 3.5, fear: 4 }), { joy: 8, fear: 4 })
  const body = { joy: 5, anger: 2, sorrow: 2, fear: 2 }
  assert.deepEqual(applyModelMood(body, { joy: 10, anger: 1 }), { joy: 8, anger: 1 })
  assert.deepEqual(moodAxesOf(body), { joy: 8, anger: 1, sorrow: 2, fear: 2 })
  assert.equal(applyModelMood(body, { joy: 8 }), null, 'no change is not an update')
})

test('the background tick advances the day without any user turn', async () => {
  const t = tmp()
  try {
    saveCompanionState(t.dir, { lastUserAt: '', body: {}, roleState: {}, life: {}, journal: {} })
    const tick = createLifeTick({ dataDir: t.dir, now: () => at2355 })
    const result = await tick(at2355)
    assert.equal(result.ok, true)
    const saved = loadCompanionState(t.dir, at2355)
    assert.ok(saved.body.updatedAt)
    assert.ok(saved.life.description)
  } finally { t.done() }
})

test('the tick writes the 23:50 journal with the model, once', async () => {
  const t = tmp()
  try {
    saveCompanionState(t.dir, { lastUserAt: '', body: { updatedAt: at2355.toISOString(), energyCheckedAt: at2355.toISOString() },
      roleState: {}, life: {}, journal: {} })
    writeFileSync(join(t.dir, 'sleep-ledger.json'), JSON.stringify({ version: 1, openingDebt: 0, episodes: [{
      id: 'night-before-journal', kind: 'night', state: 'completed',
      startedAt: at('2026-11-01T23:30:00').toISOString(),
      endedAt: at('2026-11-02T07:30:00').toISOString(),
      updatedAt: at('2026-11-02T07:30:00').toISOString(), sleptSeconds: 28800,
    }] }))
    recordUserMessage(t.dir, at('2026-11-02T20:00:00'), '今天做了三道题')
    const tick = createLifeTick({
      allowModel: () => true,
      dataDir: t.dir,
      getRoute: () => ({ provider: 'p', model: 'm' }),
      getLlm: () => fakeLlm('{"body":"今天做了三道题，最后一道还是卡住了。窗外很安静。","recall":"他说的那句再想想","afterglow":"明天再试"}'),
      now: () => at2355,
    })
    const first = await tick(at2355)
    assert.ok(first.wrote.includes('journal'))
    assert.ok(first.wrote.includes('dream'), 'the completed night also produces a dream')
    const entry = journalFor(loadJournalArchive(t.dir), { day: '2026-11-02', kind: 'journal' })
    assert.equal(entry.source, 'model')
    assert.match(entry.body, /三道题/)

    const second = await tick(at2355)
    assert.deepEqual(second.wrote, [])
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02', kind: 'journal' }).revision, 1)
  } finally { t.done() }
})

test('a failed journal run backs off on disk, so a restart does not hammer the model', async () => {
  const t = tmp()
  try {
    saveCompanionState(t.dir, { lastUserAt: '', body: { updatedAt: at2355.toISOString(), energyCheckedAt: at2355.toISOString() },
      roleState: {}, life: {}, journal: {} })
    let calls = 0
    const sources = []
    const broken = { stream: request => (async function* () {
      calls += 1
      sources.push(String(request.system ?? '').split('\n')[0])
      yield { type: 'text-delta', text: '这行不是 JSON' }
    })() }
    const first = createLifeTick({
      allowModel: () => true,
      dataDir: t.dir, getRoute: () => ({ provider: 'p', model: 'm' }), getLlm: () => broken, now: () => at2355,
    })
    await first(at2355)
    const firstCalls = calls
    assert.ok(firstCalls >= 1)
    const queued = loadTaskQueue(t.dir).tasks.find((task) => task.kind === 'journal.write')
    assert.equal(queued.state, 'queued')
    assert.match(queued.lastError, /没有产出/)
    assert.equal(queued.attempts, 1)

    // 「重启」= 新的 lifeTick 实例；内存里的退避没了，盘上的还在。
    const restarted = createLifeTick({
      allowModel: () => true,
      dataDir: t.dir, getRoute: () => ({ provider: 'p', model: 'm' }), getLlm: () => broken,
      now: () => at('2026-11-02T23:55:30'),
    })
    await restarted(at('2026-11-02T23:55:30'))
    assert.equal(calls, firstCalls, `退避窗口内不重打模型；来源：${JSON.stringify(sources)}`)

    const later = createLifeTick({
      allowModel: () => true,
      dataDir: t.dir, getRoute: () => ({ provider: 'p', model: 'm' }), getLlm: () => broken,
      now: () => at('2026-11-02T23:56:30'),
    })
    await later(at('2026-11-02T23:56:30'))
    assert.ok(calls > firstCalls, '退避到期后重试')
    assert.equal(loadTaskQueue(t.dir).tasks.find((task) => task.kind === 'journal.write').attempts, 2)
  } finally { t.done() }
})

test('a completed daytime dream does not block the same evenings journal', async () => {
  const t = tmp()
  const noon = at('2026-11-04T12:10:00')
  const evening = at('2026-11-04T23:55:00')
  try {
    saveCompanionState(t.dir, { lastUserAt: '', body: { updatedAt: noon.toISOString(), energyCheckedAt: noon.toISOString() },
      roleState: {}, life: {}, journal: {} })
    writeFileSync(join(t.dir, 'sleep-ledger.json'), JSON.stringify({ version: 1, openingDebt: 0, episodes: [{
      id: 'night-before-journal', kind: 'night', state: 'completed',
      startedAt: at('2026-11-03T23:30:00').toISOString(),
      endedAt: at('2026-11-04T07:30:00').toISOString(),
      updatedAt: at('2026-11-04T07:30:00').toISOString(), sleptSeconds: 28800,
    }] }))
    const tick = createLifeTick({ dataDir: t.dir, allowModel: () => true,
      getRoute: () => ({ provider: 'fixture', model: 'fixture' }),
      getLlm: () => fakeLlm('{"body":"今天一起看了窗外的树影，我在本子上画了很长一串箭头。"}'),
    })
    assert.ok((await tick(noon)).wrote.includes('dream'))
    assert.ok((await tick(evening)).wrote.includes('journal'))
    assert.ok(journalFor(loadJournalArchive(t.dir), { day: '2026-11-04', kind: 'journal' }))
  } finally { t.done() }
})

test('a growth receipt is pending until someone accepts it', () => {
  const t = tmp()
  try {
    const note = buildGrowthNote({
      day: '2026-11-01',
      activities: [
        { id: 'r1', kind: 'reading', state: 'completed', minutes: 25, createdAt: '2026-11-01T10:00:00' },
        { id: 'j1', kind: 'journal', state: 'completed', createdAt: '2026-11-01T23:50:00' },
      ],
      journal: { text: '写了点东西。' },
      sleepLedger: { episodes: [{ kind: 'night', state: 'completed', endedAt: '2026-11-01T07:00:00', sleptSeconds: 450 * 60 }] },
    })
    assert.match(note.text, /读了 25 分钟/)
    assert.match(note.text, /睡了 7 小时 30 分/, 'the growth note reads the recorded sleep field')
    assert.equal(note.status, 'pending')
    assert.equal(addGrowthNote(t.dir, note, { now: at2355 }).ok, true)
    assert.equal(addGrowthNote(t.dir, note, { now: at2355 }).ok, false, 'one note per day')
    assert.match(growthLine(loadGrowth(t.dir), at2355), /还没确认/)
    assert.equal(acceptGrowthNote(t.dir, { day: '2026-11-01', now: at2355 }).ok, true)
    assert.equal(growthLine(loadGrowth(t.dir), at2355), '')
    assert.equal(acceptGrowthNote(t.dir, { day: '2026-11-01', now: at2355 }).ok, false)
    assert.equal(buildGrowthNote({ day: '2026-11-02', activities: [] }), null)
  } finally { t.done() }
})

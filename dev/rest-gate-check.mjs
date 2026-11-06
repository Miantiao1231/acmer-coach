import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boundaryScore, restGateDecision, evaluateRestGate, loadRestGateState, saveRestGateState,
  awakeGraceOf, normalizeRestGateState, emptyRestGateState,
} from '../lib/rest-gate.js'
import { DEFAULT_SLEEP_SETTINGS, sanitizeSleepSettings } from '../lib/sleep-settings.js'

const NOW = new Date('2026-11-02T02:00:00')
const decide = (options) => restGateDecision({ now: NOW, ...options })
const SLEEP = { active: true, id: 'sleep-1', dueAt: '2026-11-02T07:30:00' }
const SETTINGS = sanitizeSleepSettings({
  ...DEFAULT_SLEEP_SETTINGS, restWindows: '23:00-08:30', restProbability: 18,
  restThreshold: 65, restGraceMinutes: 30, restBacklog: 4, maxDeferSeconds: 60,
})

test('boundary text is scored before any probability draw', () => {
  assert.equal(boundaryScore('先别回我，继续睡').score, -100)
  assert.equal(boundaryScore('别说话了，安静点').score, -100)
  assert.equal(boundaryScore('醒醒，快回我').score, 100)
  assert.equal(boundaryScore('你其实没睡吧').score, 100)
  assert.equal(boundaryScore('救命，难受').score, 100)
  assert.equal(boundaryScore('睡了吗').score, 72)
  assert.equal(boundaryScore('今天题做完了').score, 0)
})

test('a non-sleeping role replies and a disabled gate never holds', () => {
  assert.equal(decide({ text: '在吗', sleep: null, settings: SETTINGS }).action, 'reply')
  assert.equal(decide({ text: '在吗', sleep: SLEEP, settings: { ...SETTINGS, restGate: false } }).reason, 'disabled')
  assert.equal(decide({ text: '在吗', sleep: SLEEP, settings: { ...SETTINGS, restWindows: '10:00-11:00' } }).reason,
    'outside_active_window')
  assert.equal(decide({
    text: '在吗', sleep: { ...SLEEP, dueAt: '2026-11-02T01:00:00' }, settings: SETTINGS,
  }).reason, 'sleep_timer_due')
})

test('the probability mode is deterministic when the draw is injected', () => {
  const hit = decide({ text: '今天题做完了', sleep: SLEEP, settings: SETTINGS, probabilityRoll: () => 0.1 })
  assert.equal(hit.action, 'reply')
  assert.equal(hit.reason, 'probability_hit')
  const miss = decide({ text: '今天题做完了', sleep: SLEEP, settings: SETTINGS, probabilityRoll: () => 0.9 })
  assert.equal(miss.action, 'hold')
  assert.equal(miss.reason, 'probability_miss')
  assert.equal(miss.deferMs, 60 * 1000)
  const short = decide({
    text: '今天题做完了', sleep: { ...SLEEP, dueAt: '2026-11-02T02:00:20' }, settings: SETTINGS, probabilityRoll: () => 0.9,
  })
  assert.equal(short.deferMs, 20 * 1000)
})

test('an awake-grace receipt answers without a second draw', () => {
  let draws = 0
  const grace = { active: true, sleep: 'sleep-1' }
  const decision = decide({
    text: '在吗', sleep: SLEEP, settings: SETTINGS, grace,
    probabilityRoll: () => { draws += 1; return 0.99 },
  })
  assert.equal(decision.action, 'reply')
  assert.equal(decision.reason, 'awake_grace')
  assert.equal(draws, 0)
})

test('llm mode fails closed when the judge is missing or out of range', () => {
  const settings = { ...SETTINGS, restMode: 'llm' }
  const missing = decide({ text: '今天题做完了', sleep: SLEEP, settings, judge: null })
  assert.equal(missing.action, 'hold')
  assert.equal(missing.reason, 'judge_unavailable')
  const bad = decide({ text: '今天题做完了', sleep: SLEEP, settings, judge: () => 150 })
  assert.equal(bad.reason, 'judge_unavailable')
  const wake = decide({ text: '今天题做完了', sleep: SLEEP, settings, judge: () => 90 })
  assert.equal(wake.action, 'reply')
  assert.equal(wake.reason, 'judge_wake')
  const sleep = decide({ text: '今天题做完了', sleep: SLEEP, settings, judge: () => 10 })
  assert.equal(sleep.action, 'hold')
  assert.equal(sleep.reason, 'judge_keeps_sleeping')
})

test('a hold writes a bounded backlog that the next real reply consumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-gate-'))
  try {
    for (let i = 0; i < 6; i += 1) {
      const result = evaluateRestGate(dir, {
        text: `消息 ${i}`, now: new Date(NOW.getTime() + i * 120000), settings: SETTINGS,
        sleep: SLEEP, probabilityRoll: () => 0.99,
      })
      assert.equal(result.decision.action, 'hold')
      assert.equal(result.backlog.length, 0, 'never surface the backlog while she is asleep')
    }
    const state = loadRestGateState(dir)
    assert.equal(state.backlog.length, 4, 'bounded by restBacklog')
    assert.match(state.backlog.at(-1).text, /消息 5/)

    const reply = evaluateRestGate(dir, {
      text: '醒醒', now: new Date(NOW.getTime() + 15 * 60000), settings: SETTINGS, sleep: SLEEP,
    })
    assert.equal(reply.decision.action, 'reply')
    assert.equal(reply.backlog.length, 4)
    assert.equal(loadRestGateState(dir).backlog.length, 0)
    const grace = awakeGraceOf(loadRestGateState(dir), new Date(NOW.getTime() + 16 * 60000), 'sleep-1')
    assert.equal(grace.active, true)
    assert.equal(loadRestGateState(dir).awakeSleep, 'sleep-1')
    assert.equal(awakeGraceOf(loadRestGateState(dir), new Date(NOW.getTime() + 50 * 60000), 'sleep-1'), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a damaged gate document reads as never slept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-gate-'))
  try {
    writeFileSync(join(dir, 'rest-gate.json'), '{broken', 'utf8')
    assert.deepEqual(loadRestGateState(dir), emptyRestGateState())
    assert.equal(saveRestGateState(dir, {
      version: 1, awakeUntil: '2026-11-02T02:20:00', awakeSleep: 'sleep-1',
      last: { event: 'e', deferMs: 5, reason: 'hold' }, backlog: [{ at: 'bad' }, { at: NOW.toISOString(), text: ' 你好 ' }],
    }), true)
    const loaded = loadRestGateState(dir)
    assert.equal(loaded.backlog.length, 1)
    assert.equal(loaded.backlog[0].text, '你好')
    const normalized = normalizeRestGateState({ version: 99, backlog: 'nope' })
    assert.deepEqual(normalized, emptyRestGateState())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

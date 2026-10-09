import test from 'node:test'
import assert from 'node:assert/strict'
import { collectEvidence } from '../lib/curriculum-evidence.js'

const date = '2026-10-01'
const check = (outcome = 'failed', extra = {}) => ({
  date, outcome, score: outcome === 'passed' ? 100 : 40, maxScore: 100,
  passScore: 80, minutes: 45, limit: 60, ...extra,
})
const diagnosis = (extra = {}) => ({
  date, at: `${date}T12:00:00+08:00`, problem: '1234A', category: '不会',
  summary: '遗漏边界状态，空区间访问导致答案错误',
  evidence: [{ quote: 'answer += dp[left][right];', kind: 'wrong', why: '没有过滤空区间，读取了无效状态' }],
  ...extra,
})
const practice = (extra = {}) => ({ date, problemId: '1234A', solved: false,
  independent: true, minutes: 40, ...extra })
const progress = (nodeRecord, node = '区间 DP') => ({ nodes: { [node]: nodeRecord } })
const rowsFor = (record) => collectEvidence(progress(record))
const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
    : value
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('catalog only contains real record entries, with a stable typed public shape', () => {
  assert.deepEqual(collectEvidence({}), [])
  assert.deepEqual(collectEvidence({ rating: 1600, cursor: '区间 DP',
    nodes: { '区间 DP': { status: 'studying', at: date, verifiedAt: 1900 } },
    pendingActions: { '区间 DP': { kind: '练习', at: date } } }), [])
  const rows = rowsFor({ checks: [check()], diagnoses: [diagnosis()], passes: [practice()] })
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'eventId', 'source', 'node', 'date', 'signal', 'summary', 'fingerprint'].sort())
    for (const key of Object.keys(row)) assert.equal(typeof row[key], 'string', key)
    assert.ok(row.id && row.eventId && row.fingerprint && row.summary)
    assert.equal(row.node, '区间 DP'); assert.equal(row.date, date)
    assert.ok(['check', 'diagnosis', 'practice', 'schedule'].includes(row.source))
    assert.ok(['gap', 'baseline'].includes(row.signal))
  }
})

test('failed and over-time checks are gaps; passed checks only establish a baseline', () => {
  const rows = rowsFor({ checks: [check('failed'), check('overTime', { minutes: 90 }), check('passed')] })
  assert.deepEqual(rows.map((row) => row.signal), ['gap', 'gap', 'baseline'])
  assert.deepEqual(rows.map((row) => row.source), ['check', 'check', 'check'])
})

test('abandoned checks and narrative diagnoses without code evidence never become gaps', () => {
  assert.deepEqual(rowsFor({ checks: [check('abandoned', { reason: '今天临时没时间' })],
    diagnoses: [diagnosis({ evidence: [] }), diagnosis({ evidence: undefined }),
      { date, category: '不会', summary: 'rating 不够高所以 DP 不熟' }] }), [])
})

test('diagnosis evidence requires a meaningful quote, valid kind, and explanation', () => {
  for (const invalid of [
    { quote: '', kind: 'wrong', why: '边界遗漏' },
    { quote: '   ', kind: 'wrong', why: '边界遗漏' },
    { quote: 'answer += dp[left][right];', kind: '', why: '边界遗漏' },
    { quote: 'answer += dp[left][right];', kind: 'guessed', why: '边界遗漏' },
    { quote: 'answer += dp[left][right];', kind: 'wrong', why: '' },
    { quote: 'answer += dp[left][right];', kind: 'wrong', why: '   ' },
    null, '代码大概有问题',
  ]) assert.deepEqual(rowsFor({ diagnoses: [diagnosis({ evidence: [invalid] })] }), [])
  for (const kind of ['wrong', 'missing']) {
    const rows = rowsFor({ diagnoses: [diagnosis({ evidence: [{ quote: 'answer += dp[left][right];', kind, why: '没有考虑空区间状态' }] })] })
    assert.equal(rows.length, 1); assert.equal(rows[0].signal, 'gap')
  }
})

test('practice establishes baseline only when solved and independent are both explicitly true', () => {
  const values = [[true, true], [true, false], [false, true], [false, false]]
  const rows = rowsFor({ passes: values.map(([solved, independent], index) => practice({
    solved, independent, problemId: `${index}A`,
  })) })
  assert.deepEqual(rows.map((row) => row.signal), ['baseline', 'gap', 'gap', 'gap'])
  assert.ok(rows.every((row) => row.source === 'practice'))
})

test('invalid containers, non-record values, missing dates and illegal records are skipped', () => {
  for (const value of [null, undefined, false, 42, 'not progress', []]) assert.deepEqual(collectEvidence(value), [])
  assert.deepEqual(collectEvidence({ nodes: null }, { days: null }), [])
  assert.deepEqual(collectEvidence({ nodes: { A: null, B: false, C: 'not a record' } }), [])
  assert.deepEqual(rowsFor({ checks: {}, diagnoses: true, passes: 3 }), [])
  assert.deepEqual(rowsFor({ checks: [null, 42, {}, check('failed', { date: '' }),
    check('unknown'), check('failed', { date: '2026-02-30' })],
    diagnoses: [null, {}, diagnosis({ date: undefined })],
    passes: [null, {}, practice({ date: '' }), practice({ solved: 'true' }), practice({ independent: null })] }), [])
  assert.deepEqual(collectEvidence({}, { days: { [date]: { actual: [null, {},
    { node: '', actualMin: 30, solved: false, independent: false },
    { node: 'A', solved: false, independent: false },
  ] }, 'not-a-date': { actual: [{ node: 'A', actualMin: 30, solved: false, independent: false }] } } }), [])
})

test('invalid numeric facts and circular values cannot produce usable evidence references', () => {
  for (const amount of [-1, NaN, Infinity, '40']) {
    assert.deepEqual(rowsFor({ checks: [check('failed', { minutes: amount })] }), [])
    assert.deepEqual(rowsFor({ passes: [practice({ minutes: amount })] }), [])
  }
  assert.deepEqual(rowsFor({ passes: [practice({ minutes: 0 })] }), [])
  const circular = check(); circular.extra = circular
  assert.deepEqual(rowsFor({ checks: [circular] }), [])
})

test('a careless-error diagnosis needs a concrete wrong-code quote', () => {
  const rows = rowsFor({ diagnoses: [diagnosis({ category: '不认真', evidence: [{
    quote: 'answer += dp[left][right];', kind: 'missing', why: '附近缺少边界检查',
  }] })] })
  assert.deepEqual(rows, [])
  assert.equal(rowsFor({ diagnoses: [diagnosis({ category: '不认真' })] }).length, 1)
})

test('canonical object field order does not change record ids or fingerprints', () => {
  const input = progress({ checks: [check()], diagnoses: [diagnosis()], passes: [practice()] })
  assert.deepEqual(collectEvidence(input), collectEvidence(reverseKeys(input)))
})

test('appending an identical check remains a distinct event without renaming prior refs', () => {
  const item = check()
  const one = rowsFor({ checks: [item] })
  const two = rowsFor({ checks: [item, structuredClone(item)] })
  assert.equal(one.length, 1); assert.equal(two.length, 2)
  assert.equal(two[0].id, one[0].id)
  assert.notEqual(two[0].id, two[1].id)
  assert.equal(two[0].fingerprint, two[1].fingerprint)
  assert.equal(two[0].eventId, one[0].eventId)
  assert.notEqual(two[0].eventId, two[1].eventId)
})

test('editing an existing check or diagnosis changes its ref but does not create a new event', () => {
  const before = rowsFor({ checks: [check()], diagnoses: [diagnosis()] })
  const after = rowsFor({ checks: [check('passed')], diagnoses: [diagnosis({ summary: '复查后确认是空区间状态初始化错误' })] })
  assert.equal(before.length, 2); assert.equal(after.length, 2)
  for (let index = 0; index < before.length; index++) {
    assert.notEqual(after[index].id, before[index].id)
    assert.notEqual(after[index].fingerprint, before[index].fingerprint)
    assert.equal(after[index].eventId, before[index].eventId)
  }
})

test('editing only a practice note invalidates the ref while preserving the training event', () => {
  const before = rowsFor({ passes: [practice({ note: '自己尝试了边界样例' })] })
  const after = rowsFor({ passes: [practice({ note: '补充记录：边界样例仍然没有通过' })] })
  assert.equal(before.length, 1); assert.equal(after.length, 1)
  assert.notEqual(after[0].id, before[0].id)
  assert.notEqual(after[0].fingerprint, before[0].fingerprint)
  assert.equal(after[0].eventId, before[0].eventId)
})

test('overwriting a practice fact invalidates its old evidence ref', () => {
  const before = rowsFor({ passes: [practice()] })
  const after = rowsFor({ passes: [practice({ solved: true, independent: true, minutes: 25 })] })
  assert.equal(before.length, 1); assert.equal(after.length, 1)
  assert.notEqual(after[0].id, before[0].id)
  assert.notEqual(after[0].fingerprint, before[0].fingerprint)
  assert.ok(!after.some((row) => row.id === before[0].id))
  assert.equal(after[0].signal, 'baseline')
  assert.equal(after[0].eventId, before[0].eventId)
})

test('mirrored SCHEDULE actual and PROGRESS practice are deduplicated in favor of practice', () => {
  const fact = practice({ solved: true, independent: false, minutes: 55, note: '提示后完成' })
  const input = progress({ passes: [fact] })
  const schedule = { days: { [date]: { actual: [{ node: '区间 DP', problemId: fact.problemId,
    actualMin: fact.minutes, solved: fact.solved, independent: fact.independent, note: fact.note }] } } }
  const practiceOnly = collectEvidence(input)
  const both = collectEvidence(input, schedule)
  assert.deepEqual(both, practiceOnly)
  assert.equal(both[0].source, 'practice')
  const scheduleOnly = collectEvidence({}, schedule)
  assert.equal(scheduleOnly.length, 1); assert.equal(scheduleOnly[0].source, 'schedule')
  assert.equal(scheduleOnly[0].signal, 'gap')
  assert.equal(scheduleOnly[0].eventId, practiceOnly[0].eventId)
})

test('distinct same-day practice problems and distinct nodes do not collapse', () => {
  const input = { nodes: { A: { passes: [practice({ problemId: '1A' }), practice({ problemId: '1B' })] },
    B: { passes: [practice({ problemId: '1A' })] } } }
  const rows = collectEvidence(input)
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map((row) => row.id)).size, 3)
  assert.equal(new Set(rows.map((row) => row.eventId)).size, 3)
})

test('evidence collection leaves deeply frozen source records untouched', () => {
  const input = deepFreeze(progress({ checks: [check()], diagnoses: [diagnosis()], passes: [practice()] }))
  const schedule = deepFreeze({ days: { [date]: { actual: [{ node: 'A', actualMin: 25,
    solved: true, independent: true, problemId: '9A' }] } } })
  const snapshot = JSON.stringify({ input, schedule })
  assert.equal(collectEvidence(input, schedule).length, 4)
  assert.equal(JSON.stringify({ input, schedule }), snapshot)
})

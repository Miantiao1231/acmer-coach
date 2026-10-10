import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStrategyStore } from '../lib/strategy.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'acmer-coach-strategy-'))
  const store = createStrategyStore({
    dataDir: dir,
    competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml'),
  })
  return { dir, store }
}

test('target is explicit and revision protected', () => {
  const { dir, store } = fixture()
  try {
    assert.equal(store.target('read').revision, 0)
    const saved = store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      teamMode: 'team', weeklyHours: 35,
      constraints: { weekday: 5, saturday: 10, sunday: 0 },
      priorities: [{ id: 'contest-reading', weight: 100, reason: '区域赛前要先稳定读题' }],
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.revision, 1)
    assert.equal(store.target('set', { expectedRevision: 0 }).ok, false)
    assert.equal(existsSync(join(dir, 'TARGET.yaml')), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('VP import is idempotent and postmortem drives focus', () => {
  const { dir, store } = fixture()
  try {
    store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      teamMode: 'team', weeklyHours: 35,
      priorities: [
        { id: 'contest-reading', weight: 80 },
        { id: 'dp-modeling', weight: 70 },
      ],
    })
    const event = { eventId: 'vp-1', contest: '训练 VP', date: '2026-10-10', durationMinutes: 300,
      problems: [{ problemId: 'A', status: 'AC', solveMinutes: 20, competencies: ['contest-reading'] }] }
    assert.equal(store.vpImport([event]).total, 1)
    assert.equal(store.vpImport([event]).total, 1)
    assert.equal(store.postmortem({ eventId: 'vp-1', competencies: ['contest-reading'], rootCauses: ['扫题不完整'], nextActions: ['固定首轮扫描'] }).ok, true)
    const focus = store.focus()
    assert.equal(focus.ok, true)
    assert.equal(focus.focus[0].id, 'contest-reading')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scope refuses unknown knowledge instead of inventing applicability', () => {
  const { dir, store } = fixture()
  try {
    const v = store.scope('不存在的知识点')
    assert.equal(v.ok, false)
    assert.equal(v.found, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('first-use focus has a complete refusal shape and targets reject unknown cards', () => {
  const { dir, store } = fixture()
  try {
    const empty = store.focus()
    assert.deepEqual(Object.keys(empty).sort(), ['contest', 'deadline', 'evidenceEvents', 'focus', 'ok', 'postmortems', 'postponed', 'reject'])
    const rejected = store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [{ id: 'invented-card', weight: 100 }],
    })
    assert.equal(rejected.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('target route rejects an unrelated progress node but allows a course-bound route', () => {
  const { dir, store } = fixture()
  try {
    store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [{ id: 'dp-modeling', weight: 100 }],
    })
    const unrelated = store.route('树状数组', { purpose: 'progress', courseBound: false })
    assert.equal(unrelated.ok, false)
    assert.match(unrelated.reject, /dp-modeling|当前重点/)
    const courseBound = store.route('树状数组', { purpose: 'progress', courseBound: true })
    assert.equal(courseBound.ok, true)
    assert.equal(courseBound.courseBound, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('VP problem competencies count as evidence before a postmortem exists', () => {
  const { dir, store } = fixture()
  try {
    store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [
        { id: 'dp-modeling', weight: 80 },
        { id: 'contest-reading', weight: 70 },
      ],
    })
    store.vpImport([{ eventId: 'vp-2', contest: '训练 VP', date: '2026-10-10', durationMinutes: 300,
      problems: [{ problemId: 'B', status: 'WA', competencies: ['dp-modeling'] }] }])
    const focus = store.focus()
    assert.equal(focus.focus[0].id, 'dp-modeling')
    assert.equal(focus.focus[0].evidenceCount, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('strategy exposes stable competency evidence for curriculum gates', () => {
  const { dir, store } = fixture()
  try {
    store.vpImport([{ eventId: 'vp-evidence', contest: '训练 VP', date: '2026-10-10', durationMinutes: 300,
      problems: [{ problemId: 'C', status: 'WA', competencies: ['contest-decision'] }] }])
    const result = store.evidence()
    assert.equal(result.ok, true)
    assert.equal(result.evidence[0].id, 'vp:vp-evidence:C:contest-decision')
    assert.equal(result.evidence[0].signal, 'gap')
    assert.equal(result.evidence[0].competency, 'contest-decision')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('invalid VP input is rejected without bumping revision', () => {
  const { dir, store } = fixture()
  try {
    const result = store.vpImport([{ eventId: '', contest: '坏记录', date: '2026-10-10', problems: [] }])
    assert.equal(result.ok, false)
    assert.equal(result.revision, 0)
    assert.equal(result.imported, 0)
    assert.equal(result.invalid.length, 1)
    assert.equal(existsSync(join(dir, 'VP_EVENTS.yaml')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('invalid target priorities are rejected instead of silently dropped', () => {
  const { dir, store } = fixture()
  try {
    const result = store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [{ id: 'dp-modeling', weight: 'bad' }],
    })
    assert.equal(result.ok, false)
    assert.match(result.reject, /priorit|weight|能力/)
    assert.equal(result.revision, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('corrupt stored strategy data returns a structured refusal', () => {
  const { dir, store } = fixture()
  try {
    writeFileSync(join(dir, 'TARGET.yaml'), 'version: 1\nrevision: 4\npriorities: bad\n', 'utf8')
    const result = store.target('read')
    assert.equal(result.ok, false)
    assert.match(result.reject, /TARGET.yaml/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

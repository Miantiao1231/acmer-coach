import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createStrategyStore } from '../lib/strategy.js'

function fixture() {
  const dir = mkdtempSync(join(process.cwd(), '.strategy-test-'))
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

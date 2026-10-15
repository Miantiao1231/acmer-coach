import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTrainingLog } from '../lib/training-log.js'

const byId = new Map([
  ['dp', { id: 'dp', name: '动态规划' }],
  ['graph', { id: 'graph', name: '图论' }],
])

function fixture() {
  return buildTrainingLog({
    today: '2026-10-15', days: 5, byId,
    schedule: { days: {
      '2026-10-12': { planned: [{ from: '09:00', to: '10:00', kind: 'cycle', node: 'dp' }], actual: [{ node: 'dp', actualMin: 72, solved: true, independent: true, problemId: 'A' }] },
      '2026-10-14': { planned: [{ from: '14:00', to: '15:30', kind: 'exam', node: 'graph' }] },
    } },
    progress: { cursor: 'dp', updated: '2026-10-15', nodes: {
      dp: {
        status: 'studying', at: '2026-10-12',
        lessonNotes: [{ at: '2026-10-12T12:00:00+08:00', summary: '讲了状态定义', nextStep: '做一道转移题' }],
        passes: [{ date: '2026-10-12', solved: true, independent: true, problemId: 'A' }],
        checks: [{ date: '2026-10-13', outcome: 'failed' }],
        diagnoses: [{ date: '2026-10-13', category: '边界', summary: '漏了空集' }],
      },
    } },
    curriculum: {
      exists: true, status: 'active', goal: '区域赛金牌', phaseId: 'p1', phaseTitle: '基础补强', outcome: '能独立完成核心题', exitCriteria: '两次跨日通过',
      current: 0, focusNodes: ['dp'], phaseCompetencies: [], missingVerified: ['graph'], missingFreshEvidence: [], remainingEstimatedHours: 12, estimatedWeeks: 1,
      roadmap: [
        { id: 'p1', title: '基础补强', kind: 'training', outcome: '能独立完成核心题', exitCriteria: '两次跨日通过', estimatedHours: 12, nodes: ['dp'], competencies: [], active: true },
        { id: 'p2', title: '比赛整合', kind: 'training', outcome: '稳定完成比赛', exitCriteria: '完成模拟赛', estimatedHours: 8, nodes: ['graph'], competencies: [], active: false },
      ], history: [], exitCheckResults: [], budgetWarnings: [], needsReview: false,
    },
  })
}

test('daily log joins planned, actual and teaching evidence without inventing missed work', () => {
  const log = fixture()
  assert.equal(log.days.length, 5)
  const day = log.days.find((item) => item.date === '2026-10-12')
  assert.equal(day.plannedMinutes, 60)
  assert.equal(day.actualMinutes, 72)
  assert.equal(day.state, 'logged')
  assert.ok(day.events.some((event) => event.type === 'lesson'))
  assert.ok(day.events.some((event) => event.type === 'practice'))
  const plannedOnly = log.days.find((item) => item.date === '2026-10-14')
  assert.equal(plannedOnly.state, 'planned-only')
  assert.match(plannedOnly.events.find((event) => event.type === 'planned').detail, /90/)
})

test('phase rail marks completed/current/upcoming and keeps current evidence gaps', () => {
  const log = fixture()
  assert.deepEqual(log.curriculum.phases.map((phase) => phase.status), ['current', 'upcoming'])
  assert.deepEqual(log.curriculum.current.missingVerified, ['图论'])
  assert.equal(log.curriculum.current.remainingEstimatedHours, 12)
})

test('date range is bounded and deterministic', () => {
  const log = buildTrainingLog({ today: '2026-10-15', from: '2026-10-01', to: '2026-10-31', days: 999 })
  assert.equal(log.from, '2026-10-01')
  assert.equal(log.to, '2026-10-31')
  assert.equal(log.days.length, 31)
})

test('passes are a safe fallback when an old or partial log has no schedule actual', () => {
  const log = buildTrainingLog({ today: '2026-10-15', days: 2, byId, schedule: { days: {} }, progress: {
    nodes: { dp: { passes: [{ date: '2026-10-14', solved: true, independent: true, minutes: 38 }] } },
  } })
  const day = log.days.find((item) => item.date === '2026-10-14')
  assert.equal(day.state, 'logged')
  assert.equal(day.actualMinutes, 38)
  assert.equal(log.totals.loggedDays, 1)
})

test('future plans stay planned-only only after the real training date', () => {
  const log = buildTrainingLog({ today: '2026-10-15', from: '2026-10-15', to: '2026-10-17', byId, schedule: {
    days: { '2026-10-17': { planned: [{ from: '09:00', to: '10:00', kind: 'cycle', node: 'dp' }] } },
  } })
  assert.equal(log.days.find((item) => item.date === '2026-10-17').state, 'active')
})

test('a mirrored pass without a problem id does not duplicate a scheduled actual', () => {
  const log = buildTrainingLog({ today: '2026-10-15', days: 1, byId,
    schedule: { days: { '2026-10-15': { actual: [{ node: 'dp', actualMin: 40, solved: true, problemId: 'A' }] } } },
    progress: { nodes: { dp: { passes: [{ date: '2026-10-15', solved: true, minutes: 40 }] } } },
  })
  assert.equal(log.days[0].events.filter((event) => event.type === 'practice').length, 1)
})

test('untimed actual work is distinguishable from a day with no actual work', () => {
  const log = buildTrainingLog({ today: '2026-10-15', days: 1, byId,
    schedule: { days: { '2026-10-15': { actual: [{ node: 'dp', solved: true }] } } },
  })
  const day = log.days[0]
  assert.equal(day.actualMinutes, 0)
  assert.equal(day.actualEntries, 1)
  assert.equal(day.untimedActualEntries, 1)
})


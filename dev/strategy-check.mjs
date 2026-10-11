import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStrategyStore } from '../lib/strategy.js'

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acmer-coach-strategy-'))
  const store = createStrategyStore({
    dataDir: dir,
    competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml'),
    ...options,
  })
  return { dir, store }
}

test('invalid target constraints and VP numbers are rejected before changing ledgers', () => {
  const { dir, store } = fixture()
  try {
    const target = { expectedRevision: 0, contest: 'VP', date: '2026-10-17', result: '稳定', weeklyHours: 25, priorities: [{ id: 'graph-modeling', weight: 10 }] }
    for (const constraints of [[], null, 'bad']) assert.equal(store.target('set', { ...target, constraints }).ok, false)
    assert.equal(store.target().ok, true)
    assert.equal(store.target().revision, 0)
    const event = { eventId: 'bad-numbers', contest: 'VP', date: '2026-10-10', problems: [{ problemId: 'A', status: 'AC' }] }
    for (const [key, value] of [['solveMinutes', 'Infinity'], ['readMinutes', -1], ['attempts', 1.5], ['independent', 'yes'], ['occurredAt', 'yesterday']]) {
      assert.equal(store.vpImport([{ ...event, problems: [{ ...event.problems[0], [key]: value }] }]).ok, false, key)
    }
    assert.equal(store.vpImport([{ ...event, durationMinutes: 'Infinity' }]).ok, false)
    assert.equal(store.loadVp().revision, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('local training day includes morning VP evidence and computes the local deadline', () => {
  const { dir, store } = fixture({ now: () => new Date(2026, 9, 11, 0, 30) })
  try {
    store.target('set', { expectedRevision: 0, contest: 'VP', date: '2026-10-17', result: '稳定', weeklyHours: 25, priorities: [{ id: 'graph-modeling', weight: 10 }] })
    store.vpImport([{ eventId: 'today', contest: 'VP', date: '2026-10-11', problems: [{ problemId: 'A', status: 'AC', independent: true, competencies: ['graph-modeling'] }] }])
    assert.equal(store.focus().focus[0].baselineCount, 1)
    assert.equal(store.focus().daysRemaining, 6)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('event measurements are explicit finite facts and sync preserves coach annotations', () => {
  const { dir, store } = fixture()
  try {
    const event = { eventId: 'measured', contest: 'VP', date: '2026-10-10', problems: [{ problemId: 'A', status: 'AC' }] }
    const measurements = [{ competency: 'contest-reading', metric: 'missed-reading', value: 0, passed: true, independent: true }]
    assert.equal(store.vpImport([{ ...event, measurements }]).ok, true)
    const metric = store.evidence().evidence.find(fact => fact.metric === 'missed-reading')
    assert.ok(metric)
    assert.equal(metric.signal, 'baseline')
    assert.equal(metric.value, 0)
    const invalid = store.vpImport([{ ...event, measurements: [{ ...measurements[0], value: 'Infinity' }] }])
    assert.equal(invalid.ok, false)
    store.vpImport([{ ...event, measurements, problems: [{ ...event.problems[0], independent: true, competencies: ['graph-modeling'] }] }])
    const before = store.evidence().evidence.map(fact => fact.id)
    store.vpImport([event], { source: 'sync' })
    assert.deepEqual(store.evidence().evidence.map(fact => fact.id), before)
    store.vpImport([{ ...event, problems: [{ problemId: 'A', status: 'WA' }] }], { source: 'sync' })
    assert.equal(store.evidence().evidence.find(fact => fact.competency === 'graph-modeling').signal, 'observation')
    assert.deepEqual(store.loadVp().events[0].measurements, measurements)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('successful VP observations never become repair priority or reported problems', () => {
  const { dir, store } = fixture({ now: () => new Date('2026-10-11T12:00:00Z') })
  try {
    store.target('set', { expectedRevision: 0, contest: '训练目标', date: '2026-10-17', result: '稳定发挥', weeklyHours: 25,
      priorities: [{ id: 'dp-modeling', weight: 10 }, { id: 'graph-modeling', weight: 10 }] })
    store.vpImport(Array.from({ length: 5 }, (_, i) => ({ eventId: `dp-success-${i}`, contest: 'VP', date: '2026-10-10',
      problems: [{ problemId: 'A', status: 'AC', independent: true, competencies: ['dp-modeling'] }] })))
    const dp = store.focus().focus.find(item => item.id === 'dp-modeling')
    assert.equal(dp.gapCount, 0)
    assert.equal(dp.baselineCount, 5)
    assert.doesNotMatch(dp.whyNow, /5 次相关问题|优先修复/)
    assert.equal(dp.score, 10)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hypotheses stay observations and confirmation requires cited facts from the same VP', () => {
  const { dir, store } = fixture({ now: () => new Date('2026-10-11T12:00:00Z') })
  try {
    store.vpImport([{ eventId: 'reason-1', contest: 'VP', date: '2026-10-10',
      problems: [{ problemId: 'B', status: 'WA', competencies: ['graph-modeling'] }] }])
    const fact = store.evidence().evidence[0]
    assert.equal(fact.signal, 'observation')
    const hypothesis = { competency: 'graph-modeling', status: 'hypothesis', cause: '可能把边建反了，需要查代码确认', evidenceRefs: [fact.id] }
    assert.equal(store.postmortem({ eventId: 'reason-1', findings: [hypothesis] }).ok, true)
    assert.equal(store.evidence().evidence.some(entry => entry.signal === 'gap'), false)
    const forged = store.postmortem({ eventId: 'reason-1', findings: [{ ...hypothesis, status: 'confirmed', evidenceRefs: ['fabricated'] }] })
    assert.equal(forged.ok, false)
    assert.equal(store.postmortem({ eventId: 'reason-1', findings: [{ ...hypothesis, status: 'confirmed' }] }).ok, true)
    const gap = store.evidence().evidence.find(entry => entry.signal === 'gap')
    assert.ok(gap)
    assert.match(gap.summary, /边建反/)
    store.vpImport([{ eventId: 'reason-1', contest: 'VP', date: '2026-10-10',
      problems: [{ problemId: 'B', status: 'AC', independent: true, competencies: ['graph-modeling'] }] }])
    assert.equal(store.evidence().evidence.some(entry => entry.signal === 'gap'), false, 'changed facts invalidate old confirmation')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('synced unlabelled facts can be cited without fabricating an algorithm tag', () => {
  const { dir, store } = fixture()
  try {
    store.vpImport([{ eventId: 'unlabelled', contest: 'VP', date: '2026-10-10', problems: [{ problemId: 'A', status: 'WA' }] }])
    const fact = store.evidence().evidence[0]
    assert.ok(fact)
    assert.equal(fact.competency, '')
    assert.equal(store.postmortem({ eventId: 'unlabelled', findings: [{ competency: 'implementation-stability', status: 'confirmed',
      cause: '检查代码后确认多组数据没有清空数组', evidenceRefs: [fact.id] }] }).ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('confirmed gaps are counted once per recent event and old edits do not refresh them', () => {
  const { dir, store } = fixture({ now: () => new Date('2026-10-11T12:00:00Z') })
  try {
    store.target('set', { expectedRevision: 0, contest: '目标', date: '2026-10-17', result: '稳定发挥', weeklyHours: 25,
      priorities: [{ id: 'graph-modeling', weight: 10 }, { id: 'dp-modeling', weight: 10 }] })
    for (const [id, day] of [['recent', '2026-10-10'], ['old', '2026-08-01']]) {
      store.vpImport([{ eventId: id, contest: 'VP', date: day, problems: ['A', 'B'].map(problemId => ({ problemId, status: 'WA', competencies: ['graph-modeling'] })) }])
      const refs = store.evidence().evidence.filter(entry => entry.eventId === id && entry.source === 'vp').map(entry => entry.id)
      assert.equal(store.postmortem({ eventId: id, date: '2026-10-11', findings: [{ competency: 'graph-modeling', status: 'confirmed',
        cause: '核对题面与代码确认有向关系建反', evidenceRefs: refs }] }).ok, true)
    }
    const graph = store.focus().focus[0]
    assert.equal(graph.id, 'graph-modeling')
    assert.equal(graph.gapCount, 1)
    assert.equal(graph.score, 20)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('target profiles and exact node scopes retain sources without claiming an exam syllabus', () => {
  const { dir, store } = fixture()
  try {
    writeFileSync(join(dir, 'NODE_SCOPES.yaml'), 'version: 1\nnodes:\n  - id: 最短路\n    title: 最短路识别\n    sources: [{title: 原始资料, url: "https://oi-wiki.org/graph/shortest-path/"}]\n    appliesTo: [路径代价]\n    notFor: [负权直接套Dijkstra]\n')
    writeFileSync(join(dir, 'CONTEST_PROFILES.yaml'), 'version: 1\nprofiles:\n  - id: regional-sample\n    title: 区域赛样本\n    status: provisional\n    scope: 样本范围\n    sources: []\n    competencyIds: [graph-modeling]\n    selectionGuidance: [先诊断]\n    limitations: [不是西安预测]\n')
    const scoped = createStrategyStore({ dataDir: dir, competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml'),
      nodeScopesPath: join(dir, 'NODE_SCOPES.yaml'), contestProfilesPath: join(dir, 'CONTEST_PROFILES.yaml') })
    assert.equal(scoped.scope('最短路').id, '最短路')
    assert.equal(scoped.scope('最短路').sources.length, 1)
    const saved = scoped.target('set', { expectedRevision: 0, contest: '西安', date: '2026-10-17', result: '稳定发挥', weeklyHours: 25,
      profileId: 'regional-sample', priorities: [{ id: 'graph-modeling', weight: 10 }] })
    assert.equal(saved.ok, true)
    assert.equal(saved.profileId, 'regional-sample')
    assert.equal(scoped.target('profiles').availableProfiles[0].status, 'provisional')
    assert.match(scoped.focus().profile.limitations[0], /不是西安预测/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

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
    assert.deepEqual(Object.keys(empty).sort(), ['contest', 'daysRemaining', 'deadline', 'evidenceEvents', 'focus', 'ok', 'postmortems', 'postponed', 'profile', 'reject'])
    const rejected = store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [{ id: 'invented-card', weight: 100 }],
    })
    assert.equal(rejected.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('target route allows a fourth-ranked target capability without imposing the focus ranking', () => {
  const { dir, store } = fixture()
  try {
    assert.equal(store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [
        { id: 'contest-reading', weight: 100 },
        { id: 'contest-decision', weight: 90 },
        { id: 'dp-modeling', weight: 80 },
        { id: 'graph-modeling', weight: 10 },
      ],
    }).ok, true)
    assert.deepEqual(store.focus().postponed, ['graph-modeling'])
    const route = store.route('最短路', { purpose: 'progress', courseBound: false })
    assert.equal(route.ok, true)
    assert.equal(route.targetAligned, true)
    assert.deepEqual(route.competencyIds, ['graph-modeling'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('target route reports alignment without rejecting the coach choice', () => {
  const { dir, store } = fixture()
  try {
    assert.equal(store.route('树状数组').targetAligned, false, 'no target is not an alignment claim')
    store.target('set', {
      expectedRevision: 0, contest: '西安区域赛', date: '2026-10-18', result: '区域赛金牌',
      weeklyHours: 35, priorities: [{ id: 'dp-modeling', weight: 100 }],
    })
    for (const options of [
      { purpose: 'progress', courseBound: false },
      { purpose: 'progress', courseBound: true },
      { purpose: 'remediation', courseBound: false },
      { purpose: 'review', courseBound: false },
    ]) {
      const unrelated = store.route('树状数组', options)
      assert.equal(unrelated.ok, true)
      assert.equal(unrelated.reject, '')
      assert.equal(unrelated.targetAligned, false)
      assert.deepEqual(unrelated.competencyIds, [])
      assert.equal(unrelated.courseBound, options.courseBound)
    }
    const alignedReview = store.route('动态规划基础', { purpose: 'review', courseBound: true })
    assert.equal(alignedReview.targetAligned, true)
    assert.deepEqual(alignedReview.competencyIds, ['dp-modeling'])
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
    assert.match(result.evidence[0].id, /^vp:vp-evidence:C:contest-decision:[a-f0-9]{64}$/)
    assert.equal(result.evidence[0].signal, 'observation')
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

test('personal target stays shared while VP events stay account-scoped', () => {
  const personal = mkdtempSync(join(tmpdir(), 'acmer-coach-personal-'))
  const accountA = mkdtempSync(join(tmpdir(), 'acmer-coach-vp-a-'))
  const accountB = mkdtempSync(join(tmpdir(), 'acmer-coach-vp-b-'))
  const options = {
    competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml'),
  }
  try {
    const a = createStrategyStore({ ...options, dataDir: personal, vpDir: accountA })
    const b = createStrategyStore({ ...options, dataDir: personal, vpDir: accountB })
    const target = { expectedRevision: 0, contest: '西安区域赛', date: '2026-10-17', result: '保铜争银', weeklyHours: 25,
      priorities: [{ id: 'implementation-stability', weight: 100 }] }
    assert.equal(a.target('set', target).ok, true)
    assert.equal(a.vpImport([{ eventId: 'account-a', contest: 'VP A', date: '2026-10-10', durationMinutes: 300,
      problems: [{ problemId: 'A', status: 'AC' }] }]).ok, true)
    assert.equal(b.target('read').contest, '西安区域赛')
    assert.equal(b.vpImport([]).total, 0)
    assert.equal(existsSync(join(personal, 'TARGET.yaml')), true)
    assert.equal(existsSync(join(accountA, 'VP_EVENTS.yaml')), true)
    assert.equal(existsSync(join(accountB, 'VP_EVENTS.yaml')), false)
  } finally {
    for (const dir of [personal, accountA, accountB]) rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt stored strategy data returns a structured refusal', () => {
  const { dir, store } = fixture()
  try {
    writeFileSync(join(dir, 'TARGET.yaml'), 'version: 1\nrevision: 4\npriorities: bad\n', 'utf8')
    const result = store.target('read')
    assert.equal(result.ok, false)
    assert.match(result.reject, /TARGET.yaml/)
    const route = store.route('最短路')
    assert.equal(route.ok, false)
    assert.match(route.reject, /TARGET.yaml/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

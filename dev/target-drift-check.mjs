import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { createStrategyStore } from '../lib/strategy.js'
import { createCurriculumStore } from '../lib/curriculum.js'
import { collectEvidence } from '../lib/curriculum-evidence.js'
import { buildTrainingLog } from '../lib/training-log.js'

const byId = new Map([['A', { name: 'A', depends: [] }], ['B', { name: 'B', depends: ['A'] }]])
const seedNodes = { A: { status: 'learned' }, B: { checks: [{ date: '2026-10-08', outcome: 'failed' }] } }
const seedEvidence = collectEvidence({ nodes: seedNodes })
const phase = {
  id: 'foundation', title: '稳定基础能力', outcome: '独立建模与实现', nodes: ['B'], kind: 'training', finding: 'gap',
  requiredVerified: ['B'], exitCriteria: '独立变式', exitChecks: [{ node: 'B', minEvents: 1 }],
  basis: '已存在对应知识点的未通过检测记录，需要针对性训练',
  goalContribution: '通过独立建模提升区域赛可完成题数',
  priorityReason: '先修复已观测的基础问题', estimatedHours: 8, uncertainty: '', diagnosticMethod: '',
  evidenceRefs: seedEvidence.map((entry) => entry.id),
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coach-target-drift-'))
  const progress = { nodes: structuredClone(seedNodes), pendingActions: {} }
  const strategy = createStrategyStore({ dataDir: dir, competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml') })
  const curriculum = createCurriculumStore({ dataDir: dir, loadMap: () => ({ byId }), loadProgress: () => progress,
    loadTarget: () => strategy.target('read'), now: () => new Date('2026-10-09T12:00:00+08:00') })
  return { dir, progress, strategy, curriculum, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const setTarget = (strategy, expectedRevision, contest, date, result) => strategy.target('set', {
  expectedRevision, contest, date, result, weeklyHours: 25,
  priorities: [{ id: 'contest-decision', weight: 100 }],
})

test('a course remembers which target it was built for and flags a later target change', () => {
  const { dir, strategy, curriculum, cleanup } = fixture()
  try {
    assert.equal(setTarget(strategy, 0, '西安站', '2026-11-02', '银牌').ok, true)
    const created = curriculum.execute({ action: 'create', expectedRevision: 0,
      goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30, phases: [phase],
      reason: '根据真实训练表现建立课程路线' })
    assert.equal(created.ok, true, created.reject)
    assert.equal(created.targetState, 'fresh', created.targetNote)
    assert.equal(created.boundTarget, '西安站 2026-11-02 银牌')

    assert.equal(setTarget(strategy, 1, '香港站', '2026-12-15', '金牌').ok, true)
    const read = curriculum.execute({ action: 'read' })
    assert.equal(read.ok, true)
    assert.equal(read.targetState, 'stale')
    assert.match(read.targetNote, /西安站/)
    assert.match(read.targetNote, /香港站/)
    assert.equal(read.currentTarget, '香港站 2026-12-15 金牌')

    // 提醒但不拦：布置照常成功，但必须把不一致带出去。
    const assigned = curriculum.assignment({ node: 'B', revision: read.revision })
    assert.equal(assigned.ok, true, assigned.reject)
    assert.match(assigned.targetWarning, /西安站/)

    // 今天卡片拿到同一句提醒，不能只在小鲸的试卷里看得见。
    const log = buildTrainingLog({ curriculum: read, byId, progress: { nodes: seedNodes },
      schedule: { days: {} }, today: '2026-10-09' })
    assert.equal(log.curriculum.target.state, 'stale')
    assert.match(log.curriculum.target.note, /香港站/)
  } finally { cleanup() }
})

test('coach_status carries the target mismatch into what the model reads', async () => {
  const { dir, strategy, curriculum, cleanup } = fixture()
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  try {
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 3}\nnodes:\n  - {id: A, name: A, depends: []}\n  - {id: B, name: B, depends: [A]}\n')
    assert.equal(setTarget(strategy, 0, '西安站', '2026-11-02', '银牌').ok, true)
    assert.equal(curriculum.execute({ action: 'create', expectedRevision: 0,
      goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30, phases: [phase],
      reason: '根据真实训练表现建立课程路线' }).ok, true)
    assert.equal(setTarget(strategy, 1, '香港站', '2026-12-15', '金牌').ok, true)

    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = join(dir, 'unused.db')
    const { apply } = await import(`../index.js?target-drift=${dir.replace(/\\/g, '/')}`)
    const tools = new Map()
    apply({ tools: { register: (tool) => tools.set(tool.name, tool) }, on() {}, get() {}, effect: (cb) => cb(), inject() {} })
    const tool = tools.get('coach_status')
    const status = await tool.execute({})
    assert.match(status.targetMismatch, /西安站/)
    assert.match(tool.output.render({}, status)[0].text, /香港站/)
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    cleanup()
  }
})

test('a legacy course without a target binding is labelled but never blocked', () => {
  const { dir, strategy, curriculum, cleanup } = fixture()
  try {
    assert.equal(setTarget(strategy, 0, '西安站', '2026-11-02', '银牌').ok, true)
    const created = curriculum.execute({ action: 'create', expectedRevision: 0,
      goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30, phases: [phase],
      reason: '根据真实训练表现建立课程路线' })
    assert.equal(created.ok, true, created.reject)

    const path = join(dir, 'CURRICULUM.yaml')
    const legacy = parse(readFileSync(path, 'utf8'))
    delete legacy.targetBinding
    writeFileSync(path, '# 课程路线；进度与检测证据仍以 PROGRESS.yaml 为准。\n' + stringify(legacy, { lineWidth: 0 }), 'utf8')

    const read = curriculum.execute({ action: 'read' })
    assert.equal(read.ok, true, read.reject)
    assert.equal(read.targetState, 'unbound')
    assert.match(read.targetNote, /旧版本/)
    assert.equal(read.boundTarget, '')

    const assigned = curriculum.assignment({ node: 'B', revision: read.revision })
    assert.equal(assigned.ok, true, '旧课程不能被升级动作锁死')
    assert.equal(assigned.targetWarning, '')
    assert.doesNotMatch(curriculum.context(), /旧版本/, '旧课程没绑定目标，不该每轮念叨')
  } finally { cleanup() }
})

test('a target whose contest already happened is history, not a repeated reminder', () => {
  const { strategy, curriculum, cleanup } = fixture()
  try {
    assert.equal(setTarget(strategy, 0, '西安站', '2026-10-01', '银牌').ok, true)   // 夹具的“今天”是 2026-10-09
    const created = curriculum.execute({ action: 'create', expectedRevision: 0,
      goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30, phases: [phase],
      reason: '根据真实训练表现建立课程路线' })
    assert.equal(created.ok, true, created.reject)
    const read = curriculum.execute({ action: 'read' })
    assert.equal(read.targetState, 'archived')
    assert.match(read.targetNote, /已经结束/)
    assert.doesNotMatch(curriculum.context(), /西安站/, '打完的比赛不该每轮被提起')
    const assigned = curriculum.assignment({ node: 'B', revision: read.revision })
    assert.equal(assigned.ok, true, assigned.reject)
    assert.equal(assigned.targetWarning, '')
    const log = buildTrainingLog({ curriculum: read, byId, progress: { nodes: seedNodes },
      schedule: { days: {} }, today: '2026-10-09' })
    assert.equal(log.curriculum.target.state, 'archived')
  } finally { cleanup() }
})

test('skipping a phase rebinds the course to the current target', () => {
  const { strategy, curriculum, cleanup } = fixture()
  const diag = (id, node) => ({ id, title: id, outcome: '能说清当前能力边界', exitCriteria: '用新记录核对',
    kind: 'diagnostic', finding: 'unknown', nodes: [node], competencies: [], requiredVerified: [], exitChecks: [],
    basis: '昨日记录显示这里还需要核实', goalContribution: '确定当前阶段能训练的范围和顺序', priorityReason: '先核实基础再安排训练量',
    estimatedHours: 2, uncertainty: '尚未确认是否理解更新方向', diagnosticMethod: '口头复述并用一个最小例子自证', evidenceRefs: [] })
  try {
    assert.equal(setTarget(strategy, 0, '西安站', '2026-11-02', '银牌').ok, true)
    const created = curriculum.execute({ action: 'create', expectedRevision: 0,
      goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30,
      phases: [diag('p1', 'B'), diag('p2', 'A')], reason: '根据真实训练表现建立课程路线' })
    assert.equal(created.ok, true, created.reject)
    assert.equal(created.targetState, 'fresh')
    // 比赛打完，目标改成下一站；然后明确跳过旧阶段 —— 跳过本身就是决定，不该再拿旧目标念叨
    assert.equal(setTarget(strategy, 1, '香港站', '2026-12-15', '金牌').ok, true)
    const before = curriculum.execute({ action: 'read' })
    assert.equal(before.targetState, 'stale')
    const skipped = curriculum.execute({ action: 'skip', expectedRevision: before.revision,
      reason: '西安站已经打完，这个阶段不再适用，进入下一阶段' })
    assert.equal(skipped.ok, true, skipped.reject)
    const after = curriculum.execute({ action: 'read' })
    assert.equal(after.targetState, 'fresh', after.targetNote)
    assert.equal(after.boundTarget, '香港站 2026-12-15 金牌')
  } finally { cleanup() }
})

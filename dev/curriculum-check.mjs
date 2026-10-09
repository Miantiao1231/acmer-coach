import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { createCurriculumStore, curriculumTool } from '../lib/curriculum.js'
import { collectEvidence } from '../lib/curriculum-evidence.js'

const byId = new Map([
  ['A', { name: 'A', depends: [] }], ['B', { name: 'B', depends: ['A'] }],
  ['C', { name: 'C', depends: ['A'] }], ['D', { name: 'D', depends: ['B'] }],
  ['E', { name: 'E', depends: ['D'] }],
])
const testBase = process.env.COACH_TEST_TMP || tmpdir()
const seedNodes = {
  A: { status: 'learned' },
  B: { checks: [{ date: '2026-10-08', outcome: 'failed' }] },
  C: { checks: [{ date: '2026-10-08', outcome: 'failed' }] },
  D: { checks: [{ date: '2026-10-08', outcome: 'failed' }] },
}
const seedEvidence = collectEvidence({ nodes: seedNodes })
const phases = [
  { id: 'foundation', title: '稳定基础能力', outcome: '独立建模与实现', nodes: ['B', 'C'], exitCriteria: '独立变式与延迟复测', requiredVerified: ['B', 'C'] },
  { id: 'transfer', title: '组合迁移', outcome: '识别组合题机制', nodes: ['D'], exitCriteria: '无标签混合题独立完成', requiredVerified: ['D'] },
].map((phase) => ({ ...phase, kind: 'training', finding: 'gap',
  basis: '已存在对应知识点的未通过检测记录，需要针对性训练',
  goalContribution: '通过独立建模和稳定实现提升区域赛可完成题数',
  priorityReason: '先修复已观测的基础问题，再进入有依赖的组合训练',
  estimatedHours: 8, uncertainty: '', diagnosticMethod: '',
  evidenceRefs: seedEvidence.filter((entry) => phase.nodes.includes(entry.node)).map((entry) => entry.id),
}))
function prove(progress, node) {
  const entry = progress.nodes[node] ??= {}
  entry.status = 'verified'
  ;(entry.checks ??= []).push({ date: '2026-10-09', outcome: 'passed' })
}
function fixture() {
  const dataDir = mkdtempSync(join(testBase, 'coach-curriculum-'))
  const progress = { nodes: structuredClone(seedNodes), pendingActions: {} }
  const options = { dataDir, loadMap: () => ({ byId }), loadProgress: () => progress,
    now: () => new Date('2026-10-09T12:00:00+08:00') }
  const store = createCurriculumStore(options)
  const create = (extra = {}) => store.execute({ action: 'create', expectedRevision: 0,
    goal: '区域赛稳定表现，长期向 WF 发展', baseline: '水平与队伍缺口已核实，尚需独立检测',
    weeklyHours: 30, phases, reason: '根据用户目标与真实训练表现建立课程路线', ...extra })
  return { dataDir, progress, options, store, create }
}
function validateShape(schema, value) {
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object'); assert.notEqual(value, null)
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(key in schema.properties, `unexpected ${key}`)
    for (const [key, child] of Object.entries(schema.properties)) {
      if (child.required) assert.ok(key in value, `missing ${key}`)
      if (key in value) validateShape(child, value[key])
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value)); for (const item of value) validateShape(schema.items, item)
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value))
  else assert.equal(typeof value, schema.type)
}

const phaseFor = (nodes, extra = {}) => ({ ...phases[0], nodes, requiredVerified: [...nodes],
  evidenceRefs: seedEvidence.filter((entry) => nodes.includes(entry.node)).map((entry) => entry.id), ...extra })
const diagnostic = (nodes = ['B']) => phaseFor(nodes, {
  id: 'diagnostic', title: '核实当前能力缺口', kind: 'diagnostic', finding: 'unknown',
  basis: '尚无足够的实际结果证明具体短板，先进行诊断',
  uncertainty: '尚未确认是否独立建模、实现稳定性或熟练度存在缺口',
  diagnosticMethod: '独立完成小规模变式，记录结果并对失败代码进行判因',
  evidenceRefs: [], requiredVerified: [], estimatedHours: 2,
})
const provisional = (nodes = ['D']) => phaseFor(nodes, {
  id: 'future', kind: 'provisional', finding: 'unknown', basis: '该方向目前仅是与目标相关的远期假设，尚待诊断',
  uncertainty: '尚未取得这些节点的训练结果，进入前须重新核实依据',
  evidenceRefs: [], requiredVerified: [], estimatedHours: 0,
})
const advance = (f, revision = f.store.snapshot().revision) => f.store.execute({ action: 'advance', expectedRevision: revision, reason: '依据本阶段实际产生的检测与训练记录评估成果' })

test('assess exposes only existing record refs; rating and statuses cannot justify a training stage', () => {
  const f = fixture(); f.progress.nodes = { A: { status: 'learned' }, B: { status: 'studying', rating: 1600 } }
  const assessed = f.store.execute({ action: 'assess' })
  assert.equal(assessed.evidenceCount, 0)
  assert.equal(f.create({ phases: [phaseFor(['B'])] }).ok, false)
  assert.equal(f.create({ phases: [diagnostic(), provisional()] }).ok, true)
  assert.equal(f.store.snapshot().roadmap[1].kind, 'provisional')
  assert.equal(f.store.execute({ action: 'assess', evidenceNodes: ['unknown'] }).ok, false)
  validateShape(curriculumTool(f.store).output.schema, assessed)
})

test('training rejects fake refs, unrelated evidence and missing per-node coverage', () => {
  for (const phase of [
    phaseFor(['B'], { evidenceRefs: ['imaginary-record'] }),
    phaseFor(['B'], { evidenceRefs: [seedEvidence.find((entry) => entry.node === 'C').id] }),
    phaseFor(['B', 'C'], { evidenceRefs: [seedEvidence.find((entry) => entry.node === 'B').id] }),
    phaseFor(['B'], { requiredVerified: [] }),
  ]) {
    const f = fixture(); assert.equal(f.create({ phases: [phase] }).ok, false)
    assert.equal(f.store.load(), null)
  }
})

test('positive baselines permit extension but cannot be relabeled as a measured gap', () => {
  const f = fixture(); prove(f.progress, 'B')
  const ref = f.store.execute({ action: 'assess', evidenceNodes: ['B'] }).evidence.find((entry) => entry.signal === 'baseline').id
  assert.equal(f.create({ phases: [phaseFor(['B'], { evidenceRefs: [ref] })] }).ok, false)
  assert.equal(f.create({ phases: [phaseFor(['B'], { finding: 'extension', evidenceRefs: [ref] })] }).ok, true)
})

test('ordering uses explicit prerequisites and verified training gates, never cursor assumptions', () => {
  const f = fixture(); delete f.progress.nodes.A; f.progress.cursor = 'B'
  assert.equal(f.create({ phases: [phaseFor(['B'])] }).ok, false)
  const g = fixture()
  assert.equal(g.create({ phases: [phaseFor(['D'], { id: 'early-D' }), phaseFor(['B'])] }).ok, false)
  assert.equal(g.create({ phases: [phaseFor(['D', 'B'])] }).ok, false)
  assert.equal(g.create({ phases: [diagnostic(), phaseFor(['D'], { id: 'after-diagnosis' })] }).ok, false)
  assert.equal(g.create({ phases: [phaseFor(['B', 'D'])] }).ok, true)
})

test('planning rationale and budget are mandatory, and provisional cannot be the active phase', () => {
  for (const patch of [{ basis: '凭感觉' }, { goalContribution: '' }, { priorityReason: '' }, { estimatedHours: 0 }]) {
    const f = fixture(); assert.equal(f.create({ phases: [phaseFor(['B'], patch)] }).ok, false)
  }
  const f = fixture(); assert.equal(f.create({ phases: [provisional(['B'])] }).ok, false)
})

test('budget reports time pressure and uncertainty without pretending a weekly average is a daily schedule', () => {
  const f = fixture(); const state = f.create({ weeklyHours: 7, deadline: '2026-10-09', phases: [phaseFor(['B'], { estimatedHours: 8 })] })
  assert.equal(state.ok, true); assert.equal(state.remainingEstimatedHours, 8)
  assert.match(state.budgetWarnings.join(' '), /高于目标日期/)
  const g = fixture(); const unknown = g.create({ weeklyHours: 0, phases: [diagnostic(), provisional()] })
  assert.equal(unknown.estimatedWeeks, 0); assert.match(unknown.budgetWarnings.join(' '), /未确认/)
  assert.match(unknown.budgetWarnings.join(' '), /尚未估时/)
})

test('a changed source invalidates its reference and requires an explicit rebase', () => {
  const f = fixture(); f.create()
  f.progress.nodes.B.checks[0].minutes = 50
  const state = f.store.snapshot(); assert.equal(state.needsReview, true)
  assert.equal(f.store.assignment({ node: 'B', revision: 1 }).ok, false)
  assert.equal(advance(f).ok, false)
  const refs = f.store.execute({ action: 'assess' }).evidence
  const rebased = phases.map((phase) => ({ ...phase, evidenceRefs: refs.filter((entry) => phase.nodes.includes(entry.node)).map((entry) => entry.id) }))
  assert.equal(f.store.execute({ action: 'revise', expectedRevision: 1, phases: rebased, reason: '原检测记录有实质修订，按当前真实内容重新引用' }).ok, true)
})

test('diagnostic cannot advance on old evidence, change into training or delete a probe', () => {
  const f = fixture(); f.create({ phases: [diagnostic(['B', 'C']), provisional()] })
  assert.equal(advance(f).ok, false)
  assert.match(advance(f).reject, /新诊断/)
  for (const replacement of [phaseFor(['B', 'C'], { id: 'diagnostic' }), diagnostic(['B'])]) {
    assert.equal(f.store.execute({ action: 'revise', expectedRevision: 1, phases: [replacement, provisional()], reason: '尝试跳过尚未完成的诊断直接进入训练' }).ok, false)
  }
  assert.equal(f.store.snapshot().revision, 1)
})

test('diagnosis results allow an evidence-grounded follow-up; next training requires new performance', () => {
  const f = fixture(); f.create({ phases: [diagnostic()] })
  f.progress.nodes.B.checks.push({ date: '2026-10-09', outcome: 'failed' })
  assert.equal(advance(f).ok, false); assert.match(advance(f).reject, /后续路线/)
  const training = phaseFor(['B'], { id: 'fix-B', evidenceRefs: f.store.execute({ action: 'assess', evidenceNodes: ['B'] }).evidence.map((entry) => entry.id) })
  const revised = f.store.execute({ action: 'revise', expectedRevision: 1, phases: [diagnostic(), training], reason: '根据本阶段新诊断结果追加针对性的训练阶段' })
  assert.equal(revised.ok, true, revised.reject)
  const entered = advance(f); assert.equal(entered.ok, true, entered.reject); assert.equal(entered.phaseId, 'fix-B')
  assert.equal(advance(f).ok, false)
  prove(f.progress, 'B')
  assert.equal(advance(f).status, 'complete')
})

test('a provisional next phase cannot be entered even after diagnostic records exist', () => {
  const f = fixture(); f.create({ phases: [diagnostic(), provisional()] })
  f.progress.nodes.B.checks.push({ date: '2026-10-09', outcome: 'failed' })
  const result = advance(f); assert.equal(result.ok, false); assert.match(result.reject, /下一阶段仍待定/)
  assert.equal(f.store.snapshot().phaseId, 'diagnostic')
})

test('verified flags and old/backdated checks cannot substitute for new stage performance', () => {
  const f = fixture(); prove(f.progress, 'B'); f.create({ phases: [phaseFor(['B'])] })
  assert.equal(advance(f).ok, false)
  f.progress.nodes.B.checks.push({ date: '2026-10-08', outcome: 'passed' })
  assert.equal(advance(f).ok, false)
  prove(f.progress, 'B'); assert.equal(advance(f).status, 'complete')
})

test('note edits, changed old results and mirrored imports do not constitute new diagnostic events', () => {
  const f = fixture()
  f.progress.nodes.B.passes = [{ date: '2026-10-09', problemId: 'P1', solved: false, independent: false, minutes: 40, note: '初始记录' }]
  f.create({ phases: [diagnostic(), provisional()] })
  f.progress.nodes.B.passes[0].note = '仅修改说明'
  assert.deepEqual(f.store.snapshot().missingFreshEvidence, ['B'])
  f.progress.nodes.B.passes[0].solved = true; f.progress.nodes.B.passes[0].independent = true
  assert.deepEqual(f.store.snapshot().missingFreshEvidence, ['B'])
  const g = fixture(); g.progress.nodes.B = {}
  const schedule = { days: { '2026-10-09': { actual: [{ node: 'B', problemId: 'P1', solved: false, independent: false, actualMin: 40 }] } } }
  const store = createCurriculumStore({ ...g.options, loadSchedule: () => schedule })
  assert.equal(store.execute({ action: 'create', expectedRevision: 0, goal: '核实长期训练所需的能力起点', phases: [diagnostic(), provisional()], reason: '在只有日程记录的情况下先建立能力诊断阶段' }).ok, true)
  g.progress.nodes.B.passes = [{ date: '2026-10-09', problemId: 'P1', solved: false, independent: false, minutes: 40 }]
  assert.deepEqual(store.snapshot().missingFreshEvidence, ['B'])
})

test('adding a training target snapshots its existing observations; budget-only revision preserves progress', () => {
  const f = fixture(); f.create({ phases: [phaseFor(['B'])] }); prove(f.progress, 'C')
  assert.equal(f.store.execute({ action: 'revise', expectedRevision: 1, phases: [phaseFor(['B', 'C'])], reason: '根据实际记录扩展当前阶段能力目标，重新验收新增节点' }).ok, true)
  assert.deepEqual(f.store.snapshot().missingFreshEvidence, ['B', 'C'])
  const g = fixture(); g.create({ phases: [phaseFor(['B'])] }); prove(g.progress, 'B')
  assert.equal(g.store.execute({ action: 'revise', expectedRevision: 1, phases: [phaseFor(['B'], { estimatedHours: 10 })], reason: '可用时间改变，仅调整时间估算，保持能力目标和依据' }).ok, true)
  assert.deepEqual(g.store.snapshot().missingFreshEvidence, [])
})

test('v1 route remains readable without writes; migration preserves completed stages and history', () => {
  const f = fixture(); f.create(); prove(f.progress, 'B'); prove(f.progress, 'C')
  const old = parse(readFileSync(f.store.path, 'utf8')); old.version = 1; old.current = 1
  old.phases = old.phases.map(({ id, title, outcome, nodes, exitCriteria, requiredVerified }) => ({ id, title, outcome, nodes, exitCriteria, requiredVerified }))
  delete old.enteredAt; delete old.entryEvidenceRefs; delete old.entryEvidenceEvents
  const bytes = stringify(old); writeFileSync(f.store.path, bytes)
  const state = f.store.snapshot(); assert.equal(state.needsReview, true)
  assert.equal(readFileSync(f.store.path, 'utf8'), bytes)
  assert.equal(f.store.assignment({ node: 'D', revision: 1 }).ok, false)
  assert.equal(advance(f).ok, false)
  const completed = f.store.load().phases[0]
  const result = f.store.execute({ action: 'revise', expectedRevision: 1, phases: [completed, phases[1]], reason: '为旧路线补齐未完成阶段的真实依据，保留已经完成的阶段' })
  assert.equal(result.ok, true, result.reject); assert.equal(result.revision, 2)
  const migrated = parse(readFileSync(f.store.path, 'utf8'))
  assert.equal(migrated.version, 2); assert.equal(migrated.phases[0].kind, 'legacy')
  assert.equal(migrated.history[1].previous.version, 1)
})

test('course persists across store instances without duplicating progress', () => {
  const f = fixture(); assert.equal(f.create().ok, true)
  const restarted = createCurriculumStore(f.options)
  assert.equal(restarted.snapshot().goal, '区域赛稳定表现，长期向 WF 发展')
  assert.equal(restarted.snapshot().phaseId, 'foundation')
  assert.deepEqual(restarted.snapshot().missingVerified, ['B', 'C'])
  assert.equal(parse(readFileSync(f.store.path, 'utf8')).nodes, undefined)
  Object.assign(f.progress.nodes.B, { status: 'verified' })
  assert.deepEqual(restarted.snapshot().missingVerified, ['C'])
})

test('stale writes cannot overwrite a changed goal, and revision history keeps old snapshots', () => {
  const f = fixture(); f.create()
  const edited = f.store.execute({ action: 'revise', expectedRevision: 1, goal: '按证据修订后的能力目标', reason: '用户修改目标，保留当前阶段并调整远期路线' })
  assert.equal(edited.revision, 2)
  assert.equal(f.store.execute({ action: 'revise', expectedRevision: 1, goal: '旧目标', reason: '使用旧版本尝试更新课程目标' }).ok, false)
  assert.equal(f.store.snapshot().goal, '按证据修订后的能力目标')
  const doc = parse(readFileSync(f.store.path, 'utf8'))
  assert.equal(doc.history[1].previous.goal, '区域赛稳定表现，长期向 WF 发展')
})

test('unknown map nodes, duplicate phases, invalid dates and future phase focus are rejected', () => {
  for (const extra of [
    { phases: [{ ...phases[0], nodes: ['unknown'] }] },
    { phases: [phases[0], phases[0]] }, { deadline: '2026-02-30' },
    { focusNodes: ['D'] }, { weeklyHours: 169 },
  ]) {
    const f = fixture(); assert.equal(f.create(extra).ok, false); assert.equal(f.store.load(), null)
  }
})

test('active course cannot be silently replaced, and failed validation preserves the file', () => {
  const f = fixture(); f.create(); const before = readFileSync(f.store.path, 'utf8')
  assert.equal(f.create({ expectedRevision: 1 }).ok, false)
  assert.equal(f.store.execute({ action: 'revise', expectedRevision: 1, reason: '尚未给出足够修改依据', focusNodes: ['D'] }).ok, false)
  assert.equal(readFileSync(f.store.path, 'utf8'), before)
})

test('assignment is bound to current course revision and focus, with explicit detours', () => {
  const f = fixture(); f.create({ focusNodes: ['B'] })
  assert.equal(f.store.assignment({ node: 'B' }).ok, false)
  assert.equal(f.store.assignment({ node: 'C', revision: 1 }).ok, false)
  assert.equal(f.store.assignment({ node: 'D', revision: 1, purpose: 'remediation' }).ok, false)
  const detour = f.store.assignment({ node: 'C', revision: 1, purpose: 'remediation', reason: '补当前阶段暴露的机制缺口，完成后回到 B' })
  assert.equal(detour.ok, true); assert.equal(detour.binding.phaseId, 'foundation')
  assert.equal(f.store.snapshot().phaseId, 'foundation')
  assert.equal(f.store.assignment({ node: 'D', revision: 1, purpose: 'review', reason: '暂时复习同类知识点，之后返回主线' }).ok, false)
  assert.equal(f.store.assignment({ node: 'A', revision: 1, purpose: 'review', reason: '复习已经学过的前置，随后回到 B 的变式' }).ok, true)
})

test('expired weekly focus pauses new progression without changing long-term course', () => {
  const f = fixture(); f.create({ focusNodes: ['B'], focusUntil: '2026-10-08' })
  assert.equal(f.store.snapshot().focusExpired, true)
  assert.equal(f.store.assignment({ node: 'B', revision: 1 }).ok, false)
  assert.match(f.store.context(), /本周主线已到期/)
  assert.equal(f.store.snapshot().goal, '区域赛稳定表现，长期向 WF 发展')
})

test('unfinished bound action stops a new unit; completing it permits the next one', () => {
  const f = fixture(); f.create()
  f.progress.pendingActions.B = { curriculum: { phaseId: 'foundation' } }
  assert.equal(f.store.assignment({ node: 'C', revision: 1 }).ok, false)
  assert.match(f.store.context(), /先继续/)
  delete f.progress.pendingActions.B
  assert.equal(f.store.assignment({ node: 'C', revision: 1 }).ok, true)
})

test('existing assignments survive introducing a course and no-course behavior stays available', () => {
  const f = fixture()
  assert.equal(f.store.assignment({ node: 'B' }).ok, true)
  assert.equal(f.store.assignment({ node: 'B' }).binding, null)
  f.progress.pendingActions.A = { deliverable: '升级前已布置的动作' }
  f.create()
  assert.deepEqual(f.store.snapshot().pendingNodes, ['A'])
  assert.equal(f.store.assignment({ node: 'B', revision: 1 }).ok, false)
  delete f.progress.pendingActions.A
  assert.equal(f.store.assignment({ node: 'B', revision: 1 }).ok, true)
})

test('phase advancement requires verified facts, no pending actions, and no ungraded paper', () => {
  const f = fixture(); f.create()
  const advance = () => f.store.execute({ action: 'advance', expectedRevision: 1, reason: '根据独立变式及延迟检测记录评估阶段成果' })
  assert.equal(advance().ok, false)
  prove(f.progress, 'B'); prove(f.progress, 'C')
  f.progress.pendingActions.B = { curriculum: { phaseId: 'foundation' } }
  assert.equal(advance().ok, false)
  delete f.progress.pendingActions.B; f.progress.pending = { node: 'B' }
  assert.equal(advance().ok, false)
  f.progress.pending = null
  const next = advance(); assert.equal(next.ok, true); assert.equal(next.phaseId, 'transfer')
  assert.deepEqual(next.missingVerified, ['D'])
  assert.equal(f.store.execute({ action: 'revise', expectedRevision: 2, phases: [{ ...phases[0], outcome: '重写过去' }, phases[1]], reason: '尝试通过修订重写之前已完成的能力阶段' }).ok, false)
})

test('all phases can finish explicitly and a new route retains the previous audit history', () => {
  const f = fixture(); f.create({ phases: [phases[0]] })
  prove(f.progress, 'B'); prove(f.progress, 'C')
  assert.equal(f.store.snapshot().status, 'active')
  const done = f.store.execute({ action: 'advance', expectedRevision: 1, reason: '依据两次独立检测及迁移任务完成最终验收' })
  assert.equal(done.status, 'complete')
  assert.equal(f.store.assignment({ node: 'B', revision: 2 }).ok, false)
  assert.equal(f.create({ expectedRevision: 2 }).ok, true)
  assert.equal(f.store.snapshot().history.length, 3)
})

test('broken course is surfaced and never treated as an empty plan', () => {
  const f = fixture(); writeFileSync(f.store.path, 'revision: broken\n')
  const result = f.create(); assert.equal(result.ok, false)
  assert.match(f.store.context(), /读取失败/)
  assert.equal(readFileSync(f.store.path, 'utf8'), 'revision: broken\n')
})

test('course tool output matches its declared schema on success, rejection and absence', () => {
  const f = fixture(); const tool = curriculumTool(f.store)
  for (const result of [f.store.execute({ action: 'read' }), f.create(), f.store.execute({ action: 'advance', expectedRevision: 1, reason: '检查未验收阶段是否能够被强行推进' })]) validateShape(tool.output.schema, result)
})

test('partly damaged course fields are rejected with a valid output and never overwritten', () => {
  for (const change of [
    (doc) => { doc.goal = 123 }, (doc) => { delete doc.baseline },
    (doc) => { doc.history = [null] }, (doc) => { doc.updated = 'invalid' },
    (doc) => { doc.focusNodes = ['B', 'B'] }, (doc) => { doc.weeklyHours = 169 },
  ]) {
    const f = fixture(); f.create()
    const doc = parse(readFileSync(f.store.path, 'utf8')); change(doc)
    const broken = stringify(doc); writeFileSync(f.store.path, broken)
    const result = f.store.execute({ action: 'read' })
    assert.equal(result.ok, false)
    validateShape(curriculumTool(f.store).output.schema, result)
    assert.equal(readFileSync(f.store.path, 'utf8'), broken)
  }
})

test('plugin integration: cross-branch course assignments, detours, logging and new-session context', async () => {
  const dataDir = mkdtempSync(join(testBase, 'coach-course-integration-'))
  writeFileSync(join(dataDir, 'MAP.yaml'), 'meta: {version: 3}\nnodes:\n' + [...byId].map(([id, n]) => `  - id: ${id}\n    name: ${id}\n    domain: 测试\n    tier: core\n    depends: [${n.depends.join(', ')}]\n`).join(''))
  writeFileSync(join(dataDir, 'PROGRESS.yaml'), stringify({ version: 1, cursor: 'B', nodes: { ...structuredClone(seedNodes), B: { ...seedNodes.B, status: 'studying' }, C: { ...seedNodes.C, status: 'studying' } } }))
  process.env.COACH_DATA_DIR = dataDir
  process.env.COACH_DB = join(dataDir, 'unused.db')
  const tools = new Map(); let hook
  const { apply } = await import('../index.js?curriculum-integration')
  apply({ tools: { register: (t) => tools.set(t.name, t) }, inject() {}, on: (event, fn) => { if (event === 'agent/pre-step') hook = fn } })
  const course = tools.get('coach_curriculum'); const assign = tools.get('coach_assign')
  const created = await course.execute({ action: 'create', expectedRevision: 0, goal: '测试长期路线', phases, reason: '依据训练表现建立可延续的阶段课程' })
  assert.equal(created.ok, true, created.reject)
  const candidates = await tools.get('coach_next').execute({ cursor: 'B' })
  const nextText = tools.get('coach_next').output.render({}, candidates)[0].text
  assert.match(nextText, /测试长期路线/)
  assert.doesNotMatch(nextText, /得先把游标挪过去/)
  const gradeText = tools.get('coach_grade').output.render({}, {
    ok: true, outcome: 'passed', nodeName: 'B', score: 3, maxScore: 3, passScore: 2,
    minutes: 40, limit: 60, checks: 1, problems: [], verifiedAt: 1600, selfReported: 0,
  })[0].text
  assert.match(gradeText, /单点过卷不会自动推进阶段/)
  assert.doesNotMatch(gradeText, /推进，别回头/)
  const args = { node: 'C', deliverable: '独立变式代码与思路', why: '检验当前阶段的建模能力', curriculumRevision: 1 }
  const accepted = await assign.execute(args); assert.equal(accepted.accepted, true, accepted.reject)
  assert.match(accepted.why, /稳定基础能力/)
  assert.equal(parse(readFileSync(join(dataDir, 'PROGRESS.yaml'), 'utf8')).pendingActions.C.curriculum.phaseId, 'foundation')
  assert.equal((await assign.execute({ ...args, node: 'B' })).accepted, false)
  const decision = await hook({ messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.match(JSON.stringify(decision.messages), /测试长期路线/)
  assert.match(JSON.stringify(decision.messages), /当前未完成单元/)
  const logged = await tools.get('coach_log').execute({ node: 'C', actualMin: 40, solved: true, independent: true })
  assert.equal(logged.actionCleared, true)
  assert.equal((await course.execute({ action: 'read' })).phaseId, 'foundation')
  const offRoute = await assign.execute({ ...args, node: 'D', teachMinutes: 10 })
  assert.equal(offRoute.accepted, false); assert.match(offRoute.reject, /当前阶段主线/)
  const remediation = await assign.execute({ ...args, node: 'E', teachMinutes: 10, purpose: 'remediation', routeReason: '补当前阶段建模失败的机制，检验后回到主线' })
  assert.equal(remediation.accepted, false); assert.match(remediation.reject, /前置/)
  validateShape(assign.output.schema, accepted); validateShape(assign.output.schema, offRoute)
  writeFileSync(join(dataDir, 'PROGRESS.yaml'), 'version: 1\ncursor: ""\nnodes: {}\n')
  const fresh = await hook({ messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.match(JSON.stringify(fresh.messages), /测试长期路线/)
  const later = await hook({ messages: [], step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(later.messages.length, 0)
})

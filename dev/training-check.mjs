import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

async function fixture(run, { cursor = 'A' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-training-'))
  const old = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  writeFileSync(join(dir, 'MAP.yaml'), stringify({ meta: { version: 1 }, nodes: [{ id: 'A', name: '基础', depends: [] }] }))
  writeFileSync(join(dir, 'PROGRESS.yaml'), stringify({ version: 1, cursor, nodes: { A: { status: 'studying' } } }))
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  try {
    const { apply } = await import(`../index.js?training-${Date.now()}-${Math.random()}`)
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {} })
    const call = async (name, args) => {
      const tool = tools.get(name)
      const value = await tool.execute(args)
      shape(tool.output.schema, value)
      return value
    }
    await run({ call, tools, dir, read: file => parse(readFileSync(join(dir, file), 'utf8')), write: (file, doc) => writeFileSync(join(dir, file), stringify(doc)) })
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', old.data], ['COACH_DB', old.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a failed progress write cannot report the pending action as cleared', async () => fixture(async ({ call, read }) => {
  assert.equal((await call('coach_assign', { competency: 'contest-reading', kind: 'diagnostic', minutes: 15, deliverable: '说明三题的模型条件' })).accepted, true)
  const originalWrite = fs.writeFileSync
  let result
  try {
    fs.writeFileSync = (path, ...args) => {
      if (String(path).includes('PROGRESS.yaml')) throw new Error('simulated disk write failure')
      return originalWrite(path, ...args)
    }
    syncBuiltinESMExports()
    result = await call('coach_log', { competency: 'contest-reading', actualMin: 15, solved: true, independent: true })
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
  assert.equal(result.recorded, false)
  assert.equal(result.actionCleared, false)
  assert.ok(read('PROGRESS.yaml').pendingActions['competency:contest-reading'])
  assert.equal(read('SCHEDULE.yaml').days[result.date].actual.length, 1, 'the successfully saved actual remains visible')
}))

function shape(schema, value) {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(key in schema.properties, `unexpected ${key}`)
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      if (field.required === true || schema.required?.includes(key)) assert.ok(key in value, `missing ${key}`)
      if (key in value) shape(field, value[key])
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value)); value.forEach(item => shape(schema.items, item))
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value))
  else assert.equal(typeof value, schema.type)
}

test('15-minute node diagnostic fits one action without pretending a lecture or mastery happened', async () => fixture(async ({ call, read }) => {
  const assigned = await call('coach_assign', { node: 'A', kind: 'diagnostic', minutes: 15, deliverable: '说出状态定义并解释为什么保留这些信息' })
  assert.equal(assigned.accepted, true, assigned.reject)
  assert.equal(assigned.totalMinutes, 15)
  assert.deepEqual(assigned.blocks.map(block => block.minutes), [15])
  const progress = read('PROGRESS.yaml')
  assert.equal(progress.nodes.A.status, 'studying')
  assert.equal(progress.nodes.A.taught, undefined)
  assert.equal(progress.pendingActions.A.kind, 'diagnostic')
}))

test('a 60-minute lesson can use 20 teaching, 20 practice and 20 cleanup without a fictitious 30-minute floor', async () => fixture(async ({ call }) => {
  const r = await call('coach_assign', { node: 'A', minutes: 20, teachMinutes: 20, deliverable: '解释最小反例并提交独立尝试' })
  assert.equal(r.accepted, true, r.reject)
  assert.equal(r.totalMinutes, 60)
  assert.deepEqual(r.blocks.map(b => b.minutes), [20, 20, 10, 10])
}))

test('a full 300-minute VP occupies one schedule block within the physical day', async () => fixture(async ({ call }) => {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const planned = await call('coach_plan', { date, blocks: [{ from: '10:00', node: 'A', kind: 'vp', minutes: 300 }] })
  assert.equal(planned.ok, true, planned.reject)
  assert.equal(planned.planned.length, 1)
  assert.equal(planned.planned[0].to, '15:00')
  assert.equal(planned.planMin, 300)
  assert.equal((await call('coach_plan', { date, replace: true, blocks: [{ from: '20:00', node: 'A', kind: 'vp', minutes: 300 }] })).ok, false)
  const schedule = await call('coach_schedule', { from: date, days: 1 })
  assert.equal(schedule.days[0].planned[0].minutes, 300)
}))

test('an intentional rest day is visible and cannot be overwritten accidentally', async () => fixture(async ({ call }) => {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const rest = await call('coach_plan', { date, rest: true, blocks: [] })
  assert.equal(rest.ok, true, rest.reject)
  assert.equal(rest.planMin, 0)
  assert.equal((await call('coach_schedule', { from: date, days: 1 })).days[0].rest, true)
  assert.equal((await call('coach_journal', { date })).days[0].state, 'rest')
  const removed = await call('coach_unplan', { date, all: true })
  assert.equal(removed.ok, true)
  assert.equal(removed.removedRest, true)
  assert.equal((await call('coach_schedule', { from: date, days: 1 })).days[0].rest, false)
  assert.equal((await call('coach_plan', { date, rest: true, blocks: [] })).ok, true)
  const accidental = await call('coach_plan', { date, blocks: [{ from: '10:00', node: 'A', kind: 'cycle' }] })
  assert.equal(accidental.ok, false)
  const changed = await call('coach_plan', { date, replace: true, blocks: [{ from: '10:00', node: 'A', kind: 'cycle' }] })
  assert.equal(changed.ok, true, changed.reject)
  assert.equal((await call('coach_schedule', { from: date, days: 1 })).days[0].rest, false)
  assert.equal((await call('coach_plan', { date, replace: true, rest: true, blocks: [] })).ok, true)
  assert.equal((await call('coach_plan', { date, replace: true, blocks: [] })).ok, true)
  assert.equal((await call('coach_schedule', { from: date, days: 1 })).days[0].rest, false)
}))

test('competency diagnostic works without a cursor and completes through coach_log without a fake map node', async () => fixture(async ({ call, read }) => {
  const assigned = await call('coach_assign', { competency: 'contest-reading', kind: 'diagnostic', minutes: 15, deliverable: '扫描题面，提交题目筛选顺序和放弃理由' })
  assert.equal(assigned.accepted, true, assigned.reject)
  assert.equal(assigned.node, '')
  assert.equal(assigned.competency, 'contest-reading')
  assert.equal(assigned.totalMinutes, 15)
  assert.equal(read('PROGRESS.yaml').pendingActions['competency:contest-reading'].competency, 'contest-reading')
  const status = await call('coach_status', {})
  const pending = status.pendingActions[0]
  assert.equal(pending.node, '')
  assert.equal(pending.competency, 'contest-reading')
  assert.equal(pending.kind, 'diagnostic')
  assert.equal(pending.nodeName, '比赛读题与筛选')
  const logged = await call('coach_log', { competency: 'contest-reading', actualMin: 15, solved: false, independent: false, note: '遗漏了最后一道题的输入限制' })
  assert.equal(logged.ok, true, logged.reject)
  assert.equal(logged.actionCleared, true)
  assert.equal(logged.recorded, true)
  assert.deepEqual(Object.keys(read('PROGRESS.yaml').nodes), ['A'])
  assert.equal(read('SCHEDULE.yaml').days[logged.date].actual[0].competency, 'contest-reading')
  assert.equal(read('PROGRESS.yaml').pendingActions, undefined)
  const assessed = await call('coach_curriculum', { action: 'assess' })
  assert.equal(assessed.evidence.find(entry => entry.competency === 'contest-reading')?.signal, 'gap')
  assert.equal((await call('coach_assign', { competency: 'invented', kind: 'diagnostic', minutes: 15, deliverable: '提交观察' })).accepted, false)
  assert.equal((await call('coach_log', { competency: 'invented', actualMin: 15, solved: true, independent: true })).ok, false)
}, { cursor: '' }))

test('a node practice keeps its competition skill focus without counting a second session', async () => fixture(async ({ call, read }) => {
  const logged = await call('coach_log', { node: 'A', problemId: 'CF1067A', solved: true,
    focusCompetency: 'dp-modeling', note: '状态量选择：一维历史和滚动数组混淆', actualMin: 42 })
  assert.equal(logged.ok, true, logged.reject)
  assert.equal(read('PROGRESS.yaml').nodes.A.passes[0].focusCompetency, 'dp-modeling')
  const status = await call('coach_status', {})
  assert.equal(status.recentPasses[0].focusCompetency, 'dp-modeling')
  assert.match(status.recentPasses[0].note, /一维历史/)
  assert.equal(status.passTotal, 1)
  assert.equal(read('SCHEDULE.yaml').days[logged.date].actual.length, 1)
  assert.equal((await call('coach_log', { node: 'A', solved: true, focusCompetency: 'invented' })).ok, false)
}))

test('status links one exercise to its full MLE-WA-WA-AC-AC sequence', async () => fixture(async ({ call, read, write, dir }) => {
  const db = new DatabaseSync(join(dir, 'unused.db'))
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT);
    CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT,
      problem_id TEXT, verdict TEXT, submitted_at TEXT, cf_sub_id INTEGER, lg_sub_id INTEGER, nc_sub_id INTEGER);
    INSERT INTO users VALUES (1,'trainer','trainer');`)
  const now = Date.now()
  const at = (seconds) => new Date(now - seconds * 1000).toISOString()
  const stmt = db.prepare(`INSERT INTO unified_submissions
    (id,user_id,platform,problem_id,verdict,submitted_at,cf_sub_id) VALUES (?,?,?,?,?,?,?)`)
  for (const [id, verdict, ago] of [[1,'MLE',300],[2,'WA',240],[3,'WA',180],[4,'AC',120],[5,'AC',30]]) {
    stmt.run(id, 1, 'codeforces', '1067A', verdict, at(ago), id)
  }
  db.close()
  const logged = await call('coach_log', { node: 'A', problemId: 'CF1067A', solved: true,
    startedAt: at(360), completedAt: at(0), anchorSubmissionId: '5' })
  assert.equal(logged.ok, true, logged.reject)
  const pass = read('PROGRESS.yaml').nodes.A.passes[0]
  assert.equal(pass.platform, 'codeforces')
  assert.equal(pass.problemId, 'CF1067A')
  assert.equal(pass.anchorSubmissionId, '5')
  const status = await call('coach_status', {})
  assert.equal(status.recentPasses[0].submissionChain.attempts, 5)
  assert.equal(status.recentPasses[0].submissionChain.failed, 3)
  assert.match(status.recentPasses[0].submissionChain.verdicts, /MLE.*WA.*WA.*AC.*AC/)
  assert.equal(status.recentPasses[0].submissionChain.diagnosisStatus, 'not-recorded')
  const journal = await call('coach_journal', { date: logged.date })
  assert.match(journal.days[0].events.find(event => event.type === 'practice').detail, /提交 5 发，失败 3 发.*未见正式判因/)
  const progress = read('PROGRESS.yaml')
  progress.nodes.A.diagnoses = [{ date: logged.date, problem: 'CF1067A', category: '测试', summary: '这题有判因，未绑定本轮' }]
  write('PROGRESS.yaml', progress)
  assert.equal((await call('coach_status', {})).recentPasses[0].submissionChain.diagnosisStatus, 'problem-recorded')
}))

test('diagnosis reports submission facts separately from an unverified causal judgment', async () => fixture(async ({ call, tools, dir, read }) => {
  const db = new DatabaseSync(join(dir, 'unused.db'))
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT);
    CREATE TABLE unified_submissions (user_id INTEGER, platform TEXT, problem_id TEXT, verdict TEXT, submitted_at TEXT);
    CREATE TABLE unified_problems (platform TEXT, problem_id TEXT, title TEXT, difficulty REAL, tags TEXT);
    INSERT INTO users VALUES (1,'trainer','trainer');
    INSERT INTO unified_submissions VALUES (1,'codeforces','1067A','MLE','2026-10-28T19:47:00Z');
    INSERT INTO unified_submissions VALUES (1,'codeforces','1067A','AC','2026-10-28T20:00:00Z');`)
  db.close()
  const result = await call('coach_diagnose', { node: 'A', category: '不认真', problem: '1067A',
    code: 'int main() { vector<int> a(1000000); return a.size(); }',
    evidence: [{ quote: 'vector<int> a(1000000)', kind: 'wrong', why: '需要对照题目内存限制' }],
    summary: '这份代码的数组尺寸需要核算' })
  assert.equal(result.ok, true, result.reject)
  assert.match(result.mech.verdicts, /MLE.*AC/)
  assert.match(result.evidenceBoundary, /因果.*未核实/)
  const shown = tools.get('coach_diagnose').output.render({}, result)[0].text
  assert.match(shown, /MLE.*AC/)
  assert.match(shown, /因果.*未核实/)
  assert.equal(read('PROGRESS.yaml').nodes.A.diagnoses[0].verification, 'quote-only')
  assert.match((await call('coach_status', {})).recentDiagnoses[0].verification, /quote-only/)
}))

test('two same-day rounds of one problem keep separate completion records when submission anchors differ', async () => fixture(async ({ call, read, dir }) => {
  const db = new DatabaseSync(join(dir, 'unused.db'))
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT);
    CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT,
      problem_id TEXT, verdict TEXT, submitted_at TEXT, cf_sub_id INTEGER, lg_sub_id INTEGER, nc_sub_id INTEGER);
    INSERT INTO users VALUES (1,'trainer','trainer');`)
  const now = Date.now()
  const at = (seconds) => new Date(now - seconds * 1000).toISOString()
  db.prepare(`INSERT INTO unified_submissions
    (id,user_id,platform,problem_id,verdict,submitted_at,cf_sub_id) VALUES (1,1,'codeforces','1067A','AC',?,1)`).run(at(500))
  db.prepare(`INSERT INTO unified_submissions
    (id,user_id,platform,problem_id,verdict,submitted_at,cf_sub_id) VALUES (2,1,'codeforces','1067A','AC',?,2)`).run(at(100))
  db.close()
  const first = await call('coach_log', { node: 'A', problemId: 'CF1067A', solved: true,
    startedAt: at(600), completedAt: at(490), anchorSubmissionId: '1' })
  const second = await call('coach_log', { node: 'A', problemId: 'CF1067A', solved: true,
    startedAt: at(200), completedAt: at(90), anchorSubmissionId: '2' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.replaced, false)
  assert.equal(read('PROGRESS.yaml').nodes.A.passes.length, 2)
  assert.equal(read('SCHEDULE.yaml').days[second.date].actual.length, 2)
}))

test('status suggests one same-day AC for an old untimed record without claiming a full chain', async () => fixture(async ({ call, dir }) => {
  const db = new DatabaseSync(join(dir, 'unused.db'))
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT);
    CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT,
      problem_id TEXT, verdict TEXT, submitted_at TEXT, cf_sub_id INTEGER, lg_sub_id INTEGER, nc_sub_id INTEGER);
    INSERT INTO users VALUES (1,'trainer','trainer');`)
  const now = new Date()
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  db.prepare(`INSERT INTO unified_submissions (id,user_id,platform,problem_id,verdict,submitted_at,cf_sub_id)
    VALUES (1,1,'codeforces','1067A','AC',?,44)`).run(`${localDate}T12:00:00+08:00`)
  db.prepare(`INSERT INTO unified_submissions (id,user_id,platform,problem_id,verdict,submitted_at,cf_sub_id)
    VALUES (2,1,'codeforces','1067B','AC',?,45)`).run(`${localDate}T13:00:00+08:00`)
  db.close()
  assert.equal((await call('coach_log', { node: 'A', problemId: 'CF1067A', solved: true })).ok, true)
  const chain = (await call('coach_status', {})).recentPasses[0].submissionChain
  assert.equal(chain.status, 'unknown')
  assert.equal(chain.candidateAc?.submissionId, '44')
  assert.equal(chain.attempts, undefined)
  assert.equal((await call('coach_log', { node: 'A', problemId: 'CF1067B', solved: false })).ok, true)
  const unfinished = (await call('coach_status', {})).recentPasses.find(pass => pass.problemId === 'CF1067B')
  assert.equal(unfinished.submissionChain.candidateAc, undefined)
}))

test('competency actions bind the diagnostic phase, reject stale or other-unit work, and yield usable evidence', async () => fixture(async ({ call, read }) => {
  const phase = { id: 'read-probe', title: '读题诊断', kind: 'diagnostic', finding: 'unknown', nodes: [], competencies: ['contest-reading'],
    outcome: '确认读题筛选遗漏发生在哪个环节', exitCriteria: '记录一次新的读题诊断观察结果',
    basis: '目前没有读题过程的独立观察记录', goalContribution: '识别区域赛首轮漏读与错误筛选问题', priorityReason: '先观察当前筛选过程再决定训练重点', estimatedHours: 1,
    evidenceRefs: [], uncertainty: '目前缺少读题过程记录无法判断原因', diagnosticMethod: '限时扫描完整题面并解释筛选和放弃理由' }
  const created = await call('coach_curriculum', { action: 'create', expectedRevision: 0, goal: '区域赛读题筛选更稳定', reason: '缺少当前读题事实，先安排一次小诊断建立依据', phases: [phase] })
  assert.equal(created.ok, true, created.reject)
  const action = { competency: 'contest-reading', kind: 'diagnostic', minutes: 15, deliverable: '提交筛选顺序和放弃理由', why: '观察是否遗漏输入限制和可做题', curriculumRevision: created.revision }
  assert.equal((await call('coach_assign', { ...action, curriculumRevision: created.revision - 1 })).accepted, false)
  assert.equal((await call('coach_assign', { ...action, competency: 'contest-decision' })).accepted, false)
  const assigned = await call('coach_assign', action)
  assert.equal(assigned.accepted, true, assigned.reject)
  assert.equal(read('PROGRESS.yaml').pendingActions['competency:contest-reading'].curriculum.phaseId, 'read-probe')
  assert.equal((await call('coach_assign', { node: 'A', deliverable: '提交代码', purpose: 'remediation', routeReason: '补充当前读题阶段的实现基础再回到读题诊断', why: '补齐基础', curriculumRevision: created.revision })).accepted, false)
  const logged = await call('coach_log', { competency: 'contest-reading', problemId: 'probe-1', actualMin: 15, solved: false, independent: false })
  assert.equal(logged.actionCleared, true)
  const state = await call('coach_curriculum', { action: 'read' })
  assert.equal(state.pendingNodes.length, 0)
  assert.equal(state.missingFreshEvidence.length, 0)
  assert.equal(state.evidence[0].competency, 'contest-reading')
}, { cursor: '' }))

test('competency VP can be scheduled and withdrawn without fake nodes', async () => fixture(async ({ call }) => {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const planned = await call('coach_plan', { date, blocks: [{ from: '10:00', competency: 'contest-reading', kind: 'vp', minutes: 300 }] })
  assert.equal(planned.ok, true, planned.reject)
  assert.equal(planned.planned[0].node, '')
  assert.equal(planned.planned[0].competency, 'contest-reading')
  const schedule = await call('coach_schedule', { from: date, days: 1 })
  assert.equal(schedule.days[0].planned[0].nodeName, '比赛读题与筛选')
  assert.equal(schedule.days[0].planned[0].competency, 'contest-reading')
  assert.equal((await call('coach_assign', { competency: 'contest-reading', kind: 'vp', minutes: 300, deliverable: '完成比赛并提交首轮筛选过程' })).accepted, true)
  const withdrawn = await call('coach_unassign', { competency: 'contest-reading', reason: '队友临时有事，本次合练取消' })
  assert.equal(withdrawn.ok, true, withdrawn.reject)
  assert.equal(withdrawn.node, '')
  assert.equal(withdrawn.competency, 'contest-reading')
  const logged = await call('coach_log', { competency: 'contest-reading', problemId: 'VP-test', actualMin: 300, solved: true, independent: true })
  assert.equal(logged.plannedMin, 300)
  assert.equal((await call('coach_schedule', { from: date, days: 1 })).days[0].actual[0].competency, 'contest-reading')
  assert.equal((await call('coach_unplan', { date, all: true })).removed[0].competency, 'contest-reading')
}, { cursor: '' }))

test('explicit durations preserve defaults and reject invalid lengths, busy collisions and overlap atomically', async () => fixture(async ({ call, read, write }) => {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const defaults = await call('coach_plan', { date, blocks: [{ from: '08:00', node: 'A', kind: 'cycle' }, { from: '09:00', node: 'A', kind: 'review' }, { from: '10:00', node: 'A', kind: 'exam' }] })
  assert.equal(defaults.ok, true, defaults.reject)
  assert.deepEqual(defaults.planned.map(block => block.minutes), [60, 25, 90])
  const previous = read('SCHEDULE.yaml')
  for (const minutes of [0, -1, 961]) {
    assert.equal((await call('coach_plan', { date, replace: true, blocks: [{ from: '08:00', node: 'A', kind: 'cycle', minutes }] })).ok, false)
    assert.equal((await call('coach_assign', { node: 'A', kind: 'diagnostic', minutes, deliverable: '提交观察' })).accepted, false)
  }
  for (const minutes of [NaN, Infinity, 1.5]) await assert.rejects(call('coach_plan', { date, replace: true, blocks: [{ from: '08:00', node: 'A', kind: 'cycle', minutes }] }), /invalid arguments/)
  assert.deepEqual(read('SCHEDULE.yaml'), previous)
  assert.equal((await call('coach_assign', { node: 'A', competency: 'contest-reading', deliverable: '提交观察' })).accepted, false)
  assert.equal((await call('coach_assign', { node: 'A', minutes: 15, deliverable: '完成一个很小的迁移题' })).totalMinutes, 35)
  const busy = { version: 1, days: { [date]: { busy: [{ from: '12:00', to: '13:00', label: '上课' }] } } }
  write('SCHEDULE.yaml', busy)
  assert.equal((await call('coach_plan', { date, blocks: [{ from: '10:00', node: 'A', kind: 'vp', minutes: 300 }] })).ok, false)
  assert.deepEqual(read('SCHEDULE.yaml'), busy)
  assert.equal((await call('coach_plan', { date, blocks: [{ from: '08:00', node: 'A', kind: 'diagnostic', minutes: 15 }, { from: '08:10', node: 'A', kind: 'diagnostic', minutes: 15 }] })).ok, false)
  assert.deepEqual(read('SCHEDULE.yaml'), busy)
}))

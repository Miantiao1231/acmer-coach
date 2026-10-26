import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createStrategyStore } from '../lib/strategy.js'
import { createCurriculumStore } from '../lib/curriculum.js'
import { collectEvidence } from '../lib/curriculum-evidence.js'

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

// 「另一个进程」在保存那一刻插进来改文件 —— 时序和真实双开一致：
// 我们读完之后、写之前，账本被别人换了。
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coach-ledger-conflict-'))
  const progress = { nodes: structuredClone(seedNodes), pendingActions: {} }
  const armed = { curriculum: false, target: false }
  const beforeSave = (kind, from, to) => (path) => {
    if (!armed[kind]) return
    armed[kind] = false
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.replace(from, to), 'utf8')
  }
  const strategy = createStrategyStore({ dataDir: dir,
    competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml'),
    beforeSave: beforeSave('target', '第一站', '另一个窗口改的站') })
  const curriculum = createCurriculumStore({ dataDir: dir, loadMap: () => ({ byId }), loadProgress: () => progress,
    loadTarget: () => strategy.target('read'),
    beforeSave: beforeSave('curriculum', '区域赛稳定表现', '另一个窗口改成的目标'),
    now: () => new Date('2026-10-09T12:00:00+08:00') })
  return { dir, progress, strategy, curriculum, armed, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a curriculum write refuses to overwrite a ledger another process changed after load', () => {
  const { dir, curriculum, armed, cleanup } = fixture()
  try {
    const created = curriculum.execute({ action: 'create', expectedRevision: 0,
      goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30, phases: [phase],
      reason: '根据真实训练表现建立课程路线' })
    assert.equal(created.ok, true, created.reject)

    armed.curriculum = true
    const revised = curriculum.execute({ action: 'revise', expectedRevision: created.revision,
      weeklyHours: 25, reason: '另一个窗口按新情况调整每周时间预算' })
    assert.equal(revised.ok, false, '读到旧版本就不能再覆盖')
    assert.match(revised.reject, /另一个|冲突|重新/)
    assert.match(readFileSync(join(dir, 'CURRICULUM.yaml'), 'utf8'), /另一个窗口改成的目标/,
      '冲突时外部写入必须原样保留，不能被旧快照覆盖')
  } finally { cleanup() }
})

test('a target write also detects a ledger changed after load', () => {
  const { dir, strategy, armed, cleanup } = fixture()
  try {
    const first = strategy.target('set', { expectedRevision: 0, contest: '第一站', date: '2026-11-02',
      result: '铜牌', weeklyHours: 25, priorities: [{ id: 'contest-decision', weight: 100 }] })
    assert.equal(first.ok, true, first.reject)

    armed.target = true
    assert.throws(() => strategy.target('set', { expectedRevision: first.revision, contest: '第二站',
      date: '2026-12-15', result: '银牌', weeklyHours: 25, priorities: [{ id: 'contest-decision', weight: 100 }] }),
    /另一个|冲突|重新/)
    assert.match(readFileSync(join(dir, 'TARGET.yaml'), 'utf8'), /另一个窗口改的站/)
  } finally { cleanup() }
})

test('two processes writing the same loaded ledger cannot both succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-ledger-process-'))
  const path = join(dir, 'PROGRESS.yaml')
  writeFileSync(path, 'original')
  const worker = `
    import { bindStamp, writeLedger } from ${JSON.stringify(new URL('../lib/ledger.js', import.meta.url).href)}
    const path = process.argv[1], mark = process.argv[2]
    const doc = bindStamp({}, path)
    process.stdout.write('READY\\n')
    process.stdin.once('data', () => {
      try { writeLedger(path, mark.repeat(8 * 1024 * 1024), doc); process.stdout.write('OK\\n') }
      catch (error) { process.stdout.write('CONFLICT ' + error.message + '\\n') }
    })
  `
  const children = []
  try {
    const contenders = ['A', 'B'].map((mark) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, path, mark],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 })
      children.push(child)
      let output = '', errors = '', isReady = false
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { errors += chunk })
      const ready = new Promise((resolve, reject) => {
        const onData = () => { if (output.includes('READY\n')) { isReady = true; resolve() } }
        child.stdout.on('data', onData)
        child.on('error', reject)
        child.on('close', (code) => { if (!isReady) reject(new Error(`worker closed before ready (${code}): ${errors}`)) })
      })
      const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, output: () => output, errors: () => errors })))
      return { child, ready, done }
    })
    await Promise.all(contenders.map((item) => item.ready))
    for (const { child } of contenders) child.stdin.end('GO\n')
    const results = await Promise.all(contenders.map((item) => item.done))
    for (const result of results) assert.equal(result.code, 0, result.errors())
    const statuses = results.map((result) => result.output().split(/\r?\n/).find((line) => /^(OK|CONFLICT)/.test(line))?.split(' ')[0])
    assert.deepEqual(statuses.sort(), ['CONFLICT', 'OK'], 'one stale writer must be rejected after the other commits')
    assert.match(readFileSync(path, 'utf8'), /^(A+|B+)$/)
  } finally {
    for (const child of children) child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a first course creation refuses to replace a course created after its empty read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-ledger-create-'))
  const progress = { nodes: structuredClone(seedNodes), pendingActions: {} }
  const options = { dataDir: dir, loadMap: () => ({ byId }), loadProgress: () => progress,
    now: () => new Date('2026-10-09T12:00:00+08:00') }
  const args = (goal) => ({ action: 'create', expectedRevision: 0, goal, baseline: '起点已核实',
    weeklyHours: 30, phases: [phase], reason: '根据真实训练表现建立课程路线' })
  const rival = createCurriculumStore(options)
  const primary = createCurriculumStore({ ...options, beforeSave: () => {
    const created = rival.execute(args('另一个进程的课程'))
    assert.equal(created.ok, true, created.reject)
  } })
  try {
    const stale = primary.execute(args('过期快照的课程'))
    assert.equal(stale.ok, false, 'read saw no course, but another process created one before save')
    assert.match(readFileSync(join(dir, 'CURRICULUM.yaml'), 'utf8'), /另一个进程的课程/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a course read keeps the version of the bytes it parsed, not a later replacement', () => {
  const { dir, curriculum, cleanup } = fixture()
  const created = curriculum.execute({ action: 'create', expectedRevision: 0,
    goal: '区域赛稳定表现', baseline: '起点已核实', weeklyHours: 30, phases: [phase],
    reason: '根据真实训练表现建立课程路线' })
  assert.equal(created.ok, true, created.reject)
  const path = join(dir, 'CURRICULUM.yaml')
  const originalRead = fs.readFileSync
  let replaced = false
  try {
    fs.readFileSync = (file, ...args) => {
      const bytes = originalRead(file, ...args)
      if (!replaced && String(file) === path) {
        replaced = true
        writeFileSync(path, String(bytes).replace('区域赛稳定表现', '另一个进程改目标'), 'utf8')
      }
      return bytes
    }
    syncBuiltinESMExports()
    const revised = curriculum.execute({ action: 'revise', expectedRevision: created.revision,
      weeklyHours: 25, reason: '根据比赛安排调整当前每周训练时间' })
    assert.equal(replaced, true)
    assert.equal(revised.ok, false, 'stamping after the read must not bless the old bytes as current')
  } finally {
    fs.readFileSync = originalRead
    syncBuiltinESMExports()
    const onDisk = readFileSync(path, 'utf8')
    cleanup()
    assert.equal(onDisk.includes('另一个进程改目标'), true, 'the other writer must remain on disk')
  }
})

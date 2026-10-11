import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { collectEvidence } from '../lib/curriculum-evidence.js'
import { evaluateExitChecks } from '../lib/curriculum-planning.js'

async function fixture(run, nodeRecord = { status: 'studying' }) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-grading-'))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  try {
    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = join(dir, 'unused.db')
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes:\n  - {id: A, name: 基础, depends: []}\n')
    const path = join(dir, 'PROGRESS.yaml')
    writeFileSync(path, stringify({ version: 1, cursor: 'A', nodes: { A: nodeRecord }, pending: {
      node: 'A', totalMinutes: 90, passScore: 4, maxScore: 6,
      problems: [
        { problemId: 'P1', band: '易', weight: 1, cfRating: 1200, source: 'pool' },
        { problemId: 'P2', band: '中', weight: 2, cfRating: 1600, source: 'pool' },
        { problemId: 'P3', band: '难', weight: 3, cfRating: 1900, source: 'pool' },
      ],
    } }))
    const { apply } = await import(`../index.js?grading=${encodeURIComponent(dir)}`)
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {} })
    await run({ grade: tools.get('coach_grade'), call: (name, args) => tools.get(name).execute(args),
      ledger: () => parse(readFileSync(path, 'utf8')), bytes: () => readFileSync(path, 'utf8') })
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const results = (extra = {}) => ['P1', 'P2', 'P3'].map(problemId => ({ problemId, solved: true, minutes: 15, ...extra }))
const independentExit = ledger => evaluateExitChecks({ exitChecks: [{ node: 'A', minEvents: 1, independent: true }] },
  collectEvidence(ledger), [], '2000-01-01')[0]

test('a passing paper without independence facts cannot create a mastery certificate', async () => {
  await fixture(async ({ grade, ledger }) => {
    const result = await grade.execute({ results: results() })
    assert.equal(result.ok, true)
    assert.equal(result.outcome, 'passed')
    assert.equal(result.status, 'studying')
    assert.equal(result.verified, false)
    assert.equal(result.independence, 'unknown')
    assert.equal(result.verifiedAt, 0)
    const record = ledger().nodes.A
    assert.equal(record.checks[0].independent, undefined)
    assert.equal(record.checks[0].verifiedAt, 0)
    assert.equal(independentExit(ledger()).passed, false, 'unknown independence cannot satisfy the course exit condition')
    assert.equal(ledger().pending, undefined)
    assert.match(grade.output.render({}, result)[0].text, /独立性.*未|未.*独立/)
  })
})

test('a passing paper with a helped solution stays a paper pass without a certificate', async () => {
  await fixture(async ({ grade, ledger }) => {
    const reported = results({ independent: true })
    reported[1].independent = false
    const result = await grade.execute({ results: reported })
    assert.equal(result.outcome, 'passed')
    assert.equal(result.independence, 'assisted')
    assert.equal(result.verified, false)
    assert.equal(result.status, 'studying')
    assert.equal(result.verifiedAt, 0)
    assert.equal(ledger().nodes.A.checks[0].independent, false)
    assert.equal(independentExit(ledger()).passed, false)
    assert.match(grade.output.render({}, result)[0].text, /有帮助/)
  })
})

test('explicitly independent solved problems certify a passing paper and carry the evidence into course checks', async () => {
  await fixture(async ({ grade, ledger }) => {
    const result = await grade.execute({ results: results({ independent: true }) })
    assert.equal(result.verified, true)
    assert.equal(result.status, 'verified')
    assert.equal(result.independence, 'independent')
    assert.equal(result.verifiedAt, 1900)
    assert.equal(ledger().nodes.A.checks[0].independent, true)
    assert.equal(independentExit(ledger()).passed, true)
    assert.equal(ledger().nodes.A.passes, undefined, 'exam records must not invent practice records')
    assert.match(grade.output.render({}, result)[0].text, /不代表隔日.*迁移/)
  })
})

test('weighted passing still requires explicit independence for every solved problem', async () => {
  await fixture(async ({ grade }) => {
    const reported = results({ independent: true })
    delete reported[2].independent
    const result = await grade.execute({ results: reported })
    assert.equal(result.outcome, 'passed')
    assert.equal(result.verified, false)
    assert.equal(result.independence, 'unknown')
  })
  await fixture(async ({ grade }) => {
    const reported = results({ independent: true })
    reported[1] = { problemId: 'P2', solved: false, minutes: 15 }
    const result = await grade.execute({ results: reported })
    assert.equal(result.score, 4)
    assert.equal(result.verified, true, 'the existing weighted pass line remains valid; unsolved problems do not prove mastery')
  })
})

test('explicit independence never certifies a failing or overtime paper', async () => {
  for (const [reported, outcome] of [
    [results({ independent: true, solved: false }), 'failed'],
    [results({ independent: true, minutes: 40 }), 'overTime'],
  ]) await fixture(async ({ grade, ledger }) => {
    const result = await grade.execute({ results: reported })
    assert.equal(result.outcome, outcome)
    assert.equal(result.verified, false)
    assert.equal(result.status, 'studying')
    assert.equal(result.verifiedAt, 0)
    assert.equal(independentExit(ledger()).passed, false)
  })
})

test('unknown or assisted passing records preserve historical verified and learned states', async () => {
  const previousCheck = { date: '2026-09-01', outcome: 'passed', score: 6, maxScore: 6, passScore: 4,
    minutes: 45, limit: 90, verifiedAt: 1600, selfReported: 0, problems: [] }
  for (const status of ['verified', 'learned']) await fixture(async ({ grade, ledger }) => {
    const result = await grade.execute({ results: results() })
    assert.equal(result.status, status)
    assert.equal(result.verified, false, 'status may be historical; verified describes this attempt only')
    assert.equal(result.verifiedAt, 0)
    assert.equal(ledger().nodes.A.at, '2026-09-01')
    assert.deepEqual(ledger().nodes.A.checks[0], previousCheck)
    assert.equal(ledger().nodes.A.checks.length, 2)
  }, { status, at: '2026-09-01', checks: [previousCheck] })
})

test('malformed grading fields and contradictory IDs are rejected without changing the pending paper', async () => {
  await fixture(async ({ grade, bytes }) => {
    const before = bytes()
    for (const invalid of [
      { independent: 'true' }, { independent: null }, { solved: 'true' },
      { minutes: -1 }, { minutes: Infinity }, { minutes: Number.MAX_VALUE }, { minutes: '15' }, { problemId: '' }, { problemId: 'P2' },
    ]) {
      const reported = results()
      Object.assign(reported[0], invalid)
      let rejected
      try { rejected = await grade.execute({ results: reported }) }
      catch (error) {
        assert.equal(error.code, 'INVALID_ARGS', 'the native SDK may reject malformed types before tool execution')
      }
      if (rejected) {
        assert.equal(rejected.ok, false, JSON.stringify(invalid))
        assert.equal(rejected.verified, false)
        assert.equal(rejected.independence, 'unknown')
        for (const key of grade.output.schema.required) assert.ok(key in rejected, `missing refusal field ${key}`)
      }
      assert.equal(bytes(), before)
    }
  })
})

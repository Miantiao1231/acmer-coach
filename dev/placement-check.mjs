import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 定位卷是开卷前置闸的明确例外：新用户还没有教学记录时先用它确认位置；
// 它只记结果、不产生 verified，也不能让下一张验证卷绕过「先讲过」。
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-placement-'))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  try {
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes:\n  - {id: A, name: 基础, depends: [], tags: [testtag]}\n')
    writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\ncursor: A\nnodes: {}\npending: null\n')
    const dbPath = join(dir, 'training.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT, rating INTEGER);
      CREATE TABLE unified_problems (platform TEXT, problem_id TEXT, title TEXT, difficulty REAL, tags TEXT, url TEXT);
      CREATE TABLE unified_submissions (user_id INTEGER, platform TEXT, problem_id TEXT, verdict TEXT, submitted_at TEXT);
      CREATE TABLE diff_rating_map (platform TEXT, diff REAL, cf_rating INTEGER);
      CREATE TABLE rating_history (user_id INTEGER, platform TEXT, rating INTEGER);`)
    db.prepare('INSERT INTO users VALUES (1, ?, ?, 1500)').run('tester', 'tester')
    db.prepare('INSERT INTO rating_history VALUES (1, ?, 1500)').run('codeforces')
    for (const [id, title, difficulty] of [['100A', 'P1', 800], ['100B', 'P2', 1200], ['100C', 'P3', 1800],
      ['100D', 'P4', 850], ['100E', 'P5', 1250], ['100F', 'P6', 1850]]) {
      db.prepare('INSERT INTO unified_problems VALUES (?,?,?,?,?,?)').run('codeforces', id, title, difficulty, 'testtag', '')
    }
    db.close()
    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = dbPath
    const { apply } = await import(`../index.js?placement=${encodeURIComponent(dir)}`)
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {} })
    await run({ call: (name, args) => tools.get(name).execute(args), tool: name => tools.get(name) })
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const verified = '看过题解，正解确实用了这个算法'
const problems = [
  { platform: 'codeforces', problemId: '100A', band: '易', verified },
  { platform: 'codeforces', problemId: '100B', band: '中', verified },
  { platform: 'codeforces', problemId: '100C', band: '难', verified },
]
const results = problems.map((problem) => ({ problemId: problem.problemId, solved: true, minutes: 10, independent: true }))

test('placement mode opens without teaching but does not produce verified or a teaching record', async () => {
  await fixture(async ({ call, tool }) => {
    const blocked = await call('coach_test', { node: 'A', problems })
    assert.equal(blocked.ok, false)
    assert.match(blocked.reject, /尚无教学记录|先讲过/)

    const placed = await call('coach_test', { node: 'A', mode: 'placement', problems })
    assert.equal(placed.ok, true, placed.reject)
    assert.equal(placed.mode, 'placement')
    assert.match(tool('coach_test').output.render({}, placed)[0].text, /定位卷/)

    const graded = await call('coach_grade', { results })
    assert.equal(graded.ok, true, graded.reject)
    assert.equal(graded.mode, 'placement')
    assert.equal(graded.verified, false)
    assert.equal(graded.status, 'none')
    const status = await call('coach_status', {})
    assert.equal(status.recentChecks[0].mode, 'placement')
    assert.equal(status.cursorTaught, '', 'a placement paper must not become teaching contact')

    // 定位之后仍然要先讲；coach_lesson 的收课记录才算教学接触。
    const empty = await call('coach_test', { node: 'A', problems })
    assert.equal(empty.ok, false, 'a placement paper must not open the verification gate by itself')
    await call('coach_lesson', { action: 'start', node: 'A' })
    await call('coach_lesson', { action: 'advance', evidence: '学生能说出状态转移的关键一步' })
    await call('coach_lesson', { action: 'end', outcome: 'unknown', evidence: '讲了一个核心点' })
    const taught = await call('coach_status', {})
    assert.match(taught.cursorTaught, /^\d{4}-\d{2}-\d{2}$/)
    const verify = await call('coach_test', { node: 'A', problems })
    assert.equal(verify.ok, true, verify.reject)
    assert.equal(verify.mode, 'verify')
  })
})


test('two different placement papers passed independently become proven, not verified', async () => {
  await fixture(async ({ call }) => {
    const firstProblems = [
      { platform: 'codeforces', problemId: '100A', band: '易', verified },
      { platform: 'codeforces', problemId: '100B', band: '中', verified },
      { platform: 'codeforces', problemId: '100C', band: '难', verified },
    ]
    const secondProblems = [
      { platform: 'codeforces', problemId: '100D', band: '易', verified },
      { platform: 'codeforces', problemId: '100E', band: '中', verified },
      { platform: 'codeforces', problemId: '100F', band: '难', verified },
    ]
    const round = (list) => list.map((problem) => ({ problemId: problem.problemId, solved: true, minutes: 10, independent: true }))

    assert.equal((await call('coach_test', { node: 'A', mode: 'placement', problems: firstProblems })).ok, true)
    const first = await call('coach_grade', { results: round(firstProblems) })
    assert.equal(first.ok, true, first.reject)
    assert.equal(first.proven, false)
    assert.equal(first.status, 'none')

    assert.equal((await call('coach_test', { node: 'A', mode: 'placement', problems: secondProblems })).ok, true)
    const second = await call('coach_grade', { results: round(secondProblems) })
    assert.equal(second.ok, true, second.reject)
    assert.equal(second.proven, true)
    assert.equal(second.verified, false, 'proven is not a teaching verification')
    assert.equal(second.status, 'proven')

    const status = await call('coach_status', {})
    assert.deepEqual(status.proven, ['A'])
    assert.equal(status.provenCount, 1)
    assert.equal(status.verifiedCount, 0)
    assert.equal(status.studyingCount, 0)
    assert.match(status.recentChecks[1].mode, /placement/)
  })
})

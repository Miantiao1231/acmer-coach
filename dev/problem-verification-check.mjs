import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { DatabaseSync } from 'node:sqlite'
import {
  scopedProblemKey,
  verifiedProblemForNode,
  rejectedProblemForNode,
  recordProblemRejection,
  clearProblemRejection,
} from '../lib/problem-verification.js'

const problem = 'codeforces|1067A'

test('a verified solution belongs to the node it was checked for', () => {
  const ledger = {
    [problem]: { node: '动态规划基础', gist: '题解用动态规划状态转移求解', at: '2026-10-20' },
  }
  assert.equal(verifiedProblemForNode(ledger, problem, '动态规划基础')?.at, '2026-10-20')
  assert.equal(verifiedProblemForNode(ledger, problem, '矩阵加速'), null)
  assert.equal(verifiedProblemForNode({ [problem]: { gist: '旧记录没有知识点归属' } }, problem, '动态规划基础'), null)
})

test('the same problem can be verified for two different nodes independently', () => {
  const ledger = {
    [scopedProblemKey(problem, '矩阵加速')]: { node: '矩阵加速', gist: '题解使用矩阵快速幂处理状态递推', at: '2026-10-20' },
    [scopedProblemKey(problem, '动态规划基础')]: { node: '动态规划基础', gist: '题解解释动态规划状态设计和转移', at: '2026-10-21' },
  }
  assert.equal(verifiedProblemForNode(ledger, problem, '矩阵加速')?.at, '2026-10-20')
  assert.equal(verifiedProblemForNode(ledger, problem, '动态规划基础')?.at, '2026-10-21')
})

test('rejecting a wrong-tag candidate excludes only that node and keeps the reason', () => {
  const rejected = recordProblemRejection({}, problem, '快速幂', '实际正解是矩阵递推，不是标量快速幂', '2026-10-28')
  assert.equal(rejectedProblemForNode(rejected, problem, '快速幂')?.reason, '实际正解是矩阵递推，不是标量快速幂')
  assert.equal(rejectedProblemForNode(rejected, problem, '矩阵加速'), null)
  assert.equal(rejectedProblemForNode(clearProblemRejection(rejected, problem, '快速幂'), problem, '快速幂'), null)
})

test('coach_verify persists node-specific exclusions and clears one on recheck', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-verify-node-'))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  try {
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes:\n  - {id: 快速幂, name: 快速幂, depends: []}\n  - {id: 矩阵加速, name: 矩阵加速, depends: []}\n')
    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = join(dir, 'training.db')
    const db = new DatabaseSync(process.env.COACH_DB)
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT);
      CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT, problem_id TEXT, verdict TEXT);
      CREATE TABLE unified_problems (id INTEGER PRIMARY KEY, platform TEXT, problem_id TEXT, title TEXT, difficulty REAL, tags TEXT, url TEXT);
      CREATE TABLE diff_rating_map (platform TEXT, diff INTEGER, cf_rating INTEGER);
      CREATE TABLE rating_history (id INTEGER PRIMARY KEY, user_id INTEGER, rating INTEGER, recorded_at TEXT, platform TEXT);
      INSERT INTO users VALUES (1,'trainer','trainer');
      INSERT INTO rating_history VALUES (1,1,1800,'2026-10-20','codeforces');
      INSERT INTO unified_problems VALUES
        (1,'codeforces','1067A','题一',1600,'快速幂,矩阵加速',''),
        (2,'codeforces','1067B','题二',1800,'快速幂,矩阵加速',''),
        (3,'codeforces','1067C','题三',2000,'快速幂,矩阵加速',''),
        (4,'codeforces','1067D','题四',2200,'快速幂,矩阵加速','');`)
    db.close()
    const { apply } = await import(`../index.js?problem-node-${Date.now()}-${Math.random()}`)
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {} })
    const verify = tools.get('coach_verify')
    const rejected = await verify.execute({ check: false, problems: [
      { platform: 'codeforces', problemId: '1067A', node: '快速幂', status: 'rejected', reason: '这题实际考的是矩阵状态递推' },
    ] })
    assert.equal(rejected.ok, true, rejected.reject)
    let ledger = parse(readFileSync(join(dir, 'PROGRESS.yaml'), 'utf8'))
    assert.ok(rejectedProblemForNode(ledger.rejected_problems, problem, '快速幂'))
    assert.equal(rejectedProblemForNode(ledger.rejected_problems, problem, '矩阵加速'), null)
    const poolA = await tools.get('coach_pool').execute({ node: '快速幂' })
    const poolB = await tools.get('coach_pool').execute({ node: '矩阵加速' })
    assert.equal(poolA.ok, true, poolA.reject)
    assert.equal(poolB.ok, true, poolB.reject)
    assert.equal(poolA.bands.flatMap((band) => band.candidates).some((item) => item.problemId === '1067A'), false)
    assert.equal(poolB.bands.flatMap((band) => band.candidates).some((item) => item.problemId === '1067A'), true)
    const accepted = await verify.execute({ check: false, problems: [
      { platform: 'codeforces', problemId: '1067A', node: '快速幂', gist: '核对题解后确认这道题可以用于快速幂的专项训练' },
      { platform: 'codeforces', problemId: '1067A', node: '矩阵加速', gist: '核对题解后确认这道题可以用于矩阵加速的专项训练' },
    ] })
    assert.equal(accepted.ok, true, accepted.reject)
    ledger = parse(readFileSync(join(dir, 'PROGRESS.yaml'), 'utf8'))
    assert.equal(rejectedProblemForNode(ledger.rejected_problems, problem, '快速幂'), null)
    assert.ok(verifiedProblemForNode(ledger.verified_problems, problem, '快速幂'))
    assert.ok(verifiedProblemForNode(ledger.verified_problems, problem, '矩阵加速'))
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

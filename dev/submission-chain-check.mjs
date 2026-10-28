import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSubmissionChain } from '../lib/submission-chain.js'

async function withDatabase(rows, run) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-submissions-'))
  const dbPath = join(dir, 'training.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, cf_handle TEXT);
      CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER,
        platform TEXT, problem_id TEXT, verdict TEXT, submitted_at TEXT,
        cf_sub_id INTEGER, lg_sub_id INTEGER, nc_sub_id INTEGER);
      INSERT INTO users VALUES (1, 'Mianiii', 'Mianiii'), (2, 'other', 'other');`)
    const insert = db.prepare(`INSERT INTO unified_submissions
      (id, user_id, platform, problem_id, verdict, submitted_at, cf_sub_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const row of rows) insert.run(...row)
  } finally {
    db.close()
  }
  try { return await run(dbPath) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('one CF1067A lesson includes MLE, two WA and both AC submissions', async () => {
  await withDatabase([
    [1, 1, 'codeforces', '1067A', 'MLE', '2026-10-28T19:47:00+08:00', 1001],
    [2, 1, 'codeforces', '1067A', 'WA', '2026-10-28T19:48:00+08:00', 1002],
    [3, 1, 'codeforces', '1067A', 'WA', '2026-10-28T19:49:00+08:00', 1003],
    [4, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
    [5, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:58:00+08:00', 1005],
  ], async (dbPath) => {
    const result = await readSubmissionChain({
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      startedAt: '2026-10-28T19:26:00+08:00',
      completedAt: '2026-10-28T19:58:00+08:00',
      anchorSubmissionId: 1005,
    })
    assert.equal(result.status, 'linked')
    assert.deepEqual(result.submissions.map((s) => s.submissionId), [1001, 1002, 1003, 1004, 1005])
    assert.deepEqual(result.submissions.map((s) => s.verdict), ['MLE', 'WA', 'WA', 'AC', 'AC'])
    assert.equal(result.attempts, 5)
    assert.equal(result.failed, 3)
    assert.equal(result.accepted, 2)
  })
})

test('the explicit lesson window excludes an older solve and other users or problems', async () => {
  await withDatabase([
    [1, 1, 'codeforces', '1067A', 'WA', '2026-10-21T19:00:00+08:00', 901],
    [2, 1, 'codeforces', '1067A', 'AC', '2026-10-21T19:05:00+08:00', 902],
    [3, 1, 'codeforces', '1067A', 'MLE', '2026-10-28T19:47:00+08:00', 1001],
    [4, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
    [5, 2, 'codeforces', '1067A', 'WA', '2026-10-28T19:48:00+08:00', 2001],
    [6, 1, 'codeforces', '1067AA', 'WA', '2026-10-28T19:48:00+08:00', 3001],
    [7, 1, 'luogu', '1067A', 'WA', '2026-10-28T19:48:00+08:00', null],
  ], async (dbPath) => {
    const result = readSubmissionChain({
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      startedAt: '2026-10-28T19:26:00+08:00',
      completedAt: '2026-10-28T19:50:00+08:00',
      anchorSubmissionId: 1004,
    })
    assert.equal(result.status, 'linked')
    assert.deepEqual(result.submissions.map((s) => s.submissionId), [1001, 1004])
    assert.equal(result.attempts, 2)
  })
})

test('a lagging database cannot turn missing AC submissions into a complete chain', async () => {
  await withDatabase([
    [1, 1, 'codeforces', '1067A', 'MLE', '2026-10-28T19:47:00+08:00', 1001],
    [2, 1, 'codeforces', '1067A', 'WA', '2026-10-28T19:48:00+08:00', 1002],
    [3, 1, 'codeforces', '1067A', 'WA', '2026-10-28T19:49:00+08:00', 1003],
    [4, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
  ], async (dbPath) => {
    const base = {
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      startedAt: '2026-10-28T19:26:00+08:00',
      completedAt: '2026-10-28T19:58:00+08:00',
    }
    for (const args of [{ ...base, anchorSubmissionId: 1005 }, base]) {
      const result = readSubmissionChain(args)
      assert.equal(result.status, 'unknown')
      assert.equal(result.reason, 'anchor-not-synced')
      assert.equal(result.attempts, null)
      assert.deepEqual(result.submissions, [])
    }
  })
})

test('duplicate imported platform submission IDs count once', async () => {
  await withDatabase([
    [1, 1, 'codeforces', '1067A', 'MLE', '2026-10-28T19:47:00+08:00', 1001],
    [2, 1, 'codeforces', '1067A', 'MLE', '2026-10-28T19:47:00+08:00', 1001],
    [3, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
    [4, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
  ], async (dbPath) => {
    const result = readSubmissionChain({
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      startedAt: '2026-10-28T19:26:00+08:00',
      completedAt: '2026-10-28T19:50:00+08:00', anchorSubmissionId: 1004,
    })
    assert.equal(result.status, 'linked')
    assert.equal(result.attempts, 2)
    assert.equal(result.failed, 1)
    assert.deepEqual(result.submissions.map((s) => s.submissionId), [1001, 1004])
  })
})

test('old completion records without a start time remain unlinked', async () => {
  await withDatabase([
    [1, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
  ], async (dbPath) => {
    const result = readSubmissionChain({
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      completedAt: '2026-10-28T19:50:00+08:00', anchorSubmissionId: 1004,
    })
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'missing-time-window')
    const dateOnly = readSubmissionChain({
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      startedAt: '2026-10-28', completedAt: '2026-10-28', anchorSubmissionId: 1004,
    })
    assert.equal(dateOnly.status, 'unknown')
    assert.equal(dateOnly.reason, 'missing-time-window')
  })
})

test('a skipped submission is shown but is not called a failed attempt', async () => {
  await withDatabase([
    [1, 1, 'codeforces', '1067A', 'SKIPPED', '2026-10-28T19:47:00+08:00', 1001],
    [2, 1, 'codeforces', '1067A', 'WA', '2026-10-28T19:48:00+08:00', 1002],
    [3, 1, 'codeforces', '1067A', 'AC', '2026-10-28T19:50:00+08:00', 1004],
  ], async (dbPath) => {
    const result = readSubmissionChain({
      dbPath, trainerHandle: 'Mianiii', platform: 'codeforces', problemId: '1067A',
      startedAt: '2026-10-28T19:26:00+08:00',
      completedAt: '2026-10-28T19:50:00+08:00', anchorSubmissionId: 1004,
    })
    assert.equal(result.status, 'linked')
    assert.equal(result.attempts, 3)
    assert.equal(result.failed, 1)
    assert.equal(result.unresolved, 1)
  })
})

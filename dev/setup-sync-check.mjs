import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { syncCodeforces } from '../lib/setup.js'

test('running Codeforces sync twice does not duplicate the same submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-cf-sync-'))
  const oldFetch = globalThis.fetch
  const body = (result) => ({ ok: true, json: async () => ({ status: 'OK', result }) })
  globalThis.fetch = async (url) => {
    if (String(url).includes('/user.info?')) return body([{ rating: 1800, maxRating: 1800, rank: 'expert' }])
    if (String(url).includes('/user.status?')) return body([{ id: 396411781, creationTimeSeconds: 1793188061,
      verdict: 'MEMORY_LIMIT_EXCEEDED', programmingLanguage: 'GNU C++17', timeConsumedMillis: 31,
      memoryConsumedBytes: 536883200, problem: { contestId: 1067, index: 'A', name: 'Practice', rating: 1800, tags: ['dp'] } }])
    throw new Error(`unexpected URL ${url}`)
  }
  try {
    const dbPath = join(dir, 'training.db')
    const options = { dbPath, handle: 'trainer', problemset: false, DatabaseSync }
    await syncCodeforces(options)
    await syncCodeforces(options)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM unified_submissions WHERE cf_sub_id = 396411781').get().n, 1)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rating_history WHERE user_id = 1 AND platform = 'codeforces'").get().n, 1)
    } finally { db.close() }
  } finally {
    globalThis.fetch = oldFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

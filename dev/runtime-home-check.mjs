import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

test('native DSH_HOME isolates both knowledge and default SQLite; explicit overrides still win', () => {
  const root = mkdtempSync(join(tmpdir(), 'coach-home-'))
  mkdirSync(join(root, 'data'))
  const path = join(root, 'data', 'training.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE fixture(value TEXT)'); db.close()
  const script = `const {coachApi}=await import('./index.js'); const db=await coachApi.openDb();
    console.log(JSON.stringify({knowledge:coachApi.DATA_DIR,db:db.prepare('PRAGMA database_list').get().file})); db.close();`
  try {
    for (const overrides of [false, true]) {
      const env = { ...process.env, DSH_HOME: root }
      delete env.COACH_DATA_DIR; delete env.COACH_DB
      if (overrides) { env.COACH_DATA_DIR = join(root, 'custom-knowledge'); env.COACH_DB = path }
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', windowsHide: true })
      assert.equal(r.status, 0, r.stderr)
      const result = JSON.parse(r.stdout.trim())
      assert.equal(result.knowledge, overrides ? env.COACH_DATA_DIR : join(root, 'knowledge'))
      assert.equal(result.db.replaceAll('\\', '/'), path.replaceAll('\\', '/'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

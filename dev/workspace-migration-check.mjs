import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const target = (contest) => `version: 1\nrevision: 1\nupdated: 2026-10-11T00:51:42.901Z\ncontest: ${contest}\ndate: 2026-10-17\nresult: 保铜争银\nteamMode: team\nweeklyHours: 25\nconstraints: {}\npriorities: []\n`
let startupCount = 0
async function startup(root) {
  const previous = process.env.COACH_DATA_DIR
  const previousDb = process.env.COACH_DB
  process.env.COACH_DATA_DIR = root
  process.env.COACH_DB = join(root, 'unused.db')
  try { await import(`../index.js?workspace-migration=${Date.now()}-${startupCount++}`) }
  finally {
    if (previous === undefined) delete process.env.COACH_DATA_DIR
    else process.env.COACH_DATA_DIR = previous
    if (previousDb === undefined) delete process.env.COACH_DB
    else process.env.COACH_DB = previousDb
  }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'acmer-coach-workspace-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const accountDir = join(root, 'vp-accounts', '6')
  mkdirSync(accountDir, { recursive: true })
  writeFileSync(join(root, 'VP_ACCOUNTS.json'), JSON.stringify({
    version: 1,
    activeAccountId: 6,
    accounts: { 6: { account: { id: 6, handle: 'Mianiii', display_name: 'Mianiii' }, baseUrl: 'https://example.test' } },
  }))
  writeFileSync(join(accountDir, 'TARGET.yaml'), target('账号旧目标'))
  return { root, accountDir, main: join(root, 'TARGET.yaml'), source: join(accountDir, 'TARGET.yaml'), marker: join(accountDir, 'PERSONAL_MIGRATION.json') }
}

test('startup fills missing personal files while retaining their account originals', async (t) => {
  const f = fixture(t)
  await startup(f.root)
  assert.equal(readFileSync(f.main, 'utf8'), target('账号旧目标'))
  assert.equal(readFileSync(f.source, 'utf8'), target('账号旧目标'))
  assert.equal(existsSync(f.marker), true)
})

test('first migration preserves an existing global ledger even when the account mtime is newer', async (t) => {
  const f = fixture(t)
  writeFileSync(f.main, target('合法个人目标'))
  const older = new Date('2026-10-10T12:00:00Z'), newer = new Date('2026-10-12T12:00:00Z')
  utimesSync(f.main, older, older); utimesSync(f.source, newer, newer)
  await startup(f.root)
  assert.equal(readFileSync(f.main, 'utf8'), target('合法个人目标'))
  assert.equal(readFileSync(`${f.main}.from-vp-account-6`, 'utf8'), target('账号旧目标'))
  assert.equal(readFileSync(f.source, 'utf8'), target('账号旧目标'))
})

test('repeated startup never replaces edited global data after old account files change', async (t) => {
  const f = fixture(t)
  await startup(f.root)
  const marker = existsSync(f.marker) ? readFileSync(f.marker, 'utf8') : ''
  writeFileSync(f.main, target('迁移后合法修订'))
  writeFileSync(f.source, target('旧账号后来变化'))
  const newer = new Date('2026-10-12T12:00:00Z')
  utimesSync(f.source, newer, newer)
  await startup(f.root)
  assert.equal(readFileSync(f.main, 'utf8'), target('迁移后合法修订'))
  assert.equal(readFileSync(f.marker, 'utf8'), marker)
})

test('a newer global ledger is also finalized once rather than reconsidered on later account updates', async (t) => {
  const f = fixture(t)
  writeFileSync(f.main, target('已经较新的个人目标'))
  const old = new Date('2026-10-10T12:00:00Z')
  utimesSync(f.source, old, old)
  await startup(f.root)
  writeFileSync(f.source, target('再次变新的旧账号目标'))
  const newer = new Date('2026-10-13T12:00:00Z')
  utimesSync(f.source, newer, newer)
  await startup(f.root)
  assert.equal(readFileSync(f.main, 'utf8'), target('已经较新的个人目标'))
  assert.equal(readFileSync(`${f.main}.from-vp-account-6`, 'utf8'), target('账号旧目标'))
})

test('migration helper preserves existing conflict backups and safely finalizes unmarked accounts', async (t) => {
  const { migratePersonalWorkspace } = await import('../lib/workspace-migration.js')
  const f = fixture(t)
  writeFileSync(f.main, target('合法个人目标'))
  const backup = `${f.main}.from-vp-account-6`
  writeFileSync(backup, target('更早的冲突副本'))
  assert.deepEqual(migratePersonalWorkspace(f.root, 6), [])
  assert.equal(readFileSync(f.main, 'utf8'), target('合法个人目标'))
  assert.equal(readFileSync(backup, 'utf8'), target('更早的冲突副本'))
  assert.equal(readFileSync(f.source, 'utf8'), target('账号旧目标'))
  const marker = JSON.parse(readFileSync(f.marker, 'utf8'))
  assert.equal(marker.files['TARGET.yaml'], 'conflict-preserved')
  writeFileSync(join(f.accountDir, 'PROGRESS.yaml'), 'version: 1\nnodes: {}\n')
  assert.deepEqual(migratePersonalWorkspace(f.root, 6), [])
  assert.equal(existsSync(join(f.root, 'PROGRESS.yaml')), false)
})

test('migration helper validates account paths and skips absent accounts', async (t) => {
  const { migratePersonalWorkspace } = await import('../lib/workspace-migration.js')
  const f = fixture(t)
  for (const accountId of ['../other', '-1', '6/subdir', true]) assert.throws(() => migratePersonalWorkspace(f.root, accountId), /账号 id/)
  assert.deepEqual(migratePersonalWorkspace(f.root, 0), [])
  assert.deepEqual(migratePersonalWorkspace(f.root, 7), [])
  assert.equal(existsSync(f.marker), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('startup migrates legacy personal files out of an active VP account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acmer-coach-workspace-'))
  const accountDir = join(root, 'vp-accounts', '6')
  mkdirSync(accountDir, { recursive: true })
  writeFileSync(join(root, 'VP_ACCOUNTS.json'), JSON.stringify({
    version: 1,
    activeAccountId: 6,
    accounts: { 6: { account: { id: 6, handle: 'Mianiii', display_name: 'Mianiii' }, baseUrl: 'https://example.test' } },
  }))
  writeFileSync(join(root, 'TARGET.yaml'), 'version: 1\nrevision: 1\nupdated: 2026-10-10T20:55:57.385Z\ncontest: 旧目标\ndate: 2026-10-17\nresult: 保铜争银\nteamMode: team\nweeklyHours: 25\nconstraints: {}\npriorities: []\n')
  writeFileSync(join(accountDir, 'TARGET.yaml'), 'version: 1\nrevision: 1\nupdated: 2026-10-11T00:51:42.901Z\ncontest: 西安区域赛\ndate: 2026-10-17\nresult: 保铜争银\nteamMode: team\nweeklyHours: 25\nconstraints: {}\npriorities: []\n')
  const oldTargetTime = new Date('2026-10-10T20:55:57.385Z')
  const newTargetTime = new Date('2026-10-11T00:51:42.901Z')
  const { utimesSync } = await import('node:fs')
  utimesSync(join(root, 'TARGET.yaml'), oldTargetTime, oldTargetTime)
  utimesSync(join(accountDir, 'TARGET.yaml'), newTargetTime, newTargetTime)
  process.env.COACH_DATA_DIR = root
  try {
    await import(`../index.js?workspace-migration=${Date.now()}`)
    assert.equal(existsSync(join(root, 'TARGET.yaml')), true)
    assert.equal(existsSync(join(accountDir, 'TARGET.yaml')), true)
    assert.equal(existsSync(join(root, 'TARGET.yaml.pre-vp-account-6')), true)
    assert.match((await import('node:fs')).readFileSync(join(root, 'TARGET.yaml'), 'utf8'), /contest: 西安区域赛/)
  } finally {
    delete process.env.COACH_DATA_DIR
    rmSync(root, { recursive: true, force: true })
  }
})

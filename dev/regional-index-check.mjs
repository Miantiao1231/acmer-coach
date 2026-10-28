import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createStrategyStore } from '../lib/strategy.js'

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'acmer-regionals-'))
  const store = createStrategyStore({ dataDir,
    competenciesPath: join(process.cwd(), 'assets', 'knowledge', 'COMPETENCIES.yaml') })
  return { dataDir, store }
}

test('regional index is included in the local copy and installed-copy verification manifests', () => {
  const root = process.cwd()
  for (const file of ['dev.sh', 'verify.mjs']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /assets\/knowledge\/CONTEST_INDEX\.json/, file)
  }
  assert.match(readFileSync(join(root, 'dev', 'run-all.sh'), 'utf8'), /regional-index-check\.mjs/)
})

test('offline map CLI uses the same read-only contest query as the plugin', () => {
  const raw = execFileSync(process.execPath, ['--import', './dev/test-env.mjs', 'progress-cli.mjs', 'contests', '2025', '西安', '区域赛'],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, COACH_DATA_DIR: join(tmpdir(), 'unused-regional-cli') } })
  const result = JSON.parse(raw)
  assert.equal(result.ok, true)
  assert.equal(result.contests.length, 1)
  assert.equal(result.contests[0].scoreboard.teamsWith4, 94)
})

test('all workbook rows stay searchable, while only real scoreboard rows carry solved counts', () => {
  const { dataDir, store } = fixture()
  try {
    const result = store.contests()
    assert.equal(result.summary.total, 56)
    assert.equal(result.summary.regionals, 45)
    assert.equal(result.summary.ecFinals, 7)
    assert.equal(result.summary.invitationals, 4)
    assert.equal(result.summary.scoredRegionals, 38)
    assert.equal(result.summary.scoredProblems, 488)
    assert.equal(result.contests.length, 56)
    assert.equal(result.contests.find(item => item.year === 2019 && item.site === '徐州').scoreboard, null)
    assert.equal(existsSync(join(dataDir, 'TARGET.yaml')), false)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('a four-to-five problem comparison includes cohort denominators and source', () => {
  const { dataDir, store } = fixture()
  try {
    const result = store.contests({ year: 2025, site: '西安', category: '区域赛' })
    assert.equal(result.contests.length, 1)
    const contest = result.contests[0]
    assert.equal(contest.sourceRow, 9)
    assert.equal(contest.scoreboard.officialTeams, 399)
    assert.equal(contest.scoreboard.teamsWith4, 94)
    assert.equal(contest.scoreboard.teamsWith5, 82)
    assert.equal(contest.scoreboard.problems.length, 13)
    assert.deepEqual(contest.scoreboard.problems.find(item => item.label === 'I'), {
      id: '8', label: 'I', officialSolved: 155, solvedBy4: 14,
      solvedBy5: 76, attemptedUnsolvedBy4: 71,
    })
    assert.match(contest.scoreboard.source, /board-data\/tree\/[a-f0-9]{40}/)
    assert.equal(store.target('contests', { year: 2025, site: '西安' }).availableContests.length, 1)
    assert.equal(store.contests({ year: 2020, site: '南京' }).contests[0].scoreboard.teamsWith4, 131)
    assert.equal(store.contests({ year: 2019, site: '银川' }).contests[0].scoreboard.teamsWith5, 72)
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('each published cohort summary reconciles against its per-problem counts', () => {
  const { dataDir, store } = fixture()
  try {
    const regionals = store.contests({ category: '区域赛' }).contests
    assert.equal(regionals.length, 45)
    for (const contest of regionals.filter(item => item.scoreboard)) {
      const { officialTeams, teamsWith4, teamsWith5, problems } = contest.scoreboard
      assert.ok(officialTeams > 0 && teamsWith4 > 0 && teamsWith5 > 0, `${contest.year}${contest.site}`)
      assert.equal(problems.reduce((sum, p) => sum + p.solvedBy4, 0), teamsWith4 * 4)
      assert.equal(problems.reduce((sum, p) => sum + p.solvedBy5, 0), teamsWith5 * 5)
      for (const p of problems) {
        assert.ok(p.officialSolved <= officialTeams)
        assert.ok(p.solvedBy4 + p.solvedBy5 <= p.officialSolved)
        assert.ok(p.attemptedUnsolvedBy4 <= teamsWith4 - p.solvedBy4)
      }
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

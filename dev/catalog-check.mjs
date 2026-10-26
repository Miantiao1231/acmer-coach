import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStrategyStore } from '../lib/strategy.js'

const knowledge = new URL('../assets/knowledge/', import.meta.url)
const read = name => YAML.parse(readFileSync(new URL(name, knowledge), 'utf8'))
const mapIds = new Set(read('MAP.yaml').nodes.map(node => node.id))
const competencies = read('COMPETENCIES.yaml').competencies

test('cross-cutting concepts stay on the map without becoming standalone exam units', () => {
  const roles = read('NODE_META.yaml').nodes
  for (const id of ['动态规划基础', '离散化', '图论相关概念', '复杂度']) {
    assert.ok(mapIds.has(id))
    assert.equal(roles[id]?.role, 'integrated')
    assert.equal(roles[id]?.tier, 'core')
  }
  for (const id of ['背包 DP', '线段树', '最短路']) assert.notEqual(roles[id]?.role, 'integrated')
})

function sources(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label}: sources required`)
  for (const source of value) {
    assert.ok(typeof source.title === 'string' && source.title.trim(), `${label}: source title required`)
    const url = new URL(source.url)
    assert.equal(url.protocol, 'https:', `${label}: public HTTPS source required`)
    assert.ok(!url.username && !url.password, `${label}: no account credentials`)
    if (url.search) {
      assert.equal(url.hostname, 'contest.ucup.ac', `${label}: only public official attachments may use query parameters`)
      assert.equal(url.pathname, '/download.php')
      assert.deepEqual([...url.searchParams.keys()].sort(), ['id', 'r', 'type'])
      assert.equal(url.searchParams.get('type'), 'attachments')
      assert.match(url.searchParams.get('id'), /^\d+$/)
      assert.match(url.searchParams.get('r'), /^\d+$/)
    }
    assert.ok(url.pathname !== '/', `${label}: link to evidence, not a homepage`)
  }
}

function textList(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label}: nonempty list required`)
  assert.ok(value.every(item => typeof item === 'string' && item.trim()), `${label}: text required`)
}

test('contest evidence exposes actual reviewed samples, never a complete syllabus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-samples-'))
  try {
    const store = createStrategyStore({ dataDir: dir, competenciesPath: fileURLToPath(new URL('COMPETENCIES.yaml', knowledge)) })
    const profiles = store.target('profiles').availableProfiles
    const regional = profiles.find(profile => profile.id === 'regional-diagnostic')
    assert.equal(regional.coverage.sampledProblems, 70)
    assert.equal(regional.coverage.reviewedSolutions, 70)
    assert.deepEqual(regional.coverage.years, [2022, 2023, 2024, 2025])
    assert.equal(regional.coverage.isSyllabus, false)
    assert.deepEqual(regional.samples.filter(sample => sample.year === 2022).map(sample => sample.problem).sort(), [...'ABCDEFGHIJKLM'])
    assert.equal(new Set(regional.samples.map(sample => `${sample.contest}:${sample.year}:${sample.problem}`)).size, 70)
    const additions = [
      ["Xi'an", 2025, 'ABCDEFGHIJKLM', 'contest.ucup.ac', '/download.php'],
      ['Hangzhou', 2024, 'ABCDEFGHIJKLM', 'contest.ucup.ac', '/download.php'],
      ['Shanghai', 2025, 'ABCDEFGHIJKLM', 'ucup.ac', '/tutorials/tutorials-4-12-zh.pdf'],
      ['Hong Kong', 2025, 'ABCDEFGHIJKL', 'ucup.ac', '/tutorials/tutorials-4-14-en.pdf'],
    ]
    for (const [city, year, letters, host, pathname] of additions) {
      const samples = regional.samples.filter(sample => sample.contest === city && sample.year === year)
      assert.deepEqual(samples.map(sample => sample.problem).sort(), [...letters], `${city}: reviewed full paper`)
      for (const sample of samples) {
        const url = new URL(sample.sourceUrl)
        assert.equal(url.hostname, host)
        assert.equal(url.pathname, pathname)
        assert.match(url.hash, /^#page=[1-9]\d*$/)
        if (city === "Xi'an" || city === 'Hangzhou') {
          assert.equal(url.searchParams.get('type'), 'attachments')
          assert.equal(url.searchParams.get('id'), city === "Xi'an" ? '2562' : '1893')
          assert.equal(url.searchParams.get('r'), '1')
        }
      }
    }
    assert.match(regional.title, /中国|亚洲/)
    for (const sample of regional.samples) {
      assert.ok(sample.model && sample.solutionReviewed)
      if (sample.contest === 'Nanjing') assert.match(sample.sourceUrl, sample.year === 2022
        ? /^https:\/\/sua\.ac\/wiki\/2022-icpc-nanjing\/tutorial-sketch-zh\.pdf#page=\d+$/
        : /^https:\/\/universal-cup-website\.qoj\.ac\/files\/ucup\/tutorials\/tutorials-2-11\.pdf#page=\d+$/)
      assert.ok(sample.competencyIds.every(id => competencies.some(card => card.id === id)))
    }
    const xian = profiles.find(profile => profile.id === 'xian-pending')
    assert.equal(xian.coverage.sampledProblems, 13)
    assert.equal(xian.coverage.reviewedSolutions, 13)
    assert.deepEqual(xian.coverage.years, [2025])
    assert.deepEqual(xian.samples, regional.samples.filter(sample => sample.contest === "Xi'an"))
    assert.equal(xian.coverage.isSyllabus, false)
    assert.equal(store.target('set', { expectedRevision: 0, contest: '区域赛', date: '2026-10-17', result: '稳定', profileId: regional.id, weeklyHours: 25,
      priorities: [{ id: 'graph-modeling', weight: 10 }] }).ok, true)
    assert.equal(store.focus().profile.coverage.sampledProblems, 70)
    assert.equal(store.target('set', { expectedRevision: 1, contest: '西安区域赛', date: '2026-10-17', result: '稳定', profileId: 'xian-pending', weeklyHours: 25,
      priorities: [{ id: 'graph-modeling', weight: 10 }] }).ok, true)
    assert.equal(store.focus().profile.coverage.reviewedSolutions, 13)
    assert.equal(store.focus().profile.id, 'xian-pending')
    assert.equal(profiles.find(profile => profile.id === 'nwerc-reference').coverage.reviewedSolutions, 13)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('contest profiles identify sampling limits and use only existing competencies', () => {
  const catalog = read('CONTEST_PROFILES.yaml')
  const competencyIds = new Set(competencies.map(card => card.id))
  assert.equal(catalog.version, 1)
  assert.ok(catalog.profiles.length >= 3)
  assert.equal(new Set(catalog.profiles.map(profile => profile.id)).size, catalog.profiles.length)
  for (const profile of catalog.profiles) {
    assert.ok(profile.title && profile.scope)
    assert.ok(['provisional', 'reviewed'].includes(profile.status))
    textList(profile.selectionGuidance, `${profile.id}.selectionGuidance`)
    textList(profile.limitations, `${profile.id}.limitations`)
    assert.ok(profile.competencyIds.length > 0)
    for (const id of profile.competencyIds) assert.ok(competencyIds.has(id), `${profile.id}: unknown ${id}`)
    sources(profile.sources, profile.id)
    assert.match(profile.limitations.join(' '), /样本|采样|未核验/)
    assert.doesNotMatch(JSON.stringify(profile), /金牌.*(?:必须|至少)\s*\d+\s*题|必考|命中率/)
  }
  const xian = catalog.profiles.find(profile => profile.id === 'xian-pending')
  assert.ok(xian)
  assert.equal(xian.status, 'provisional')
  assert.match(xian.limitations.join(' '), /不是.*考纲|不能.*预测/)
})

test('general competency mappings reference real nodes and disclose their sources', () => {
  assert.equal(new Set(competencies.map(card => card.id)).size, competencies.length)
  for (const card of competencies) {
    for (const id of card.nodes) assert.ok(mapIds.has(id), `${card.id}: unknown MAP node ${id}`)
    sources(card.sources, card.id)
  }
})

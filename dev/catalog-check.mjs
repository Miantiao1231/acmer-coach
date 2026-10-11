import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import YAML from 'yaml'

const knowledge = new URL('../assets/knowledge/', import.meta.url)
const read = name => YAML.parse(readFileSync(new URL(name, knowledge), 'utf8'))
const mapIds = new Set(read('MAP.yaml').nodes.map(node => node.id))
const competencies = read('COMPETENCIES.yaml').competencies

function sources(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label}: sources required`)
  for (const source of value) {
    assert.ok(typeof source.title === 'string' && source.title.trim(), `${label}: source title required`)
    const url = new URL(source.url)
    assert.equal(url.protocol, 'https:', `${label}: public HTTPS source required`)
    assert.ok(!url.username && !url.password && !url.search, `${label}: no account credentials or query data`)
    assert.ok(url.pathname !== '/', `${label}: link to evidence, not a homepage`)
  }
}

function textList(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label}: nonempty list required`)
  assert.ok(value.every(item => typeof item === 'string' && item.trim()), `${label}: text required`)
}

test('node teaching cards use exact map nodes and contain sourced transfer boundaries', () => {
  const catalog = read('NODE_SCOPES.yaml')
  assert.equal(catalog.version, 1)
  assert.ok(catalog.nodes.length >= 12)
  assert.equal(new Set(catalog.nodes.map(card => card.id)).size, catalog.nodes.length)
  for (const card of catalog.nodes) {
    assert.ok(mapIds.has(card.id), `${card.id}: unknown MAP node`)
    assert.ok(card.title && card.contestUse)
    for (const field of ['recognition', 'proofQuestions', 'appliesTo', 'extensions', 'notFor', 'commonFailures', 'transferProblems', 'exitEvidence']) {
      textList(card[field], `${card.id}.${field}`)
    }
    sources(card.sources, card.id)
  }
  for (const id of ['最短路', '强连通分量', '线段树', '动态规划基础']) {
    assert.ok(catalog.nodes.some(card => card.id === id), `${id}: important boundary card required`)
  }
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

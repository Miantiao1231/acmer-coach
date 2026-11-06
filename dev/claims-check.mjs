import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyPerson, loadPerson, savePerson } from '../lib/person.js'
import { eventForClaim, loadEvents, makeClaim, projectFacts, reduceEvents } from '../lib/claims.js'

const NOW = new Date('2026-10-30T12:00:00')

test('an old person snapshot migrates into claims and keeps its facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    writeFileSync(join(dir, 'person.json'), JSON.stringify({
      version: 1,
      profile: { identity: '小鲸', likes: ['热可可'], dislikes: [], quirks: [], background: [] },
      relation: { milestones: [{ label: '第一次见面', date: '2026-10-01', evidence: '原话' }] },
      habits: [{ situation: '他卡住时', action: '先问', boundary: '', evidence: '原话' }],
      library: [], pending: [], rejected: [], style: [],
      presence: { mode: 'auto', until: '', reason: '' },
      reflection: {},
    }), 'utf8')
    const person = loadPerson(dir, NOW)
    assert.equal(person.profile.identity, '小鲸')
    assert.deepEqual(person.profile.likes, ['热可可'])
    assert.equal(person.relation.milestones.length, 1)
    assert.equal(person.habits.length, 1)
    assert.equal(person.relation.milestones[0].evidence, '原话')
    assert.equal(person.habits[0].evidence, '原话')
    assert.ok(existsSync(join(dir, 'person-events.jsonl')))
    assert.ok(readFileSync(join(dir, 'person-events.jsonl'), 'utf8').includes('第一次见面'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('changing a fact appends a correct event and the projection uses the new value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    const person = emptyPerson(NOW)
    person.habits.push({ id: 'h1', situation: '他卡住时', action: '先问', boundary: '', evidence: '原话', feedback: '', createdAt: NOW.toISOString() })
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir, NOW)
    assert.equal(loaded.habits.length, 1)
    loaded.habits[0].boundary = '不直接给答案'
    assert.equal(savePerson(dir, loaded), true)
    const changed = loadPerson(dir, NOW).habits[0]
    assert.equal(changed.boundary, '不直接给答案')
    assert.equal(changed.evidence, '原话')
    assert.ok(loadEvents(dir).some(event => event.type === 'correct'))

    loaded.relation.milestones.push({ id: 'm1', label: '第一次复盘', date: '2026-10-01', evidence: '他说想复盘', createdAt: NOW.toISOString() })
    assert.equal(savePerson(dir, loaded), true)
    assert.equal(loadPerson(dir, NOW).relation.milestones[0].evidence, '他说想复盘')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('removing a profile item retracts it without deleting history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    const person = emptyPerson(NOW)
    person.profile.likes = ['热可可', '被摸头']
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir, NOW)
    loaded.profile.likes = loaded.profile.likes.filter(item => item !== '热可可')
    assert.equal(savePerson(dir, loaded), true)
    assert.ok(!loadPerson(dir, NOW).profile.likes.includes('热可可'))
    assert.ok(loadEvents(dir).some(event => event.type === 'retract'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('two active identity claims become a visible conflict', () => {
  const claims = reduceEvents([
    eventForClaim('profile', { field: 'identity', text: '小鲸' }),
    eventForClaim('profile', { field: 'identity', text: '别的鲸' }),
  ])
  const facts = projectFacts(claims, { profile: { identity: '小鲸', likes: [], dislikes: [], quirks: [], background: [] } })
  assert.equal(facts.conflicts.length, 1)
  assert.match(facts.conflicts[0].values.join('/'), /小鲸.*别的鲸/)
})

test('accept and reject change claim status without touching the fact text', () => {
  const proposed = eventForClaim('habit', { situation: '他卡住时', action: '先问' }, { status: 'proposed' })
  const accepted = reduceEvents([proposed, { type: 'accept', id: proposed.claim.id, at: NOW.toISOString() }])
  assert.equal(accepted.get(proposed.claim.id).status, 'active')
  const rejectedEvent = makeClaim('habit', { situation: '他走神时', action: '叫一声' }, { status: 'proposed' })
  const rejected = reduceEvents([{ type: 'claim', claim: rejectedEvent }, { type: 'reject', id: rejectedEvent.id, at: NOW.toISOString() }])
  assert.equal(rejected.get(rejectedEvent.id).status, 'rejected')
})

test('shared experiences project in date order and keep their evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    const person = emptyPerson(NOW)
    person.episodes.push(
      { id: 'e1', summary: '第一次一起复盘', at: '2026-10-20', tags: ['复盘'], evidence: '他说想认真复盘', createdAt: NOW.toISOString() },
      { id: 'e2', summary: '他第一次主动说不会', at: '2026-10-28', tags: [], evidence: '这题我真不会', createdAt: NOW.toISOString() },
    )
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir, NOW)
    assert.deepEqual(loaded.episodes.map(item => item.summary), ['他第一次主动说不会', '第一次一起复盘'])
    assert.equal(loaded.episodes[0].evidence, '这题我真不会')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a promise status change is a correction, not a second promise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    const person = emptyPerson(NOW)
    person.promises.push({ id: 'p1', text: '明天问他的进度', dueAt: '2026-10-31', status: 'open', evidence: '他说记得问我', createdAt: NOW.toISOString() })
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir, NOW)
    loaded.promises[0].status = 'done'
    assert.equal(savePerson(dir, loaded), true)
    const promises = loadPerson(dir, NOW).promises
    assert.equal(promises.length, 1)
    assert.equal(promises[0].status, 'done')
    assert.equal(promises[0].evidence, '他说记得问我')
    assert.ok(loadEvents(dir).some(event => event.type === 'correct'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('identity conflict resolution keeps the chosen value and retracts the other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    const { appendEvents, eventForClaim, resolveConflict, loadEvents } = await import('../lib/claims.js')
    appendEvents(dir, [
      eventForClaim('profile', { field: 'identity', text: '小鲸' }),
      eventForClaim('profile', { field: 'identity', text: '别的鲸' }),
    ])
    assert.equal(resolveConflict(dir, 'identity', '小鲸'), true)
    const person = loadPerson(dir, NOW)
    assert.equal(person.profile.identity, '小鲸')
    assert.equal(person.conflicts.length, 0)
    assert.ok(loadEvents(dir).some(event => event.type === 'retract'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

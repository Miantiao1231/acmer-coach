import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifeTick } from '../lib/life-tick.js'
import { advanceLife, loadCompanionState, saveCompanionState } from '../lib/companion-state.js'
import { emptyState, loadState, saveState } from '../lib/proactive-state.js'
import { createProactiveWorker } from '../lib/proactive-worker.js'
import { loadTaskQueue } from '../lib/task-queue.js'
import { emptyPerson, savePerson } from '../lib/person.js'

const BASE = new Date('2000-01-10T10:00:00+08:00')
const later = minutes => new Date(BASE.getTime() + minutes * 60000)
const description = '想把听到的旋律哼成一小段'
const output = JSON.stringify({ description, note: '下次可以接着哼后半段', durationMinutes: 30 })

function fixture(t, { enabled = false, fail = false, beforeReply = null, dailyLimit = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-improv-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const person = emptyPerson(BASE)
  person.boundaries = [{ id: 'private', text: '学生私事不能作为即兴输入', evidence: '学生原话', createdAt: BASE.toISOString() }]
  savePerson(dir, person)
  saveCompanionState(dir, { lastUserAt: '', body: { energy: 77, updatedAt: BASE.toISOString(), energyCheckedAt: BASE.toISOString() },
    roleState: {}, life: { kind: 'idle', source: 'ambient', description: '想听歌', startedAt: BASE.toISOString(), updatedAt: BASE.toISOString() }, journal: {} })
  const state = emptyState(BASE)
  state.settings.lifeImprov = enabled
  state.settings.lifeImprovDailyLimit = dailyLimit
  saveState(dir, state)
  const requests = []
  const llm = { async *stream(request) {
    requests.push(request)
    if (beforeReply) await beforeReply(dir)
    if (fail) throw new Error('fixture offline failure')
    yield { type: 'text-delta', text: output }
  } }
  const tick = () => createLifeTick({ dataDir: dir, allowModel: () => false,
    getRoute: () => ({ provider: 'fixture', model: 'fixture' }), getLlm: () => llm, now: () => BASE })
  return { dir, requests, tick }
}

test('life improvisation has its own opt-in and never spends when disabled or without a route', async t => {
  const f = fixture(t)
  await f.tick()(BASE)
  assert.equal(f.requests.length, 0)
  assert.equal(loadTaskQueue(f.dir).tasks.some(task => task.kind === 'life.improvise'), false)
  const state = loadState(f.dir, BASE)
  assert.equal(state.settings.lifeImprov, false)
  assert.equal(state.settings.lifeImprovDailyLimit, 2)
  state.settings.lifeImprov = true
  saveState(f.dir, state)
  await createLifeTick({ dataDir: f.dir, allowModel: () => false })(BASE)
  assert.equal(loadTaskQueue(f.dir).tasks.some(task => task.kind === 'life.improvise'), false)
})

test('life improvisation is independent, bounded across restart, and caches one simulated plan', async t => {
  const f = fixture(t, { enabled: true })
  await f.tick()(BASE)
  assert.equal(f.requests.length, 1, 'backgroundLlm and proactive contact remain disabled')
  assert.equal(f.requests[0].maxTokens, 256)
  assert.equal(loadState(f.dir, new Date('2050-01-01T00:00:00Z')).lifeImprovBudget.day, '2000-01-10', 'reading at another date must not rewrite the spent-budget day')
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /学生私事不能作为即兴输入/)
  const saved = loadCompanionState(f.dir, BASE)
  assert.equal(saved.life.source, 'model')
  assert.equal(saved.life.description, description)
  assert.equal(saved.life.modelPlan.note, '下次可以接着哼后半段')
  const chatting = advanceLife(saved.life, { now: later(1), lastUserAt: later(1).toISOString() })
  assert.equal(chatting.kind, 'chatting')
  assert.deepEqual(chatting.modelPlan, saved.life.modelPlan)
  const asleep = advanceLife(chatting, { now: later(2), presence: { mode: 'sleep' } })
  assert.equal(asleep.kind, 'resting')
  assert.deepEqual(asleep.modelPlan, saved.life.modelPlan)
  assert.equal(advanceLife(asleep, { now: later(12) }).source, 'model')
  assert.notEqual(advanceLife(asleep, { now: later(31) }).source, 'model')
  await f.tick()(later(60))
  assert.equal(f.requests.length, 1, 'four-hour interval survives a new worker')
  await f.tick()(later(241))
  assert.equal(f.requests.length, 2)
  await f.tick()(later(482))
  assert.equal(f.requests.length, 2, 'daily limit survives another restart')
})

test('failed life improvisations count against durable budget and do not repeat on restart', async t => {
  const f = fixture(t, { enabled: true, fail: true })
  await f.tick()(BASE)
  await f.tick()(later(1))
  assert.equal(f.requests.length, 1)
  await f.tick()(later(241))
  await f.tick()(later(482))
  assert.equal(f.requests.length, 2)
  const tasks = loadTaskQueue(f.dir).tasks.filter(task => task.kind === 'life.improvise')
  assert.equal(tasks.length, 2)
  assert.ok(tasks.every(task => task.state === 'failed' && task.attempts === 1))
})

test('life improvisation preserves a conversation and body update made during generation', async t => {
  const f = fixture(t, { enabled: true, beforeReply: dir => {
    const fresh = loadCompanionState(dir, later(1))
    saveCompanionState(dir, { ...fresh, lastUserAt: later(1).toISOString(),
      body: { ...fresh.body, energy: 33, updatedAt: later(1).toISOString() },
      life: advanceLife(fresh.life, { now: later(1), lastUserAt: later(1).toISOString() }) })
  } })
  await f.tick()(BASE)
  const saved = loadCompanionState(f.dir, later(1))
  assert.equal(saved.lastUserAt, later(1).toISOString())
  assert.equal(saved.body.energy, 33)
  assert.equal(saved.life.kind, 'chatting')
  assert.equal(saved.life.modelPlan.description, description)
})

test('life improvisation settings validate independently and expose effective budget use', async t => {
  const f = fixture(t)
  const worker = createProactiveWorker({ dataDir: f.dir, now: () => BASE, env: { COACH_BACKGROUND_LLM: '0' } })
  for (const value of ['false', '', {}, 0, null, undefined]) {
    assert.equal(worker.setSettings({ lifeImprov: value }).ok, false, 'paid opt-in requires a boolean')
    assert.equal(worker.status().effective.lifeImprov, false)
  }
  assert.equal(worker.setSettings({ lifeImprov: true, lifeImprovDailyLimit: 1 }).ok, true)
  assert.equal(worker.status().effective.lifeImprov, true)
  assert.equal(worker.status().lifeImprovCallsToday, 0)
  assert.equal(worker.setSettings({ lifeImprovDailyLimit: 7 }).ok, false)
  await f.tick()(BASE)
  assert.equal(worker.status().lifeImprovCallsToday, 1)
  assert.equal(worker.status().effective.backgroundLlm, false)
  assert.equal(worker.status().enabled, false)
  await f.tick()(later(241))
  assert.equal(f.requests.length, 1)
})

test('life improvisation waits while chatting or sleeping without reserving budget', async t => {
  const f = fixture(t, { enabled: true })
  const saved = loadCompanionState(f.dir, BASE)
  saveCompanionState(f.dir, { ...saved, lastUserAt: BASE.toISOString() })
  await f.tick()(BASE)
  const night = await f.tick()(new Date('2000-01-10T23:55:00+08:00'))
  assert.equal(night.presence, 'sleep')
  assert.equal(f.requests.length, 0)
  assert.equal(loadTaskQueue(f.dir).tasks.some(task => task.kind === 'life.improvise'), false)
})

test('two life ticks share one durable improvisation reservation', { timeout: 5000 }, async t => {
  let signalStarted, release
  const started = new Promise(resolve => { signalStarted = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture(t, { enabled: true, beforeReply: () => { signalStarted(); return gate } })
  const first = f.tick()(BASE)
  try {
    await Promise.race([started, first.then(() => { throw new Error('tick finished without entering generation') })])
    await f.tick()(BASE)
    assert.equal(f.requests.length, 1)
  } finally { release() }
  await first
  assert.equal(loadTaskQueue(f.dir).tasks.filter(task => task.kind === 'life.improvise').length, 1)
  assert.equal(loadCompanionState(f.dir, BASE).life.modelPlan.description, description)
})

test('life budget survives task-history eviction and an in-flight opt-out prevents plan adoption', async t => {
  const f = fixture(t, { enabled: true, dailyLimit: 1 })
  await f.tick()(BASE)
  const original = loadTaskQueue(f.dir).tasks
  const unrelated = Array.from({ length: 200 }, (_, i) => ({ id: `unrelated-${i}`, kind: 'fixture', state: 'done',
    createdAt: new Date(BASE.getTime() + i + 1).toISOString(), finishedAt: BASE.toISOString() }))
  writeFileSync(join(f.dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [...original, ...unrelated] }))
  assert.equal(loadTaskQueue(f.dir).tasks.some(task => task.kind === 'life.improvise'), false)
  await f.tick()(later(241))
  assert.equal(f.requests.length, 1, 'evicting unrelated queue history cannot restore spent budget')

  const closing = fixture(t, { enabled: true, beforeReply: dir => {
    const state = loadState(dir, BASE)
    state.settings.lifeImprov = false
    saveState(dir, state)
  } })
  await closing.tick()(BASE)
  assert.equal(closing.requests.length, 1)
  assert.equal(loadCompanionState(closing.dir, BASE).life.modelPlan, null, 'disabled while running: do not apply the new plan')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEnergy, parseState, energyMaintenanceDue, maintainEnergy, ENERGY_MAINTENANCE_MS,
  emptyRoleState, normalizeRoleState, roleStateLines,
} from '../lib/state-maintenance.js'

const NOW = new Date('2026-11-01T12:00:00')

test('energy maintenance parses the bounded integer contract', () => {
  assert.deepEqual(parseEnergy('{"energy": 42}'), { energy: 42 })
  assert.deepEqual(parseEnergy('```json\n{"energy": 0}\n```'), { energy: 0 })
  assert.deepEqual(parseEnergy('{"energy": null}'), { energy: null })
  assert.equal(parseEnergy('{"energy": 101}'), null)
  assert.equal(parseEnergy('{"energy": 42.5}'), null)
  assert.equal(parseEnergy('not json'), null)
})

test('energy maintenance is due once per maintenance window', () => {
  assert.equal(energyMaintenanceDue({ energyCheckedAt: '' }, NOW), true)
  assert.equal(energyMaintenanceDue({ energyCheckedAt: '2026-11-01T11:30:00' }, NOW), true)
  assert.equal(energyMaintenanceDue({ energyCheckedAt: '2026-11-01T11:30:01' }, NOW), false)
  assert.equal(energyMaintenanceDue({ energyCheckedAt: '2026-11-01T11:00:00' }, NOW), true)
  assert.ok(ENERGY_MAINTENANCE_MS === 30 * 60 * 1000)
})

test('the maintenance call receives sleep pressure and returns a model energy', async () => {
  let options
  const llm = {
    stream(value) {
      options = value
      return (async function* () {
        yield { type: 'text-delta', text: '{"energy": 63}' }
      })()
    },
  }
  const result = await maintainEnergy({
    llm, route: { provider: 'p', model: 'm' },
    body: { energy: 20, fatigue: 80, sleepDebt: 300, sleepPressure: 70, awakeMinutes: 240, updatedAt: '2026-11-01T11:00:00' },
    profile: {
      sleepDebtMinutes: 300, sleepPressure: 70, awakeMinutes: 240, hasSleepHistory: true,
      latest: {
        kind: 'night', state: 'completed', startedAt: '2026-10-31T23:00:00',
        updatedAt: '2026-11-01T07:00:00', endedAt: '2026-11-01T07:00:00',
        targetMinutes: 480, baseNeedMinutes: 480, sleptSeconds: 8 * 3600,
        interruptions: 1, earlyInterruptions: 0, qualityMin: 70, qualityMax: 90, oversleepMinutes: 0,
      },
    },
    sleepMinutes: 60, workloadScore: 55,
    presence: 'normal', activity: { lesson: false, pending: true, studying: 2 }, now: NOW,
  })
  assert.equal(result.energy, 63)
  const text = options.messages[0].content[0].text
  assert.match(text, /睡眠压力/)
  assert.match(text, /sleep_receipt/)
  assert.match(text, /"pending": true/)
  assert.match(text, /只输出 JSON/)
})

test('role_state is normalized, merged with the previous values and bounded', () => {
  const previous = normalizeRoleState({ mood: '开心', location: '图书馆', conditions: ['嗓子有点干'] }, NOW)
  const parsed = parseState(JSON.stringify({
    energy: 55,
    role_state: {
      hunger: 130, health: 72, sleepiness: 41.5, busy: true,
      mood: '  有点困  ', location: '在教室', cycle: '早八', online_mode: 'busy',
      conditions: ['a', 'b', 'c', 'd', 'e', 'f', ''],
    },
  }), { previousRoleState: previous, now: NOW })
  assert.equal(parsed.energy, 55)
  assert.equal(parsed.roleState.hunger, 100)
  assert.equal(parsed.roleState.health, 72)
  assert.equal(parsed.roleState.sleepiness, 30, 'non-integer falls back to the previous value')
  assert.equal(parsed.roleState.busy, true)
  assert.equal(parsed.roleState.mood, '有点困')
  assert.equal(parsed.roleState.location, '在教室')
  assert.equal(parsed.roleState.cycle, '早八')
  assert.equal(parsed.roleState.onlineMode, 'busy')
  assert.equal(parsed.roleState.conditions.length, 5)

  const partial = parseState('{"role_state":{"hunger":5}}', { previousRoleState: previous, now: NOW })
  assert.equal(partial.energy, null)
  assert.equal(partial.roleState.hunger, 5)
  assert.equal(partial.roleState.mood, '开心')
  assert.deepEqual(partial.roleState.conditions, ['嗓子有点干'])
  assert.equal(parseState('{"role_state":{"mood":"平静"},"energy":101}').energy, null)
  assert.equal(parseState('{"nothing":true}'), null)
})

test('role state lines never claim events and survive damaged values', () => {
  const line = roleStateLines({ hunger: 80, sleepiness: 70, health: 30, busy: true, mood: '烦', location: '在教室', conditions: ['嗓子干'] }, NOW)
  assert.match(line, /有点饿/)
  assert.match(line, /很困/)
  assert.match(line, /身体不太舒服/)
  assert.match(line, /正忙/)
  assert.match(line, /在教室/)
  assert.doesNotMatch(line, /在在/)
  const empty = roleStateLines(null, NOW)
  assert.match(empty, /生活状态/)
  assert.deepEqual(normalizeRoleState({ hunger: 'x', onlineMode: 'nope' }, NOW).hunger, emptyRoleState(NOW).hunger)
})

test('the maintenance payload carries the previous role state', async () => {
  let options
  const llm = {
    stream(value) {
      options = value
      return (async function* () { yield { type: 'text-delta', text: '{"role_state":{"mood":"困困"}}' } })()
    },
  }
  const result = await maintainEnergy({
    llm, route: { provider: 'p', model: 'm' }, body: {}, roleState: { mood: '开心', hunger: 30 }, now: NOW,
  })
  assert.equal(result.energy, null)
  assert.equal(result.roleState.mood, '困困')
  assert.equal(result.roleState.hunger, 30)
  assert.match(options.messages[0].content[0].text, /previous_role_state/)
  assert.match(options.messages[0].content[0].text, /"mood": "开心"/)
})

test('a failed or empty maintenance call leaves the caller free to keep the old energy', async () => {
  const failed = await maintainEnergy({
    llm: { stream: () => { throw new Error('offline') } },
    route: { provider: 'p', model: 'm' }, body: {}, now: NOW,
  })
  assert.equal(failed, null)
  const empty = await maintainEnergy({
    llm: { stream: () => (async function* () { yield { type: 'text-delta', text: '{"energy": null}' } })() },
    route: { provider: 'p', model: 'm' }, body: {}, now: NOW,
  })
  assert.deepEqual(empty, { energy: null })
})

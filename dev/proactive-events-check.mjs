import test from 'node:test'
import assert from 'node:assert/strict'
import {
  eventAllowed, recordEvent, pruneEvents, eventKeyOf, eventCooldownMinutes,
  scheduleFollowup, followupDue, clearFollowup,
  enqueueDelivery, queuedDeliveryDue, finishQueuedDelivery, dropQueuedDelivery,
  MAX_EVENTS,
} from '../lib/proactive-events.js'
import { emptyState, normalizeState, noteUser } from '../lib/proactive-state.js'

const at = (value) => new Date(value)
const NOW = at('2026-11-02T12:00:00')

test('the event ledger blocks the same topic inside its cooldown', () => {
  const state = emptyState(NOW)
  const candidate = { id: 'meal:午饭', kind: 'meal', purpose: 'care', topic: '午饭', cooldownMinutes: 0 }
  assert.equal(eventKeyOf(candidate), 'meal:午饭')
  assert.equal(eventCooldownMinutes(candidate), 360)
  assert.equal(eventAllowed(state, candidate, NOW), true)
  recordEvent(state, candidate, { at: NOW, status: 'sent', contactId: 'c1' })
  assert.equal(eventAllowed(state, candidate, at('2026-11-02T14:00:00')), false)
  assert.equal(eventAllowed(state, candidate, at('2026-11-02T18:01:00')), true)
  const short = { ...candidate, cooldownMinutes: 30 }
  assert.equal(eventAllowed(state, short, at('2026-11-02T12:31:00')), true)
  for (let index = 0; index < MAX_EVENTS + 10; index += 1) {
    recordEvent(state, { id: `x:${index}`, kind: 'x', topic: `t${index}` }, { at: NOW })
  }
  assert.equal(state.eventLedger.length, MAX_EVENTS)
})

test('the ledger keeps only the last week of events', () => {
  const state = emptyState(NOW)
  recordEvent(state, { id: 'old:1', topic: '旧' }, { at: at('2026-10-01T10:00:00') })
  recordEvent(state, { id: 'new:1', topic: '新' }, { at: NOW })
  pruneEvents(state, NOW)
  assert.deepEqual(state.eventLedger.map((event) => event.key), ['new:1'])
})

test('a follow-up fires only while the loop is still open', () => {
  const state = emptyState(NOW)
  assert.equal(scheduleFollowup(state, {
    contactId: 'c1', at: NOW, purpose: 'care', topic: '午饭', body: '吃了吗', minutes: 25, expiresMinutes: 120,
  }) !== null, true)
  assert.equal(followupDue(state, at('2026-11-02T12:10:00')), null, 'not due yet')
  assert.equal(followupDue(state, at('2026-11-02T12:26:00'))?.contactId, 'c1')
  state.lastUserAt = at('2026-11-02T12:05:00').toISOString()
  assert.equal(followupDue(state, at('2026-11-02T12:30:00')), null, 'he already replied')
  state.lastUserAt = ''
  assert.equal(followupDue(state, at('2026-11-02T15:00:00')), null, 'window expired')
  clearFollowup(state)
  assert.equal(state.followup, null)

  const skipped = emptyState(NOW)
  assert.equal(scheduleFollowup(skipped, { contactId: 'c2', at: NOW, purpose: 'nudge', minutes: 25 }), null)
  const unprompted = emptyState(NOW)
  scheduleFollowup(unprompted, { contactId: 'c3', at: NOW, purpose: 'care', minutes: 25, expiresMinutes: 120 })
  unprompted.unanswered = 2
  assert.equal(followupDue(unprompted, at('2026-11-02T12:30:00')), null)
})

test('a failed delivery is retried verbatim and then dropped', () => {
  const state = emptyState(NOW)
  const item = enqueueDelivery(state, { body: '在吗', purpose: 'care', topic: '午饭', at: NOW, contactId: 'c1' })
  assert.ok(item)
  assert.equal(queuedDeliveryDue(state, at('2026-11-02T12:00:30')), null, 'one minute backoff')
  assert.equal(queuedDeliveryDue(state, at('2026-11-02T12:01:30'))?.id, item.id)
  finishQueuedDelivery(state, item.id, { ok: false, at: at('2026-11-02T12:01:30'), error: 'offline' })
  assert.equal(state.queue[0].attempts, 1)
  assert.ok(Date.parse(state.queue[0].nextAt) > at('2026-11-02T12:01:30').getTime())
  finishQueuedDelivery(state, item.id, { ok: true, at: at('2026-11-02T12:05:00') })
  assert.equal(state.queue.length, 0)

  const other = enqueueDelivery(state, { body: 'x', at: NOW })
  finishQueuedDelivery(state, other.id, { ok: false, at: NOW })
  finishQueuedDelivery(state, other.id, { ok: false, at: NOW })
  finishQueuedDelivery(state, other.id, { ok: false, at: NOW })
  assert.equal(state.queue.length, 0, 'three failed attempts drop the item')
  const third = enqueueDelivery(state, { body: 'y', at: NOW })
  dropQueuedDelivery(state, third.id)
  assert.equal(state.queue.length, 0)
})

test('the new workflow fields survive a save/load round trip', () => {
  const state = emptyState(NOW)
  state.tokensToday = 1234
  recordEvent(state, { id: 'meal:午饭', kind: 'meal', purpose: 'care', topic: '午饭' }, { at: NOW })
  scheduleFollowup(state, { contactId: 'c1', at: NOW, purpose: 'care', minutes: 25, expiresMinutes: 120 })
  enqueueDelivery(state, { body: '在吗', at: NOW })
  const loaded = normalizeState(JSON.parse(JSON.stringify(state)), NOW)
  assert.equal(loaded.tokensToday, 1234)
  assert.equal(loaded.eventLedger.length, 1)
  assert.equal(loaded.followup.contactId, 'c1')
  assert.equal(loaded.queue.length, 1)

  noteUser(loaded, at('2026-11-02T12:10:00'), '在')
  assert.equal(loaded.followup, null)
  assert.equal(loaded.queue.length, 0)
})

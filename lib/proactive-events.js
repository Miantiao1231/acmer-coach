// Proactive event ledger, follow-up, and delivery queue.
//
// The original keeps a typed event ledger with (id, revision) dedupe, an
// open-loop follow-up that fires when a sent message went unanswered, and a
// durable delivery queue with retries. dsh-coach kept one candidate per tick
// with no memory of what fired, so the same event could repeat and a failed
// send was simply dropped.
const clean = (value) => String(value ?? '').trim()
const DAY_MS = 86400000
const MAX_EVENTS = 120
const EVENT_TTL_DAYS = 7
const MAX_QUEUE = 5
const QUEUE_TTL_MS = 30 * 60 * 1000
const MAX_ATTEMPTS = 3

// Purposes worth a second, softer line when he did not answer the first.
export const FOLLOWUP_PURPOSES = new Set(['care', 'share', 'tease', 'checkin', 'miss', 'pending', 'promise', 'target'])

export function eventKeyOf(candidate) {
  return clean(candidate?.id) || `${clean(candidate?.kind)}:${clean(candidate?.topic).slice(0, 60)}`
}

export function eventCooldownMinutes(candidate) {
  const value = Number(candidate?.cooldownMinutes)
  if (Number.isFinite(value) && value > 0) return Math.min(10080, Math.round(value))
  // Default: the same event key does not fire twice within six hours.
  return 360
}

export function eventAllowed(state, candidate, now = new Date()) {
  const key = eventKeyOf(candidate)
  if (!key || key === ':') return false
  const last = (state?.eventLedger ?? []).find((event) => event.key === key && event.status === 'sent')
  if (!last) return true
  const at = Date.parse(last.at)
  if (!Number.isFinite(at)) return true
  return now.getTime() - at >= eventCooldownMinutes(candidate) * 60000
}

export function recordEvent(state, candidate, { at = new Date(), status = 'sent', contactId = '' } = {}) {
  if (!state) return null
  const key = eventKeyOf(candidate)
  if (!key || key === ':') return null
  const event = {
    key,
    kind: clean(candidate.kind).slice(0, 40),
    purpose: clean(candidate.purpose).slice(0, 40),
    status: ['sent', 'skipped', 'held', 'failed'].includes(status) ? status : 'skipped',
    contactId: clean(contactId).slice(0, 120),
    at: at.toISOString(),
    revision: Number.isInteger(candidate.revision) ? candidate.revision : 0,
  }
  state.eventLedger = [...(Array.isArray(state.eventLedger) ? state.eventLedger : []), event]
    .slice(-MAX_EVENTS)
  return event
}

export function pruneEvents(state, now = new Date()) {
  if (!state) return
  state.eventLedger = (Array.isArray(state.eventLedger) ? state.eventLedger : [])
    .filter((event) => {
      const at = Date.parse(event?.at ?? '')
      return Number.isFinite(at) && now.getTime() - at <= EVENT_TTL_DAYS * DAY_MS
    })
    .slice(-MAX_EVENTS)
}

// ---- follow-up -------------------------------------------------------------

// Scheduled once per sent contact. `at` is the moment the original message was
// sent, so a later user reply invalidates the follow-up instead of stacking a
// second message on top of an answered thread.
export function scheduleFollowup(state, { contactId, at = new Date(), purpose, topic, body, minutes = 25, expiresMinutes = 120 } = {}) {
  if (!state) return null
  if (minutes <= 0 || !FOLLOWUP_PURPOSES.has(clean(purpose))) {
    state.followup = null
    return null
  }
  state.followup = {
    contactId: clean(contactId).slice(0, 120),
    purpose: clean(purpose).slice(0, 40),
    topic: clean(topic).slice(0, 200),
    body: clean(body).slice(0, 600),
    at: at.toISOString(),
    dueAt: new Date(at.getTime() + minutes * 60000).toISOString(),
    expiresAt: new Date(at.getTime() + expiresMinutes * 60000).toISOString(),
    attempts: 0,
  }
  return state.followup
}

export function followupDue(state, now = new Date()) {
  const item = state?.followup
  if (!item) return null
  const due = Date.parse(item.dueAt)
  const expires = Date.parse(item.expiresAt)
  const sentAt = Date.parse(item.at)
  if (!Number.isFinite(due) || !Number.isFinite(expires)) return null
  // He replied after the original message: the open loop is closed.
  const lastUser = Date.parse(state.lastUserAt ?? '')
  if (Number.isFinite(lastUser) && Number.isFinite(sentAt) && lastUser > sentAt) return null
  if ((state.unanswered ?? 0) >= 2) return null
  if (now.getTime() > expires) return null
  return now.getTime() >= due ? item : null
}

export function clearFollowup(state) {
  if (state) state.followup = null
}

// ---- delivery queue --------------------------------------------------------

export function enqueueDelivery(state, {
  body = '', purpose = '', topic = '', at = new Date(), error = '', contactId = '', source = '',
} = {}) {
  if (!state) return null
  const item = {
    id: `q-${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    contactId: clean(contactId).slice(0, 120),
    body: clean(body).slice(0, 600),
    purpose: clean(purpose).slice(0, 40),
    topic: clean(topic).slice(0, 200),
    source: clean(source).slice(0, 80),
    at: at.toISOString(),
    nextAt: new Date(at.getTime() + 60000).toISOString(),
    expiresAt: new Date(at.getTime() + QUEUE_TTL_MS).toISOString(),
    attempts: 0,
    error: clean(error).slice(0, 200),
  }
  state.queue = [...(Array.isArray(state.queue) ? state.queue : []), item].slice(-MAX_QUEUE)
  return item
}

export function queuedDeliveryDue(state, now = new Date()) {
  const item = (state?.queue ?? []).find((entry) => {
    const next = Date.parse(entry?.nextAt ?? '')
    const expires = Date.parse(entry?.expiresAt ?? '')
    return Number.isFinite(next) && Number.isFinite(expires)
      && now.getTime() >= next && now.getTime() <= expires && (entry.attempts ?? 0) < MAX_ATTEMPTS
  })
  return item ?? null
}

export function finishQueuedDelivery(state, id, { ok = false, at = new Date(), error = '' } = {}) {
  if (!state) return
  const list = Array.isArray(state.queue) ? state.queue : []
  const index = list.findIndex((entry) => entry.id === id)
  if (index < 0) return
  if (ok) { list.splice(index, 1); return }
  const item = list[index]
  item.attempts = (item.attempts ?? 0) + 1
  item.error = clean(error).slice(0, 200)
  item.nextAt = new Date(at.getTime() + Math.min(10 * 60000, 60000 * 2 ** item.attempts)).toISOString()
  if (item.attempts >= MAX_ATTEMPTS) list.splice(index, 1)
}

export function dropQueuedDelivery(state, id) {
  if (!state) return
  state.queue = (Array.isArray(state.queue) ? state.queue : []).filter((entry) => entry.id !== id)
}

export { MAX_ATTEMPTS, QUEUE_TTL_MS, MAX_EVENTS, EVENT_TTL_DAYS }

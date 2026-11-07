// Busy-hours reply gate.
//
// Port of companion_v2 conversation/busy_gate.py. While the role's own calendar
// says she is busy, a passive message is answered late (60–300s) instead of
// instantly; urgent messages and direct commands cut through. What he sent
// during the window is kept, and released as one hint after the window ends —
// without that, "busy" and "offline" feel the same to him.
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'busy-gate.json'
const VERSION = 1
const MAX_BACKLOG = 8

// Same shape as the rest gate's boundary scoring: the urgent class cuts through
// the gate entirely, a direct command is answered because it usually cannot
// wait, and a "在吗" gets answered late but not ignored.
const URGENT = /救命|出事|急(?!性子)|紧急|不舒服|难受|害怕|崩溃|报警|医院|摔了|好痛|来不及/
const COMMAND = /^(?:帮我|给我|快|马上|立刻|现在就|现在能|能不能|回我|看看|看一下|讲一下|讲下|说下)/
const POLITE = /^(?:在吗|在不在|忙吗|你忙|打扰)/
const WAKE = /醒醒|别忙了|先别忙|回我一下|快回/

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

export function busyBoundary(text) {
  const value = String(text ?? '').replace(/\s+/g, '')
  if (!value) return { score: 0, reason: 'empty' }
  if (URGENT.test(value)) return { score: 100, reason: 'urgent' }
  if (WAKE.test(value)) return { score: 95, reason: 'asked_to_stop' }
  if (COMMAND.test(value)) return { score: 90, reason: 'command' }
  if (POLITE.test(value)) return { score: 60, reason: 'checks_if_busy' }
  return { score: 0, reason: 'normal' }
}

export function emptyBusyGateState() {
  return { version: VERSION, busyUntil: '', recoveryUntil: '', last: null, backlog: [] }
}

export function normalizeBusyGateState(raw) {
  const base = emptyBusyGateState()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const iso = (value) => {
    const at = stamp(value)
    return at === null ? '' : new Date(at).toISOString()
  }
  return {
    ...base,
    busyUntil: iso(raw.busyUntil),
    recoveryUntil: iso(raw.recoveryUntil),
    last: raw.last && typeof raw.last === 'object' && !Array.isArray(raw.last)
      ? { event: clean(raw.last.event).slice(0, 120), delayMs: Math.max(0, Number(raw.last.delayMs) || 0), reason: clean(raw.last.reason).slice(0, 60) }
      : null,
    backlog: (Array.isArray(raw.backlog) ? raw.backlog : [])
      .map((entry) => {
        const at = stamp(entry?.at)
        const text = clean(entry?.text).slice(0, 300)
        return at === null || !text ? null : { at: new Date(at).toISOString(), text, reason: clean(entry?.reason).slice(0, 60) }
      })
      .filter(Boolean)
      .slice(-MAX_BACKLOG),
  }
}

export function loadBusyGateState(dataDir) {
  return normalizeBusyGateState(readJsonFile(dataDir, FILE))
}

function saveBusyGateState(dataDir, state) {
  return updateJsonFile(dataDir, FILE, (current) => {
    // 两个会话共享数据目录：保留另一方刚写的 backlog/busyUntil，别用旧快照覆盖。
    const latest = normalizeBusyGateState(current)
    // release 是显式清空：不能把 latest 里刚交还的旧条目再拼回来。
    if (state.last?.event === 'release') {
      return normalizeBusyGateState({ ...latest, ...state, backlog: [] })
    }
    const merged = new Map()
    for (const item of [...latest.backlog, ...state.backlog]) {
      merged.set(`${item.at}\u0000${item.text}`, item)
    }
    return normalizeBusyGateState({
      ...latest,
      ...state,
      backlog: [...merged.values()].slice(-MAX_BACKLOG),
    })
  }, normalizeBusyGateState).ok
}

// Pure decision. `presence` is the effective presence, which carries `until`
// for an explicit busy window.
export function busyGateDecision({ text = '', now = new Date(), presence = null, settings } = {}) {
  const decision = { action: 'reply', reason: 'not_busy', delayMs: 0, boundary: 'not_busy', score: 0, until: '' }
  if (!settings?.busyGate) return { ...decision, reason: 'disabled' }
  if (presence?.mode !== 'busy') return decision

  const until = stamp(presence.until)
  decision.until = until === null ? '' : new Date(until).toISOString()
  const boundary = busyBoundary(text)
  decision.score = boundary.score
  decision.boundary = boundary.reason
  if (boundary.score >= Number(settings.busyUrgentThreshold ?? 85)) {
    return { ...decision, action: 'reply', reason: boundary.reason }
  }
  // A busy window with no end time still delays, but only by the minimum: there
  // is no point making him wait for a deadline that may never arrive.
  const remaining = until === null ? 0 : Math.max(0, (until - now.getTime()) / 1000)
  const seconds = Math.min(
    Number(settings.busyMaxDelaySeconds ?? 300),
    Math.max(Number(settings.busyMinDelaySeconds ?? 60), remaining),
  )
  return { ...decision, action: 'hold', reason: 'busy', delayMs: Math.round(seconds * 1000) }
}

// The one entry point. Mirrors evaluateRestGate: judge once, persist the
// consequence, and hand back the backlog only on the turn where she is actually
// free again.
export function evaluateBusyGate(dataDir, { text = '', now = new Date(), presence = null, settings } = {}) {
  const state = loadBusyGateState(dataDir)
  const decision = busyGateDecision({ text, now, presence, settings })
  let next = state
  let backlog = []

  if (decision.action === 'hold') {
    const entry = { at: now.toISOString(), text: clean(text).slice(0, 300), reason: decision.reason }
    const kept = entry.text
      ? [...state.backlog, entry].slice(-MAX_BACKLOG)
      : state.backlog
    next = {
      ...state,
      busyUntil: decision.until || state.busyUntil,
      last: { event: 'hold', delayMs: decision.delayMs, reason: decision.reason },
      backlog: kept,
    }
  } else if (presence?.mode === 'busy') {
    // Urgent message while still busy: answer it, keep what is still queued.
    next = { ...state, busyUntil: decision.until || state.busyUntil, last: { event: 'reply', delayMs: 0, reason: decision.reason } }
  } else {
    const busyUntil = stamp(state.busyUntil)
    const graceMs = Math.max(0, Number(settings?.busyRecoveryMinutes) || 0) * 60000
    const inGrace = busyUntil !== null && now.getTime() >= busyUntil && now.getTime() - busyUntil <= graceMs
    if (inGrace && state.backlog.length) {
      backlog = state.backlog.slice()
      next = {
        ...state,
        backlog: [],
        recoveryUntil: new Date(busyUntil + graceMs).toISOString(),
        last: { event: 'release', delayMs: 0, reason: 'busy_ended' },
      }
      decision.reason = 'busy_ended'
    } else if (state.last?.event !== 'idle') {
      next = { ...state, busyUntil: '', recoveryUntil: '', last: { event: 'idle', delayMs: 0, reason: decision.reason } }
    }
  }

  if (next !== state) saveBusyGateState(dataDir, next)
  return { decision, backlog, state: next }
}

export { MAX_BACKLOG }

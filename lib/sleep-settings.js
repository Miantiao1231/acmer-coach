// Sleep schedule and rest-gate settings. Env overrides a small JSON file so the
// panel can later save the same keys without changing the runtime.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'sleep-settings.json'
const DEFAULTS = {
  time: '23:30',
  timezone: '',
  minutes: 480,
  windowMinutes: 60,
  variationMinutes: 30,
  napEnabled: true,
  napMinutes: 25,
  restGate: true,
  restMode: 'probability',
  restProbability: 18,
  restThreshold: 65,
  restWindows: '23:00-08:30,12:20-13:40',
  restGraceMinutes: 30,
  restBacklog: 4,
  maxDeferSeconds: 60,
  // 忙时回复门：她说「手头有事」的时段，被动消息晚一点回。
  busyGate: true,
  busyMinDelaySeconds: 60,
  busyMaxDelaySeconds: 300,
  busyUrgentThreshold: 85,
  busyRecoveryMinutes: 10,
  // 收尾沉默：道别/应声已经收完的一轮不再开新回合。
  closingGuard: true,
  closingWindowMinutes: 20,
  closingAckSeconds: 90,
}

const clamp = (value, low, high, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback
}
const bool = (value, fallback) => value === undefined || value === null ? fallback
  : !(value === false || value === '0' || value === 'off' || value === 0)

export function parseClock(value, fallback = '23:30') {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? '').trim())
  if (!match) return parseClock(fallback, '23:30')
  const hour = Number(match[1]) % 24
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute, minutes: hour * 60 + minute, text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
}

export function parseRestWindows(value) {
  const text = String(value ?? '').replace(/[：—–－~～至到]/g, ':')
  const windows = []
  for (const part of text.split(/[,;；，、]+/)) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part.replace(/\s+/g, ''))
    if (!match) continue
    const start = (Number(match[1]) % 24) * 60 + Math.min(59, Number(match[2]))
    let end = (Number(match[3]) % 24) * 60 + Math.min(59, Number(match[4]))
    if (end <= start) end += 24 * 60
    windows.push([start, end])
  }
  return windows
}

export function sanitizeSleepSettings(raw = {}) {
  const clock = parseClock(raw.time, DEFAULTS.time)
  return {
    time: clock.text,
    timezone: String(raw.timezone ?? '').trim().slice(0, 80),
    minutes: Math.round(clamp(raw.minutes, 1, 1440, DEFAULTS.minutes)),
    windowMinutes: Math.round(clamp(raw.windowMinutes, 0, 240, DEFAULTS.windowMinutes)),
    variationMinutes: Math.round(clamp(raw.variationMinutes, 0, 120, DEFAULTS.variationMinutes)),
    napEnabled: bool(raw.napEnabled, DEFAULTS.napEnabled),
    napMinutes: Math.round(clamp(raw.napMinutes, 5, 180, DEFAULTS.napMinutes)),
    restGate: bool(raw.restGate, DEFAULTS.restGate),
    restMode: ['probability', 'llm'].includes(raw.restMode) ? raw.restMode : DEFAULTS.restMode,
    restProbability: Math.round(clamp(raw.restProbability, 0, 100, DEFAULTS.restProbability)),
    restThreshold: Math.round(clamp(raw.restThreshold, 1, 100, DEFAULTS.restThreshold)),
    restWindows: String(raw.restWindows ?? DEFAULTS.restWindows).slice(0, 200),
    restGraceMinutes: Math.round(clamp(raw.restGraceMinutes, 0, 240, DEFAULTS.restGraceMinutes)),
    restBacklog: Math.round(clamp(raw.restBacklog, 1, 32, DEFAULTS.restBacklog)),
    maxDeferSeconds: Math.round(clamp(raw.maxDeferSeconds, 5, 900, DEFAULTS.maxDeferSeconds)),
    busyGate: bool(raw.busyGate, DEFAULTS.busyGate),
    busyMinDelaySeconds: Math.round(clamp(raw.busyMinDelaySeconds, 5, 600, DEFAULTS.busyMinDelaySeconds)),
    busyMaxDelaySeconds: Math.round(clamp(raw.busyMaxDelaySeconds, 15, 1800, DEFAULTS.busyMaxDelaySeconds)),
    busyUrgentThreshold: Math.round(clamp(raw.busyUrgentThreshold, 1, 100, DEFAULTS.busyUrgentThreshold)),
    busyRecoveryMinutes: Math.round(clamp(raw.busyRecoveryMinutes, 0, 240, DEFAULTS.busyRecoveryMinutes)),
    closingGuard: bool(raw.closingGuard, DEFAULTS.closingGuard),
    closingWindowMinutes: Math.round(clamp(raw.closingWindowMinutes, 1, 240, DEFAULTS.closingWindowMinutes)),
    closingAckSeconds: Math.round(clamp(raw.closingAckSeconds, 10, 600, DEFAULTS.closingAckSeconds)),
  }
}

function envSettings(env) {
  return {
    ...(env.COACH_SLEEP_TIME !== undefined ? { time: env.COACH_SLEEP_TIME } : {}),
    ...(env.COACH_SLEEP_TIMEZONE !== undefined ? { timezone: env.COACH_SLEEP_TIMEZONE } : {}),
    ...(env.COACH_SLEEP_MINUTES !== undefined ? { minutes: env.COACH_SLEEP_MINUTES } : {}),
    ...(env.COACH_SLEEP_WINDOW_MINUTES !== undefined ? { windowMinutes: env.COACH_SLEEP_WINDOW_MINUTES } : {}),
    ...(env.COACH_SLEEP_VARIATION_MINUTES !== undefined ? { variationMinutes: env.COACH_SLEEP_VARIATION_MINUTES } : {}),
    ...(env.COACH_NAP_ENABLED !== undefined ? { napEnabled: env.COACH_NAP_ENABLED } : {}),
    ...(env.COACH_NAP_MINUTES !== undefined ? { napMinutes: env.COACH_NAP_MINUTES } : {}),
    ...(env.COACH_REST_GATE !== undefined ? { restGate: env.COACH_REST_GATE } : {}),
    ...(env.COACH_REST_MODE !== undefined ? { restMode: env.COACH_REST_MODE } : {}),
    ...(env.COACH_REST_PROBABILITY !== undefined ? { restProbability: env.COACH_REST_PROBABILITY } : {}),
    ...(env.COACH_REST_THRESHOLD !== undefined ? { restThreshold: env.COACH_REST_THRESHOLD } : {}),
    ...(env.COACH_REST_WINDOWS !== undefined ? { restWindows: env.COACH_REST_WINDOWS } : {}),
    ...(env.COACH_REST_GRACE_MINUTES !== undefined ? { restGraceMinutes: env.COACH_REST_GRACE_MINUTES } : {}),
    ...(env.COACH_REST_BACKLOG !== undefined ? { restBacklog: env.COACH_REST_BACKLOG } : {}),
    ...(env.COACH_REST_MAX_DEFER_SECONDS !== undefined ? { maxDeferSeconds: env.COACH_REST_MAX_DEFER_SECONDS } : {}),
    ...(env.COACH_BUSY_GATE !== undefined ? { busyGate: env.COACH_BUSY_GATE } : {}),
    ...(env.COACH_BUSY_MIN_DELAY_SECONDS !== undefined ? { busyMinDelaySeconds: env.COACH_BUSY_MIN_DELAY_SECONDS } : {}),
    ...(env.COACH_BUSY_MAX_DELAY_SECONDS !== undefined ? { busyMaxDelaySeconds: env.COACH_BUSY_MAX_DELAY_SECONDS } : {}),
    ...(env.COACH_BUSY_URGENT_THRESHOLD !== undefined ? { busyUrgentThreshold: env.COACH_BUSY_URGENT_THRESHOLD } : {}),
    ...(env.COACH_BUSY_RECOVERY_MINUTES !== undefined ? { busyRecoveryMinutes: env.COACH_BUSY_RECOVERY_MINUTES } : {}),
    ...(env.COACH_CLOSING_GUARD !== undefined ? { closingGuard: env.COACH_CLOSING_GUARD } : {}),
    ...(env.COACH_CLOSING_WINDOW_MINUTES !== undefined ? { closingWindowMinutes: env.COACH_CLOSING_WINDOW_MINUTES } : {}),
    ...(env.COACH_CLOSING_ACK_SECONDS !== undefined ? { closingAckSeconds: env.COACH_CLOSING_ACK_SECONDS } : {}),
  }
}

export function loadSleepSettings(dataDir, env = process.env) {
  let stored = {}
  try { stored = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')) } catch { /* first run */ }
  return sanitizeSleepSettings({ ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}), ...envSettings(env) })
}

export function saveSleepSettings(dataDir, settings) {
  const path = join(dataDir, FILE)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(sanitizeSleepSettings(settings), null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}

export function localParts(date, timezone = '') {
  if (timezone) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(date).map((part) => [part.type, part.value]))
      return {
        year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
        hour: Number(parts.hour) % 24, minute: Number(parts.minute),
      }
    } catch { /* fall through to machine local */ }
  }
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() }
}

export function localMinutes(date, timezone = '') {
  const parts = localParts(date, timezone)
  return parts.hour * 60 + parts.minute
}

export function localDay(date, timezone = '') {
  const parts = localParts(date, timezone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function restWindowActive(settings, now) {
  const windows = parseRestWindows(settings.restWindows)
  if (!windows.length) return true
  const minutes = localMinutes(now, settings.timezone)
  return windows.some(([start, end]) => (start <= minutes && minutes < end)
    || (start <= minutes + 1440 && minutes + 1440 < end))
}

function variation(settings, dateKey) {
  const span = settings.variationMinutes
  if (!span) return 0
  let hash = 2166136261
  for (const ch of `${dateKey}:${settings.time}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619)
  return ((hash >>> 0) % (span * 2 + 1)) - span
}

function zonedTime(parts, timezone = '') {
  if (!timezone) return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0)
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let value = target
  for (let i = 0; i < 2; i += 1) {
    const actual = localParts(new Date(value), timezone)
    value += target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
  }
  return new Date(value)
}

// Bedtime for one local calendar day, including the per-day jitter. Exported
// because the sleep ledger materializes missed nights and must agree with the
// runtime's window exactly.
export function bedtimeForDate(parts, settings) {
  const clock = parseClock(settings.time, DEFAULTS.time)
  const date = new Date(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0, 0)
  date.setMinutes(date.getMinutes() + variation(settings, `${parts.year}-${parts.month}-${parts.day}`))
  return zonedTime({
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: date.getHours(), minute: date.getMinutes(),
  }, settings.timezone)
}

// The bedtime whose local wall time is closest to `now` (today or yesterday).
export function bedtimeAround(now, settings) {
  let parts = localParts(now, settings.timezone)
  let start = bedtimeForDate(parts, settings)
  if (start.getTime() > now.getTime()) {
    const previous = new Date(parts.year, parts.month - 1, parts.day - 1, 12, 0, 0, 0)
    parts = { year: previous.getFullYear(), month: previous.getMonth() + 1, day: previous.getDate(), hour: 0, minute: 0 }
    start = bedtimeForDate(parts, settings)
  }
  return start
}

export function nextBedtime(now, settings) {
  const parts = localParts(now, settings.timezone)
  let value = bedtimeForDate(parts, settings)
  if (value.getTime() <= now.getTime()) {
    const next = new Date(parts.year, parts.month - 1, parts.day + 1)
    value = bedtimeForDate({
      year: next.getFullYear(), month: next.getMonth() + 1, day: next.getDate(), hour: 12, minute: 0,
    }, settings)
  }
  return value
}

export function sleepWindow(now, settings) {
  const start = bedtimeAround(now, settings)
  const end = new Date(start.getTime() + settings.minutes * 60000)
  const startParts = localParts(start, settings.timezone)
  const endParts = localParts(end, settings.timezone)
  return {
    start, end,
    startMinutes: startParts.hour * 60 + startParts.minute,
    endMinutes: endParts.hour * 60 + endParts.minute,
  }
}

export { DEFAULTS as DEFAULT_SLEEP_SETTINGS }

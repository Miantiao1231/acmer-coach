// Daily 04:00 patrol.
//
// The original humanized.py runs a local, model-free patrol once per day at
// 04:00, records the day's state, and trims the history to 30 days. It is the
// reason a "day" has a boundary even when nobody talked at midnight.
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'state-patrol.json'
const VERSION = 1
const KEEP_DAYS = 30
const PATROL_HOUR = 4
const pad = (value) => String(value).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const clean = (value) => String(value ?? '').trim()
const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value)))

export function emptyPatrol() {
  return { version: VERSION, entries: [] }
}

export function normalizePatrol(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return emptyPatrol()
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.day ?? '')))
    .map((entry) => ({
      day: entry.day,
      at: clean(entry.at).slice(0, 40),
      energy: Math.round(clamp(entry.energy ?? 0, 0, 100)),
      mood: clean(entry.mood).slice(0, 40),
      sleepDebt: Math.round(clamp(entry.sleepDebt ?? 0, 0, 720)),
      journal: Boolean(entry.journal),
      note: clean(entry.note).slice(0, 120),
    }))
    .sort((a, b) => a.day.localeCompare(b.day))
  return { version: VERSION, entries: entries.slice(-KEEP_DAYS) }
}

export function loadPatrol(dataDir) {
  return normalizePatrol(readJsonFile(dataDir, FILE))
}

// Before 04:00 the day has not turned yet: the patrol for "today" belongs to
// yesterday's date, and it only fires once the clock reaches 04:00.
export function patrolDay(now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // Before 04:00 today's patrol has not run yet: the pending one belongs to
  // yesterday. At/after 04:00 the new local day is the one to record.
  if (now.getHours() < PATROL_HOUR) day.setDate(day.getDate() - 1)
  const dueAt = new Date(day)
  dueAt.setHours(PATROL_HOUR, 0, 0, 0)
  return { day: ymd(day), dueAt }
}

// Returns the day whose patrol is missing, or '' when it already ran. A process
// that starts at 05:00 catches up the 04:00 it missed exactly once.
export function patrolCatchUpDay(store, now = new Date()) {
  const { day, dueAt } = patrolDay(now)
  if (now.getTime() < dueAt.getTime()) return ''
  return store?.entries?.some((entry) => entry.day === day) ? '' : day
}

export function recordPatrol(dataDir, {
  now = new Date(), body = null, roleState = null, journal = null, note = '',
} = {}) {
  const { day, dueAt } = patrolDay(now)
  if (now.getTime() < dueAt.getTime()) return { ok: false, reject: '还没到 04:00' }
  if (loadPatrol(dataDir).entries.some((entry) => entry.day === day)) {
    return { ok: false, reject: '今天已经巡逻过' }
  }
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizePatrol(current)
    if (store.entries.some((entry) => entry.day === day)) return null
    store.entries.push({
      day,
      at: now.toISOString(),
      energy: body?.energy ?? 0,
      mood: roleState?.mood ?? '',
      sleepDebt: body?.sleepDebt ?? 0,
      journal: Boolean(journal?.text),
      note,
    })
    return store
  }, normalizePatrol)
  if (!result.ok) return { ok: false, reject: '巡逻写入失败' }
  return { ok: true, day, entry: result.value?.entries?.at(-1) ?? null }
}

export { KEEP_DAYS, PATROL_HOUR, ymd as patrolDayKey }

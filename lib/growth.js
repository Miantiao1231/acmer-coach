// Growth receipts.
//
// The original turns completed life/journal receipts into a progress_note,
// keeps it pending until a human accepts it, and only then feeds it back. Here
// the note is deterministic (no model) and one per day; acceptance is a POST on
// the coach page.
import { readJsonFile, updateJsonFile } from './json-store.js'
import { actualSleepMinutes } from './sleep-ledger.js'

const FILE = 'growth-notes.json'
const VERSION = 1
const MAX_NOTES = 60

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const pad = (value) => String(value).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

export function emptyGrowth() {
  return { version: VERSION, notes: [] }
}

export function normalizeGrowth(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return emptyGrowth()
  const notes = (Array.isArray(raw.notes) ? raw.notes : [])
    .filter((note) => note && /^\d{4}-\d{2}-\d{2}$/.test(String(note.day ?? '')) && clean(note.text))
    .map((note) => ({
      day: note.day,
      text: clean(note.text).slice(0, 300),
      evidence: Array.isArray(note.evidence) ? note.evidence.map((id) => clean(id).slice(0, 80)).filter(Boolean).slice(0, 12) : [],
      status: ['pending', 'accepted', 'dropped'].includes(note.status) ? note.status : 'pending',
      createdAt: clean(note.createdAt).slice(0, 40),
      acceptedAt: clean(note.acceptedAt).slice(0, 40),
    }))
    .sort((a, b) => a.day.localeCompare(b.day))
  return { version: VERSION, notes: notes.slice(-MAX_NOTES) }
}

export function loadGrowth(dataDir) {
  return normalizeGrowth(readJsonFile(dataDir, FILE))
}

export function buildGrowthNote({ day, activities = [], journal = null, sleepLedger = null } = {}) {
  const done = (activities ?? []).filter((activity) => activity.state === 'completed'
    && String(activity.createdAt ?? '').slice(0, 10) === day)
  const reading = done.find((activity) => activity.kind === 'reading')
  const night = (sleepLedger?.episodes ?? []).find((episode) => episode.kind === 'night'
    && String(episode.endedAt ?? episode.updatedAt ?? '').slice(0, 10) === day)
  const bits = []
  if (reading) bits.push(`读了 ${Math.round(reading.minutes || 0)} 分钟书`)
  if (journal?.text) bits.push('写了日记')
  if (night) {
    const minutes = Math.round(actualSleepMinutes(night))
    if (minutes > 0) bits.push(`睡了 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`)
  }
  if (!bits.length) return null
  return {
    day,
    text: `${day.slice(5)} 这天${bits.join('，')}。`,
    evidence: done.map((activity) => activity.id).slice(0, 8),
    status: 'pending',
  }
}

export function addGrowthNote(dataDir, note, { now = new Date() } = {}) {
  if (!note?.day || !clean(note.text)) return { ok: false, reject: '没有可记录的小结' }
  let saved = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeGrowth(current)
    if (store.notes.some((item) => item.day === note.day)) return null
    store.notes.push({
      day: note.day,
      text: clean(note.text).slice(0, 300),
      evidence: Array.isArray(note.evidence) ? note.evidence.slice(0, 12) : [],
      status: 'pending',
      createdAt: now.toISOString(),
      acceptedAt: '',
    })
    saved = store.notes.at(-1)
    return store
  }, normalizeGrowth)
  if (!result.ok) return { ok: false, reject: '写入失败' }
  return { ok: Boolean(saved), note: saved }
}

export function acceptGrowthNote(dataDir, { day, accept = true, now = new Date() } = {}) {
  let changed = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeGrowth(current)
    const note = store.notes.find((item) => item.day === day)
    if (!note || note.status !== 'pending') return null
    note.status = accept ? 'accepted' : 'dropped'
    note.acceptedAt = now.toISOString()
    changed = note
    return store
  }, normalizeGrowth)
  return result.ok && changed ? { ok: true, note: changed } : { ok: false, reject: '没有待确认的小结' }
}

export function pendingGrowthNotes(store, limit = 3) {
  return (store?.notes ?? []).filter((note) => note.status === 'pending').slice(-limit)
}

export function growthLine(store, now = new Date()) {
  const pending = pendingGrowthNotes(store, 1)
  if (!pending.length) return ''
  const note = pending[0]
  const age = Math.round((now.getTime() - Date.parse(`${note.day}T12:00:00`)) / 86400000)
  if (!Number.isFinite(age) || age > 3) return ''
  return `- 还没确认的小结（${note.day}）：${note.text}这是你自己的记录，他没确认前别当成他的评价。`
}

export { MAX_NOTES }

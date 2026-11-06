// Periodic private-dialogue episodes.
//
// The original does not keep a second memory store: an episode is bounded
// material offered to the existing reflection pass, with a cursor that only
// advances after the batch landed. Thresholds keep V1's names: 8 messages or
// 90 minutes.
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'memory-cursor.json'
const VERSION = 1
const REFRESH_MESSAGES = 8
const REFRESH_MINUTES = 90
const MAX_LINES = 40
const MAX_LINE_CHARS = 200
const MIN_SOURCE_CHARS = 80

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

export function loadEpisodeCursor(dataDir) {
  const raw = readJsonFile(dataDir, FILE)
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) {
    return { version: VERSION, coveredThrough: '', updatedAt: '' }
  }
  return {
    version: VERSION,
    coveredThrough: Number.isFinite(Date.parse(raw.coveredThrough)) ? raw.coveredThrough : '',
    updatedAt: clean(raw.updatedAt).slice(0, 40),
  }
}

export function markEpisodeCovered(dataDir, { coveredThrough, now = new Date() } = {}) {
  if (!Number.isFinite(Date.parse(coveredThrough))) return false
  const result = updateJsonFile(dataDir, FILE, () => ({
    version: VERSION, coveredThrough, updatedAt: now.toISOString(),
  }))
  return result.ok
}

export function episodeDue(entries, cursor, {
  now = new Date(), refreshMessages = REFRESH_MESSAGES, refreshMinutes = REFRESH_MINUTES,
} = {}) {
  const since = Date.parse(cursor?.coveredThrough ?? '')
  const fresh = (Array.isArray(entries) ? entries : [])
    .filter((entry) => {
      const at = Date.parse(entry?.at ?? '')
      return Number.isFinite(at) && (!Number.isFinite(since) || at > since) && at <= now.getTime()
    })
  if (fresh.length >= refreshMessages) return true
  if (!fresh.length) return false
  return now.getTime() - Date.parse(fresh[0].at) >= refreshMinutes * 60000
}

// Returns the bounded material plus the cursor the caller advances only after a
// reflection batch actually lands.
export function episodeMaterial(entries, cursor, {
  now = new Date(), maxLines = MAX_LINES, maxLineChars = MAX_LINE_CHARS,
  minChars = MIN_SOURCE_CHARS,
} = {}) {
  const since = Date.parse(cursor?.coveredThrough ?? '')
  const fresh = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ at: Date.parse(entry?.at ?? ''), text: clean(entry?.text) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.text
      && (!Number.isFinite(since) || entry.at > since) && entry.at <= now.getTime())
    .sort((a, b) => a.at - b.at)
    .slice(-maxLines)
    .map((entry) => ({ at: new Date(entry.at).toISOString(), text: entry.text.slice(0, maxLineChars) }))
  const chars = fresh.reduce((total, entry) => total + entry.text.length, 0)
  if (chars < minChars) return null
  return {
    lines: fresh,
    chars,
    coveredThrough: fresh.at(-1)?.at ?? '',
    from: fresh[0]?.at ?? '',
  }
}

export { REFRESH_MESSAGES, REFRESH_MINUTES, MIN_SOURCE_CHARS }

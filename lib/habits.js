// Repeated private utterances as soft habit candidates.
//
// Ported from the original habits.py: count repeated original wording, never
// interpret subject/polarity, require N occurrences on N distinct local days,
// weight stale evidence down, and cap the list. No model call.
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'habit-candidates.json'
const VERSION = 1
const MIN_COUNT = 3
const MIN_DAYS = 3
const MAX_ITEMS = 24
const RECENCY_DAYS = 30
const MIN_TEXT = 2
const MAX_TEXT = 40

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const pad = (value) => String(value).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

// Signature keeps the raw wording (the original counts wording, not meaning).
function signatureOf(text) {
  return clean(text).toLowerCase().replace(/[，。！？、,.!?~～\s]+/g, '')
}

export function emptyHabitStore() {
  return { version: VERSION, items: [] }
}

export function normalizeHabitStore(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return emptyHabitStore()
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .filter((item) => item && typeof item.sig === 'string' && item.sig)
    .map((item) => ({
      sig: item.sig.slice(0, 80),
      text: clean(item.text).slice(0, MAX_TEXT),
      count: Math.max(0, Math.round(Number(item.count) || 0)),
      days: [...new Set((Array.isArray(item.days) ? item.days : []).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))].slice(-90),
      firstAt: clean(item.firstAt).slice(0, 40),
      lastAt: clean(item.lastAt).slice(0, 40),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 120)
  return { version: VERSION, items }
}

export function loadHabitStore(dataDir) {
  return normalizeHabitStore(readJsonFile(dataDir, FILE))
}

export function observeHabit(dataDir, { text = '', now = new Date() } = {}) {
  const value = clean(text)
  if (value.length < MIN_TEXT || value.length > MAX_TEXT) return null
  const sig = signatureOf(value)
  if (!sig) return null
  const day = ymd(now)
  let saved = null
  updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeHabitStore(current)
    const item = store.items.find((entry) => entry.sig === sig)
    if (item) {
      item.count += 1
      if (!item.days.includes(day)) item.days.push(day)
      item.lastAt = now.toISOString()
    } else {
      store.items.push({
        sig, text: value.slice(0, MAX_TEXT), count: 1, days: [day],
        firstAt: now.toISOString(), lastAt: now.toISOString(),
      })
    }
    saved = store
    return store
  }, normalizeHabitStore)
  return saved
}

export function qualifiedHabits(store, {
  now = new Date(), minCount = MIN_COUNT, minDays = MIN_DAYS, maxItems = MAX_ITEMS,
  recencyDays = RECENCY_DAYS,
} = {}) {
  const floor = now.getTime() - recencyDays * 86400000
  return (store?.items ?? [])
    .filter((item) => item.count >= minCount && item.days.length >= minDays
      && Number.isFinite(Date.parse(item.lastAt)) && Date.parse(item.lastAt) >= floor)
    .sort((a, b) => (b.count - a.count) || String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, maxItems)
}

export function habitLines(habits) {
  if (!habits?.length) return ''
  return `- 他反复说过的原话（出现 ${habits.length} 组，别当结论，只作语气参考）：${habits.slice(0, 4).map((item) => `「${item.text}」×${item.count}`).join('、')}。`
}

export { MIN_COUNT, MIN_DAYS, MAX_ITEMS, RECENCY_DAYS }

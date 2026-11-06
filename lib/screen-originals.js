// Screen originals.
//
// 默认只保存摘要与来源。显式保留的原件兼容旧档案，最多 40 张、7 天。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'screen-captures.json'
const DIR = 'screen-originals'
const VERSION = 1
const MAX_CAPTURES = 40
const KEEP_MS = 7 * 24 * 3600 * 1000

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

export function emptyScreenCaptures() {
  return { version: VERSION, captures: [] }
}

export function normalizeScreenCaptures(raw) {
  const base = emptyScreenCaptures()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const captures = (Array.isArray(raw.captures) ? raw.captures : [])
    .filter((item) => item && clean(item.id) && stamp(item.at) !== null)
    .map((item) => ({
      id: clean(item.id).slice(0, 60),
      at: new Date(stamp(item.at)).toISOString(),
      sha256: clean(item.sha256).slice(0, 64),
      bytes: Math.max(0, Number(item.bytes) || 0),
      width: Number.isFinite(Number(item.width)) ? Number(item.width) : null,
      height: Number.isFinite(Number(item.height)) ? Number(item.height) : null,
      summary: clean(item.summary).slice(0, 160),
      kind: clean(item.kind).slice(0, 20) || 'other',
      confidence: clean(item.confidence).slice(0, 10) || 'low',
      consentId: clean(item.consentId).slice(0, 60),
      retained: item.retained !== false,
      deleted: item.deleted === true,
    }))
    .sort((a, b) => a.at.localeCompare(b.at))
  return { version: VERSION, captures: captures.slice(-MAX_CAPTURES) }
}

export function loadScreenCaptures(dataDir) {
  return normalizeScreenCaptures(readJsonFile(dataDir, FILE))
}

export function originalPath(dataDir, id) {
  return join(dataDir, DIR, `${String(id).replace(/[^a-z0-9-]/gi, '')}.jpg`)
}

export function saveScreenCapture(dataDir, { image, observation, consentId = '', now = new Date(), retainOriginal = false } = {}) {
  if (!image?.data?.length || !observation?.summary) return { ok: false, reject: '没有可保存的截图。' }
  const id = `scr-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const sha256 = createHash('sha256').update(image.data).digest('hex')
  try {
    if (retainOriginal) {
      mkdirSync(join(dataDir, DIR), { recursive: true })
      writeFileSync(originalPath(dataDir, id), image.data)
    }
  } catch {
    return { ok: false, reject: '截图原件写入失败。' }
  }
  let saved = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = pruneStore(normalizeScreenCaptures(current), now)
    const entry = {
      id, at: now.toISOString(), sha256, bytes: image.data.length,
      width: image.width ?? null, height: image.height ?? null,
      summary: clean(observation.summary).slice(0, 160),
      kind: clean(observation.kind) || 'other',
      confidence: clean(observation.confidence) || 'low',
      consentId: clean(consentId),
      retained: retainOriginal === true,
      deleted: false,
    }
    saved = entry
    return { version: VERSION, captures: [...store.captures, entry].slice(-MAX_CAPTURES) }
  }, normalizeScreenCaptures)
  if (!result.ok || !saved) { try { rmSync(originalPath(dataDir, id), { force: true }) } catch { /* ignore */ } return { ok: false, reject: '截图索引写入失败。' } }
  pruneFiles(dataDir, result.value?.captures ?? [saved])
  return { ok: true, capture: saved }
}

export function latestScreenCapture(store, { now = new Date(), maxAgeMs = 24 * 3600 * 1000 } = {}) {
  return (store?.captures ?? [])
    .filter((item) => !item.deleted && (stamp(item.at) ?? 0) >= now.getTime() - maxAgeMs)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1) ?? null
}

export function readScreenOriginal(dataDir, id) {
  try { return readFileSync(originalPath(dataDir, id)) } catch { return null }
}

export function dropScreenCapture(dataDir, id, { now = new Date() } = {}) {
  let dropped = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeScreenCaptures(current)
    const capture = store.captures.find((item) => item.id === id)
    if (!capture || capture.deleted) return null
    capture.deleted = true
    dropped = capture
    return store
  }, normalizeScreenCaptures)
  if (result.ok && dropped) {
    try { rmSync(originalPath(dataDir, id), { force: true }) } catch { /* ignore */ }
    return { ok: true, capture: dropped }
  }
  return { ok: false, reject: '没有这张截图。' }
}

function pruneStore(store, now) {
  const cut = now.getTime() - KEEP_MS
  return { version: VERSION, captures: store.captures.filter((item) => (stamp(item.at) ?? 0) >= cut) }
}

// Files are the part that actually costs disk; the index alone is not enough.
function pruneFiles(dataDir, captures) {
  const keep = new Set(captures.filter((item) => !item.deleted && item.retained !== false).map((item) => `${item.id}.jpg`))
  let names = []
  try { names = readdirSync(join(dataDir, DIR)) } catch { return }
  for (const name of names) {
    if (keep.has(name)) continue
    try { rmSync(join(dataDir, DIR, name), { force: true }) } catch { /* ignore */ }
  }
}

export { MAX_CAPTURES, KEEP_MS }

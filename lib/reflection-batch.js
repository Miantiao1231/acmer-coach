// Durable reflection batch.
//
// The original keeps a batch state machine (selecting → prepared → running →
// received → modelled → complete/empty/failed/partial), persists the raw model
// output before parsing, and can repair a partially accepted batch without
// asking the model again. dsh-coach kept the batch in memory, so a restart lost
// both the raw output and every proposal that had already landed.
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'reflection-batch.json'
const VERSION = 1
const STATES = ['selecting', 'prepared', 'running', 'received', 'modelled', 'complete', 'empty', 'failed', 'partial']
const STALE_RUNNING_MS = 15 * 60 * 1000

const clean = (value) => String(value ?? '').trim()

export function emptyBatchState() {
  return { version: VERSION, batch: null }
}

function normalizeEvidence(raw) {
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    handle: clean(item?.handle).slice(0, 20),
    text: clean(item?.text).slice(0, 1200),
    time: clean(item?.time).slice(0, 40),
    messageId: clean(item?.messageId).slice(0, 200),
    seq: Number.isInteger(item?.seq) ? item.seq : null,
    sourceDigest: clean(item?.sourceDigest).slice(0, 40),
    span: item?.span && Number.isInteger(item.span.start) && Number.isInteger(item.span.end)
      ? { start: item.span.start, end: item.span.end } : null,
  })).filter((item) => item.handle && item.text)
}

function normalizeBatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = clean(raw.id)
  if (!id) return null
  return {
    id: id.slice(0, 80),
    state: STATES.includes(raw.state) ? raw.state : 'prepared',
    createdAt: clean(raw.createdAt).slice(0, 40),
    updatedAt: clean(raw.updatedAt).slice(0, 40),
    evidence: normalizeEvidence(raw.evidence),
    raw: String(raw.raw ?? '').slice(0, 200000),
    rawSavedAt: clean(raw.rawSavedAt).slice(0, 40),
    summary: clean(raw.summary).slice(0, 500),
    proposals: Array.isArray(raw.proposals) ? raw.proposals.slice(0, 64) : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected.slice(0, 64) : [],
    attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
    error: clean(raw.error).slice(0, 200),
  }
}

export function normalizeBatchState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return emptyBatchState()
  return { version: VERSION, batch: normalizeBatch(raw.batch) }
}

export function loadBatchState(dataDir) {
  return normalizeBatchState(readJsonFile(dataDir, FILE))
}

export function saveBatch(dataDir, batch) {
  const result = updateJsonFile(dataDir, FILE, () => ({
    version: VERSION,
    // State transitions own their timestamps, including an injected clock.
    batch: batch || null,
  }), normalizeBatchState)
  return result.ok
}

export function startBatch(dataDir, { evidence, now = new Date(), id = '' } = {}) {
  const batch = {
    id: clean(id) || `rb-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    state: 'prepared',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    evidence: normalizeEvidence(evidence),
    raw: '', rawSavedAt: '', summary: '', proposals: [], rejected: [], attempts: 0, error: '',
  }
  if (!batch.evidence.length) return null
  return saveBatch(dataDir, batch) ? batch : null
}

// The raw output is what a restart actually needs: parsing is pure, so a batch
// that reached `received` can finish without another model call.
export function markReceived(dataDir, { id, raw, now = new Date() } = {}) {
  let saved = null
  updateJsonFile(dataDir, FILE, (current) => {
    const state = normalizeBatchState(current)
    if (!state.batch || state.batch.id !== id) return null
    state.batch.state = 'received'
    state.batch.raw = String(raw ?? '').slice(0, 200000)
    state.batch.rawSavedAt = now.toISOString()
    state.batch.updatedAt = now.toISOString()
    state.batch.attempts += 1
    saved = state.batch
    return state
  }, normalizeBatchState)
  return saved
}

export function finishBatch(dataDir, {
  id, state = 'complete', summary = '', proposals = [], rejected = [], error = '', now = new Date(),
} = {}) {
  let saved = null
  updateJsonFile(dataDir, FILE, (current) => {
    const value = normalizeBatchState(current)
    if (!value.batch || value.batch.id !== id) return null
    value.batch.state = STATES.includes(state) ? state : 'complete'
    value.batch.updatedAt = now.toISOString()
    value.batch.summary = summary
    value.batch.proposals = proposals
    value.batch.rejected = rejected
    value.batch.error = clean(error).slice(0, 200)
    saved = value.batch
    return value
  }, normalizeBatchState)
  return saved
}

// Called once at startup. A `received` batch still has its raw output: re-parse
// it and let the caller land the proposals. A `running` batch older than the
// stale window is a crash; it becomes `failed` so a new batch can start.
export function recoverBatch(dataDir, { now = new Date(), staleMs = STALE_RUNNING_MS } = {}) {
  const state = loadBatchState(dataDir)
  const batch = state.batch
  if (!batch) return { kind: 'none', batch: null }
  if (batch.state === 'received' && batch.raw) return { kind: 'received', batch }
  if (batch.state === 'running' || batch.state === 'prepared') {
    const updated = Date.parse(batch.updatedAt || batch.createdAt || '')
    if (Number.isFinite(updated) && now.getTime() - updated > staleMs) {
      const failed = finishBatch(dataDir, { id: batch.id, state: 'failed', error: 'stale', now })
      return { kind: 'failed', batch: failed }
    }
    return { kind: 'active', batch }
  }
  return { kind: batch.state, batch }
}

// A partial batch keeps the accepted proposals and their evidence; the rejected
// ones stay in the batch so a later retry only has to re-check those slots.
export function partialBatch(dataDir, { id, summary = '', proposals = [], rejected = [], now = new Date() } = {}) {
  return finishBatch(dataDir, { id, state: 'partial', summary, proposals, rejected, now })
}

export function clearBatch(dataDir) {
  return saveBatch(dataDir, null)
}

export { STATES as BATCH_STATES }

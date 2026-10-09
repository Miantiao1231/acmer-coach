// Evidence references are derived from existing ledgers; this module never writes them.
import { createHash } from 'node:crypto'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' ? value.trim() : ''
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

function date(value) {
  const d = text(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  const parsed = new Date(`${d}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d ? d : ''
}

// Sorted object keys make references insensitive to YAML/JavaScript field order.
// Arrays keep their order, and the caller separately includes an event's position.
function canonical(value, visiting = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite evidence value')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || visiting.has(value)) throw new Error('Invalid evidence value')
  visiting.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, visiting)).join(',')}]`
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], visiting)}`).join(',')}}`
  } finally {
    visiting.delete(value)
  }
}

function fingerprint(record) {
  try { return createHash('sha256').update(canonical(record)).digest('hex') }
  catch { return '' }
}

function checkValid(record) {
  if (!object(record) || !date(record.date) || !['failed', 'overTime', 'passed'].includes(record.outcome)) return false
  // These fields were introduced at different times. Missing legacy fields are
  // compatible, but present malformed numbers cannot become trusted evidence.
  for (const key of ['score', 'maxScore', 'passScore', 'minutes', 'limit', 'verifiedAt', 'selfReported']) {
    if (record[key] !== undefined && (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || record[key] < 0)) return false
  }
  return true
}

function diagnosisValid(record) {
  return object(record) && Boolean(date(record.date)) && ['不会', '不熟', '不认真'].includes(record.category) &&
    Array.isArray(record.evidence) && record.evidence.length > 0 && record.evidence.every((entry) =>
      object(entry) && text(entry.quote).replace(/\s+/g, '').length >= 6 &&
      ['wrong', 'missing'].includes(entry.kind) && Boolean(text(entry.why))) &&
    (record.category !== '不认真' || record.evidence.some((entry) => entry.kind === 'wrong'))
}

function practiceValid(record, minutes) {
  return object(record) && typeof record.solved === 'boolean' &&
    typeof record.independent === 'boolean' && positive(minutes)
}

const practiceKey = (day, node, record, minutes) => JSON.stringify([
  day, node, text(record.problemId), minutes, record.solved, record.independent,
])

/**
 * Read-only catalog of usable observations in PROGRESS and SCHEDULE.
 * Every returned field is a string. IDs contain both an event locator and a
 * canonical content hash, so references cannot silently resolve to edited data.
 */
export function collectEvidence(progress, schedule = { days: {} }) {
  const result = []
  const seenIds = new Set()
  const progressPractice = new Set()
  const add = (source, node, day, locator, eventId, signal, summary, record) => {
    const hash = fingerprint(record)
    if (!hash) return false
    const id = `${source}:${encodeURIComponent(node)}:${locator}:${hash}`
    if (!seenIds.has(id)) {
      seenIds.add(id)
      result.push({ id, eventId, source, node, date: day, signal, summary, fingerprint: hash })
    }
    return true
  }

  const nodes = object(progress?.nodes) ? progress.nodes : {}
  for (const [node, rec] of Object.entries(nodes)) {
    if (!node.trim() || !object(rec)) continue
    const checks = Array.isArray(rec.checks) ? rec.checks : []
    checks.forEach((record, index) => {
      if (!checkValid(record)) return
      const signal = record.outcome === 'passed' ? 'baseline' : 'gap'
      const label = { failed: '检测未通过', overTime: '检测超时', passed: '检测通过' }[record.outcome]
      const scores = typeof record.score === 'number' && typeof record.maxScore === 'number'
        ? `，得分 ${record.score}/${record.maxScore}` : ''
      const time = typeof record.minutes === 'number' && typeof record.limit === 'number'
        ? `，用时 ${record.minutes}/${record.limit} 分钟` : ''
      const eventId = `check:${encodeURIComponent(node)}:${index}`
      add('check', node, date(record.date), String(index), eventId, signal, `${label}${scores}${time}`, record)
    })

    const diagnoses = Array.isArray(rec.diagnoses) ? rec.diagnoses : []
    diagnoses.forEach((record, index) => {
      if (!diagnosisValid(record)) return
      const summary = `代码判因：${record.category}${text(record.summary) ? `；${text(record.summary)}` : ''}`
      const eventId = `diagnosis:${encodeURIComponent(node)}:${index}`
      add('diagnosis', node, date(record.date), String(index), eventId, 'gap', summary, record)
    })

    const passes = Array.isArray(rec.passes) ? rec.passes : []
    passes.forEach((record, index) => {
      const day = date(record?.date)
      if (!day || !practiceValid(record, record?.minutes)) return
      const signal = record.solved && record.independent ? 'baseline' : 'gap'
      const label = record.solved ? (record.independent ? '独立做出' : '依赖提示或题解做出') : '尚未做出'
      const summary = `${text(record.problemId) ? `${text(record.problemId)}：` : ''}${label}，用时 ${record.minutes} 分钟`
      const eventId = `practice:${encodeURIComponent(node)}:${day}:${encodeURIComponent(text(record.problemId))}`
      if (add('practice', node, day, String(index), eventId, signal, summary, record)) {
        progressPractice.add(practiceKey(day, node, record, record.minutes))
      }
    })
  }

  const days = object(schedule?.days) ? schedule.days : {}
  for (const [rawDay, entry] of Object.entries(days)) {
    const day = date(rawDay)
    if (!day || !object(entry) || !Array.isArray(entry.actual)) continue
    for (const record of entry.actual) {
      const node = text(record?.node)
      if (!node || !practiceValid(record, record?.actualMin)) continue
      if (progressPractice.has(practiceKey(day, node, record, record.actualMin))) continue
      const signal = record.solved && record.independent ? 'baseline' : 'gap'
      const label = record.solved ? (record.independent ? '独立做出' : '依赖提示或题解做出') : '尚未做出'
      const summary = `${text(record.problemId) ? `${text(record.problemId)}：` : ''}${label}，实际用时 ${record.actualMin} 分钟`
      const locator = `${day}:${encodeURIComponent(text(record.problemId))}`
      const eventId = `practice:${encodeURIComponent(node)}:${day}:${encodeURIComponent(text(record.problemId))}`
      add('schedule', node, day, locator, eventId, signal, summary, record)
    }
  }
  return result
}

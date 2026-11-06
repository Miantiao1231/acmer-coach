// Reading positions refer to the exact saved text, never to elapsed minutes.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callText, parseJsonObject } from './llm-call.js'

const EXCERPT_LIMIT = 6000
const clean = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim()
const hashOf = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32)

export function readingSource(person, { bookId = '', limit = EXCERPT_LIMIT } = {}) {
  const book = (person?.library ?? []).find((item) => bookId ? item.id === bookId : item.state === 'reading')
  if (!book) return null
  const excerpt = String(book.excerpt ?? book.text ?? '')
  const note = clean(book.note ?? '')
  const contentHash = hashOf(excerpt)
  const start = book.readingHash === contentHash && Number.isInteger(book.readingOffset)
    ? Math.max(0, Math.min(excerpt.length, book.readingOffset)) : 0
  const end = Math.min(excerpt.length, start + Math.max(1, Math.min(EXCERPT_LIMIT, limit)))
  const text = excerpt.trim() ? excerpt.slice(start, end) : note.slice(0, EXCERPT_LIMIT)
  return {
    bookId: clean(book.id),
    title: clean(book.title).slice(0, 120),
    kind: excerpt.trim() ? 'excerpt' : note ? 'note' : 'title',
    text,
    hash: hashOf(text || clean(book.title)),
    contentHash, start, end, total: excerpt.length,
    scope: ['article', 'chapter', 'excerpt'].includes(book.scope) ? book.scope : 'excerpt',
  }
}

export const readingTextHash = (value) => hashOf(String(value ?? ''))

// One-shot read receipts: `open` hands out a range, `save` must present the
// exact same range back. Without this a tool call could advance the position
// for text it never received, or advance it twice for one reading.
const RECEIPT_FILE = 'reading-receipt.json'
const RECEIPT_TTL_MS = 2 * 3600 * 1000

function readReceipts(dataDir, at) {
  let list = []
  try { list = JSON.parse(readFileSync(join(dataDir, RECEIPT_FILE), 'utf8'))?.receipts ?? [] } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.filter(item => item && Number.isFinite(Date.parse(item.at)) && at - Date.parse(item.at) < RECEIPT_TTL_MS)
}

function writeReceipts(dataDir, receipts) {
  const path = join(dataDir, RECEIPT_FILE)
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ receipts: receipts.slice(-20) }), 'utf8')
    renameSync(`${path}.tmp`, path)
  } catch { /* 凭据写不下就是没有凭据：下次 open 会重发 */ }
}

export function issueReadReceipt(dataDir, { sessionId = '', bookId, hash, start, end, task = false, at = new Date() } = {}) {
  if (!clean(bookId) || !clean(hash)) return null
  const receipt = {
    sessionId: clean(sessionId), bookId: clean(bookId), hash: clean(hash),
    start: Math.max(0, Number(start) || 0), end: Math.max(0, Number(end) || 0),
    // A receipt handed out inside a background reading turn is only good while
    // that turn is authorized; an ordinary read by the user is not.
    task: task === true, at: at.toISOString(),
  }
  writeReceipts(dataDir, [...readReceipts(dataDir, at.getTime()), receipt])
  return receipt
}

// The turn ended (cancelled, switch turned off, timeout): whatever it opened is
// no longer something it may commit.
export function dropReadReceipts(dataDir, sessionId, at = new Date()) {
  const key = clean(sessionId)
  if (!key) return 0
  const receipts = readReceipts(dataDir, at.getTime())
  const kept = receipts.filter(item => item.sessionId !== key)
  writeReceipts(dataDir, kept)
  return receipts.length - kept.length
}

export function consumeReadReceipt(dataDir, { sessionId = '', bookId, hash, start } = {}, at = new Date()) {
  const receipts = readReceipts(dataDir, at.getTime())
  const index = receipts.findLastIndex(item => item.sessionId === clean(sessionId)
    && item.bookId === clean(bookId) && item.hash === clean(hash) && item.start === (Number(start) || 0))
  if (index < 0) { writeReceipts(dataDir, receipts); return null }
  const [receipt] = receipts.splice(index, 1)
  writeReceipts(dataDir, receipts)
  return receipt
}

export function sourceIsCurrent(activitySource, source) {
  if (!activitySource?.hash || !source?.hash) return true
  return activitySource.hash === source.hash
}

const REFLECTION_INSTRUCTION = `你刚读完一段材料，写一句读后感。
只依据给的材料和读的分钟数，不编造情节，不总结成书评，不引用材料里没有的句子。
第一人称，40 到 160 字。
输出 JSON：{"reflection":"读后感"}`

export async function writeReadingReflection({
  llm, route, source, minutes = 0, now = new Date(), timeoutMs = 60000, maxTokens = 400,
} = {}) {
  // 只有真实摘录才写读后感：书名或一句备注不能证明读过正文。
  if (source?.kind !== 'excerpt' || !clean(source?.text)) return null
  const payload = {
    title: source.title,
    source_kind: source.kind,
    text: source.text.slice(0, EXCERPT_LIMIT),
    minutes: Math.round(Number(minutes) || 0),
  }
  const output = await callText({
    llm, route,
    system: '你是小鲸，正在记录自己刚读过的内容。只依据材料，不编造。',
    prompt: `${REFLECTION_INSTRUCTION}\n\n材料：\n${JSON.stringify(payload, null, 2)}`,
    maxTokens, temperature: 0.6, timeoutMs,
  })
  if (!output) return null
  const data = parseJsonObject(output.text)
  const reflection = clean(data?.reflection)
  if (reflection.length < 10) return null
  return reflection.slice(0, 400)
}

// Attached to a finished reading activity. `sourceChanged` means the book text
// moved while it was being read; the minutes still count but the receipt says
// the takeaway may not match the current excerpt.
export function readingReceipt(activity, source, reflection, { now = new Date() } = {}) {
  if (!source) return null
  const current = sourceIsCurrent(activity?.source, source)
  return {
    activityId: clean(activity?.id),
    bookId: source.bookId,
    title: source.title,
    sourceKind: source.kind,
    contentHash: source.hash,
    sourceHash: source.contentHash,
    start: source.start, end: source.end, total: source.total, scope: source.scope,
    sourceChanged: !current,
    minutes: Math.round((Number(activity?.minutes) || 0) * 10) / 10,
    reflection: clean(reflection).slice(0, 400),
    at: now.toISOString(),
  }
}

export function readingSourceSnapshot(source) {
  if (!source) return null
  return { bookId: source.bookId, title: source.title, kind: source.kind, hash: source.hash,
    text: source.text.slice(0, EXCERPT_LIMIT), contentHash: source.contentHash ?? '',
    start: source.start ?? 0, end: source.end ?? 0, total: source.total ?? 0, scope: source.scope ?? 'excerpt' }
}

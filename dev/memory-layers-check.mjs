import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceFromMessages, parseReflection } from '../lib/reflection.js'
import {
  eventForClaim, appendEvents, reduceEvents, loadEvents, retractBySource, claimSourceIntact,
} from '../lib/claims.js'
import {
  startBatch, markReceived, finishBatch, recoverBatch, loadBatchState, clearBatch, saveBatch, partialBatch,
} from '../lib/reflection-batch.js'
import {
  loadEpisodeCursor, markEpisodeCovered, episodeDue, episodeMaterial,
} from '../lib/episodes.js'
import { observeHabit, qualifiedHabits, normalizeHabitStore, habitLines } from '../lib/habits.js'
import { selectMemory } from '../lib/memory-select.js'

const at = (value) => new Date(value)

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-layers-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('evidence carries a source digest and span for later retraction', () => {
  const [item] = evidenceFromMessages([{ text: '我不喜欢别人叫我小同学。', id: 'm-1', seq: 3, time: '2026-11-02T10:00:00Z' }])
  assert.equal(item.handle, 's1')
  assert.equal(item.messageId, 'm-1')
  assert.equal(item.sourceDigest.length, 32)
  assert.deepEqual(item.span, { start: 0, end: item.text.length })
})

test('parsed proposals keep the source reference', () => {
  const evidence = evidenceFromMessages([
    { text: '今天和队友一起打了一场练习赛，输了但挺开心的。', id: 'm-1', seq: 1, time: '2026-11-02T10:00:00Z' },
  ])
  const parsed = parseReflection(JSON.stringify({
    summary: '一场练习赛。',
    proposals: [{
      kind: 'episode',
      fields: { summary: '和队友打了一场练习赛，输了但气氛很好。', tags: ['练习赛'] },
      confidence: 0.9,
      evidence_handles: ['s1'],
    }],
  }), { allowedHandles: new Map(evidence.map((item) => [item.handle, item])) })
  assert.equal(parsed.ok, true)
  const proposal = parsed.proposals[0]
  assert.equal(proposal.evidence[0].messageId, 'm-1')
  assert.equal(proposal.evidence[0].sourceDigest, evidence[0].sourceDigest)
  assert.deepEqual(proposal.evidence[0].span, evidence[0].span)
})

test('retracting a source retracts every claim that cited it', () => {
  const t = tmp()
  try {
    const [item] = evidenceFromMessages([{ text: '我不喜欢别人叫我小同学。', id: 'm-1', seq: 1, time: '2026-11-02T10:00:00Z' }])
    const other = evidenceFromMessages([{ text: '最近在准备区域赛。', id: 'm-2', seq: 2, time: '2026-11-02T10:01:00Z' }])[0]
    appendEvents(t.dir, [
      eventForClaim('boundary', { text: '不要叫我小同学' }, { evidence: [{ handle: 's1', quote: item.text, time: item.time, messageId: item.messageId, sourceDigest: item.sourceDigest, span: item.span }] }),
      eventForClaim('context', { text: '在准备区域赛' }, { evidence: [{ handle: 's1', quote: other.text, time: other.time, messageId: other.messageId, sourceDigest: other.sourceDigest }] }),
    ])
    const claims = [...reduceEvents(loadEvents(t.dir)).values()]
    assert.equal(claims.every((claim) => claim.status === 'active'), true)
    assert.equal(claimSourceIntact(claims[0], { messageId: 'm-1' }), true)
    assert.equal(claimSourceIntact(claims[0], { messageId: 'm-2' }), false)

    const result = retractBySource(t.dir, { messageId: 'm-1' })
    assert.equal(result.retracted, 1)
    const after = [...reduceEvents(loadEvents(t.dir)).values()]
    assert.equal(after.find((claim) => claim.id === claims[0].id).status, 'retracted')
    assert.equal(after.find((claim) => claim.id === claims[1].id).status, 'active')
    assert.equal(retractBySource(t.dir, {}).ok, false)
  } finally { t.done() }
})

test('a reflection batch survives a restart and a stale running batch is failed', () => {
  const t = tmp()
  try {
    const evidence = evidenceFromMessages([{ text: '记住我下周三要考线代。', id: 'm-1', seq: 1, time: '2026-11-02T10:00:00Z' }])
    const batch = startBatch(t.dir, { evidence, now: at('2026-11-02T10:00:00') })
    assert.equal(loadBatchState(t.dir).batch.state, 'prepared')
    markReceived(t.dir, {
      id: batch.id,
      raw: JSON.stringify({ summary: '他下周三考线代。', proposals: [] }),
      now: at('2026-11-02T10:01:00'),
    })
    const recovered = recoverBatch(t.dir, { now: at('2026-11-02T10:05:00') })
    assert.equal(recovered.kind, 'received')
    assert.match(recovered.batch.raw, /考线代/)
    finishBatch(t.dir, { id: batch.id, state: 'partial', summary: 'x', proposals: [], rejected: [{ handle: 's1' }] })
    assert.equal(loadBatchState(t.dir).batch.state, 'partial')
    clearBatch(t.dir)
    assert.equal(loadBatchState(t.dir).batch, null)

    const stale = startBatch(t.dir, { evidence, now: at('2026-11-02T10:00:00') })
    const failed = recoverBatch(t.dir, { now: at('2026-11-02T11:00:00') })
    assert.equal(failed.kind, 'failed')
    assert.equal(failed.batch.id, stale.id)
  } finally { t.done() }
})

test('batch timestamps preserve the supplied clock through writes and recovery', () => {
  const t = tmp()
  try {
    const now = at('2000-01-10T12:00:00Z')
    const evidence = evidenceFromMessages([{ text: '记住这件事', id: 'clock-message' }])
    const batch = startBatch(t.dir, { evidence, now })
    assert.equal(loadBatchState(t.dir).batch.updatedAt, now.toISOString())
    const running = { ...batch, state: 'running' }
    assert.equal(saveBatch(t.dir, running), true)
    assert.equal(recoverBatch(t.dir, { now: new Date(now.getTime() + 15 * 60000) }).kind, 'active')
    const recoveredAt = new Date(now.getTime() + 15 * 60000 + 1)
    const recovered = recoverBatch(t.dir, { now: recoveredAt })
    assert.equal(recovered.kind, 'failed')
    assert.equal(recovered.batch.updatedAt, recoveredAt.toISOString())
    assert.equal(loadBatchState(t.dir).batch.updatedAt, recoveredAt.toISOString())

    const receivedAt = new Date(now.getTime() + 20 * 60000)
    markReceived(t.dir, { id: batch.id, raw: '{}', now: receivedAt })
    assert.equal(loadBatchState(t.dir).batch.updatedAt, receivedAt.toISOString())
    assert.equal(loadBatchState(t.dir).batch.rawSavedAt, receivedAt.toISOString())
    const finishedAt = new Date(now.getTime() + 21 * 60000)
    partialBatch(t.dir, { id: batch.id, now: finishedAt })
    assert.equal(loadBatchState(t.dir).batch.updatedAt, finishedAt.toISOString())
  } finally { t.done() }
})

test('episode material is bounded and the cursor advances only when asked', () => {
  const t = tmp()
  try {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      at: new Date(Date.parse('2026-11-02T09:00:00Z') + index * 60000).toISOString(),
      text: `第 ${index} 条消息，今天在讨论题。`,
    }))
    assert.equal(episodeDue(entries, loadEpisodeCursor(t.dir), { now: at('2026-11-02T12:00:00Z') }), true)
    assert.equal(episodeDue([], loadEpisodeCursor(t.dir), { now: at('2026-11-02T12:00:00Z') }), false)
    const material = episodeMaterial(entries, loadEpisodeCursor(t.dir), { now: at('2026-11-02T12:00:00Z') })
    assert.equal(material.lines.length, 10)
    assert.equal(material.coveredThrough, entries.at(-1).at)
    assert.equal(markEpisodeCovered(t.dir, { coveredThrough: material.coveredThrough, now: at('2026-11-02T12:00:00Z') }), true)
    assert.equal(episodeDue(entries, loadEpisodeCursor(t.dir), { now: at('2026-11-02T12:00:00Z') }), false)
    assert.equal(episodeMaterial([{ at: entries[0].at, text: '短' }], { coveredThrough: '' }, { now: at('2026-11-02T12:00:00Z') }), null)
  } finally { t.done() }
})

test('habits need repeated wording on three distinct days', () => {
  const t = tmp()
  try {
    for (const day of ['2026-10-30', '2026-11-01', '2026-11-02']) {
      observeHabit(t.dir, { text: '今天好困', now: at(`${day}T10:00:00`) })
    }
    observeHabit(t.dir, { text: '这道题好难', now: at('2026-11-02T11:00:00') })
    observeHabit(t.dir, { text: '这道题好难', now: at('2026-11-02T11:10:00') })
    observeHabit(t.dir, { text: '这道题好难', now: at('2026-11-02T11:20:00') })
    const qualified = qualifiedHabits(undefined, {})
    assert.deepEqual(qualified, [])
    const habits = qualifiedHabits(normalizeHabitStore(loadHabitList(t.dir)), { now: at('2026-11-02T12:00:00') })
    assert.deepEqual(habits.map((item) => item.text), ['今天好困'])
    assert.match(habitLines(habits), /今天好困/)
  } finally { t.done() }
})

test('memory selection keeps two relevant episodes from collapsing into one', () => {
  const now = at('2026-11-02T12:00:00')
  const person = {
    pinned: [], boundaries: [], promises: [],
    episodes: [
      { summary: '区域赛复盘：第四题卡住，最后没有过。', at: '2026-10-20', tags: [] },
      { summary: '区域赛复盘：第四题又卡住，还是没过。', at: '2026-10-25', tags: [] },
      { summary: '和队友打了一场练习赛，输了但很开心。', at: '2026-11-01', tags: [] },
    ],
  }
  const picked = selectMemory(person, { query: '区域赛复盘 第四题 卡住', now })
  assert.equal(picked.episodes.length, 2)
  assert.equal(new Set(picked.episodes.map((item) => item.summary)).size, 2)
})

function loadHabitList(dir) {
  return JSON.parse(readFileSync(join(dir, 'habit-candidates.json'), 'utf8'))
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSources, chooseSource } from '../lib/proactive-sources.js'
import { createProactiveTool } from '../lib/proactive.js'

const NOW = new Date('2026-10-30T12:00:00')
const base = {
  person: { relation: { milestones: [] }, library: [] },
  progress: { nodes: {} },
  target: null,
  classWindow: null,
  lastUserAt: '',
  life: null,
  vp: null,
  now: NOW,
}

test('candidates cover target, pending, lesson, check, absence, milestone, library and class', () => {
  const candidates = buildSources({
    ...base,
    target: { contest: '香港站', date: '2026-11-05' },
    progress: {
      pending: { node: '区间 DP' },
      lesson: { node: '二分' },
      nodes: { A: { checks: [{ date: '2026-10-30', outcome: 'failed' }] } },
    },
    lastUserAt: '2026-10-25T12:00:00',
    person: {
      relation: { milestones: [{ label: '第一次说心里话', date: '2025-11-02' }] },
      library: [{ title: '《海》', state: 'reading' }],
    },
    classWindow: { from: '14:00', to: '16:00', weekdays: [5] },
  })
  const kinds = candidates.map(item => item.kind)
  for (const kind of ['target', 'pending', 'lesson', 'check-failed', 'absence', 'milestone', 'library', 'class']) {
    assert.ok(kinds.includes(kind), `缺少 ${kind}`)
  }
  assert.ok(candidates.find(item => item.kind === 'target').topic.includes('6 天'))
})

test('a recently finished book with a note can still be shared', () => {
  const candidates = buildSources({
    ...base,
    person: {
      relation: { milestones: [] },
      library: [{ title: '《海》', state: 'done', note: '最后一段写得很好。', doneAt: '2026-10-28T12:00:00.000Z' }],
    },
  })
  const library = candidates.find(item => item.kind === 'library')
  assert.ok(library)
  assert.match(library.topic, /刚读完/)
  assert.match(library.evidence, /state=done/)
})

test('an old or undated finished book says "以前读过", never "刚读完"', () => {
  for (const doneAt of ['2026-01-01T12:00:00.000Z', '']) {
    const candidates = buildSources({
      ...base,
      person: {
        relation: { milestones: [] },
        library: [{ title: '《半年前的书》', state: 'done', note: '当时做了不少笔记。', doneAt, updatedAt: '2026-11-05T12:00:00.000Z' }],
      },
    })
    const library = candidates.find(item => item.kind === 'library')
    assert.ok(library)
    assert.match(library.topic, /以前读过/)
    assert.doesNotMatch(library.topic, /刚读完/)
  }
})

test('recent topics are removed before selection', () => {
  const candidates = buildSources({
    ...base,
    progress: { pending: { node: '区间 DP' }, nodes: {} },
  })
  const chosen = chooseSource(candidates, {
    state: { recent: [{ topic: '押着的卷「区间 DP」还没做完', at: NOW.toISOString() }] },
    now: NOW,
    sessionId: 'sess-1',
  })
  assert.notEqual(chosen?.topic, '押着的卷「区间 DP」还没做完')
})

test('a due promise is a high-priority proactive candidate', () => {
  const candidates = buildSources({
    ...base,
    person: {
      relation: { milestones: [] },
      library: [],
      promises: [{ id: 'p1', text: '明天问他那道题的进度', dueAt: '2026-10-31', status: 'open' }],
    },
  })
  const promise = candidates.find(item => item.kind === 'promise')
  assert.ok(promise)
  assert.match(promise.topic, /答应过/)
  assert.equal(promise.score, 88)
})

test('the tool only exposes arm/disarm/status and delegates to the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-proactive-'))
  try {
    const calls = []
    const tool = createProactiveTool({
      armWorker: (id) => { calls.push(['arm', id]); return { ok: true, summary: `armed:${id}` } },
      disarmWorker: () => { calls.push(['disarm']); return { ok: true, summary: 'disarmed' } },
      workerStatus: () => ({ enabled: true, sentToday: 0, unanswered: 0, nextAt: '' }),
    })
    assert.deepEqual(tool.parameters.properties.action.enum, ['arm', 'disarm', 'status'])
    const exec = { agent: { session: { id: 'sess-1' } } }
    assert.equal((await tool.execute({ action: 'arm' }, exec)).summary, 'armed:sess-1')
    assert.equal((await tool.execute({ action: 'disarm' }, exec)).summary, 'disarmed')
    assert.match((await tool.execute({ action: 'status' }, exec)).summary, /已开/)
    assert.deepEqual(calls, [['arm', 'sess-1'], ['disarm']])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

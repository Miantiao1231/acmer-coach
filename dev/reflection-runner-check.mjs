import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPerson, savePerson } from '../lib/person.js'
import { applyReflection } from '../lib/reflection-runner.js'
import { startBatch, markReceived, saveBatch } from '../lib/reflection-batch.js'

const session = { id: 'session-reflect' }
const route = { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }
const user = (index) => ({
  type: 'user/message',
  seq: index,
  time: `2026-10-30T12:0${index}:00`,
  data: { message: { id: `m${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `消息${index}` }] } },
})
const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

test('recovered reflection summary keeps its original batch time and does not replace a newer pair', () => {
  for (const newer of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-recovered-time-'))
    try {
      const person = loadPerson(dir)
      person.reflection.lastAt = newer ? '2026-11-04T10:00:00.000Z' : '2026-10-31T10:00:00.000Z'
      person.reflection.lastSummary = newer ? '更新的反思摘要' : '旧反思摘要'
      const now = new Date()
      person.reflection.day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      person.reflection.reflectCallsToday = 2
      person.reflection.styleCallsToday = 3
      assert.equal(savePerson(dir, person), true)
      const batch = startBatch(dir, { evidence: [{ handle: 's1', text: '合成证据', time: '2026-11-03T10:00:00.000Z' }], now: new Date('2026-11-03T10:00:00.000Z') })
      markReceived(dir, { id: batch.id, raw: JSON.stringify({ summary: '待恢复的摘要', proposals: [] }), now: new Date('2026-11-03T10:01:00.000Z') })
      applyReflection({ on() {}, get() { throw new Error('恢复不得调用模型') } }, dir, { allowModel: () => false })
      const reflection = loadPerson(dir).reflection
      assert.equal(reflection.lastSummary, newer ? '更新的反思摘要' : '待恢复的摘要')
      assert.equal(reflection.lastAt, newer ? '2026-11-04T10:00:00.000Z' : '2026-11-03T10:01:00.000Z')
      assert.equal(reflection.reflectCallsToday, 2)
      assert.equal(reflection.styleCallsToday, 3)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('an undated recovered batch neither invents a fresh time nor overwrites a dated summary', () => {
  for (const existing of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-undated-'))
    try {
      const person = loadPerson(dir)
      if (existing) {
        person.reflection.lastAt = '2026-11-04T10:00:00.000Z'
        person.reflection.lastSummary = '有日期的摘要'
      }
      assert.equal(savePerson(dir, person), true)
      const batch = startBatch(dir, { evidence: [{ handle: 's1', text: '合成证据' }] })
      const received = markReceived(dir, { id: batch.id, raw: JSON.stringify({ summary: '无日期摘要', proposals: [] }) })
      assert.equal(saveBatch(dir, { ...received, rawSavedAt: 'invalid' }), true)
      applyReflection({ on() {}, get() { throw new Error('恢复不得调用模型') } }, dir, { allowModel: () => false })
      const reflection = loadPerson(dir).reflection
      assert.equal(reflection.lastAt, existing ? '2026-11-04T10:00:00.000Z' : '')
      assert.equal(reflection.lastSummary, existing ? '有日期的摘要' : '无日期摘要')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

function fakeCtx(response, mode = 'text') {
  const handlers = new Map()
  return {
    handlers,
    on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) },
    get: (name) => name === 'llm' ? {
      stream: async function* () {
        if (mode === 'tool') {
          yield { type: 'block-end', block: { type: 'tool-call', name: 'report_reflection', arguments: response } }
        } else {
          yield { type: 'text-delta', text: response }
        }
      },
    } : undefined,
  }
}

test('reflection runner stores evidence-backed proposals after enough user messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const response = JSON.stringify({
      summary: '今天聊了不少。',
      proposals: [{ kind: 'habit', fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' }, confidence: 0.8, evidence_handles: ['s1'] }],
    })
    const ctx = fakeCtx(response)
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 4, styleEvery: 100, maxTokens: 512 })
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    for (let i = 0; i < 4; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    const person = loadPerson(dir)
    assert.equal(person.pending.length, 1)
    assert.equal(person.pending[0].kind, 'habit')
    assert.equal(person.pending[0].evidence[0].quote, '消息0')
    assert.ok(person.reflection.lastAt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reflection waits for background model authorization even after a forced request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    let calls = 0
    const ctx = fakeCtx('{"summary":"x","proposals":[]}')
    ctx.get = name => name === 'llm' ? { async *stream() { calls += 1 } } : null
    applyReflection(ctx, dir)
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    handler(session, { ...user(0), data: { message: { ...user(0).data.message,
      content: [{ type: 'text', text: '记住以后先画图' }] } } })
    handler(session, turnEnd)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
    assert.equal(loadPerson(dir).reflection.reflectCallsToday, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a failed reflection leaves the window intact and writes no proposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const ctx = fakeCtx('not json')
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 4, styleEvery: 100, maxTokens: 512 })
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    for (let i = 0; i < 4; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    const person = loadPerson(dir)
    assert.equal(person.pending.length, 0)
    assert.equal(person.reflection.lastAt, '')
    assert.ok(person.reflection.retryAt, '解析失败要留下持久的退避时间')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('structured tool arguments are preferred over plain text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const response = JSON.stringify({
      summary: 'x',
      proposals: [{ kind: 'habit', fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' }, confidence: 0.8, evidence_handles: ['s1'] }],
    })
    const ctx = fakeCtx(response, 'tool')
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 4, styleEvery: 100, maxTokens: 512 })
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    for (let i = 0; i < 4; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(loadPerson(dir).pending.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a rejected proposal is not re-added by a later reflection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const person = loadPerson(dir)
    person.rejected = [{ kind: 'habit', fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' }, at: new Date().toISOString() }]
    savePerson(dir, person)
    const response = JSON.stringify({
      summary: 'x',
      proposals: [{ kind: 'habit', fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' }, confidence: 0.8, evidence_handles: ['s1'] }],
    })
    const ctx = fakeCtx(response)
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 4, styleEvery: 100, maxTokens: 512 })
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    for (let i = 0; i < 4; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(loadPerson(dir).pending.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the daily budget stops a second reflection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const response = JSON.stringify({
      summary: 'x',
      proposals: [{ kind: 'habit', fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' }, confidence: 0.8, evidence_handles: ['s1'] }],
    })
    const ctx = fakeCtx(response)
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 4, styleEvery: 100, maxTokens: 512, dailyLimit: 1 })
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    for (let i = 0; i < 4; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(loadPerson(dir).pending.length, 1)
    for (let i = 4; i < 8; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(loadPerson(dir).pending.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('style runner stores pending notes after enough samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const response = JSON.stringify({
      summary: '他的节奏',
      signals: [{ dimension: 'sentence_rhythm', observation: '短句多', pattern: '先两三个字确认，再补一句', situation: '日常', avoid: '', proposal: '', confidence: 0.7, evidence_handles: ['s1'] }],
    })
    const ctx = fakeCtx(response)
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 40, styleEvery: 10, maxTokens: 512 })
    const handler = ctx.handlers.get('session/event')[0]
    handler(session, route)
    for (let i = 0; i < 10; i++) handler(session, user(i))
    handler(session, turnEnd)
    await new Promise(resolve => setTimeout(resolve, 50))
    const person = loadPerson(dir)
    assert.equal(person.style.length, 1)
    assert.equal(person.style[0].status, 'pending')
    assert.equal(person.style[0].evidence[0].quote, '消息0')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

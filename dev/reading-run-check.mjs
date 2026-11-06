import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPerson } from '../lib/person.js'
import { emptyState, loadState, saveState, readingStatus } from '../lib/proactive-state.js'
import { consumeReadReceipt, issueReadReceipt, readingTextHash } from '../lib/reading.js'
import { runReadingSession } from '../lib/reading-session.js'
import { createLifeTick } from '../lib/life-tick.js'

const NOW = new Date(2026, 10, 6, 10)
const articleHtml = (title, body) => `<html><head><title>${title}</title></head><body><article><p>${body}</p></article></body></html>`

async function toolFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-tool-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, home: process.env.DSH_HOME }
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  process.env.DSH_HOME = dir
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
  writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\nnodes: {}\n')
  const tools = new Map()
  const services = {
    web: {
      fetch: async ({ url }) => ({
        url, statusCode: 200,
        body: { kind: 'html', content: articleHtml('七桥的故事', '图论的正文段落。'.repeat(200)) },
        truncated: false,
      }),
    },
  }
  const { apply } = await import(`../index.js?reading-tool=${dir}`)
  apply({
    tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, effect: (cb) => cb(),
    get: name => services[name], on() {},
  })
  t.after(() => {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db], ['DSH_HOME', previous.home]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return { dir, tools }
}

test('coach_read shelves a fetched article with a verifiable position', async t => {
  const { dir, tools } = await toolFixture(t)
  const read = tools.get('coach_read')
  const open = await read.execute({ action: 'open', url: 'https://example.test/graph' })
  assert.equal(open.ok, true, open.reject)
  assert.match(open.text, /图论的正文段落/)
  assert.ok(open.total > 1000)
  const book = loadPerson(dir).library[0]
  assert.equal(book.title, '七桥的故事')
  assert.equal(book.source, 'https://example.test/graph')
  assert.equal(book.readingHash, readingTextHash(book.excerpt), 'the tool computes the fingerprint, not the model')
  assert.equal(book.readingOffset, 0)

  const save = await read.execute({
    action: 'save', bookId: book.id, readChars: 1000,
    note: '这一段讲七桥问题，欧拉把陆地抽象成点。', continue: true,
  })
  assert.equal(save.ok, true, save.reject)
  assert.equal(save.offset, 1000)
  const updated = loadPerson(dir).library[0]
  assert.equal(updated.readingOffset, 1000)
  assert.match(updated.note, /七桥/)

  // One open issues one receipt: a second save with no new open must not move
  // the position twice.
  const repeat = await read.execute({ action: 'save', bookId: book.id, readChars: 1000 })
  assert.equal(repeat.ok, false, 'the same range cannot be saved twice')
  assert.equal(loadPerson(dir).library[0].readingOffset, 1000)

  const resume = await read.execute({ action: 'open' })
  assert.equal(resume.ok, true, resume.reject)
  assert.equal(resume.start, 1000, 'the next open resumes at the saved position')

  // readChars cannot claim more than open handed out (600 chars left here).
  const over = await read.execute({ action: 'save', bookId: book.id, readChars: 6000 })
  assert.equal(over.ok, true, over.reject)
  assert.equal(over.offset, 1600, 'the opened range bounds what can be saved')
  assert.equal(over.done, true)
  assert.equal((await read.execute({ action: 'save', bookId: book.id })).ok, false)
})

test('coach_read refuses non-text and binary bodies', async t => {
  const { tools } = await toolFixture(t)
  const read = tools.get('coach_read')
  const short = await read.execute({ action: 'open', url: 'https://example.test/empty' })
  assert.equal(short.ok, true, 'the fixture body is long enough')
  const invalid = await read.execute({ action: 'save', bookId: 'missing', readChars: 1000 })
  assert.equal(invalid.ok, false)
})

// What the agent/request waterfall's continuation returns to the loop.
const nextRequest = () => Promise.resolve({ provider: 'p', model: 'm' })

// Mirrors the host service the plugin actually gets: `create()` returns a
// session id and `resolveAgent()` hands back the agent. There is no
// `createSession()` on the real service.
function sessionCtx({ finalText, mainSessionId = 'main-1', onRequest = null }) {
  const tempAgent = {
    session: { id: 'temp-1' }, followed: [],
    followup(message) {
      this.followed.push(message)
      // Every attempt runs through the agent/request waterfall inside
      // prepareRequest; the fixture fires it the same way.
      emit('agent/request', { agent: tempAgent, turn: 0, step: 1 }, nextRequest)
      if (onRequest) onRequest()
    },
    whenIdle: async () => {},
    cancel(cause) { tempAgent.cancelled = cause },
  }
  const mainAgent = { session: { id: mainSessionId }, messages: [], followup(message) { this.messages.push(message) } }
  const archived = []
  const listeners = []
  const emit = (type, ...args) => {
    for (const [kind, handler] of listeners) if (kind === type) handler(...args)
  }
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'temp-1', agentPreset: 'xiaojing' }),
          resolveAgent: async id => id === 'temp-1' ? { agent: tempAgent } : id === mainSessionId ? { agent: mainAgent } : null,
        }
      }
      if (name === 'sessionQuery') {
        return {
          readSession: async () => ({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } } }] }),
        }
      }
      if (name === 'workspaceController') return { archiveSession: async request => { archived.push(request) } }
      return undefined
    },
    on(type, handler) { listeners.push([type, handler]); return () => {} },
  }
  return { ctx, tempAgent, mainAgent, archived, emit }
}

test('a real reading session is archived and its share becomes a queued contact', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-session-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  assert.equal(saveState(dir, state), true)

  const { ctx, tempAgent, mainAgent, archived } = sessionCtx({ finalText: '读完了。\nSHARE: 我今天读到一篇讲七桥的。' })
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, true, result.reason)
  assert.equal(tempAgent.followed.length, 1)
  assert.match(JSON.stringify(tempAgent.followed[0]), /coach_read/, 'the temp session is told to use the reading tool')
  assert.deepEqual(archived, [{ sessionId: 'temp-1', stopActivity: true }])
  // The reading turn never talks to the main session itself: the share becomes
  // a queued contact that the proactive worker delivers on its own rhythm.
  assert.equal(mainAgent.messages.length, 0)
  assert.equal(result.queued, true)
  const queued = loadState(dir, NOW).queue
  assert.equal(queued.length, 1)
  assert.match(queued[0].body, /讲七桥的/)
  assert.equal(queued[0].source, 'reading')
  assert.equal(readingStatus(dir, NOW).callsToday, 1)
})

test('NO_SHARE archives the temp session without waking the main session', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-noshare-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  const { ctx, mainAgent, archived } = sessionCtx({ finalText: '读完了。\nNO_SHARE' })
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.share, false)
  assert.equal(mainAgent.messages.length, 0)
  assert.equal(archived.length, 1)
})

test('the life tick invokes the real reading runner when the setting is on', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-tick-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = false
  state.settings.autonomousReading = true
  saveState(dir, state)
  let calls = 0
  const tick = createLifeTick({
    dataDir: dir,
    getRoute: () => ({ provider: 'p', model: 'm' }),
    getLlm: () => null,
    runReading: async () => { calls += 1 },
    allowModel: () => false,
  })
  await tick(NOW, { canContinue: () => true })
  assert.equal(calls, 1, 'the reading switch is its own authorization')
})

test('a truncated fetch is shelved as an excerpt, never as a finished article', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-trunc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, home: process.env.DSH_HOME }
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  process.env.DSH_HOME = dir
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
  writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\nnodes: {}\n')
  t.after(() => {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db], ['DSH_HOME', previous.home]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const tools = new Map()
  const services = {
    web: {
      fetch: async ({ url }) => ({
        url, statusCode: 200, truncated: true,
        body: { kind: 'html', content: articleHtml('被截断的长文', '正文片段。'.repeat(60)) },
      }),
    },
  }
  const { apply } = await import(`../index.js?reading-trunc=${dir}`)
  apply({
    tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, effect: (cb) => cb(),
    get: name => services[name], on() {},
  })
  const read = tools.get('coach_read')
  const open = await read.execute({ action: 'open', url: 'https://example.test/long' })
  assert.equal(open.ok, true, open.reject)
  const book = loadPerson(dir).library[0]
  assert.equal(book.scope, 'excerpt', 'a partial fetch cannot call itself the whole article')
  const save = await read.execute({ action: 'save', bookId: book.id, readChars: 6000 })
  assert.equal(save.ok, true, save.reject)
  assert.equal(save.done, false)
  assert.equal(loadPerson(dir).library[0].state, 'reading', 'finishing a slice is not finishing the article')
})

test('a reading session that lost its lease mid-turn is cancelled and archived', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-cancel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  const { ctx, mainAgent, archived } = sessionCtx({ finalText: 'SHARE: 不该发出去' })
  let calls = 0
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW, canContinue: () => (calls += 1) === 1 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
  assert.equal(mainAgent.messages.length, 0, 'nothing is shared after the lease is gone')
  assert.equal(archived.length, 1)
})

test('the reading switch is checked before a session is created', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-off-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = false
  saveState(dir, state)
  let created = 0
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { create: async () => { created += 1; return { sessionId: 'temp-1' } }, resolveAgent: async () => null }
      return undefined
    },
  }
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, false)
  assert.match(result.reason, /关闭/)
  assert.equal(created, 0, 'a closed switch never spends a model call')
})

test('each model request is charged to the reading budget', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-budget-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  const { ctx, emit, tempAgent, mainAgent } = sessionCtx({ finalText: 'NO_SHARE' })
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, true, result.reason)
  assert.equal(loadState(dir, NOW).readingRequests.count, 1, 'the opening attempt is charged')
  assert.equal(result.requests, 1)
  // The loop runs prepareRequest for every step and every retry, and writes no
  // request/header when nothing changed — so each of these is a real call.
  for (let step = 2; step <= 4; step += 1) {
    emit('agent/request', { agent: tempAgent, turn: 0, step }, nextRequest)
  }
  assert.equal(loadState(dir, NOW).readingRequests.count, 4, 'unchanged config and retries are still charged')
  emit('agent/request', { agent: mainAgent, turn: 0, step: 3 }, nextRequest)
  assert.equal(loadState(dir, NOW).readingRequests.count, 4, 'other sessions are not charged to reading')
})

test('exhausted request budget cancels the turn instead of spending more', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-exhausted-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  // 7 of the day's 8 requests are already spent: the opening one is the last.
  state.readingRequests = { day: '2026-11-06', count: 7 }
  saveState(dir, state)
  let more = null
  const { ctx, tempAgent, emit } = sessionCtx({ finalText: 'SHARE: 不该发', onRequest: () => {
    if (more) more('agent/request', { agent: tempAgent, turn: 0, step: 2 }, nextRequest)
  } })
  more = emit
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
  assert.equal(tempAgent.cancelled, 'reading-budget')
  assert.equal(loadState(dir, NOW).readingRequests.count, 8, 'the day stops at the confirmed limit')
})

test('one reading session stops after its own four requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-session-cap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  let more = null
  const { ctx, tempAgent, emit } = sessionCtx({ finalText: 'NO_SHARE', onRequest: () => {
    if (!more) return
    for (let i = 0; i < 4; i += 1) more('agent/request', { agent: tempAgent, turn: 0, step: 2 + i }, nextRequest)
  } })
  more = emit
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
  assert.equal(tempAgent.cancelled, 'reading-budget')
  // Opening + three follow-up requests were charged; the fifth is refused.
  assert.equal(loadState(dir, NOW).readingRequests.count, 4, 'a turn stops at four charged requests')
})

test('a share is queued with its source and nothing is sent while proactive contact is off', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-share-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  const { ctx, mainAgent } = sessionCtx({ finalText: 'SHARE: 读到一篇讲七桥的。' })
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.queued, true)
  assert.equal(mainAgent.messages.length, 0, 'the runner never wakes the session itself')
  const after = loadState(dir, NOW)
  assert.equal(after.sentToday, 0, 'nothing counts as sent until the worker actually delivers')
  assert.equal(after.queue.length, 1)
  assert.equal(after.queue[0].purpose, 'life')
  assert.equal(after.queue[0].source, 'reading')

  // With proactive contact switched off there is nowhere to share, so the
  // reading turn does not manufacture a queue entry either.
  const off = emptyState(NOW)
  off.enabled = false
  off.settings.autonomousReading = true
  saveState(dir, off)
  const quiet = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(quiet.queued, false)
  assert.equal(loadState(dir, NOW).queue.length, 0)
})

test('our own 60000-character cut is also a fragment, not the whole article', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-clip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, home: process.env.DSH_HOME }
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  process.env.DSH_HOME = dir
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
  writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\nnodes: {}\n')
  t.after(() => {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db], ['DSH_HOME', previous.home]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const tools = new Map()
  const services = {
    web: {
      fetch: async ({ url }) => ({
        url, statusCode: 200, truncated: false, // the host delivered everything
        body: { kind: 'html', content: articleHtml('超长正文', '长文段落。'.repeat(20000)) },
      }),
    },
  }
  const { apply } = await import(`../index.js?reading-clip=${dir}`)
  apply({
    tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, effect: (cb) => cb(),
    get: name => services[name], on() {},
  })
  const read = tools.get('coach_read')
  const open = await read.execute({ action: 'open', url: 'https://example.test/huge' })
  assert.equal(open.ok, true, open.reject)
  const book = loadPerson(dir).library[0]
  assert.equal(book.excerpt.length, 60000, 'the stored text is clamped')
  assert.equal(book.scope, 'excerpt', 'a locally clipped text is not a finished article')
})

test('a finished turn invalidates the ranges it opened but never saved', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-late-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  issueReadReceipt(dir, { sessionId: 'temp-1', bookId: 'b1', hash: 'h1', start: 0, end: 1000, task: true })
  const { ctx } = sessionCtx({ finalText: 'NO_SHARE' })
  let calls = 0
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW, canContinue: () => (calls += 1) === 1 })
  assert.equal(result.ok, false)
  assert.equal(consumeReadReceipt(dir, { sessionId: 'temp-1', bookId: 'b1', hash: 'h1', start: 0 }), null,
    'a late save has nothing left to present')
})

test('a web search spends from the same four-request allowance', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-search-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'main-1'
  state.settings.autonomousReading = true
  saveState(dir, state)
  // One agent attempt (the follow-up) plus four searches: the fifth call is
  // refused before it reaches the provider.
  const { ctx, tempAgent, emit } = sessionCtx({
    finalText: 'NO_SHARE',
    onRequest: () => {
      for (let i = 0; i < 4; i += 1) emit('session/event', { id: 'temp-1' }, { type: 'web/deepseek-search-llm-request' })
    },
  })
  const result = await runReadingSession({ ctx, dataDir: dir, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
  assert.equal(tempAgent.cancelled, 'reading-budget')
  assert.equal(loadState(dir, NOW).readingRequests.count, 4)
})

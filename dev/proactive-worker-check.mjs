import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, noteUser, noteContact, emptyState, updateState, addPendingReply } from '../lib/proactive-state.js'
import { enqueueDelivery } from '../lib/proactive-events.js'
import { nextAllowed } from '../lib/proactive-rhythm.js'
import { buildSources } from '../lib/proactive-sources.js'
import { composeProactive } from '../lib/proactive-compose.js'
import { deliverProactive, PROACTIVE_SOURCE } from '../lib/proactive-send.js'
import { createProactiveWorker } from '../lib/proactive-worker.js'

const NOW = new Date('2026-10-30T12:00:00')
const CONFIG = { maxPerDay: 1, minIntervalMinutes: 180, idleMinutes: 45, unansweredPauseAfter: 2, burstMax: 0, burstGapSeconds: 45, burstWindowSeconds: 180, quietStart: 1350, quietEnd: 480 }
const BURST_CONFIG = { ...CONFIG, burstMax: 1 }

test('a slow life tick renews its lease and stops new work after losing ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-slow-tick-'))
  let clock = NOW.getTime(), release, heartbeat, control
  const gate = new Promise(resolve => { release = resolve })
  const first = createProactiveWorker({ dataDir: dir, owner: 'desktop', now: () => new Date(clock),
    setInterval: fn => { heartbeat = fn; return { unref() {} } }, clearInterval() {},
    lifeTick: async (_at, options) => { control = options; await gate } })
  const second = createProactiveWorker({ dataDir: dir, owner: 'web', now: () => new Date(clock), lifeTick: async () => {} })
  try {
    const pending = first.tick()
    await Promise.resolve()
    clock += 240000
    heartbeat?.()
    clock += 120000
    assert.equal((await second.tick()).reason, 'locked')
    first.stop()
    assert.equal(control.canContinue(), false)
    assert.notEqual((await second.tick()).reason, 'locked')
    release()
    assert.equal((await pending).reason, 'lease-lost')
  } finally { release(); first.stop(); second.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('a suspended old worker cannot retake a lease after another profile resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-resumed-tick-'))
  let clock = NOW.getTime(), release, control
  const gate = new Promise(resolve => { release = resolve })
  const first = createProactiveWorker({ dataDir: dir, owner: 'desktop', now: () => new Date(clock),
    setInterval: () => ({ unref() {} }), clearInterval() {},
    lifeTick: async (_at, options) => { control = options; await gate } })
  const second = createProactiveWorker({ dataDir: dir, owner: 'web', now: () => new Date(clock), lifeTick: async () => {} })
  try {
    const pending = first.tick()
    await Promise.resolve()
    clock += 301000 // No heartbeat ran during suspension.
    assert.notEqual((await second.tick()).reason, 'locked')
    assert.equal(control.canContinue(), false)
    second.stop()
    assert.equal(control.canContinue(), false, 'ownership loss stays latched even after the winner exits')
    release()
    assert.equal((await pending).reason, 'lease-lost')
  } finally { release(); first.stop(); second.stop(); rmSync(dir, { recursive: true, force: true }) }
})

function mockLlm(texts) {
  return {
    stream() {
      return (async function* () {
        const text = texts.shift() ?? ''
        if (text) yield { type: 'text-delta', text }
      })()
    },
  }
}

function mockCtx(llm, sent) {
  const agent = {
    session: { id: 'sess-1' },
    followup(message) { sent.push(message) },
  }
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
      if (name === 'sessions') return { flush: async () => true }
      return null
    },
    agent,
  }
}

test('state ledger tracks daily budget, unanswered and corrections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 's1'
    noteUser(state, new Date('2026-10-30T11:00:00'))
    noteContact(state, { id: 'c1', at: '2026-10-30T11:10:00', purpose: 'care', source: 'test', topic: 'x', status: 'sent' }, NOW)
    assert.equal(state.sentToday, 1)
    assert.equal(state.unanswered, 1)
    saveState(dir, state)
    const loaded = loadState(dir, NOW)
    assert.equal(loaded.sentToday, 1)
    assert.equal(loaded.contacts.length, 1)
    noteUser(loaded, new Date('2026-10-30T11:20:00'))
    assert.equal(loaded.unanswered, 0)
    const tomorrow = new Date('2026-10-31T09:00:00')
    assert.equal(loadState(dir, tomorrow).sentToday, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('activeSince tracks a continuous conversation and resets after a long gap', () => {
  const state = emptyState(NOW)
  noteUser(state, new Date('2026-10-30T11:00:00'))
  assert.equal(state.activeSince, new Date('2026-10-30T11:00:00').toISOString())
  noteUser(state, new Date('2026-10-30T11:10:00'))
  assert.equal(state.activeSince, new Date('2026-10-30T11:00:00').toISOString())
  noteUser(state, new Date('2026-10-30T12:10:00'))
  assert.equal(state.activeSince, new Date('2026-10-30T12:10:00').toISOString())
})

test('rhythm enforces quiet, daily cap, idle and unanswered slowdown', () => {
  const base = { enabled: true, sessionId: 's1', sentToday: 0, unanswered: 0, lastUserAt: '2026-10-30T09:00:00', lastContactAt: '' }
  assert.equal(nextAllowed(base, NOW, CONFIG).reason, 'ready')
  assert.equal(nextAllowed({ ...base, lastUserAt: '2026-10-30T11:50:00.000Z' }, NOW, CONFIG).reason, 'idle')
  assert.equal(nextAllowed({ ...base, sentToday: 1 }, NOW, CONFIG).reason, 'daily-cap')
  assert.equal(nextAllowed({ ...base, unanswered: 2 }, NOW, CONFIG).reason, 'unanswered')
  assert.equal(nextAllowed({ ...base, lastContactAt: '2026-10-30T11:00:00' }, NOW, CONFIG).reason, 'interval')
  const quiet = nextAllowed({ ...base, lastUserAt: '2026-10-30T20:00:00.000Z' }, new Date('2026-10-30T23:00:00'), CONFIG)
  assert.equal(quiet.reason, 'quiet')
  assert.ok(quiet.at.getDate() === 31 || quiet.at.getHours() >= 8)
})

test('sources include promises, episodes and her own life', () => {
  const candidates = buildSources({
    person: {
      relation: { milestones: [] }, library: [{ title: '算法导论', state: 'reading' }],
      promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }],
      episodes: [{ at: '2026-10-28', summary: '第一次一起复盘', evidence: '原话' }],
    },
    progress: { nodes: {} }, target: null, classWindow: null, lastUserAt: '',
    life: { description: '在读《算法导论》' }, now: NOW,
  })
  const kinds = candidates.map(item => item.kind)
  assert.ok(kinds.includes('promise'))
  assert.ok(kinds.includes('episode'))
  assert.ok(kinds.includes('life'))
  assert.ok(kinds.includes('library'))
})

test('lease loss during a draft or judge blocks every later model call', async () => {
  for (const lostDuring of ['draft', 'judge']) {
    let owned = true, calls = 0
    const llm = { stream() {
      const call = ++calls
      return (async function* () {
        if (call === 1) {
          yield { type: 'text-delta', text: '在吗，昨天那道题要不要接着看？' }
          if (lostDuring === 'draft') owned = false
        } else if (call === 2 && lostDuring === 'judge') {
          owned = false
          throw new Error('adapter tools unsupported after ownership changed')
        } else yield { type: 'text-delta', text: JSON.stringify({ decision: 'send', score: 90, reason: '像她' }) }
      })()
    } }
    const result = await composeProactive({ llm, route: { provider: 'p', model: 'm' },
      candidate: { topic: '押着的卷' }, person: {}, state: {}, now: NOW, canContinue: () => owned })
    assert.equal(calls, lostDuring === 'draft' ? 1 : 2)
    assert.equal(result.ok, false)
    assert.match(result.reject, /lease-lost/)
  }
})

test('compose drafts and a successful judge returns the body', async () => {
  const llm = mockLlm(['在吗，昨天那道题要不要接着看？', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })])
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, persona: '你是小鲸。', rules: '不要汇报。',
    candidate: { topic: '押着的卷', reason: '有未完成动作' }, person: {}, state: {}, now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.body, '在吗，昨天那道题要不要接着看？')
  assert.equal(result.judge.score, 86)
})

test('compose fails closed when the judge drops or is malformed', async () => {
  const dropped = await composeProactive({
    llm: mockLlm(['在吗', JSON.stringify({ decision: 'drop', score: 20, reason: '太像汇报' })]),
    route: { provider: 'p', model: 'm' }, candidate: { topic: 'x' }, person: {}, state: {}, now: NOW,
  })
  assert.equal(dropped.ok, false)
  const malformed = await composeProactive({
    llm: mockLlm(['在吗', '不是 json']),
    route: { provider: 'p', model: 'm' }, candidate: { topic: 'x' }, person: {}, state: {}, now: NOW,
  })
  assert.equal(malformed.ok, false)
})

test('deliver sends a custom-source wake message and flushes the session', async () => {
  const sent = []
  const ctx = mockCtx(mockLlm([]), sent)
  const result = await deliverProactive({ ctx, sessionId: 'sess-1', body: '在吗' })
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].source.kind, PROACTIVE_SOURCE)
  const text = sent[0].content[0].text
  assert.match(text, /<coach_proactive>/)
  assert.match(text, /在吗/)
})

test('worker sends once, records the contact, then waits for the interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const llm = mockLlm(['在吗，昨天那道题要不要接着看？', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })])
    const worker = createProactiveWorker({
      ctx: mockCtx(llm, sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const first = await worker.tick()
    assert.equal(first.ok, true)
    assert.equal(first.reason, 'sent')
    assert.equal(sent.length, 1)
    const after = loadState(dir, NOW)
    assert.equal(after.sentToday, 1)
    assert.equal(after.contacts[0].status, 'sent')
    const second = await worker.tick()
    // 发完第一轮后 nextAt 被设成最短间隔；现在 tick 真正读 nextAt，所以
    // 第二次会停在 waiting，而不是重新算到 daily-cap。两种都说明“不会再发”。
    assert.ok(['waiting', 'daily-cap', 'interval'].includes(second.reason), second.reason)
    assert.equal(sent.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('worker does not send when the judge drops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const llm = mockLlm(['在吗', JSON.stringify({ decision: 'drop', score: 20, reason: '太像汇报' })])
    const worker = createProactiveWorker({
      ctx: mockCtx(llm, sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const result = await worker.tick()
    assert.equal(result.reason, 'judge-skip')
    assert.equal(sent.length, 0)
    assert.equal(loadState(dir, NOW).contacts[0].status, 'skipped')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('arm/disarm persist and inflight prevents a duplicate after a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const sent = []
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm([]), sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    assert.equal(worker.arm('').ok, false)
    assert.equal(worker.arm('sess-1').ok, true)
    assert.equal(loadState(dir, NOW).enabled, true)
    assert.equal(worker.disarm().ok, true)
    assert.equal(loadState(dir, NOW).enabled, false)

    const state = loadState(dir, NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.inflight = { id: 'x', at: '2026-10-30T11:58:00', topic: 'x', purpose: 'care' }
    saveState(dir, state)
    const result = await worker.tick()
    assert.equal(result.reason, 'inflight')
    assert.equal(sent.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the actual assistant reply replaces the draft in the contact record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const llm = mockLlm(['草稿正文', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })])
    const worker = createProactiveWorker({
      ctx: mockCtx(llm, sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    assert.equal((await worker.tick()).reason, 'sent')
    assert.equal(loadState(dir, NOW).contacts[0].body, '草稿正文')
    assert.equal(worker.noteActiveReply('sess-1', '她实际说出来的话', NOW), true)
    const after = loadState(dir, NOW)
    assert.equal(after.contacts[0].body, '她实际说出来的话')
    assert.equal(after.pendingReply, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('a receipt that arrives before the contact record still confirms the send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    let worker = null
    const agent = {
      session: { id: 'sess-1' },
      followup(message) {
        sent.push(message)
        // followup 先落盘、worker 后记账：模拟回执抢在 contact 前面。
        worker.confirmActiveDelivery('sess-1', message.id, NOW)
      },
    }
    const ctx = {
      get(name) {
        if (name === 'llm') return mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })])
        if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
        if (name === 'sessions') return { flush: async () => true }
        return null
      },
    }
    worker = createProactiveWorker({
      ctx, dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    assert.equal((await worker.tick()).reason, 'sent')
    const after = loadState(dir, NOW)
    assert.equal(after.contacts[0].delivery, 'confirmed')
    assert.equal(after.sentToday, 1)
    assert.equal(after.pendingReceipts.length, 0)
    assert.equal(sent.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a burst sends one short follow-up after the gap, without spending a new daily slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    let clock = NOW
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const llm = mockLlm([
      '在吗，昨天那道题要不要接着看？', JSON.stringify({ decision: 'send', score: 86, reason: '像她' }),
      '对了，不用现在回。', JSON.stringify({ decision: 'send', score: 84, reason: '补一句自然' }),
    ])
    const worker = createProactiveWorker({
      ctx: mockCtx(llm, sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: BURST_CONFIG, now: () => clock,
    })
    assert.equal((await worker.tick()).reason, 'sent')
    assert.ok(loadState(dir, clock).burst)
    clock = new Date(NOW.getTime() + 60 * 1000)
    assert.equal((await worker.tick()).reason, 'burst-sent')
    const after = loadState(dir, clock)
    assert.equal(after.burst, null)
    assert.equal(after.sentToday, 1, 'burst must not spend a second daily slot')
    assert.equal(after.unanswered, 1, 'burst must not count as another unanswered contact')
    assert.equal(after.contacts.filter(item => item.status === 'sent').length, 2)
    assert.equal(sent.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a burst is still blocked by quiet hours, daily cap and unanswered pause', () => {
  const base = { ...emptyState(new Date('2026-10-30T12:00:00')), enabled: true, sessionId: 'sess-1' }
  const midnight = new Date('2026-10-30T22:30:10')
  assert.equal(nextAllowed(base, midnight, CONFIG, { burst: true }).reason, 'quiet')
  // 每日上限按联系算，burst 是同一轮的补一句；普通路径仍然受上限约束。
  const capped = { ...base, occupiedToday: 1, lastUserAt: '2026-10-30T09:00:00' }
  assert.equal(nextAllowed(capped, new Date('2026-10-30T12:00:00'), CONFIG, { burst: true }).reason, 'ready')
  assert.equal(nextAllowed(capped, new Date('2026-10-30T12:00:00'), CONFIG).reason, 'daily-cap')
  const unanswered = { ...base, unanswered: 2, lastContactAt: '2026-10-30T11:00:00' }
  assert.equal(nextAllowed(unanswered, new Date('2026-10-30T12:00:00'), CONFIG, { burst: true }).reason, 'unanswered')
  // 同一轮补一句不再被 idle/最短间隔挡住；普通路径仍会挡。
  const recent = { ...base, lastUserAt: '2026-10-30T11:50:00', lastContactAt: '2026-10-30T11:59:00' }
  assert.equal(nextAllowed(recent, new Date('2026-10-30T12:00:00'), CONFIG, { burst: true }).reason, 'ready')
  assert.equal(nextAllowed(recent, new Date('2026-10-30T12:00:00'), CONFIG).reason, 'idle')
})

test('a due burst waits for quiet hours instead of sending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    let clock = new Date('2026-10-30T22:29:00')
    const state = emptyState(clock)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T21:00:00'
    saveState(dir, state)
    const sent = []
    const llm = mockLlm(['在吗，明天要不要接着看？', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })])
    const worker = createProactiveWorker({
      ctx: mockCtx(llm, sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T21:00:00', life: null }),
      loadVp: () => null, config: BURST_CONFIG, now: () => clock,
    })
    try {
      assert.equal((await worker.tick()).reason, 'sent')
      assert.ok(loadState(dir, clock).burst)
      clock = new Date('2026-10-30T22:30:10')
      assert.equal((await worker.tick()).reason, 'burst-wait')
      const after = loadState(dir, clock)
      assert.ok(after.burst, 'the burst is held, not silently dropped')
      assert.equal(after.contacts.filter(item => item.status === 'sent').length, 1)
      assert.equal(sent.length, 1)
      assert.ok(Date.parse(after.nextAt) > clock.getTime())
    } finally { worker.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a user reply cancels a pending burst', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const llm = mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })])
    const worker = createProactiveWorker({
      ctx: mockCtx(llm, sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: BURST_CONFIG, now: () => NOW,
    })
    assert.equal((await worker.tick()).reason, 'sent')
    worker.noteActiveUser('sess-1', new Date(NOW.getTime() + 10 * 1000))
    assert.equal(loadState(dir, NOW).burst, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('proactive skips non-critical topics while a lesson or check is active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm(['不应生成', JSON.stringify({ decision: 'send', score: 90, reason: 'x' })]), sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [{ title: '算法导论', state: 'reading' }] }),
      loadProgress: () => ({ nodes: {}, lesson: { node: '二分' } }),
      loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const result = await worker.tick()
    assert.equal(result.reason, 'busy')
    assert.equal(sent.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('two workers cannot send at the same time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    const sent = []
    const make = (owner) => createProactiveWorker({
      ctx: mockCtx(mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 86, reason: '像她' })]), sent), dataDir: dir, owner,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const a = make('owner-a')
    const b = make('owner-b')
    assert.equal((await a.tick()).reason, 'sent')
    assert.equal((await b.tick()).reason, 'locked')
    assert.equal(sent.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('start installs the tick timer and stop clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    let callback = null
    let cleared = false
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm([]), []), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
      setInterval: (fn) => { callback = fn; return { unref() {} } },
      clearInterval: () => { cleared = true },
    })
    worker.start()
    assert.equal(typeof callback, 'function')
    worker.stop()
    assert.equal(cleared, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('intensity settings change the live rhythm and reject unknown values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm([]), []), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    assert.equal(worker.setSettings({ intensity: 'light' }).ok, true)
    assert.equal(worker.status().rhythm.intensity, 'light')
    assert.equal(worker.setSettings({ intensity: 'nope' }).ok, false)
    assert.equal(worker.status().rhythm.intensity, 'light')
    assert.equal(worker.setSettings({ arbiter: false }).ok, true)
    assert.equal(worker.status().settings.arbiter, false)
    const legacyArbiter = worker.setSettings({ arbiter: true })
    assert.equal(legacyArbiter.ok, true)
    assert.equal(worker.status().settings.arbiter, true, '旧设置保留以便兼容')
    assert.equal(worker.status().effective.arbiter, false, '保存的旧开关不能冒充正在运行的仲裁')
    assert.match(legacyArbiter.summary, /兼容.*不启用/)
    assert.equal(worker.status().settings.intensity, 'light')
    assert.equal(worker.setSettings({ external: true, weatherCity: '郑州', newsSources: 'zhihu,weibo', screenVision: true }).ok, true)
    assert.equal(worker.status().settings.weatherCity, '郑州')
    assert.equal(worker.status().settings.newsSources, 'zhihu,weibo')
    assert.equal(worker.status().settings.screenVision, true)
    assert.equal(worker.setSettings({}).ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the life clock runs even when proactive contact is off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    saveState(dir, emptyState(NOW))
    let ticks = 0
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm([]), []), dataDir: dir,
      loadPerson: () => null, loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => null, loadVp: () => null,
      config: CONFIG, now: () => NOW,
      lifeTick: async () => { ticks += 1 },
    })
    const result = await worker.tick()
    assert.equal(result.reason, 'disabled')
    assert.equal(ticks, 1, 'sleep/journal/patrol do not depend on the contact switch')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no proactive message is sent while she is asleep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    saveState(dir, state)
    writeFileSync(join(dir, 'sleep-ledger.json'), JSON.stringify({
      version: 1, openingDebt: 0, presenceStarted: '',
      episodes: [{
        id: 'night-1', kind: 'night', state: 'active',
        startedAt: '2026-10-30T00:00:00', updatedAt: '2026-10-30T11:00:00',
        baseNeedMinutes: 480, targetMinutes: 480, sleptSeconds: 36000,
      }],
    }), 'utf8')
    const sent = []
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm(['不该发出去']), sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [{ text: '明天问他进度', dueAt: '2026-10-31', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const result = await worker.tick()
    assert.equal(result.reason, 'sleep-hold')
    assert.equal(sent.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a queued reading share is delivered by the worker and recorded once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T08:00:00'
    saveState(dir, state)
    // Exactly what the reading turn leaves behind: a queued line and a reply
    // slot, no send.
    updateState(dir, current => {
      addPendingReply(current, { contactId: 'c-1', at: NOW.toISOString(), sessionId: 'sess-1', draft: '读到的' })
      enqueueDelivery(current, {
        body: '我今天读到一篇讲七桥的，想到你上次画的那个图。', purpose: 'life', source: 'reading',
        topic: '读到的：七桥', at: new Date(NOW.getTime() - 120000), contactId: 'c-1',
      })
      return current
    }, NOW)
    const sent = []
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm([]), sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T08:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const result = await worker.tick()
    assert.equal(result.reason, 'queue-sent', result.reason)
    assert.equal(sent.length, 1)
    const after = loadState(dir, NOW)
    assert.equal(after.queue.length, 0)
    assert.equal(after.sentToday, 1)
    assert.equal(after.contacts[0].source, 'reading', 'the share keeps its provenance')
    assert.match(after.contacts[0].body, /七桥/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unanswered pause holds a queued share instead of waking him', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pworker-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.lastUserAt = '2026-10-30T08:00:00'
    state.unanswered = 2
    state.queue = [{
      id: 'q-1', contactId: '', body: '读到的', purpose: 'life', source: 'reading', topic: '读到的',
      at: '2026-10-30T11:58:00.000Z', nextAt: '2026-10-30T11:59:00.000Z',
      expiresAt: '2026-10-30T12:28:00.000Z', attempts: 0, error: '',
    }]
    saveState(dir, state)
    const sent = []
    const worker = createProactiveWorker({
      ctx: mockCtx(mockLlm([]), sent), dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], promises: [] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T08:00:00', life: null }),
      loadVp: () => null, config: CONFIG, now: () => NOW,
    })
    const result = await worker.tick()
    assert.equal(result.reason, 'unanswered', result.reason)
    assert.equal(sent.length, 0)
    assert.equal(loadState(dir, NOW).queue.length, 1, 'the share waits, it is not force-sent')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

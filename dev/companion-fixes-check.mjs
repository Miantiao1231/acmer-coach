import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyState, saveState, loadState, noteContact, addPendingReply, noteUser, noteAssistantReply, confirmDelivery,
} from '../lib/proactive-state.js'
import { nextAllowed, rhythmConfig } from '../lib/proactive-rhythm.js'
import { buildSources, chooseSource } from '../lib/proactive-sources.js'
import { badBody, composeProactive, draftPrompt, judgePrompt, parseJudge } from '../lib/proactive-compose.js'
import { utilityControls, resetUtilityControls, resolveModelInfoSafe } from '../lib/llm-controls.js'
import { createProactiveWorker } from '../lib/proactive-worker.js'
import { deliverProactive, wakeText } from '../lib/proactive-send.js'
import { acquireLease } from '../lib/proactive-lock.js'
import { advanceBody } from '../lib/body-state.js'
import { loadPerson, savePerson, createCompanionTool, memoryLines, personLines, emptyPerson } from '../lib/person.js'
import { selectMemory } from '../lib/memory-select.js'
import { dedupeMemories, detectMemoryConflicts, formatMemories } from '../lib/hindsight.js'
import {
  appendEvents, compactEvents, eventForClaim, loadEvents, resolveConflict, listEventArchives, readEventArchive, migrateIfEmpty,
} from '../lib/claims.js'
import { auditText } from '../lib/persona-audit.js'
import { warmthScore, isColdReply } from '../lib/warmth.js'
import { saveCompanionState, loadCompanionState, emptyCompanionState } from '../lib/companion-state.js'
import { applyReflection } from '../lib/reflection-runner.js'
import { arbitrateConflicts, arbitrateMemory } from '../lib/memory-arbiter.js'
import { lastSeenAt } from '../lib/last-seen.js'

const NOW = new Date('2026-10-30T12:00:00')
const CONFIG = {
  maxPerDay: 3, minIntervalMinutes: 30, idleMinutes: 5, unansweredPauseAfter: 2,
  burstMax: 0, burstGapSeconds: 45, burstWindowSeconds: 180, quietStart: 1350, quietEnd: 480,
}

function mockLlm(texts) {
  return {
    calls: 0,
    stream() {
      this.calls += 1
      const text = texts.shift() ?? ''
      return (async function* () { if (text) yield { type: 'text-delta', text } })()
    },
  }
}

function mockCtx(llm, sent) {
  const agent = { session: { id: 'sess-1' }, followup(message) { sent.push(message) } }
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
      if (name === 'sessions') return { flush: async () => true }
      return null
    },
  }
}

function workerFor(dir, { llm, sent = [], state, progress = { nodes: {} }, person = null, config = CONFIG, now = () => NOW }) {
  const defaultPerson = {
    profile: {}, relation: { milestones: [] }, library: [], episodes: [], boundaries: [],
    promises: [{ text: '明天问他进度', dueAt: '2026-10-30', status: 'open' }],
  }
  const base = state ?? emptyState(now())
  saveState(dir, base)
  return createProactiveWorker({
    ctx: mockCtx(llm, sent), dataDir: dir,
    loadPerson: () => person ?? defaultPerson,
    loadProgress: () => progress,
    loadSchedule: () => ({ classWindow: null }),
    loadTarget: () => null,
    loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
    loadVp: () => null, config, now,
  })
}

test('quiet hours never schedule before 08:00 after jitter', () => {
  const cfg = rhythmConfig({})
  for (let day = 1; day <= 31; day += 1) {
    const at = new Date(2026, 9, day, 7, 55)
    const next = nextAllowed({ enabled: true, sessionId: 's', sentToday: 0, unanswered: 0, lastUserAt: '', lastContactAt: '' }, at, cfg)
    assert.equal(next.reason, 'quiet')
    assert.ok(next.at.getHours() >= 8, `${at.toString()} -> ${next.at.toString()}`)
  }
})

test('malformed rhythm env falls back instead of disabling every gate', () => {
  const cfg = rhythmConfig({
    COACH_PROACTIVE_MAX_PER_DAY: 'abc', COACH_PROACTIVE_INTERVAL_MIN: 'abc',
    COACH_PROACTIVE_IDLE_MIN: 'abc', COACH_PROACTIVE_UNANSWERED_PAUSE: 'abc',
    COACH_PROACTIVE_BURST_GAP: 'abc', COACH_PROACTIVE_BURST_WINDOW: 'abc',
  })
  assert.equal(cfg.maxPerDay, 2)
  assert.equal(cfg.minIntervalMinutes, 180)
  assert.equal(cfg.idleMinutes, 45)
  assert.equal(cfg.unansweredPauseAfter, 2)
  assert.equal(cfg.burstGapSeconds, 45)
  assert.equal(cfg.burstWindowSeconds, 180)
  const gate = nextAllowed({ enabled: true, sessionId: 's', sentToday: 99, unanswered: 99, lastUserAt: '', lastContactAt: '' }, NOW, cfg)
  assert.equal(gate.reason, 'daily-cap')
})

test('occupied unconfirmed contacts still block the daily cap', () => {
  const cfg = { ...rhythmConfig({}), maxPerDay: 1 }
  const state = { enabled: true, sessionId: 's', sentToday: 0, occupiedToday: 1, unanswered: 0, lastUserAt: '', lastContactAt: '' }
  assert.equal(nextAllowed(state, NOW, cfg).reason, 'daily-cap')
})

test('burst follows the live intensity setting, not the constructor config', async () => {
  const run = async (settings, config) => {
    const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
    try {
      const state = emptyState(NOW)
      state.enabled = true
      state.sessionId = 'sess-1'
      state.route = { provider: 'p', model: 'm' }
      state.lastUserAt = '2026-10-30T09:00:00'
      state.settings = { intensity: settings }
      const llm = mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 90, reason: '像她' })])
      const worker = workerFor(dir, { llm, state, config })
      const result = await worker.tick()
      return { result, state: loadState(dir, NOW) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const light = await run('light', { ...CONFIG, burstMax: 1 })
  assert.equal(light.result.reason, 'sent')
  assert.equal(light.state.burst, null, 'light 不应该排 burst')
  const strong = await run('strong', { ...CONFIG, burstMax: 0 })
  assert.equal(strong.result.reason, 'sent')
  assert.ok(strong.state.burst, 'strong 的 preset 应该允许 burst')
})

test('nextAt is honored: a judge drop backs off instead of retrying every minute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    let clock = NOW
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    const llm = mockLlm([
      '在吗', JSON.stringify({ decision: 'drop', score: 20, reason: '太像汇报' }),
      '在吗', JSON.stringify({ decision: 'drop', score: 20, reason: '太像汇报' }),
    ])
    const worker = workerFor(dir, { llm, state, now: () => clock })
    const first = await worker.tick()
    assert.equal(first.reason, 'judge-skip')
    clock = new Date(NOW.getTime() + 60 * 1000)
    const second = await worker.tick()
    assert.equal(second.reason, 'waiting')
    assert.equal(llm.calls, 2, '第二次不应该再调模型')
    assert.equal(loadState(dir, clock).contacts.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lastSeenAt prefers the proactive ledger and falls back to companion cache', () => {
  assert.equal(lastSeenAt({ lastUserAt: '2026-10-30T12:00:00.000Z' }, { lastUserAt: '2026-10-30T09:00:00.000Z' }), '2026-10-30T12:00:00.000Z')
  assert.equal(lastSeenAt({ lastUserAt: '' }, { lastUserAt: '2026-10-30T09:00:00.000Z' }), '2026-10-30T09:00:00.000Z')
  assert.equal(lastSeenAt(null, null), '')
})

test('the worker stores a judge drop and reuses it on the next attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T11:30:00'
    state.lastUserText = '累'
    const llm = mockLlm([
      '在吗', JSON.stringify({ decision: 'drop', score: 20, reason: '太像汇报' }),
      '在吗',
    ])
    let clock = NOW
    const worker = workerFor(dir, { llm, state, now: () => clock })
    const first = await worker.tick()
    assert.equal(first.reason, 'judge-skip')
    const afterFirst = loadState(dir, clock)
    assert.equal(afterFirst.judgeCache.length, 1)
    // 跳过话题的 5 分钟冷却过去；保留 judge 缓存，清掉 nextAt。
    clock = new Date(NOW.getTime() + 6 * 60000)
    afterFirst.nextAt = ''
    saveState(dir, afterFirst)
    const second = await worker.tick()
    assert.equal(second.reason, 'judge-skip')
    assert.equal(llm.calls, 3, '第二次只应重写 draft，judge 命中缓存')
    assert.equal(loadState(dir, clock).contacts.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('disarm during compose is not overwritten and does not send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    let release
    const gate = new Promise(resolve => { release = resolve })
    let startedResolve
    const started = new Promise(resolve => { startedResolve = resolve })
    let call = 0
    const llm = {
      stream() {
        const n = call++
        return (async function* () {
          if (n === 0) { startedResolve(); await gate; yield { type: 'text-delta', text: '在吗' } }
          else yield { type: 'text-delta', text: JSON.stringify({ decision: 'send', score: 90, reason: 'x' }) }
        })()
      },
    }
    const sent = []
    const worker = workerFor(dir, { llm, sent, state })
    const pending = worker.tick()
    await started
    assert.equal(worker.disarm().ok, true)
    release()
    const result = await pending
    // disarm 同时清 enabled 并释放租约：先撞到哪道检查都算「没发出去」。
    assert.ok(['stale', 'lease-lost'].includes(result.reason), `unexpected reason ${result.reason}`)
    assert.equal(sent.length, 0)
    assert.equal(loadState(dir, NOW).enabled, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a user message during compose aborts the send and is not lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    let release
    const gate = new Promise(resolve => { release = resolve })
    let startedResolve
    const started = new Promise(resolve => { startedResolve = resolve })
    let call = 0
    const llm = {
      stream() {
        const n = call++
        return (async function* () {
          if (n === 0) { startedResolve(); await gate; yield { type: 'text-delta', text: '在吗' } }
          else yield { type: 'text-delta', text: JSON.stringify({ decision: 'send', score: 90, reason: 'x' }) }
        })()
      },
    }
    const sent = []
    const worker = workerFor(dir, { llm, sent, state })
    const pending = worker.tick()
    await started
    const spokenAt = new Date(NOW.getTime() + 1000)
    worker.noteActiveUser('sess-1', spokenAt)
    release()
    const result = await pending
    assert.equal(result.reason, 'stale')
    assert.equal(sent.length, 0)
    const after = loadState(dir, NOW)
    assert.equal(after.lastUserAt, spokenAt.toISOString())
    assert.equal(after.contacts.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pending replies are cleared by a user message and expire', () => {
  const state = emptyState(NOW)
  state.nextAt = '2026-10-30T18:00:00.000Z'
  noteContact(state, { id: 'c1', at: '2026-10-30T11:00:00.000Z', purpose: 'care', source: 'test', topic: 'x', status: 'sent' }, NOW)
  addPendingReply(state, { contactId: 'c1', at: '2026-10-30T11:00:00.000Z', sessionId: 'sess-1', draft: '在吗' })
  noteUser(state, new Date('2026-10-30T11:01:00.000Z'))
  assert.equal(state.nextAt, '', '他回来了就不该继续吃 unanswered 的 6 小时暂停')
  assert.equal(state.pendingReply, null)
  assert.equal(noteAssistantReply(state, 'sess-1', '这是回他别的问题', new Date('2026-10-30T11:02:00.000Z')), null)
  assert.equal(state.contacts[0].body, '')

  const stale = emptyState(NOW)
  noteContact(stale, { id: 'c2', at: '2026-10-30T10:00:00.000Z', purpose: 'care', source: 'test', topic: 'x', status: 'sent' }, NOW)
  addPendingReply(stale, { contactId: 'c2', at: '2026-10-30T10:00:00.000Z', sessionId: 'sess-1', draft: '在吗' })
  assert.equal(noteAssistantReply(stale, 'sess-1', '十分钟后才回', new Date('2026-10-30T10:11:00.000Z')), null)
  assert.equal(stale.pendingReply, null)
})

test('body absence recovery applies once per absence, not once per turn', () => {
  const body = {
    energy: 50, fatigue: 20, sleepDebt: 60, joy: 5, anger: 1, sorrow: 1, fear: 1,
    baseline: 6, updatedAt: '2026-10-30T06:00:00', lastCheck: '', lastSleepAt: '', lastGapAt: '',
  }
  const first = advanceBody(body, { now: NOW, lastUserAt: '2026-10-30T06:00:00' })
  const second = advanceBody(first, { now: NOW, lastUserAt: '2026-10-30T06:00:00' })
  assert.equal(second.energy, first.energy)
  assert.equal(second.sleepDebt, first.sleepDebt)
  assert.equal(second.joy, first.joy)
})

test('stale person snapshots merge instead of retracting concurrent facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const base = loadPerson(dir)
    base.habits.push({ id: 'h1', situation: '晚上', action: '先问吃饭', boundary: '', evidence: '原话', createdAt: NOW.toISOString() })
    assert.equal(savePerson(dir, base), true)
    const a = loadPerson(dir)
    const b = loadPerson(dir)
    a.habits.push({ id: 'h2', situation: '卡住', action: '先给提示', boundary: '', evidence: '原话', createdAt: NOW.toISOString() })
    assert.equal(savePerson(dir, a), true)
    b.library.push({ id: 'b1', title: '算法导论', source: '', kind: 'book', state: 'reading', progress: 0, note: '', addedAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
    assert.equal(savePerson(dir, b), true)
    const after = loadPerson(dir)
    assert.deepEqual(after.habits.map(item => item.action).sort(), ['先问吃饭', '先给提示'].sort())
    assert.equal(after.library.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pending.list describes episode/promise/boundary instead of undefined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const evidence = [{ handle: 's1', quote: '原话', time: NOW.toISOString() }]
    writeFileSync(join(dir, 'person.json'), JSON.stringify({
      version: 1, revision: 0, pending: [
        { id: 'p1', kind: 'episode', fields: { summary: '一起复盘了那道二分题', at: '2026-10-29', tags: [] }, evidence, confidence: 0.8, createdAt: NOW.toISOString(), status: 'pending' },
        { id: 'p2', kind: 'promise', fields: { text: '明天问你进度', dueAt: '2026-10-30' }, evidence, confidence: 0.8, createdAt: NOW.toISOString(), status: 'pending' },
        { id: 'p3', kind: 'boundary', fields: { text: '不要叫我宝贝' }, evidence, confidence: 0.8, createdAt: NOW.toISOString(), status: 'pending' },
      ],
    }))
    const result = await createCompanionTool(dir).execute({ action: 'pending.list' })
    assert.match(result.summary, /一起复盘了那道二分题/)
    assert.match(result.summary, /明天问你进度/)
    assert.match(result.summary, /不要叫我宝贝/)
    assert.doesNotMatch(result.summary, /undefined/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('event log compaction keeps active facts and archives the old file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const events = Array.from({ length: 8 }, (_, i) =>
      eventForClaim('profile', { field: 'likes', text: `热可可 ${i}` }, { at: NOW.toISOString() }))
    appendEvents(dir, events)
    assert.equal(loadEvents(dir).length, 8)
    const result = compactEvents(dir, { thresholdBytes: 1, keepArchives: 1 })
    assert.equal(result.ok, true)
    assert.equal(result.compacted, true)
    const after = loadEvents(dir)
    assert.equal(after.length, 1)
    assert.equal(after[0].type, 'snapshot')
    const person = loadPerson(dir, NOW)
    assert.ok(person.profile.likes.includes('热可可 0'))
    assert.ok(person.profile.likes.includes('热可可 7'))
    assert.ok(readdirSync(dir).some(name => name.startsWith('person-events.archive-')))
    const archives = listEventArchives(dir)
    assert.equal(archives.length, 1)
    assert.match(archives[0].name, /^person-events\.archive-/)
    assert.ok(archives[0].size > 0)
    assert.match(readEventArchive(dir, archives[0].name), /热可可 0/)
    assert.equal(readEventArchive(dir, '../person-events.jsonl'), null)
    appendEvents(dir, [eventForClaim('profile', { field: 'likes', text: '新喜欢' }, { at: NOW.toISOString() })])
    assert.ok(loadPerson(dir, NOW).profile.likes.includes('新喜欢'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveConflict refuses an unknown value instead of wiping every identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const at = NOW.toISOString()
    appendEvents(dir, [
      eventForClaim('profile', { field: 'identity', text: '旧的她' }, { id: 'i1', at }),
      eventForClaim('profile', { field: 'identity', text: '新的她' }, { id: 'i2', at }),
    ])
    const before = loadEvents(dir)
    assert.equal(resolveConflict(dir, 'identity', '不存在的说法'), false)
    assert.equal(loadEvents(dir).length, before.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('memory selection keeps safety facts and only relevant/recent episodes', () => {
  const person = {
    pinned: [{ text: '他在准备区域赛' }],
    boundaries: [{ text: '不要叫他宝贝' }],
    episodes: [
      { at: '2026-10-29', summary: '一起复盘了二分边界', tags: [] },
      { at: '2026-10-20', summary: '聊了矩阵加速', tags: [] },
      { at: '2026-10-10', summary: '看了旧书', tags: [] },
    ],
    promises: [
      { text: '明天问他进度', dueAt: '2026-10-30', status: 'open' },
      { text: '周末一起复盘', dueAt: '2026-11-05', status: 'open' },
    ],
  }
  const relevant = selectMemory(person, { query: '二分边界还是有点乱', now: NOW })
  assert.equal(relevant.episodes.length, 2)
  assert.equal(relevant.episodes[0].summary, '一起复盘了二分边界')
  assert.equal(relevant.episodes.some(item => item.summary === '看了旧书'), false)
  assert.equal(relevant.due.length, 1)
  assert.equal(relevant.rest.length, 0)
  const recent = selectMemory(person, { query: '', now: NOW })
  assert.equal(recent.episodes.length, 1)
  assert.equal(recent.episodes[0].summary, '一起复盘了二分边界')
  const lines = memoryLines(person, NOW, { lastUserText: '' })
  assert.ok(lines.some(line => line.includes('不要叫他宝贝')))
  assert.ok(lines.some(line => line.includes('明天问他进度')))
  assert.equal(lines.some(line => line.includes('看了旧书')), false)
})

test('the optional memory arbiter selects candidates and caches the decision', async () => {
  const person = {
    revision: 7,
    episodes: [
      { id: 'e1', at: '2026-10-29', summary: '二分边界复盘', tags: [] },
      { id: 'e2', at: '2026-10-20', summary: '聊了键盘', tags: [] },
    ],
    promises: [{ id: 'p1', text: '周末一起复盘', dueAt: '2026-11-05', status: 'open' }],
  }
  const llm = mockLlm([JSON.stringify({ episode_ids: ['e1'], promise_ids: ['p1'], repair_ids: [], reason: '相关' })])
  const route = { provider: 'p', model: 'm' }
  const first = await arbitrateMemory({ llm, route, query: '二分边界怎么复盘', person, now: NOW })
  assert.equal(first.episodes[0].id, 'e1')
  assert.equal(first.rest[0].id, 'p1')
  const idle = mockLlm([])
  const second = await arbitrateMemory({ llm: idle, route, query: '二分边界怎么复盘', person, now: NOW })
  assert.equal(second.cached, true)
  assert.equal(idle.calls, 0)
  const broken = await arbitrateMemory({ llm: mockLlm(['不是 JSON']), route, query: '另一句话', person, now: NOW })
  assert.equal(broken, null)
})

test('the optional conflict arbiter returns only valid memory drops', async () => {
  const memories = [{ text: '他喜欢被叫宝贝' }, { text: '他九月要打区域赛' }]
  const claims = ['不要叫我宝贝']
  const llm = mockLlm([JSON.stringify({ drop_ids: ['m0', 'm9'], conflicts: [{ memory_id: 'm0', claim: '不要叫我宝贝', reason: '否定相反' }] })])
  const drops = await arbitrateConflicts({ llm, route: { provider: 'p', model: 'm' }, claims, memories, timeoutMs: 1000 })
  assert.equal(drops.length, 1)
  assert.equal(drops[0].memory.text, '他喜欢被叫宝贝')
})

test('word-level relevance catches a paraphrase that 2-gram would miss', () => {
  const person = {
    pinned: [], boundaries: [], promises: [],
    episodes: [
      { at: '2026-10-29', summary: '区域赛总结：最后半小时换了题', tags: [] },
      { at: '2026-10-20', summary: '聊了键盘和耳机', tags: [] },
    ],
  }
  const picked = selectMemory(person, { query: '上次比赛复盘说了什么', now: NOW })
  assert.equal(picked.episodes[0].summary, '区域赛总结：最后半小时换了题')
})

test('shared words and different dates are left for contextual judgment', () => {
  const conflicts = detectMemoryConflicts([
    { text: '他喜欢被叫宝贝' },
    { text: '他十月要打区域赛' },
    { text: '他喜欢热可可' },
  ], ['不要叫我宝贝', '他九月要打区域赛', '他讨厌热可可'])
  assert.deepEqual(conflicts, [])
})

test('archive identity is injected every turn and memory has a hard budget', () => {
  const person = {
    profile: { identity: '小蓝，蓝头发的鲸鱼娘', likes: [], dislikes: [], quirks: [], background: [] },
    pinned: Array.from({ length: 6 }, (_, i) => ({ text: `置顶 ${i} `.padEnd(100, '字') })),
    boundaries: Array.from({ length: 6 }, (_, i) => ({ text: `边界 ${i} `.padEnd(100, '线') })),
    episodes: Array.from({ length: 6 }, (_, i) => ({ at: '2026-10-29', summary: `经历 ${i} `.padEnd(80, '事'), tags: [] })),
    promises: [{ text: '明天问他进度', dueAt: '2026-10-30', status: 'open' }],
    relation: { milestones: [] }, habits: [], library: [], style: [], pending: [], conflicts: [],
  }
  const lines = personLines(person, NOW)
  assert.ok(lines.some(line => line.includes('小蓝，蓝头发的鲸鱼娘')))
  const memories = memoryLines(person, NOW, { lastUserText: '' })
  assert.ok(memories.join('\n').length <= 1800, `memory budget ${memories.join('\n').length}`)
})

test('Hindsight auto injection is capped to three memories', () => {
  const memories = Array.from({ length: 5 }, (_, i) => ({ text: `记忆 ${i}`, document_id: `d${i}` }))
  const text = formatMemories(memories, { limit: 3, maxChars: 1200 })
  assert.equal(text.split('\n').filter(Boolean).length, 3)
  assert.match(text, /记忆 0/)
  assert.doesNotMatch(text, /记忆 3/)
  const dedupeInput = [
    { text: '一起复盘了二分边界，他说这次终于接上了' },
    { text: '他提过想换一个更安静的键盘' },
  ]
  const deduped = dedupeMemories(dedupeInput, ['一起复盘了二分边界'])
  assert.deepEqual(deduped, dedupeInput, 'a shorter local note cannot replace a richer recalled memory')
  const sourced = { id: 'm1', text: '同一句话', document_id: 'd1' }
  const anotherSource = { id: 'm2', text: '同一句话', document_id: 'd2' }
  assert.deepEqual(dedupeMemories([sourced, { ...sourced }, anotherSource]), [sourced, anotherSource])
})

test('the optional memory arbiter sees a relevant thirteenth episode before truncating candidates', async () => {
  const episodes = Array.from({ length: 13 }, (_, index) => ({
    id: `tail-e${index}`, at: index === 12 ? '2026-10-29' : '2026-10-01',
    summary: index === 12 ? '一起画图理解了基环树建模' : `旧的键盘聊天 ${index}`, tags: [],
  }))
  let prompt = ''
  const llm = { async *stream(request) {
    prompt = request.messages[0].content[0].text
    yield { type: 'text-delta', text: JSON.stringify({ episode_ids: ['tail-e12'], promise_ids: [], repair_ids: [] }) }
  } }
  const selected = await arbitrateMemory({ llm, route: { provider: 'fixture', model: 'fixture' },
    query: '基环树怎么从题目建模', person: { episodes, promises: [], revision: 123 }, now: NOW })
  assert.match(prompt, /tail-e12：一起画图理解了基环树建模/)
  assert.equal(selected.episodes[0].id, 'tail-e12')
})

test('soft pending candidates are allowed without a lesson and suppressed when he is tired', async () => {
  const person = {
    profile: {}, relation: { milestones: [] }, library: [], episodes: [], boundaries: [], promises: [],
  }
  const run = async (lastUserText, lastUserAt, progress) => {
    const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
    try {
      const state = emptyState(NOW)
      state.enabled = true
      state.sessionId = 'sess-1'
      state.route = { provider: 'p', model: 'm' }
      state.lastUserAt = lastUserAt
      state.lastUserText = lastUserText
      const sent = []
      const llm = mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 90, reason: '像她' })])
      const worker = workerFor(dir, { llm, sent, state, person, progress })
      return { result: await worker.tick(), sent, state: loadState(dir, NOW) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const soft = await run('', '2026-10-30T09:00:00', { nodes: {}, pending: { node: '区间DP' } })
  assert.equal(soft.result.reason, 'sent')
  assert.match(soft.state.contacts[0].topic, /押着的卷/)
  assert.equal(soft.state.contacts[0].draft, '在吗')
  const tired = await run('好累，别催我', '2026-10-30T11:30:00', { nodes: {}, pending: { node: '区间DP' } })
  assert.equal(tired.result.reason, 'busy')
  assert.equal(tired.sent.length, 0)
  const lesson = await run('', '2026-10-30T09:00:00', { nodes: {}, lesson: { node: '二分' }, pending: { node: '区间DP' } })
  assert.equal(lesson.result.reason, 'busy')
  assert.equal(lesson.sent.length, 0)
})

test('VP source reads the real events shape and ignores stale contests', () => {
  const person = { profile: {}, relation: { milestones: [] }, library: [], promises: [], episodes: [], boundaries: [] }
  const recent = buildSources({ person, progress: null, target: null, classWindow: null, lastUserAt: '', life: null,
    vp: { events: [{ eventId: 'e1', date: '2026-10-29', contest: '区域赛' }] }, now: NOW })
  assert.equal(recent.some(item => item.kind === 'vp'), true)
  const old = buildSources({ person, progress: null, target: null, classWindow: null, lastUserAt: '', life: null,
    vp: { events: [{ eventId: 'e2', date: '2026-08-01', contest: '旧比赛' }] }, now: NOW })
  assert.equal(old.some(item => item.kind === 'vp'), false)
})

test('busy gate filters blocked candidates before choosing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    const sent = []
    const llm = mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 90, reason: 'x' })])
    const worker = workerFor(dir, { llm, sent, state, progress: { nodes: {}, pending: { node: '区间DP' } } })
    const result = await worker.tick()
    assert.equal(result.reason, 'sent', '应该选 promise，而不是先选 pending 再判 busy')
    assert.equal(sent.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a forced single-message reflection actually runs once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const hooks = []
    let calls = 0
    const llm = { stream() { calls += 1; return (async function* () { yield { type: 'text-delta', text: JSON.stringify({ summary: '记住了', proposals: [] }) } })() } }
    const ctx = { on(name, fn) { if (name === 'session/event') hooks.push(fn) }, get(name) { return name === 'llm' ? llm : null } }
    applyReflection(ctx, dir, { allowModel: () => true, reflectEvery: 12, dailyLimit: 8 })
    const session = { id: 'sess-1' }
    const message = { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住我不吃香菜' }] }
    for (const fn of hooks) {
      fn(session, { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
      fn(session, { type: 'user/message', data: { message }, seq: 1, time: NOW.toISOString() })
      fn(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    const person = loadPerson(dir)
    assert.equal(calls, 1)
    assert.equal(person.reflection.reflectCallsToday, 1)
    assert.equal(person.reflection.lastSummary, '记住了')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('judge JSON surrounded by prose is still accepted', () => {
  const parsed = parseJudge('我先看人格。\n{"decision":"send","score":86,"reason":"像她"}')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.decision, 'send')
  assert.equal(parsed.score, 86)
  assert.equal(parseJudge('完全不 JSON').ok, false)
})

test('cold replies are detected without flagging code or short answers', () => {
  const cold = '今天的检测还没有完成，建议你尽快安排时间处理一下。'
  assert.equal(isColdReply(cold), true)
  assert.ok(warmthScore(cold) < 45)
  assert.ok(auditText(cold).includes('助手腔没有情绪'))
  assert.equal(isColdReply('诶？你终于来啦——我刚刚还在想你是不是把我忘了。'), false)
  assert.equal(isColdReply('`dp[i]` 表示前 i 个物品的最大价值，转移是 `dp[i]=max(dp[i-1], dp[i-w]+v[i])`。'), false)
  assert.equal(isColdReply('好。'), false)
})

test('a cold proactive draft is rewritten once before the judge sees it', async () => {
  const llm = mockLlm([
    '今天的检测还没有完成，建议你尽快安排时间处理一下。',
    '诶？那个卷还押着呢。……我不是催你哦，就是问问。',
    JSON.stringify({ decision: 'send', score: 88, reason: '像她' }),
  ])
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, persona: '你是小鲸。', rules: '',
    candidate: { topic: '押着的卷', reason: '未完成' }, person: {}, state: {}, now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.warmed, true)
  assert.match(result.body, /我不是催你/)
  assert.equal(llm.calls, 3, '冷初稿 = draft + 重写 + judge')
})

test('judge prefers a structured tool call when the adapter emits one', async () => {
  const calls = []
  const queue = [
    { text: '在吗，昨天那道题要不要接着看？' },
    { tool: ['{"decision":"send",', '"score":91,"reason":"像她"}'] },
  ]
  const llm = {
    stream(options) {
      calls.push(options)
      const next = queue.shift() ?? {}
      return (async function* () {
        if (next.text) yield { type: 'text-delta', text: next.text }
        for (const part of next.tool ?? []) {
          yield { type: 'tool-call-delta', id: 'j1', name: 'judge_proactive', argumentsDelta: part }
        }
      })()
    },
  }
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, candidate: { topic: '押着的卷', reason: '未完成' },
    person: {}, state: {}, now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.judge.score, 91)
  assert.equal(calls[1].tools?.[0]?.name, 'judge_proactive')
})

test('a skipped topic cools down before being picked again', () => {
  const at = new Date('2026-10-30T15:00:00')
  const person = { relation: { milestones: [] }, library: [] }
  const progress = { nodes: {}, pending: { node: '区间 DP' } }
  const candidates = buildSources({ person, progress, target: null, classWindow: null, lastUserAt: '', life: null, vp: null, now: at })
  const state = { recent: [{ topic: '押着的卷「区间 DP」还没做完', at: at.toISOString(), cooldownMinutes: 60 }] }
  assert.equal(chooseSource(candidates, { state, now: at }), null)
  const later = new Date(at.getTime() + 61 * 60000)
  assert.ok(chooseSource(candidates, { state, now: later }))
})

test('badBody uses a whole-word AI check and compose includes pinned/conflicts', () => {
  assert.equal(badBody('wait a moment'), '')
  assert.equal(badBody('domain 里再拆一层'), '')
  assert.notEqual(badBody('AI 说这样做'), '')
  const candidate = { topic: '他答应过的事', reason: '约定', evidence: '承诺记录：明天问他进度（2026-10-31）' }
  const person = {
    pinned: [{ text: '他九月要打区域赛' }],
    conflicts: [{ kind: 'profile', values: ['旧她', '新她'] }],
    boundaries: [], episodes: [], promises: [],
  }
  const prompt = draftPrompt({ persona: '你是小鲸。', rules: '规则。', candidate, person, state: {}, now: NOW })
  assert.match(prompt, /九月要打区域赛/)
  assert.match(prompt, /旧她/)
  assert.match(prompt, /承诺记录：明天问他进度/)
  const judge = judgePrompt({ persona: '你是小鲸。', rules: '规则。', candidate, body: '明天问你进度', person, state: {}, now: NOW })
  assert.match(judge, /承诺记录：明天问他进度/)
  const judgeWithState = judgePrompt({
    persona: '你是小鲸。', rules: '规则。', candidate, body: '明天问你进度', person,
    state: { lastUserText: '我今天有点累', contacts: [{ status: 'sent', body: '昨晚那道题还押着' }] },
    roleState: '- 身体：有点累；心情：平静。', now: NOW,
  })
  assert.match(judgeWithState, /我今天有点累/)
  assert.match(judgeWithState, /昨晚那道题还押着/)
  assert.match(judgeWithState, /身体：有点累/)
  const judgeWithDialogue = judgePrompt({
    persona: '你是小鲸。', rules: '规则。', candidate, body: '明天问你进度', person,
    state: {}, dialogue: '他：我今天有点累\n她：那先歇会儿。', now: NOW,
  })
  assert.match(judgeWithDialogue, /最近对话/)
  assert.match(judgeWithDialogue, /我今天有点累/)
  const soft = draftPrompt({ persona: '', rules: '', candidate: { ...candidate, soft: true }, person, state: {}, now: NOW })
  assert.match(soft, /只轻问一句/)
})

test('an empty draft is reported as empty, not as a length problem', async () => {
  const llm = {
    stream: () => (async function* () {
      yield { type: 'reasoning-delta', text: '想了很久' }
      yield { type: 'finish', reason: { kind: 'length' } }
    })(),
  }
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, candidate: { topic: '押着的卷', reason: '未完成' },
    person: {}, state: {}, now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(result.reject, /draft 为空/)
  assert.match(result.reject, /finish=length/)
  assert.match(result.reject, /reasoning=4字/)
  assert.equal(badBody(''), '正文为空（模型没有输出正文）')
  assert.match(badBody('x'.repeat(361)), /正文过长/)
})

test('a draft delivered only as a text block is still accepted', async () => {
  const queue = [
    '训练员？那道题还押着呢，我不是催你，就是问问。',
    JSON.stringify({ decision: 'send', score: 84, reason: '像她' }),
  ]
  const llm = {
    stream() {
      const text = queue.shift() ?? ''
      return (async function* () {
        yield { type: 'block-end', block: { type: 'text', text } }
      })()
    },
  }
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, candidate: { topic: '押着的卷', reason: '未完成' },
    person: {}, state: {}, now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.judge.score, 84)
})

test('judge can fall back to a verdict written in reasoning text', async () => {
  const queue = [
    { text: '训练员？那道题还押着呢，我不是催你，就是问问。' },
    { reasoning: JSON.stringify({ decision: 'send', score: 86, reason: '像她' }) },
  ]
  const llm = {
    stream() {
      const next = queue.shift() ?? {}
      return (async function* () {
        if (next.text) yield { type: 'text-delta', text: next.text }
        if (next.reasoning) yield { type: 'reasoning-delta', text: next.reasoning }
      })()
    },
  }
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, candidate: { topic: '押着的卷', reason: '未完成' },
    person: {}, state: {}, now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.judge.score, 86)
})

test('candidate evidence is filled from the real source record', () => {
  const candidates = buildSources({
    person: { relation: { milestones: [] }, library: [], promises: [{ text: '问他进度', dueAt: '2026-10-30', status: 'open' }] },
    progress: { nodes: {}, pending: { node: '区间 DP' } },
    target: null, classWindow: null, lastUserAt: '', life: null, vp: null, now: NOW,
  })
  const promise = candidates.find(item => item.kind === 'promise')
  const pending = candidates.find(item => item.kind === 'pending')
  assert.equal(promise.evidence, '承诺记录：问他进度（2026-10-30）')
  assert.match(pending.evidence, /PROGRESS\.pending：区间 DP/)
})

test('her own life line carries book progress, journal and elapsed time', () => {
  const candidates = buildSources({
    person: {
      relation: { milestones: [] },
      library: [{ title: '算法导论', state: 'reading', progress: 0.42, note: '摊还分析' }],
    },
    progress: { nodes: {} }, target: null, classWindow: null, lastUserAt: '',
    life: { description: '在读《算法导论》 42%', day: '2026-10-30', startedAt: '2026-10-30T11:20:00' },
    journal: { day: '2026-10-30', text: '今天读到摊还分析，比想象中慢。' },
    vp: null, now: NOW,
  })
  const library = candidates.find(item => item.kind === 'library')
  assert.match(library.evidence, /progress=42%/)
  assert.match(library.evidence, /note=摊还分析/)
  const life = candidates.find(item => item.kind === 'life' && item.topic.includes('在读'))
  assert.match(life.evidence, /已经 40 分钟/)
  assert.match(life.evidence, /今天的日记：今天读到摊还分析/)
  assert.ok(candidates.some(item => item.topic === '她今天的小事' && item.evidence.includes('摊还分析')))
})

test('a repeated body is rejected before the judge call', async () => {
  const llm = mockLlm(['在吗，昨天那道题要不要接着看？'])
  const state = emptyState(NOW)
  state.contacts = [{
    id: 'c1', at: NOW.toISOString(), purpose: 'care', source: 'test', topic: '押着的卷',
    body: '在吗，昨天那道题要不要接着看？', draft: '在吗，昨天那道题要不要接着看？',
    status: 'sent', reason: '', replyAt: '', burst: false, quality: [], judge: null,
  }]
  const result = await composeProactive({
    llm, route: { provider: 'p', model: 'm' }, persona: '', rules: '',
    candidate: { topic: '押着的卷', reason: '未完成', evidence: 'PROGRESS.pending：区间 DP' },
    person: {}, state, now: NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(result.duplicate, true)
  assert.equal(llm.calls, 1, '重复正文不该再花第二次 judge 调用')
})

test('a cached judge drop is reused for the same body', async () => {
  const firstLlm = mockLlm(['在吗', JSON.stringify({ decision: 'drop', score: 20, reason: '太像汇报' })])
  const state = emptyState(NOW)
  const first = await composeProactive({
    llm: firstLlm, route: { provider: 'p', model: 'm' }, persona: '', rules: '',
    candidate: { topic: '押着的卷', reason: '未完成', evidence: 'PROGRESS.pending：区间 DP' },
    person: {}, state, now: NOW,
  })
  assert.equal(first.ok, false)
  assert.ok(first.judgeSignature)
  const cachedState = emptyState(NOW)
  cachedState.judgeCache = [{ signature: first.judgeSignature, decision: 'drop', score: 20, reason: '太像汇报', at: NOW.toISOString() }]
  const secondLlm = mockLlm(['在吗'])
  const second = await composeProactive({
    llm: secondLlm, route: { provider: 'p', model: 'm' }, persona: '', rules: '',
    candidate: { topic: '押着的卷', reason: '未完成', evidence: 'PROGRESS.pending：区间 DP' },
    person: {}, state: cachedState, now: NOW,
  })
  assert.equal(second.ok, false)
  assert.equal(second.cached, true)
  assert.equal(secondLlm.calls, 1, '缓存命中只应重写 draft，不再调 judge')
})

test('wake text is one experience plus a reminder, without hard tool bans', () => {
  const text = wakeText('外面下雨了，我想提醒你带伞。')
  assert.match(text, /你刚想起这件事/)
  assert.match(text, /外面下雨了/)
  assert.match(text, /现在主动找训练员说说/)
  assert.doesNotMatch(text, /不要调用工具|不要改写|不要提日程/)
})

test('a failed flush is still delivered instead of being retried as a duplicate', async () => {
  const sent = []
  const agent = { session: { id: 'sess-1' }, followup(message) { sent.push(message) } }
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
      if (name === 'sessions') return { flush: async () => false }
      return null
    },
  }
  const result = await deliverProactive({ ctx, sessionId: 'sess-1', body: '在吗' })
  assert.equal(result.ok, true)
  assert.equal(result.persisted, false)
  assert.equal(result.delivery, 'unknown')
  assert.equal(sent.length, 1)
})

test('an unconfirmed delivery occupies budget but is not counted as sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const state = emptyState(NOW)
    state.enabled = true
    state.sessionId = 'sess-1'
    state.route = { provider: 'p', model: 'm' }
    state.lastUserAt = '2026-10-30T09:00:00'
    const sent = []
    const agent = { session: { id: 'sess-1' }, followup(message) { sent.push(message) } }
    const ctx = {
      get(name) {
        if (name === 'llm') return mockLlm(['在吗', JSON.stringify({ decision: 'send', score: 90, reason: 'x' })])
        if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
        if (name === 'sessions') return { flush: async () => false }
        return null
      },
    }
    const worker = createProactiveWorker({
      ctx, dataDir: dir,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [], episodes: [], boundaries: [],
        promises: [{ text: '明天问他进度', dueAt: '2026-10-30', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
      loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: '2026-10-30T09:00:00', life: null }),
      loadVp: () => null, config: { ...CONFIG, burstMax: 1 }, now: () => NOW,
    })
    saveState(dir, state)
    const result = await worker.tick()
    assert.equal(result.reason, 'sent')
    const after = loadState(dir, NOW)
    assert.equal(after.sentToday, 0)
    assert.equal(after.occupiedToday, 1)
    assert.equal(after.contacts[0].delivery, 'unknown')
    assert.equal(after.burst, null)
    assert.equal(sent.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a queued proactive message becomes confirmed when its session event arrives', () => {
  const state = emptyState(NOW)
  noteContact(state, {
    id: 'c1', at: '2026-10-30T11:55:00', purpose: 'care', source: 'promise',
    topic: '押着的卷', status: 'sent', delivery: 'unknown',
  }, NOW)
  addPendingReply(state, { contactId: 'c1', at: '2026-10-30T11:55:00', sessionId: 'sess-1', draft: '在吗', messageId: 'm1' })
  assert.equal(state.sentToday, 0)
  assert.equal(state.occupiedToday, 1)
  const confirmed = confirmDelivery(state, 'sess-1', 'm1', NOW)
  assert.equal(confirmed.delivery, 'confirmed')
  assert.equal(state.sentToday, 1)
  assert.equal(confirmDelivery(state, 'sess-1', 'm1', NOW), null)
  assert.equal(state.sentToday, 1)
  assert.equal(confirmDelivery(state, 'sess-1', 'old', new Date('2026-10-30T13:00:00')), null)
})

test('reflection counters reset on a new day instead of carrying yesterday', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-'))
  try {
    const person = emptyPerson(NOW)
    person.reflection.day = '2026-10-29'
    person.reflection.reflectCallsToday = 8
    person.reflection.styleCallsToday = 8
    assert.equal(savePerson(dir, person), true)
    const today = loadPerson(dir, NOW)
    assert.equal(today.reflection.reflectCallsToday, 0)
    assert.equal(today.reflection.styleCallsToday, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stale writer cannot put yesterday reflection counts back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-race-'))
  try {
    const realNow = new Date()
    const todayKey = `${realNow.getFullYear()}-${String(realNow.getMonth() + 1).padStart(2, '0')}-${String(realNow.getDate()).padStart(2, '0')}`
    const stale = emptyPerson(realNow)
    stale.reflection = { ...stale.reflection, day: '2020-01-01', reflectCallsToday: 8, styleCallsToday: 8 }
    assert.equal(savePerson(dir, stale), true)
    const staleLoaded = loadPerson(dir, realNow)
    const today = loadPerson(dir, realNow)
    today.reflection = { ...today.reflection, day: todayKey, reflectCallsToday: 1, styleCallsToday: 0 }
    assert.equal(savePerson(dir, today), true)
    staleLoaded.reflection = { ...staleLoaded.reflection, day: '2020-01-01', reflectCallsToday: 8, styleCallsToday: 8 }
    assert.equal(savePerson(dir, staleLoaded), true)
    const fresh = loadPerson(dir, realNow)
    assert.equal(fresh.reflection.day, todayKey)
    assert.equal(fresh.reflection.reflectCallsToday, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a future reflection day is discarded instead of pinning the quota forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reflect-future-'))
  try {
    const realNow = new Date()
    const person = emptyPerson(realNow)
    person.reflection = { ...person.reflection, day: '2999-01-01', reflectCallsToday: 8, styleCallsToday: 8 }
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir, realNow)
    assert.equal(loaded.reflection.day, '')
    assert.equal(loaded.reflection.reflectCallsToday, 0)
    assert.equal(savePerson(dir, loaded), true)
    assert.equal(loadPerson(dir, realNow).reflection.day, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('utility calls pick the lowest reasoning effort and fall back safely', async () => {
  resetUtilityControls()
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'max' }, { id: 'low' }] } }) }
  assert.deepEqual(await utilityControls(llm, { provider: 'p', model: 'm' }), { reasoningEffort: 'low' })
  const noReasoning = { resolveModelInfo: async () => ({ reasoning: undefined }) }
  assert.deepEqual(await utilityControls(noReasoning, { provider: 'p', model: 'n' }), {})
  assert.deepEqual(await utilityControls(null, { provider: 'p', model: 'm' }), {})
  const hung = { resolveModelInfo: () => new Promise(() => {}) }
  const started = Date.now()
  assert.equal(await resolveModelInfoSafe(hung, { provider: 'p', model: 'hung' }, 30), null)
  assert.ok(Date.now() - started < 500, '模型目录卡住时不能拖死调用方')
  resetUtilityControls()
})

test('two first loads migrate the same facts only once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-claims-'))
  try {
    const person = emptyPerson(NOW)
    person.profile.likes = ['热可可']
    const first = migrateIfEmpty(dir, person)
    const second = migrateIfEmpty(dir, person)
    assert.equal(first.migrated, true)
    assert.equal(second.migrated, false)
    const claims = loadEvents(dir).filter(event => event.type === 'claim')
    assert.equal(claims.length, first.events.length)
    assert.equal(new Set(claims.map(event => event.claim.id)).size, claims.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stale lease can be taken over exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    writeFileSync(join(dir, 'proactive-worker.lock'), JSON.stringify({ owner: 'dead', at: '2026-10-29T00:00:00.000Z' }))
    assert.equal(acquireLease(dir, 'owner-a', NOW), true)
    assert.equal(acquireLease(dir, 'owner-b', NOW), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a corrupt companion state is backed up instead of being merged as defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-companion-'))
  try {
    writeFileSync(join(dir, 'companion-state.json'), '{broken', 'utf8')
    const state = emptyCompanionState(NOW)
    state.lastUserAt = NOW.toISOString()
    assert.equal(saveCompanionState(dir, state), true)
    assert.ok(readdirSync(dir).some(name => name.startsWith('companion-state.json.corrupt-')))
    assert.equal(loadCompanionState(dir, NOW).lastUserAt, state.lastUserAt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('companion state keeps the newer writer instead of overwriting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-fix-'))
  try {
    const newer = new Date('2026-10-30T12:00:00')
    const older = new Date('2026-10-30T11:00:00')
    saveCompanionState(dir, {
      lastUserAt: newer.toISOString(),
      body: { energy: 80, updatedAt: newer.toISOString() },
      life: { description: '在读新书', updatedAt: newer.toISOString() },
      journal: { day: '2026-10-30', text: '新日记', at: newer.toISOString() },
    })
    saveCompanionState(dir, {
      lastUserAt: older.toISOString(),
      body: { energy: 10, updatedAt: older.toISOString() },
      life: { description: '旧活动', updatedAt: older.toISOString() },
      journal: { day: '2026-10-30', text: '旧日记', at: older.toISOString() },
    })
    const loaded = loadCompanionState(dir, newer)
    assert.equal(loaded.lastUserAt, newer.toISOString())
    assert.equal(loaded.body.energy, 80)
    assert.equal(loaded.life.description, '在读新书')
    assert.equal(loaded.journal.text, '新日记')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

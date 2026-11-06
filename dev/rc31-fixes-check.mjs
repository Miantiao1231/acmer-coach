// rc.31 审查 13 项的回归用例：每条对应一个已修行为，防止默认入口再漏掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { withOperationId } from '../lib/tool-operations.js'
import { collectEvidence } from '../lib/curriculum-evidence.js'
import { emptyPerson, savePerson, loadPerson, createCompanionTool, applyProposal } from '../lib/person.js'
import { emptyState, saveState, loadState, noteContact } from '../lib/proactive-state.js'
import { enqueueDelivery } from '../lib/proactive-events.js'
import { createProactiveWorker } from '../lib/proactive-worker.js'
import { updateSleepLedger, startSleepEpisode } from '../lib/sleep-ledger.js'
import { createLifeTick } from '../lib/life-tick.js'
import { saveCompanionState, loadCompanionState } from '../lib/companion-state.js'
import { loadTaskQueue, cancelTask } from '../lib/task-queue.js'
import { recordUserMessage } from '../lib/interaction-log.js'
import { loadJournalArchive } from '../lib/journal.js'
import { TEST_FILES } from './test-files.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const fixture = (name, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `coach-rc31-${name}-`))
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body)
  return dir
}
const useHome = (dir) => Object.assign(process.env, {
  DSH_HOME: dir, COACH_DATA_DIR: dir, COACH_DB: join(dir, 'unused.db'),
  COACH_HINDSIGHT: '0', COACH_BACKGROUND_LLM: '0', COACH_EXTERNAL_SOURCES: '0',
})
const toolsFor = async (tag, get = () => undefined) => {
  const tools = new Map()
  const { apply } = await import(`../index.js?rc31-fix=${tag}`)
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {}, get })
  return tools
}
const MAP = 'meta: {version: 99}\nnodes: [{id: A, name: 基础单元, domain: fixture, depends: []}, ' +
  '{id: B, name: 待诊断单元, domain: fixture, depends: [A]}]\n'

test('只读调用不复用 operation_id 缓存，写调用仍然去重', async () => {
  const dir = fixture('operations')
  let runs = 0
  // parameters 必须每次新建：共享对象会被前一个包装器加上 operation_id，
  // 后一个包装器看到它就直接跳过，测的就不是去重逻辑了。
  const makeTool = () => ({ name: 'coach_fixture', parameters: { properties: {} },
    execute: async () => ({ ok: true, run: ++runs }) })
  const read = withOperationId(makeTool(), dir, () => true)
  assert.equal((await read.execute({ operation_id: 'same' })).run, 1)
  assert.equal((await read.execute({ operation_id: 'same' })).run, 2)
  const write = withOperationId(makeTool(), dir, () => false)
  const first = await write.execute({ operation_id: 'write-once' })
  assert.equal((await write.execute({ operation_id: 'write-once' })).run, first.run)
  rmSync(dir, { recursive: true, force: true })
})

test('真实注册的 companion / coach_curriculum 读取不复用 operation_id', async () => {
  const dir = fixture('readonly-real', {
    'MAP.yaml': 'meta: {version: 3}\nnodes: [{id: A, name: A, domain: fixture, depends: []}]\n',
    'PROGRESS.yaml': 'version: 1\nnodes: {}\n',
  })
  const saved = { ...process.env }
  try {
    useHome(dir)
    let person = loadPerson(dir)
    person.profile.identity = 'FIRST'
    savePerson(dir, person)
    const tools = await toolsFor('readonly-real')
    const first = await tools.get('companion').execute({ action: 'read', operation_id: 'companion-read' })
    person = loadPerson(dir)
    person.profile.identity = 'SECOND'
    savePerson(dir, person)
    const second = await tools.get('companion').execute({ action: 'read', operation_id: 'companion-read' })
    assert.match(first.summary, /FIRST/)
    assert.match(second.summary, /SECOND/)

    const curriculum = goal => `version: 1
revision: 1
status: complete
goal: ${goal}
baseline: 已有基础记录
weeklyHours: 1
deadline: ''
current: 0
focusNodes: [A]
focusUntil: ''
history: []
updated: ${new Date().toISOString()}
phases:
  - id: old
    title: 过去的单元
    nodes: [A]
    outcome: 完成单元
    exitCriteria: 已完成
    requiredVerified: [A]
`
    writeFileSync(join(dir, 'CURRICULUM.yaml'), curriculum('FIRST GOAL'))
    const c1 = await tools.get('coach_curriculum').execute({ action: 'read', operation_id: 'cur-read' })
    await new Promise(resolve => setTimeout(resolve, 5))
    writeFileSync(join(dir, 'CURRICULUM.yaml'), curriculum('SECOND GOAL'))
    const c2 = await tools.get('coach_curriculum').execute({ action: 'read', operation_id: 'cur-read' })
    assert.equal(c1.goal, 'FIRST GOAL')
    assert.equal(c2.goal, 'SECOND GOAL')
  } finally {
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('短而有信息量的检索词不会被历史话题替换', async () => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  const calls = []
  const hooks = new Map()
  const cleanups = []
  const previousFetch = globalThis.fetch
  const previousEnv = { ...process.env }
  try {
    Object.assign(process.env, { COACH_HINDSIGHT: '1', HINDSIGHT_URL: 'http://fixture.invalid', HINDSIGHT_BANK: 'fixture' })
    delete process.env.HINDSIGHT_API_KEY
    globalThis.fetch = async (url, opt = {}) => {
      calls.push({ url: String(url), body: opt.body ? JSON.parse(opt.body) : {} })
      return new Response('{}')
    }
    applyHindsight({
      tools: { register() {} },
      get: name => name === 'sessionQuery' ? {
        readSession: async () => ({ events: [{ type: 'user/message',
          data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '之前在讨论动态规划' }] } }] }),
      } : undefined,
      on: (name, fn) => hooks.set(name, fn),
      effect: fn => { const clean = fn(); if (typeof clean === 'function') cleanups.push(clean) },
    })
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '别催我' }] }
    await hooks.get('agent/pre-step')({ step: 1, messages: [message], agent: { session: { id: 'fixture' } } },
      async () => ({ kind: 'enter', messages: [message] }))
    const request = calls.find(call => call.url.endsWith('/recall'))
    assert.ok(request.body.query.includes('别催我'))
    assert.notEqual(request.body.query, '之前在讨论动态规划')
  } finally {
    for (const clean of cleanups) clean()
    globalThis.fetch = previousFetch
    process.env = previousEnv
  }
})

test('待确认的诊断是观察，不进能力缺口', () => {
  const evidence = collectEvidence({ nodes: { A: { diagnoses: [{
    date: '2026-11-05', category: '待确认', summary: '越界风险待核实', verification: 'quote-only',
    evidence: [{ quote: 'a[n]=1;', kind: 'wrong', why: '存在越界风险，是否导致失败仍需核对' }],
  }] } } })
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].signal, 'observation')
})

test('短练习收尾可由教练指定，诊断可观察未知前置，完成课程允许单次复习', async () => {
  const dir = fixture('teaching', { 'MAP.yaml': MAP })
  const saved = { ...process.env }
  try {
    useHome(dir)
    writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\ncursor: B\nnodes: { B: { status: studying } }')
    let tools = await toolsFor('teaching-diagnostic')
    const diagnostic = await tools.get('coach_assign').execute({ node: 'B', kind: 'diagnostic', minutes: 15,
      deliverable: '口头解释已有思路以核对起点', why: '尚无前置证据，先观察当前理解' })
    assert.equal(diagnostic.accepted, true, diagnostic.reject)

    writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\ncursor: A\nnodes: { A: { status: studying } }')
    tools = await toolsFor('teaching-tail')
    const short = await tools.get('coach_assign').execute({ node: 'A', minutes: 5, tailMinutes: 0,
      deliverable: '只手算三个点的箭头关系，不写代码' })
    assert.equal(short.accepted, true, short.reject)
    assert.equal(short.totalMinutes, 5)
    assert.equal(short.tailMinutes, 0)
    assert.deepEqual(short.blocks.map(block => block.kind), ['solve'])

    writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\ncursor: A\nnodes: { A: { status: verified } }')
    writeFileSync(join(dir, 'CURRICULUM.yaml'), `version: 1
revision: 1
status: complete
goal: 过去的课程
baseline: 已有基础记录
weeklyHours: 1
deadline: ''
current: 0
focusNodes: [A]
focusUntil: ''
history: []
updated: ${new Date().toISOString()}
phases:
  - id: old
    title: 过去的单元
    nodes: [A]
    outcome: 完成单元
    exitCriteria: 已完成
    requiredVerified: [A]
`)
    tools = await toolsFor('teaching-review')
    const review = await tools.get('coach_assign').execute({ node: 'A', purpose: 'review',
      routeReason: '用户明确报告遗忘，先做短复习核对当前理解', minutes: 10,
      deliverable: '解释一个小例子', curriculumRevision: 1 })
    assert.equal(review.accepted, true, review.reject)
  } finally {
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

const release = (promise) => new Promise(done => promise.push(done))
test('旧的处境原话迟到时不覆盖新的当前处境', async () => {
  const dir = fixture('context', { 'MAP.yaml': 'meta: {version: 3}\nnodes: []\n',
    'PROGRESS.yaml': 'version: 1\nnodes: {}\n' })
  const saved = { ...process.env }
  const releases = []
  try {
    useHome(dir)
    const query = { readSession: () => release(releases) }
    const tools = await toolsFor('context-late-write', name => name === 'sessionQuery' ? query : undefined)
    const tool = tools.get('coach_student_context')
    const exec = { agent: { session: { id: 'fixture' } } }
    const oldQuote = '合成旧处境'
    const newQuote = '合成新的当前处境'
    const snapshot = (quote, id, time) => ({ session: { id: 'fixture' }, events: [{ type: 'user/message', seq: 1, time,
      data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: quote }] } }] })
    const oldCall = tool.execute({ action: 'set', quote: oldQuote }, exec)
    const freshCall = tool.execute({ action: 'set', quote: newQuote }, exec)
    releases[1](snapshot(newQuote, 'new-source', Date.now() - 1000))
    await freshCall
    assert.equal(loadPerson(dir).context.messageId, 'new-source')
    releases[0](snapshot(oldQuote, 'old-source', Date.now() - 86400000))
    await oldCall
    assert.equal(loadPerson(dir).context.messageId, 'new-source')
    assert.equal((await tool.execute({ action: 'read' }, exec)).quote, newQuote)

    // 清除后，清除前开始的旧写不能把处境恢复。
    const lateAfterClear = tool.execute({ action: 'set', quote: oldQuote }, exec)
    await tool.execute({ action: 'clear' }, exec)
    releases[2](snapshot(oldQuote, 'cleared-late-source', Date.now() - 60000))
    await lateAfterClear
    assert.equal(loadPerson(dir).context, null)

    // 冲突回执也要过滤时效：已过期的新记录不能借「冲突」分支被带出来。
    const expired = loadPerson(dir)
    expired.context = { quote: 'synthetic expired newer',
      at: new Date(Date.now() - 2 * 86400000).toISOString(), messageId: 'expired-newer',
      expiresAt: new Date(Date.now() - 86400000).toISOString() }
    assert.equal(savePerson(dir, expired), true)
    const olderConflict = tool.execute({ action: 'set', quote: oldQuote }, exec)
    releases[3](snapshot(oldQuote, 'expired-older', Date.now() - 3 * 86400000))
    assert.equal((await olderConflict).quote, '')
    assert.equal((await tool.execute({ action: 'read' }, exec)).quote, '')
  } finally {
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('采用第 13 条候选不会静默淘汰旧偏好', async () => {
  const dir = fixture('profile')
  try {
    let person = loadPerson(dir)
    person.profile.likes = Array.from({ length: 12 }, (_, i) => `合成偏好${i}`)
    savePerson(dir, person)
    person = loadPerson(dir)
    person.pending.push({ id: 'profile-candidate', kind: 'profile', subject: 'role',
      fields: { likes: ['新采用的合成偏好'] }, confidence: 0.9,
      evidence: [{ handle: 's1', quote: '请给小鲸加一个新合成偏好', messageId: 'candidate-source' }] })
    savePerson(dir, person)
    const adopted = await createCompanionTool(dir).execute({ action: 'pending.accept', id: 'profile-candidate' },
      { origin: 'human' })
    const after = loadPerson(dir)
    assert.equal(adopted.ok, false)
    assert.ok(after.profile.likes.includes('合成偏好0'))
    assert.equal(after.profile.likes.includes('新采用的合成偏好'), false)
    assert.ok(after.pending.some(item => item.id === 'profile-candidate'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const NOW = new Date(2026, 10, 5, 12)
const CONFIG = { maxPerDay: 2, minIntervalMinutes: 180, idleMinutes: 45, unansweredPauseAfter: 2,
  burstMax: 0, quietStart: 1350, quietEnd: 480, tokenBudget: 60000 }
function proactiveFixture() {
  const dir = fixture('proactive')
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'fixture-session'
  state.lastUserAt = new Date(NOW.getTime() - 3 * 3600000).toISOString()
  const failedAt = new Date(NOW.getTime() - 120000)
  noteContact(state, { id: 'fixture-contact', at: failedAt.toISOString(), purpose: 'care', topic: '离线排队话题',
    source: 'fixture', status: 'failed', delivery: 'failed' }, NOW)
  enqueueDelivery(state, { body: '离线排队消息', at: failedAt, contactId: 'fixture-contact' })
  saveState(dir, state)
  return dir
}
function workerFor(dir, { sent, onResolve = null } = {}) {
  const ctx = { get(name) {
    if (name === 'sessionController') return { resolveAgent: async () => {
      if (onResolve) onResolve()
      return { agent: { session: { id: 'fixture-session' }, followup: message => sent.push(message) } }
    } }
    if (name === 'sessions') return { flush: async () => true }
    return null
  } }
  return createProactiveWorker({ dataDir: dir, ctx, now: () => NOW, config: CONFIG })
}

test('补发遵守角色睡眠', async () => {
  const dir = proactiveFixture()
  const sent = []
  try {
    updateSleepLedger(dir, ledger => { startSleepEpisode(ledger, { now: NOW, kind: 'nap' }); return ledger })
    const worker = workerFor(dir, { sent })
    const result = await worker.tick()
    assert.equal(result.reason, 'sleep-hold')
    assert.equal(sent.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('等待恢复期间关闭或回话，补发不再投递', async () => {
  for (const scenario of ['disarm', 'reply']) {
    const dir = proactiveFixture()
    const sent = []
    let worker
    try {
      worker = workerFor(dir, { sent, onResolve: () => {
        if (scenario === 'disarm') worker.disarm()
        else worker.noteActiveUser('fixture-session', NOW, '已回来聊天')
      } })
      const result = await worker.tick()
      assert.equal(result.reason, 'queue-invalid', scenario)
      assert.equal(sent.length, 0, scenario)
    } finally { worker?.stop(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('补发成功按普通发送记账，并更正事件状态', async () => {
  const dir = fixture('queue-accounting')
  const sent = []
  let clock = NOW
  let online = false
  const state = emptyState(NOW)
  state.enabled = true
  state.sessionId = 'full-session'
  state.route = { provider: 'fixture', model: 'fixture' }
  state.lastUserAt = new Date(NOW.getTime() - 3 * 3600000).toISOString()
  state.settings.external = false
  saveState(dir, state)
  const outputs = ['草稿正文', JSON.stringify({ decision: 'send', score: 88, reason: '离线判官' })]
  const llm = { async *stream() { yield { type: 'text-delta', text: outputs.shift() ?? '' } } }
  const ctx = { get(name) {
    if (name === 'llm') return llm
    if (name === 'sessionController') return { resolveAgent: async () => {
      if (!online) throw new Error('离线模拟不可用')
      return { agent: { session: { id: 'full-session' }, followup: message => sent.push(message) } }
    } }
    if (name === 'sessions') return { flush: async () => true }
    return null
  } }
  const worker = createProactiveWorker({ dataDir: dir, ctx, config: CONFIG, now: () => clock,
    loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [],
      promises: [{ text: '明天一起复盘', dueAt: '2026-11-06', status: 'open' }] }),
    loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }),
    loadTarget: () => null, loadCompanionState: () => ({ lastUserAt: state.lastUserAt, life: null }), loadVp: () => null })
  try {
    const first = await worker.tick()
    assert.equal(first.reason, 'send-fail')
    clock = new Date(NOW.getTime() + 20 * 60000)
    online = true
    const second = await worker.tick()
    const after = loadState(dir, clock)
    assert.equal(second.reason, 'queue-sent')
    assert.equal(sent.length, 1)
    assert.equal(after.sentToday, 1)
    assert.equal(after.occupiedToday, 1)
    assert.equal(after.unanswered, 1)
    assert.ok(after.lastContactAt)
    assert.deepEqual(after.contacts.map(item => item.status), ['sent'])
    assert.deepEqual(after.eventLedger.map(event => event.status), ['sent'])
  } finally { worker.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('被取消的生活任务不再应用模型产物', async () => {
  const dir = fixture('life-cancel')
  try {
    savePerson(dir, emptyPerson(NOW))
    saveCompanionState(dir, { lastUserAt: '',
      body: { energy: 77, updatedAt: NOW.toISOString(), energyCheckedAt: NOW.toISOString() },
      roleState: {}, life: { kind: 'idle', source: 'ambient', description: '想听歌',
        startedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }, journal: {} })
    const state = emptyState(NOW)
    state.settings.lifeImprov = true
    saveState(dir, state)
    let cancelled = false
    const llm = { async *stream() {
      const task = loadTaskQueue(dir).tasks.find(item => item.kind === 'life.improvise' && item.state === 'claimed')
      cancelled = cancelTask(dir, task.id, { now: NOW }).ok
      yield { type: 'text-delta', text: JSON.stringify({ description: '取消后仍写入的离线计划', durationMinutes: 30 }) }
    } }
    const tick = createLifeTick({ dataDir: dir, allowModel: () => false,
      getRoute: () => ({ provider: 'fixture', model: 'fixture' }), getLlm: () => llm, now: () => NOW })
    await tick(NOW)
    assert.equal(cancelled, true)
    assert.equal(loadTaskQueue(dir).tasks.find(item => item.kind === 'life.improvise')?.state, 'cancelled')
    assert.equal(loadCompanionState(dir, NOW).life.modelPlan?.description, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rewrite=false 的分段贯穿排程与账本', async () => {
  const dir = fixture('tail-chain', {
    'MAP.yaml': 'meta: {version: 99}\nnodes: [{id: A, name: A, depends: []}]\n',
    'PROGRESS.yaml': 'version: 1\ncursor: A\nnodes: {A: {status: studying}}\n',
  })
  const saved = { ...process.env }
  try {
    useHome(dir)
    const tools = await toolsFor('tail-chain')
    const assigned = await tools.get('coach_assign').execute({ node: 'A', minutes: 40, tailMinutes: 20,
      rewrite: false, deliverable: '独立完成一题，只复盘不重写' })
    assert.equal(assigned.accepted, true, assigned.reject)
    assert.deepEqual(assigned.blocks.map(block => block.kind), ['solve', 'resolve'])
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const planned = await tools.get('coach_plan').execute({ date,
      blocks: [{ node: 'A', kind: 'cycle', minutes: assigned.totalMinutes, from: '10:00' }] })
    assert.equal(planned.ok, true, planned.reject)
    const text = tools.get('coach_plan').output.render({}, planned).map(block => block.text || '').join('\n')
    assert.match(text, /40 自己做 → 20 解决遗留，不重写/)
    const persisted = parse(readFileSync(join(dir, 'PROGRESS.yaml'), 'utf8')).pendingActions.A
    assert.equal(persisted.rewrite, false)
    assert.equal(persisted.resolveMinutes, 20)
    assert.equal(persisted.rewriteMinutes, 0)
    assert.deepEqual(persisted.blocks.map(block => block.minutes), [40, 20])
  } finally {
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个独立快照各采纳一条偏好，不会写出第 13 条', () => {
  const dir = fixture('profile-race')
  try {
    let base = loadPerson(dir)
    base.profile.likes = Array.from({ length: 11 }, (_, i) => `existing${i}`)
    savePerson(dir, base)
    const first = loadPerson(dir)
    const second = loadPerson(dir)
    const proposal = text => ({ kind: 'profile', subject: 'role', fields: { likes: [text] }, confidence: 0.9,
      evidence: [{ handle: 's1', quote: 'synthetic approved role preference' }] })
    assert.equal(applyProposal(first, proposal('concurrent-A')).ok, true)
    assert.equal(applyProposal(second, proposal('concurrent-B')).ok, true)
    assert.equal(savePerson(dir, first), true)
    assert.equal(savePerson(dir, second), false)
    const after = loadPerson(dir)
    assert.equal(after.profile.likes.length, 12)
    assert.equal(after.profile.likes.includes('concurrent-B'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('会话恢复失败且用户已回话时不再把草稿入队', async () => {
  const dir = fixture('resolve-fail')
  let clock = NOW
  let online = false
  let worker
  const sent = []
  try {
    const state = emptyState(NOW)
    Object.assign(state, { enabled: true, sessionId: 'fail-session', route: { provider: 'fixture', model: 'fixture' },
      lastUserAt: new Date(NOW.getTime() - 3 * 3600000).toISOString() })
    state.settings.external = false
    saveState(dir, state)
    const outputs = ['草稿正文', JSON.stringify({ decision: 'send', score: 88, reason: '离线判官' })]
    const llm = { async *stream() { yield { type: 'text-delta', text: outputs.shift() ?? '' } } }
    const ctx = { get(name) {
      if (name === 'llm') return llm
      if (name === 'sessions') return { flush: async () => true }
      if (name === 'sessionController') return { resolveAgent: async () => {
        if (!online) {
          worker.noteActiveUser('fail-session', NOW, '这件事已经说完了')
          throw new Error('离线模拟恢复失败')
        }
        return { agent: { session: { id: 'fail-session' }, followup: message => sent.push(message) } }
      } }
      return null
    } }
    worker = createProactiveWorker({ dataDir: dir, ctx, config: { ...CONFIG, burstMax: 0, idleMinutes: 30 },
      now: () => clock,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [],
        promises: [{ text: '明天一起复盘', dueAt: '2026-11-07', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }), loadTarget: () => null,
      loadCompanionState: () => ({ lastUserAt: state.lastUserAt, life: null }), loadVp: () => null })
    const first = await worker.tick()
    assert.equal(first.reason, 'stale')
    assert.equal(loadState(dir, clock).queue.length, 0)
    clock = new Date(NOW.getTime() + 30 * 60000)
    online = true
    await worker.tick()
    assert.equal(sent.length, 0)
  } finally { worker?.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('burst 与恢复会话期间入睡都不投递', async () => {
  {
    const dir = fixture('burst-asleep')
    const sent = []
    try {
      const state = emptyState(NOW)
      Object.assign(state, { enabled: true, sessionId: 'fixture-session',
        route: { provider: 'fixture', model: 'fixture' },
        lastUserAt: new Date(NOW.getTime() - 3600000).toISOString() })
      state.settings.external = false
      state.burst = { originContactId: 'old-contact', originAt: new Date(NOW.getTime() - 60000).toISOString(),
        at: new Date(NOW.getTime() - 15000).toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString(),
        sessionId: 'fixture-session', purpose: 'care', topic: '离线补话', body: '刚才的草稿', remaining: 1 }
      updateSleepLedger(dir, ledger => { startSleepEpisode(ledger, { kind: 'nap', now: NOW }); return ledger })
      saveState(dir, state)
      const outputs = ['补一句离线内容', JSON.stringify({ decision: 'send', score: 88, reason: '离线判官' })]
      const llm = { async *stream() { yield { type: 'text-delta', text: outputs.shift() ?? '' } } }
      const ctx = { get(name) {
        if (name === 'llm') return llm
        if (name === 'sessions') return { flush: async () => true }
        if (name === 'sessionController') return { resolveAgent: async () =>
          ({ agent: { session: { id: 'fixture-session' }, followup: message => sent.push(message) } }) }
        return null
      } }
      const worker = createProactiveWorker({ ctx, dataDir: dir, now: () => NOW,
        config: { ...CONFIG, burstMax: 1, burstGapSeconds: 45, burstWindowSeconds: 180 } })
      try {
        const result = await worker.tick()
        assert.equal(result.reason, 'sleep-hold')
        assert.equal(sent.length, 0)
      } finally { worker.stop() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  {
    const dir = fixture('sleep-resolve')
    const sent = []
    try {
      const state = emptyState(NOW)
      Object.assign(state, { enabled: true, sessionId: 'fixture-session',
        route: { provider: 'fixture', model: 'fixture' },
        lastUserAt: new Date(NOW.getTime() - 3600000).toISOString() })
      state.settings.external = false
      const at = new Date(NOW.getTime() - 120000)
      noteContact(state, { id: 'contact', at: at.toISOString(), purpose: 'care',
        topic: '离线消息', status: 'failed', source: 'fixture' }, NOW)
      enqueueDelivery(state, { body: '待补发消息', purpose: 'care', topic: '离线消息', contactId: 'contact', at })
      saveState(dir, state)
      const ctx = { get(name) {
        if (name === 'sessions') return { flush: async () => true }
        if (name === 'sessionController') return { resolveAgent: async () => {
          updateSleepLedger(dir, ledger => { startSleepEpisode(ledger, { kind: 'nap', now: NOW }); return ledger })
          return { agent: { session: { id: 'fixture-session' }, followup: message => sent.push(message) } }
        } }
        return null
      } }
      const worker = createProactiveWorker({ ctx, dataDir: dir, config: CONFIG, now: () => NOW })
      try {
        const result = await worker.tick()
        assert.equal(result.reason, 'sleep-hold')
        assert.equal(sent.length, 0)
        assert.equal(loadState(dir, NOW).queue.length, 1)
      } finally { worker.stop() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('取消的日记任务不再落盘', async () => {
  const dir = fixture('journal-cancel')
  const at = new Date(2026, 10, 5, 23, 55)
  try {
    saveCompanionState(dir, { lastUserAt: '',
      body: { updatedAt: at.toISOString(), energyCheckedAt: at.toISOString() },
      roleState: {}, life: {}, journal: {} })
    recordUserMessage(dir, new Date(2026, 10, 5, 20), '离线材料：今天一起画了三个点的箭头')
    let cancelled = false
    const llm = { async *stream() {
      const task = loadTaskQueue(dir).tasks.find(item => item.kind === 'journal.write' && item.state === 'claimed')
      if (task) cancelled = cancelTask(dir, task.id, { now: at }).ok
      yield { type: 'text-delta', text: JSON.stringify({
        body: '今天一起画了三个点的箭头，纸上留下了一小段清楚的思路。' }) }
    } }
    const tick = createLifeTick({ dataDir: dir, allowModel: () => true,
      getRoute: () => ({ provider: 'fixture', model: 'fixture' }), getLlm: () => llm, now: () => at })
    await tick(at)
    assert.equal(cancelled, true)
    assert.equal(loadTaskQueue(dir).tasks.find(item => item.kind === 'journal.write')?.state, 'cancelled')
    assert.equal(loadJournalArchive(dir).entries.some(entry => entry.kind === 'journal'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('补发重建回复槽，晚到回执和实际回复都能认领', async () => {
  const dir = fixture('retry-receipt')
  let clock = NOW
  let online = false
  const sent = []
  try {
    const state = emptyState(NOW)
    Object.assign(state, { enabled: true, sessionId: 'full-session',
      route: { provider: 'fixture', model: 'fixture' },
      lastUserAt: new Date(NOW.getTime() - 3 * 3600000).toISOString() })
    state.settings.external = false
    saveState(dir, state)
    const outputs = ['草稿正文', JSON.stringify({ decision: 'send', score: 88, reason: '离线判官' })]
    const llm = { async *stream() { yield { type: 'text-delta', text: outputs.shift() ?? '' } } }
    const ctx = { get(name) {
      if (name === 'llm') return llm
      if (name === 'sessionController') return { resolveAgent: async () => {
        if (!online) throw new Error('离线不可用')
        return { agent: { session: { id: 'full-session' }, followup: message => sent.push(message) } }
      } }
      if (name === 'sessions') return { flush: async () => false }
      return null
    } }
    const worker = createProactiveWorker({ dataDir: dir, ctx, config: { ...CONFIG, burstMax: 0 },
      now: () => clock,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [],
        promises: [{ text: '明天一起复盘', dueAt: '2026-11-07', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }), loadTarget: () => null,
      loadCompanionState: () => ({ lastUserAt: state.lastUserAt, life: null }), loadVp: () => null })
    try {
      const first = await worker.tick()
      assert.equal(first.reason, 'send-fail')
      clock = new Date(NOW.getTime() + 20 * 60000)
      online = true
      const second = await worker.tick()
      assert.equal(second.reason, 'queue-sent')
      assert.equal(sent.length, 1)
      worker.confirmActiveDelivery('full-session', sent[0].id, clock)
      assert.equal(worker.noteActiveReply('full-session', '她实际说出来的离线内容', clock), true)
      const saved = loadState(dir, clock)
      assert.equal(saved.pendingReplies.length, 0)
      assert.equal(saved.pendingReceipts.length, 0)
      assert.equal(saved.contacts[0].delivery, 'confirmed')
      assert.equal(saved.sentToday, 1)
      assert.equal(saved.occupiedToday, 1)
      assert.equal(saved.contacts[0].body, '她实际说出来的离线内容')
    } finally { worker.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('补发 flush 返回前已收到实际回复，正文不被草稿覆盖', async () => {
  const dir = fixture('fast-reply')
  let clock = NOW
  let online = false
  let earlyCaptured = false
  let worker
  const sent = []
  try {
    const state = emptyState(NOW)
    Object.assign(state, { enabled: true, sessionId: 'full-session',
      route: { provider: 'fixture', model: 'fixture' },
      lastUserAt: new Date(NOW.getTime() - 3 * 3600000).toISOString() })
    state.settings.external = false
    saveState(dir, state)
    const outputs = ['草稿正文', JSON.stringify({ decision: 'send', score: 88, reason: '离线判官' })]
    const llm = { async *stream() { yield { type: 'text-delta', text: outputs.shift() ?? '' } } }
    const ctx = { get(name) {
      if (name === 'llm') return llm
      if (name === 'sessionController') return { resolveAgent: async () => {
        if (!online) throw new Error('离线不可用')
        return { agent: { session: { id: 'full-session' }, followup: message => sent.push(message) } }
      } }
      if (name === 'sessions') return { flush: async () => {
        // flush 还没返回，原生送达确认和实际回复先到。
        worker.confirmActiveDelivery('full-session', sent[0].id, clock)
        earlyCaptured = worker.noteActiveReply('full-session', '落盘确认期间已实际说出的内容', clock)
        return true
      } }
      return null
    } }
    worker = createProactiveWorker({ dataDir: dir, ctx, config: { ...CONFIG, burstMax: 0 },
      now: () => clock,
      loadPerson: () => ({ profile: {}, relation: { milestones: [] }, library: [],
        promises: [{ text: '明天一起复盘', dueAt: '2026-11-07', status: 'open' }] }),
      loadProgress: () => ({ nodes: {} }), loadSchedule: () => ({ classWindow: null }), loadTarget: () => null,
      loadCompanionState: () => ({ lastUserAt: state.lastUserAt, life: null }), loadVp: () => null })
    const first = await worker.tick()
    assert.equal(first.reason, 'send-fail')
    clock = new Date(NOW.getTime() + 20 * 60000)
    online = true
    const second = await worker.tick()
    assert.equal(second.reason, 'queue-sent')
    const saved = loadState(dir, clock)
    assert.equal(earlyCaptured, true)
    assert.equal(saved.contacts[0].body, '落盘确认期间已实际说出的内容')
    assert.ok(saved.contacts[0].replyAt)
    assert.equal(saved.contacts[0].draft, '草稿正文')
    assert.equal(saved.pendingReplies.length, 0)
    assert.equal(saved.sentToday, 1)
  } finally { worker?.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('全套测试入口只有一份文件清单', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.test, 'node dev/run-tests.mjs')
  for (const runner of ['dev/run-all.sh', 'dev.sh']) {
    assert.match(readFileSync(join(ROOT, runner), 'utf8'), /dev\/run-tests\.mjs/)
  }
  assert.ok(TEST_FILES.length >= 62)
  for (const file of TEST_FILES) assert.ok(existsSync(join(ROOT, file)), file)
})

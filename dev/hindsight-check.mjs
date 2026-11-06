import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const enter = messages => async () => ({ kind: 'enter', messages })

test('native memory snapshots are scoped to the session and disappear when no current query exists', async t => fixture(t, async ({ ctx, hooks, tick }) => {
  const contexts = new Map()
  ctx.get = name => name === 'systemPrompt' ? { refreshContext() {}, context(definition) { contexts.set(definition.name, definition) } }
    : name === 'sessionProjections' ? { stateOf() { return {} } } : undefined
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const agent = { session: { id: 'native-memory-fixture' } }, messages = [user('上次约定过什么')]
  const hook = hooks.get('agent/pre-step')[0]
  const result = await hook({ messages, step: 1, agent }, enter(messages))
  assert.equal(result.messages.length, 1)
  const memory = contexts.get('coach:memory')
  assert.match(memory.text({ agent }), /hindsight_memories/)
  assert.equal(memory.text({ agent: { session: {} } }), '')
  await hook({ messages: [], step: 1, agent }, enter([]))
  assert.equal(memory.text({ agent }), '')
}))

test('memory requests redact clear secrets from direct, derived and retained text', async t => fixture(t, async ({ ctx, hooks, tools, calls, tick, dir }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  const secret = 'sk-FAKEFIXTURE0000000000000000'
  const source = `我贴的日志 api_key=${secret}`
  ctx.get = () => ({ readSession: async () => ({ events: [{ type: 'user/message', data: user(source) }] }) })
  applyHindsight(ctx); await tick()
  for (const text of [source, '继续']) {
    const messages = [user(text)]
    await hooks.get('agent/pre-step')[0]({ messages, step: 1, agent: { session: { id: 's1' } } }, enter(messages))
  }
  await tools.get('coach_recall').execute({ query: source })
  const session = { id: 'redaction' }, event = hooks.get('session/event')[0]
  event(session, { type: 'user/message', data: user(source) })
  event(session, { type: 'assistant/message', data: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: source }] } })
  event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(); await tick()
  const payloads = calls.filter(call => call.url.endsWith('/recall') || call.url.endsWith('/memories'))
  assert.equal(payloads.length, 4)
  for (const call of payloads) {
    assert.doesNotMatch(JSON.stringify(call.body), new RegExp(secret))
    assert.match(JSON.stringify(call.body), /REDACTED/)
  }
  assert.doesNotMatch(readFileSync(join(dir, 'data', 'acmer-coach', 'tasks.json'), 'utf8'), new RegExp(secret))
}))

test('the existing task tool can inspect and retry a failed memory save without a new chat turn', async t => fixture(t, async ({ ctx, tools, calls, tick, dir }) => {
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'MAP.yaml'), 'meta: {version: 3}\nnodes: []\n')
  const { claimTask, failTask, loadTaskQueue } = await import('../lib/task-queue.js')
  const outbox = join(dir, 'data', 'acmer-coach')
  const seed = claimTask(outbox, { kind: 'memory.retain', key: 'manual-retry', lane: 'memory', maxAttempts: 1,
    payload: { endpoint: 'http://127.0.0.1:18888/v1/default/banks/fixture-coach',
      item: { document_id: 'fixture-retry', content: '下次画图', metadata: { source: 'fixture' } } } }).task
  failTask(outbox, seed.id, { fence: seed.fence, error: 'HTTP 503' })
  const { apply } = await import(`../index.js?memory-task=${Math.random()}`)
  apply(ctx); await tick()
  const taskTool = tools.get('coach_task')
  assert.match((await taskTool.execute({ action: 'list', queue: 'memory' })).summary, new RegExp(seed.id))
  assert.equal((await taskTool.execute({ action: 'retry', queue: 'memory', id: seed.id })).ok, true)
  await tick(); await tick()
  assert.equal(loadTaskQueue(outbox).tasks[0].state, 'done')
  assert.equal(calls.filter(call => call.url.endsWith('/memories')).length, 1)
  assert.equal((await tools.get('coach_status').execute({})).memoryRetainState, 'accepted')
}))

test('cancelling an in-flight memory save is not misreported as a disk failure', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  try {
    await fixture(t, async ({ ctx, hooks, tools, calls, tick, dir }) => {
      mkdirSync(join(dir, 'knowledge'), { recursive: true })
      writeFileSync(join(dir, 'knowledge', 'MAP.yaml'), 'meta: {version: 3}\nnodes: []\n')
      const { apply } = await import(`../index.js?memory-cancel=${Math.random()}`)
      const { loadTaskQueue } = await import('../lib/task-queue.js')
      apply(ctx); await tick()
      const session = { id: 'cancel-fixture' }, event = hooks.get('session/event')[0]
      event(session, { type: 'user/message', data: user('留个接续位置') })
      event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      await tick(); await tick()
      assert.equal(calls.filter(call => call.url.endsWith('/memories')).length, 1)
      const pending = loadTaskQueue(join(dir, 'data', 'acmer-coach')).tasks[0]
      assert.equal((await tools.get('coach_task').execute({ action: 'cancel', queue: 'memory', id: pending.id })).ok, true)
      release(); await tick(); await tick()
      const status = await tools.get('coach_status').execute({})
      assert.equal(status.memoryRetainState, 'idle')
      assert.equal(status.memoryLastRetainError, '')
    }, { response: async request => {
      if (request.url.endsWith('/memories')) await gate
      return new Response('{}', { status: 200 })
    } })
  } finally { release() }
})

test('failed retains survive restart with stable identity and recall cannot hide write failure', async t => {
  let failed = true
  await fixture(t, async ({ ctx, hooks, tools, calls, tick, dir }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    const { loadTaskQueue } = await import('../lib/task-queue.js')
    const health = {}
    applyHindsight(ctx, health); await tick()
    const event = hooks.get('session/event')[0], session = { id: 'durable' }
    event(session, { type: 'user/message', data: user('下次请先给我画图') })
    event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await tick(); await tick()
    const pending = loadTaskQueue(join(dir, 'data', 'acmer-coach')).tasks[0]
    assert.equal(pending?.state, 'queued')
    assert.equal(pending.attempts, 1)
    await tools.get('coach_recall').execute({ query: '查约定' })
    assert.equal(health.recallState, 'ready')
    assert.equal(health.retainState, 'pending')
    assert.equal(health.state, 'unavailable')
    assert.match(health.lastRetainError, /503/)
    failed = false
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(61000)
    const secondHealth = {}
    applyHindsight(ctx, secondHealth)
    await tick(); await tick(); await tick()
    const completed = loadTaskQueue(join(dir, 'data', 'acmer-coach')).tasks[0]
    assert.equal(completed.state, 'done')
    assert.equal(completed.attempts, 2)
    assert.equal(secondHealth.retainState, 'accepted')
    assert.equal(secondHealth.lastRetainError, '')
    const writes = calls.filter(call => call.url.endsWith('/memories'))
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0].body, writes[1].body)
  }, { response: request => new Response('{}', { status: request.url.endsWith('/memories') && failed ? 503 : 200 }) })
})

test('retain retries stay scoped, stop while disabled, and end after three attempts', async t => fixture(t, async ({ ctx, hooks, calls, tick, dir }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  const { loadTaskQueue } = await import('../lib/task-queue.js')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  applyHindsight(ctx); await tick()
  const event = hooks.get('session/event')[0], session = { id: 'bounded' }
  event(session, { type: 'user/message', data: user('保存这个约定') })
  event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(); await tick()
  const writes = () => calls.filter(call => call.url.endsWith('/memories'))
  assert.equal(writes().length, 1)
  process.env.COACH_HINDSIGHT = '0'
  t.mock.timers.tick(61000)
  applyHindsight(ctx); await tick()
  assert.equal(writes().length, 1)
  process.env.COACH_HINDSIGHT = '1'
  process.env.HINDSIGHT_BANK = 'other-fixture'
  applyHindsight(ctx); await tick(); await tick()
  assert.equal(writes().length, 1, 'a different bank must not receive old-bank tasks')
  process.env.HINDSIGHT_BANK = 'fixture-coach'
  for (let i = 0; i < 2; i++) {
    applyHindsight(ctx); await tick(); await tick(); await tick()
    t.mock.timers.tick(301000)
  }
  assert.equal(writes().length, 3)
  const terminal = loadTaskQueue(join(dir, 'data', 'acmer-coach')).tasks[0]
  assert.equal(terminal.state, 'failed')
  const health = {}
  applyHindsight(ctx, health); await tick(); await tick()
  assert.equal(writes().length, 3)
  assert.equal(health.retainState, 'failed')
  assert.equal(health.state, 'unavailable')
  assert.match(health.lastRetainError, /503/)
}, { response: request => new Response('{}', { status: request.url.endsWith('/memories') ? 503 : 200 }) }))

test('a full retain queue reports failure instead of evicting an unfinished message', async t => fixture(t, async ({ ctx, hooks, calls, tick, dir }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  const { writeJsonFile } = await import('../lib/json-store.js')
  const outbox = join(dir, 'data', 'acmer-coach'), at = new Date().toISOString()
  const tasks = Array.from({ length: 200 }, (_, i) => ({ id: `unfinished-${i}`, kind: 'memory.retain', key: `foreign-${i}`,
    payload: { endpoint: 'http://other-fixture.invalid' }, createdAt: at, runAt: at, state: 'queued' }))
  assert.equal(writeJsonFile(outbox, 'tasks.json', { version: 1, tasks }), true)
  const health = {}
  applyHindsight(ctx, health); await tick()
  const event = hooks.get('session/event')[0], session = { id: 'full' }
  event(session, { type: 'user/message', data: user('这句不能静默挤掉旧记录') })
  event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(); await tick()
  assert.equal(calls.some(call => call.url.endsWith('/memories')), false)
  assert.equal(health.retainState, 'failed')
  assert.match(health.lastRetainError, /queue-full/)
  const stored = JSON.parse(readFileSync(join(outbox, 'tasks.json'), 'utf8')).tasks
  assert.equal(stored.length, 200)
  assert.equal(stored[0].id, 'unfinished-0')
}))
async function fixture(t, run, { enabled = true, bank = 'fixture-coach', response, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-hindsight-'))
  const keys = ['COACH_HINDSIGHT', 'HINDSIGHT_URL', 'HINDSIGHT_BANK', 'HINDSIGHT_API_KEY', 'DSH_HOME', 'COACH_DATA_DIR', 'COACH_DB',
    'COACH_RECALL_BUDGET_MS', 'COACH_RECALL_BACKOFF_MS']
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  Object.assign(process.env, { COACH_HINDSIGHT: enabled ? '1' : '0', HINDSIGHT_URL: 'http://127.0.0.1:18888',
    HINDSIGHT_BANK: bank, DSH_HOME: dir, COACH_DATA_DIR: join(dir, 'knowledge'), COACH_DB: join(dir, 'unused.db') }, env)
  delete process.env.HINDSIGHT_API_KEY
  const calls = [], hooks = new Map(), tools = new Map()
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const request = { url: String(url), ...options, body: options.body && JSON.parse(options.body) }
    calls.push(request)
    if (response) return response(request)
    // Hindsight exposes bank reads at /config; the bank root only accepts mutations.
    if (request.method === 'GET' && !request.url.endsWith('/config')) return new Response('{}', { status: 405 })
    return new Response(JSON.stringify(request.url.endsWith('/recall')
      ? { results: [{ type: 'world', text: '学生明确偏好先最小反例再完整推理。' }] } : {}), { status: 200 })
  })
  const cleanups = []
  const ctx = { effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    on: (name, fn) => { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list) },
    tools: { register(tool) { tools.set(tool.name, tool) } }, inject() {} }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  try { await run({ ctx, calls, hooks, tools, dir, tick }) }
  finally {
    for (const cleanup of cleanups) cleanup()
    fetch.mock.restore()
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete process.env[k]; else process.env[k] = value }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('public coach apply mounts packaged bridge only when explicitly enabled', async t => {
  for (const enabled of [false, true]) await fixture(t, async ({ ctx, hooks, calls, tools, tick }) => {
    const { apply } = await import(`../index.js?hindsight-${Math.random()}`)
    apply(ctx); await tick()
    // 只数记忆 retain 钩子；人格复核和后台反思也挂在 session/event 上，但它们不碰 bank。
    const retainHooks = (hooks.get('session/event') || []).filter(fn => String(fn).includes('retain-'))
    assert.equal(retainHooks.length, enabled ? 1 : 0)
    assert.equal((hooks.get('agent/pre-step') || []).length, 3)
    assert.equal(tools.size, 38)
    assert.equal(tools.has('coach_recall'), true)
    if (!enabled) {
      assert.equal(calls.length, 0)
      const result = await tools.get('coach_recall').execute({ query: '检查桥状态' })
      assert.equal(result.ok, false)
      assert.match(result.reject, /COACH_HINDSIGHT/)
    }
  }, { enabled })
})

test('persistent settings keep recall working when the desktop launch omits environment variables', async t => fixture(t, async ({ ctx, calls, hooks, tools, dir, tick }) => {
  const data = join(dir, 'data', 'acmer-coach')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'hindsight.json'), JSON.stringify({ enabled: true, url: 'http://127.0.0.1:18888', bank: 'saved-coach' }))
  for (const key of ['COACH_HINDSIGHT', 'HINDSIGHT_URL', 'HINDSIGHT_BANK']) delete process.env[key]
  const { applyHindsight } = await import('../lib/hindsight.js')
  assert.equal(applyHindsight(ctx), true)
  await tick()
  const messages = [user('上节课卡在哪里？')]
  const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  assert.match(result.messages.at(-2).content[0].text, /当前时间/)
  assert.match(result.messages.at(-1).content[0].text, /hindsight_memories/)
  assert.ok(calls.every(call => call.url.includes('/banks/saved-coach')))
  assert.equal((await tools.get('coach_recall').execute({ query: '继续上节课' })).ok, true)
}))

test('disabled memory still injects time without making a network request', async t => fixture(t, async ({ ctx, calls, hooks, tools }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  assert.equal(applyHindsight(ctx), false)
  const messages = [user('今天练什么？')]
  const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  assert.equal(result.messages.length, 2)
  assert.match(result.messages[1].content[0].text, /当前时间/)
  assert.equal((await tools.get('coach_recall').execute({ query: '旧课' })).ok, false)
  assert.equal(calls.length, 0)
}, { enabled: false }))

test('native request clock replaces the legacy bridge clock even before its first injection', async t => fixture(t, async ({ ctx, calls, hooks }) => {
  const session = { id: 'native-clock-session' }
  ctx.get = name => name === 'sessionProjections' ? {
    stateOf: (candidate, key) => candidate === session && key === 'timeContext'
      ? { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null } : undefined,
  } : null
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx)
  const messages = [user('今天聊聊天')]
  const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1, agent: { session } }, enter(messages))
  assert.deepEqual(result.messages, messages, '宿主已有请求时钟，不应再追加旧 runtime 消息')
  assert.equal(calls.length, 0)
}, { enabled: false }))

test('automatic recall keeps sourced memories and does not call a separate conflict model', async t => fixture(t, async ({ ctx, hooks, dir, tick }) => {
  const { loadPerson, savePerson } = await import('../lib/person.js')
  const { saveState, emptyState } = await import('../lib/proactive-state.js')
  const { applyHindsight } = await import('../lib/hindsight.js')
  const dataDir = join(dir, 'knowledge')
  const person = loadPerson(dataDir)
  person.episodes.push({ id: 'past-contest', at: '2026-10-25', summary: '训练员2026-10-25参加比赛', tags: [], createdAt: new Date().toISOString() })
  person.boundaries.push({ id: 'local-boundary', text: '训练员不喜欢长篇说教', evidence: '不喜欢长篇说教', createdAt: new Date().toISOString() })
  assert.equal(savePerson(dataDir, person), true)
  const state = emptyState()
  state.route = { provider: 'fixture', model: 'fixture' }
  state.settings.arbiter = true
  assert.equal(saveState(dataDir, state), true)
  let modelCalls = 0
  ctx.get = name => name === 'llm' ? { async *stream() {
    modelCalls += 1
    yield { type: 'text-delta', text: '{"drop_ids":["m0","m1"],"conflicts":[]}' }
  } } : null
  applyHindsight(ctx); await tick()
  const messages = [user('下次比赛和讲题约定是什么？')]
  const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  const text = result.messages.at(-1).content[0].text
  assert.match(text, /2026-11-08/)
  assert.match(text, /完整证明/)
  assert.match(text, /future-contest/)
  assert.match(text, /teaching-preference/)
  assert.equal(modelCalls, 0)
  assert.doesNotMatch(text, /学生最新原话与已核对账本优先/)
}, { response: request => new Response(JSON.stringify(request.url.endsWith('/recall') ? { results: [
  { id: 'future-contest', document_id: 'future-source', text: '训练员计划2026-11-08参加比赛' },
  { id: 'teaching-preference', document_id: 'preference-source', text: '训练员不喜欢长篇说教，但希望讲算法时给出完整证明' },
] } : {}), { status: 200 }) }))

test('explicit environment disable overrides saved settings', async t => fixture(t, async ({ ctx, calls, hooks, tools, dir }) => {
  const data = join(dir, 'data', 'acmer-coach')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'hindsight.json'), JSON.stringify({ enabled: true, url: 'http://127.0.0.1:18888', bank: 'saved-coach' }))
  const { applyHindsight } = await import('../lib/hindsight.js')
  assert.equal(applyHindsight(ctx), false)
  const messages = [user('今天练什么？')]
  const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  assert.match(result.messages.at(-1).content[0].text, /当前时间/)
  assert.equal((await tools.get('coach_recall').execute({ query: '旧课' })).ok, false)
  assert.equal(calls.length, 0)
}, { enabled: false }))

test('malformed saved settings fail closed while time injection survives', async t => fixture(t, async ({ ctx, calls, hooks, tools, dir }) => {
  const data = join(dir, 'data', 'acmer-coach')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'hindsight.json'), '{bad json')
  delete process.env.COACH_HINDSIGHT
  const { applyHindsight } = await import('../lib/hindsight.js')
  assert.equal(applyHindsight(ctx), false)
  const messages = [user('今天练什么？')]
  const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  assert.match(result.messages.at(-1).content[0].text, /当前时间/)
  assert.match((await tools.get('coach_recall').execute({ query: '旧课' })).reject, /配置无效/)
  assert.equal(calls.length, 0)
}))

test('recall uses only real user text, first step, typed plugin messages, and preserves existing bank settings', async t => fixture(t, async ({ ctx, calls, hooks, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const pre = hooks.get('agent/pre-step')[0]
  const real = user('交换论证卡在哪里？')
  real.content.push({ type: 'image', source: 'fixture' })
  const messages = [real, { ...user('不许拿注入内容查记忆'), source: { kind: 'plugin:fixture' } }]
  const result = await pre({ messages, step: 1 }, enter(messages))
  assert.equal(result.messages[0], real)
  const appended = result.messages.slice(messages.length)
  assert.equal(appended.length, 2)
  assert.ok(appended.every(m => m.role === 'user' && m.source.kind === 'plugin:acmer-coach' && m.id))
  assert.match(appended[0].content[0].text, /当前时间/)
  assert.match(appended[1].content[0].text, /hindsight_memories/)
  const recalled = calls.find(c => c.url.endsWith('/recall'))
  assert.equal(recalled.body.query, real.content[0].text)
  assert.equal(recalled.body.max_tokens, 400)
  assert.deepEqual(recalled.body.types, ['observation'])
  assert.ok(calls.every(c => c.url.includes('/banks/fixture-coach')))
  assert.ok(calls.some(c => c.method === 'GET' && c.url.endsWith('/banks/fixture-coach/config')))
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0)
  const before = calls.length
  assert.deepEqual(await pre({ messages, step: 2 }, enter(messages)), await enter(messages)())
  assert.equal(calls.length, before)
}))

test('a low-information opener recalls recent context instead of searching for "在吗"', async t => {
  await fixture(t, async ({ ctx, calls, hooks, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx); await tick()
    const pre = hooks.get('agent/pre-step')[0]
    const messages = [user('在吗')]
    await pre({ messages, step: 1 }, enter(messages))
    const recalled = calls.find(c => c.url.endsWith('/recall'))
    assert.ok(recalled, 'generic opener still triggers recall')
    assert.notEqual(recalled.body.query, '在吗')
    assert.match(recalled.body.query, /最近的训练进展|训练员的重要偏好/)
  })
})

test('legacy coach-only bank mission upgrades once for private continuity while custom missions stay untouched', async t => {
  const oldMission = '只提炼与算法训练相关的事实：训练员卡过的题/知识点、弱项标签、错题类型、学习方法偏好、目标与里程碑。忽略日常寒暄和与训练无关的闲聊。'
  await fixture(t, async ({ ctx, calls, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx)
    await tick()
    const patch = calls.find(call => call.method === 'PATCH')
    assert.ok(patch)
    assert.match(patch.body.updates.retain_mission, /交流偏好/)
    assert.match(patch.body.updates.retain_mission, /重要经历/)
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
  }, { response: request => request.method === 'GET'
    ? new Response(JSON.stringify({ config: { retain_mission: oldMission,
      reflect_mission: '你是算法教练小鲸的记忆助手。从记忆中提炼与训练员 Mianiii 算法竞赛训练相关的事实、偏好、弱项、进展，供教练参考。' } }), { status: 200 })
    : new Response('{}', { status: 200 }) })
  await fixture(t, async ({ ctx, calls, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx)
    await tick()
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 0)
  }, { response: request => request.method === 'GET'
    ? new Response(JSON.stringify({ config: { retain_mission: '用户自定义的记忆范围' } }), { status: 200 })
    : new Response('{}', { status: 200 }) })
})

test('a blocked bank mission update does not disable ordinary recall', async t => fixture(t, async ({ ctx, hooks, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx)
  await tick()
  const messages = [user('我之前偏好怎么聊天？')]
  const decision = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  assert.match(decision.messages.at(-1).content[0].text, /hindsight_memories/)
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
}, { response: request => {
  if (request.method === 'PATCH') throw new Error('config writes disabled')
  if (request.method === 'GET') return new Response(JSON.stringify({ config: {
    retain_mission: '只提炼与算法训练相关的事实：训练员卡过的题/知识点、弱项标签、错题类型、学习方法偏好、目标与里程碑。忽略日常寒暄和与训练无关的闲聊。',
  } }), { status: 200 })
  return new Response(JSON.stringify({ results: [{ type: 'observation', text: '用户喜欢短一点的私聊。' }] }), { status: 200 })
} }))

test('automatic recall sees all text admitted after private input coalescing', async t => fixture(t, async ({ ctx, calls, hooks, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const first = user('等一下，我还没说完')
  const second = user('其实我担心的是没有人带我')
  await hooks.get('agent/pre-step')[0]({ messages: [first], step: 1 },
    async () => ({ kind: 'enter', messages: [first, second] }))
  const recalled = calls.find(call => call.url.endsWith('/recall'))
  assert.equal(recalled.body.query, '等一下，我还没说完\n其实我担心的是没有人带我')
}))

test('a native DSH schedule turn recalls its topic without pretending a human sent it', async t => fixture(t, async ({ ctx, calls, hooks, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const followup = { role: 'user', source: { kind: 'schedule' },
    content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nreminder_prompt_json: "回来继续聊矩阵加速"' }] }
  const result = await hooks.get('agent/pre-step')[0]({ messages: [followup], step: 1 },
    async () => ({ kind: 'enter', messages: [followup] }))
  assert.equal(calls.find(call => call.url.endsWith('/recall')).body.query, '回来继续聊矩阵加速')
  assert.equal(result.messages[0], followup)
}))

test('automatic recall has twelve seconds while explicit lookup keeps fifteen seconds', async t => fixture(t, async ({ ctx, hooks, tools, tick }) => {
  const timeout = AbortSignal.timeout
  const budgets = []
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return timeout(ms) })
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const messages = [user('复习上节课')]
  await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  await tools.get('coach_recall').execute({ query: '复习上节课' })
  assert.ok(budgets.includes(12000), `自动召回预算：${budgets.join(', ')}`)
  assert.ok(budgets.includes(15000), `主动深查预算：${budgets.join(', ')}`)
}))

test('completed turns retain native final replies and separate interleaved sessions; failed turns do not retain', async t => fixture(t, async ({ ctx, hooks, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const event = hooks.get('session/event')[0]
  event('one', { type: 'user/message', data: user('第一位学生的真实回答') })
  event('two', { type: 'user/message', data: user('第二位学生的真实回答') })
  event('one', { type: 'user/message', data: { ...user('注入的秘密假证据'), source: { kind: 'plugin:fixture' } } })
  event('one', { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'reasoning', text: '不能保存的思维链' }, { type: 'text', text: '已核对第一位的边界' }] } } })
  event('one', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  event('two', { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'fixture failure' } } } })
  await tick(); await tick()
  const writes = calls.filter(c => c.url.endsWith('/memories'))
  assert.equal(writes.length, 1)
  assert.match(writes[0].body.items[0].content, /第一位学生/)
  assert.match(writes[0].body.items[0].content, /已核对第一位/)
  assert.doesNotMatch(writes[0].body.items[0].content, /第二位|假证据|思维链/)
  assert.equal(writes[0].body.async, true)
  assert.equal(Object.hasOwn(writes[0].body.items[0], 'timestamp'), false)
  assert.deepEqual(writes[0].body.items[0].metadata, { source: 'dsh' })
}))

test('a native schedule reply is remembered without retaining its trigger instruction', async t => fixture(t, async ({ ctx, hooks, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const event = hooks.get('session/event')[0]
  const session = { id: 'followup-session' }
  event(session, { type: 'user/message', data: { id: 'followup-1', role: 'user', source: { kind: 'schedule' },
    content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nreminder_prompt_json: "内部续聊指令"' }] } })
  event(session, { type: 'assistant/message', data: { message: { id: 'reply-1', role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'text', text: '你昨天说要从状态设计接着聊，咱们从那一格开始？' }] } } })
  event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(); await tick()
  const write = calls.find(call => call.url.endsWith('/memories'))
  assert.match(write.body.items[0].content, /小鲸主动联系/)
  assert.match(write.body.items[0].content, /昨天说要从状态设计/)
  assert.doesNotMatch(write.body.items[0].content, /内部续聊指令|SCHEDULE REMINDER/)
}))

test('a plugin proactive turn is remembered without retaining its wake instruction', async t => fixture(t, async ({ ctx, hooks, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const event = hooks.get('session/event')[0]
  const session = { id: 'proactive-session' }
  event(session, { type: 'user/message', data: { id: 'wake-1', role: 'user', source: { kind: 'plugin:acmer-coach/proactive' },
    content: [{ type: 'text', text: '<coach_proactive>这是你主动找他的时刻。只输出正文。</coach_proactive>' }] } })
  event(session, { type: 'assistant/message', data: { message: { id: 'reply-1', role: 'assistant', source: { kind: 'model' },
    content: [{ type: 'text', text: '训练员，昨天那道题还卡着吗？' }] } } })
  event(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(); await tick()
  const write = calls.find(call => call.url.endsWith('/memories'))
  assert.match(write.body.items[0].content, /小鲸主动联系/)
  assert.match(write.body.items[0].content, /昨天那道题还卡着吗/)
  assert.doesNotMatch(write.body.items[0].content, /coach_proactive|只输出正文/)
  assert.equal(write.body.items[0].metadata.kind, 'companion-followup')
}))

test('unavailable service still injects clock and can recover on a later turn', async t => {
  let down = true
  await fixture(t, async ({ ctx, hooks, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    const health = {}
    applyHindsight(ctx, health); await tick()
    const pre = hooks.get('agent/pre-step')[0], messages = [user('需要核对记忆')]
    const failed = await pre({ messages, step: 1 }, enter(messages))
    assert.equal(failed.messages.length, 2)
    assert.match(failed.messages[1].content[0].text, /当前时间/)
    assert.equal(health.state, 'unavailable')
    down = false
    const recovered = await pre({ messages, step: 1 }, enter(messages))
    assert.equal(recovered.messages.length, 3)
    assert.equal(health.state, 'ready')
  }, { env: { COACH_RECALL_BACKOFF_MS: '0' }, response: request => {
    if (down) throw new DOMException('fixture timeout', 'TimeoutError')
    return new Response(JSON.stringify(request.url.endsWith('/recall') ? { results: [{ text: '已恢复' }] } : {}))
  } })
})

test('one failed recall backs off instead of blocking every turn for the full timeout', async t => {
  let requests = 0
  await fixture(t, async ({ ctx, hooks, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx); await tick()
    const pre = hooks.get('agent/pre-step')[0], messages = [user('需要核对记忆')]
    const first = await pre({ messages, step: 1 }, enter(messages))
    assert.equal(first.messages.length, 2, '失败时只注入时钟，不塞记忆')
    const before = requests
    const second = await pre({ messages, step: 1 }, enter(messages))
    assert.equal(second.messages.length, 2, '退避期内仍然注入时钟，但不再等召回')
    assert.equal(requests, before, '退避期内一个请求都不发（连 bank 探测也不重试）')
  }, { env: { COACH_RECALL_BACKOFF_MS: '60000', COACH_RECALL_BUDGET_MS: '200' },
  response: () => {
    requests++
    throw new DOMException('fixture timeout', 'TimeoutError')
  } })
})

test('only a missing bank is created; bootstrap contains no personal user or bank defaults', async t => fixture(t, async ({ ctx, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick(); await tick()
  const put = calls.find(c => c.method === 'PUT')
  assert.ok(put)
  assert.doesNotMatch(JSON.stringify(put.body), /Mianiii|xiaojing-coach/)
}, { response: request => new Response('{}', { status: request.method === 'GET'
  ? request.url.endsWith('/config') ? 404 : 405 : 200 }) }))

test('missing or traversal bank fails closed without network or retention hooks', async t => {
  for (const bank of ['', '../someone-else', 'a/b']) await fixture(t, async ({ ctx, calls, hooks, tools }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    assert.equal(applyHindsight(ctx), false)
    assert.equal(calls.length, 0)
    assert.equal(hooks.get('session/event')?.length || 0, 0)
    assert.equal(hooks.get('agent/pre-step')?.length || 0, 1)
    assert.ok(tools.has('coach_recall'))
    const result = await tools.get('coach_recall').execute({ query: '检查桥状态' })
    assert.equal(result.ok, false)
    assert.match(result.reject, /HINDSIGHT_BANK/)
  }, { bank })
})

test('authentication is sent only in headers; logs contain neither key nor student text', async t => fixture(t, async ({ ctx, hooks, calls, dir, tick }) => {
  process.env.HINDSIGHT_API_KEY = 'fixture-service-key'
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  await hooks.get('agent/pre-step')[0]({ messages: [user('学生私有内容不该进日志')], step: 1 }, enter([user('学生私有内容不该进日志')]))
  assert.ok(calls.every(c => c.headers.Authorization === 'Bearer fixture-service-key'))
  const log = readFileSync(join(dir, 'data', 'acmer-coach', 'hindsight.log'), 'utf8')
  assert.doesNotMatch(log, /fixture-service-key|学生私有内容/)
}))

test('test preload prevents public apply from contacting a bank inherited from the launch shell', async t => fixture(t, async ({ dir }) => {
  const code = `let requests=0, eventHooks=0; globalThis.fetch=async()=>{requests++;throw Error('unexpected network')};
    const {apply}=await import('./index.js'); apply({tools:{register(){}},inject(){},on(name,fn){if(name==='session/event'&&String(fn).includes('retain-'))eventHooks++}});
    await new Promise(r=>setImmediate(r));console.log(JSON.stringify({requests,eventHooks}));`
  const result = spawnSync(process.execPath, ['--import', './dev/test-env.mjs', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, COACH_HINDSIGHT: '1', DSH_HOME: dir }, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { requests: 0, eventHooks: 0 })
}))

test('retain preserves real native event times and source identities in a stable per-turn document', async t => fixture(t, async ({ ctx, hooks, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const event = hooks.get('session/event')[0], session = { id: 'session-fixture' }
  const record = turn => {
    event(session, { type: 'user/message', seq: 10, time: 1700000000000, data: { ...user('真实学生回答'), id: 'user-1' } })
    event(session, { type: 'assistant/message', seq: 12, time: 1700000001000, data: { turn, step: 1, message: {
      id: 'assistant-1', role: 'assistant', source: { kind: 'model', replayState: 'not-for-memory' },
      content: [{ type: 'reasoning', text: 'private-reasoning' }, { type: 'text', text: '教练判断仍待验证' }],
    } } })
    event(session, { type: 'turn/end', seq: 13, time: 1700000002000, data: { turn, reason: { kind: 'completed' } } })
  }
  record(7); await tick(); await tick()
  record(7); await tick(); await tick()
  record(8); await tick(); await tick()
  const items = calls.filter(c => c.url.endsWith('/memories')).map(c => c.body.items[0])
  assert.equal(items[0].timestamp, '2023-11-14T22:13:22.000Z')
  assert.equal(items.length, 2, 'completed turn replay does not send a second extraction request')
  assert.equal(items[0].document_id, 'dsh-session-fixture-turn-7')
  assert.equal(items[1].document_id, 'dsh-session-fixture-turn-8')
  assert.deepEqual(items[0].metadata, { source: 'dsh', session_id: 'session-fixture', turn: '7',
    user_message_ids: '["user-1"]', user_event_seqs: '[10]', user_event_times: '[1700000000000]',
    assistant_message_id: 'assistant-1', assistant_event_seq: '12', assistant_event_time: '1700000001000',
    turn_end_seq: '13', turn_end_time: '1700000002000' })
  assert.ok(Object.values(items[0].metadata).every(value => typeof value === 'string'))
  assert.match(items[0].content, /2023-11-14T22:13:20.000Z/)
  assert.doesNotMatch(JSON.stringify(items[0]), /private-reasoning|not-for-memory/)
}))

test('automatic recall carries server dates and source metadata while legacy results stay unknown', async t => {
  const results = [{ id: 'fact-1', type: 'experience', text: '提炼事实仍需核对', occurred_start: '2023-11-14T22:13:20Z',
    occurred_end: '2023-11-14T22:13:21Z', mentioned_at: '2023-11-15T00:00:00Z', document_id: 'document-fixture',
    metadata: { session_id: 'session-fixture', turn: '7', user_message_ids: '["user-1"]' } }, { content: '无来源的旧记忆' }]
  await fixture(t, async ({ ctx, hooks, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx); await tick()
    const messages = [user('查询过去的答复')]
    const result = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
    const memories = result.messages.at(-1).content[0].text
    assert.match(memories, /fact-1/)
    assert.match(memories, /occurred_start.*2023-11-14T22:13:20Z/)
    assert.match(memories, /mentioned_at.*2023-11-15T00:00:00Z/)
    assert.match(memories, /session-fixture/)
    assert.match(memories, /user-1/)
    assert.match(memories, /无来源的旧记忆/)
    assert.ok(memories.length <= 4500)
  }, { response: request => new Response(JSON.stringify(request.url.endsWith('/recall') ? { results } : {})) })
})

test('coach_recall is a native thin read-only tool with structured source fields and unknown legacy dates', async t => fixture(t, async ({ ctx, tools, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  applyHindsight(ctx); await tick()
  const tool = tools.get('coach_recall')
  assert.ok(tool)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['maxTokens', 'query'])
  const result = await tool.execute({ query: '过去哪些边界解释还未核对？', maxTokens: 600 })
  assert.deepEqual(result, { ok: true, reject: '', memories: [{ text: '仍需核对', id: 'known-1', type: 'experience',
    occurred_start: '2023-11-14T22:13:20Z', mentioned_at: '2023-11-15T00:00:00Z', document_id: 'document-fixture',
    metadata: { session_id: 'session-fixture', user_message_ids: '["user-1"]' } }, { text: '旧记忆仍可读' }] })
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), [])
  const rendered = tool.output.render({}, result).map(block => block.text).join('\n')
  assert.match(rendered, /session-fixture|user-1/)
  assert.match(rendered, /提炼|核对/)
  assert.ok(rendered.length <= 4500)
  const recall = calls.find(c => c.url.endsWith('/recall'))
  assert.deepEqual(recall.body, { query: '过去哪些边界解释还未核对？', max_tokens: 600, budget: 'low' })
  assert.equal(calls.some(c => c.method === 'PUT' || c.method === 'DELETE'), false)
}, { response: request => new Response(JSON.stringify(request.url.endsWith('/recall') ? { results: [
  { id: 'known-1', text: '仍需核对', type: 'experience', occurred_start: '2023-11-14T22:13:20Z',
    mentioned_at: '2023-11-15T00:00:00Z', document_id: 'document-fixture',
    metadata: { session_id: 'session-fixture', user_message_ids: '["user-1"]', discarded: { not: 'string' } }, private_field: 'drop' },
  { content: '旧记忆仍可读', metadata: null, occurred_start: null },
] } : {})) }))

test('coach_recall rejects bounded or foreign-bank arguments before network and reports service failures safely', async t => fixture(t, async ({ ctx, tools, calls, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  applyHindsight(ctx); await tick()
  const tool = tools.get('coach_recall'), before = calls.length
  for (const args of [{ query: ' ' }, { query: 'x'.repeat(1001) }, { query: 'valid', maxTokens: 0 },
    { query: 'valid', maxTokens: 1201 }, { query: 'valid', bank: 'another-bank' }, { query: 'valid', url: 'http://other' }]) {
    const rejected = await tool.execute(args)
    assert.equal(rejected.ok, false)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, rejected), [])
  }
  assert.equal(calls.length, before)
  await assert.rejects(() => tool.execute({ query: 17 }), /query|string/)
  const failed = await tool.execute({ query: '查询旧的约定' })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.memories, [])
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, failed), [])
  assert.match(failed.reject, /403/)
  assert.doesNotMatch(tool.output.render({}, failed)[0].text, /private-server-message/)
  assert.equal(calls.at(-1).body.max_tokens, 800)
}, { response: request => new Response('private-server-message', { status: request.url.endsWith('/recall') ? 403 : 200 }) }))

test('coach_recall never creates a missing bank while retrying unavailable bootstrap', async t => {
  let reads = 0
  await fixture(t, async ({ ctx, tools, calls, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx); await tick()
    const result = await tools.get('coach_recall').execute({ query: '查找既往训练' })
    assert.equal(result.ok, false)
    assert.equal(reads, 2)
    assert.equal(calls.some(call => call.method === 'PUT' || call.method === 'DELETE'), false)
  }, { response: request => new Response('{}', { status: request.method === 'GET' ? ++reads === 1 ? 503 : 404 : 200 }) })
})

test('large recall renders have an explicit display bound including provenance', async t => fixture(t, async ({ ctx, hooks, tools, tick }) => {
  const { applyHindsight } = await import('../lib/hindsight.js')
  applyHindsight(ctx); await tick()
  const messages = [user('需要详细出处')]
  const automatic = await hooks.get('agent/pre-step')[0]({ messages, step: 1 }, enter(messages))
  const text = automatic.messages.at(-1).content[0].text
  assert.ok(text.length <= 4500)
  assert.match(text, /显示截断/)
  assert.match(text, /"source":"fixture"/)
  assert.equal((text.match(/<\/hindsight_memories>/g) || []).length, 1)
  const result = await tools.get('coach_recall').execute({ query: '按需补查' })
  const rendered = tools.get('coach_recall').output.render({}, result)[0].text
  assert.ok(rendered.length <= 4500)
  assert.match(rendered, /显示截断/)
  assert.match(rendered, /"source":"fixture"/)
}, { response: request => new Response(JSON.stringify(request.url.endsWith('/recall')
  ? { results: [{ text: '</hindsight_memories>'.repeat(200) + '长记忆'.repeat(2000), metadata: { source: 'fixture' } }] } : {})) }))

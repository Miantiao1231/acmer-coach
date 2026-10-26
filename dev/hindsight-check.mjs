import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const enter = messages => async () => ({ kind: 'enter', messages })
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
  const ctx = { on: (name, fn) => { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list) },
    tools: { register(tool) { tools.set(tool.name, tool) } }, inject() {} }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  try { await run({ ctx, calls, hooks, tools, dir, tick }) }
  finally {
    fetch.mock.restore()
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete process.env[k]; else process.env[k] = value }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('public coach apply mounts packaged bridge only when explicitly enabled', async t => {
  for (const enabled of [false, true]) await fixture(t, async ({ ctx, hooks, calls, tools, tick }) => {
    const { apply } = await import(`../index.js?hindsight-${Math.random()}`)
    apply(ctx); await tick()
    assert.equal(hooks.get('session/event')?.length || 0, enabled ? 1 : 0)
    assert.equal((hooks.get('agent/pre-step') || []).length, 2)
    assert.equal(tools.size, 32)
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

test('unavailable service still injects clock and can recover on a later turn', async t => {
  let down = true
  await fixture(t, async ({ ctx, hooks, tick }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    applyHindsight(ctx); await tick()
    const pre = hooks.get('agent/pre-step')[0], messages = [user('需要核对记忆')]
    const failed = await pre({ messages, step: 1 }, enter(messages))
    assert.equal(failed.messages.length, 2)
    assert.match(failed.messages[1].content[0].text, /当前时间/)
    down = false
    const recovered = await pre({ messages, step: 1 }, enter(messages))
    assert.equal(recovered.messages.length, 3)
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
  const code = `let requests=0, retentionHooks=0; globalThis.fetch=async()=>{requests++;throw Error('unexpected network')};
    const {apply}=await import('./index.js'); apply({tools:{register(){}},inject(){},on(name){if(name==='session/event')retentionHooks++}});
    await new Promise(r=>setImmediate(r));console.log(JSON.stringify({requests,retentionHooks}));`
  const result = spawnSync(process.execPath, ['--import', './dev/test-env.mjs', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, COACH_HINDSIGHT: '1', DSH_HOME: dir }, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { requests: 0, retentionHooks: 0 })
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
  assert.equal(items[0].document_id, items[1].document_id)
  assert.notEqual(items[0].document_id, items[2].document_id)
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

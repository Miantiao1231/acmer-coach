import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const enter = messages => async () => ({ kind: 'enter', messages })
async function fixture(t, run, { enabled = true, bank = 'fixture-coach', response } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-hindsight-'))
  const keys = ['COACH_HINDSIGHT', 'HINDSIGHT_URL', 'HINDSIGHT_BANK', 'HINDSIGHT_API_KEY', 'DSH_HOME', 'COACH_DATA_DIR', 'COACH_DB']
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  Object.assign(process.env, { COACH_HINDSIGHT: enabled ? '1' : '0', HINDSIGHT_URL: 'http://127.0.0.1:18888',
    HINDSIGHT_BANK: bank, DSH_HOME: dir, COACH_DATA_DIR: join(dir, 'knowledge'), COACH_DB: join(dir, 'unused.db') })
  delete process.env.HINDSIGHT_API_KEY
  const calls = [], hooks = new Map()
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
    tools: { register() {} }, inject() {} }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  try { await run({ ctx, calls, hooks, dir, tick }) }
  finally {
    fetch.mock.restore()
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete process.env[k]; else process.env[k] = value }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('public coach apply mounts packaged bridge only when explicitly enabled', async t => {
  for (const enabled of [false, true]) await fixture(t, async ({ ctx, hooks, calls, tick }) => {
    const { apply } = await import(`../index.js?hindsight-${Math.random()}`)
    apply(ctx); await tick()
    assert.equal(hooks.get('session/event')?.length || 0, enabled ? 1 : 0)
    assert.equal((hooks.get('agent/pre-step') || []).length, enabled ? 2 : 1)
    if (!enabled) assert.equal(calls.length, 0)
  }, { enabled })
})

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
  }, { response: request => {
    if (down) throw new DOMException('fixture timeout', 'TimeoutError')
    return new Response(JSON.stringify(request.url.endsWith('/recall') ? { results: [{ text: '已恢复' }] } : {}))
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

test('missing or traversal bank fails closed without network or hooks', async t => {
  for (const bank of ['', '../someone-else', 'a/b']) await fixture(t, async ({ ctx, calls, hooks }) => {
    const { applyHindsight } = await import('../lib/hindsight.js')
    assert.equal(applyHindsight(ctx), false)
    assert.equal(calls.length, 0); assert.equal(hooks.size, 0)
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

function shape(schema, value) {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(key in schema.properties, `unexpected field ${key}`)
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      if (field.required === true || (Array.isArray(schema.required) && schema.required.includes(key))) assert.ok(key in value, `missing field ${key}`)
      if (key in value) shape(field, value[key])
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value))
    if (schema.items) value.forEach(item => shape(schema.items, item))
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value))
  else assert.equal(typeof value, schema.type)
}

// 一个假 VP：第一页 has_more=true，第二页收尾。
// 页面路由和 coach_vp_sync 走同一份 mock，谁少做一步都会露馅。
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coach-vp-unify-'))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, fetch: globalThis.fetch }
  const account = { id: 1, handle: 'mock-account', display_name: 'Mock account' }
  const counters = { page: 0 }
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  globalThis.fetch = async url => {
    const parsed = new URL(url)
    if (parsed.pathname === '/api/coach/auth/exchange') return json({ access_token: 'test-token', user: account })
    if (parsed.pathname === '/api/coach/me') return json({ user: account, read_only: true })
    if (parsed.pathname !== '/api/coach/sync') throw new Error(`unexpected mock route ${parsed.pathname}`)
    const page = ++counters.page
    const cursor = Number(parsed.searchParams.get('submission_cursor') || 0)
    const rows = page === 1
      ? [{ id: 1, contest_id: 7, problem_id: 'A', verdict: 'AC', submitted_at: '2026-10-10T00:10:00Z' }]
      : [{ id: 2, contest_id: 7, problem_id: 'B', verdict: 'AC', submitted_at: '2026-10-10T00:40:00Z' }]
    return json({ account,
      contests: [{ id: 7, title: 'Mock VP', start_time: '2026-10-10T00:00:00Z', duration_min: 300 }],
      events: [], submissions: rows,
      next_cursor: { submission_id: rows.at(-1).id, event_id: 0 },
      has_more: page === 1, echo_cursor: cursor })
  }
  const registered = new Map()
  let handler
  const ctx = {
    tools: { register: tool => registered.set(tool.name, tool) },
    on() {}, get() {},
    effect: cb => cb(),
    webServer: { register: route => { handler = route.handler; return () => {} } },
    inject: (services, cb) => { if (services.includes('webServer')) cb(ctx) },
  }
  const { apply } = await import(`../index.js?vp-unify-${dir.replace(/\\/g, '/')}`)
  apply(ctx)
  assert.equal(typeof handler, 'function')
  const post = async (payload) => {
    const res = { status: undefined, headers: {}, body: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.body = body } }
    const req = {
      url: '/coach/api/vp/connect', method: 'POST',
      headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(payload) },
    }
    await handler(req, res)
    return { status: res.status, body: JSON.parse(String(res.body)) }
  }
  const call = async (name, args = {}) => {
    const tool = registered.get(name)
    assert.ok(tool, `missing tool ${name}`)
    const result = await tool.execute(args)
    shape(tool.output.schema, result)
    return result
  }
  const cleanup = () => {
    globalThis.fetch = previous.fetch
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, post, call, cleanup, counters }
}

function json(value) { return { ok: true, json: async () => value } }

test('the VP page sync route imports training evidence instead of only refreshing the cache', async () => {
  const f = await fixture()
  try {
    const connected = await f.post({ op: 'finish', code: 'test-code' })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))

    const first = await f.post({ op: 'sync' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.cached, true, '缓存更新是事实，要单独报')
    assert.equal(first.body.imported, 1, '页面同步必须真的导入训练证据')
    assert.equal(first.body.importOk, true, first.body.importReject)
    assert.equal(first.body.hasMore, true, '第一页还有数据，不能说完成')
    assert.deepEqual(first.body.pageCounts, { contests: 1, submissions: 1, events: 0 })
    assert.deepEqual(first.body.totals, { contests: 1, submissions: 1, events: 0 })

    const vpPath = join(f.dir, 'vp-accounts', '1', 'VP_EVENTS.yaml')
    assert.ok(existsSync(vpPath), '页面同步后必须存在账号级 VP_EVENTS.yaml')
    const events = parse(readFileSync(vpPath, 'utf8')).events
    assert.equal(events.length, 1)
    assert.equal(events[0].eventId, 'vp:1:7')

    const second = await f.post({ op: 'sync' })
    assert.equal(second.body.hasMore, false)
    assert.equal(second.body.imported, 1, '第二页应更新同一场证据而不是新增一场')
    assert.deepEqual(second.body.totals, { contests: 1, submissions: 2, events: 0 })
    assert.equal(parse(readFileSync(vpPath, 'utf8')).events.length, 1, '同一场比赛的证据不能重复')
  } finally { f.cleanup() }
})

test('coach_vp_sync returns a bounded summary instead of the accumulated cache', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.call('coach_vp_connect', { action: 'finish', code: 'test-code' })).ok, true)
    const first = await f.call('coach_vp_sync')
    assert.equal(first.ok, true, first.reject)
    assert.equal('submissions' in first, false, '不再把累计提交塞给模型')
    assert.equal('events' in first, false, '不再把累计事件塞给模型')
    assert.equal('contests' in first, false, '不再把累计比赛塞给模型')
    assert.ok(Array.isArray(first.summary), '要有比赛级摘要')
    assert.equal(first.summary.length, 1)
    assert.equal(first.summary[0].contestId, '7')
    assert.equal(first.summary[0].title, 'Mock VP')
    assert.equal(first.summary[0].solved, 1)
    assert.equal(first.summary[0].submissions, 1)
    assert.deepEqual(first.totals, { contests: 1, submissions: 1, events: 0 })
    assert.equal(first.hasMore, true)

    const second = await f.call('coach_vp_sync')
    assert.equal(second.ok, true, second.reject)
    assert.equal(second.hasMore, false)
    assert.deepEqual(second.totals, { contests: 1, submissions: 2, events: 0 })
    assert.equal(second.summary[0].solved, 2)
    assert.equal(second.summary[0].problems, 2)
    assert.match(second.text, /按需/)
  } finally { f.cleanup() }
})

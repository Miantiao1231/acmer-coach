import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function shape(schema, value) {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(key in schema.properties, `unexpected field ${key}`)
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      if (field.required) assert.ok(key in value, `missing field ${key}`)
      if (key in value) shape(field, value[key])
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value))
    if (schema.items) value.forEach(item => shape(schema.items, item))
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value))
  else assert.equal(typeof value, schema.type)
}

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-vp-sync-'))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, fetch: globalThis.fetch }
  const account = { id: 1, handle: 'mock-account', display_name: 'Mock account' }
  let page = 0
  let mode = 'normal'
  const calls = []
  try {
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = join(dir, 'unused.db')
    globalThis.fetch = async url => {
      const parsed = new URL(url)
      if (parsed.pathname === '/api/coach/auth/exchange') return json({ access_token: 'test-token', user: account })
      if (parsed.pathname !== '/api/coach/sync') throw new Error(`unexpected mock route ${parsed.pathname}`)
      if (mode === 'error') return { ok: false, status: 503, json: async () => ({ detail: 'temporary mock failure' }) }
      calls.push(Number(parsed.searchParams.get('submission_cursor')))
      const submissionId = mode === 'duplicate' ? page : ++page
      const contest = { id: mode === 'invalid' ? 8 : 7, title: 'Mock VP', start_time: mode === 'invalid' ? '2026-02-30T00:00:00Z' : mode === 'naive-utc' ? '2026-10-10 00:00:00' : '2026-10-10T00:00:00Z', duration_min: 300 }
      return json({ account, contests: [contest], events: [],
        submissions: [{ id: submissionId, contest_id: contest.id, problem_id: 'A', verdict: 'AC', submitted_at: mode === 'naive-utc' ? '2026-10-10 00:10:00' : '2026-10-10T00:10:00Z' }],
        next_cursor: { submission_id: submissionId, event_id: 0 }, has_more: page === 1 })
    }
    const { apply } = await import(`../index.js?vp-sync-${dir.replace(/\\/g, '/')}`)
    const registered = new Map()
    apply({ tools: { register: tool => registered.set(tool.name, tool) }, inject() {}, on() {} })
    const call = async (name, args = {}) => {
      const tool = registered.get(name)
      const result = await tool.execute(args)
      shape(tool.output.schema, result)
      return result
    }
    assert.equal((await call('coach_vp_connect', { action: 'finish', code: 'test-code' })).ok, true)
    await run({ call, calls, mode: value => { mode = value } })
  } finally {
    globalThis.fetch = previous.fetch
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function json(value) { return { ok: true, json: async () => value } }

test('public VP sync exposes two-page continuation and distinguishes page rows from cumulative cache', async () => {
  await fixture(async ({ call, calls, mode }) => {
    const first = await call('coach_vp_sync')
    assert.equal(first.ok, true, first.reject)
    assert.equal(first.hasMore, true)
    assert.deepEqual(first.pageCounts, { submissions: 1, events: 0, contests: 1 })
    const second = await call('coach_vp_sync')
    assert.equal(second.ok, true, second.reject)
    assert.equal(second.hasMore, false)
    assert.deepEqual(second.pageCounts, { submissions: 1, events: 0, contests: 1 })
    assert.equal(second.submissions.length, 2)
    assert.deepEqual(calls, [0, 1])
    assert.equal(second.nextCursor.submission_id, 2)
    assert.match(second.text, /缓存累计/)
    assert.doesNotMatch(second.text, /新增训练证据/)
    mode('duplicate')
    const repeated = await call('coach_vp_sync')
    assert.equal(repeated.ok, true, repeated.reject)
    assert.equal(repeated.submissions.length, 2)
    assert.deepEqual(repeated.pageCounts, { submissions: 1, events: 0, contests: 1 })
    assert.match(repeated.text, /缓存累计/)
    assert.doesNotMatch(repeated.text, /新增训练证据/)
  })
})

test('public VP sync propagates training import refusal and network failure with complete output shapes', async () => {
  await fixture(async ({ call, mode }) => {
    mode('invalid')
    const rejected = await call('coach_vp_sync')
    assert.equal(rejected.ok, false, 'invalid imported date must not be reported as successful sync')
    assert.match(rejected.reject, /VP 导入被拒绝/)
    assert.equal(rejected.imported, 0)
    mode('error')
    const failed = await call('coach_vp_sync')
    assert.equal(failed.ok, false)
    assert.match(failed.reject, /503/)
    assert.equal(failed.hasMore, false)
    assert.deepEqual(failed.pageCounts, { submissions: 0, events: 0, contests: 0 })
    assert.deepEqual(failed.nextCursor, { submission_id: 0, event_id: 0 })
  })
})

test('platform UTC timestamps without a timezone become valid ISO evidence', async () => {
  await fixture(async ({ call, mode }) => {
    mode('naive-utc')
    const synced = await call('coach_vp_sync')
    assert.equal(synced.ok, true, synced.reject)
    const facts = await call('coach_curriculum', { action: 'assess', evidenceEventIds: ['vp:1:7'] })
    assert.equal(facts.evidence[0].occurredAt, '2026-10-10T00:10:00.000Z')
    assert.equal(facts.evidence[0].minutes, 10)
    const platformStart = new Date('2026-10-10T00:00:00Z')
    const localDate = `${platformStart.getFullYear()}-${String(platformStart.getMonth() + 1).padStart(2, '0')}-${String(platformStart.getDate()).padStart(2, '0')}`
    assert.equal(facts.evidence[0].date, localDate)
  })
})

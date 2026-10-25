import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { createVpClient } from '../lib/vp-client.js'

const account = id => ({ id, handle: `account-${id}`, display_name: `Account ${id}` })
const json = value => ({ ok: true, json: async () => value })

function heldServer() {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname
    if (path.endsWith('/auth/exchange')) {
      const id = Number(JSON.parse(options.body).code)
      return json({ user: account(id), access_token: `fixture-${id}` })
    }
    if (path.endsWith('/sync')) {
      await pending
      return json({ account: account(1), submissions: [{ id: 1, contest_id: 7, problem_id: 'A', verdict: 'AC', submitted_at: '2026-10-10T00:10:00Z' }],
        contests: [{ id: 7, title: 'VP A', start_time: '2026-10-10T00:00:00Z', duration_min: 300 }], events: [],
        next_cursor: { submission_id: 1, event_id: 0 }, has_more: false })
    }
    throw new Error(`unexpected fixture route: ${path}`)
  }
  return { fetchImpl, release: () => release() }
}

test('a late sync cannot switch the active VP account back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acmer-vp-race-'))
  const server = heldServer()
  try {
    const client = createVpClient({ dataDir: dir, fetchImpl: server.fetchImpl })
    await client.finish({ code: '1' })
    const oldSync = client.sync()
    await client.finish({ code: '2' })
    assert.equal(client.localStatus().activeAccountId, 2)
    server.release()
    await oldSync
    assert.equal(client.localStatus().activeAccountId, 2)
    assert.equal(JSON.parse(readFileSync(join(dir, 'vp-accounts', '1', 'SYNC.json'))).account.id, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a late coach sync imports into its own account without changing the current workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acmer-vp-tool-race-'))
  const server = heldServer()
  const old = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, memory: process.env.COACH_HINDSIGHT, fetch: globalThis.fetch }
  try {
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = join(dir, 'unused.db')
    process.env.COACH_HINDSIGHT = '0'
    globalThis.fetch = server.fetchImpl
    const { apply } = await import(`../index.js?race=${Date.now()}`)
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {} })
    const connect = tools.get('coach_vp_connect')
    assert.equal((await connect.execute({ action: 'finish', code: '1' })).ok, true)
    const oldSync = tools.get('coach_vp_sync').execute({})
    assert.equal((await connect.execute({ action: 'finish', code: '2' })).ok, true)
    server.release()
    const synced = await oldSync
    assert.equal(synced.ok, true, synced.reject)
    assert.equal((await connect.execute({ action: 'status' })).activeAccountId, 2)
    const accountOne = join(dir, 'vp-accounts', '1', 'VP_EVENTS.yaml')
    assert.equal(parse(readFileSync(accountOne, 'utf8')).events[0].eventId, 'vp:1:7')
    assert.equal(existsSync(join(dir, 'vp-accounts', '2', 'VP_EVENTS.yaml')), false)
  } finally {
    globalThis.fetch = old.fetch
    for (const [key, value] of [['COACH_DATA_DIR', old.data], ['COACH_DB', old.db], ['COACH_HINDSIGHT', old.memory]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

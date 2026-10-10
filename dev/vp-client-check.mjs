import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVpClient } from '../lib/vp-client.js'

const root = mkdtempSync(join(tmpdir(), 'acmer-coach-vp-'))
let account = { id: 1, handle: 'A', display_name: 'Coach A' }
let mismatch = false
const fetchImpl = async (url, options = {}) => {
  const path = new URL(url).pathname
  const body = options.body ? JSON.parse(options.body) : {}
  if (path.endsWith('/api/coach/auth/start')) return json({ request_id: 'r1', authorize_url: 'https://vp/authorize/r1' })
  if (path.endsWith('/api/coach/auth/exchange')) {
    account = body.code === 'B' ? { id: 2, handle: 'B', display_name: 'Coach B' } : { id: 1, handle: 'A', display_name: 'Coach A' }
    return json({ access_token: `token-${account.id}`, user: account })
  }
  if (path.endsWith('/api/coach/me')) return json({ user: account, read_only: true })
  if (path.endsWith('/api/coach/contests')) return json({ account, contests: [{ id: 7, title: 'VP 7', status: 'ended' }] })
  if (path.endsWith('/api/coach/sync')) return json({
    account: mismatch ? { id: 1, handle: 'A' } : account,
    submissions: [{ id: 9, contest_id: 7, verdict: 'AC' }], events: [], contests: [],
    next_cursor: { submission_id: 9, event_id: 0 }, has_more: false,
  })
  if (path.endsWith('/api/coach/replay/7')) return json({ account, visualization: { team_events: [] } })
  throw new Error(`unexpected ${url}`)
}
function json(value) { return { ok: true, json: async () => value, text: async () => JSON.stringify(value) } }

try {
  const client = createVpClient({ dataDir: root, fetchImpl })
  const start = await client.start({ baseUrl: 'https://vp/' })
  assert.equal(start.requestId, 'r1')
  await client.finish({ code: 'A' })
  const synced = await client.sync()
  assert.equal(synced.account.id, 1)
  assert.equal(JSON.parse(readFileSync(join(root, 'vp-accounts', '1', 'SYNC.json'))).account.id, 1)
  await client.finish({ code: 'B' })
  assert.equal((await client.status()).account.id, 2)
  assert.equal((await client.contests()).contests[0].id, 7)
  assert.equal((await client.sync()).account.id, 2)
  mismatch = true
  await assert.rejects(() => client.sync(), /account mismatch/)
  assert.equal(JSON.parse(readFileSync(join(root, 'vp-accounts', '2', 'SYNC.json'))).account.id, 2)
  console.log('VP CLIENT ALL PASSED')
} finally {
  rmSync(root, { recursive: true, force: true })
}

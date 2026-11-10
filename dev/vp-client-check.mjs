import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVpClient, isVpAuthExpired, VP_AUTH_EXPIRED } from '../lib/vp-client.js'

const root = mkdtempSync(join(tmpdir(), 'acmer-coach-vp-'))
let account = { id: 1, handle: 'A', display_name: 'Coach A' }
let mismatch = false
let nextPage = false
let expired = false
const unauthorized = (detail = 'coach token 已失效') => ({ ok: false, status: 401, json: async () => ({ detail }) })
const fetchImpl = async (url, options = {}) => {
  const path = new URL(url).pathname
  const body = options.body ? JSON.parse(options.body) : {}
  if (path.endsWith('/api/coach/auth/start')) return json({ request_id: 'r1', authorize_url: 'https://vp/authorize/r1' })
  if (path.endsWith('/api/coach/auth/exchange')) {
    account = body.code === 'B' ? { id: 2, handle: 'B', display_name: 'Coach B' } : { id: 1, handle: 'A', display_name: 'Coach A' }
    return json({ access_token: `token-${account.id}`, user: account })
  }
  if (expired && /\/api\/coach\/(me|contests|sync|replay)/.test(path)) return unauthorized()
  if (path.endsWith('/api/coach/me')) return json({ user: account, read_only: true })
  if (path.endsWith('/api/coach/contests')) return json({ account, contests: [{ id: 7, title: 'VP 7', status: 'ended' }] })
  if (path.endsWith('/api/coach/sync')) return json({
    account: mismatch ? { id: 1, handle: 'A' } : account,
    submissions: [{ id: nextPage ? 10 : 9, contest_id: 7, verdict: nextPage ? 'WA' : 'AC' }], events: [], contests: [],
    next_cursor: { submission_id: nextPage ? 10 : 9, event_id: 0 }, has_more: !nextPage,
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
  assert.equal(synced.hasMore, true, 'first page must expose continuation')
  assert.deepEqual(synced.pageCounts, { submissions: 1, events: 0, contests: 0 })
  assert.equal(JSON.parse(readFileSync(join(root, 'vp-accounts', '1', 'SYNC.json'))).account.id, 1)
  nextPage = true
  const secondPage = await client.sync()
  assert.equal(secondPage.hasMore, false, 'last page must expose completion')
  assert.deepEqual(secondPage.pageCounts, { submissions: 1, events: 0, contests: 0 }, 'page counts must not include old cached rows')
  assert.deepEqual(secondPage.submissions.map(item => item.id), [9, 10], 'incremental pages must retain earlier accepted runs')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'vp-accounts', '1', 'SYNC.json'))).submissions.map(item => item.id), [9, 10])
  nextPage = false
  await client.finish({ code: 'B' })
  assert.equal((await client.status()).account.id, 2)
  assert.equal((await client.contests()).contests[0].id, 7)
  assert.equal((await client.sync()).account.id, 2)
  mismatch = true
  await assert.rejects(() => client.sync(), /account mismatch/)
  assert.equal(JSON.parse(readFileSync(join(root, 'vp-accounts', '2', 'SYNC.json'))).account.id, 2)

  // 401 是「授权失效」而不是普通失败：调用方要能稳定区分，页面才能切到重新授权。
  expired = true
  const state = await client.status()
  assert.equal(state.connected, false)
  assert.equal(state.expired, true, '401 must be reported as expired, not just disconnected')
  assert.match(state.error, /401/)
  for (const call of [() => client.contests(), () => client.sync(), () => client.replay({ contestId: 7 })]) {
    await assert.rejects(call, err => err.code === VP_AUTH_EXPIRED && err.status === 401 && isVpAuthExpired(err))
  }
  // 断网/5xx 不是授权失效，不能误导成「重新授权」。
  const unreachable = createVpClient({ dataDir: root, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ detail: 'temporary mock failure' }) }) })
  const down = await unreachable.status()
  assert.equal(down.connected, false)
  assert.equal(down.expired, false)
  expired = false
  assert.equal((await client.status()).connected, true, '重新授权后同一账号应恢复为已连接')
  console.log('VP CLIENT ALL PASSED')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// 注册表损坏/坏 baseUrl 不能让插件启动失败；按未连接处理。
{
  const dir = mkdtempSync(join(tmpdir(), 'acmer-coach-vp-corrupt-'))
  try {
    writeFileSync(join(dir, 'VP_ACCOUNTS.json'), '{"version":1,"activeAccountId":1,"accounts":{"1":{"account":{"id":1')
    const broken = createVpClient({ dataDir: dir, fetchImpl })
    assert.equal(broken.localStatus().connected, false, 'truncated registry is disconnected')
    writeFileSync(join(dir, 'VP_ACCOUNTS.json'), JSON.stringify({ version: 1, activeAccountId: 1,
      accounts: { 1: { account: { id: 1, handle: 'A' }, baseUrl: 'not a url' } } }))
    const badUrl = createVpClient({ dataDir: dir, fetchImpl })
    assert.equal(badUrl.localStatus().connected, false, 'invalid baseUrl is disconnected')
    writeFileSync(join(dir, 'VP_ACCOUNTS.json'), JSON.stringify({ version: 1, activeAccountId: 0,
      accounts: { 0: { account: { id: 0, handle: 'zero' }, baseUrl: 'https://vp/' } } }))
    const badId = createVpClient({ dataDir: dir, fetchImpl })
    assert.equal(badId.localStatus().connected, false, 'account id 0 is rejected')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

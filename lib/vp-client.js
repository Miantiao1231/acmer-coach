import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_BASE_URL = 'https://xiaojing.run'

const cleanBaseUrl = (value) => {
  const url = new URL(String(value || DEFAULT_BASE_URL))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('VP baseUrl 必须是干净的 http/https 地址')
  }
  return url.toString().replace(/\/$/, '')
}

function safeAccount(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(Number(value.id))) throw new Error('VP 返回了无效账号')
  return { id: Number(value.id), handle: String(value.handle || ''), display_name: String(value.display_name || value.handle || '') }
}

function atomicJson(path, value, mode = 0o600) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try { chmodSync(tmp, mode) } catch { /* Windows 没有 Unix mode，不影响原子写 */ }
  try { renameSync(tmp, path) } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EEXIST') throw err
    try { unlinkSync(path) } catch (removeErr) { if (removeErr.code !== 'ENOENT') throw err }
    copyFileSync(tmp, path)
    unlinkSync(tmp)
  }
}

export function createVpClient({ dataDir, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('VP 客户端需要 fetch')
  const root = join(dataDir, 'vp-accounts')
  const registryPath = join(dataDir, 'VP_ACCOUNTS.json')

  const loadRegistry = () => {
    try {
      const doc = JSON.parse(readFileSync(registryPath, 'utf8'))
      return doc && typeof doc === 'object' ? doc : { activeAccountId: '', accounts: {} }
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, activeAccountId: '', accounts: {} }
      throw err
    }
  }
  const saveRegistry = (value) => atomicJson(registryPath, { version: 1, ...value })
  const accountDir = (id) => join(root, String(id))
  const tokenPath = (id) => join(accountDir(id), 'TOKEN.json')
  const loadToken = (id) => JSON.parse(readFileSync(tokenPath(id), 'utf8')).access_token
  const active = () => {
    const registry = loadRegistry()
    const id = Number(registry.activeAccountId || 0)
    if (!id) return null
    const meta = registry.accounts?.[String(id)]
    if (!meta) return null
    return { id, account: safeAccount(meta.account), baseUrl: cleanBaseUrl(meta.baseUrl || DEFAULT_BASE_URL) }
  }
  const request = async (baseUrl, path, { token, method = 'GET', body } = {}) => {
    const response = await fetchImpl(`${cleanBaseUrl(baseUrl)}${path}`, {
      method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    let payload
    try { payload = await response.json() } catch { payload = { detail: await response.text() } }
    if (!response.ok) throw new Error(`VP ${response.status}: ${payload?.detail || payload?.message || '请求失败'}`)
    return payload
  }
  const requireActive = () => {
    const current = active()
    if (!current) throw new Error('还没有连接 VP；先调用 coach_vp_connect start/finish')
    return { ...current, token: loadToken(current.id) }
  }
  const verifyAccount = (current, value) => {
    const returned = safeAccount(value)
    if (returned.id !== current.id) throw new Error(`VP account mismatch: 当前是 ${current.id}，接口返回 ${returned.id}`)
    return returned
  }

  return {
    async start({ baseUrl = DEFAULT_BASE_URL } = {}) {
      const clean = cleanBaseUrl(baseUrl)
      const result = await request(clean, '/api/coach/auth/start', { method: 'POST', body: {
        redirect_uri: 'http://127.0.0.1:8765/coach/callback',
        scopes: ['profile', 'contests', 'submissions', 'replay'],
      } })
      return { ok: true, requestId: result.request_id, authorizeUrl: result.authorize_url, expiresAt: result.expires_at, baseUrl: clean }
    },
    async finish({ code, baseUrl = DEFAULT_BASE_URL } = {}) {
      const clean = cleanBaseUrl(baseUrl)
      const result = await request(clean, '/api/coach/auth/exchange', { method: 'POST', body: { code: String(code || '') } })
      const account = safeAccount(result.user)
      const dir = accountDir(account.id)
      mkdirSync(dir, { recursive: true })
      atomicJson(tokenPath(account.id), { access_token: String(result.access_token), saved_at: now().toISOString() })
      const registry = loadRegistry()
      registry.accounts = registry.accounts || {}
      registry.accounts[String(account.id)] = { account, baseUrl: clean, lastSyncAt: registry.accounts[String(account.id)]?.lastSyncAt || '' }
      registry.activeAccountId = account.id
      saveRegistry(registry)
      return { ok: true, account, activeAccountId: account.id }
    },
    async status() {
      const current = active()
      if (!current) return { connected: false, account: null, activeAccountId: null }
      try {
        const remote = await request(current.baseUrl, '/api/coach/me', { token: loadToken(current.id) })
        const account = verifyAccount(current, remote.user)
        return { connected: true, account, activeAccountId: current.id, baseUrl: current.baseUrl, readOnly: remote.read_only !== false }
      } catch (err) {
        return { connected: false, account: current.account, activeAccountId: current.id, error: err.message }
      }
    },
    async sync({ limit = 200, includeProfile = true } = {}) {
      const current = requireActive()
      const registry = loadRegistry()
      const accountMeta = registry.accounts[String(current.id)] || {}
      const cursor = accountMeta.cursor || { submission_id: 0, event_id: 0 }
      const query = new URLSearchParams({ submission_cursor: String(cursor.submission_id || 0), event_cursor: String(cursor.event_id || 0), limit: String(Math.max(1, Math.min(500, Number(limit) || 200))), include_profile: includeProfile ? '1' : '0' })
      const payload = await request(current.baseUrl, `/api/coach/sync?${query}`, { token: current.token })
      const account = verifyAccount(current, payload.account)
      const next = payload.next_cursor || cursor
      atomicJson(join(accountDir(current.id), 'SYNC.json'), { ...payload, account, synced_at: now().toISOString() })
      registry.accounts[String(current.id)] = { ...accountMeta, account, baseUrl: current.baseUrl, cursor: next, lastSyncAt: now().toISOString() }
      saveRegistry(registry)
      return { ...payload, account, cursor: next, cachedPath: join(accountDir(current.id), 'SYNC.json') }
    },
    async replay({ contestId, limit = 50000 } = {}) {
      const current = requireActive()
      const payload = await request(current.baseUrl, `/api/coach/replay/${encodeURIComponent(String(contestId))}?limit=${Math.max(1, Math.min(50000, Number(limit) || 50000))}`, { token: current.token })
      const account = verifyAccount(current, payload.account)
      const result = { ...payload, account, cachedPath: join(accountDir(current.id), `REPLAY-${String(contestId)}.json`) }
      atomicJson(result.cachedPath, { ...payload, account, cached_at: now().toISOString() })
      return result
    },
    disconnect() {
      const current = active()
      if (!current) return { ok: true, disconnected: false }
      try { rmSync(tokenPath(current.id), { force: true }) } catch { /* best effort */ }
      const registry = loadRegistry()
      registry.activeAccountId = ''
      saveRegistry(registry)
      return { ok: true, disconnected: true, account: current.account, cached: true }
    },
    localStatus() {
      const current = active()
      return current ? { connected: true, account: current.account, activeAccountId: current.id, baseUrl: current.baseUrl } : { connected: false, account: null, activeAccountId: null }
    },
  }
}

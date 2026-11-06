// Screen consent.
//
// Port of companion_v2's screen/configuration.py + capabilities/screen_access.py:
// a capture is only allowed while an explicit, time-boxed grant from him is
// active. The settings switch says she *may* peek; this says she *may peek now*.
import { readJsonFile, updateJsonFile } from './json-store.js'

const FILE = 'screen-consent.json'
const VERSION = 1
const MAX_GRANTS = 24
export const DEFAULT_CONSENT_MINUTES = 120
export const MAX_CONSENT_MINUTES = 24 * 60

const clean = (value) => String(value ?? '').trim().slice(0, 120)
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

export function emptyScreenConsent() {
  return { version: VERSION, grants: [] }
}

export function normalizeScreenConsent(raw) {
  const base = emptyScreenConsent()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const grants = (Array.isArray(raw.grants) ? raw.grants : [])
    .map((grant) => {
      const grantedAt = stamp(grant?.grantedAt)
      const expiresAt = stamp(grant?.expiresAt)
      if (grantedAt === null || expiresAt === null || expiresAt <= grantedAt) return null
      return {
        id: clean(grant.id) || `sc-${grantedAt}`,
        scope: grant.scope === 'proactive' ? 'proactive' : 'peek',
        by: grant.by === 'model' ? 'model' : 'human',
        grantedAt: new Date(grantedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        revokedAt: stamp(grant.revokedAt) === null ? '' : new Date(stamp(grant.revokedAt)).toISOString(),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt))
  return { version: VERSION, grants: grants.slice(-MAX_GRANTS) }
}

export function loadScreenConsent(dataDir) {
  return normalizeScreenConsent(readJsonFile(dataDir, FILE))
}

export function activeScreenConsent(store, now = new Date()) {
  return (store?.grants ?? [])
    .filter((grant) => !grant.revokedAt && stamp(grant.expiresAt) > now.getTime())
    .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))
    .at(0) ?? null
}

// Only a human grants. The model can ask, but the grant button is the page.
export function grantScreenConsent(dataDir, { minutes = DEFAULT_CONSENT_MINUTES, scope = 'peek', by = 'human', now = new Date() } = {}) {
  if (by !== 'human') return { ok: false, reject: '屏幕授权只能由他本人在页面上给。' }
  const span = Math.round(Number(minutes))
  if (!Number.isFinite(span) || span < 1) return { ok: false, reject: '授权时长要在 1 分钟以上。' }
  const capped = Math.min(MAX_CONSENT_MINUTES, span)
  const id = `sc-${now.getTime().toString(36)}`
  let saved = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeScreenConsent(current)
    store.grants.push({
      id,
      scope: scope === 'proactive' ? 'proactive' : 'peek',
      by: 'human',
      grantedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + capped * 60000).toISOString(),
      revokedAt: '',
    })
    saved = store.grants.at(-1)
    return { version: VERSION, grants: store.grants.slice(-MAX_GRANTS) }
  }, normalizeScreenConsent)
  return result.ok && saved ? { ok: true, grant: saved } : { ok: false, reject: '授权写入失败。' }
}

export function revokeScreenConsent(dataDir, { now = new Date() } = {}) {
  let changed = null
  const result = updateJsonFile(dataDir, FILE, (current) => {
    const store = normalizeScreenConsent(current)
    const live = state_grants(store, now)
    if (!live.length) return null
    for (const grant of live) grant.revokedAt = now.toISOString()
    changed = live.at(-1)
    return store
  }, normalizeScreenConsent)
  return result.ok && changed ? { ok: true, grant: changed } : { ok: false, reject: '没有生效中的授权。' }
}

function state_grants(store, now) {
  return store.grants.filter((grant) => !grant.revokedAt && stamp(grant.expiresAt) > now.getTime())
}

export function screenConsentLine(store, now = new Date()) {
  const grant = activeScreenConsent(store, now)
  if (!grant) return ''
  const minutes = Math.max(1, Math.round((stamp(grant.expiresAt) - now.getTime()) / 60000))
  return `- 他授权你可以看屏幕，还剩 ${minutes} 分钟。只概括他在做什么，不复述画面里的账号、聊天或文件名。`
}

export { MAX_GRANTS }

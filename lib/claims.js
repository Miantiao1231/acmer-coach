// 事实账本：只追加的 person-events.jsonl。
//
// 事实（档案/纪念日/习惯/书架/上下文）写成 claim；纠正是新 claim 关掉旧 claim，
// 不覆盖。person.json 只是投影 + 工作流状态（待审/说法/presence）缓存。
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync,
  openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const EVENTS = 'person-events.jsonl'
const LOCK = 'person-events.lock'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 1
const KINDS = ['profile', 'milestone', 'habit', 'library', 'context', 'episode', 'promise', 'boundary']
const PROFILE_FIELDS = ['likes', 'dislikes', 'quirks', 'background']

const clean = (value) => String(value ?? '').trim()
const libraryReadingFields = (item = {}) => {
  const excerpt = typeof item.excerpt === 'string' ? item.excerpt.slice(0, 60000) : ''
  const fetchedAt = Date.parse(item.fetchedAt || '')
  return { excerpt,
    readingOffset: Number.isInteger(item.readingOffset) && item.readingOffset >= 0 ? Math.min(item.readingOffset, excerpt.length) : 0,
    readingHash: clean(item.readingHash),
    fetchedAt: Number.isFinite(fetchedAt) ? new Date(fetchedAt).toISOString() : '',
    doneAt: Number.isFinite(Date.parse(item.doneAt || '')) ? new Date(item.doneAt).toISOString() : '',
    scope: ['article', 'chapter', 'excerpt'].includes(item.scope) ? item.scope : 'excerpt' }
}
const contextValue = context => context?.quote ? {
  quote: clean(context.quote), at: clean(context.at), messageId: clean(context.messageId), expiresAt: clean(context.expiresAt),
  ...(clean(context.expiryMode) ? { expiryMode: clean(context.expiryMode) } : {}),
} : null
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const nowIso = () => new Date().toISOString()

export function claimKey(kind, value = {}) {
  if (kind === 'profile') {
    return value.field === 'identity' ? 'profile:identity' : `profile:${value.field}:${clean(value.text)}`
  }
  if (kind === 'milestone') return `milestone:${clean(value.label)}\u0000${clean(value.date)}`
  if (kind === 'habit') return `habit:${value.subject === 'role' ? 'role:' : ''}${clean(value.situation)}\u0000${clean(value.action)}`
  if (kind === 'library') return `library:${clean(value.title).toLowerCase()}`
  if (kind === 'context') return 'context'
  // 共同经历按「发生日 + 摘要前缀」去重；同一天的两件事不会被同一条吞掉。
  if (kind === 'episode') return `episode:${clean(value.at)}\u0000${clean(value.summary).slice(0, 40)}`
  // 承诺按文本去重；改日期/状态是纠正，不是另一条承诺。
  if (kind === 'promise') return `promise:${clean(value.text)}`
  if (kind === 'boundary') return `boundary:${clean(value.text)}`
  return `${kind}:${JSON.stringify(value)}`
}

function makeClaim(kind, value, { evidence = [], confidence = 0.7, source = 'user', status = 'active', id, at } = {}) {
  return {
    id: id || makeId('c'),
    kind,
    key: claimKey(kind, value),
    value,
    evidence: Array.isArray(evidence) ? evidence.filter(item => item && clean(item.quote)) : [],
    confidence: Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0.7,
    source,
    status,
    createdAt: at || nowIso(),
  }
}

export function eventForClaim(kind, value, options = {}) {
  return { type: 'claim', claim: makeClaim(kind, value, options) }
}

export function loadEvents(dataDir) {
  try {
    return readFileSync(join(dataDir, EVENTS), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(event => event && typeof event.type === 'string')
  } catch { return [] }
}

function acquireLock(dataDir) {
  const path = join(dataDir, LOCK)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, JSON.stringify({ owner: LOCK_OWNER, at: Date.now() })) }
      catch (error) { try { closeSync(fd) } catch { /* ignore */ } try { unlinkSync(path) } catch { /* ignore */ } throw error }
      return { fd, path, ino: statSync(path).ino }
    } catch (error) {
      if (error.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > 10000) unlinkSync(path)
      } catch { /* 另一个进程刚删掉 */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch { /* ignore */ }
    }
  }
  return null
}

function releaseLock(lock, dataDir) {
  try { closeSync(lock.fd) } catch { /* ignore */ }
  // 只删自己建的那一个 inode：被 stale 接管后，路径已经属于别的进程了。
  try {
    if (statSync(lock.path).ino !== lock.ino) return
    const raw = JSON.parse(readFileSync(join(dataDir, LOCK), 'utf8'))
    if (raw?.owner === LOCK_OWNER) unlinkSync(join(dataDir, LOCK))
  } catch { /* 不是自己的锁或已经被删 */ }
}

const COMPACT_BYTES = 2 * 1024 * 1024

function appendLocked(dataDir, events) {
  appendFileSync(join(dataDir, EVENTS), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
}

export function appendEvents(dataDir, events) {
  if (!Array.isArray(events) || !events.length) return true
  let written = false
  const lock = acquireLock(dataDir)
  if (lock === null) return false
  try {
    appendLocked(dataDir, events)
    written = true
    return true
  } catch {
    return false
  } finally {
    releaseLock(lock, dataDir)
    if (written) {
      try {
        if (statSync(join(dataDir, EVENTS)).size > COMPACT_BYTES) compactEvents(dataDir)
      } catch { /* compaction is best effort */ }
    }
  }
}

// 首次迁移必须和 append 在同一把锁里：两个进程同时读到空账本时，
// 只有一个能拿到锁并写入，另一个会看到已经迁好的事件，不会再迁第二套。
export function migrateIfEmpty(dataDir, source) {
  const current = loadEvents(dataDir)
  if (current.length || !source) return { events: current, migrated: false }
  const lock = acquireLock(dataDir)
  if (lock === null) return { events: current, migrated: false }
  try {
    const events = loadEvents(dataDir)
    if (events.length) return { events, migrated: false }
    const migrated = migrateFacts(source)
    if (!migrated.length) return { events, migrated: false }
    backupPersonFile(dataDir)
    appendLocked(dataDir, migrated)
    return { events: loadEvents(dataDir), migrated: true }
  } catch {
    return { events: loadEvents(dataDir), migrated: false }
  } finally {
    releaseLock(lock, dataDir)
  }
}

// 超过阈值时把 active claims 写成一个 snapshot，旧文件复制到 archive。
// 主文件从此只保留“当前真相 + 后续纠正”，完整历史仍在 archive 里。
export function compactEvents(dataDir, { thresholdBytes = COMPACT_BYTES, keepArchives = 3 } = {}) {
  const path = join(dataDir, EVENTS)
  let before = 0
  try { before = statSync(path).size } catch { return { ok: true, compacted: false, reason: 'missing' } }
  if (before < thresholdBytes) return { ok: true, compacted: false, reason: 'below-threshold', before }
  const lock = acquireLock(dataDir)
  if (lock === null) return { ok: false, compacted: false, reason: 'locked' }
  let tmp = null
  try {
    before = statSync(path).size
    if (before < thresholdBytes) return { ok: true, compacted: false, reason: 'below-threshold', before }
    const events = loadEvents(dataDir)
    const active = [...reduceEvents(events).values()].filter(claim => claim.status === 'active')
    const archive = join(dataDir, `person-events.archive-${Date.now()}-${process.pid}.jsonl`)
    copyFileSync(path, archive)
    const snapshot = {
      type: 'snapshot', version: VERSION, at: nowIso(),
      claims: active.map(claim => ({ ...claim, status: 'active' })),
    }
    tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    writeFileSync(tmp, JSON.stringify(snapshot) + '\n', 'utf8')
    renameSync(tmp, path)
    tmp = null
    const after = statSync(path).size
    try {
      const archives = readdirSync(dataDir)
        .filter(name => /^person-events\.archive-.*\.jsonl$/.test(name))
        .sort()
      for (const name of archives.slice(0, Math.max(0, archives.length - keepArchives))) {
        unlinkSync(join(dataDir, name))
      }
    } catch { /* archive pruning is best effort */ }
    return { ok: true, compacted: true, before, after, claims: active.length, archive }
  } catch {
    if (tmp) { try { unlinkSync(tmp) } catch { /* ignore */ } }
    return { ok: false, compacted: false, reason: 'write-failed' }
  } finally {
    releaseLock(lock, dataDir)
  }
}

const ARCHIVE_RE = /^person-events\.archive-[0-9]+-[0-9]+\.jsonl$/

export function listEventArchives(dataDir) {
  try {
    return readdirSync(dataDir)
      .filter(name => ARCHIVE_RE.test(name))
      .sort()
      .reverse()
      .map(name => {
        try {
          const info = statSync(join(dataDir, name))
          return { name, size: info.size, at: info.mtime.toISOString() }
        } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function readEventArchive(dataDir, name) {
  if (!ARCHIVE_RE.test(String(name ?? ''))) return null
  try { return readFileSync(join(dataDir, name), 'utf8') } catch { return null }
}

export function reduceEvents(events) {
  const claims = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'snapshot' && Array.isArray(event.claims)) {
      claims.clear()
      for (const claim of event.claims) {
        if (claim?.id && KINDS.includes(claim.kind)) {
          claims.set(claim.id, { ...claim, status: claim.status || 'active' })
        }
      }
    } else if (event.type === 'claim' && event.claim?.id && KINDS.includes(event.claim.kind)) {
      claims.set(event.claim.id, { ...event.claim, status: event.claim.status || 'active' })
    } else if (['accept', 'reject', 'retract'].includes(event.type) && claims.has(event.id)) {
      const claim = claims.get(event.id)
      claim.status = event.type === 'accept' ? 'active' : event.type === 'reject' ? 'rejected' : 'retracted'
      claim.statusAt = event.at || nowIso()
    } else if (event.type === 'correct' && event.id && event.claim?.id && KINDS.includes(event.claim.kind)) {
      const old = claims.get(event.id)
      if (old) {
        old.status = 'superseded'
        old.supersededAt = event.at || nowIso()
      }
      // rootId 跟着纠正链一路抄下来：压缩只保留 active claim，祖先会被丢掉，
      // 靠 supersedes 走不到最初那条，对外 id 就会变、书架条目「找不到」。
      const rootId = old?.rootId || event.id
      claims.set(event.claim.id, { ...event.claim, status: event.claim.status || 'active', supersedes: event.id, rootId })
    }
  }
  return claims
}

function valueOf(item, kind) {
  if (kind === 'milestone') return { label: clean(item.label), date: clean(item.date), reason: clean(item.reason) }
  if (kind === 'habit') return {
    situation: clean(item.situation), action: clean(item.action),
    boundary: clean(item.boundary), feedback: clean(item.feedback),
    ...(item.subject === 'role' ? { subject: 'role' } : {}),
  }
  if (kind === 'library') return {
    title: clean(item.title), source: clean(item.source), kind: ['book', 'article', 'other'].includes(item.kind) ? item.kind : 'book',
    state: ['reading', 'done', 'paused'].includes(item.state) ? item.state : 'reading',
    progress: Number.isFinite(Number(item.progress)) ? Math.max(0, Math.min(1, Number(item.progress))) : 0,
    note: clean(item.note),
    ...libraryReadingFields(item),
  }
  if (kind === 'episode') return {
    summary: clean(item.summary), at: clean(item.at),
    tags: Array.isArray(item.tags) ? item.tags.map(clean).filter(Boolean).slice(0, 5) : [],
  }
  if (kind === 'promise') return {
    text: clean(item.text), dueAt: clean(item.dueAt),
    status: ['open', 'done', 'dropped'].includes(item.status) ? item.status : 'open',
  }
  if (kind === 'boundary') return { text: clean(item.text) }
  return item
}

// A source message can be revoked (deleted, edited, or corrected by the user).
// Every active claim that cites it is retracted as a whole: keeping a fact whose
// only evidence no longer exists is exactly the failure the original guards
// against with evidence spans.
export function retractBySource(dataDir, { messageId = '', digest = '', now = new Date() } = {}) {
  if (!messageId && !digest) return { ok: false, retracted: 0 }
  const claims = reduceEvents(loadEvents(dataDir))
  const events = []
  for (const claim of claims.values()) {
    if (claim.status !== 'active') continue
    const hit = (claim.evidence ?? []).some((item) =>
      (messageId && item.messageId === messageId) || (digest && item.sourceDigest === digest))
    if (hit) events.push({ type: 'retract', id: claim.id, at: now.toISOString() })
  }
  if (!events.length) return { ok: true, retracted: 0 }
  return { ok: appendEvents(dataDir, events), retracted: events.length }
}

export function claimSourceIntact(claim, { messageId = '', digest = '' } = {}) {
  if (!messageId && !digest) return true
  return (claim?.evidence ?? []).some((item) =>
    (messageId && item.messageId === messageId) || (digest && item.sourceDigest === digest))
}

export function projectFacts(claims, defaults = {}) {
  const all = [...claims.values()]
  // 纠正只改字段时，对外仍用**最初那条 claim 的 id**：页面/工具拿到的条目 id
  // 不会因为改了一次备注就换一个新身份。真正换 key 的编辑（改标题/改日期）
  // 仍是 retract + 新 claim，id 跟着换。
  const idOf = (claim) => {
    // 新数据直接带 rootId（压缩后仍然在）；老账本才沿 supersedes 链回溯。
    if (claim?.rootId) return claim.rootId
    let id = claim.id
    let current = claim
    const seen = new Set([id])
    while (current?.supersedes && !seen.has(current.supersedes)) {
      id = current.supersedes
      seen.add(id)
      current = claims.get(current.supersedes)
    }
    return id
  }
  const active = all.filter(claim => claim.status === 'active')
  const hasProfile = all.some(claim => claim.kind === 'profile')
  const profile = hasProfile
    ? { identity: defaults.profile?.identity || '', likes: [], dislikes: [], quirks: [], background: [] }
    : {
        identity: defaults.profile?.identity || '',
        likes: [...(defaults.profile?.likes || [])],
        dislikes: [...(defaults.profile?.dislikes || [])],
        quirks: [...(defaults.profile?.quirks || [])],
        background: [...(defaults.profile?.background || [])],
      }
  const identityClaims = []
  for (const claim of active.filter(item => item.kind === 'profile')) {
    const value = claim.value || {}
    if (value.field === 'identity') {
      identityClaims.push(claim)
      if (clean(value.text)) profile.identity = clean(value.text)
      continue
    }
    if (PROFILE_FIELDS.includes(value.field) && clean(value.text)
        && profile[value.field].length < 12 && !profile[value.field].includes(clean(value.text))) {
      profile[value.field].push(clean(value.text))
    }
  }

  const milestones = active.filter(item => item.kind === 'milestone').map(claim => ({
    id: idOf(claim),
    label: clean(claim.value?.label),
    date: clean(claim.value?.date),
    evidence: clean(claim.value?.reason) || clean(claim.evidence?.[0]?.quote),
    createdAt: claim.createdAt,
  })).filter(item => item.label && item.date)

  const habits = active.filter(item => item.kind === 'habit').map(claim => ({
    id: idOf(claim),
    situation: clean(claim.value?.situation),
    action: clean(claim.value?.action),
    boundary: clean(claim.value?.boundary),
    evidence: clean(claim.evidence?.[0]?.quote),
    feedback: clean(claim.value?.feedback),
    ...(claim.value?.subject === 'role' ? { subject: 'role' } : {}),
    createdAt: claim.createdAt,
  })).filter(item => item.situation && item.action)

  const libraryByKey = new Map()
  for (const claim of active.filter(item => item.kind === 'library')) {
    const previous = libraryByKey.get(claim.key)
    if (!previous || String(claim.createdAt) >= String(previous.createdAt)) libraryByKey.set(claim.key, claim)
  }
  const library = [...libraryByKey.values()].map(claim => ({
    id: idOf(claim),
    title: clean(claim.value?.title),
    source: clean(claim.value?.source),
    kind: claim.value?.kind || 'book',
    state: claim.value?.state || 'reading',
    progress: Number(claim.value?.progress) || 0,
    note: clean(claim.value?.note),
    ...libraryReadingFields(claim.value),
    addedAt: claim.createdAt,
    updatedAt: claim.statusAt || claim.createdAt,
  }))

  // 共同经历是「她记得发生过什么」，不是用户档案；只保留有摘要、有日期的条目，
  // 按发生日倒序。上限和习惯/书架一样在投影层兜底，账本本身仍可回溯。
  const episodes = active.filter(item => item.kind === 'episode').map(claim => ({
    id: idOf(claim),
    summary: clean(claim.value?.summary),
    at: clean(claim.value?.at),
    tags: Array.isArray(claim.value?.tags) ? claim.value.tags.map(clean).filter(Boolean) : [],
    evidence: clean(claim.evidence?.[0]?.quote),
    createdAt: claim.createdAt,
  })).filter(item => item.summary).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30)

  // 承诺是「她答应过的事」；open 排前面，到期日近的排前面。
  const promises = active.filter(item => item.kind === 'promise').map(claim => ({
    id: idOf(claim),
    text: clean(claim.value?.text),
    dueAt: clean(claim.value?.dueAt),
    status: ['open', 'done', 'dropped'].includes(claim.value?.status) ? claim.value.status : 'open',
    evidence: clean(claim.evidence?.[0]?.quote),
    createdAt: claim.createdAt,
  })).filter(item => item.text).sort((a, b) => {
    const rank = { open: 0, done: 1, dropped: 2 }
    return (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || String(a.dueAt || '9999-12-31').localeCompare(String(b.dueAt || '9999-12-31'))
  }).slice(0, 20)

  const boundaries = active.filter(item => item.kind === 'boundary').map(claim => ({
    id: idOf(claim),
    text: clean(claim.value?.text),
    evidence: clean(claim.evidence?.[0]?.quote),
    createdAt: claim.createdAt,
  })).filter(item => item.text).slice(0, 12)

  const contextClaims = active.filter(item => item.kind === 'context')
  const context = contextValue(contextClaims.at(-1)?.value)

  const conflicts = []
  const identityTexts = [...new Set(identityClaims.map(claim => clean(claim.value?.text)).filter(Boolean))]
  if (identityTexts.length > 1) conflicts.push({ kind: 'profile', key: 'profile:identity', values: identityTexts })
  const contexts = [...new Set(contextClaims.map(claim => clean(claim.value?.quote)).filter(Boolean))]
  if (contexts.length > 1) conflicts.push({ kind: 'context', key: 'context', values: contexts })

  return { profile, relation: { milestones }, habits, library, episodes, promises, boundaries, context, conflicts }
}

export function migrateFacts(raw) {
  if (!raw || typeof raw !== 'object') return []
  const events = []
  const add = (kind, value, evidence = [], status = 'active') =>
    events.push(eventForClaim(kind, value, { evidence, source: 'migration', status }))
  const profile = raw.profile || {}
  if (clean(profile.identity)) add('profile', { field: 'identity', text: clean(profile.identity) })
  for (const field of PROFILE_FIELDS) {
    for (const text of Array.isArray(profile[field]) ? profile[field] : []) {
      if (clean(text)) add('profile', { field, text: clean(text) })
    }
  }
  for (const item of raw.relation?.milestones ?? []) {
    add('milestone', valueOf(item, 'milestone'), item.evidence ? [{ handle: 'migration', quote: item.evidence, time: item.createdAt || '' }] : [])
  }
  for (const item of raw.habits ?? []) {
    add('habit', valueOf(item, 'habit'), item.evidence ? [{ handle: 'migration', quote: item.evidence, time: item.createdAt || '' }] : [])
  }
  for (const item of raw.library ?? []) add('library', valueOf(item, 'library'))
  for (const item of raw.episodes ?? []) {
    add('episode', valueOf(item, 'episode'), item.evidence ? [{ handle: 'migration', quote: item.evidence, time: item.createdAt || '' }] : [])
  }
  for (const item of raw.promises ?? []) {
    add('promise', valueOf(item, 'promise'), item.evidence ? [{ handle: 'migration', quote: item.evidence, time: item.createdAt || '' }] : [])
  }
  for (const item of raw.boundaries ?? []) {
    add('boundary', valueOf(item, 'boundary'), item.evidence ? [{ handle: 'migration', quote: item.evidence, time: item.createdAt || '' }] : [])
  }
  if (raw.context?.quote) add('context', contextValue(raw.context))
  return events
}

function findActive(claims, kind, key) {
  for (const claim of claims.values()) {
    if (claim.kind === kind && claim.key === key && claim.status === 'active') return claim
  }
  return null
}

export function diffFacts(previous, next, claims, factMetadata = new Map()) {
  const events = []
  const at = nowIso()
  const evidenceOf = (item) => item?.evidence ? [{ handle: 'user', quote: clean(item.evidence), time: clean(item.createdAt) }] : []
  // Provenance is scoped to one exact fact, never to the whole save/migration.
  const optionsFor = (kind, value, evidence) => factMetadata.get(claimKey(kind, value)) ?? { source: 'user', evidence }
  const claimEvent = (kind, value, evidence = []) => {
    const options = optionsFor(kind, value, evidence)
    events.push({ type: 'claim', at, claim: makeClaim(kind,
      options.subject === 'role' ? { ...value, subject: 'role' } : value, options) })
  }
  // 同一次保存如果因为写盘失败被重试，不能把已经 active 的事实再追加一遍。
  const addClaim = (kind, value, evidence = []) => {
    const key = claimKey(kind, value)
    if (key && findActive(claims, kind, key)) return
    claimEvent(kind, value, evidence)
  }
  // 纠正只改字段，**不能把原话证据一起丢掉** —— 习惯/纪念日的证据是
  // 「这条为什么存在」的唯一凭据，改个边界就没了，档案会变成一屋子没来由的断言。
  const correct = (old, kind, value, evidence = old.evidence) => {
    // Editing status/notes does not erase the original verified source.
    if (evidence?.length === 1 && old.evidence?.some(item => item.quote === evidence[0].quote)) evidence = old.evidence
    const options = optionsFor(kind, value, evidence)
    events.push({ type: 'correct', id: old.id, at, claim: makeClaim(kind,
      options.subject === 'role' ? { ...value, subject: 'role' } : value, options) })
  }
  const retract = old => events.push({ type: 'retract', id: old.id, at })

  if (previous.profile?.identity !== next.profile?.identity) {
    const old = findActive(claims, 'profile', 'profile:identity')
    if (old) correct(old, 'profile', { field: 'identity', text: clean(next.profile.identity) })
    else addClaim('profile', { field: 'identity', text: clean(next.profile.identity) })
  }
  for (const field of PROFILE_FIELDS) {
    const before = new Set(previous.profile?.[field] ?? [])
    const after = new Set(next.profile?.[field] ?? [])
    for (const text of after) if (!before.has(text)) addClaim('profile', { field, text })
    for (const text of before) {
      if (after.has(text)) continue
      const old = findActive(claims, 'profile', claimKey('profile', { field, text }))
      if (old) retract(old)
    }
  }

  const beforeMilestones = new Map((previous.relation?.milestones ?? []).map(item => [claimKey('milestone', item), item]))
  const afterMilestones = new Map((next.relation?.milestones ?? []).map(item => [claimKey('milestone', item), item]))
  for (const [key, item] of afterMilestones) {
    if (!beforeMilestones.has(key)) { addClaim('milestone', valueOf(item, 'milestone'), evidenceOf(item)); continue }
    const old = findActive(claims, 'milestone', key)
    const before = beforeMilestones.get(key)
    if (old && before.evidence !== item.evidence) correct(old, 'milestone', valueOf(item, 'milestone'), evidenceOf(item))
  }
  for (const [key] of beforeMilestones) {
    if (afterMilestones.has(key)) continue
    const old = findActive(claims, 'milestone', key)
    if (old) retract(old)
  }

  const beforeHabits = new Map((previous.habits ?? []).map(item => [claimKey('habit', item), item]))
  const afterHabits = new Map((next.habits ?? []).map(item => [claimKey('habit', item), item]))
  for (const [key, item] of afterHabits) {
    if (!beforeHabits.has(key)) { addClaim('habit', valueOf(item, 'habit'), evidenceOf(item)); continue }
    const old = findActive(claims, 'habit', key)
    const before = beforeHabits.get(key)
    if (old && (before.boundary !== item.boundary || before.feedback !== item.feedback || before.evidence !== item.evidence)) {
      correct(old, 'habit', valueOf(item, 'habit'), evidenceOf(item))
    }
  }
  for (const [key] of beforeHabits) {
    if (afterHabits.has(key)) continue
    const old = findActive(claims, 'habit', key)
    if (old) retract(old)
  }

  const beforeLibrary = new Map((previous.library ?? []).map(item => [claimKey('library', item), item]))
  const afterLibrary = new Map((next.library ?? []).map(item => [claimKey('library', item), item]))
  for (const [key, item] of afterLibrary) {
    if (!beforeLibrary.has(key)) { addClaim('library', valueOf(item, 'library')); continue }
    const old = findActive(claims, 'library', key)
    const before = beforeLibrary.get(key)
    if (old && (before.state !== item.state || before.progress !== item.progress || before.note !== item.note
      || before.source !== item.source || before.kind !== item.kind
      || JSON.stringify(libraryReadingFields(before)) !== JSON.stringify(libraryReadingFields(item)))) {
      correct(old, 'library', valueOf(item, 'library'))
    }
  }
  for (const [key] of beforeLibrary) {
    if (afterLibrary.has(key)) continue
    const old = findActive(claims, 'library', key)
    if (old) retract(old)
  }

  const beforeEpisodes = new Map((previous.episodes ?? []).map(item => [claimKey('episode', item), item]))
  const afterEpisodes = new Map((next.episodes ?? []).map(item => [claimKey('episode', item), item]))
  for (const [key, item] of afterEpisodes) {
    if (!beforeEpisodes.has(key)) { addClaim('episode', valueOf(item, 'episode'), evidenceOf(item)); continue }
    const old = findActive(claims, 'episode', key)
    const before = beforeEpisodes.get(key)
    if (old && (before.summary !== item.summary || before.evidence !== item.evidence
      || (before.tags ?? []).join('\u0000') !== (item.tags ?? []).join('\u0000'))) {
      correct(old, 'episode', valueOf(item, 'episode'), evidenceOf(item))
    }
  }
  for (const [key] of beforeEpisodes) {
    if (afterEpisodes.has(key)) continue
    const old = findActive(claims, 'episode', key)
    if (old) retract(old)
  }

  const beforePromises = new Map((previous.promises ?? []).map(item => [claimKey('promise', item), item]))
  const afterPromises = new Map((next.promises ?? []).map(item => [claimKey('promise', item), item]))
  for (const [key, item] of afterPromises) {
    if (!beforePromises.has(key)) { addClaim('promise', valueOf(item, 'promise'), evidenceOf(item)); continue }
    const old = findActive(claims, 'promise', key)
    const before = beforePromises.get(key)
    if (old && (before.dueAt !== item.dueAt || before.status !== item.status || before.evidence !== item.evidence)) {
      correct(old, 'promise', valueOf(item, 'promise'), evidenceOf(item))
    }
  }
  for (const [key] of beforePromises) {
    if (afterPromises.has(key)) continue
    const old = findActive(claims, 'promise', key)
    if (old) retract(old)
  }

  const beforeBoundaries = new Map((previous.boundaries ?? []).map(item => [claimKey('boundary', item), item]))
  const afterBoundaries = new Map((next.boundaries ?? []).map(item => [claimKey('boundary', item), item]))
  for (const [key, item] of afterBoundaries) {
    if (!beforeBoundaries.has(key)) addClaim('boundary', valueOf(item, 'boundary'), evidenceOf(item))
  }
  for (const [key] of beforeBoundaries) {
    if (afterBoundaries.has(key)) continue
    const old = findActive(claims, 'boundary', key)
    if (old) retract(old)
  }

  const previousContext = contextValue(previous.context)
  const nextContext = contextValue(next.context)
  if (JSON.stringify(previousContext) !== JSON.stringify(nextContext)) {
    const old = findActive(claims, 'context', 'context')
    if (nextContext) {
      const value = nextContext
      if (old) correct(old, 'context', value)
      else addClaim('context', value)
    } else if (old) retract(old)
  }
  return events
}

function backupPersonFile(dataDir) {
  try {
    const path = join(dataDir, 'person.json')
    if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`)
  } catch { /* backup is best effort */ }
}

export function loadFacts(dataDir, defaults, raw) {
  const source = raw && typeof raw === 'object' ? (raw.projection && typeof raw.projection === 'object' ? raw.projection : raw) : null
  const { events } = migrateIfEmpty(dataDir, source)
  const claims = reduceEvents(events)
  return { events, claims, facts: projectFacts(claims, defaults) }
}

export { makeClaim, VERSION, KINDS }

// 用户明确选择的冲突裁决：保留选中的 claim，撤回其它 active claim。
// 不删除历史；只是让投影只剩一个真相。
export function resolveConflict(dataDir, kind, value) {
  const text = clean(value)
  if (!text) return false
  const events = loadEvents(dataDir)
  const claims = reduceEvents(events)
  const all = [...claims.values()]
  const active = all.filter(claim => claim.status === 'active' && (kind === 'identity'
    ? claim.kind === 'profile' && claim.value?.field === 'identity'
    : claim.kind === 'context'))
  if (!active.length) return false
  const chosen = active.find(claim => clean(kind === 'identity' ? claim.value?.text : claim.value?.quote) === text)
  // 只允许裁决到当前真实存在的说法。传错/过期的 value 不能把全部 active
  // identity 一起撤回 —— 那等于一次误点清空身份。
  if (!chosen) return false
  const at = nowIso()
  const writes = []
  for (const claim of active) if (claim.id !== chosen.id) writes.push({ type: 'retract', id: claim.id, at })
  return appendEvents(dataDir, writes)
}

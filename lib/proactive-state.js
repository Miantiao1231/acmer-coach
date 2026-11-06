// 主动联系的持久账本：只存工作流状态，不存「她是谁」。
// 事实仍归 person/claims；这里记录“什么时候说过、他回没回、今天用了几次”。
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'proactive-state.json'
const LOCK = 'proactive-state.lock'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 2
const MAX_CONTACTS = 200
const MAX_RECENT = 30
const MAX_PENDING_REPLIES = 4
const MAX_JUDGE_CACHE = 50
const MAX_EVENTS = 120
// 主动消息发出去后，模型可能还在排版/走工具；超过这个时间就不再把它当“对这条消息的回复”。
export const PENDING_REPLY_TTL_MS = 10 * 60 * 1000

const clean = (value) => String(value ?? '').trim()
const pad = (n) => String(n).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const iso = (date) => date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : ''

export function emptyState(now = new Date()) {
  return {
    version: VERSION,
    revision: 0,
    enabled: false,
    sessionId: '',
    route: null,
    lastUserAt: '',
    lastUserText: '',
    activeSince: '',
    lastContactAt: '',
    lastSentAt: '',
    lastPurpose: '',
    unanswered: 0,
    day: ymd(now),
    sentToday: 0,
    occupiedToday: 0,
    draftCallsToday: 0,
    judgeCallsToday: 0,
    tokensToday: 0,
    eventLedger: [],
    followup: null,
    queue: [],
    nextAt: '',
    inflight: null,
    pendingReply: null,
    pendingReplies: [],
    pendingReceipts: [],
    judgeCache: [],
    burst: null,
    failures: 0,
    screenPeekAt: '',
    screenPeekDay: '',
    screenPeekCount: 0,
    settings: {
      intensity: '', arbiter: false, backgroundLlm: false, lifeImprov: false, lifeImprovDailyLimit: 2, autonomousReading: false, external: true,
      weatherCity: '', weatherKey: '', weatherHost: '', newsSources: '', screenVision: true,
    },
    lifeImprovBudget: { day: ymd(now), calls: 0, lastAt: '' },
    readingBudget: { day: ymd(now), calls: 0, lastAt: '' },
    readingRequests: { day: ymd(now), count: 0 },
    recent: [],
    contacts: [],
  }
}

function normalizeContact(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = clean(raw.id)
  const at = clean(raw.at)
  if (!id || !at) return null
  return {
    id,
    at,
    purpose: clean(raw.purpose).slice(0, 40),
    source: clean(raw.source).slice(0, 80),
    topic: clean(raw.topic).slice(0, 200),
    body: clean(raw.body).slice(0, 600),
    // 草稿单独留一份：body 在收到她的实际回复后会被覆盖，去重和 judge 缓存都还需要原文。
    draft: clean(raw.draft).slice(0, 600),
    status: ['sent', 'skipped', 'failed'].includes(raw.status) ? raw.status : 'skipped',
    reason: clean(raw.reason).slice(0, 200),
    replyAt: clean(raw.replyAt).slice(0, 40),
    delivery: ['confirmed', 'queued', 'unknown', 'failed'].includes(raw.delivery)
      ? raw.delivery : (raw.status === 'sent' ? 'confirmed' : ''),
    burst: raw.burst === true,
    judgeCached: raw.judgeCached === true,
    duplicate: raw.duplicate === true,
    warmed: raw.warmed === true,
    quality: Array.isArray(raw.quality) ? raw.quality.filter(item => typeof item === 'string').slice(0, 8) : [],
    judge: raw.judge && typeof raw.judge === 'object' ? {
      decision: clean(raw.judge.decision).slice(0, 20),
      score: Number.isFinite(Number(raw.judge.score)) ? Math.max(0, Math.min(100, Number(raw.judge.score))) : 0,
      reason: clean(raw.judge.reason).slice(0, 200),
    } : null,
    cooldownMinutes: Number.isInteger(raw.cooldownMinutes)
      ? Math.max(0, Math.min(10080, raw.cooldownMinutes)) : 0,
  }
}

function normalizeJudge(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const signature = clean(raw.signature)
  const at = clean(raw.at)
  const decision = raw.decision === 'send' || raw.decision === 'drop' ? raw.decision : ''
  const score = Number(raw.score)
  if (!signature || !at || !Number.isFinite(Date.parse(at)) || !decision
    || !Number.isInteger(score) || score < 0 || score > 100) return null
  return {
    signature: signature.slice(0, 200),
    decision,
    score,
    reason: clean(raw.reason).slice(0, 200),
    at,
  }
}

function normalizePending(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const contactId = clean(raw.contactId)
  const at = clean(raw.at)
  if (!contactId || !at) return null
  return {
    contactId: contactId.slice(0, 120),
    at,
    sessionId: clean(raw.sessionId).slice(0, 200),
    draft: clean(raw.draft).slice(0, 600),
    messageId: clean(raw.messageId).slice(0, 200),
  }
}

function normalizeReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const messageId = clean(raw.messageId)
  const at = clean(raw.at)
  if (!messageId || !at || !Number.isFinite(Date.parse(at))) return null
  return { messageId: messageId.slice(0, 200), sessionId: clean(raw.sessionId).slice(0, 200), at }
}

export function normalizeState(raw, now = new Date()) {
  const base = emptyState(now)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const recent = (Array.isArray(raw.recent) ? raw.recent : []).filter(item =>
    item && typeof item.topic === 'string' && typeof item.at === 'string')
    .slice(-MAX_RECENT)
    .map(item => ({
      topic: item.topic.slice(0, 200),
      at: item.at,
      purpose: clean(item.purpose).slice(0, 40),
      cooldownMinutes: Number.isInteger(item.cooldownMinutes) ? Math.max(0, Math.min(10080, item.cooldownMinutes)) : 0,
    }))
  const contacts = (Array.isArray(raw.contacts) ? raw.contacts : []).map(normalizeContact).filter(Boolean).slice(-MAX_CONTACTS)
  const route = raw.route && typeof raw.route === 'object'
    && typeof raw.route.provider === 'string' && typeof raw.route.model === 'string'
    ? { provider: raw.route.provider.slice(0, 120), model: raw.route.model.slice(0, 120) } : null
  // 旧版只存一条 pendingReply；新版最多存 4 条，按发出顺序配对回复。
  const pendingReplies = (Array.isArray(raw.pendingReplies) ? raw.pendingReplies : [])
    .map(normalizePending).filter(Boolean).slice(-MAX_PENDING_REPLIES)
  if (!pendingReplies.length) {
    const legacy = normalizePending(raw.pendingReply)
    if (legacy) pendingReplies.push(legacy)
  }
  const judgeCache = (Array.isArray(raw.judgeCache) ? raw.judgeCache : [])
    .map(normalizeJudge).filter(Boolean).slice(-MAX_JUDGE_CACHE)
  const state = {
    ...base,
    revision: Number.isInteger(raw.revision) ? Math.max(0, raw.revision) : 0,
    enabled: raw.enabled === true,
    sessionId: clean(raw.sessionId).slice(0, 200),
    route,
    lastUserAt: clean(raw.lastUserAt),
    lastUserText: clean(raw.lastUserText).slice(0, 200),
    activeSince: clean(raw.activeSince),
    lastContactAt: clean(raw.lastContactAt),
    lastSentAt: clean(raw.lastSentAt),
    lastPurpose: clean(raw.lastPurpose).slice(0, 40),
    unanswered: Number.isInteger(raw.unanswered) ? Math.max(0, Math.min(99, raw.unanswered)) : 0,
    failures: Number.isInteger(raw.failures) ? Math.max(0, Math.min(9, raw.failures)) : 0,
    screenPeekAt: clean(raw.screenPeekAt),
    screenPeekDay: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.screenPeekDay ?? '')) ? String(raw.screenPeekDay) : '',
    screenPeekCount: Number.isInteger(raw.screenPeekCount) ? Math.max(0, Math.min(9, raw.screenPeekCount)) : 0,
    settings: {
      intensity: ['light', 'standard', 'strong'].includes(raw.settings?.intensity) ? raw.settings.intensity : '',
      // 额外模型活动要明确启用；旧数据缺字段不能当作付费授权。
      arbiter: raw.settings?.arbiter === true,
      backgroundLlm: raw.settings?.backgroundLlm === true,
      lifeImprov: raw.settings?.lifeImprov === true,
      autonomousReading: raw.settings?.autonomousReading === true,
      lifeImprovDailyLimit: Number.isInteger(raw.settings?.lifeImprovDailyLimit)
        && raw.settings.lifeImprovDailyLimit >= 1 && raw.settings.lifeImprovDailyLimit <= 6
        ? raw.settings.lifeImprovDailyLimit : 2,
      external: raw.settings?.external !== false,
      weatherCity: clean(raw.settings?.weatherCity).slice(0, 80),
      weatherKey: clean(raw.settings?.weatherKey).slice(0, 200),
      weatherHost: clean(raw.settings?.weatherHost).slice(0, 200),
      newsSources: clean(raw.settings?.newsSources).slice(0, 400),
      screenVision: raw.settings?.screenVision !== false,
    },
    lifeImprovBudget: {
      day: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.lifeImprovBudget?.day ?? '')) ? raw.lifeImprovBudget.day : base.day,
      calls: Number.isInteger(raw.lifeImprovBudget?.calls) ? Math.max(0, raw.lifeImprovBudget.calls) : 0,
      lastAt: iso(new Date(raw.lifeImprovBudget?.lastAt ?? '')),
    },
    readingBudget: {
      day: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.readingBudget?.day ?? '')) ? raw.readingBudget.day : base.day,
      calls: Number.isInteger(raw.readingBudget?.calls) ? Math.max(0, raw.readingBudget.calls) : 0,
      lastAt: iso(new Date(raw.readingBudget?.lastAt ?? '')),
    },
    readingRequests: {
      day: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.readingRequests?.day ?? '')) ? raw.readingRequests.day : base.day,
      count: Number.isInteger(raw.readingRequests?.count) ? Math.max(0, raw.readingRequests.count) : 0,
    },
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.day ?? '')) ? String(raw.day) : base.day,
    sentToday: Number.isInteger(raw.sentToday) ? Math.max(0, raw.sentToday) : 0,
    occupiedToday: Number.isInteger(raw.occupiedToday)
      ? Math.max(0, raw.occupiedToday)
      : (Number.isInteger(raw.sentToday) ? Math.max(0, raw.sentToday) : 0),
    draftCallsToday: Number.isInteger(raw.draftCallsToday) ? Math.max(0, raw.draftCallsToday) : 0,
    judgeCallsToday: Number.isInteger(raw.judgeCallsToday) ? Math.max(0, raw.judgeCallsToday) : 0,
    tokensToday: Number.isInteger(raw.tokensToday) ? Math.max(0, raw.tokensToday) : 0,
    eventLedger: (Array.isArray(raw.eventLedger) ? raw.eventLedger : [])
      .filter((event) => event && typeof event.key === 'string' && Number.isFinite(Date.parse(event.at)))
      .map((event) => ({
        key: event.key.slice(0, 120),
        kind: clean(event.kind).slice(0, 40),
        purpose: clean(event.purpose).slice(0, 40),
        status: ['sent', 'skipped', 'held', 'failed'].includes(event.status) ? event.status : 'skipped',
        contactId: clean(event.contactId).slice(0, 120),
        at: event.at,
        revision: Number.isInteger(event.revision) ? Math.max(0, event.revision) : 0,
      }))
      .slice(-MAX_EVENTS),
    followup: raw.followup && typeof raw.followup === 'object'
      && Number.isFinite(Date.parse(raw.followup.dueAt)) && Number.isFinite(Date.parse(raw.followup.expiresAt))
      ? {
        contactId: clean(raw.followup.contactId).slice(0, 120),
        purpose: clean(raw.followup.purpose).slice(0, 40),
        topic: clean(raw.followup.topic).slice(0, 200),
        body: clean(raw.followup.body).slice(0, 600),
        at: clean(raw.followup.at).slice(0, 40),
        dueAt: raw.followup.dueAt,
        expiresAt: raw.followup.expiresAt,
        attempts: Number.isInteger(raw.followup.attempts) ? Math.max(0, Math.min(3, raw.followup.attempts)) : 0,
      }
      : null,
    queue: (Array.isArray(raw.queue) ? raw.queue : [])
      .filter((item) => item && typeof item.id === 'string' && Number.isFinite(Date.parse(item.expiresAt)))
      .map((item) => ({
        id: item.id.slice(0, 120),
        contactId: clean(item.contactId).slice(0, 120),
        body: clean(item.body).slice(0, 600),
        purpose: clean(item.purpose).slice(0, 40),
        source: clean(item.source).slice(0, 80),
        topic: clean(item.topic).slice(0, 200),
        at: clean(item.at).slice(0, 40),
        nextAt: clean(item.nextAt).slice(0, 40),
        expiresAt: item.expiresAt,
        attempts: Number.isInteger(item.attempts) ? Math.max(0, Math.min(3, item.attempts)) : 0,
        error: clean(item.error).slice(0, 200),
      }))
      .slice(-5),
    nextAt: clean(raw.nextAt),
    inflight: raw.inflight && typeof raw.inflight === 'object' && typeof raw.inflight.id === 'string' && typeof raw.inflight.at === 'string'
      ? { id: raw.inflight.id.slice(0, 120), at: raw.inflight.at, topic: clean(raw.inflight.topic).slice(0, 200), purpose: clean(raw.inflight.purpose).slice(0, 40) }
      : null,
    pendingReplies,
    pendingReply: pendingReplies.at(-1) ?? null,
    pendingReceipts: (Array.isArray(raw.pendingReceipts) ? raw.pendingReceipts : [])
      .map(normalizeReceipt).filter(Boolean).slice(-4),
    judgeCache,
    burst: raw.burst && typeof raw.burst === 'object' && typeof raw.burst.originContactId === 'string'
      && Number.isFinite(Date.parse(raw.burst.at))
      ? { originContactId: raw.burst.originContactId.slice(0, 120), originAt: clean(raw.burst.originAt), at: raw.burst.at, expiresAt: clean(raw.burst.expiresAt), sessionId: clean(raw.burst.sessionId).slice(0, 200), purpose: clean(raw.burst.purpose).slice(0, 40), topic: clean(raw.burst.topic).slice(0, 200), body: clean(raw.burst.body).slice(0, 600), remaining: Number.isInteger(raw.burst.remaining) ? Math.max(0, Math.min(2, raw.burst.remaining)) : 1 }
      : null,
    recent,
    contacts,
  }
  if (state.day !== ymd(now)) {
    state.day = ymd(now)
    state.sentToday = 0
    state.occupiedToday = 0
    state.draftCallsToday = 0
    state.judgeCallsToday = 0
    state.tokensToday = 0
    state.screenPeekDay = state.day
    state.screenPeekCount = 0
  }
  return state
}

export function loadState(dataDir, now = new Date()) {
  try {
    return normalizeState(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')), now)
  } catch {
    return emptyState(now)
  }
}

// 每次落盘都递增 revision。worker 在 await compose 前后比较它：
// revision 变了说明他说话/关开关/切强度了，这一轮必须作废，不能拿旧快照写回。
export function saveState(dataDir, state, { bumpRevision = true } = {}) {
  const path = join(dataDir, FILE)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  try {
    const revision = Number.isInteger(state.revision) ? state.revision : 0
    const next = { ...state, revision: bumpRevision ? revision + 1 : revision }
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    state.revision = next.revision
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}

function acquireStateLock(dataDir) {
  const path = join(dataDir, LOCK)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, JSON.stringify({ owner: LOCK_OWNER, at: Date.now() })) }
      catch (error) { try { closeSync(fd) } catch { /* ignore */ } try { unlinkSync(path) } catch { /* ignore */ } throw error }
      return { fd, path, ino: statSync(path).ino }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > 5000) unlinkSync(path)
      } catch { /* 另一个进程刚删掉 */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch { /* ignore */ }
    }
  }
  return null
}

function releaseStateLock(lock) {
  if (!lock) return
  try { closeSync(lock.fd) } catch { /* ignore */ }
  // 只删自己建的那一个 inode：被 stale 接管后，路径已经属于别的进程了。
  try {
    if (statSync(lock.path).ino !== lock.ino) return
    const raw = JSON.parse(readFileSync(lock.path, 'utf8'))
    if (raw?.owner === LOCK_OWNER) unlinkSync(lock.path)
  } catch { /* 不是自己的锁或已经被删 */ }
}

// 读-改-写放在同一个文件锁里。mutator 返回 null 表示这一轮不改（不落盘）。
export function updateState(dataDir, mutator, now = new Date(), { bumpRevision = true } = {}) {
  const lock = acquireStateLock(dataDir)
  if (!lock) return { ok: false, state: null, skipped: false }
  try {
    const state = loadState(dataDir, now)
    const next = mutator(state)
    if (next === null) return { ok: true, state, skipped: true }
    const ok = saveState(dataDir, next ?? state, { bumpRevision })
    return { ok, state: next ?? state, skipped: false }
  } finally {
    releaseStateLock(lock)
  }
}

export function noteUser(state, at = new Date(), text = '') {
  const time = iso(at)
  if (!time) return state
  const previous = Date.parse(state.lastUserAt)
  const gap = Number.isFinite(previous) ? Date.parse(time) - previous : Infinity
  // 连续对话才算「一直在屏幕前」；中间隔了 45 分钟就重新计时。
  if (!Number.isFinite(previous) || gap > 45 * 60 * 1000) state.activeSince = time
  state.lastUserAt = time
  // 空文本（只有附件）也要清掉上一句，避免旧的「累/别催」继续压住 pending。
  state.lastUserText = clean(text).slice(0, 200)
  state.burst = null
  // 他回话 = 这条线被接住了，之前排的「补一句」作废；失败队列里的旧消息也
  // 不能再补发，否则会在新对话里突然插一句过期的话。
  state.followup = null
  state.queue = []
  // 他回话 = 上一次主动联系被接住了；未回复计数清零。
  // 同时丢掉还没配对的回复槽：接下来那句 assistant 是在回他，不是在回主动消息。
  state.pendingReplies = []
  state.pendingReply = null
  // 不要在 noteUser 里保留旧的 nextAt：unanswered 的 6 小时暂停、上一次
  // judge-skip 的 90 分钟都已经被“他回来了”打破，下一 tick 应重新按 idle/interval 算。
  state.nextAt = ''
  if (!state.lastContactAt || Date.parse(time) > Date.parse(state.lastContactAt)) state.unanswered = 0
  return state
}

export function noteRoute(state, route) {
  if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return state
  state.route = { provider: route.provider, model: route.model }
  return state
}

export function noteContact(state, contact, now = new Date()) {
  const entry = normalizeContact(contact)
  if (!entry) return state
  state.contacts = [...(state.contacts ?? []), entry].slice(-MAX_CONTACTS)
  if (entry.status === 'sent') {
    state.lastContactAt = entry.at
    state.lastPurpose = entry.purpose
    // burst 是同一轮联系的补话：不占新的每日额度，也不再加一次未回复。
    if (!entry.burst) {
      const delivery = entry.delivery || 'confirmed'
      state.occupiedToday = (state.occupiedToday ?? state.sentToday ?? 0) + 1
      // 只有确认落盘的才计入“已发”；unknown/queued 仍占用额度，防止多发。
      if (delivery === 'confirmed') state.sentToday += 1
      state.unanswered += 1
    }
    state.recent = [...(state.recent ?? []), {
      topic: entry.topic, at: entry.at, purpose: entry.purpose,
      ...(entry.cooldownMinutes ? { cooldownMinutes: entry.cooldownMinutes } : {}),
    }].slice(-MAX_RECENT)
  } else if (entry.status === 'skipped' || entry.status === 'failed') {
    // 失败/跳过的同一话题先冷静 5 分钟，避免 judge 坏一次就每分钟重选同一条。
    state.recent = [...(state.recent ?? []), {
      topic: entry.topic, at: entry.at, purpose: entry.purpose, cooldownMinutes: 5,
    }].slice(-MAX_RECENT)
  }
  return state
}

export function rememberJudge(state, signature, judge, at = new Date()) {
  const entry = normalizeJudge({
    signature,
    decision: judge?.decision,
    score: judge?.score,
    reason: judge?.reason,
    at: iso(at),
  })
  if (!entry) return state
  state.judgeCache = [...(state.judgeCache ?? []).filter(item => item.signature !== entry.signature), entry]
    .slice(-MAX_JUDGE_CACHE)
  return state
}

export function addPendingReply(state, pending) {
  const entry = normalizePending(pending)
  if (!entry) return state
  const list = Array.isArray(state.pendingReplies) ? state.pendingReplies : (state.pendingReply ? [state.pendingReply] : [])
  state.pendingReplies = [...list, entry].slice(-MAX_PENDING_REPLIES)
  state.pendingReply = state.pendingReplies.at(-1) ?? null
  return state
}

// 配对“她对主动消息真正说出口的话”。旧实现只有一个槽，burst 会覆盖原消息；
// 现在按发出顺序取最早一条，并且用户一说话就清空、超过 10 分钟作废。
export function noteAssistantReply(state, sessionId, text, at = new Date()) {
  const body = clean(text).slice(0, 1200)
  if (!body) return null
  const atMs = at instanceof Date ? at.getTime() : Date.parse(at)
  if (!Number.isFinite(atMs)) return null
  const list = Array.isArray(state.pendingReplies) ? state.pendingReplies : (state.pendingReply ? [state.pendingReply] : [])
  if (!list.length) { state.pendingReply = null; return null }
  const fresh = list.filter(entry => {
    const sentAt = Date.parse(entry.at)
    return Number.isFinite(sentAt) && atMs >= sentAt - 60000 && atMs - sentAt <= PENDING_REPLY_TTL_MS
  })
  const pending = fresh.find(entry => !sessionId || !entry.sessionId || entry.sessionId === sessionId)
  if (!pending) {
    // 只丢掉过期项，别把别的会话还活着的槽一起清了。
    state.pendingReplies = fresh
    state.pendingReply = fresh.at(-1) ?? null
    return null
  }
  const contact = (state.contacts ?? []).find(item => item.id === pending.contactId)
  if (contact) {
    contact.body = body
    contact.replyAt = iso(at)
  }
  const remaining = fresh.filter(entry => entry !== pending)
  state.pendingReplies = remaining
  state.pendingReply = remaining.at(-1) ?? null
  return contact ?? null
}

// 真正收到「这条唤醒消息已经进了会话」的回执后，把 queued/unknown 补成 confirmed。
// 只改最近 10 分钟内、还没确认的那条，避免旧账被翻出来重复计数。
export function confirmDelivery(state, sessionId, messageId, at = new Date()) {
  const atMs = at instanceof Date ? at.getTime() : Date.parse(at)
  if (!Number.isFinite(atMs)) return null
  const pending = messageId
    ? (state.pendingReplies ?? []).find(item => item.messageId === messageId)
    : (state.pendingReplies ?? []).find(item => !sessionId || item.sessionId === sessionId)
  const contact = pending?.contactId
    ? (state.contacts ?? []).find(item => item.id === pending.contactId)
    : (messageId ? null : [...(state.contacts ?? [])].reverse().find(item => item.status === 'sent'
      && item.delivery !== 'confirmed'))
  if (!contact) {
    // 事件可能比 worker 记账先到（followup 先落盘、flush 后返回）。
    // 先把回执存起来，等 noteContact 把这条 contact 写进去时再认领。
    if (messageId) {
      state.pendingReceipts = [...(state.pendingReceipts ?? []), {
        messageId: messageId.slice(0, 200), sessionId: clean(sessionId).slice(0, 200), at: iso(at),
      }].slice(-4)
    }
    return null
  }
  if (contact.status !== 'sent' || contact.delivery === 'confirmed') return null
  const sentAt = Date.parse(contact.at)
  if (!Number.isFinite(sentAt) || atMs - sentAt > PENDING_REPLY_TTL_MS) return null
  contact.delivery = 'confirmed'
  // 发出去时只有 confirmed 才计入 sentToday；现在补上，不重复加。
  if (!contact.burst) state.sentToday = (state.sentToday ?? 0) + 1
  return contact
}

export function contactSummary(state) {
  const contacts = state.contacts ?? []
  const sent = contacts.filter(item => item.status === 'sent')
  const stats = {
    sent: sent.length,
    skipped: contacts.filter(item => item.status === 'skipped').length,
    failed: contacts.filter(item => item.status === 'failed').length,
    judgeCached: contacts.filter(item => item.judgeCached === true).length,
    judgeDrop: contacts.filter(item => item.judge?.decision === 'drop').length,
    duplicate: contacts.filter(item => item.duplicate === true).length,
    warmed: contacts.filter(item => item.warmed === true).length,
    judgeAvg: (() => {
      const scores = contacts.map(item => item.judge?.score).filter(score => Number.isInteger(score) && score > 0)
      return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0
    })(),
    burst: contacts.filter(item => item.burst === true).length,
    confirmed: sent.filter(item => item.delivery === 'confirmed').length,
    unconfirmed: sent.filter(item => item.delivery && item.delivery !== 'confirmed').length,
  }
  return {
    enabled: state.enabled,
    sessionId: state.sessionId,
    lastContactAt: state.lastContactAt,
    lastPurpose: state.lastPurpose,
    unanswered: state.unanswered,
    failures: state.failures,
    settings: {
      ...(state.settings ?? {}),
      // 面板只需要知道“有没有配过”，不要把 Key 回传到浏览器。
      weatherKey: state.settings?.weatherKey ? '***' : '',
    },
    hasWeatherKey: Boolean(state.settings?.weatherKey),
    activeSince: state.activeSince,
    screenPeekCount: state.screenPeekCount,
    sentToday: state.sentToday,
    occupiedToday: state.occupiedToday,
    totalSent: sent.length,
    stats,
    burst: state.burst,
    recent: state.recent.slice(-3),
    recentContacts: contacts.slice(-20).map(item => ({
      at: item.at, purpose: item.purpose, status: item.status, topic: item.topic, body: item.body, replyAt: item.replyAt, reason: item.reason, quality: item.quality,
      delivery: item.delivery, judgeCached: item.judgeCached, duplicate: item.duplicate, warmed: item.warmed, burst: item.burst, judge: item.judge,
    })),
  }
}

// A remembered model route is not permission to spend background tokens.
export function backgroundModelsEnabled(dataDir, env = process.env) {
  if (env.COACH_BACKGROUND_LLM === '0') return false
  if (env.COACH_BACKGROUND_LLM === '1') return true
  return loadState(dataDir).settings.backgroundLlm === true
}

export const LIFE_IMPROV_INTERVAL_MS = 4 * 3600000

export function lifeImprovStatus(dataDir, now = new Date()) {
  const { settings, lifeImprovBudget: budget } = loadState(dataDir, now)
  const callsToday = budget.day === ymd(now) ? budget.calls : 0
  const latest = Date.parse(budget.lastAt)
  return { enabled: settings.lifeImprov === true, dailyLimit: settings.lifeImprovDailyLimit,
    callsToday, nextAt: Number.isFinite(latest) ? new Date(latest + LIFE_IMPROV_INTERVAL_MS).toISOString() : '' }
}

export function reserveLifeImprov(dataDir, now = new Date()) {
  let key = ''
  const result = updateState(dataDir, state => {
    const budget = state.lifeImprovBudget
    const day = ymd(now)
    const calls = budget.day === day ? budget.calls : 0
    const gap = now.getTime() - Date.parse(budget.lastAt)
    if (!state.settings.lifeImprov || calls >= state.settings.lifeImprovDailyLimit
      || (Number.isFinite(gap) && gap < LIFE_IMPROV_INTERVAL_MS)) return null
    state.lifeImprovBudget = { day, calls: calls + 1, lastAt: now.toISOString() }
    key = `life-improv:${day}:${calls + 1}`
    return state
  }, now)
  // Reserve before calling; failures never refund budget, even when queue admission fails.
  return result.ok && !result.skipped ? key : ''
}

export const READING_INTERVAL_MS = 30 * 60000
// 一次真实阅读会话里每次模型请求都要单独扣费：开场、检索、读一段、写笔记、
// 收尾各算一次。会话次数只是排期，真实开销按请求算。
// 用户确认的预算：每天两轮，每轮最多 4 次请求，合计 8 次。
export const READING_REQUESTS_PER_SESSION = 4
export const READING_REQUEST_LIMIT = 8

export function readingStatus(dataDir, now = new Date()) {
  const { settings, readingBudget: budget, readingRequests: requests } = loadState(dataDir, now)
  const callsToday = budget.day === ymd(now) ? budget.calls : 0
  const requestsToday = requests?.day === ymd(now) ? requests.count : 0
  const latest = Date.parse(budget.lastAt)
  let next = Number.isFinite(latest) ? latest + READING_INTERVAL_MS : 0
  if (callsToday >= 2) {
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    next = Math.max(next, midnight.getTime())
  }
  return { enabled: settings.autonomousReading === true, dailyLimit: 2, callsToday,
    requestsToday, requestLimit: READING_REQUEST_LIMIT,
    nextAt: next > now.getTime() ? new Date(next).toISOString() : '' }
}

// 在真正把请求发给模型之前调用。返回 false 表示今天额度已经用完，调用方必须停下。
export function reserveReadingRequest(dataDir, now = new Date()) {
  let granted = false
  const result = updateState(dataDir, state => {
    const day = ymd(now)
    const count = state.readingRequests?.day === day ? state.readingRequests.count : 0
    if (state.settings.autonomousReading !== true || count >= READING_REQUEST_LIMIT) return null
    state.readingRequests = { day, count: count + 1 }
    granted = true
    return state
  }, now, { bumpRevision: false })
  return Boolean(result.ok && granted)
}

export function reserveReading(dataDir, now = new Date()) {
  let key = ''
  const result = updateState(dataDir, state => {
    const day = ymd(now), budget = state.readingBudget
    const calls = budget.day === day ? budget.calls : 0
    if (state.settings.autonomousReading !== true || calls >= 2) return null
    state.readingBudget = { day, calls: calls + 1, lastAt: now.toISOString() }
    key = `reading:${day}:${calls + 1}`
    return state
  }, now)
  // One real reading session reserves one call before starting; failures are not refunded.
  return result.ok && !result.skipped ? key : ''
}

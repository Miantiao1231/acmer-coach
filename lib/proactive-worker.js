// 插件自己的主动联系 worker：不再借 DSH 日程，也不直接改 session 结构。
// 节奏/预算/来源/生成/判定/发送/回执都在这里；发送用自定义 source 的唤醒消息。
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import {
  loadState, updateState, addPendingReply, rememberJudge, noteUser, noteRoute, noteContact, noteAssistantReply,
  confirmDelivery, contactSummary, emptyState, PENDING_REPLY_TTL_MS, backgroundModelsEnabled, lifeImprovStatus, readingStatus,
} from './proactive-state.js'
import { rhythmConfig, nextAllowed } from './proactive-rhythm.js'
import { buildSources, chooseSource } from './proactive-sources.js'
import { composeProactive } from './proactive-compose.js'
import { deliverProactive } from './proactive-send.js'
import { loadExternalSources } from './external-sources.js'
import { observeScreen } from './screen-observer.js'
import { loadScreenConsent, activeScreenConsent } from './screen-consent.js'
import { acquireLease, renewLease, releaseLease } from './proactive-lock.js'
import { auditText } from './persona-audit.js'
import { inClassWindow, lifeLine } from './companion-state.js'
import { bodyLines } from './body-state.js'
import { loadSleepLedger, currentSleep } from './sleep-ledger.js'
import {
  eventAllowed, recordEvent, pruneEvents, scheduleFollowup, followupDue, clearFollowup,
  enqueueDelivery, queuedDeliveryDue, finishQueuedDelivery, dropQueuedDelivery,
} from './proactive-events.js'

const clean = (value) => String(value ?? '').trim()
const nowStamp = (now) => now.toISOString()
const makeId = () => `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const BURST_PURPOSES = new Set(['affection', 'care', 'play', 'life', 'followup'])
const MINUTE = 60 * 1000
const SCREEN_MIN_ACTIVE = 30 * MINUTE
const SCREEN_COOLDOWN = 2 * 60 * MINUTE
const SCREEN_DAILY_LIMIT = 3

const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

function roleStateOf(companion, at) {
  return [...bodyLines(companion?.body ?? {}), lifeLine(companion?.life ?? null, at)]
    .filter(Boolean).join('\n')
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n')
}

async function withTimeout(promise, ms, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 和原插件一样，让判官能看到最近真实对话，而不只是最后一句。
async function recentDialogue(ctx, sessionId) {
  try {
    const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : null
    if (!query?.readSession || !sessionId) return ''
    const snapshot = await withTimeout(query.readSession(sessionId), 3000, 'session read timeout')
    const events = Array.isArray(snapshot?.events) ? snapshot.events.slice(-80) : []
    const lines = []
    for (const event of events) {
      const message = event?.data?.message || event?.data
      if (!message || typeof message.role !== 'string') continue
      const user = message.role === 'user' && message.source?.kind === 'user'
      const assistant = message.role === 'assistant'
      if (!user && !assistant) continue
      const text = messageText(message).trim().replace(/\s+/g, ' ').slice(0, 220)
      if (!text) continue
      lines.push(`${user ? '他' : '她'}：${text}`)
    }
    return lines.slice(-8).join('\n')
  } catch {
    return ''
  }
}

function screenDue(state, at, { consented = false } = {}) {
  // 屏幕观察和外部话题是两个开关：关天气/新闻不该把截屏一起关掉。
  if (state.settings?.screenVision === false) return false
  // 开关只说「她可以看」，真正截屏还要他在页面上给的限时授权。
  if (!consented) return false
  const active = Date.parse(state.activeSince)
  const lastUser = Date.parse(state.lastUserAt)
  if (!Number.isFinite(active) || !Number.isFinite(lastUser)) return false
  if (at.getTime() - active < SCREEN_MIN_ACTIVE) return false
  if (at.getTime() - lastUser > 15 * MINUTE) return false
  if ((state.screenPeekCount ?? 0) >= SCREEN_DAILY_LIMIT) return false
  const lastPeek = Date.parse(state.screenPeekAt)
  if (Number.isFinite(lastPeek) && at.getTime() - lastPeek < SCREEN_COOLDOWN) return false
  return true
}

function log(dataDir, line) {
  try {
    const path = join(dataDir, 'proactive.log')
    mkdirSync(dirname(path), { recursive: true })
    if ((statSync(path, { throwIfNoEntry: false })?.size || 0) > 256 * 1024) {
      writeFileSync(path, readFileSync(path, 'utf8').slice(-128 * 1024), 'utf8')
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* diagnostics never block contact */ }
}

export function createProactiveWorker({
  ctx,
  dataDir,
  loadPerson,
  loadProgress,
  loadSchedule,
  loadTarget,
  loadCompanionState,
  loadVp,
  persona = '',
  rules = '',
  now = () => new Date(),
  config = null,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  fetchImpl = globalThis.fetch,
  env = process.env,
  execFileImpl = undefined,
  lifeTick = null,
  owner = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  let timer = null
  let running = false
  let stopped = false
  const cfg = config ?? rhythmConfig(env)
  const cfgFor = (state) => state?.settings?.intensity
    ? rhythmConfig({ ...env, COACH_PROACTIVE_INTENSITY: state.settings.intensity })
    : cfg

  function read() { return loadState(dataDir, now()) }

  // 发送前最后一刻的有效性核对：会话恢复可能要等 10 秒，期间开关、会话、回复
  // 或睡眠都可能变了。返回空串表示可以投；否则返回原因（lease/stale/asleep）。
  const stillWanted = (canContinue, expected = {}) => () => {
    if (!canContinue()) return 'lease'
    const current = read()
    if (!current.enabled || current.sessionId !== expected.sessionId) return 'stale'
    if (expected.lastUserAt !== undefined && current.lastUserAt !== expected.lastUserAt) return 'stale'
    if (expected.revision !== undefined && current.revision !== expected.revision) return 'stale'
    if (expected.burstOrigin && current.burst?.originContactId !== expected.burstOrigin) return 'stale'
    try { if (currentSleep(loadSleepLedger(dataDir))) return 'asleep' } catch { /* 读不到睡眠账本就不拦 */ }
    return ''
  }

  // 所有状态写都走 updateState：拿文件锁，读最新，改，落盘。
  // 不能拿 tick 开头读到的旧对象整文件覆盖 —— 那会把他刚说的、刚关掉的开关写回去。
  // 失败时短暂等一次再重试：丢一条 contact 会让已经发出的消息在账上不存在。
  function mutate(fn, at = now(), { bumpRevision = true } = {}) {
    let result = updateState(dataDir, fn, at, { bumpRevision })
    if (!result.ok) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) } catch { /* ignore */ }
      result = updateState(dataDir, fn, at, { bumpRevision })
    }
    if (!result.ok) log(dataDir, 'state-write-fail')
    return result
  }

  const contactMeta = (composed, candidate = null) => ({
    judgeCached: composed?.cached === true,
    duplicate: composed?.duplicate === true,
    warmed: composed?.warmed === true,
    ...(candidate?.cooldownMinutes ? { cooldownMinutes: candidate.cooldownMinutes } : {}),
  })

  // 回执可能比 contact 先到；发送成功后把对应回执认领掉，按 confirmed 记账。
  function takeReceipt(state, sent, at = now()) {
    const list = Array.isArray(state.pendingReceipts) ? state.pendingReceipts : []
    const index = sent?.messageId
      ? list.findIndex(item => item.messageId === sent.messageId)
      : list.findIndex(item => item.sessionId === state.sessionId
        && at.getTime() - Date.parse(item.at) <= PENDING_REPLY_TTL_MS)
    if (index < 0) return false
    list.splice(index, 1)
    state.pendingReceipts = list
    return true
  }

  function rememberComposed(state, composed, at = now()) {
    // 只缓存“判定真的给出了 send/drop”的结果；judge 调用失败不能缓存成
    // 30 分钟的 drop，否则一次网络抖动会把她这一小时的话题全压掉。
    if (!composed?.cached && composed?.judgeSignature && composed?.judge
      && composed.judge.reason !== 'judge 不可用'
      && !String(composed.reject ?? '').startsWith('judge 失败')) {
      rememberJudge(state, composed.judgeSignature, composed.judge, at)
    }
    return state
  }

  function nextAtAfter(state, at, cfgNow) {
    const after = nextAllowed(state, at, cfgNow)
    return after.at && after.at.getTime() > at.getTime() ? after.at.toISOString() : ''
  }

  function postpone(minutes) {
    const at = now()
    mutate(state => {
      state.nextAt = new Date(at.getTime() + minutes * MINUTE).toISOString()
      return state
    }, at)
  }

  function context(nowValue = now()) {
    let person = null
    let progress = null
    let schedule = null
    let target = null
    let companion = null
    let vp = null
    try { person = loadPerson(dataDir) } catch { person = null }
    try { progress = loadProgress() } catch { progress = null }
    try { schedule = loadSchedule() } catch { schedule = null }
    try { target = loadTarget() } catch { target = null }
    try { companion = loadCompanionState(dataDir) } catch { companion = null }
    try { vp = loadVp ? loadVp() : null } catch { vp = null }
    return { person, progress, schedule, target, companion, vp, now: nowValue }
  }

  async function tickBurst(state, at, cfgNow, canContinue) {
    const burst = state.burst
    if (!burst) return { ok: true, reason: 'no-burst' }
    if (!state.route?.provider || !state.route?.model) {
      mutate(s => { s.burst = null; s.nextAt = new Date(at.getTime() + 30 * MINUTE).toISOString(); return s }, at)
      return { ok: true, reason: 'burst-no-route' }
    }
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null
    if (!llm || typeof llm.stream !== 'function') {
      mutate(s => { s.burst = null; s.nextAt = new Date(at.getTime() + 30 * MINUTE).toISOString(); return s }, at)
      return { ok: true, reason: 'burst-no-llm' }
    }
    if (state.draftCallsToday >= 8 || state.judgeCallsToday >= 8) {
      mutate(s => { s.burst = null; s.nextAt = new Date(at.getTime() + 6 * 3600000).toISOString(); return s }, at)
      return { ok: true, reason: 'call-budget' }
    }
    let aborted = false
    const budget = mutate(s => {
      if (!s.enabled || s.sessionId !== state.sessionId || s.burst?.originContactId !== burst.originContactId
        || s.lastUserAt !== state.lastUserAt || s.revision !== state.revision) { aborted = true; return null }
      s.draftCallsToday += 1
      s.judgeCallsToday += 1
      return s
    }, at)
    if (!budget.ok || aborted || budget.skipped) return { ok: true, reason: 'stale' }
    state = budget.state
    const baseRevision = state.revision
    const data = context(at)
    const dialogue = await recentDialogue(ctx, state.sessionId)
    const candidate = { kind: 'burst', purpose: burst.purpose, topic: burst.topic, reason: '补一句', score: 50, evidence: `上一句主动消息：${burst.body || burst.topic}` }
    if (!canContinue()) return { ok: true, reason: 'lease-lost' }
    const composed = await composeProactive({
      llm, route: state.route, persona, rules, candidate, person: data.person, state,
      roleState: roleStateOf(data.companion, at), dialogue, now: at, burst, canContinue,
    })
    if (!canContinue()) return { ok: true, reason: 'lease-lost' }
    const fresh = read()
    if (fresh.revision !== baseRevision) {
      log(dataDir, 'burst-stale')
      return { ok: true, reason: 'stale' }
    }
    // 租约可能在这 60 秒的 compose 里过期，被另一个进程接管；发送前再确认一次。
    if (!acquireLease(dataDir, owner, now())) {
      log(dataDir, 'burst-lease-lost')
      return { ok: true, reason: 'lease-lost' }
    }
    if (!composed.ok) {
      mutate(s => {
        s.burst = null
        noteContact(s, {
          ...contactMeta(composed),
          id: makeId(), at: nowStamp(now()), purpose: burst.purpose, source: 'burst',
          topic: burst.topic, body: composed.body || '', draft: composed.body || '', status: 'skipped', burst: true,
          reason: composed.reject, judge: composed.judge ?? null,
        }, now())
        rememberComposed(s, composed, now())
        s.nextAt = nextAtAfter(s, now(), cfgNow)
        return s
      })
      log(dataDir, `burst-skip reason=${composed.reject}`)
      return { ok: true, reason: 'burst-skip' }
    }
    const contactId = makeId()
    const reserved = mutate(s => {
      if (!s.enabled || s.sessionId !== state.sessionId || s.burst?.originContactId !== burst.originContactId
        || s.lastUserAt !== state.lastUserAt || s.revision !== baseRevision) { aborted = true; return null }
      s.inflight = { id: contactId, at: nowStamp(now()), topic: burst.topic, purpose: burst.purpose }
      addPendingReply(s, { contactId, at: nowStamp(now()), sessionId: s.sessionId, draft: composed.body })
      return s
    })
    if (!reserved.ok || aborted || reserved.skipped) return { ok: true, reason: 'stale' }
    const sendRevision = reserved.state.revision
    const beforeSend = read()
    if (beforeSend.revision !== sendRevision || !beforeSend.enabled
      || beforeSend.sessionId !== state.sessionId || beforeSend.lastUserAt !== state.lastUserAt
      || beforeSend.burst?.originContactId !== burst.originContactId) {
      mutate(s => {
        s.inflight = null
        s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
        s.pendingReply = s.pendingReplies.at(-1) ?? null
        return s
      })
      return { ok: true, reason: 'stale' }
    }
    let sent
    try {
      sent = await deliverProactive({ ctx, sessionId: state.sessionId, body: composed.body,
        isValid: stillWanted(canContinue, { sessionId: state.sessionId, lastUserAt: state.lastUserAt,
          revision: sendRevision, burstOrigin: burst.originContactId }) })
    } catch (error) {
      sent = { ok: false, reject: String(error?.message || error) }
    }
    if (sent.hold === 'asleep') {
      mutate(s => {
        s.inflight = null
        s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
        s.pendingReply = s.pendingReplies.at(-1) ?? null
        s.burst = null
        s.nextAt = new Date(now().getTime() + 10 * MINUTE).toISOString()
        return s
      })
      log(dataDir, 'burst-hold asleep')
      return { ok: true, reason: 'sleep-hold' }
    }
    if (!sent.ok && sent.invalid) {
      mutate(s => {
        s.inflight = null
        s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
        s.pendingReply = s.pendingReplies.at(-1) ?? null
        s.burst = null
        return s
      })
      return { ok: true, reason: 'stale' }
    }
    if (!sent.ok) {
      // 恢复会话失败时 isValid 没机会跑：记为失败前再核一次。
      const invalidNow = stillWanted(canContinue, { sessionId: state.sessionId,
        lastUserAt: state.lastUserAt, revision: sendRevision, burstOrigin: burst.originContactId })()
      if (invalidNow === 'lease') return { ok: true, reason: 'lease-lost' }
      if (invalidNow) {
        mutate(s => {
          s.inflight = null
          s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
          s.pendingReply = s.pendingReplies.at(-1) ?? null
          s.burst = null
          if (invalidNow === 'asleep') s.nextAt = new Date(now().getTime() + 10 * MINUTE).toISOString()
          return s
        })
        log(dataDir, `burst-drop ${invalidNow}`)
        return { ok: true, reason: invalidNow === 'asleep' ? 'sleep-hold' : 'stale' }
      }
      mutate(s => {
        s.inflight = null
        s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
        s.pendingReply = s.pendingReplies.at(-1) ?? null
        s.burst = null
        noteContact(s, {
          ...contactMeta(composed),
          id: contactId, at: nowStamp(now()), purpose: burst.purpose, source: 'burst',
          topic: burst.topic, body: composed.body, draft: composed.body, status: 'failed', burst: true,
          delivery: 'failed', reason: sent.reject, judge: composed.judge,
        }, now())
        rememberComposed(s, composed, now())
        s.failures = Math.min(6, (s.failures ?? 0) + 1)
        s.nextAt = new Date(now().getTime() + Math.min(2 * 3600000, 10 * MINUTE * 2 ** s.failures)).toISOString()
        return s
      })
      return { ok: false, reason: 'burst-send-fail', reject: sent.reject }
    }
    mutate(s => {
      s.inflight = null
      const pending = (s.pendingReplies ?? []).find(item => item.contactId === contactId)
      if (pending && sent.messageId) pending.messageId = sent.messageId
      const delivery = takeReceipt(s, sent, now()) ? 'confirmed' : (sent.delivery || 'confirmed')
      const stable = s.revision === sendRevision && s.enabled && s.sessionId === state.sessionId
        && delivery === 'confirmed'
      const remaining = stable ? Math.max(0, (burst.remaining ?? 1) - 1) : 0
      s.burst = stable && remaining > 0
        ? { ...burst, originAt: nowStamp(now()), at: new Date(now().getTime() + cfgNow.burstGapSeconds * 1000).toISOString(), expiresAt: new Date(now().getTime() + cfgNow.burstWindowSeconds * 1000).toISOString(), body: composed.body, remaining }
        : null
      s.failures = 0
      noteContact(s, {
          ...contactMeta(composed),
        id: contactId, at: nowStamp(now()), purpose: burst.purpose, source: 'burst',
        topic: burst.topic, body: composed.body, draft: composed.body, status: 'sent', burst: true,
        delivery, reason: '', judge: composed.judge,
      }, now())
      rememberComposed(s, composed, now())
      s.nextAt = s.burst ? s.burst.at : nextAtAfter(s, now(), cfgNow)
      return s
    })
    if (sent.persisted === false) log(dataDir, 'burst-persist-unconfirmed')
    log(dataDir, `burst-sent judge=${composed.judge?.score ?? 0}`)
    return { ok: true, reason: 'burst-sent', body: composed.body }
  }

  async function tick() {
    if (stopped) return { ok: false, reason: 'stopped' }
    if (running) return { ok: false, reason: 'busy' }
    running = true
    let heartbeat = null
    let leaseLost = false
    const canContinue = () => {
      if (stopped || leaseLost) return false
      if (!renewLease(dataDir, owner, now())) leaseLost = true
      return !leaseLost
    }
    try {
      const at = now()
      let state = read()
      const cfgNow = cfgFor(state)
      if (!acquireLease(dataDir, owner, at)) return { ok: true, reason: 'locked' }
      heartbeat = setIntervalFn(canContinue, 60000)
      heartbeat?.unref?.()
      // The life clock runs even when proactive contact is switched off: sleep,
      // the 23:50 journal, reading and the 04:00 patrol are not "messages".
      if (lifeTick) {
        try { await lifeTick(at, { canContinue }) } catch (error) { log(dataDir, `life-tick-fail ${error?.name || 'Error'}`) }
      }
      if (!canContinue()) return { ok: true, reason: 'lease-lost' }
      if (!state.enabled || !state.sessionId) return { ok: true, reason: 'disabled' }
      // 睡眠先于一切投递分支：普通、burst、队列补发都不在睡着时发。
      // 事件保留为候选，醒来后重新评估；什么都不标成已跳过。
      let asleep = false
      try { asleep = Boolean(currentSleep(loadSleepLedger(dataDir))) } catch { asleep = false }
      if (asleep) {
        mutate(s => { s.nextAt = new Date(at.getTime() + 10 * MINUTE).toISOString(); return s }, at)
        return { ok: true, reason: 'sleep-hold' }
      }
      if (state.inflight) {
        const reservedAt = Date.parse(state.inflight.at)
        if (Number.isFinite(reservedAt) && at.getTime() - reservedAt < 5 * 60 * 1000) {
          mutate(s => { s.nextAt = new Date(at.getTime() + 5 * MINUTE).toISOString(); return s }, at)
          return { ok: true, reason: 'inflight' }
        }
        // 超过 5 分钟还没落账：可能是发送后写状态失败（消息已发出）。
        // 清掉 inflight 但不能立刻重发，先冷静 10 分钟，避免同一条发两遍。
        const staleId = state.inflight.id
        const cleared = mutate(s => {
          s.inflight = null
          // 对应的 pending 槽也要清：contact 没落账时它永远配不到，只会吃掉下一条回复。
          s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== staleId)
          s.pendingReply = s.pendingReplies.at(-1) ?? null
          s.nextAt = new Date(at.getTime() + 10 * MINUTE).toISOString()
          return s
        }, at)
        if (cleared.ok && cleared.state) state = cleared.state
        log(dataDir, `inflight-stale id=${staleId}`)
        return { ok: true, reason: 'inflight-stale' }
      }
      if (state.burst) {
        if (cfgNow.burstMax <= 0) {
          const cleared = mutate(s => { s.burst = null; s.nextAt = ''; return s }, at)
          if (cleared.ok && cleared.state) state = cleared.state
        } else {
          const burstAt = Date.parse(state.burst.at)
          const expires = Date.parse(state.burst.expiresAt)
          const userAfter = state.lastUserAt && state.burst.originAt
            ? Date.parse(state.lastUserAt) > Date.parse(state.burst.originAt) : false
          if (!Number.isFinite(burstAt) || (state.burst.remaining ?? 1) <= 0
            || (Number.isFinite(expires) && expires <= at.getTime()) || userAfter) {
            const cleared = mutate(s => { s.burst = null; s.nextAt = ''; return s }, at)
            if (cleared.ok && cleared.state) state = cleared.state
          } else if (burstAt <= at.getTime()) {
            return await tickBurst(state, at, cfgNow, canContinue)
          } else {
            mutate(s => { s.nextAt = s.burst?.at || state.burst.at; return s }, at)
            return { ok: true, reason: 'burst-wait' }
          }
        }
      }
      // nextAt 不是装饰：退避/arm 的 5 分钟/静默后的早晨都靠它。
      const nextAtMs = Date.parse(state.nextAt)
      if (Number.isFinite(nextAtMs) && nextAtMs > at.getTime() + 999) {
        return { ok: true, reason: 'waiting', nextAt: state.nextAt }
      }
      const rhythm = nextAllowed(state, at, cfgNow)
      if (rhythm.at && rhythm.at.getTime() > at.getTime()) {
        mutate(s => { s.nextAt = rhythm.at.toISOString(); return s }, at)
        return { ok: true, reason: rhythm.reason, nextAt: rhythm.at.toISOString() }
      }
      if (state.draftCallsToday >= 8 || state.judgeCallsToday >= 8) {
        mutate(s => { s.nextAt = new Date(at.getTime() + 6 * 3600000).toISOString(); return s }, at)
        return { ok: true, reason: 'call-budget' }
      }
      // Drop event entries older than the ledger window; only write when the
      // oldest entry actually crossed it.
      const oldestEvent = Date.parse(state.eventLedger?.[0]?.at ?? '')
      if (Number.isFinite(oldestEvent) && at.getTime() - oldestEvent > 7 * 86400000) {
        const pruned = mutate(s => { pruneEvents(s, at); return s }, at)
        if (pruned.ok && pruned.state) state = pruned.state
      }
      // Daily token budget: a real spend counter, not just a call count.
      if ((state.tokensToday ?? 0) >= cfgNow.tokenBudget) {
        mutate(s => { s.nextAt = new Date(at.getTime() + 6 * 3600000).toISOString(); return s }, at)
        return { ok: true, reason: 'token-budget' }
      }
      // Delivery queue first: a message that failed to send is retried verbatim,
      // never recomposed (a second draft would read as a second message).
      const queued = queuedDeliveryDue(state, at)
      if (queued) {
        // 补发前重建回复槽：首投失败时它被删了；不重建的话宿主的送达回执和
        // 她的实际回复都会因为找不到 contactId 而丢掉。
        if (queued.contactId) {
          const slotted = mutate(s => {
            if (!(s.pendingReplies ?? []).some(item => item.contactId === queued.contactId)) {
              addPendingReply(s, { contactId: queued.contactId, at: nowStamp(now()), sessionId: s.sessionId, draft: queued.body })
            }
            return s
          }, at)
          if (slotted.ok && slotted.state) state = slotted.state
        }
        let queuedSent
        try {
          queuedSent = await deliverProactive({ ctx, sessionId: state.sessionId, body: queued.body,
            isValid: stillWanted(canContinue, { sessionId: state.sessionId, lastUserAt: state.lastUserAt }) })
        } catch (error) { queuedSent = { ok: false, reject: String(error?.message || error) } }
        if (queuedSent.hold === 'asleep') {
          // 睡着不是作废：队列保留，醒来再补。
          mutate(s => { s.nextAt = new Date(now().getTime() + 10 * MINUTE).toISOString(); return s }, at)
          log(dataDir, 'queue-hold asleep')
          return { ok: true, reason: 'sleep-hold' }
        }
        if (queuedSent.invalid) {
          // 开关已关/他已回答：这条补发不该再存在，直接丢掉而不是继续重试。
          const dropped = mutate(s => {
            dropQueuedDelivery(s, queued.id)
            s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== queued.contactId)
            s.pendingReply = s.pendingReplies.at(-1) ?? null
            return s
          }, at)
          if (dropped.ok && dropped.state) state = dropped.state
          log(dataDir, 'queue-dropped invalid')
          return { ok: true, reason: 'queue-invalid' }
        }
        if (!queuedSent.ok) {
          // 恢复会话失败时 isValid 没机会跑：投递前再核一次；过时/睡着都不算重试失败。
          const invalidNow = stillWanted(canContinue, { sessionId: state.sessionId, lastUserAt: state.lastUserAt })()
          if (invalidNow === 'lease') return { ok: true, reason: 'lease-lost' }
          if (invalidNow) {
            mutate(s => {
              if (invalidNow === 'asleep') {
                s.nextAt = new Date(now().getTime() + 10 * MINUTE).toISOString()
              } else {
                dropQueuedDelivery(s, queued.id)
                s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== queued.contactId)
                s.pendingReply = s.pendingReplies.at(-1) ?? null
              }
              return s
            }, at)
            log(dataDir, `queue-drop ${invalidNow}`)
            return { ok: true, reason: invalidNow === 'asleep' ? 'sleep-hold' : 'queue-invalid' }
          }
        }
        mutate(s => {
          finishQueuedDelivery(s, queued.id, { ok: queuedSent.ok, at: now(), error: queuedSent.reject })
          if (!queuedSent.ok) {
            // 真投递失败：队列留着等重试，但回复槽不能提前挂着。
            s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== queued.contactId)
            s.pendingReply = s.pendingReplies.at(-1) ?? null
            return s
          }
          const contacts = Array.isArray(s.contacts) ? s.contacts : []
          const index = contacts.findIndex(item => item.id === queued.contactId)
          const previous = index >= 0 ? contacts[index] : null
          // 补发成功复用普通发送的记账：每日条数、未回复次数、最近联系时间。
          // 按 contactId 只记一次，失败占位换成成功记录，不新增第二条。
          if (!previous || previous.status !== 'sent') {
            const delivery = takeReceipt(s, queuedSent, now()) ? 'confirmed' : (queuedSent.delivery || 'confirmed')
            if (index >= 0) contacts.splice(index, 1)
            // flush 返回前宿主的实际回复可能已经落到旧记录上（replyAt 非空）。
            // 重建成功记录时保留实际正文与 replyAt，草稿单独放回 draft；
            // 已经消费掉的回复槽不重建。
            const replied = Boolean(previous?.replyAt)
            noteContact(s, {
              ...(previous?.judgeCached ? { judgeCached: true } : {}),
              ...(previous?.duplicate ? { duplicate: true } : {}),
              ...(previous?.warmed ? { warmed: true } : {}),
              ...(previous?.cooldownMinutes ? { cooldownMinutes: previous.cooldownMinutes } : {}),
              ...(replied ? { replyAt: previous.replyAt, quality: previous.quality ?? [] } : {}),
              id: queued.contactId, at: nowStamp(now()), purpose: queued.purpose,
              source: queued.source || previous?.source || 'queued', topic: queued.topic,
              body: replied ? (previous.body || queued.body) : queued.body,
              draft: queued.body, status: 'sent', delivery, reason: '',
              ...(previous?.judge ? { judge: previous.judge } : {}),
            }, now())
          }
          if (queuedSent.messageId) {
            const pending = (s.pendingReplies ?? []).find(item => item.contactId === queued.contactId)
            if (pending) pending.messageId = queuedSent.messageId
          }
          // 事件账本里这条还挂着 failed；补发成功要更正成 sent，冷却才按已发计算。
          const event = (s.eventLedger ?? []).find(item => item.contactId === queued.contactId && item.status === 'failed')
          if (event) { event.status = 'sent'; event.at = nowStamp(now()) }
          s.nextAt = nextAtAfter(s, now(), cfgNow)
          return s
        }, at)
        log(dataDir, queuedSent.ok ? 'queue-sent' : 'queue-retry-fail')
        return { ok: queuedSent.ok, reason: queuedSent.ok ? 'queue-sent' : 'queue-retry-fail' }
      }
      const data = context(at)
      const dialogue = await recentDialogue(ctx, state.sessionId)
      if (!data.person) {
        postpone(30)
        return { ok: true, reason: 'no-person' }
      }
      // 和状态注入共用同一个时段判断，别再手写一份会漂的 hm()。
      const inClass = inClassWindow(data.schedule?.classWindow ?? null, at)
      const lectureBusy = Boolean(data.progress?.lesson || inClass)
      const pendingBusy = Boolean(data.progress?.pending) && !lectureBusy
      const busy = Boolean(data.progress?.lesson || data.progress?.pending || inClass)
      // 外部话题只在空闲时取；讲课/押卷/上课不为了天气或新闻打断他。
      let external = null
      let screen = null
      if (!busy) {
        const consented = Boolean(activeScreenConsent(loadScreenConsent(dataDir), at))
        if (state.route?.provider && state.route?.model && screenDue(state, at, { consented })) {
          // 先记冷却时间，再截屏；失败只吃 2 小时冷却，不消耗当天次数。
          const marked = mutate(s => {
            s.screenPeekAt = nowStamp(at)
            s.screenPeekDay = localDay(at)
            return s
          }, at)
          if (!marked.ok) {
            // 冷却时间没写进去就别截屏，否则锁一抖就可能连续截。
            log(dataDir, 'screen-mark-fail')
          } else {
            if (marked.state) state = marked.state
            screen = await observeScreen({ ctx, route: state.route, dataDir, now: at, execFileImpl, env })
            if (screen) {
              const counted = mutate(s => {
                s.screenPeekCount = (s.screenPeekCount ?? 0) + 1
                return s
              }, at)
              if (counted.ok && counted.state) state = counted.state
            } else {
              log(dataDir, 'screen-peek-empty')
            }
          }
        }
        if (state.settings?.external !== false) {
          external = await loadExternalSources({
            dataDir, now: at, env, fetchImpl,
            city: state.settings?.weatherCity ?? '',
            qweatherKey: state.settings?.weatherKey ?? '',
            qweatherHost: state.settings?.weatherHost ?? '',
            newsSources: state.settings?.newsSources ?? null,
          })
        }
      }

      let candidates = buildSources({
        person: data.person, progress: data.progress, target: data.target,
        classWindow: data.schedule?.classWindow ?? null, lastUserAt: state.lastUserAt || data.companion?.lastUserAt || '',
        life: data.companion?.life ?? null, journal: data.companion?.journal ?? null,
        external, screen, vp: data.vp, now: at,
      })
      // Event ledger: the same (kind, topic) does not fire again inside its
      // cooldown. This is the (id, revision) dedupe of the original.
      candidates = candidates.filter(item => eventAllowed(state, item, at))
      // 先过滤再选：不能在“押卷/上课”时先选中被禁的 pending，再把整轮判 busy，
      // 把本来允许的 promise/target 一起拖死。
      // 讲课/上课不打断；只有押卷时允许 pending 轻问一句。
      const allowed = lectureBusy ? ['target', 'promise'] : pendingBusy ? ['target', 'promise', 'pending'] : null
      if (allowed) candidates = candidates.filter(item => allowed.includes(item.kind))
      // 他刚说忙/累/别催，押卷也不要轻问。
      const tired = /(忙|累|没空|别催|不要催|等下|晚点|别烦)/.test(state.lastUserText ?? '')
        && Date.parse(state.lastUserAt) > at.getTime() - 2 * 3600000
      if (tired) candidates = candidates.filter(item => item.kind !== 'pending')
      if (tired) candidates = candidates.filter(item => !['meal', 'screen', 'weather', 'news'].includes(item.kind))
      // Open loop: the previous message is unanswered and its follow-up is due.
      // It replaces the normal candidate pick; it still goes through the same
      // compose + judge + send path.
      const followup = followupDue(state, at)
      const followupCandidate = followup ? {
        id: `followup:${followup.contactId || followup.at}`,
        kind: 'followup', purpose: followup.purpose,
        topic: `接着「${followup.topic || followup.body}」`,
        reason: '他还没回，补一句', score: 60,
        evidence: `上一句：${followup.body}`, cooldownMinutes: 0,
      } : null
      const candidate = followupCandidate ?? chooseSource(candidates, { state, now: at, sessionId: state.sessionId })
      if (!candidate) {
        postpone(30)
        return { ok: true, reason: busy ? 'busy' : 'no-candidate' }
      }
      if (!state.route?.provider || !state.route?.model) {
        postpone(30)
        log(dataDir, `skip no-route candidate=${candidate.kind}`)
        return { ok: true, reason: 'no-route' }
      }
      const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null
      if (!llm || typeof llm.stream !== 'function') {
        postpone(30)
        log(dataDir, `skip no-llm candidate=${candidate.kind}`)
        return { ok: true, reason: 'no-llm' }
      }
      let budgetAborted = false
      const budget = mutate(s => {
        if (!s.enabled || s.sessionId !== state.sessionId || s.lastUserAt !== state.lastUserAt || s.revision !== state.revision) {
          budgetAborted = true
          return null
        }
        s.draftCallsToday += 1
        s.judgeCallsToday += 1
        return s
      }, at)
      if (!budget.ok || budgetAborted || budget.skipped) return { ok: true, reason: 'stale' }
      state = budget.state
      const baseRevision = state.revision
      if (!canContinue()) return { ok: true, reason: 'lease-lost' }
      const composed = await composeProactive({
        llm, route: state.route, persona, rules, candidate, person: data.person, state,
        roleState: roleStateOf(data.companion, at), dialogue, now: at, canContinue,
        burst: followup ? { purpose: followup.purpose, topic: followup.topic, body: followup.body } : null,
      })
      if (!canContinue()) return { ok: true, reason: 'lease-lost' }
      const fresh = read()
      if (fresh.revision !== baseRevision) {
        log(dataDir, `stale candidate=${candidate.kind}`)
        return { ok: true, reason: 'stale' }
      }
      // 租约可能在这 60 秒的 compose 里过期，被另一个进程接管；发送前再确认一次。
      if (!acquireLease(dataDir, owner, now())) {
        log(dataDir, `lease-lost candidate=${candidate.kind}`)
        return { ok: true, reason: 'lease-lost' }
      }
      if (!composed.ok) {
        mutate(s => {
          s.tokensToday = (s.tokensToday ?? 0) + (composed.tokens ?? 0)
          noteContact(s, {
          ...contactMeta(composed, candidate),
            id: makeId(), at: nowStamp(now()), purpose: candidate.purpose, source: candidate.kind,
            topic: candidate.topic, body: composed.body || '', draft: composed.body || '', status: 'skipped',
            reason: composed.reject, judge: composed.judge ?? null,
          }, now())
          rememberComposed(s, composed, now())
          recordEvent(s, candidate, { at: now(), status: 'skipped' })
          if (followup) clearFollowup(s)
          s.nextAt = new Date(at.getTime() + 90 * MINUTE).toISOString()
          return s
        }, at)
        log(dataDir, `skip judge candidate=${candidate.kind} reason=${composed.reject}`)
        return { ok: true, reason: 'judge-skip', reject: composed.reject }
      }
      const contactId = makeId()
      let aborted = false
      const reserved = mutate(s => {
        if (!s.enabled || s.sessionId !== state.sessionId || s.lastUserAt !== state.lastUserAt || s.revision !== baseRevision) {
          aborted = true
          return null
        }
        s.inflight = { id: contactId, at: nowStamp(now()), topic: candidate.topic, purpose: candidate.purpose }
        addPendingReply(s, { contactId, at: nowStamp(now()), sessionId: s.sessionId, draft: composed.body })
        return s
      })
      if (!reserved.ok || aborted || reserved.skipped) return { ok: true, reason: 'stale' }
      const sendRevision = reserved.state.revision
      const beforeSend = read()
      if (beforeSend.revision !== sendRevision || !beforeSend.enabled
        || beforeSend.sessionId !== state.sessionId || beforeSend.lastUserAt !== state.lastUserAt) {
        mutate(s => {
          s.inflight = null
          s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
          s.pendingReply = s.pendingReplies.at(-1) ?? null
          return s
        })
        return { ok: true, reason: 'stale' }
      }
      let sent
      try {
        sent = await deliverProactive({ ctx, sessionId: state.sessionId, body: composed.body,
          isValid: stillWanted(canContinue, { sessionId: state.sessionId, lastUserAt: state.lastUserAt,
            revision: sendRevision }) })
      } catch (error) {
        sent = { ok: false, reject: String(error?.message || error) }
      }
      if (sent.hold === 'asleep') {
        mutate(s => {
          s.inflight = null
          s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
          s.pendingReply = s.pendingReplies.at(-1) ?? null
          s.nextAt = new Date(now().getTime() + 10 * MINUTE).toISOString()
          return s
        })
        log(dataDir, 'send-hold asleep')
        return { ok: true, reason: 'sleep-hold' }
      }
      if (!sent.ok && sent.invalid) {
        mutate(s => {
          s.inflight = null
          s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
          s.pendingReply = s.pendingReplies.at(-1) ?? null
          return s
        })
        log(dataDir, 'send-dropped invalid')
        return { ok: true, reason: 'stale' }
      }
      if (!sent.ok) {
        // 恢复会话失败时 isValid 没机会跑：入队前再核对一次；过时/睡着都不重试。
        const invalidNow = stillWanted(canContinue, { sessionId: state.sessionId,
          lastUserAt: state.lastUserAt, revision: sendRevision })()
        if (invalidNow === 'lease') return { ok: true, reason: 'lease-lost' }
        if (invalidNow) {
          mutate(s => {
            s.inflight = null
            s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
            s.pendingReply = s.pendingReplies.at(-1) ?? null
            if (invalidNow === 'asleep') s.nextAt = new Date(now().getTime() + 10 * MINUTE).toISOString()
            return s
          })
          log(dataDir, `send-drop ${invalidNow}`)
          return { ok: true, reason: invalidNow === 'asleep' ? 'sleep-hold' : 'stale' }
        }
        mutate(s => {
          s.inflight = null
          s.pendingReplies = (s.pendingReplies ?? []).filter(item => item.contactId !== contactId)
          s.pendingReply = s.pendingReplies.at(-1) ?? null
          noteContact(s, {
          ...contactMeta(composed, candidate),
            id: contactId, at: nowStamp(now()), purpose: candidate.purpose, source: candidate.kind,
            topic: candidate.topic, body: composed.body, draft: composed.body, status: 'failed',
            delivery: 'failed', reason: sent.reject, judge: composed.judge,
          }, now())
          rememberComposed(s, composed, now())
          s.tokensToday = (s.tokensToday ?? 0) + (composed.tokens ?? 0)
          recordEvent(s, candidate, { at: now(), status: 'failed', contactId })
          // Keep the text, retry verbatim. Re-drafting after a failed send would
          // risk producing a different message than the one already judged.
          enqueueDelivery(s, {
            body: composed.body, purpose: candidate.purpose, topic: candidate.topic,
            at: now(), error: sent.reject, contactId,
          })
          if (followup) clearFollowup(s)
          s.failures = Math.min(6, (s.failures ?? 0) + 1)
          s.nextAt = new Date(now().getTime() + Math.min(2 * 3600000, 10 * MINUTE * 2 ** s.failures)).toISOString()
          return s
        })
        log(dataDir, `send-fail candidate=${candidate.kind} reason=${sent.reject}`)
        return { ok: false, reason: 'send-fail', reject: sent.reject }
      }
      mutate(s => {
        s.inflight = null
        const pending = (s.pendingReplies ?? []).find(item => item.contactId === contactId)
        if (pending && sent.messageId) pending.messageId = sent.messageId
        const delivery = takeReceipt(s, sent, now()) ? 'confirmed' : (sent.delivery || 'confirmed')
        // 发送期间他关掉/切会话/说话了：这一条已经发出去了，但不要再排 burst。
        const stable = s.revision === sendRevision && s.enabled && s.sessionId === state.sessionId && s.lastUserAt === state.lastUserAt
        s.failures = 0
        noteContact(s, {
          ...contactMeta(composed, candidate),
          id: contactId, at: nowStamp(now()), purpose: candidate.purpose, source: candidate.kind,
          topic: candidate.topic, body: composed.body, draft: composed.body, status: 'sent',
          delivery, reason: '', judge: composed.judge,
        }, now())
        rememberComposed(s, composed, now())
        s.tokensToday = (s.tokensToday ?? 0) + (composed.tokens ?? 0)
        recordEvent(s, candidate, { at: now(), status: 'sent', contactId })
        if (followup) {
          clearFollowup(s)
        } else if (stable && delivery === 'confirmed') {
          // One open loop at a time: a new contact replaces the previous one.
          scheduleFollowup(s, {
            contactId, at: now(), purpose: candidate.purpose, topic: candidate.topic, body: composed.body,
            minutes: cfgNow.followupMinutes, expiresMinutes: cfgNow.followupWindowMinutes,
          })
        }
        if (stable && delivery === 'confirmed'
          && cfgNow.burstMax > 0 && BURST_PURPOSES.has(candidate.purpose)) {
          s.burst = {
            originContactId: contactId, originAt: nowStamp(now()),
            at: new Date(now().getTime() + cfgNow.burstGapSeconds * 1000).toISOString(),
            expiresAt: new Date(now().getTime() + cfgNow.burstWindowSeconds * 1000).toISOString(),
            sessionId: s.sessionId, purpose: candidate.purpose, topic: candidate.topic, body: composed.body,
            remaining: cfgNow.burstMax,
          }
        } else if (s.burst) {
          s.burst = null
        }
        s.nextAt = s.burst ? s.burst.at : nextAtAfter(s, now(), cfgNow)
        return s
      })
      if (sent.persisted === false) log(dataDir, 'send-persist-unconfirmed')
      log(dataDir, `sent candidate=${candidate.kind} judge=${composed.judge?.score ?? 0}`)
      return { ok: true, reason: 'sent', body: composed.body, candidate }
    } catch (error) {
      log(dataDir, `tick-error ${error?.message || error}`)
      return { ok: false, reason: 'error', reject: String(error?.message || error) }
    } finally {
      if (heartbeat) clearIntervalFn(heartbeat)
      running = false
    }
  }

  function start() {
    stopped = false
    if (timer) return
    let state = read()
    // 旧数据只有 companion-state.lastUserAt：启动时把它 seed 进唯一真相。
    if (!state.lastUserAt && typeof loadCompanionState === 'function') {
      try {
        const companion = loadCompanionState(dataDir)
        if (companion?.lastUserAt) {
          const seeded = updateState(dataDir, current => {
            if (!current.lastUserAt) current.lastUserAt = companion.lastUserAt
            return current
          })
          if (seeded.ok && seeded.state) state = seeded.state
        }
      } catch { /* 旧数据读不到就保持空 */ }
    }
    if (state.enabled && state.sessionId) {
      const next = nextAllowed(state, now(), cfgFor(state))
      updateState(dataDir, s => {
        if (next.at) s.nextAt = next.at.toISOString()
        return s
      })
    }
    timer = setIntervalFn(() => { void tick() }, 60_000)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  function stop() {
    stopped = true
    if (timer) clearIntervalFn(timer)
    timer = null
    releaseLease(dataDir, owner)
  }

  function arm(sessionId) {
    const id = clean(sessionId)
    if (!id) return { ok: false, reject: '没有会话 id，不能开启主动联系。' }
    const at = now()
    const result = updateState(dataDir, state => {
      state.enabled = true
      state.sessionId = id
      state.burst = null
      // 上次发送可能崩在 reserve 与落账之间；重新开启时别被旧 inflight 白挡 5 分钟。
      state.inflight = null
      state.pendingReplies = []
      state.pendingReply = null
      state.pendingReceipts = []
      state.nextAt = new Date(at.getTime() + 5 * MINUTE).toISOString()
      return state
    }, at)
    if (!result.ok) return { ok: false, reject: '主动状态写入失败。' }
    log(dataDir, `arm session=${id}`)
    return { ok: true, summary: '主动联系已开启；她会按节奏自己找你。' }
  }

  function disarm() {
    const result = updateState(dataDir, state => {
      state.enabled = false
      state.burst = null
      state.inflight = null
      state.pendingReplies = []
      state.pendingReply = null
      state.pendingReceipts = []
      state.nextAt = ''
      return state
    })
    if (!result.ok) return { ok: false, reject: '主动状态写入失败，关闭没有生效。' }
    releaseLease(dataDir, owner)
    log(dataDir, 'disarm')
    return { ok: true, summary: '主动联系已关闭。' }
  }

  function noteActiveUser(sessionId, at = now(), text = '') {
    mutate(state => {
      if (clean(sessionId)) state.sessionId = clean(sessionId)
      noteUser(state, at, text)
      return state
    }, at)
  }

  function noteActiveRoute(route) {
    mutate(state => noteRoute(state, route))
  }

  function noteActiveReply(sessionId, text, at = now()) {
    let captured = null
    const result = mutate(state => {
      captured = noteAssistantReply(state, sessionId, text, at)
      if (captured) {
        const reasons = auditText(text)
        if (reasons.length) captured.quality = reasons
      }
      return state
    }, at)
    return Boolean(result.ok && captured)
  }

  // 主动唤醒消息真正出现在会话事件里 = 送达回执。把 queued/unknown 补成 confirmed。
  function confirmActiveDelivery(sessionId, messageId, at = now()) {
    let confirmed = null
    mutate(state => {
      const before = (state.pendingReceipts ?? []).length
      confirmed = confirmDelivery(state, sessionId, messageId, at)
      const after = (state.pendingReceipts ?? []).length
      // 回执不是业务变更，不递增 revision；否则正在发送的那一轮会误判 stale，burst 被取消。
      return confirmed || after > before ? state : null
    }, at, { bumpRevision: false })
    return Boolean(confirmed)
  }

  function setSettings(settings = {}) {
    const hasIntensity = settings.intensity !== undefined && settings.intensity !== null && settings.intensity !== ''
    const hasArbiter = settings.arbiter !== undefined && settings.arbiter !== null
    const hasBackground = settings.backgroundLlm !== undefined && settings.backgroundLlm !== null
    const hasImprov = Object.hasOwn(settings, 'lifeImprov')
    const hasReading = Object.hasOwn(settings, 'autonomousReading')
    const hasImprovLimit = settings.lifeImprovDailyLimit !== undefined && settings.lifeImprovDailyLimit !== null
    const hasExternal = settings.external !== undefined && settings.external !== null
    const hasCity = settings.weatherCity !== undefined && settings.weatherCity !== null
    const hasKey = settings.weatherKey !== undefined && settings.weatherKey !== null
    const hasHost = settings.weatherHost !== undefined && settings.weatherHost !== null
    const hasNews = settings.newsSources !== undefined && settings.newsSources !== null
    const hasScreen = settings.screenVision !== undefined && settings.screenVision !== null
    const intensity = String(settings.intensity ?? '')
    if (![hasIntensity, hasArbiter, hasBackground, hasImprov, hasReading, hasImprovLimit, hasExternal, hasCity, hasKey, hasHost, hasNews, hasScreen].some(Boolean)) {
      return { ok: false, reject: '没有要保存的设置。' }
    }
    if (hasIntensity && !['light', 'standard', 'strong'].includes(intensity)) {
      return { ok: false, reject: '强度只能是 light/standard/strong。' }
    }
    const flag = (value) => !(value === false || value === 'off' || value === '0' || value === 0)
    const arbiter = hasArbiter ? flag(settings.arbiter) : null
    const backgroundLlm = hasBackground ? flag(settings.backgroundLlm) : null
    if (hasImprov && typeof settings.lifeImprov !== 'boolean') return { ok: false, reject: '生活即兴开关只接受 true 或 false。' }
    const lifeImprov = hasImprov ? settings.lifeImprov : null
    if (hasReading && typeof settings.autonomousReading !== 'boolean') return { ok: false, reject: '自主阅读开关只接受 true 或 false。' }
    const lifeImprovDailyLimit = hasImprovLimit ? Number(settings.lifeImprovDailyLimit) : null
    if (hasImprovLimit && (!Number.isInteger(lifeImprovDailyLimit) || lifeImprovDailyLimit < 1 || lifeImprovDailyLimit > 6)) {
      return { ok: false, reject: '生活即兴每日上限应为1—6次。' }
    }
    const external = hasExternal ? flag(settings.external) : null
    const screenVision = hasScreen ? flag(settings.screenVision) : null
    const weatherCity = hasCity ? clean(settings.weatherCity).slice(0, 80) : null
    const weatherKey = hasKey && clean(settings.weatherKey) !== '***' ? clean(settings.weatherKey).slice(0, 200) : null
    const weatherHost = hasHost ? clean(settings.weatherHost).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').slice(0, 200) : null
    const newsSources = hasNews
      ? (Array.isArray(settings.newsSources) ? settings.newsSources.join(',') : clean(settings.newsSources)).slice(0, 400)
      : null
    const at = now()
    let nextAt = ''
    const result = updateState(dataDir, state => {
      state.settings = {
        ...(state.settings ?? {}),
        ...(hasIntensity ? { intensity } : {}),
        ...(hasArbiter ? { arbiter } : {}),
        ...(hasBackground ? { backgroundLlm } : {}),
        ...(hasImprov ? { lifeImprov } : {}),
        ...(hasReading ? { autonomousReading: settings.autonomousReading } : {}),
        ...(hasImprovLimit ? { lifeImprovDailyLimit } : {}),
        ...(hasExternal ? { external } : {}),
        ...(hasCity ? { weatherCity } : {}),
        ...(hasKey && weatherKey !== null ? { weatherKey } : {}),
        ...(hasHost ? { weatherHost } : {}),
        ...(hasNews ? { newsSources } : {}),
        ...(hasScreen ? { screenVision } : {}),
      }
      const nextCfg = cfgFor(state)
      if (nextCfg.burstMax <= 0) state.burst = null
      const next = nextAllowed(state, at, nextCfg)
      nextAt = next.at && next.at.getTime() > at.getTime() ? next.at.toISOString() : ''
      state.nextAt = nextAt
      return state
    }, at)
    if (!result.ok) return { ok: false, reject: '主动设置写入失败。' }
    const summary = [
      hasIntensity ? `主动强度已设为 ${intensity}` : '',
      hasArbiter ? '记忆仲裁设置仅作旧版兼容，当前对话不启用' : '',
      hasBackground ? `后台生活与反思已${backgroundLlm ? '开启（消耗模型额度）' : '关闭'}` : '',
      hasImprov ? `生活即兴已${lifeImprov ? '开启（独立消耗模型额度）' : '关闭'}` : '',
      hasReading ? `自主阅读已${settings.autonomousReading ? '开启（每天两轮，每轮最多 4 次模型请求）' : '关闭'}` : '',
      hasImprovLimit ? `生活即兴每日最多${lifeImprovDailyLimit}次（失败也计，至少间隔4小时）` : '',
      hasExternal ? `外部话题已${external ? '开启' : '关闭'}` : '',
      hasCity ? `天气城市已设为 ${weatherCity || '自动（IP）'}` : '',
      hasKey ? '天气 Key 已保存' : '',
      hasHost ? `和风 Host 已设为 ${weatherHost || '空'}` : '',
      hasNews ? '新闻源已保存' : '',
      hasScreen ? `屏幕观察已${screenVision ? '开启' : '关闭'}` : '',
    ].filter(Boolean).join('；')
    return { ok: true, summary: `${summary}。` }
  }

  function status() {
    const state = read()
    const rhythm = cfgFor(state)
    const settings = state.settings ?? {}
    const improv = lifeImprovStatus(dataDir, now())
    const reading = readingStatus(dataDir, now())
    // 面板要能区分“我选了开”和“实际生效”：环境变量关掉时不能还显示开。
    const effective = {
      intensity: rhythm.intensity,
      arbiter: false,
      backgroundLlm: backgroundModelsEnabled(dataDir, env),
      lifeImprov: improv.enabled,
      autonomousReading: reading.enabled,
      external: settings.external !== false && env.COACH_EXTERNAL_SOURCES !== '0',
      screenVision: settings.screenVision !== false,
    }
    return { ...contactSummary(state), nextAt: state.nextAt, route: state.route, rhythm, effective,
      lifeImprovCallsToday: improv.callsToday, lifeImprovNextAt: improv.nextAt,
      readingCallsToday: reading.callsToday, readingNextAt: reading.nextAt,
      readingRequestsToday: reading.requestsToday, readingRequestLimit: reading.requestLimit }
  }

  return { tick, start, stop, arm, disarm, noteActiveUser, noteActiveRoute, noteActiveReply, confirmActiveDelivery, setSettings, status, read }
}

export { emptyState }

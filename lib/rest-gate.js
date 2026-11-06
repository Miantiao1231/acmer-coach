// Rest reply gate: while the role is actually asleep, a message may be held
// (reply deferred) instead of waking her. This is a JS port of the boundary
// scoring and probability/LLM decision in companion_v2 rest_gate.py.
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { localMinutes, restWindowActive } from './sleep-settings.js'

const FILE = 'rest-gate.json'
const LOCK = 'rest-gate.lock'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 1
const MAX_BACKLOG = 32

const NO_REPLY = /(?:不用|不必|无需|别|不要|先别|暂时别|今晚别|今天别)(?:再)?(?:回(?:复)?|理我|搭理我|接话|说话|出声)(?:了|啦|吧|我|哈|噢|哦|$|[，。！？,.!?])/
const QUIET = /(?:安静点|闭嘴|别说话|不要说话|别醒|继续睡)|(?:别|不要|先别).{0,10}(?:打扰|吵我|叫我|主动|发消息|找我)/
const CORRECTION = /你.{0,6}(?:没睡|没在睡|不是在睡|不是睡|不在睡|还没睡|醒着|清醒|没休息|没在休息|不是在休息)|别装睡|装睡|明明醒着|明明没睡/
const WAKEUP = /快醒|醒醒|醒一醒|醒来|醒过来|别睡了?|别睡啦|别睡嘛|先别睡|起床|起来|快起|回我一下|快回|马上回/
const GOODNIGHT = /晚安|好梦|早点睡|早点休息|睡个好觉/
const URGENT = /救命|出事|急|紧急|重要|不舒服|难受|害怕|崩溃|报警|医院|摔|痛/
const SOFT = /醒了吗|睡了吗|在吗|能不能回|可以回吗|想你|陪我|听我说|还睡吗|还在睡吗/

export function boundaryScore(text) {
  const value = String(text ?? '').replace(/\s+/g, '')
  if (!value) return { score: 0, reason: 'empty' }
  if (NO_REPLY.test(value)) return { score: -100, reason: 'user_asks_no_reply' }
  if (CORRECTION.test(value)) return { score: 100, reason: 'user_corrects_not_resting' }
  if (WAKEUP.test(value)) return { score: 100, reason: 'explicit_wakeup_request' }
  if (QUIET.test(value)) return { score: -100, reason: 'user_asks_quiet' }
  if (GOODNIGHT.test(value)) return { score: 100, reason: 'goodnight_ack' }
  if (URGENT.test(value)) return { score: 100, reason: 'urgent_or_explicit_wakeup' }
  if (SOFT.test(value)) return { score: 72, reason: 'soft_wakeup_request' }
  return { score: 0, reason: 'normal' }
}

export function restGateDecision({
  text = '', now = new Date(), sleep = null, settings, grace = null,
  probabilityRoll = Math.random, judge = null,
} = {}) {
  const decision = { action: 'reply', reason: 'not_sleeping', deferMs: 0, score: 0, boundary: 'not_sleeping' }
  if (!settings?.restGate) return { ...decision, reason: 'disabled' }
  if (!sleep?.active) return { ...decision, reason: sleep?.reason || 'not_sleeping' }
  // The original does not re-judge every message after one wake: for the grace
  // window the same sleep receipt answers "awake".
  if (grace?.active && grace.sleep === sleep.id) return { ...decision, reason: 'awake_grace' }
  const due = Date.parse(sleep.dueAt ?? '')
  if (Number.isFinite(due) && due <= now.getTime()) return { ...decision, reason: 'sleep_timer_due' }
  if (!restWindowActive(settings, now)) return { ...decision, reason: 'outside_active_window' }

  const boundary = boundaryScore(text)
  decision.score = boundary.score
  decision.boundary = boundary.reason
  const until = Number.isFinite(due) ? Math.max(1, (due - now.getTime()) / 1000) : settings.maxDeferSeconds
  const deferMs = Math.round(Math.min(settings.maxDeferSeconds, until) * 1000)
  if (boundary.score < 0) return { ...decision, action: 'hold', reason: boundary.reason, deferMs }
  if (boundary.score >= settings.restThreshold) return { ...decision, action: 'reply', reason: boundary.reason }

  if (settings.restMode === 'llm') {
    let score = null
    if (typeof judge === 'function') {
      try { score = judge({ text, sleep, settings, now }) } catch { score = null }
    }
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      return { ...decision, action: 'hold', reason: 'judge_unavailable', deferMs }
    }
    decision.score = score
    return score >= settings.restThreshold
      ? { ...decision, action: 'reply', reason: 'judge_wake' }
      : { ...decision, action: 'hold', reason: 'judge_keeps_sleeping', deferMs }
  }

  const roll = Number(probabilityRoll())
  return roll * 100 < settings.restProbability
    ? { ...decision, action: 'reply', reason: 'probability_hit' }
    : { ...decision, action: 'hold', reason: 'probability_miss', deferMs }
}

// Optional small-model wake judge for restMode=llm. Failure returns null, which
// restGateDecision treats as "keep sleeping" (the original fail-closed rule).
export async function judgeWake({ llm, route, text, sleep = null, settings, now = new Date(), timeoutMs = 3000 } = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) return null
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const stream = llm.stream({
      provider: route.provider, model: route.model,
      system: '判断角色是否应该为这条消息醒来。只输出 JSON：{"score":0-100,"reason":"一句"}。',
      messages: [createUserMessage({ content: [{ type: 'text', text: [
        `现在：${now.toISOString()}`,
        `睡眠：${JSON.stringify(sleep ?? {})}`,
        `消息：${String(text ?? '').slice(0, 800)}`,
        'score >= 阈值表示值得醒来；不确定就低分。只输出 JSON。',
      ].join('\n') }] })],
      maxTokens: 200, temperature: 0.1, signal: controller.signal,
    })
    let raw = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text'
        && typeof chunk.block.text === 'string' && !raw) raw = chunk.block.text
    }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const data = JSON.parse(raw.slice(start, end + 1))
    return Number.isInteger(data.score) && data.score >= 0 && data.score <= 100 ? data.score : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Durable gate state ─────────────────────────────────────────────
// The original keeps awake_until + a bounded backlog in runtime_metadata. We
// use one JSON document with the same two keys so a restart does not re-judge
// messages she already answered or lose the ones she missed while asleep.

export function emptyRestGateState() {
  return { version: VERSION, awakeUntil: '', awakeSleep: '', last: null, backlog: [] }
}

const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}
const textOf = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = stamp(raw.at)
  const text = textOf(raw.text, 300)
  if (at === null || !text) return null
  return { at: new Date(at).toISOString(), text, reason: textOf(raw.reason, 60), sleep: textOf(raw.sleep, 120) }
}

export function normalizeRestGateState(raw) {
  const base = emptyRestGateState()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const awakeUntil = stamp(raw.awakeUntil)
  const last = raw.last && typeof raw.last === 'object' && !Array.isArray(raw.last)
    ? { event: textOf(raw.last.event, 120), deferMs: Math.max(0, Number(raw.last.deferMs) || 0), reason: textOf(raw.last.reason, 60) }
    : null
  return {
    ...base,
    awakeUntil: awakeUntil === null ? '' : new Date(awakeUntil).toISOString(),
    awakeSleep: textOf(raw.awakeSleep, 120),
    last,
    backlog: (Array.isArray(raw.backlog) ? raw.backlog : []).map(normalizeEntry).filter(Boolean).slice(-MAX_BACKLOG),
  }
}

export function loadRestGateState(dataDir) {
  try {
    return normalizeRestGateState(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')))
  } catch {
    return emptyRestGateState()
  }
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
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > 5000) unlinkSync(path)
      } catch { /* another process just removed it */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch { /* ignore */ }
    }
  }
  return null
}

function releaseLock(lock) {
  if (!lock) return
  try { closeSync(lock.fd) } catch { /* ignore */ }
  try {
    if (statSync(lock.path).ino !== lock.ino) return
    const raw = JSON.parse(readFileSync(lock.path, 'utf8'))
    if (raw?.owner === LOCK_OWNER) unlinkSync(lock.path)
  } catch { /* not ours or already gone */ }
}

export function saveRestGateState(dataDir, state) {
  const lock = acquireLock(dataDir)
  if (!lock) return false
  try {
    const path = join(dataDir, FILE)
    if (existsSync(path)) {
      let valid = false
      try { valid = Boolean(JSON.parse(readFileSync(path, 'utf8'))?.version === VERSION) } catch { valid = false }
      if (!valid) { try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch { /* keep going */ } }
    }
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    writeFileSync(tmp, JSON.stringify(normalizeRestGateState(state), null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  } finally {
    releaseLock(lock)
  }
}

export function awakeGraceOf(state, now = new Date(), sleepId = '') {
  if (!sleepId) return null
  const until = stamp(state?.awakeUntil)
  if (until === null || until <= now.getTime()) return null
  return { active: true, sleep: state?.awakeSleep ?? '', until: new Date(until).toISOString() }
}

export function markAwake(state, { now = new Date(), settings, sleepId = '' } = {}) {
  const minutes = Math.max(0, Number(settings?.restGraceMinutes) || 0)
  if (!minutes) return { ...state, awakeUntil: '', awakeSleep: '' }
  return {
    ...state,
    awakeUntil: new Date(now.getTime() + minutes * 60000).toISOString(),
    awakeSleep: textOf(sleepId, 120),
  }
}

export function appendRestBacklog(state, {
  now = new Date(), text = '', reason = '', sleepId = '', max = 4,
} = {}) {
  const entry = { at: now.toISOString(), text: textOf(text, 300), reason: textOf(reason, 60), sleep: textOf(sleepId, 120) }
  if (!entry.text) return state
  const backlog = (Array.isArray(state?.backlog) ? state.backlog : []).slice()
  const last = backlog.at(-1)
  if (last && last.text === entry.text && last.sleep === entry.sleep
    && now.getTime() - (stamp(last.at) ?? 0) < 60000) {
    backlog[backlog.length - 1] = entry
  } else {
    backlog.push(entry)
  }
  return { ...state, backlog: backlog.slice(-Math.max(1, Math.min(MAX_BACKLOG, Number(max) || 4))) }
}

// The one pre-step entry: judge once, persist the consequence, and return the
// backlog only when she is actually replying. A held message is never surfaced
// while she is still asleep.
export function evaluateRestGate(dataDir, {
  text = '', now = new Date(), settings, sleep = null,
  probabilityRoll = Math.random, judge = null,
} = {}) {
  const state = loadRestGateState(dataDir)
  const grace = awakeGraceOf(state, now, sleep?.active ? sleep.id : '')
  const decision = restGateDecision({ text, now, sleep, settings, grace, probabilityRoll, judge })
  let next = state
  let backlog = []
  if (decision.action === 'hold') {
    next = appendRestBacklog(state, {
      now, text, reason: decision.reason, sleepId: sleep?.id, max: settings?.restBacklog,
    })
  } else {
    if (sleep?.active && decision.reason !== 'awake_grace') {
      next = markAwake(state, { now, settings, sleepId: sleep.id })
    }
    if (state.backlog.length) {
      backlog = state.backlog.slice()
      next = { ...next, backlog: [] }
    }
  }
  if (next !== state) saveRestGateState(dataDir, next)
  return { decision, backlog, state: next }
}

export { localMinutes }

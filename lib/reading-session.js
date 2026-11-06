// A real reading turn in its own session.
//
// The old background utility call wrote notes without the agent's tools or
// context, so it could invent "I never compared it that way before". Here the
// plugin opens a normal session with the coach preset, lets the agent read with
// its own web tools and `coach_read`, waits for the turn to finish, archives the
// session, and only then forwards a share decision to the session the user last
// spoke in. The temporary session never talks to the user directly.
//
// Every model request inside that session is charged to the reading budget
// before it goes out (`request/header` fires first), and a share is recorded as
// a real contact so it counts against the proactive rhythm instead of
// bypassing it.
import {
  addPendingReply, loadState, readingStatus, reserveReading, reserveReadingRequest, updateState,
  READING_REQUESTS_PER_SESSION,
} from './proactive-state.js'
import { enqueueDelivery } from './proactive-events.js'
import { dropReadReceipts } from './reading.js'

const DEFAULT_TIMEOUT = 5 * 60 * 1000
const SHARE_LIMIT = 400
const POLL_MS = 5000
export const READING_SOURCE = 'plugin:acmer-coach/reading'

// Sessions that are currently mid reading turn. `coach_read` refuses to commit
// progress once the switch is off, and only this set can tell a reading turn
// from the user reading something himself.
const activeTurns = new Set()
export const readingTurnActive = (sessionId) => activeTurns.has(String(sessionId ?? ''))

const makeId = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

const INSTRUCTION = `你现在有自己的阅读时间，不是训练任务，也不是在跟训练员对话。
这一轮最多只有 4 次模型请求，别绕路：每个工具只调一次，别反复试探。
1. 先调 coach_read open：不带参数会续读书架里没读完的；想读新的就先调 web_search 找一篇公开材料，再用 open 给 url。
2. 读完返回的这一段，调 coach_read save：note 写 40 到 160 字第一人称读书笔记，只写材料里的内容和此刻的反应，不补写「以前/我之前」这类没有记录的个人往事；continue 由你决定。
3. 最后单独输出一行：SHARE: <想对他说的一句话> 或 NO_SHARE。不要把这行写进书架笔记。
不要在临时会话里调用任何主动联系工具；分享由宿主转达。材料读不了就输出 NO_SHARE 并说明原因。`

const textOf = (event) => {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim()
}

function withTimeout(promise, ms) {
  let timer = null
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

function parseShare(text) {
  const value = String(text ?? '')
  const match = /(?:^|\n)\s*SHARE:\s*([^\n]+)/.exec(value)
  if (!match) return ''
  if (/^\s*NO_SHARE\b/i.test(value)) return ''
  return match[1].trim().slice(0, SHARE_LIMIT)
}

// The host service exposes `create()` (returns a session id) and
// `resolveAgent()`; there is no combined `createSession()`.
async function openSession(controller, preset) {
  if (typeof controller?.create !== 'function' || typeof controller.resolveAgent !== 'function') {
    return { error: '宿主不支持真实会话' }
  }
  let created
  try {
    created = await controller.create({ agentPreset: preset })
  } catch (error) {
    return { error: `阅读会话创建失败：${error?.message || error}` }
  }
  const sessionId = String(created?.sessionId ?? '')
  if (!sessionId) return { error: '阅读会话没有返回 id' }
  let found
  try {
    found = await controller.resolveAgent(sessionId)
  } catch (error) {
    return { error: `阅读会话恢复失败：${error?.message || error}`, sessionId }
  }
  if (!found?.agent) return { error: '阅读会话没有可用的 agent', sessionId }
  return { agent: found.agent, sessionId }
}

export async function runReadingSession({
  ctx, dataDir, now = new Date(), canContinue = () => true, timeoutMs = DEFAULT_TIMEOUT,
} = {}) {
  if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: '没有宿主上下文' }
  // Authorization first: a lost lease or a switch turned off must not create a
  // session, reserve budget, or spend a single request.
  if (!canContinue()) return { ok: false, reason: 'cancelled' }
  const initial = loadState(dataDir, now)
  if (initial.settings.autonomousReading !== true) return { ok: false, reason: '自主阅读已关闭' }
  const preset = process.env.COACH_READING_PRESET || 'xiaojing'

  const opened = await openSession(ctx.get('sessionController'), preset)
  const workspace = ctx.get('workspaceController')
  const archive = async (sessionId) => {
    if (!sessionId || typeof workspace?.archiveSession !== 'function') return
    try { await workspace.archiveSession({ sessionId, stopActivity: true }) } catch { /* 归档失败不影响结果 */ }
  }
  if (opened.error) {
    await archive(opened.sessionId)
    return { ok: false, reason: opened.error }
  }
  const { agent, sessionId } = opened
  if (typeof agent.followup !== 'function') {
    await archive(sessionId)
    return { ok: false, reason: '阅读会话没有可用的 agent' }
  }
  if (!reserveReading(dataDir, now)) {
    await archive(sessionId)
    return { ok: false, reason: '阅读预算已用完' }
  }

  // The lease can disappear, or the switch can be turned off, mid-turn. Poll
  // both and cancel the temporary agent instead of letting it keep spending.
  const stillWanted = () => canContinue() && loadState(dataDir, now).settings.autonomousReading === true
  let cancelled = false
  const cancel = (cause) => {
    cancelled = true
    try { agent.cancel?.(cause) } catch { /* 取消失败不阻塞归档 */ }
  }
  const stopPoll = setInterval(() => { if (!stillWanted()) cancel('lease-lost') }, POLL_MS)
  stopPoll.unref?.()

  // Charge every real model attempt before it leaves.
  //
  // `request/header` is not per-request: the agent loop only writes a header
  // when the config or the served surface changes, so a normal multi-step turn
  // (and every retry) shares one header. The honest boundary is `agent/request`,
  // the waterfall the loop runs inside prepareRequest for every attempt. Search
  // is a separate model call: the DeepSeek provider logs
  // `web/deepseek-search-llm-request` before it posts, on the session itself.
  const budget = readingStatus(dataDir, now)
  if (budget.requestsToday >= budget.requestLimit) {
    clearInterval(stopPoll)
    await archive(sessionId)
    return { ok: false, reason: '阅读预算已用完' }
  }
  let requests = 0
  const charge = () => {
    requests += 1
    if (requests > READING_REQUESTS_PER_SESSION || !reserveReadingRequest(dataDir, now)) {
      // Cancelling aborts the phase signal; the loop checks it right after this
      // hook, so the over-budget attempt never reaches the provider.
      cancel('reading-budget')
      return false
    }
    return true
  }
  const disposers = []
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/request', (payload, next) => {
      if (payload?.agent?.session?.id === sessionId) charge()
      return typeof next === 'function' ? next() : payload
    }))
    disposers.push(ctx.on('session/event', (session, event) => {
      if (session?.id !== sessionId) return
      if (event?.type === 'web/deepseek-search-llm-request') charge()
    }))
  }
  const offEvents = () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }

  activeTurns.add(sessionId)
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: INSTRUCTION }],
      source: { kind: READING_SOURCE },
    }))
    const outcome = await withTimeout(agent.whenIdle?.() ?? Promise.resolve(), timeoutMs)
    if (outcome === 'timeout') cancel('reading-timeout')
  } catch (error) {
    clearInterval(stopPoll)
    offEvents()
    activeTurns.delete(sessionId)
    await archive(sessionId)
    return { ok: false, reason: `阅读回合失败：${error?.message || error}` }
  } finally {
    clearInterval(stopPoll)
    offEvents()
    activeTurns.delete(sessionId)
    // Anything this turn opened but never committed dies with it; a late save
    // from the same session must not slip through as ordinary reading.
    dropReadReceipts(dataDir, sessionId, now)
  }
  if (cancelled || !stillWanted()) {
    await archive(sessionId)
    return { ok: false, reason: cancelled || !canContinue() ? 'cancelled' : '阅读已关闭', requests }
  }

  let finalText = ''
  try {
    const query = ctx.get('sessionQuery')
    const snapshot = await query?.readSession?.(sessionId)
    const replies = (snapshot?.events ?? [])
      .filter(event => event?.type === 'assistant/message')
      .map(textOf).filter(Boolean)
    finalText = replies.at(-1) ?? ''
  } catch { /* 读不到会话就只归档，不分享 */ }
  await archive(sessionId)

  const share = parseShare(finalText)
  let queued = false
  if (share) {
    // A share is a proactive message. It goes into the same delivery queue the
    // worker uses, so quiet hours, the daily cap, "answered nothing yet" and the
    // contact interval all apply, and the ledger records it once, at the moment
    // it actually leaves. The reading turn never talks to the main session.
    try {
      const contactId = makeId()
      const result = updateState(dataDir, state => {
        if (!state.enabled || !state.sessionId) return null
        // Same shape the worker itself leaves after a failed send: a contact id
        // and a reply slot, so the delivery receipt and his answer land on one
        // record instead of a second copy.
        addPendingReply(state, { contactId, at: now.toISOString(), sessionId: state.sessionId, draft: share })
        enqueueDelivery(state, {
          body: share, purpose: 'life', source: 'reading', contactId,
          topic: `读到的：${share.slice(0, 60)}`, at: now,
        })
        return state
      }, now)
      queued = Boolean(result.ok && !result.skipped)
    } catch { /* 入队失败就是这次不说了 */ }
  }
  return { ok: true, sessionId, requests, share: Boolean(share), queued }
}

export { parseShare, INSTRUCTION }

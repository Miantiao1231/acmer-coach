// Private-chat closing guard + adaptive debounce.
//
// Port of companion_v2 conversation/private_closing.py and private_debounce.py.
// The original's problem is real in practice: he says 晚安, she says 晚安, he
// says 晚安 again to be polite, and the two of them ping-pong until one gives
// up. The guard looks at the *previous* message in the window and stays quiet
// when the exchange has already closed.

const NIGHT = /(?:那)?(?:晚安|晚安啦|好梦|睡个好觉|早点睡|早点休息|我先睡|我去睡|睡觉去了|睡了睡了)/
const BYE = /(?:那)?(?:拜拜|再见|回见|先走了|我走了|下了|撤了|886?)/
const THANKS = /(?:那)?(?:谢谢|谢啦|感谢|多谢|辛苦了|辛苦啦)/
const ACK = /^(?:嗯+|哦+|噢+|好+|行|可以|收到|懂了|明白了|知道|ok|OK|哈哈哈*|hhh*|草)[。！？~～\s]*$/

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

export function closingKind(text) {
  const value = clean(text)
  if (!value) return ''
  if (NIGHT.test(value)) return 'goodnight'
  if (BYE.test(value)) return 'bye'
  if (THANKS.test(value)) return 'thanks'
  if (ACK.test(value)) return 'ack'
  return ''
}

// What our own reply counts as, so "晚安" answered by "晚安" ends there.
export function replyKind(text) {
  const kind = closingKind(text)
  if (kind === 'thanks') return '' // 谢谢 deserves an answer, not silence
  return kind
}

// `previous` is the message in the window right before this one:
//   { role: 'assistant' | 'user', text, at }
export function closingDecision({ text = '', now = new Date(), previous = null, settings } = {}) {
  const decision = { action: 'reply', reason: 'not_closing', kind: closingKind(text) }
  if (!settings?.closingGuard) return { ...decision, reason: 'disabled' }
  if (!decision.kind) return decision
  if (!previous?.text) return { ...decision, reason: 'no_previous' }

  const age = now.getTime() - (Date.parse(previous.at ?? '') || now.getTime())
  const windowMs = Math.max(1, Number(settings.closingWindowMinutes ?? 20)) * 60000
  if (age > windowMs) return { ...decision, reason: 'stale_previous' }

  if (previous.role === 'assistant') {
    const ours = replyKind(previous.text)
    if (ours && ours === decision.kind) {
      return { ...decision, action: 'hold', reason: `already_answered_${decision.kind}` }
    }
    // 谢谢 said right after a closing is politeness, not a new topic.
    if (decision.kind === 'thanks' && ours) {
      return { ...decision, action: 'hold', reason: 'thanks_after_closing' }
    }
    return decision
  }

  // Both sides saying 嗯 back and forth: answer once, then let it rest.
  if (decision.kind === 'ack' && replyKind(previous.text) === 'ack' && age <= (Number(settings.closingAckSeconds ?? 90) * 1000)) {
    return { ...decision, action: 'hold', reason: 'ack_chain' }
  }
  return decision
}

// Adaptive debounce window. The original merges 1.5–4s of rapid private
// messages; dsh already coalesces on its own, so adding that whole window back
// would just make every reply slower. What is left is the residue dsh cannot
// see: a sentence that is obviously unfinished ("然后", trailing comma). That
// buys at most 1.2s, and only when it is likely to save a second round trip.
export function adaptiveDebounceMs(text, { cap = 1200 } = {}) {
  const value = clean(text)
  if (!value) return 0
  let ms = 0
  if (/(?:，|,|然后|还有|就是|而且|所以|以及)$/.test(value)) ms += 800
  else if (!/[。！？!?…~～]$/.test(value) && value.length <= 12) ms += 400
  if (value.length > 60) ms += 200
  return Math.min(cap, ms)
}

export { NIGHT as GOODNIGHT_PATTERN, BYE as BYE_PATTERN }

import { setTimeout as sleep } from 'node:timers/promises'

const plainUserText = message => message?.role === 'user' && message.source?.kind === 'user'
  && Array.isArray(message.content) && message.content.length === 1
  && message.content[0]?.type === 'text' && typeof message.content[0].text === 'string'
  && message.content[0].text.trim() ? message.content[0].text : ''

const quietMs = text => /[，,：:]\s*$/.test(text) ? 3400
  : /[。！？.!?]\s*$/.test(text) ? 1500
    : text.length < 16 ? 2600 : 2200

// DSH has already claimed the first message. Pending next-turn text moves
// into the same step with its original ids, preserving the transcript and UI.
export async function coalescePrivateInput({ agent, messages, step, signal }, decision,
  { quietMs: windowFor = quietMs, maxMs = 8000, pollMs = 80 } = {}) {
  if (step !== 1 || decision?.kind !== 'enter' || !agent?.inbox?.splice
    || !Array.isArray(messages) || messages.length !== 1 || !plainUserText(messages[0])) return decision

  const started = Date.now()
  let latestAt = started
  let latestText = plainUserText(messages[0])
  const principal = JSON.stringify(messages[0].source.principal ?? null)
  const sameUser = message => plainUserText(message)
    && JSON.stringify(message.source.principal ?? null) === principal
  const collected = []
  let admitted = false
  try {
    while (!signal?.aborted) {
      const pending = agent.inbox.nextTurn
      if (pending?.length && !sameUser(pending[0])) break
      let count = 0
      while (count < (pending?.length || 0) && sameUser(pending[count])) count++
      if (count) {
        const added = agent.inbox.splice('next-turn', 0, count, [])
        if (added.length) {
          collected.push(...added)
          latestText = plainUserText(added.at(-1))
          latestAt = Date.now()
        }
      }
      const remaining = Math.min(started + maxMs, latestAt + windowFor(latestText)) - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(remaining, pollMs), undefined, { signal })
    }
    signal?.throwIfAborted?.()
    const firstIndex = decision.messages.findIndex(message => message.id === messages[0].id)
    if (firstIndex < 0) return decision
    admitted = true
    return collected.length ? { ...decision, messages: [...decision.messages.slice(0, firstIndex + 1),
      ...collected, ...decision.messages.slice(firstIndex + 1)] } : decision
  } finally {
    if (!admitted && collected.length) agent.inbox.splice('next-turn', 0, 0, collected)
  }
}

export function applyCompanion(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => coalescePrivateInput(payload, await next()))
}

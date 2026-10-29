import { setTimeout as sleep } from 'node:timers/promises'

const plainUserText = message => message?.role === 'user' && message.source?.kind === 'user'
  && Array.isArray(message.content) && message.content.length === 1
  && message.content[0]?.type === 'text' && typeof message.content[0].text === 'string'
  && message.content[0].text.trim() ? message.content[0].text : ''

const quietMs = text => /[，,：:]\s*$/.test(text) ? 3400
  : /[。！？.!?]\s*$/.test(text) ? 1500
    : text.length < 16 ? 2600 : 2200

// DSH has already claimed the first message. Claim later text into that turn
// so the host records it as used, rather than canceled.
export async function coalescePrivateInput({ agent, messages, turn, step, signal }, decision,
  { quietMs: windowFor = quietMs, maxMs = 8000, pollMs = 80 } = {}) {
  if (step !== 1 || !Number.isInteger(turn) || turn < 1 || decision?.kind !== 'enter'
    || !agent?.inbox?.claim || !Array.isArray(agent.inbox.nextTurn) || !Array.isArray(agent.inbox.nextStep)
    || !Array.isArray(messages) || messages.length !== 1 || !plainUserText(messages[0])) return decision

  const firstIndex = decision.messages.findIndex(message => message.id === messages[0].id)
  if (firstIndex < 0) return decision
  const started = Date.now()
  let latestAt = started
  let latestText = plainUserText(messages[0])
  let observedLastId
  const principal = JSON.stringify(messages[0].source.principal ?? null)
  const sameUser = message => plainUserText(message)
    && JSON.stringify(message.source.principal ?? null) === principal
  while (!signal?.aborted) {
    if (agent.inbox.nextStep.length) break
    const pending = agent.inbox.nextTurn
    if (pending.length && !sameUser(pending[0])) break
    let count = 0
    while (count < pending.length && sameUser(pending[count])) count++
    if (count) {
      const last = pending[count - 1]
      const text = plainUserText(last)
      if (last.id !== observedLastId || text !== latestText) {
        observedLastId = last.id
        latestText = text
        latestAt = Date.now()
      }
    }
    if (count < pending.length) break
    const remaining = Math.min(started + maxMs, latestAt + windowFor(latestText)) - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(remaining, pollMs), undefined, { signal })
  }
  signal?.throwIfAborted?.()
  const collected = []
  while (!agent.inbox.nextStep.length && sameUser(agent.inbox.nextTurn[0])) {
    const [message] = agent.inbox.claim('next-turn', turn)
    if (!message) break
    collected.push(message)
  }
  return collected.length ? { ...decision, messages: [...decision.messages.slice(0, firstIndex + 1),
    ...collected, ...decision.messages.slice(firstIndex + 1)] } : decision
}

export function applyCompanion(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => coalescePrivateInput(payload, await next()))
}

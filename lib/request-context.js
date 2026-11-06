// Share the host's current-context snapshot; old hosts keep the existing message fallback.
export function createRequestContext(ctx, name, order) {
  const snapshots = new WeakMap()
  const sessionOf = agent => agent?.session && typeof agent.session === 'object' ? agent.session : null
  let native = false
  try {
    const prompt = ctx.get?.('systemPrompt')
    if (typeof prompt?.context === 'function' && typeof prompt.refreshContext === 'function') {
      prompt.context({ name, order, text: ({ agent }) => snapshots.get(sessionOf(agent)) || '' })
      native = true
    }
  } catch { /* A missing optional host capability never stops conversation. */ }
  return {
    clear(agent) { const session = sessionOf(agent); if (session) snapshots.delete(session) },
    publish(agent, text) {
      const session = sessionOf(agent)
      if (!native || !session) return false
      snapshots.set(session, text)
      return true
    },
  }
}

// DeepSeek can append a changed system prompt in history. Start a native series
// when attaching/upgrading so compaction does not keep using the obsolete head.
export function createPromptGuard(ctx) {
  const checked = new WeakMap()
  let revision = 0
  ctx.on?.('system-prompt/change', () => { revision++ })
  return async (agent, decision, signal) => {
    const session = agent?.session
    if (!session || typeof session !== 'object' || checked.get(session) === revision
      || !Array.isArray(session.surface?.nodes) || typeof session.eventAt !== 'function'
      || typeof session.deriveEventMessage !== 'function') return decision
    const seenRevision = revision
    try {
      const nodes = session.surface.nodes.map(seq => session.eventAt(seq))
        .filter(event => event?.type === 'system/message')
        .map(event => session.deriveEventMessage(event))
        .map(message => ({ source: message?.source?.kind, text: message?.content
          ?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '' }))
        .filter(node => node.text)
      // Native normalization clears all system tails, so foreign sources must be left alone.
      if (!nodes.length || nodes.some(node => node.source !== 'system-prompt')) {
        checked.set(session, seenRevision)
        return decision
      }
      const prompt = ctx.get?.('systemPrompt')
      if (typeof prompt?.assemble !== 'function') return decision
      const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
      const current = renderPrompt(await prompt.assemble({ scope: agent, agent, signal }))
      signal?.throwIfAborted?.()
      checked.set(session, seenRevision)
      return nodes.length > 1 || nodes[0].text !== current ? { ...decision, startsRequestSeries: true } : decision
    } catch (error) {
      if (signal?.aborted) throw error
      return decision
    }
  }
}

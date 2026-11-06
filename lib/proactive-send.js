// 把一条已经过人格判定的主动消息送进会话。
// 用自定义 source 的 user 消息唤醒模型；客户端把这条 source 的 turn-trigger 渲染成空。
// 注意：这是 B1，不是直接追加 assistant 消息 —— 后者会破坏 DSH 的 turn/step 持久化契约。
export const PROACTIVE_SOURCE = 'plugin:acmer-coach/proactive'
const WAKE_TIMEOUT = 10 * 1000
const FLUSH_TIMEOUT = 8 * 1000

// 这两步在宿主里都可能永远不 settle；卡住会把 worker 的 running 永久按住。
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

export function wakeText(body) {
  // 一段经历 + 一句“去找他”。不加工具/改写/日程之类的硬约束。
  return [
    '<coach_proactive>',
    '你刚想起这件事：',
    String(body ?? '').trim(),
    '现在主动找训练员说说。',
    '</coach_proactive>',
  ].join('\n')
}

export async function deliverProactive({ ctx, sessionId, body, isValid = null }) {
  if (!ctx || !sessionId) return { ok: false, reject: '缺少会话或上下文' }
  const text = String(body ?? '').trim()
  if (!text) return { ok: false, reject: '主动消息为空' }
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : null
  let agent = null
  if (controller && typeof controller.resolveAgent === 'function') {
    let resolved
    try {
      resolved = await withTimeout(controller.resolveAgent(sessionId), WAKE_TIMEOUT, '会话恢复超时')
    } catch (error) {
      return { ok: false, reject: `会话恢复失败：${error?.message || error}` }
    }
    if (resolved?.error) return { ok: false, reject: `会话恢复失败：${resolved.error.message || resolved.error}` }
    agent = resolved?.agent ?? null
  }
  if (!agent) {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
    agent = typeof agents?.get === 'function' ? agents.get(sessionId) : null
  }
  if (!agent || typeof agent.followup !== 'function') return { ok: false, reject: '会话不在线，无法主动联系' }
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  // resolveAgent 最长等 10 秒：期间他可能关掉主动联系、换会话、已经回话，
  // 或者她开始午休/睡觉。在真正 followup 之前再核对一次；
  // 失效是「没发」，不是「发送失败」；睡眠是「暂缓」，不是作废。
  if (typeof isValid === 'function') {
    const invalid = isValid()
    if (invalid) {
      return {
        ok: false, invalid: true,
        hold: invalid === 'asleep' ? 'asleep' : '',
        reject: invalid === 'asleep' ? '她正在休息，主动联系暂缓' : '主动联系已失效：已关闭或已有新回复',
      }
    }
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: wakeText(text) }],
    source: { kind: PROACTIVE_SOURCE },
  })
  agent.followup(message)
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
  const hasFlush = typeof sessions?.flush === 'function'
  let persisted = false
  if (hasFlush) {
    try {
      persisted = (await withTimeout(sessions.flush(agent.session), FLUSH_TIMEOUT, '会话落盘超时')) !== false
    } catch {
      // followup 已经把消息交给 agent 了；flush 只影响落盘确认。这里如果当成
      // 发送失败，下一轮会再发一次，用户会收到重复消息。宁可标成「已发但未确认落盘」。
      persisted = false
    }
  }
  return {
    ok: true, sessionId, messageId: message.id, persisted,
    delivery: persisted ? 'confirmed' : (hasFlush ? 'unknown' : 'queued'),
  }
}

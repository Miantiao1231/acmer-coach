// One streaming text call with a hard timeout. Returns null instead of
// throwing: every caller treats a missing model as "fall back to the local
// template", never as a reason to break the turn.
import { utilityControls } from './llm-controls.js'

export async function callText({
  llm, route, system = '', prompt = '', maxTokens = 1024, temperature = 0.6,
  timeoutMs = 180000, tool = null,
} = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) return null
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const controls = await utilityControls(llm, route)
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }] })],
      ...controls,
      maxTokens,
      temperature,
      signal: controller.signal,
      ...(tool ? { tools: [tool] } : {}),
    })
    let text = ''
    let toolArgs = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text'
        && typeof chunk.block.text === 'string' && !text) text = chunk.block.text
      if (tool && chunk?.type === 'tool-call-delta' && (!chunk.name || chunk.name === tool.name)) {
        toolArgs += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      }
      if (tool && chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name === tool.name) {
        toolArgs = typeof chunk.block.arguments === 'string' ? chunk.block.arguments : toolArgs
      }
    }
    return { text, toolArgs }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Tolerant JSON extraction: models sometimes wrap the object in a fence or add
// a sentence around it. Returns null when no object can be parsed.
export function parseJsonObject(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { /* fall through to brace extraction */ }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

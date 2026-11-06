// 后台工具调用（draft/judge/屏幕/反思/记忆筛选）不需要长思考。
// 推理模型会把 maxTokens 花在 reasoning 上，正文为空；这里挑模型支持的
// 最低档思考强度，让同样的 token 预算留给正文。拿不到能力就原样返回。
const cache = new Map()
const infoCache = new Map()
const infoFailUntil = new Map()
const LOW_EFFORTS = ['none', 'off', 'minimal', 'low']
const INFO_TIMEOUT = 3000
const INFO_RETRY_AFTER = 60 * 1000

async function withTimeout(promise, ms) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('model info timeout')), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 模型目录解析没有 signal，必须自己加超时：它跑在 pre-step / worker tick 里，
// 卡住会让整轮对话或主动 worker 永久停摆。
export async function resolveModelInfoSafe(llm, route, timeoutMs = INFO_TIMEOUT) {
  const provider = route?.provider
  const model = route?.model
  if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) return null
  const key = `${provider}\u0000${model}`
  if (infoCache.has(key)) return infoCache.get(key)
  // 刚失败过的模型 60 秒内别再等 3 秒；否则每轮对话都白白卡一次。
  if (Date.now() < (infoFailUntil.get(key) ?? 0)) return null
  try {
    const info = await withTimeout(Promise.resolve(llm.resolveModelInfo(provider, model)), timeoutMs)
    infoCache.set(key, info)
    infoFailUntil.delete(key)
    return info
  } catch {
    infoFailUntil.set(key, Date.now() + INFO_RETRY_AFTER)
    return null
  }
}

export async function utilityControls(llm, route) {
  const provider = route?.provider
  const model = route?.model
  if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) return {}
  const key = `${provider}\u0000${model}`
  if (cache.has(key)) return cache.get(key)
  const info = await resolveModelInfoSafe(llm, route)
  if (!info) return {}
  const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
  const picked = lowEffort(efforts)
  const controls = picked ? { reasoningEffort: picked } : {}
  cache.set(key, controls)
  return controls
}

function lowEffort(efforts) {
  for (const wanted of LOW_EFFORTS) {
    const hit = efforts.find(effort => String(effort?.id ?? '').toLowerCase() === wanted)
    if (hit) return hit.id
  }
  return null
}

// 测试/进程内换模型时清缓存。
export function resetUtilityControls() {
  cache.clear()
  infoCache.clear()
  infoFailUntil.clear()
}

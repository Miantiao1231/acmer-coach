// 原生 time-context 首次注入前就注册了投影；不要靠消息出现顺序猜时钟是否存在。
export function hasNativeTimeContext(ctx, agent) {
  if (!agent?.session) return false
  try {
    return ctx.get?.('sessionProjections')?.stateOf?.(agent.session, 'timeContext') !== undefined
  } catch {
    return false
  }
}

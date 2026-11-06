// “他上次说话”只有一个真相：proactive-state。companion-state 里的同名字段
// 只作为旧数据回退和缓存，不再单独决定时间感。
export function lastSeenAt(proactive, companion) {
  const value = String(proactive?.lastUserAt ?? '').trim()
  if (value) return value
  return String(companion?.lastUserAt ?? '').trim()
}

// 主动联系的节奏：静默、每日额度、最短间隔、未回复降频。
// 只算「下一次最早什么时候可以想他」，不发消息，也不改事实。
const clean = (value) => String(value ?? '').trim()
const pad = (n) => String(n).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
// 环境变量是字符串；写错一个字母时 Number('abc') 是 NaN，而 Math.max/min
// 会把 NaN 原样带出去，接下来所有比较都变成 false —— 每日上限、间隔、静默
// 会同时失效。这里先把非有限值退回预设。
const numberOr = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (value, low, high, fallback = low) => Math.max(low, Math.min(high, numberOr(value, fallback)))

const QUIET_START = 22 * 60 + 30
const QUIET_END = 8 * 60

export function rhythmConfig(env = process.env) {
  const name = ['light', 'standard', 'strong'].includes(env.COACH_PROACTIVE_INTENSITY) ? env.COACH_PROACTIVE_INTENSITY : 'standard'
  const presets = {
    light: { maxPerDay: 1, minIntervalMinutes: 240, idleMinutes: 60, burstMax: 0 },
    standard: { maxPerDay: 2, minIntervalMinutes: 180, idleMinutes: 45, burstMax: 1 },
    strong: { maxPerDay: 3, minIntervalMinutes: 120, idleMinutes: 30, burstMax: 1 },
  }
  const preset = presets[name]
  return {
    intensity: name,
    maxPerDay: clamp(env.COACH_PROACTIVE_MAX_PER_DAY ?? preset.maxPerDay, 1, 4, preset.maxPerDay),
    minIntervalMinutes: clamp(env.COACH_PROACTIVE_INTERVAL_MIN ?? preset.minIntervalMinutes, 30, 720, preset.minIntervalMinutes),
    idleMinutes: clamp(env.COACH_PROACTIVE_IDLE_MIN ?? preset.idleMinutes, 5, 360, preset.idleMinutes),
    unansweredPauseAfter: clamp(env.COACH_PROACTIVE_UNANSWERED_PAUSE ?? 2, 1, 5, 2),
    burstMax: clamp(env.COACH_PROACTIVE_BURST_MAX ?? preset.burstMax, 0, 2, preset.burstMax),
    burstGapSeconds: clamp(env.COACH_PROACTIVE_BURST_GAP ?? 45, 15, 180, 45),
    burstWindowSeconds: clamp(env.COACH_PROACTIVE_BURST_WINDOW ?? 180, 60, 600, 180),
    followupMinutes: clamp(env.COACH_PROACTIVE_FOLLOWUP_MIN ?? 25, 5, 180, 25),
    followupWindowMinutes: clamp(env.COACH_PROACTIVE_FOLLOWUP_WINDOW ?? 120, 30, 360, 120),
    tokenBudget: clamp(env.COACH_PROACTIVE_TOKEN_BUDGET ?? 60000, 5000, 500000, 60000),
    quietStart: QUIET_START,
    quietEnd: QUIET_END,
  }
}

function minutesOf(date) { return date.getHours() * 60 + date.getMinutes() }
function atMinute(date, minutes) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
  next.setMinutes(minutes)
  return next
}
function jitter(date, salt = '') {
  // 固定抖动量，不是 Math.random：同一分钟算出来一致，便于测试和重启后稳定。
  let hash = 2166136261
  const text = `${ymd(date)}:${date.getHours()}:${salt}`
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  const value = (hash >>> 0) % 21 - 10 // -10..10 分钟
  return value * 60000
}

export function nextAllowed(state, now = new Date(), config = rhythmConfig()) {
  if (!state?.enabled || !state?.sessionId) return { at: null, reason: 'disabled' }
  const stamp = now.getTime()
  const quiet = minutesOf(now)
  const inQuiet = config.quietStart > config.quietEnd
    ? (quiet >= config.quietStart || quiet < config.quietEnd)
    : (quiet >= config.quietStart && quiet < config.quietEnd)
  if (inQuiet) {
    const morning = atMinute(now, config.quietEnd)
    const base = morning.getTime() <= stamp ? morning.getTime() + 86400000 : morning.getTime()
    // 静默结束后的抖动只能往后，不能把 08:00 抖回 07:59。
    return { at: new Date(base + Math.max(0, jitter(new Date(base), 'quiet'))), reason: 'quiet' }
  }
  if ((state.occupiedToday ?? state.sentToday ?? 0) >= config.maxPerDay) {
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)
    return { at: new Date(tomorrow.getTime() + jitter(tomorrow, 'daily')), reason: 'daily-cap' }
  }
  if ((state.unanswered ?? 0) >= config.unansweredPauseAfter) {
    // 连续主动都没被接住：不是拉黑，是明显放慢，等他先开口。
    return { at: new Date(stamp + 6 * 3600000), reason: 'unanswered' }
  }
  if (state.lastUserAt) {
    const lastUser = Date.parse(state.lastUserAt)
    if (Number.isFinite(lastUser)) {
      const idleAt = lastUser + config.idleMinutes * 60000
      if (idleAt > stamp) return { at: new Date(idleAt), reason: 'idle' }
    }
  }
  if (state.lastContactAt) {
    const last = Date.parse(state.lastContactAt)
    if (Number.isFinite(last)) {
      const factor = 1 + Math.min(2, state.unanswered ?? 0) * 0.35
      const interval = config.minIntervalMinutes * 60000 * factor
      if (last + interval > stamp) return { at: new Date(last + interval), reason: 'interval' }
    }
  }
  return { at: now, reason: 'ready' }
}

export function rhythmLines(state, now = new Date(), config = rhythmConfig()) {
  const next = nextAllowed(state, now, config)
  return `主动联系：${state?.enabled ? '已开' : '关'}；今天已发 ${state?.sentToday ?? 0}/${config.maxPerDay}；未回复 ${state?.unanswered ?? 0} 次；下次最早 ${next.at ? next.at.toISOString() : '—'}（${next.reason}）。`
}

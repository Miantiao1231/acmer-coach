// The original derives workload from the last 24h of private messages plus
// reading minutes. dsh does not expose a message count, so interaction-log
// records timestamps and activity-ledger records reading segments.
import { messageCountSince } from './interaction-log.js'
import { readingMinutesBetween } from './activity-ledger.js'

const WORKLOAD_WINDOW_MS = 24 * 3600 * 1000

export function workloadScoreFor({ log = null, activities = null, now = new Date() } = {}) {
  const from = new Date(now.getTime() - WORKLOAD_WINDOW_MS)
  const messages = log ? messageCountSince(log, { since: from, now }) : 0
  const readingMinutes = activities ? readingMinutesBetween(activities, { from, to: now }) : 0
  return Math.min(100, Math.round(Math.max(0, messages) * 4 + Math.max(0, readingMinutes) * 1.2))
}

export { WORKLOAD_WINDOW_MS }

// Glue between the durable sleep ledger and the rest of the plugin.
// The presence flag starts/ends an episode; the ledger is the only source of
// sleep debt/pressure. Auto nights are materialized retroactively when a night
// has already ended without an explicit sleep record.
import {
  updateSleepLedger, currentSleep, startSleepEpisode, interruptSleepEpisode,
  resumeDueSleep, finishDueSleep, finishSleepEpisode, ensureAutoNights, actualSleepMinutes,
  sleepProfile, nightSleepReady, napReady,
} from './sleep-ledger.js'
import { loadSleepSettings, sleepWindow } from './sleep-settings.js'

const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

const NAP_START = 11 * 60
const NAP_END = 16 * 60
const localMinutes = (date) => date.getHours() * 60 + date.getMinutes()
const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// The original role does not ask the user to press a "nap" button: the body
// clock starts sleep when readiness says it is due. We approximate the timer by
// starting from the beginning of the missed window and letting finishDue close it.
function autoStartSleep(ledger, { now, lastUserAt = '', workloadScore = 0, settings }) {
  if (currentSleep(ledger)) return null
  const profile = sleepProfile(ledger, { now, workloadScore })
  const minutes = localMinutes(now)
  const last = Date.parse(String(lastUserAt ?? ''))
  const gap = Number.isFinite(last) ? now.getTime() - last : Infinity
  const window = sleepWindow(now, settings)

  const inNight = now.getTime() >= window.start.getTime() && now.getTime() < window.end.getTime()
  // sleep_window_minutes: once bedtime + N minutes has passed, the window is
  // closed and she sleeps even if readiness alone would not say so. The 30-min
  // quiet gap still applies — an active conversation is not a sleep window.
  const windowClosed = now.getTime() >= window.start.getTime() + settings.windowMinutes * 60000
  if (inNight && (nightSleepReady(profile) || windowClosed)) {
    const already = ledger.episodes.some((episode) => Date.parse(episode.startedAt) >= window.start.getTime())
    if (!already && gap >= 30 * 60000) {
      const from = Math.max(window.start.getTime(), Number.isFinite(last) ? last + 30 * 60000 : 0)
      if (from < now.getTime()) {
        const started = startSleepEpisode(ledger, {
          kind: 'night', baseNeedMinutes: settings.minutes, targetMinutes: null,
          workloadScore, now, startedAt: new Date(from),
        })
        if (started.ok) return started.episode
      }
    }
  }

  if (settings.napEnabled && minutes >= NAP_START && minutes < NAP_END
    && napReady(profile, { localMinutes: minutes })) {
    const today = localDay(now)
    const already = ledger.episodes.some((episode) => episode.kind === 'nap'
      && localDay(new Date(episode.startedAt)) === today)
    if (!already && gap >= 20 * 60000) {
      const from = Math.max(now.getTime() - settings.napMinutes * 60000,
        Number.isFinite(last) ? last + 20 * 60000 : 0)
      if (from < now.getTime()) {
        const started = startSleepEpisode(ledger, {
          kind: 'nap', baseNeedMinutes: settings.napMinutes, targetMinutes: settings.napMinutes,
          workloadScore, now, startedAt: new Date(from),
        })
        if (started.ok) return started.episode
      }
    }
  }
  return null
}

export function settleSleep(dataDir, {
  now = new Date(), from = now, presenceMode = 'auto', presenceSince = '', presenceUntil = '',
  workloadScore = 0, openingDebt = 0, userMessage = false,
  autoSleep = true, lastUserAt = '', settings: settingsOverride = null,
} = {}) {
  const settings = settingsOverride ?? loadSleepSettings(dataDir)
  const start = from instanceof Date && Number.isFinite(from.getTime()) ? from : now
  const result = updateSleepLedger(dataDir, (ledger) => {
    let changed = false
    if (userMessage) {
      const active = ledger.episodes.find((episode) => episode.state === 'active')
      if (active && interruptSleepEpisode(ledger, active.id, { now, graceMinutes: 30, workloadScore }).ok) changed = true
    }

    const mode = presenceMode === 'sleep' || presenceMode === 'nap' ? presenceMode : ''
    if (mode) {
      // No explicit `since` (legacy presence) uses one stable marker so a
      // finished episode is not restarted on the next turn.
      const marker = stamp(presenceSince) === null
        ? (ledger.presenceStarted || start.toISOString())
        : new Date(stamp(presenceSince)).toISOString()
      if (!currentSleep(ledger) && ledger.presenceStarted !== marker) {
        const hour = now.getHours()
        // “睡了”默认按夜间睡眠；只有午休窗口的显式 sleep 才当小睡。
        const night = mode === 'sleep' && !(hour >= 11 && hour < 16)
        const kind = mode === 'nap' || !night ? 'nap' : 'night'
        const duration = kind === 'night' ? settings.minutes : settings.napMinutes
        const until = stamp(presenceUntil)
        const manualTarget = until !== null && until > now.getTime()
          ? Math.max(1, Math.ceil((until - Date.parse(marker)) / 60000)) : null
        const started = startSleepEpisode(ledger, {
          kind, baseNeedMinutes: duration,
          targetMinutes: manualTarget ?? (kind === 'night' ? null : duration),
          workloadScore, now, startedAt: marker,
        })
        if (started.ok) {
          ledger.presenceStarted = marker
          changed = true
        }
      } else if (currentSleep(ledger) && ledger.presenceStarted !== marker) {
        // A presence-driven episode was already started by presence.set;
        // remember the marker so finishing it does not start a fresh sleep.
        ledger.presenceStarted = marker
        changed = true
      }
    } else if (presenceMode !== 'auto' || ledger.presenceStarted) {
      // Auto sleep survives idle ticks; only an explicit wake or old manual marker ends it here.
      const current = currentSleep(ledger)
      if (current && finishSleepEpisode(ledger, current.id, { now }).ok) changed = true
      if (ledger.presenceStarted) {
        ledger.presenceStarted = ''
        changed = true
      }
    }

    if (autoSleep && !mode && !userMessage) {
      // Don't retroactively put her to sleep on the same turn the user speaks:
      // the reply would still be generated in an awake tone. The next idle
      // page/turn settles the readiness decision.
      if (autoStartSleep(ledger, { now, lastUserAt, workloadScore, settings })) changed = true
    }
    if (ensureAutoNights(ledger, { from: start, to: now, workloadScore, settings }).length) changed = true
    if (resumeDueSleep(ledger, { now, workloadScore }).length) changed = true
    if (finishDueSleep(ledger, { now, workloadScore }).length) changed = true
    return changed ? ledger : null
  }, { openingDebt })
  return result.ok ? result.ledger : null
}

// Minutes actually slept inside [from, to]. Used by the body integrator so a
// completed episode is credited once, while an awake gap gets no sleep credit.
export function sleepMinutesBetween(ledger, from, to) {
  const startMs = from instanceof Date ? from.getTime() : Date.parse(from)
  const endMs = to instanceof Date ? to.getTime() : Date.parse(to)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0
  let total = 0
  for (const episode of ledger?.episodes ?? []) {
    const started = stamp(episode.startedAt)
    if (started === null) continue
    const ended = episode.state === 'completed' ? stamp(episode.endedAt)
      : episode.state === 'active' ? endMs : stamp(episode.updatedAt)
    if (ended === null) continue
    const a = Math.max(startMs, started)
    const b = Math.min(endMs, ended)
    if (b <= a) continue
    total += Math.min((b - a) / 60000, actualSleepMinutes(episode, new Date(endMs)))
  }
  return Math.min((endMs - startMs) / 60000, total)
}

// Sleep episodes: the durable record behind body state.
//
// This is the JS port of companion_v2's role_work/life physiology + body_clock:
// sleep debt is settled from completed sleep receipts (not from awake time),
// sleep pressure is derived from awake minutes, and interruptions/oversleep are
// recorded on the episode instead of being inferred from a presence flag.
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { bedtimeForDate, localParts } from './sleep-settings.js'

const FILE = 'sleep-ledger.json'
const LOCK = 'sleep-ledger.lock'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 1
const MAX_EPISODES = 80
const NIGHT_BASE_MINUTES = 480
const QUALITY = 0.78
const STATES = new Set(['active', 'paused', 'completed'])
const KINDS = new Set(['night', 'nap', 'manual'])

const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value)))
const clean = (value) => String(value ?? '').trim()
const iso = (date) => date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : ''
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)

export function emptySleepLedger(openingDebt = 0) {
  return { version: VERSION, openingDebt: clamp(Number(openingDebt) || 0, 0, 720), presenceStarted: '', episodes: [] }
}

function normalizeEpisode(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = clean(raw.id)
  const started = stamp(raw.startedAt)
  const updated = stamp(raw.updatedAt)
  if (!id || started === null || updated === null) return null
  const state = STATES.has(raw.state) ? raw.state : null
  const kind = KINDS.has(raw.kind) ? raw.kind : 'manual'
  if (!state) return null
  return {
    id: id.slice(0, 120),
    kind,
    state,
    startedAt: new Date(started).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    endedAt: stamp(raw.endedAt) === null ? '' : new Date(stamp(raw.endedAt)).toISOString(),
    dueAt: stamp(raw.dueAt) === null ? '' : new Date(stamp(raw.dueAt)).toISOString(),
    baseNeedMinutes: clamp(Number(raw.baseNeedMinutes) || NIGHT_BASE_MINUTES, 1, 1440),
    targetMinutes: clamp(Number(raw.targetMinutes) || NIGHT_BASE_MINUTES, 1, 1440),
    sleptSeconds: Math.max(0, Number(raw.sleptSeconds) || 0),
    interruptions: Math.max(0, Math.min(20, Number(raw.interruptions) || 0)),
    earlyInterruptions: Math.max(0, Math.min(20, Number(raw.earlyInterruptions) || 0)),
    qualityMin: clamp(Number(raw.qualityMin) || 25, 1, 100),
    qualityMax: clamp(Number(raw.qualityMax) || 98, 1, 100),
    wakeUntil: stamp(raw.wakeUntil) === null ? '' : new Date(stamp(raw.wakeUntil)).toISOString(),
    oversleepMinutes: Math.max(0, Number(raw.oversleepMinutes) || 0),
    workloadScore: clamp(Number(raw.workloadScore) || 0, 0, 100),
  }
}

export function normalizeSleepLedger(raw) {
  const base = emptySleepLedger(raw?.openingDebt)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return base
  const episodes = (Array.isArray(raw.episodes) ? raw.episodes : [])
    .map(normalizeEpisode).filter(Boolean)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  const active = episodes.filter((episode) => episode.state !== 'completed')
  const completed = episodes.filter((episode) => episode.state === 'completed')
  const kept = [...active, ...completed.slice(-Math.max(0, MAX_EPISODES - active.length))]
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  return {
    ...base,
    presenceStarted: stamp(raw.presenceStarted) === null ? '' : new Date(stamp(raw.presenceStarted)).toISOString(),
    episodes: kept,
  }
}

export function loadSleepLedger(dataDir) {
  try {
    return normalizeSleepLedger(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')))
  } catch {
    return emptySleepLedger(0)
  }
}

function acquireLock(dataDir) {
  const path = join(dataDir, LOCK)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      mkdirSync(dataDir, { recursive: true })
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, JSON.stringify({ owner: LOCK_OWNER, at: Date.now() })) }
      catch (error) { try { closeSync(fd) } catch { /* ignore */ } try { unlinkSync(path) } catch { /* ignore */ } throw error }
      return { fd, path, ino: statSync(path).ino }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(path).mtimeMs > 5000) unlinkSync(path)
      } catch { /* another process just removed it */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch { /* ignore */ }
    }
  }
  return null
}

function releaseLock(lock) {
  if (!lock) return
  try { closeSync(lock.fd) } catch { /* ignore */ }
  try {
    if (statSync(lock.path).ino !== lock.ino) return
    const raw = JSON.parse(readFileSync(lock.path, 'utf8'))
    if (raw?.owner === LOCK_OWNER) unlinkSync(lock.path)
  } catch { /* not ours or already gone */ }
}

function saveSleepLedger(dataDir, ledger) {
  const path = join(dataDir, FILE)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}

// Read-modify-write under a cross-process lock; every lifecycle mutation goes
// through this so an interrupt and a scheduled wake cannot overwrite each other.
export function updateSleepLedger(dataDir, mutator, { openingDebt = 0 } = {}) {
  const lock = acquireLock(dataDir)
  if (!lock) return { ok: false, ledger: null }
  try {
    const current = loadSleepLedger(dataDir)
    const ledger = current.episodes.length || current.openingDebt > 0
      ? current
      : emptySleepLedger(openingDebt)
    const next = mutator(ledger)
    if (next === null) return { ok: true, ledger }
    if (!saveSleepLedger(dataDir, next)) return { ok: false, ledger: current }
    return { ok: true, ledger: next }
  } finally {
    releaseLock(lock)
  }
}

export function actualSleepMinutes(episode, now = new Date()) {
  const recorded = Math.max(0, Number(episode?.sleptSeconds) || 0) / 60
  if (episode?.state !== 'active') return recorded
  const updated = stamp(episode.updatedAt)
  if (updated === null) return recorded
  return recorded + Math.max(0, (now.getTime() - updated) / 60000)
}

export function sleepQualityRange(workloadScore, sleepDebtMinutes, interruptions = 0, earlyInterruptions = 0) {
  const workload = clamp(workloadScore, 0, 100)
  const debt = clamp(sleepDebtMinutes, 0, 720)
  const interruptionsValue = clamp(interruptions, 0, 20)
  const early = clamp(earlyInterruptions, 0, interruptionsValue)
  const penalty = workload * 0.18 + Math.min(20, debt * 0.025) + interruptionsValue * 7 + early * 5
  const lower = Math.max(25, Math.min(92, Math.round(82 - penalty)))
  const upper = Math.max(lower + 3, Math.min(98, Math.round(95 - workload * 0.10
    - Math.min(12, debt * 0.015) - interruptionsValue * 4 - early * 3)))
  return { min: lower, max: upper }
}

export function recommendedSleepMinutes(baseNeedMinutes = NIGHT_BASE_MINUTES, sleepDebtMinutes = 0, workloadScore = 0) {
  const base = clamp(baseNeedMinutes, 1, 1440)
  const recovery = Math.min(120, Math.round(Math.max(0, sleepDebtMinutes) * 0.45))
  const workload = workloadScore >= 80 ? 30 : workloadScore >= 55 ? 15 : 0
  return Math.min(1440, base + recovery + workload)
}

function nightWindows(from, to, startMinutes = 23 * 60 + 30, endMinutes = 7 * 60 + 30) {
  if (!(to > from)) return []
  const startHour = Math.floor(startMinutes / 60) % 24
  const startMinute = startMinutes % 60
  const endHour = Math.floor(endMinutes / 60) % 24
  const endMinute = endMinutes % 60
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0)
  day.setDate(day.getDate() - 1)
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 0, 0, 0, 0)
  const starts = []
  for (let cursor = new Date(day); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
    starts.push(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), startHour, startMinute, 0, 0))
  }
  const windows = []
  for (const start of starts) {
    const end = new Date(start)
    end.setHours(endHour, endMinute, 0, 0)
    if (endMinutes <= startMinutes) end.setDate(end.getDate() + 1)
    const a = Math.max(from.getTime(), start.getTime())
    const b = Math.min(to.getTime(), end.getTime())
    if (b > a) windows.push({ start, end, from: new Date(a), to: new Date(b), minutes: (b - a) / 60000 })
  }
  return windows
}

// Settings-aware nights: the per-day bedtime already carries the configured
// timezone and jitter, so the ledger and the runtime cannot disagree about when
// last night started.
function configuredNightWindows(from, to, settings) {
  if (!(to > from)) return []
  const first = localParts(from, settings.timezone)
  const last = localParts(to, settings.timezone)
  const dayStart = Date.UTC(first.year, first.month - 1, first.day) - 86400000
  const dayEnd = Date.UTC(last.year, last.month - 1, last.day) + 86400000
  const windows = []
  for (let time = dayStart; time <= dayEnd; time += 86400000) {
    const day = new Date(time)
    const start = bedtimeForDate({
      year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(),
      hour: 12, minute: 0,
    }, settings)
    const end = new Date(start.getTime() + settings.minutes * 60000)
    const a = Math.max(from.getTime(), start.getTime())
    const b = Math.min(to.getTime(), end.getTime())
    if (b > a) windows.push({ start, end, from: new Date(a), to: new Date(b), minutes: (b - a) / 60000 })
  }
  return windows
}

// A night with no explicit sleep episode is materialized as a completed night
// receipt once that night is over. This is the automatic bedtime the original
// role body clock owns, without requiring a timer to fire mid-sleep.
export function ensureAutoNights(ledger, {
  from, to = new Date(), workloadScore = 0, settings = null,
  sleepStartMinutes = 23 * 60 + 30, sleepEndMinutes = 7 * 60 + 30,
} = {}) {
  const start = from instanceof Date ? from : new Date(from)
  const end = to instanceof Date ? to : new Date(to)
  if (!(end > start)) return []
  const created = []
  const windows = settings
    ? configuredNightWindows(start, end, settings)
    : nightWindows(start, end, sleepStartMinutes, sleepEndMinutes)
  for (const window of windows) {
    // Only settle nights that have already ended; an in-progress night is not
    // assumed to be sleep just because the user has not messaged yet.
    if (window.end.getTime() > end.getTime()) continue
    if (window.minutes < 30) continue
    const overlaps = ledger.episodes.some((episode) => {
      const started = stamp(episode.startedAt)
      const finished = episode.state === 'completed' ? stamp(episode.endedAt) : end.getTime()
      return started !== null && finished !== null
        && finished > window.start.getTime() && started < window.end.getTime()
    })
    if (overlaps) continue
    const debt = sleepProfile(ledger, { now: window.end, workloadScore }).sleepDebtMinutes
    const quality = sleepQualityRange(workloadScore, debt)
    const sleptMinutes = window.minutes
    const episode = {
      id: `auto-${window.start.toISOString().slice(0, 10)}`,
      kind: 'night',
      state: 'completed',
      startedAt: window.from.toISOString(),
      updatedAt: window.to.toISOString(),
      endedAt: window.to.toISOString(),
      dueAt: '',
      baseNeedMinutes: settings ? settings.minutes : NIGHT_BASE_MINUTES,
      targetMinutes: settings ? settings.minutes : NIGHT_BASE_MINUTES,
      sleptSeconds: Math.round(sleptMinutes * 60),
      interruptions: 0,
      earlyInterruptions: 0,
      qualityMin: quality.min,
      qualityMax: quality.max,
      wakeUntil: '',
      oversleepMinutes: 0,
      workloadScore: clamp(workloadScore, 0, 100),
      auto: true,
    }
    ledger.episodes.push(episode)
    created.push(episode)
  }
  if (ledger.episodes.length > MAX_EPISODES) {
    const active = ledger.episodes.filter((episode) => episode.state !== 'completed')
    const completed = ledger.episodes.filter((episode) => episode.state === 'completed')
    ledger.episodes = [...active, ...completed.slice(-Math.max(0, MAX_EPISODES - active.length))]
  }
  return created
}

export function sleepProfile(ledger, { now = new Date(), workloadScore = 0 } = {}) {
  const value = normalizeSleepLedger(ledger)
  let debt = clamp(value.openingDebt, 0, 720)
  const completed = value.episodes.filter((episode) => episode.state === 'completed')
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  for (const episode of completed) {
    const slept = actualSleepMinutes(episode, now)
    const quality = ((episode.qualityMin + episode.qualityMax) / 200) || QUALITY
    if (episode.kind === 'nap') {
      debt = Math.max(0, debt - slept * quality * 0.12)
    } else {
      debt += Math.max(0, episode.baseNeedMinutes - slept)
      debt = Math.max(0, debt - Math.min(debt, Math.max(0, slept - episode.baseNeedMinutes) * quality * 0.75))
    }
    debt = Math.min(720, debt)
  }
  const latest = value.episodes.filter((episode) => episode.state === 'active').at(-1)
    ?? value.episodes.filter((episode) => episode.state === 'paused').at(-1)
    ?? value.episodes.at(-1) ?? null
  let awakeMinutes = null
  let pressure = null
  if (latest) {
    if (latest.state === 'active') {
      awakeMinutes = 0
      pressure = 0
    } else {
      const ended = stamp(latest.updatedAt)
      awakeMinutes = ended === null ? null : Math.max(0, Math.round((now.getTime() - ended) / 60000))
      pressure = awakeMinutes === null ? null
        : Math.min(100, Math.round(awakeMinutes / 60 * 4 + debt * 0.14 + clamp(workloadScore, 0, 100) * 0.12))
    }
  }
  return {
    sleepDebtMinutes: Math.round(debt),
    sleepPressure: pressure,
    awakeMinutes,
    workloadScore: clamp(workloadScore, 0, 100),
    hasSleepHistory: Boolean(latest),
    latest,
  }
}

export function nightSleepReady(profile) {
  if (profile?.sleepPressure === null || profile?.sleepPressure === undefined) return true
  const threshold = Math.max(48, 66 - (profile.workloadScore ?? 0) * 0.12
    - (profile.sleepDebtMinutes ?? 0) * 0.035)
  return profile.sleepPressure >= threshold
}

export function napReady(profile, { localMinutes } = {}) {
  const hour = Number(localMinutes)
  return Boolean(profile?.hasSleepHistory
    && profile.awakeMinutes !== null && profile.awakeMinutes >= 300
    && Number.isFinite(hour) && hour >= 660 && hour < 960
    && profile.sleepPressure !== null && profile.sleepPressure >= 40
    && ((profile.workloadScore ?? 0) >= 40 || (profile.sleepDebtMinutes ?? 0) >= 90))
}

export function currentSleep(ledger) {
  return ledger.episodes.find((episode) => episode.state === 'active' || episode.state === 'paused') ?? null
}

export function startSleepEpisode(ledger, {
  kind = 'manual', baseNeedMinutes = NIGHT_BASE_MINUTES, targetMinutes = null,
  workloadScore = 0, now = new Date(), startedAt = null, id = '',
} = {}) {
  if (currentSleep(ledger)) return { ok: false, reject: '已经有一段睡眠在进行中' }
  const selectedKind = KINDS.has(kind) ? kind : 'manual'
  const base = clamp(baseNeedMinutes, 1, 1440)
  const startMs = stamp(startedAt)
  const start = startMs === null ? now : new Date(Math.min(now.getTime(), startMs))
  const profile = sleepProfile(ledger, { now, workloadScore })
  const target = clamp(targetMinutes ?? recommendedSleepMinutes(base, profile.sleepDebtMinutes, workloadScore), 1, 1440)
  const quality = sleepQualityRange(workloadScore, profile.sleepDebtMinutes)
  const episode = {
    id: clean(id) || `sleep-${digest(`${start.toISOString()}:${selectedKind}:${ledger.episodes.length}`)}`,
    kind: selectedKind,
    state: 'active',
    startedAt: start.toISOString(),
    updatedAt: start.toISOString(),
    endedAt: '',
    dueAt: new Date(start.getTime() + target * 60000).toISOString(),
    baseNeedMinutes: base,
    targetMinutes: target,
    sleptSeconds: 0,
    interruptions: 0,
    earlyInterruptions: 0,
    qualityMin: quality.min,
    qualityMax: quality.max,
    wakeUntil: '',
    oversleepMinutes: 0,
    workloadScore: clamp(workloadScore, 0, 100),
  }
  ledger.episodes = [...ledger.episodes, episode].slice(-MAX_EPISODES)
  return { ok: true, episode }
}

export function interruptSleepEpisode(ledger, id, { now = new Date(), graceMinutes = 30, workloadScore = 0 } = {}) {
  const episode = ledger.episodes.find((item) => item.id === id)
  if (!episode || episode.state !== 'active') return { ok: false, reject: '没有正在进行的睡眠' }
  const segmentSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(episode.updatedAt)) / 1000))
  const early = segmentSeconds < 20 * 60
  const sleptSeconds = episode.sleptSeconds + segmentSeconds
  const interruptions = episode.interruptions + 1
  const earlyInterruptions = episode.earlyInterruptions + (early ? 1 : 0)
  const debt = sleepProfile(ledger, { now, workloadScore }).sleepDebtMinutes
  const quality = sleepQualityRange(episode.workloadScore || workloadScore, debt, interruptions, earlyInterruptions)
  Object.assign(episode, {
    state: 'paused',
    updatedAt: now.toISOString(),
    sleptSeconds,
    interruptions,
    earlyInterruptions,
    qualityMin: quality.min,
    qualityMax: quality.max,
    wakeUntil: new Date(now.getTime() + Math.max(0, graceMinutes) * 60000).toISOString(),
  })
  return { ok: true, episode }
}

export function resumeDueSleep(ledger, { now = new Date(), workloadScore = 0 } = {}) {
  const resumed = []
  for (const episode of ledger.episodes) {
    if (episode.state !== 'paused' || !episode.wakeUntil || Date.parse(episode.wakeUntil) > now.getTime()) continue
    const remaining = Math.max(0, Math.round(episode.targetMinutes * 60 - episode.sleptSeconds))
    if (remaining <= 0) {
      episode.state = 'completed'
      episode.endedAt = now.toISOString()
      episode.updatedAt = now.toISOString()
      episode.wakeUntil = ''
    } else {
      episode.state = 'active'
      episode.updatedAt = now.toISOString()
      episode.dueAt = new Date(now.getTime() + remaining * 1000).toISOString()
      episode.wakeUntil = ''
    }
    resumed.push(episode)
  }
  return resumed
}

function completeEpisode(episode, now) {
  const segmentSeconds = episode.state === 'active'
    ? Math.max(0, Math.round((now.getTime() - Date.parse(episode.updatedAt)) / 1000)) : 0
  episode.sleptSeconds += segmentSeconds
  episode.state = 'completed'
  episode.endedAt = now.toISOString()
  episode.updatedAt = now.toISOString()
  episode.wakeUntil = ''
}

export function finishSleepEpisode(ledger, id, { now = new Date() } = {}) {
  const episode = ledger.episodes.find((item) => item.id === id)
  if (!episode || (episode.state !== 'active' && episode.state !== 'paused')) {
    return { ok: false, reject: '没有可结束的睡眠' }
  }
  const sleptMinutes = actualSleepMinutes(episode, now)
  completeEpisode(episode, now)
  // 点一下“睡了”又马上切回“自动”不该记成一夜短睡：不足半小时的
  // 手动/夜间打盹按午睡结算，不拿 8 小时基础需求去加一整夜债。
  if (sleptMinutes < 30 && episode.kind !== 'nap') {
    episode.kind = 'nap'
    episode.baseNeedMinutes = Math.max(1, Math.round(sleptMinutes))
    episode.targetMinutes = Math.max(1, Math.round(sleptMinutes))
  }
  return { ok: true, episode }
}

export function oversleepExtension(episode, { sleepDebtMinutes = 0, roll = null } = {}) {
  if (!episode || episode.kind === 'nap' || episode.oversleepMinutes
    || (episode.kind === 'manual' && episode.targetMinutes <= 60)) return 0
  const chance = Math.min(70, 8 + Math.min(30, Math.floor(sleepDebtMinutes / 10))
    + Math.floor((episode.workloadScore ?? 0) / 4) + episode.interruptions * 8)
  const value = roll === null || roll === undefined
    ? parseInt(digest(`${episode.id}:oversleep`).slice(0, 8), 16) % 100
    : Number(roll)
  if (!(value < chance)) return 0
  return chance >= 45 ? 30 : 15
}

export function finishDueSleep(ledger, { now = new Date(), workloadScore = 0 } = {}) {
  const finished = []
  for (const episode of ledger.episodes) {
    if (episode.state !== 'active' || !episode.dueAt || Date.parse(episode.dueAt) > now.getTime()) continue
    const debt = sleepProfile(ledger, { now, workloadScore }).sleepDebtMinutes
    const extension = oversleepExtension(episode, { sleepDebtMinutes: debt })
    const segmentSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(episode.updatedAt)) / 1000))
    episode.sleptSeconds += segmentSeconds
    episode.updatedAt = now.toISOString()
    if (extension) {
      episode.oversleepMinutes += extension
      episode.dueAt = new Date(now.getTime() + extension * 60000).toISOString()
    } else {
      episode.state = 'completed'
      episode.endedAt = now.toISOString()
      episode.dueAt = ''
    }
    finished.push(episode)
  }
  return finished
}

export { NIGHT_BASE_MINUTES }

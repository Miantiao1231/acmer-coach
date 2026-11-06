// 身体状态：精力、疲劳、睡眠债、四轴心情。
// 睡眠债/压力来自 sleep-ledger 的睡眠记录；精力/疲劳只按实际睡/醒时长推进。
import { sleepProfile } from './sleep-ledger.js'
import { sleepMinutesBetween } from './sleep-runtime.js'

const DEFAULT_BASELINE = 6
const AXES = ['joy', 'anger', 'sorrow', 'fear']
const NIGHT_START = 23 * 60 + 30
const NIGHT_END = 7 * 60 + 30
const NAP_START = 13 * 60
const NAP_END = 13 * 60 + 30
// 一夜的基础睡眠需求。8 小时睡眠会还 1 小时债；短睡加债，睡过头按 0.75 还。
const NIGHT_BASE_MINUTES = 7 * 60
const MIN_SLEEP_GAP = 30
const MIN_NAP_GAP = 20
const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value)))
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const axis = (value) => clamp(finite(value, 1), 1, 10)

export function emptyBody(now = new Date()) {
  return {
    energy: 70,
    fatigue: 20,
    sleepDebt: 60,
    sleepPressure: null,
    awakeMinutes: null,
    joy: 6,
    anger: 1,
    sorrow: 1,
    fear: 1,
    baseline: DEFAULT_BASELINE,
    updatedAt: now.toISOString(),
    energyCheckedAt: '',
    lastCheck: '',
    lastSleepAt: '',
    lastGapAt: '',
  }
}

export function normalizeBody(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyBody(now)
  return {
    energy: clamp(finite(raw.energy, 70), 0, 100),
    fatigue: clamp(finite(raw.fatigue, 20), 0, 100),
    sleepDebt: clamp(finite(raw.sleepDebt, 60), 0, 720),
    sleepPressure: raw.sleepPressure === null || raw.sleepPressure === undefined
      ? null : clamp(finite(raw.sleepPressure, 0), 0, 100),
    awakeMinutes: raw.awakeMinutes === null || raw.awakeMinutes === undefined
      ? null : Math.max(0, Math.round(finite(raw.awakeMinutes, 0))),
    joy: axis(raw.joy),
    anger: axis(raw.anger),
    sorrow: axis(raw.sorrow),
    fear: axis(raw.fear),
    baseline: clamp(finite(raw.baseline, DEFAULT_BASELINE), 1, 10),
    updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : now.toISOString(),
    energyCheckedAt: typeof raw.energyCheckedAt === 'string' && Number.isFinite(Date.parse(raw.energyCheckedAt)) ? raw.energyCheckedAt : '',
    lastCheck: typeof raw.lastCheck === 'string' ? raw.lastCheck : '',
    lastSleepAt: typeof raw.lastSleepAt === 'string' ? raw.lastSleepAt : '',
    lastGapAt: typeof raw.lastGapAt === 'string' ? raw.lastGapAt : '',
  }
}

function atMinute(date, minutes) {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
  value.setMinutes(minutes)
  return value
}

// 统计 [from, to] 与每天 sleepStart–sleepEnd 窗口的重叠分钟数。
// sleepStart > sleepEnd 表示跨午夜（夜间），循环要从 from 的前一天开始。
function windowMinutes(from, to, sleepStart, sleepEnd) {
  if (!(to > from)) return 0
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0)
  if (sleepStart > sleepEnd) day.setDate(day.getDate() - 1)
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 0, 0, 0, 0)
  let total = 0
  for (let cursor = new Date(day); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
    const start = atMinute(cursor, sleepStart)
    const end = atMinute(cursor, sleepEnd)
    if (sleepStart > sleepEnd) end.setDate(end.getDate() + 1)
    const a = Math.max(from.getTime(), start.getTime())
    const b = Math.min(to.getTime(), end.getTime())
    if (b > a) total += (b - a) / 60000
  }
  return total
}

function latestCheck(progress) {
  let best = null
  for (const [node, record] of Object.entries(progress?.nodes ?? {})) {
    for (const check of Array.isArray(record?.checks) ? record.checks : []) {
      if ((check?.outcome === 'passed' || check?.outcome === 'failed') && check?.date) {
        if (!best || String(check.date) > String(best.date)) best = { ...check, node }
      }
    }
  }
  return best
}

export function advanceBody(input, {
  now = new Date(), lastUserAt = '', progress = null, presence = null,
  presenceExplicit = null, presenceSince = '', presenceUntil = '',
  sleepLedger = null, workloadScore = 0,
} = {}) {
  const body = normalizeBody(input, now)
  const previous = new Date(body.updatedAt)
  const elapsedMinutes = clamp((now - previous) / 60000, 0, 2880)

  if (sleepLedger) {
    // Ledger path: sleep debt/pressure are the profile's; energy/fatigue only
    // integrate the minutes actually spent asleep vs awake in this interval.
    const profile = sleepProfile(sleepLedger, { now, workloadScore })
    const sleepMinutes = sleepMinutesBetween(sleepLedger, previous, now)
    const awakeMinutes = Math.max(0, elapsedMinutes - sleepMinutes)
    body.energy += 12 * (sleepMinutes / 60) - 2.5 * (awakeMinutes / 60)
    body.fatigue += -15 * (sleepMinutes / 60) + 3 * (awakeMinutes / 60)
    body.sleepDebt = profile.sleepDebtMinutes
    body.sleepPressure = profile.sleepPressure
    body.awakeMinutes = profile.awakeMinutes
    if (profile.latest?.state === 'completed' && profile.latest.endedAt) {
      body.lastSleepAt = profile.latest.endedAt
    }
  } else {
    const mode = presence?.mode ?? 'normal'
    // Fallback for callers without a sleep ledger (old data/tests): explicit
    // sleep/nap starts at `since` and is capped; auto uses window overlap.
    const explicit = presenceExplicit === null
      ? mode === 'sleep' || mode === 'nap'
      : Boolean(presenceExplicit)
    const sinceMs = Date.parse(presenceSince)
    const untilMs = Date.parse(presenceUntil)
    const explicitStart = Math.max(previous.getTime(), Number.isFinite(sinceMs) ? sinceMs : previous.getTime())
    const explicitEnd = Number.isFinite(untilMs) ? Math.min(now.getTime(), untilMs) : now.getTime()
    const explicitMinutes = explicit ? Math.max(0, (explicitEnd - explicitStart) / 60000) : 0
    const explicitCap = mode === 'nap' ? 120 : 600
    const explicitSleep = Math.min(explicitMinutes, explicitCap)
    const nightOverlap = windowMinutes(previous, now, NIGHT_START, NIGHT_END)
    const napOverlap = windowMinutes(previous, now, NAP_START, NAP_END)
    let nightSleep = 0
    let napSleep = 0
    if (explicit && mode === 'sleep') nightSleep = Math.min(elapsedMinutes, explicitSleep)
    else if (explicit && mode === 'nap') napSleep = Math.min(elapsedMinutes, explicitSleep)
    else {
      // 至少安静 30 分钟才算一段睡眠；连续发消息的短间隔不会刷恢复。
      if (elapsedMinutes >= MIN_SLEEP_GAP) nightSleep = nightOverlap
      if (nightOverlap === 0 && elapsedMinutes >= MIN_NAP_GAP) napSleep = napOverlap
    }
    nightSleep = Math.min(nightSleep, elapsedMinutes)
    napSleep = Math.min(napSleep, Math.max(0, elapsedMinutes - nightSleep))
    const awakeMinutes = Math.max(0, elapsedMinutes - nightSleep - napSleep)

    body.energy += 12 * (nightSleep / 60) + 16 * (napSleep / 60) - 2.5 * (awakeMinutes / 60)
    body.fatigue += -15 * (nightSleep / 60) - 10 * (napSleep / 60) + 3 * (awakeMinutes / 60)

    if (nightSleep > 0) {
      const nights = Math.max(1, Math.round(nightOverlap / NIGHT_BASE_MINUTES))
      const base = explicit
        ? (nightSleep >= 240 ? NIGHT_BASE_MINUTES : nightSleep)
        : nights === 1
          ? (nightOverlap >= 240 ? NIGHT_BASE_MINUTES : nightOverlap)
          : NIGHT_BASE_MINUTES * nights
      body.sleepDebt += Math.max(0, base - nightSleep)
      body.sleepDebt -= Math.min(body.sleepDebt, Math.max(0, nightSleep - base) * 0.75)
      body.lastSleepAt = now.toISOString()
    }
    if (napSleep > 0) body.sleepDebt -= napSleep * 0.12
  }

  const last = lastUserAt ? new Date(lastUserAt) : null
  const gapHours = last && Number.isFinite(last.getTime()) ? (now - last) / 3600000 : 0
  const lastIso = last && Number.isFinite(last.getTime()) ? last.toISOString() : ''
  // 情绪先按半衰期回稳：开心回基线，烦躁/难过/不安回 1。
  const decay = 1 - 0.5 ** (elapsedMinutes / 90)
  body.joy += (body.baseline - body.joy) * decay
  for (const key of ['anger', 'sorrow', 'fear']) body[key] += (1 - body[key]) * decay

  const check = latestCheck(progress)
  if (check) {
    const key = `${check.node}:${check.date}:${check.outcome}`
    if (body.lastCheck !== key) {
      if (check.outcome === 'passed') { body.joy += 2; body.energy += 1 }
      else { body.sorrow += 2; body.fatigue += 2 }
      body.lastCheck = key
    }
  }
  if (lastIso && body.lastGapAt !== lastIso) {
    if (gapHours >= 72) body.joy += 1
    else if (gapHours >= 12) body.joy += 0.3
    if (gapHours >= 12) body.lastGapAt = lastIso
  }

  body.energy = clamp(body.energy, 0, 100)
  body.fatigue = clamp(body.fatigue, 0, 100)
  body.sleepDebt = clamp(body.sleepDebt, 0, 720)
  for (const key of AXES) body[key] = clamp(body[key], 1, 10)
  body.updatedAt = now.toISOString()
  return body
}

export function bodyLines(body) {
  const energy = clamp(body?.energy ?? 70, 0, 100)
  const fatigue = clamp(body?.fatigue ?? 20, 0, 100)
  const debt = clamp(body?.sleepDebt ?? 60, 0, 720)
  const energyWord = energy >= 75 ? '精神很好' : energy >= 50 ? '还行' : energy >= 30 ? '有点累' : '很累'
  const fatigueWord = fatigue >= 60 ? '困得厉害' : fatigue >= 30 ? '有点困' : ''
  const debtWord = debt >= 120 ? '睡眠债不轻' : debt >= 60 ? '睡得不太够' : ''
  const joy = body?.joy ?? 1
  const anger = body?.anger ?? 1
  const sorrow = body?.sorrow ?? 1
  const fear = body?.fear ?? 1
  const moodWord = joy >= 7 ? '开心'
    : anger >= 5 && anger >= sorrow && anger >= fear ? '有点气'
      : sorrow >= 5 && sorrow >= fear ? '有点低落'
        : fear >= 5 ? '有点不安' : '平静'
  const bits = [`精力 ${Math.round(energy)}/100（${energyWord}）`]
  if (fatigueWord) bits.push(fatigueWord)
  if (Number.isFinite(body?.sleepPressure)) bits.push(`睡眠压力 ${Math.round(body.sleepPressure)}/100`)
  if (debtWord) bits.push(debtWord)
  return [`- 身体：${bits.join('，')}；心情：${moodWord}。`]
}

// 社交情绪：被夸、被逗、被道歉、深夜还在——只动四轴，不写事实、不改判断。
// 每次只看当前这一条用户消息；重复历史不会反复加分。
export function applySocialEmotion(body, text, now = new Date()) {
  const value = String(text ?? '')
  const hour = now.getHours()
  if (/厉害|可爱|喜欢你|乖|棒|谢谢/.test(value)) body.joy += 1
  if (/笨蛋|坏|讨厌|哼/.test(value)) { body.anger += 0.8; body.joy += 0.2 }
  if (/对不起|我错了|抱歉/.test(value)) { body.anger -= 2; body.sorrow -= 1 }
  if (hour >= 1 && hour < 5) { body.fear += 0.5; body.sorrow += 0.25 }
  body.joy = clamp(body.joy, 1, 10)
  for (const key of AXES) body[key] = clamp(body[key], 1, 10)
  return body
}

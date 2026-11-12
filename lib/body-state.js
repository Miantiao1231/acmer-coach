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
  sleepLedger = null, workloadScore = 0, userText = '',
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

  // 社交情绪只在对话 turn 传 userText 时结算（页面读取、睡眠推进不传）。
  // 放在按时间回稳之后：先让旧情绪衰减，再叠加这一轮消息带来的真实起伏。
  if (String(userText ?? '').trim()) applySocialEmotion(body, userText, now)

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
  // 阈值取 3 而不是 5：负面轴刚起来一点就该在语气里有反应，
  // 不然数值已经明显偏离 1、注入的心情词还是「平静」，语气跟不上。
  const moodWord = joy >= 7 ? '开心'
    : anger >= 3 && anger >= sorrow && anger >= fear ? '有点气'
      : sorrow >= 3 && sorrow >= fear ? '有点低落'
        : fear >= 3 ? '有点不安' : '平静'
  const bits = [`精力 ${Math.round(energy)}/100（${energyWord}）`]
  if (fatigueWord) bits.push(fatigueWord)
  if (Number.isFinite(body?.sleepPressure)) bits.push(`睡眠压力 ${Math.round(body.sleepPressure)}/100`)
  if (debtWord) bits.push(debtWord)
  return [`- 身体：${bits.join('，')}；心情：${moodWord}。`]
}

// 社交情绪：被夸、被逗、被道歉、他累了/烦了/难过、深夜还醒着——只动四轴，
// 不写事实、不改判断、不碰工具参数。每次只看当前这一条用户消息；重复历史不会反复加分。
export function applySocialEmotion(body, text, now = new Date()) {
  const value = String(text ?? '')
  const hour = now.getHours()
  // 他来哄她/说没事了：先记下来，别把“别难过”读成又一句负面。
  const comforting = /别担心|没事了|别怕|好多了|不难过|抱抱|摸摸|哄你/.test(value)
  // 被夸、被感谢、被喜欢：开心。
  if (/厉害|可爱|喜欢你|爱你|乖|棒|谢谢|多谢|辛苦|靠谱/.test(value)) body.joy += 1.2
  // 被逗、被凶：先有点气；真生气还是打闹看上下文，这里只让数值有起伏。
  if (/笨蛋|讨厌|坏蛋|哼|闭嘴|别烦|凶什么|凶我/.test(value)) { body.anger += 0.9; body.joy += 0.2 }
  // 他在认错/哄人：气消一些，低落和不安也轻一些。
  if (/对不起|我错了|抱歉|不好意思|不该凶|不是故意/.test(value)) { body.anger -= 2; body.sorrow -= 1; body.fear -= 0.5 }
  if (!comforting) {
    // 他累、烦、难过、害怕：她跟着揪心——这是关心，不是替他记训练事实。
    if (/好累|很累|太累|累了|累死|疲惫|撑不住|没力气|熬不住/.test(value)) { body.sorrow += 0.8; body.fear += 0.2 }
    if (/(好|很|真|太|有点|特别|最近)烦|烦死|烦人|烦躁|不爽|气死|郁闷|烦不烦/.test(value)) { body.anger += 0.7; body.sorrow += 0.3 }
    if (/(?<!不)难过|伤心|想哭|哭了|低落|emo|沮丧|破防|崩溃|难受/.test(value)) { body.sorrow += 1; body.fear += 0.2 }
    if (/害怕|担心|紧张|焦虑|好慌|不安/.test(value)) body.fear += 1
  }
  // 他来哄她/说没事了：不安和低落往下走。
  if (comforting) { body.fear -= 1; body.sorrow -= 0.8 }
  // 深夜还醒着：夜深了，有点不安和低落。
  if (hour >= 1 && hour < 5) { body.fear += 0.5; body.sorrow += 0.25 }
  body.joy = clamp(body.joy, 1, 10)
  for (const key of AXES) body[key] = clamp(body[key], 1, 10)
  return body
}

// 睡眠只有 sleep-ledger 一个来源：active/paused 是账本里的真实睡眠，
// 「刚醒」只限最近 20 分钟，避免把几小时前的一觉说成当下状态。
export function sleepStateNote(sleepLedger, now = new Date()) {
  const episodes = Array.isArray(sleepLedger?.episodes) ? sleepLedger.episodes : []
  const active = episodes.filter((episode) => episode?.state === 'active' || episode?.state === 'paused').at(-1) ?? null
  if (active) {
    if (active.state === 'paused') return active.kind === 'nap' ? '午睡刚被叫醒，还有点迷糊' : '夜里睡到一半被叫醒，还困着'
    return active.kind === 'nap' ? '正在午休' : '正在睡'
  }
  const latest = episodes
    .filter((episode) => episode?.state === 'completed' && Number.isFinite(Date.parse(String(episode.endedAt ?? ''))))
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt)).at(-1) ?? null
  if (!latest) return ''
  const minutes = Math.floor((now.getTime() - Date.parse(latest.endedAt)) / 60000)
  if (!(minutes >= 0 && minutes <= 20)) return ''
  return latest.kind === 'nap' ? '刚午休醒来' : '刚睡醒'
}

// 对话接话用的状态行：身体/心情（四轴）+ 作息与生活状态。
// 心情只由四轴给一次，不再单列 roleState.mood，避免同一个状态被说出两种心情；
// 睡眠只采 ledger，不采 roleState 的描述。这些只影响语气和关注点，不改判断。
export function stateToneLines(body, { roleState = null, sleepLedger = null, now = new Date() } = {}) {
  const lines = [...bodyLines(body)]
  const role = roleState && typeof roleState === 'object' ? roleState : {}
  const bits = []
  const sleepiness = finite(role.sleepiness, 0)
  if (sleepiness >= 65) bits.push('很困')
  else if (sleepiness >= 40) bits.push('有点困')
  if (finite(role.hunger, 0) >= 65) bits.push('有点饿')
  if (finite(role.health, 100) <= 45) bits.push('身体不太舒服')
  if (role.busy === true) bits.push('手头正忙')
  const sleepNote = sleepStateNote(sleepLedger, now)
  if (sleepNote) bits.push(sleepNote)
  const location = String(role.location ?? '').replace(/\s+/g, ' ').trim()
  if (location) bits.push(`在${location.replace(/^在/, '')}`)
  if (bits.length) lines.push(`- 生活：${bits.join('，')}。`)
  return lines
}


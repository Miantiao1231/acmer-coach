// 主动开口的候选来源：只从教练真实数据里挑，不编天气/饭点/健康。
// 每个候选都带 purpose、证据和分数；worker 只负责选一条。
const clean = (value) => String(value ?? '').trim()
const pad = (n) => String(n).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const daysBetween = (from, to) => {
  const date = new Date(`${from}T12:00:00`)
  if (Number.isNaN(date.getTime())) return null
  const today = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 12)
  return Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)) / 86400000)
}
const nextAnniversary = (dateStr, now) => {
  const date = new Date(`${dateStr}T12:00:00`)
  if (Number.isNaN(date.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const thisYear = new Date(now.getFullYear(), date.getMonth(), date.getDate(), 12)
  const next = thisYear < today ? new Date(now.getFullYear() + 1, date.getMonth(), date.getDate(), 12) : thisYear
  return Math.round((next - today) / 86400000)
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
const add = (list, item) => {
  if (!item?.topic || !item?.reason) return
  list.push({
    id: `${item.kind}:${clean(item.topic).slice(0, 60)}`,
    kind: item.kind,
    purpose: item.purpose || item.kind,
    topic: clean(item.topic).slice(0, 200),
    reason: clean(item.reason).slice(0, 160),
    score: Math.max(1, Math.min(100, Math.round(Number(item.score) || 50))),
    evidence: clean(item.evidence).slice(0, 500),
    soft: item.soft === true,
    cooldownMinutes: Number.isFinite(Number(item.cooldownMinutes))
      ? Math.max(0, Math.min(10080, Math.round(Number(item.cooldownMinutes)))) : 0,
  })
}

function mealWindow(now) {
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60 + 15) return { key: 'lunch', label: '午饭' }
  if (minutes >= 17 * 60 + 30 && minutes < 19 * 60 + 15) return { key: 'dinner', label: '晚饭' }
  return null
}

export function buildSources({ person, progress, target, classWindow, lastUserAt, life, journal, vp, external, screen, now = new Date() } = {}) {
  const candidates = []
  if (target?.date) {
    const days = Math.round((new Date(`${target.date}T12:00:00`) - new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)) / 86400000)
    if (days >= 0 && days <= 14) add(candidates, { kind: 'target', purpose: 'care', score: 95, topic: `${target.contest || '比赛'}还有 ${days} 天`, reason: '比赛临期', evidence: `TARGET：${target.contest || '比赛'}，${target.date}` })
  }
  // 外部话题：天气/新闻来自有出处的接口；饭点/屏幕时间是本地现算。
  const weather = external?.weather
  if (weather?.text) {
    const temp = Number.isFinite(weather.temperature) ? `${weather.temperature}°C` : ''
    const rain = weather.rainSoon ? '，可能会下雨/下雪' : ''
    const change = weather.change === 'condition' ? '，天气刚刚变了' : weather.change === 'temperature' ? '，温度变化挺大' : ''
    add(candidates, {
      kind: 'weather', purpose: 'care',
      score: weather.change || weather.rainSoon ? 74 : 46,
      topic: `外面${weather.text}${temp ? `，${temp}` : ''}`,
      reason: weather.change || weather.rainSoon ? '天气变化' : '她看到的天气',
      evidence: `天气：${weather.city || '你那边'} · ${weather.text} · ${temp}${rain}${change}（${weather.provider || '天气源'}，${weather.at || ''}）`,
      cooldownMinutes: 180,
    })
  }
  const news = external?.news
  if (news?.title) {
    add(candidates, {
      kind: 'news', purpose: 'life', score: 48,
      topic: `看到一条新闻：${news.title.slice(0, 60)}`,
      reason: '她刚看到的',
      evidence: `新闻：${news.sourceLabel || news.source} · ${news.title} · ${news.url}（${news.at || ''}）`,
      cooldownMinutes: 720,
    })
  }
  const meal = mealWindow(now)
  if (meal) {
    add(candidates, {
      kind: 'meal', purpose: 'life', score: 52,
      topic: `这个点她也在吃${meal.label}`,
      reason: '她自己的生活',
      evidence: `本地时间 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}；这是她自己的${meal.label}，不是查他的三餐。`,
      cooldownMinutes: 360,
    })
  }
  if (screen?.summary) {
    add(candidates, {
      kind: 'screen', purpose: 'life', score: 54,
      topic: '她刚瞄了一眼你的屏幕',
      reason: '想看看你在忙什么',
      evidence: `屏幕观察：${screen.summary}（置信度 ${screen.confidence || 'low'}）。可以自然地说看到了屏幕，只提一项相关细节，不暴露无关隐私，不断言他的意图。`,
      cooldownMinutes: 240,
    })
  }
  const pending = progress?.pending
  if (pending?.node) add(candidates, { kind: 'pending', purpose: 'followup', score: 90, topic: `押着的卷「${pending.node}」还没做完`, reason: '有未完成动作', soft: true, evidence: `PROGRESS.pending：${pending.node}${pending.date ? `（${pending.date} 开）` : ''}` })
  const lesson = progress?.lesson
  if (lesson?.node) add(candidates, { kind: 'lesson', purpose: 'followup', score: 85, topic: `上次课停在「${lesson.node}」`, reason: '续课点', evidence: `PROGRESS.lesson：${lesson.node}` })
  const check = latestCheck(progress)
  if (check) {
    const days = daysBetween(check.date, now)
    if (days !== null && days >= 0 && days <= 2) {
      add(candidates, {
        kind: check.outcome === 'failed' ? 'check-failed' : 'check-passed',
        purpose: check.outcome === 'failed' ? 'care' : 'affection',
        score: check.outcome === 'failed' ? 82 : 78,
        topic: check.outcome === 'failed' ? `最近一次检测没过「${check.node}」` : `最近一次检测过了「${check.node}」`,
        reason: check.outcome === 'failed' ? '卡点' : '刚有结果',
        evidence: `PROGRESS 检测：${check.node} · ${check.date} · ${check.outcome}`,
      })
    }
  }
  // 她答应过的事：到期/逾期优先，且只报 open。
  for (const promise of person?.promises ?? []) {
    if (promise.status !== 'open' || !promise.dueAt) continue
    const days = daysBetween(promise.dueAt, now)
    if (days === null || days < -1) continue
    add(candidates, {
      kind: 'promise', purpose: 'followup', score: 88,
      topic: `你答应过：${promise.text}`,
      reason: days > 0 ? '约定已经过了' : days === 0 ? '约定就在今天' : '约定在明天',
      evidence: promise.evidence || `承诺记录：${promise.text}${promise.dueAt ? `（${promise.dueAt}）` : ''}`,
    })
    break
  }
  const last = lastUserAt ? new Date(lastUserAt) : null
  const gap = last && Number.isFinite(last.getTime()) ? Math.floor((now - last) / 86400000) : null
  const gapHours = last && Number.isFinite(last.getTime()) ? (now - last) / 3600000 : null
  if (gapHours !== null && gapHours >= 8 && gapHours < 72 && now.getHours() >= 8 && now.getHours() < 11) {
    add(candidates, { kind: 'greeting', purpose: 'care', score: 62, topic: '早，昨晚睡得怎么样', reason: '隔了一晚', evidence: `上次用户消息：${lastUserAt}` })
  }
  if (gap !== null && gap >= 3) add(candidates, { kind: 'absence', purpose: 'care', score: 75, topic: `已经 ${gap} 天没来了`, reason: '久未联系', evidence: `上次用户消息：${lastUserAt}` })
  for (const milestone of person?.relation?.milestones ?? []) {
    const days = nextAnniversary(milestone.date, now)
    if (days === null || days > 7) continue
    add(candidates, {
      kind: 'milestone', purpose: 'affection', score: 72,
      topic: days === 0 ? `今天是「${milestone.label}」` : `还有 ${days} 天是「${milestone.label}」`,
      reason: '纪念日', evidence: milestone.evidence || `纪念日：${milestone.label} · ${milestone.date}`,
    })
    break
  }
  // 共同经历：只在最近 14 天里挑一条，作为“忽然想起来”的由头。
  const episodes = (person?.episodes ?? []).filter(item => {
    const days = daysBetween(item.at, now)
    return days !== null && days >= 0 && days <= 14
  })
  if (episodes.length) {
    const picked = episodes[Math.abs(Math.floor(now.getTime() / 86400000)) % episodes.length]
    add(candidates, {
      kind: 'episode', purpose: 'reminiscence', score: 68,
      topic: `上次你们：${picked.summary.slice(0, 50)}`,
      reason: '共同经历', evidence: picked.evidence || `共同经历：${picked.at} · ${picked.summary}`,
    })
  }
  const like = (person?.profile?.likes ?? [])[0]
  if (like) add(candidates, { kind: 'opinion', purpose: 'life', score: 54, topic: `她最近喜欢${like}`, reason: '她自己的偏好', evidence: `person.profile.likes：${like}` })
  // 正在读的优先；没有在读的，才看读完的。完成日必须来自真实读完时间
  // （doneAt），不能用最近一次元数据编辑时间冒充「刚读完」。
  const readingBook = (person?.library ?? []).find(item => item.state === 'reading')
  const doneBook = (person?.library ?? [])
    .filter(item => item.state === 'done' && item.note)
    .sort((a, b) => Date.parse(b.doneAt || 0) - Date.parse(a.doneAt || 0))[0]
  const book = readingBook ?? doneBook
  if (book) {
    const progress = Number(book.progress) > 0 ? `${Math.round(Number(book.progress) * 100)}%` : ''
    const reading = book.state === 'reading'
    const doneDays = book.doneAt && Number.isFinite(Date.parse(book.doneAt))
      ? Math.floor((now.getTime() - Date.parse(book.doneAt)) / 86400000) : null
    const recent = !reading && doneDays !== null && doneDays >= 0 && doneDays <= 7
    const label = reading ? '她正在看' : recent ? '她刚读完' : '她以前读过'
    add(candidates, {
      kind: 'library', purpose: 'life', score: reading ? 60 : recent ? 56 : 48,
      topic: `${label}《${book.title}》`, reason: '她自己的事',
      evidence: `person.library：《${book.title}》 state=${book.state}${book.doneAt ? ` doneAt=${book.doneAt}` : ''}${progress ? ` progress=${progress}` : ''}${book.note ? ` note=${book.note}` : ''}`,
    })
  }
  if (life?.description && (!life.day || life.day === ymd(now))) {
    const since = Date.parse(life.startedAt)
    const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60000)) : null
    const journalToday = journal?.day === ymd(now) ? clean(journal?.text) : ''
    add(candidates, {
      kind: 'life', purpose: 'life', score: 58,
      topic: `她现在${life.description}`, reason: '她自己的生活',
      evidence: [
        `companion.life：${life.description}${life.day ? `（${life.day}）` : ''}`,
        minutes !== null ? `已经 ${minutes} 分钟` : '',
        journalToday ? `今天的日记：${journalToday}` : '',
      ].filter(Boolean).join('；'),
    })
  }
  // 一天的日记是比「在窗边发呆」更具体的由头；但只在她今天真的写了的时候才用。
  if (journal?.day === ymd(now) && clean(journal?.text)) {
    add(candidates, {
      kind: 'life', purpose: 'life', score: 56,
      topic: '她今天的小事', reason: '她自己的生活',
      evidence: `companion.journal：${clean(journal.text)}`,
    })
  }
  if (classWindow && Array.isArray(classWindow.weekdays) && classWindow.weekdays.includes(now.getDay())) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(classWindow.from ?? ''))
    if (match) {
      const start = Number(match[1]) * 60 + Number(match[2])
      const minutes = now.getHours() * 60 + now.getMinutes()
      if (start > minutes && start - minutes <= 180) {
        add(candidates, { kind: 'class', purpose: 'care', score: 55, topic: `今天 ${classWindow.from} 有课`, reason: '日程', evidence: `SCHEDULE.classWindow：${classWindow.from}–${classWindow.to}` })
      }
    }
  }
  // VP 赛后：strategy.loadVp() 的真实形状是 { events, postmortems }，不是 contests。
  // 只报最近 3 天内真实打过的比赛，不猜结果；没有日期或太旧就跳过。
  const recentVp = (vp?.events ?? [])
    .map(event => ({ event, days: daysBetween(event?.date, now) }))
    .filter(item => item.event?.contest && item.days !== null && item.days >= 0 && item.days <= 3)
    .sort((a, b) => String(b.event.date).localeCompare(String(a.event.date)))[0]?.event
  if (recentVp) {
    add(candidates, { kind: 'vp', purpose: 'care', score: 64, topic: `刚打完「${recentVp.contest}」`, reason: 'VP 赛后', evidence: `VP event：${recentVp.contest} · ${recentVp.date}` })
  }
  // 上午/下午的专注时段：她自己的小事、回忆、书、上课这类轻话题降一点权重，
  // 目标/押卷/承诺/检测这些真正影响训练的仍然照常。
  const hour = now.getHours() + now.getMinutes() / 60
  if ((hour >= 9 && hour < 11.5) || (hour >= 14 && hour < 16.5)) {
    for (const item of candidates) {
      if (['life', 'episode', 'library', 'class'].includes(item.kind)) item.score = Math.max(1, Math.round(item.score * 0.75))
    }
  }
  return candidates
}

function seedUnit(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0) / 2 ** 32
}

export function chooseSource(candidates, { state, now = new Date(), sessionId = '' } = {}) {
  const nowMs = now.getTime()
  const recent = new Set((state?.recent ?? [])
    .filter(item => {
      const at = Date.parse(item.at)
      if (!Number.isFinite(at)) return false
      const cooldown = Number.isFinite(item.cooldownMinutes) && item.cooldownMinutes > 0
        ? item.cooldownMinutes * 60000
        : 7 * 86400000
      return nowMs - at < cooldown
    })
    .map(item => item.topic))
  const feasible = candidates.filter(item => !recent.has(item.topic))
  if (!feasible.length) return null
  // 权重选择：高优先仍更常赢，但不会每天同一件事。
  const seed = `${sessionId}:${ymd(now)}:${now.getHours()}`
  const weighted = feasible.map(item => ({ item, weight: Math.max(1, item.score) }))
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  let target = seedUnit(seed) * total
  for (const entry of weighted) {
    target -= entry.weight
    if (target <= 0) return entry.item
  }
  return weighted[weighted.length - 1].item
}

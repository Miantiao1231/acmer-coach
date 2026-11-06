// 统一记忆选择：先按“安全/到期”拿必须带的，再按当前话题的相关度拿可选记忆。
// 目标是压掉“每轮把 3 条经历全念一遍 + Hindsight 再召回一遍”的重复注入。
const clean = (value) => String(value ?? '').trim()
const pad = (n) => String(n).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

const SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null
const STOP = new Set([
  '这个', '那个', '什么', '怎么', '就是', '还是', '一个', '我们', '他们', '她们',
  '你们', '自己', '现在', '今天', '昨天', '明天', '然后', '因为', '所以', '但是',
  '可以', '没有', '不是', '已经', '一下', '有点', '一点', '东西', '事情', '时候',
  '真的', '其实', '觉得', '知道', '看到', '说', '想', '去', '来', '上', '下',
  '里', '后', '前', '的', '了', '吗', '呢', '啊', '吧', '在', '有', '是', '就',
  '都', '也', '很', '太', '和', '跟', '我', '你', '他', '她', '它',
])
const NORMALIZE_REPLACEMENTS = [
  [/(?:区域赛|竞赛|比赛)/g, '比赛'],
  [/(?:复盘|总结|回顾)/g, '复盘'],
  [/(?:卡点|卡壳|卡住)/g, '卡住'],
  [/(?:疲惫|没精神)/g, '累'],
  [/(?:题目|题面)/g, '题'],
  [/(?:进展|推进)/g, '进度'],
]

function rawTokens(text) {
  let value = clean(text).toLowerCase()
  for (const [pattern, replacement] of NORMALIZE_REPLACEMENTS) value = value.replace(pattern, replacement)
  if (!value) return []
  if (!SEGMENTER) return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return [...SEGMENTER.segment(value)].filter(item => item.isWordLike).map(item => item.segment)
}

export function tokensOf(text) {
  return [...new Set(rawTokens(text).filter(token => token && !STOP.has(token)))]
}

function overlapScore(query, text) {
  const q = tokensOf(query)
  if (!q.length) return 0
  const target = new Set(tokensOf(text))
  let score = 0
  for (const token of q) if (target.has(token)) score += 3
  // 词级没命中时保留一点双字兜底，避免分词把专有名词切碎后完全归零。
  const raw = clean(query)
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const bigram = raw.slice(i, i + 2).trim()
    if (bigram && String(text).includes(bigram)) score += 1
  }
  return score
}

function ageDays(at, now) {
  const date = new Date(`${clean(at)}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return Infinity
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  return Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)) / 86400000)
}

// MMR: the highest-overlap episode is not automatically the best second pick.
// Without this, two near-duplicate summaries of the same contest crowd out a
// different memory that the conversation actually needs.
function jaccard(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

function mmrPick(entries, { limit = 2, lambda = 0.7 } = {}) {
  const picked = []
  const pool = [...entries]
  while (picked.length < limit && pool.length) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index]
      const similarity = picked.reduce((max, chosen) => Math.max(max, jaccard(
        tokensOf(candidate.item.summary ?? candidate.item.text ?? ''),
        tokensOf(chosen.item.summary ?? chosen.item.text ?? ''),
      )), 0)
      const score = lambda * candidate.score - (1 - lambda) * similarity - Math.min(365, candidate.age || 0) * 0.001
      if (score > bestScore) { bestScore = score; bestIndex = index }
    }
    picked.push(pool.splice(bestIndex, 1)[0])
  }
  return picked
}

export function selectMemory(person, { query = '', now = new Date() } = {}) {
  const pinned = (person?.pinned ?? []).slice(0, 12)
  const boundaries = (person?.boundaries ?? []).slice(0, 12)

  const episodes = (person?.episodes ?? [])
    .filter(item => !(item.tags ?? []).includes('修复'))
    .map(item => ({ item, score: overlapScore(query, item.summary), age: ageDays(item.at, now) }))
  const relevantEpisodes = episodes.filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.age - b.age)
  const recentEpisodes = episodes.filter(entry => entry.age >= 0 && entry.age <= 14)
    .sort((a, b) => a.age - b.age)
  const pool = [...relevantEpisodes, ...recentEpisodes.filter(entry => !relevantEpisodes.includes(entry))].slice(0, 12)
  const pickedEpisodes = mmrPick(pool, { limit: relevantEpisodes.length ? 2 : 1 }).map(entry => entry.item)

  const repairs = (person?.episodes ?? [])
    .filter(item => (item.tags ?? []).includes('修复'))
    .map(item => ({ item, score: overlapScore(query, item.summary), age: ageDays(item.at, now) }))
    .filter(entry => entry.score > 0 || (entry.age >= 0 && entry.age <= 3))
    .sort((a, b) => b.score - a.score || a.age - b.age)
    .slice(0, 1).map(entry => entry.item)

  const today = ymd(now)
  const promises = (person?.promises ?? [])
    .filter(item => item.status === 'open')
    .map(item => ({ item, score: overlapScore(query, item.text), due: item.dueAt && item.dueAt <= today }))
  const due = promises.filter(entry => entry.due)
    .sort((a, b) => String(a.item.dueAt).localeCompare(String(b.item.dueAt)))
    .slice(0, 2).map(entry => entry.item)
  const rest = promises.filter(entry => !entry.due && (entry.score > 0 || due.length === 0))
    .sort((a, b) => String(a.item.dueAt || '9999').localeCompare(String(b.item.dueAt || '9999')))
    .slice(0, 1).map(entry => entry.item)

  return { pinned, boundaries, repairs, episodes: pickedEpisodes, due, rest }
}

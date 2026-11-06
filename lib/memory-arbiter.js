// 可选的记忆仲裁器：只在值得的时候调一次小模型，做两件事：
//   1. 从候选经历/承诺里选真正相关的 1–2 条；
//   2. 判断 Hindsight 记忆和 claims 是否矛盾。
// 任何失败（无路由、超时、坏 JSON）都返回 null/[]，调用方回退到词级选择。
import { createHash } from 'node:crypto'
import { utilityControls } from './llm-controls.js'
import { selectMemory } from './memory-select.js'

const clean = (value) => String(value ?? '').trim()
const digest = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32)
const DEFAULT_TIMEOUT = 4000
const CACHE_TTL = 30 * 60 * 1000
const CACHE_MAX = 80
const cache = new Map()

const MEMORY_SYSTEM = `你是记忆筛选器。只根据给定的候选和当前用户话语，选出真正相关的记忆。
不能新增候选，不能改写事实，不能把候选之外的经历写进结果。
只输出 JSON：{"episode_ids":[],"promise_ids":[],"repair_ids":[],"reason":"一句短理由"}。
最多选 2 条经历、1 条未到期承诺、1 条修复经历；不相关就空数组。`

const CONFLICT_SYSTEM = `你是记忆冲突检查器。判断 Hindsight 记忆是否和本地记录 claims 矛盾；本地记录也可能陈旧，不能预设正确。
只输出 JSON：{"drop_ids":[],"conflicts":[{"memory_id":"m1","claim":"一句话","reason":"否定相反/日期不同/其他"}]}。
只有确实矛盾才放进 drop_ids；不确定就留空。不能改写记忆。`

const readCache = (key) => {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL) { cache.delete(key); return null }
  return hit.value
}
const writeCache = (key, value) => {
  cache.set(key, { at: Date.now(), value })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

async function callJson({ llm, route, system, prompt, timeoutMs, maxTokens = 800 }) {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const controls = await utilityControls(llm, route)
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }] })],
      ...controls,
      maxTokens,
      temperature: 0.1,
      signal: controller.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text'
        && typeof chunk.block.text === 'string' && !text) text = chunk.block.text
    }
    const raw = clean(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(raw)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function episodeCandidates(person) {
  return (person?.episodes ?? []).filter(item => !(item.tags ?? []).includes('修复'))
    .map((item, index) => ({ id: clean(item.id) || `e${index}`, item }))
}

function repairCandidates(person) {
  return (person?.episodes ?? []).filter(item => (item.tags ?? []).includes('修复'))
    .map((item, index) => ({ id: clean(item.id) || `r${index}`, item }))
}

function promiseCandidates(person, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return (person?.promises ?? []).filter(item => item.status === 'open' && !(item.dueAt && item.dueAt <= today))
    .map((item, index) => ({ id: clean(item.id) || `p${index}`, item }))
}

const listOf = (entries, max = 12) => entries.slice(0, max)
  .map(entry => `- ${entry.id}：${clean(entry.item.summary ?? entry.item.text).slice(0, 120)}`).join('\n')

export async function arbitrateMemory({ llm, route, query, person, now = new Date(), timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) return null
  const text = clean(query)
  if (text.length < 4) return null
  const relevant = selectMemory(person, { query: text, now })
  const candidates = (entries, selected) => entries.filter(entry => selected.includes(entry.item))
  const episodes = candidates(episodeCandidates(person), relevant.episodes)
  const repairs = candidates(repairCandidates(person), relevant.repairs)
  const promises = candidates(promiseCandidates(person, now), relevant.rest)
  if (!episodes.length && !repairs.length && !promises.length) return null
  const key = digest(JSON.stringify([query, person?.revision, episodes.map(e => e.id), repairs.map(e => e.id), promises.map(e => e.id)]))
  const cached = readCache(key)
  if (cached) return { ...cached, cached: true }
  const prompt = [
    `当前话语：${text.slice(0, 500)}`,
    episodes.length ? `候选经历：\n${listOf(episodes)}` : '',
    repairs.length ? `候选修复经历：\n${listOf(repairs)}` : '',
    promises.length ? `候选未到期承诺：\n${listOf(promises)}` : '',
    '只输出 JSON，不要解释。',
  ].filter(Boolean).join('\n\n')
  const data = await callJson({ llm, route, system: MEMORY_SYSTEM, prompt, timeoutMs })
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (!['episode_ids', 'promise_ids', 'repair_ids'].some(key => Array.isArray(data[key]))) return null
  const pick = (ids, entries, max) => {
    const wanted = Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
    return wanted.slice(0, max).map(id => entries.find(entry => entry.id === id)?.item).filter(Boolean)
  }
  const result = {
    episodes: pick(data.episode_ids, episodes, 2),
    repairs: pick(data.repair_ids, repairs, 1),
    rest: pick(data.promise_ids, promises, 1),
    cached: false,
    reason: clean(data.reason).slice(0, 200),
  }
  writeCache(key, result)
  return result
}

export async function arbitrateConflicts({ llm, route, claims = [], memories = [], timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) return []
  if (!claims.length || !memories.length) return []
  const key = digest(JSON.stringify([claims.map(c => clean(c?.text ?? c)), memories.map((m, i) => `${i}:${clean(m?.text)}`)]))
  const cached = readCache(key)
  if (cached) return cached
  const prompt = [
    `本地记录：\n${claims.slice(0, 20).map((claim, i) => `- c${i}：${clean(claim?.text ?? claim).slice(0, 160)}`).join('\n')}`,
    `Hindsight 记忆：\n${memories.slice(0, 8).map((memory, i) => `- m${i}：${clean(memory?.text).slice(0, 220)}`).join('\n')}`,
    '只输出 JSON，不要解释。',
  ].join('\n\n')
  const data = await callJson({ llm, route, system: CONFLICT_SYSTEM, prompt, timeoutMs, maxTokens: 600 })
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const ids = Array.isArray(data.drop_ids) ? data.drop_ids.filter(id => typeof id === 'string') : []
  const result = []
  for (const id of ids) {
    const index = Number(String(id).replace(/^m/, ''))
    if (!Number.isInteger(index) || index < 0 || index >= memories.length) continue
    const conflict = Array.isArray(data.conflicts) ? data.conflicts.find(item => item?.memory_id === id) : null
    result.push({ index, memory: memories[index], reason: clean(conflict?.reason).slice(0, 160) || '模型判定冲突' })
  }
  writeCache(key, result)
  return result
}

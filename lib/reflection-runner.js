// 后台反思：攒够真人消息后跑一次小模型，只写「待审候选」，不直接改档案。
//
// 关键边界：
//   1. 只在 turn/end 后触发，不阻塞对话；
//   2. 模型调用失败/没路由就安静跳过，下一轮再试；
//   3. 模型调用期间用户可能 accept 了别的候选 —— 所以落盘前重新读一次 person.json，
//      不能拿调用前的旧快照覆盖。
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadPerson, savePerson } from './person.js'
import { utilityControls } from './llm-controls.js'
import {
  evidenceFromMessages, buildMaterials, parseReflection, parseStyle,
  REFLECTION_INSTRUCTION, STYLE_INSTRUCTION, REFLECTION_TOOL, STYLE_TOOL,
} from './reflection.js'
import {
  startBatch, markReceived, finishBatch, recoverBatch,
} from './reflection-batch.js'
import {
  loadEpisodeCursor, episodeDue, episodeMaterial, markEpisodeCovered,
} from './episodes.js'
import { loadInteractionLog } from './interaction-log.js'
import { backgroundModelsEnabled } from './proactive-state.js'

const textOf = message => Array.isArray(message?.content)
  ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  : ''
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const keyOf = (message) => message.id || `${message.seq ?? ''}\u0000${message.text}`
const pad = (n) => String(n).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

function log(dataDir, line) {
  try {
    mkdirSync(dirname(join(dataDir, 'reflection.log')), { recursive: true })
    const path = join(dataDir, 'reflection.log')
    if ((statSync(path, { throwIfNoEntry: false })?.size || 0) > 256 * 1024) {
      writeFileSync(path, readFileSync(path, 'utf8').slice(-128 * 1024), 'utf8')
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 诊断永远不能挡住对话 */ }
}

function addPending(person, proposal) {
  const signature = JSON.stringify([proposal.kind, proposal.subject ?? 'unknown', proposal.fields])
  const same = item => JSON.stringify([item.kind, item.subject ?? 'unknown', item.fields]) === signature
  if (person.pending.some(same)) return false
  if (person.rejected.some(same)) return false
  if (proposal.kind === 'habit' && person.habits.some(item => item.situation === proposal.fields.situation && item.action === proposal.fields.action)) return false
  if (proposal.kind === 'anniversary' && person.relation.milestones.some(item => item.label === proposal.fields.label && item.date === proposal.fields.date)) return false
  if (proposal.kind === 'library' && person.library.some(item => item.title.toLowerCase() === proposal.fields.title.toLowerCase())) return false
  if (proposal.kind === 'episode' && person.episodes.some(item => item.at === proposal.fields.at && item.summary === proposal.fields.summary)) return false
  if (proposal.kind === 'promise' && person.promises.some(item => item.text === proposal.fields.text)) return false
  if (proposal.kind === 'boundary' && person.boundaries.some(item => item.text === proposal.fields.text)) return false
  if (proposal.kind === 'profile') {
    const fresh = ['likes', 'dislikes', 'quirks', 'background'].some(key =>
      (proposal.fields[key] ?? []).some(value => !(person.profile[key] ?? []).includes(value)))
    if (!fresh) return false
  }
  if (person.pending.length >= 32) return false
  person.pending.push(proposal)
  return true
}

function addStyle(person, signal) {
  if (person.style.some(item => item.dimension === signal.dimension && item.pattern === signal.pattern)) return false
  if (person.style.length >= 16) return false
  person.style.push(signal)
  return true
}

async function callModel(llm, route, system, prompt, maxTokens, timeoutMs, tool) {
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
      temperature: 0.2,
      signal: controller.signal,
      ...(tool ? { tools: [tool] } : {}),
    })
    let text = ''
    let toolArgs = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text'
        && typeof chunk.block.text === 'string' && !text) text = chunk.block.text
      if (chunk?.type === 'tool-call-delta' && (!chunk.name || chunk.name === tool?.name)) {
        toolArgs += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      }
      if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name === tool?.name) {
        toolArgs = typeof chunk.block.arguments === 'string' ? chunk.block.arguments : toolArgs
      }
    }
    return { text, toolArgs }
  } finally {
    clearTimeout(timer)
  }
}

export function applyReflection(ctx, dataDir, options = {}) {
  const allowModel = options.allowModel ?? (() => backgroundModelsEnabled(dataDir))
  const reflectEvery = clamp(Number(options.reflectEvery ?? process.env.COACH_REFLECT_EVERY ?? 12), 4, 40)
  const styleEvery = clamp(Number(options.styleEvery ?? process.env.COACH_STYLE_EVERY ?? 40), 10, 100)
  const maxTokens = clamp(Number(options.maxTokens ?? process.env.COACH_REFLECT_MAX_TOKENS ?? 2048), 512, 4096)
  const timeoutMs = clamp(Number(options.timeoutMs ?? process.env.COACH_REFLECT_TIMEOUT_MS ?? 60000), 5000, 180000)
  const dailyLimit = clamp(Number(options.dailyLimit ?? process.env.COACH_REFLECT_DAILY ?? 8), 1, 32)
  const buffers = new Map()
  let reflectRetryAt = 0
  let styleRetryAt = 0
  const routes = new Map()
  let lastRoute = null
  let users = []
  let styleUsers = []
  let reflecting = false
  let styling = false

  const bufferFor = (session) => {
    const id = typeof session?.id === 'string' ? session.id : ''
    const existing = buffers.get(id)
    if (existing) {
      // LRU：重新插到末尾，别让活跃会话被最早的插入序淘汰。
      buffers.delete(id)
      buffers.set(id, existing)
      return existing
    }
    // 反思长期跑不成时缓冲不能无限长；保留最近 64 个会话就够。
    if (buffers.size >= 64) buffers.delete(buffers.keys().next().value)
    const created = { users: [], force: false }
    buffers.set(id, created)
    return created
  }

  const routeFor = (sessionId) => routes.get(sessionId) ?? lastRoute

  async function runReflection(sessionId, { force = false } = {}) {
    if (!allowModel() || reflecting || Date.now() < reflectRetryAt) return
    const route = routeFor(sessionId)
    const llm = ctx.get?.('llm')
    if (!route?.provider || !route?.model || typeof llm?.stream !== 'function') {
      log(dataDir, `reflect-skip no-route-or-llm session=${sessionId}`)
      return
    }
    // 先把批次取出来，再决定要不要占额度。force（他说“记住…”）允许单条消息
    // 立即反思；普通反思仍然要攒够 4 条，避免一句寒暄就调模型。
    const batch = users.slice(-32)
    const evidence = evidenceFromMessages(batch)
    if (evidence.length < (force ? 1 : 4)) return
    const now0 = new Date()
    // Persist the batch before the model call: a restart after this point must
    // be able to finish from the raw output instead of losing the whole batch.
    const record = startBatch(dataDir, { evidence, now: now0 })
    reflecting = true
    try {
      const now = new Date()
      const today = ymd(now)
      const person = loadPerson(dataDir)
      if (person.reflection.retryAt && Date.parse(person.reflection.retryAt) > now.getTime()) {
        log(dataDir, 'reflect-skip retry-at')
        return
      }
      const used = person.reflection.day === today ? person.reflection.reflectCallsToday || 0 : 0
      if (used >= dailyLimit) { log(dataDir, 'reflect-skip daily-budget'); return }
      // 占额度：失败也计一次，避免一次坏输出把额度刷爆。
      const reserved = loadPerson(dataDir)
      if (person.reflection.day !== today) reserved.reflection.styleCallsToday = 0
      reserved.reflection.day = today
      reserved.reflection.reflectCallsToday = used + 1
      if (!savePerson(dataDir, reserved)) {
        log(dataDir, 'reflect-save-fail reserve')
        return
      }
      // Periodic private episode material: offered to the same reflection pass,
      // never summarised by a second model or stored as a second memory.
      const episodeCursor = loadEpisodeCursor(dataDir)
      const episodeEntries = loadInteractionLog(dataDir, now).entries
      const episode = episodeDue(episodeEntries, episodeCursor, { now })
        ? episodeMaterial(episodeEntries, episodeCursor, { now })
        : null
      const output = await callModel(llm, route, REFLECTION_INSTRUCTION, buildMaterials(person, evidence, episode), maxTokens, timeoutMs, REFLECTION_TOOL)
      const raw = output.toolArgs || output.text
      if (record) markReceived(dataDir, { id: record.id, raw, now })
      const parsed = parseReflection(raw, { allowedHandles: new Map(evidence.map(item => [item.handle, item])) })
      if (!parsed.ok) {
        if (record) finishBatch(dataDir, { id: record.id, state: 'failed', error: parsed.reject })
        reflectRetryAt = Date.now() + 5 * 60 * 1000
        const retry = loadPerson(dataDir)
        retry.reflection.retryAt = new Date(reflectRetryAt).toISOString()
        if (!savePerson(dataDir, retry)) log(dataDir, 'reflect-save-fail retry-at')
        log(dataDir, `reflect-parse-fail ${parsed.reject}`)
        return
      }
      // 模型调用期间可能有别的手动写入；落盘前重读，不能用旧快照覆盖。
      const fresh = loadPerson(dataDir)
      let added = 0
      for (const proposal of parsed.proposals) if (addPending(fresh, proposal)) added += 1
      fresh.reflection.lastAt = new Date().toISOString()
      fresh.reflection.lastSummary = parsed.summary.slice(0, 500)
      fresh.reflection.retryAt = ''
      // 落盘失败就别把这条消息从缓冲里删掉：下次还要重试，不能当成功。
      if (!savePerson(dataDir, fresh)) {
        log(dataDir, 'reflect-save-fail result')
        return
      }
      const processed = new Set(batch.map(keyOf))
      users = users.filter(item => !processed.has(keyOf(item)))
      reflectRetryAt = 0
      // The episode cursor advances only after the batch actually landed.
      if (episode?.coveredThrough) markEpisodeCovered(dataDir, { coveredThrough: episode.coveredThrough, now })
      if (record) {
        // A batch with some rejected proposals is `partial`, not `complete`:
        // the rejected slots are kept so a later pass can retry just those.
        finishBatch(dataDir, {
          id: record.id,
          state: parsed.rejected.length ? 'partial' : 'complete',
          summary: parsed.summary,
          proposals: parsed.proposals,
          rejected: parsed.rejected,
        })
      }
      log(dataDir, `reflect-ok added=${added} rejected=${parsed.rejected.length}`)
    } catch (error) {
      if (record) finishBatch(dataDir, { id: record.id, state: 'failed', error: error?.name || 'Error' })
      reflectRetryAt = Date.now() + 5 * 60 * 1000
      const retry = loadPerson(dataDir)
      retry.reflection.retryAt = new Date(reflectRetryAt).toISOString()
      if (!savePerson(dataDir, retry)) log(dataDir, 'reflect-save-fail error')
      log(dataDir, `reflect-fail ${error?.name || 'Error'}`)
    } finally {
      reflecting = false
    }
  }

  async function runStyle(sessionId) {
    if (!allowModel() || styling || Date.now() < styleRetryAt) return
    const route = routeFor(sessionId)
    const llm = ctx.get?.('llm')
    if (!route?.provider || !route?.model || typeof llm?.stream !== 'function') {
      log(dataDir, `style-skip no-route-or-llm session=${sessionId}`)
      return
    }
    const batch = styleUsers.slice(-32)
    const evidence = evidenceFromMessages(batch)
    if (evidence.length < 10) return
    styling = true
    try {
      const now = new Date()
      const today = ymd(now)
      const person = loadPerson(dataDir)
      if (person.reflection.styleRetryAt && Date.parse(person.reflection.styleRetryAt) > now.getTime()) {
        log(dataDir, 'style-skip retry-at')
        return
      }
      const used = person.reflection.day === today ? person.reflection.styleCallsToday || 0 : 0
      if (used >= dailyLimit) { log(dataDir, 'style-skip daily-budget'); return }
      const reserved = loadPerson(dataDir)
      if (person.reflection.day !== today) reserved.reflection.reflectCallsToday = 0
      reserved.reflection.day = today
      reserved.reflection.styleCallsToday = used + 1
      if (!savePerson(dataDir, reserved)) {
        log(dataDir, 'style-save-fail reserve')
        return
      }
      const output = await callModel(llm, route, STYLE_INSTRUCTION, buildMaterials(person, evidence), maxTokens, timeoutMs, STYLE_TOOL)
      const parsed = parseStyle(output.toolArgs || output.text, { allowedHandles: new Map(evidence.map(item => [item.handle, item])) })
      if (!parsed.ok) {
        styleRetryAt = Date.now() + 5 * 60 * 1000
        const retry = loadPerson(dataDir)
        retry.reflection.styleRetryAt = new Date(styleRetryAt).toISOString()
        if (!savePerson(dataDir, retry)) log(dataDir, 'style-save-fail retry-at')
        log(dataDir, `style-parse-fail ${parsed.reject}`)
        return
      }
      const fresh = loadPerson(dataDir)
      let added = 0
      for (const signal of parsed.signals) if (addStyle(fresh, signal)) added += 1
      fresh.reflection.lastStyleAt = new Date().toISOString()
      fresh.reflection.styleRetryAt = ''
      if (!savePerson(dataDir, fresh)) {
        log(dataDir, 'style-save-fail result')
        return
      }
      const processed = new Set(batch.map(keyOf))
      styleUsers = styleUsers.filter(item => !processed.has(keyOf(item)))
      styleRetryAt = 0
      log(dataDir, `style-ok added=${added} rejected=${parsed.rejected.length}`)
    } catch (error) {
      styleRetryAt = Date.now() + 5 * 60 * 1000
      const retry = loadPerson(dataDir)
      retry.reflection.styleRetryAt = new Date(styleRetryAt).toISOString()
      if (!savePerson(dataDir, retry)) log(dataDir, 'style-save-fail error')
      log(dataDir, `style-fail ${error?.name || 'Error'}`)
    } finally {
      styling = false
    }
  }

  // Restart recovery: a batch that reached `received` already has the raw
  // model output, so land its proposals without paying for another call.
  function recoverPendingBatch() {
    const recovered = recoverBatch(dataDir)
    if (recovered.kind !== 'received' || !recovered.batch) return
    const parsed = parseReflection(recovered.batch.raw, {
      allowedHandles: new Map(recovered.batch.evidence.map(item => [item.handle, item])),
    })
    if (!parsed.ok) {
      finishBatch(dataDir, { id: recovered.batch.id, state: 'failed', error: parsed.reject })
      log(dataDir, `reflect-recover-fail ${parsed.reject}`)
      return
    }
    const person = loadPerson(dataDir)
    let added = 0
    for (const proposal of parsed.proposals) if (addPending(person, proposal)) added += 1
    const receivedAt = Date.parse(recovered.batch.rawSavedAt)
    const currentAt = Date.parse(person.reflection.lastAt)
    // A recovered old batch must not relabel a newer summary or make old work look fresh.
    if (Number.isFinite(receivedAt) && (!Number.isFinite(currentAt) || receivedAt >= currentAt)) {
      person.reflection.lastSummary = parsed.summary.slice(0, 500)
      person.reflection.lastAt = new Date(receivedAt).toISOString()
    } else if (!Number.isFinite(receivedAt) && !person.reflection.lastSummary && !person.reflection.lastAt) {
      person.reflection.lastSummary = parsed.summary.slice(0, 500)
    }
    if (!savePerson(dataDir, person)) { log(dataDir, 'reflect-recover-save-fail'); return }
    finishBatch(dataDir, {
      id: recovered.batch.id,
      state: parsed.rejected.length ? 'partial' : 'complete',
      summary: parsed.summary, proposals: parsed.proposals, rejected: parsed.rejected,
    })
    log(dataDir, `reflect-recover-ok added=${added} rejected=${parsed.rejected.length}`)
  }
  try { recoverPendingBatch() } catch (error) { log(dataDir, `reflect-recover-error ${error?.name || 'Error'}`) }

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (event?.type === 'request/header') {
        const config = event.data?.header?.config
        if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
          lastRoute = { provider: config.provider, model: config.model }
          routes.set(sessionId, lastRoute)
        }
        return
      }
      if (event?.type === 'user/message') {
        const message = event.data?.message || event.data
        if (message?.role !== 'user' || message?.source?.kind !== 'user') return
        const text = textOf(message)
        if (!text.trim()) return
        const buffer = bufferFor(session)
        buffer.users.push({ text, id: message.id, seq: event.seq, time: event.time })
        if (/(记住|以后|答应|约定|女朋友|不要再|别叫|别喊|别提|别催)/.test(text)) buffer.force = true
        return
      }
      if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return
      const buffer = buffers.get(sessionId)
      if (!buffer || !buffer.users.length) return
      users.push(...buffer.users)
      styleUsers.push(...buffer.users)
      // 一次反思最多吃 32 条；失败积压时保留最近 256 条，别把整段对话常驻内存。
      if (users.length > 256) users = users.slice(-256)
      if (styleUsers.length > 256) styleUsers = styleUsers.slice(-256)
      const force = buffer.force === true
      buffer.users = []
      buffer.force = false
      if (users.length >= reflectEvery || force) void runReflection(sessionId, { force })
      const person = loadPerson(dataDir)
      const since = Date.parse(person.reflection.lastStyleAt || person.reflection.lastAt || '')
      const weekDue = Number.isFinite(since) && Date.now() - since > 7 * 86400000
      if (styleUsers.length >= styleEvery || (weekDue && styleUsers.length >= 10)) void runStyle(sessionId)
    } catch (error) {
      log(dataDir, `event-fail ${error?.name || 'Error'}`)
    }
  })
}

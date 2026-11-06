// 陪伴状态：只记「上次见到训练员是什么时候」，其余（心情、执教态）从事实现算。
//
// 为什么只存一个时间戳：
//   心情如果也存盘，就要处理衰减、并发和损坏；而它能依据的事实只有
//   PROGRESS 里的检测记录和「多久没见」。现算既不会漂，也不会把假心情写进账本。
//
// 状态文件是**建议性**的：读不到、写不进、格式坏了，都必须让对话继续。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyBody, normalizeBody } from './body-state.js'
import { emptyRoleState, normalizeRoleState } from './state-maintenance.js'

const FILE = 'companion-state.json'
const LOCK_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const VERSION = 1
const pad = (n) => String(n).padStart(2, '0')

const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

// 她自己的生活：只记录“现在在做什么”，不是事实账本。
// 互动与睡眠有时间来源；闲时只是模拟近况，不冒充已经完成的生活事件。
const IDLE_DESCRIPTIONS = ['想听会儿歌', '想翻翻以前的题解', '想歇一会儿', '想把桌面理清爽一点']
const IDLE_SLOT_MS = 2 * 3600000
const RECENT_CHAT_MS = 10 * 60000

export function emptyJournal(now = new Date()) {
  return { day: ymd(now), text: '', at: '' }
}

export function normalizeJournal(raw, now = new Date()) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(value.day ?? '')) ? String(value.day) : ymd(now),
    text: String(value.text ?? '').trim().slice(0, 240),
    at: typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) ? value.at : '',
  }
}

export function advanceJournal(input, { now = new Date(), person = null, presence = null, body = null, life = null } = {}) {
  const journal = normalizeJournal(input, now)
  const today = ymd(now)
  if (journal.day === today && journal.text) return journal
  const book = (person?.library ?? []).find(item => item.state === 'reading')
  const mode = presence?.mode ?? 'normal'
  let text
  if (mode === 'sleep' || mode === 'nap') text = '今天补了个觉，醒来还是有点困。'
  else if (book) {
    const progress = Number(book.progress) > 0 ? `，读到 ${Math.round(Number(book.progress) * 100)}%` : ''
    text = `今天在看《${book.title}》${progress}。${book.note ? `记了一句：${book.note}` : '看得有点慢。'}`
  } else if (life?.description) text = `今天${life.description}，没什么特别的事。`
  else text = '今天在窗边坐了一会儿，没什么特别的事。'
  if (Number(body?.energy) < 35) text += '有点累，想早点睡。'
  return { day: today, text: text.slice(0, 240), at: now.toISOString() }
}

export function journalLine(journal, now = new Date()) {
  if (!journal?.text || journal.day !== ymd(now)) return ''
  return `- 你今天的小日记：${journal.text}（他问起或你主动分享时再说，不要每轮念）。`
}

export function emptyLife(now = new Date()) {
  return { day: ymd(now), kind: 'idle', source: 'ambient', description: IDLE_DESCRIPTIONS[0], modelPlan: null, state: 'active', startedAt: now.toISOString(), updatedAt: now.toISOString() }
}

function normalizeModelPlan(raw) {
  if (!raw || typeof raw !== 'object') return null
  const description = String(raw.description ?? '').trim().slice(0, 120)
  const started = Date.parse(raw.startedAt), expires = Date.parse(raw.expiresAt)
  const minutes = (expires - started) / 60000
  if (description.length < 2 || !Number.isFinite(minutes) || minutes < 20 || minutes > 120) return null
  return { id: String(raw.id ?? '').slice(0, 80), description,
    note: String(raw.note ?? '').trim().slice(0, 160),
    startedAt: new Date(started).toISOString(), expiresAt: new Date(expires).toISOString() }
}

export function normalizeLife(raw, now = new Date()) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const kind = ['reading', 'resting', 'idle', 'chatting', 'improvised'].includes(value.kind) ? value.kind : 'idle'
  const source = ['ambient', 'conversation', 'presence', 'library', 'model'].includes(value.source) ? value.source
    : kind === 'reading' ? 'library' : kind === 'resting' ? 'presence' : kind === 'chatting' ? 'conversation' : kind === 'improvised' ? 'model' : 'ambient'
  const description = String(value.description ?? '').trim().slice(0, 120)
  const at = (input) => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? input : now.toISOString()
  return {
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(value.day ?? '')) ? String(value.day) : ymd(now),
    kind,
    source,
    description: description || '在发呆',
    modelPlan: normalizeModelPlan(value.modelPlan),
    state: 'active',
    startedAt: at(value.startedAt),
    updatedAt: at(value.updatedAt),
  }
}

// 同一闲时时段保持稳定；近期真实互动优先于兜底近况，睡眠保留独立来源。
export function advanceLife(input, { now = new Date(), presence = null, person = null, lastUserAt = '' } = {}) {
  const life = normalizeLife(input, now)
  const mode = presence?.mode ?? 'normal'
  let next
  const chatGap = now.getTime() - Date.parse(lastUserAt)
  if (mode === 'sleep') next = { kind: 'resting', source: 'presence', description: '在补觉' }
  else if (mode === 'nap') next = { kind: 'resting', source: 'presence', description: '在午休' }
  else if (chatGap >= 0 && chatGap < RECENT_CHAT_MS) next = { kind: 'chatting', source: 'conversation', description: '在和训练员聊天' }
  else if (life.modelPlan && Date.parse(life.modelPlan.startedAt) <= now.getTime() && Date.parse(life.modelPlan.expiresAt) > now.getTime()) {
    next = { kind: 'improvised', source: 'model', description: life.modelPlan.description }
  }
  else {
    const book = (person?.library ?? []).find(item => item.state === 'reading')
    if (book) {
      const progress = Number(book.progress) > 0 ? ` ${Math.round(Number(book.progress) * 100)}%` : ''
      next = { kind: 'reading', source: 'library', description: `在读《${book.title}》${progress}` }
    } else {
      const index = Math.abs(Math.floor(now.getTime() / IDLE_SLOT_MS)) % IDLE_DESCRIPTIONS.length
      next = { kind: 'idle', source: 'ambient', description: IDLE_DESCRIPTIONS[index] }
    }
  }
  const changed = life.day !== ymd(now) || life.description !== next.description || life.kind !== next.kind
  return {
    day: ymd(now),
    ...next,
    modelPlan: life.modelPlan,
    state: 'active',
    startedAt: changed ? now.toISOString() : life.startedAt,
    updatedAt: now.toISOString(),
  }
}

export function lifeLine(life, now = new Date()) {
  if (!life?.description || life.day !== ymd(now)) return ''
  const started = new Date(life.startedAt)
  const minutes = Number.isFinite(started.getTime()) ? Math.max(0, Math.floor((now - started) / 60000)) : 0
  const since = minutes < 15 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`
  return `- ${life.source === 'model' ? '角色即兴模拟' : '你现在'}：${life.description}（${since}开始的）。他问起或你主动分享时再说，不要每轮报。`
}

export function emptyCompanionState(now = new Date()) {
  return {
    version: VERSION, lastUserAt: '', body: emptyBody(now),
    roleState: emptyRoleState(now), life: emptyLife(now), journal: emptyJournal(now),
  }
}

function parseCompanionState(raw, now) {
  if (!raw || raw.version !== VERSION || typeof raw.lastUserAt !== 'string') return null
  return {
    version: VERSION, lastUserAt: raw.lastUserAt, body: normalizeBody(raw.body, now),
    roleState: normalizeRoleState(raw.roleState, now),
    life: normalizeLife(raw.life, now), journal: normalizeJournal(raw.journal, now),
  }
}

export function loadCompanionState(dataDir, now = new Date()) {
  try {
    return parseCompanionState(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')), now)
      ?? emptyCompanionState(now)
  } catch {
    return emptyCompanionState(now)
  }
}

// 只读调用要区分「没有保存过」和「损坏/空文件」：前者返回 null，后者也返回
// null，绝不把默认生活状态当成已保存的事实。写入路径继续用 loadCompanionState。
export function loadCompanionStateIfPresent(dataDir, now = new Date()) {
  try {
    return parseCompanionState(JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')), now)
  } catch {
    return null
  }
}

const LOCK = 'companion-state.lock'

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
  } catch { /* 不是自己的锁或已经被删 */ }
}

function laterStamp(a, b) {
  const at = Date.parse(a ?? '')
  const bt = Date.parse(b ?? '')
  if (!Number.isFinite(at)) return b ?? ''
  if (!Number.isFinite(bt)) return a
  return bt >= at ? b : a
}

function newer(a, b, key) {
  const at = Date.parse(a?.[key] ?? '')
  const bt = Date.parse(b?.[key] ?? '')
  if (!Number.isFinite(at)) return b
  if (!Number.isFinite(bt)) return a
  return bt >= at ? b : a
}

export function saveCompanionState(dataDir, state) {
  const lock = acquireLock(dataDir)
  if (!lock) return false
  try {
    // 两个会话/两个进程同时推进时，不能拿旧快照整个覆盖：后写的会把另一个
    // 会话刚更新的 lastUserAt、身体或日记吞掉。按时间戳取较新的那份。
    // 文件坏了要先留证据，不能拿 emptyCompanionState(now) 当 prior 把默认值写回去。
    const path = join(dataDir, FILE)
    let prior = null
    if (existsSync(path)) {
      let valid = false
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        valid = raw && raw.version === VERSION && typeof raw.lastUserAt === 'string'
      } catch { valid = false }
      if (valid) prior = loadCompanionState(dataDir)
      else {
        try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch { /* keep going */ }
      }
    }
    const next = {
      lastUserAt: String(state?.lastUserAt ?? ''),
      body: normalizeBody(state?.body),
      // Missing roleState means "this caller does not maintain it" — keep the
      // stored one instead of stamping a fresh default over it.
      roleState: state?.roleState ? normalizeRoleState(state.roleState) : null,
      life: normalizeLife(state?.life),
      journal: normalizeJournal(state?.journal),
    }
    const merged = prior ? {
      version: VERSION,
      lastUserAt: laterStamp(prior.lastUserAt, next.lastUserAt),
      body: newer(prior.body, next.body, 'updatedAt'),
      roleState: next.roleState ? newer(prior.roleState, next.roleState, 'updatedAt') : prior.roleState,
      // A new chat can cover the display without discarding a plan generated concurrently.
      life: { ...newer(prior.life, next.life, 'updatedAt'),
        modelPlan: newer(prior.life.modelPlan, next.life.modelPlan, 'startedAt') },
      journal: newer(prior.journal, next.journal, 'at'),
    } : { version: VERSION, ...next, roleState: next.roleState ?? normalizeRoleState(undefined) }
    // 原子替换：读取方永远看不到截断到一半的 JSON。
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    try {
      writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
      renameSync(tmp, path)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw error
    }
    return true
  } catch {
    // 状态只是语气线索；写失败不能让整轮对话挂掉。
    return false
  } finally {
    releaseLock(lock)
  }
}

const formatClock = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 周${'日一二三四五六'[d.getDay()]}`

function gapText(ms) {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 5) return '刚才'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function timeLine(state, now = new Date(), { includeClock = true } = {}) {
  const clock = includeClock ? `时间：${formatClock(now)}；` : ''
  if (!state?.lastUserAt) return `- ${clock}上次对话时间未知。`
  const last = new Date(state.lastUserAt)
  if (Number.isNaN(last.getTime())) return includeClock ? `- 时间：${formatClock(now)}。` : '- 上次对话时间无效。'
  const ms = Math.max(0, now - last)
  const when = ms >= 86400000 ? `（上次 ${formatClock(last)}）` : ''
  return `- ${clock}距上次对话 ${gapText(ms)}${when}。`
}

const hm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (mi > 59) return null
  if (h === 24) return mi === 0 ? 1440 : null
  return h < 24 ? h * 60 + mi : null
}

export function inClassWindow(window, now) {
  if (!window || !Array.isArray(window.weekdays) || !window.weekdays.includes(now.getDay())) return false
  const from = hm(window.from), to = hm(window.to)
  if (from === null || to === null) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  return minutes >= from && minutes < to
}

export function modeLine(progress, classWindow, now = new Date()) {
  if (progress?.lesson) return `- 执教态：正在讲「${progress.lesson.node}」；先交付，讲完停，等他回应。`
  if (progress?.pending) return `- 执教态：押着一张卷（${progress.pending.node}）；先问他做完没或卡在哪，别开新点。`
  if (inClassWindow(classWindow, now)) return '- 执教态：在上课时段；先讲他要的，讲完停，等他回应。'
  return '- 日常态：先接话，别主动排课；他明确要训练时才进教练模式。'
}

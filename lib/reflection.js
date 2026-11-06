// 后台反思的内核：证据清单、提示词、严格解析、提案校验。
// 这一层不碰网络、不碰文件，纯函数，方便单测。
const PROPOSAL_KINDS = ['habit', 'anniversary', 'profile', 'library', 'episode', 'promise', 'boundary']
const STYLE_DIMENSIONS = ['sentence_rhythm', 'emoji', 'punctuation', 'directness', 'diction', 'formatting', 'other']
const MAX_PROPOSALS = 8
const MAX_SIGNALS = 8
const MIN_CONFIDENCE = 0.5
const MIN_ANNIVERSARY_CONFIDENCE = 0.8
const MIN_EPISODE_CONFIDENCE = 0.7
const MIN_PROMISE_CONFIDENCE = 0.7
const MIN_BOUNDARY_CONFIDENCE = 0.8
const CHANNELS = ['private', 'group', 'proactive', 'qzone', 'tts']
const RELATIONSHIP_STAGES = ['stranger', 'familiar', 'close', 'any']
const EMOTION_GATES = ['normal', 'positive', 'low', 'guarded', 'any']
const INTENTS = ['acknowledgement', 'question', 'request', 'help', 'comfort', 'play', 'tease', 'intimacy', 'boundary', 'emotion', 'casual', 'proactive', 'any']

import { createHash } from 'node:crypto'

const clean = (value) => String(value ?? '').trim()
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// 只挡最明确的秘密；宁可少挡，不要把正常句子打碎。
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /(?:password|passwd|密码|api[_-]?key|secret)\s*[:=：]\s*\S+/gi,
]

export function redact(text) {
  let value = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, '[REDACTED]')
  return value
}

export function normalizeApplicability(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const list = (input, allowed, fallback) => {
    const values = Array.isArray(input) ? [...new Set(input.filter(item => allowed.includes(item)))] : []
    return values.length ? values : fallback
  }
  return {
    channels: list(value.channels, CHANNELS, ['private']),
    relationship_stages: list(value.relationship_stages, RELATIONSHIP_STAGES, ['any']),
    emotion_gates: list(value.emotion_gates, EMOTION_GATES, ['any']),
    intent: INTENTS.includes(value.intent) ? value.intent : 'any',
    keywords: Array.isArray(value.keywords)
      ? [...new Set(value.keywords.map(clean).filter(Boolean).map(item => item.slice(0, 32)))].slice(0, 8)
      : [],
  }
}

export const REFLECTION_INSTRUCTION = `你是小鲸的记忆整理器。只根据本轮提供的原始用户消息和现有档案，提出少量值得沉淀的候选；允许不修改。
只写用户明确说过、有原话支持的东西。一次情绪、气话、玩笑、客套、沉默，不算长期偏好或性格。区分事实、自述、计划、第三方转述和角色自己的话。Bot 说过的话、档案里的旧结论、同源重复引用，都不是新证据。
每条候选必须带 evidence_handles（s 编号），只能引用本轮提供的消息。证据不足就不要提。没有值得记的就返回空 proposals。current.rejected 里是已经丢掉、不要再提的候选。
只输出 JSON，不要推理过程。顶层只有 summary 和 proposals。
kind 只能是：
- habit：互动习惯，fields 为 situation、action、boundary（boundary 可空）
- anniversary：关系里程碑，fields 为 label（2-48 字）、reason；confidence 必须 ≥0.8；一次最多 1 条；日期由系统从证据消息取，不要自己填
- profile：仅限用户明确给小鲸设定的偏好/背景，必须 subject="role"；fields 为 likes/dislikes/quirks/background。用户说“我喜欢…”是学生事实，留给 Hindsight，不提出为小鲸档案
- library：仅限用户明确安排小鲸阅读的书或文章，必须 subject="role"；fields 为 title、source、note、kind。用户自己在看的书不能当作小鲸在读
- episode：一段值得以后想起的共同经历，fields 为 summary（10–160 字，写发生了什么、他当时的状态或你们的约定，不写流水账、不把 Bot 的话写成他的事实）、tags（最多 5 个短词）；一次最多 1 条，confidence ≥0.7
- promise：她答应他的事，fields 为 text（4–120 字，必须是用户明确要求或双方明确约定的）、dueAt（YYYY-MM-DD，可空）；一次最多 1 条，confidence ≥0.7。她自己随口说的话、没有用户确认的事不算承诺
- boundary：他明确划过的线（不要叫某个称呼、不要提某个话题、不要催某件事、已有伴侣等），fields 为 text（2–120 字）；只收用户明确说过的原话，一次最多 1 条，confidence ≥0.8
每条 proposal：{ kind, fields, confidence, evidence_handles }；profile/library 另需 subject:"role"，明确属于小鲸而非学生
请调用 report_reflection 工具提交，不要把 JSON 写在正文里。`

export const REFLECTION_TOOL = {
  name: 'report_reflection',
  description: '提交本轮记忆反思的结构化结果。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      proposals: { type: 'array', items: { type: 'object' } },
    },
    required: ['summary', 'proposals'],
  },
}

export const STYLE_INSTRUCTION = `只观察可借鉴的表达形式：句长、节奏、标点、措辞、直接程度、排版。
不要从少量样本推断身份、性格、情绪、健康、关系或稳定偏好；一次说法不概括为长期习惯；证据不足就不提。
每条必须带 evidence_handles（s 编号），只能引用本轮提供的消息。
只输出 JSON：{ summary, signals: [...] }，signals 最多 8 条。
每条 signal：{ dimension, observation, pattern, situation, avoid, proposal, applicability, confidence, evidence_handles }
dimension 只能是 sentence_rhythm/emoji/punctuation/directness/diction/formatting/other。
pattern 要是能自然改写的具体说法或句法结构，不能只写「更自然、更简短」。
applicability：channels 选 private/group/proactive/qzone/tts（必须包含 private）；relationship_stages 选 stranger/familiar/close/any；emotion_gates 选 normal/positive/low/guarded/any；intent 选 acknowledgement/question/request/help/comfort/play/tease/intimacy/boundary/emotion/casual/proactive/any；keywords 最多 8 个简短情境词。
请调用 report_style 工具提交，不要把 JSON 写在正文里。`

export const STYLE_TOOL = {
  name: 'report_style',
  description: '提交本轮表达学习候选的结构化结果。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      signals: { type: 'array', items: { type: 'object' } },
    },
    required: ['summary', 'signals'],
  },
}

export function evidenceFromMessages(messages, max = 32) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => clean(message?.text))
    .slice(-max)
    .map((message, index) => {
      const time = message.time ? new Date(message.time) : null
      const text = redact(clean(message.text)).slice(0, 1000)
      return {
        handle: `s${index + 1}`,
        text,
        time: time && Number.isFinite(time.getTime()) ? time.toISOString() : '',
        messageId: clean(message.id).slice(0, 200),
        // A source digest + span lets a later retraction find every claim that
        // leaned on this exact message even after person.json is rebuilt.
        sourceDigest: createHash('sha256').update(text).digest('hex').slice(0, 32),
        span: { start: 0, end: text.length },
        ...(Number.isInteger(message.seq) && message.seq >= 0 ? { seq: message.seq } : {}),
      }
    })
}

export function buildMaterials(person, evidence, episode = null) {
  const current = {
    profile: person?.profile ?? {},
    milestones: (person?.relation?.milestones ?? []).map(item => ({ label: item.label, date: item.date })),
    habits: (person?.habits ?? []).map(item => ({ situation: item.situation, action: item.action })),
    library: (person?.library ?? []).map(item => ({ title: item.title, state: item.state })),
    episodes: (person?.episodes ?? []).slice(0, 5).map(item => ({ at: item.at, summary: item.summary })),
    promises: (person?.promises ?? []).filter(item => item.status === 'open').slice(0, 5)
      .map(item => ({ text: item.text, dueAt: item.dueAt })),
    boundaries: (person?.boundaries ?? []).slice(0, 8).map(item => item.text),
    pinned: (person?.pinned ?? []).slice(0, 12).map(item => item.text),
    style: (person?.style ?? []).filter(item => item.status === 'active').map(item => ({ dimension: item.dimension, pattern: item.pattern })),
    rejected: (person?.rejected ?? []).map(item => ({ kind: item.kind, fields: item.fields })),
  }
  return JSON.stringify({
    evidence: evidence.map(item => ({ handle: item.handle, text: item.text, time: item.time })),
    current,
    // Periodic private episode: bounded material for one 共同经历 proposal. It
    // is material, not evidence — proposals still have to cite `evidence`.
    ...(episode?.lines?.length ? {
      episode_material: {
        from: episode.from, to: episode.coveredThrough,
        lines: episode.lines.map(line => ({ speaker: 'user', text: line.text, at: line.at })),
      },
    } : {}),
    coverage: { count: evidence.length, from: evidence[0]?.time ?? '', to: evidence.at(-1)?.time ?? '' },
  }, null, 2)
}

function stripFence(text) {
  const value = String(text ?? '').trim()
  const lines = value.split('\n')
  if (lines.length >= 3 && /^```(json)?$/i.test(lines[0].trim()) && lines.at(-1).trim() === '```') {
    return lines.slice(1, -1).join('\n').trim()
  }
  return value
}

function parseJson(text) {
  const body = stripFence(text)
  if (!body) throw new Error('空输出')
  return JSON.parse(body)
}

function reject(reason, raw) {
  return { reason, raw }
}

function proposalFrom(raw, allowed, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '不是对象' }
  const keys = Object.keys(raw)
  if (keys.some(key => !['kind', 'subject', 'fields', 'confidence', 'evidence_handles'].includes(key))) {
    return { error: 'proposal 有多余字段' }
  }
  const kind = PROPOSAL_KINDS.includes(raw.kind) ? raw.kind : ''
  if (!kind) return { error: 'kind 不合法' }
  if (['profile', 'library'].includes(kind) && raw.subject !== 'role') {
    return { error: '角色档案候选必须明确 subject=role，不能采用学生自己的偏好或阅读' }
  }
  const confidence = Number(raw.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { error: 'confidence 不合法' }
  if (confidence < MIN_CONFIDENCE) return { error: 'confidence 太低' }
  if (kind === 'anniversary' && confidence < MIN_ANNIVERSARY_CONFIDENCE) return { error: '纪念日置信度不足 0.8' }
  if (kind === 'episode' && confidence < MIN_EPISODE_CONFIDENCE) return { error: '共同经历置信度不足 0.7' }
  if (kind === 'promise' && confidence < MIN_PROMISE_CONFIDENCE) return { error: '承诺置信度不足 0.7' }
  if (kind === 'boundary' && confidence < MIN_BOUNDARY_CONFIDENCE) return { error: '边界置信度不足 0.8' }
  const handles = Array.isArray(raw.evidence_handles) ? raw.evidence_handles.filter(value => typeof value === 'string') : []
  if (!handles.length) return { error: '没有证据' }
  if (handles.some(handle => !allowed.has(handle))) return { error: '未知证据 handle' }
  const fields = raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields) ? raw.fields : {}
  const evidence = handles.map(handle => {
    const item = allowed.get(handle)
    return {
      handle: item.handle,
      quote: item.text,
      time: item.time,
      messageId: item.messageId,
      sourceDigest: item.sourceDigest || '',
      span: item.span || null,
      ...(Number.isInteger(item.seq) ? { seq: item.seq } : {}),
    }
  })
  const cleanFields = {}
  if (kind === 'habit') {
    cleanFields.situation = clean(fields.situation).slice(0, 80)
    cleanFields.action = clean(fields.action).slice(0, 120)
    cleanFields.boundary = clean(fields.boundary).slice(0, 120)
    if (!cleanFields.situation || !cleanFields.action) return { error: '习惯缺场合或做法' }
  } else if (kind === 'anniversary') {
    cleanFields.label = clean(fields.label).slice(0, 48)
    cleanFields.reason = clean(fields.reason).slice(0, 320)
    if (cleanFields.label.length < 2) return { error: '纪念日名称太短' }
    const date = evidence[0]?.time ? new Date(evidence[0].time) : null
    if (!date || !Number.isFinite(date.getTime())) return { error: '证据没有可用时间' }
    cleanFields.date = ymd(date)
  } else if (kind === 'profile') {
    for (const key of ['likes', 'dislikes', 'quirks', 'background']) {
      if (fields[key] === undefined) continue
      if (!Array.isArray(fields[key])) return { error: `profile.${key} 不是数组` }
      const list = [...new Set(fields[key].map(clean).filter(Boolean).map(value => value.slice(0, 60)))].slice(0, 12)
      if (list.length) cleanFields[key] = list
    }
    if (!Object.keys(cleanFields).length) return { error: 'profile 没有有效字段' }
  } else if (kind === 'library') {
    cleanFields.title = clean(fields.title).slice(0, 120)
    cleanFields.source = clean(fields.source).slice(0, 200)
    cleanFields.note = clean(fields.note).slice(0, 300)
    cleanFields.kind = ['book', 'article', 'other'].includes(fields.kind) ? fields.kind : 'book'
    if (!cleanFields.title) return { error: 'library 缺标题' }
  } else if (kind === 'episode') {
    cleanFields.summary = clean(fields.summary).slice(0, 160)
    cleanFields.tags = Array.isArray(fields.tags)
      ? [...new Set(fields.tags.map(clean).filter(Boolean).map(value => value.slice(0, 16)))].slice(0, 5)
      : []
    if (cleanFields.summary.length < 10) return { error: '共同经历太短' }
    const date = evidence[0]?.time ? new Date(evidence[0].time) : null
    const at = date && Number.isFinite(date.getTime()) ? ymd(date) : ymd(now)
    cleanFields.at = at > ymd(now) ? ymd(now) : at
  } else if (kind === 'promise') {
    cleanFields.text = clean(fields.text).slice(0, 120)
    if (cleanFields.text.length < 4) return { error: '承诺太短' }
    cleanFields.dueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.dueAt ?? '')) ? String(fields.dueAt) : ''
    cleanFields.status = 'open'
  } else if (kind === 'boundary') {
    cleanFields.text = clean(fields.text).slice(0, 120)
    if (cleanFields.text.length < 2) return { error: '边界太短' }
  }
  return {
    proposal: {
      id: makeId('p'),
      kind,
      ...(raw.subject === 'role' ? { subject: 'role' } : {}),
      fields: cleanFields,
      evidence,
      confidence,
      createdAt: now.toISOString(),
      status: 'pending',
    },
  }
}

export function parseReflection(text, { allowedHandles, now = new Date() } = {}) {
  const allowed = allowedHandles instanceof Map
    ? allowedHandles
    : new Map((allowedHandles ?? []).map(item => [item.handle, item]))
  let data
  try { data = parseJson(text) } catch (error) { return { ok: false, reject: `JSON 解析失败：${error.message}`, summary: '', proposals: [], rejected: [] } }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !['summary', 'proposals'].includes(key))) {
    return { ok: false, reject: '顶层字段不合法', summary: '', proposals: [], rejected: [] }
  }
  if (typeof data.summary !== 'string' || data.summary.length > 500) {
    return { ok: false, reject: 'summary 不合法', summary: '', proposals: [], rejected: [] }
  }
  if (!Array.isArray(data.proposals) || data.proposals.length > MAX_PROPOSALS) {
    return { ok: false, reject: 'proposals 数量不合法', summary: '', proposals: [], rejected: [] }
  }
  const proposals = []
  const rejected = []
  const seen = new Set()
  let anniversaries = 0
  let episodes = 0
  let promises = 0
  let boundaries = 0
  for (const raw of data.proposals) {
    const result = proposalFrom(raw, allowed, now)
    if (result.error) { rejected.push(reject(result.error, raw)); continue }
    const proposal = result.proposal
    if (proposal.kind === 'anniversary') {
      if (anniversaries >= 1) { rejected.push(reject('一次最多 1 条纪念日', raw)); continue }
      anniversaries += 1
    }
    if (proposal.kind === 'episode') {
      if (episodes >= 1) { rejected.push(reject('一次最多 1 条共同经历', raw)); continue }
      episodes += 1
    }
    if (proposal.kind === 'promise') {
      if (promises >= 1) { rejected.push(reject('一次最多 1 条承诺', raw)); continue }
      promises += 1
    }
    if (proposal.kind === 'boundary') {
      if (boundaries >= 1) { rejected.push(reject('一次最多 1 条边界', raw)); continue }
      boundaries += 1
    }
    const key = JSON.stringify([proposal.kind, proposal.fields])
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push(proposal)
  }
  return { ok: true, reject: '', summary: data.summary, proposals, rejected }
}

export function parseStyle(text, { allowedHandles } = {}) {
  const allowed = allowedHandles instanceof Map
    ? allowedHandles
    : new Map((allowedHandles ?? []).map(item => [item.handle, item]))
  let data
  try { data = parseJson(text) } catch (error) { return { ok: false, reject: `JSON 解析失败：${error.message}`, summary: '', signals: [], rejected: [] } }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !['summary', 'signals'].includes(key))) {
    return { ok: false, reject: '顶层字段不合法', summary: '', signals: [], rejected: [] }
  }
  if (typeof data.summary !== 'string' || data.summary.length > 500) {
    return { ok: false, reject: 'summary 不合法', summary: '', signals: [], rejected: [] }
  }
  if (!Array.isArray(data.signals) || data.signals.length > MAX_SIGNALS) {
    return { ok: false, reject: 'signals 数量不合法', summary: '', signals: [], rejected: [] }
  }
  const signals = []
  const rejected = []
  const seen = new Set()
  for (const raw of data.signals) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { rejected.push(reject('不是对象', raw)); continue }
    const dimension = STYLE_DIMENSIONS.includes(raw.dimension) ? raw.dimension : ''
    const observation = clean(raw.observation).slice(0, 800)
    const pattern = clean(raw.pattern).slice(0, 400)
    if (!dimension || !observation || !pattern) { rejected.push(reject('dimension/observation/pattern 不完整', raw)); continue }
    const confidence = Number(raw.confidence)
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > 1) { rejected.push(reject('confidence 不合法', raw)); continue }
    const handles = Array.isArray(raw.evidence_handles) ? raw.evidence_handles.filter(value => typeof value === 'string') : []
    if (!handles.length || handles.some(handle => !allowed.has(handle))) { rejected.push(reject('证据 handle 不合法', raw)); continue }
    const key = `${dimension}\u0000${pattern}`
    if (seen.has(key)) continue
    seen.add(key)
    signals.push({
      id: makeId('st'),
      dimension,
      observation,
      pattern,
      situation: clean(raw.situation).slice(0, 240),
      avoid: clean(raw.avoid).slice(0, 240),
      proposal: clean(raw.proposal).slice(0, 400),
      applicability: normalizeApplicability(raw.applicability),
      confidence,
      evidence: handles.map(handle => {
        const item = allowed.get(handle)
        return {
          handle: item.handle,
          quote: item.text,
          time: item.time,
          messageId: item.messageId,
          ...(Number.isInteger(item.seq) ? { seq: item.seq } : {}),
        }
      }),
      createdAt: new Date().toISOString(),
      status: 'pending',
    })
  }
  return { ok: true, reject: '', summary: data.summary, signals, rejected }
}

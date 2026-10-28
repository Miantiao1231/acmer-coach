/** Short lesson continuity notes; teaching judgments never change mastery records. */
import { createHash, randomUUID } from 'node:crypto'

export function createTeachingNotes({ loadProgress, saveProgress, loadMap, getSessionQuery, now = () => new Date().toISOString() }) {
  const failure = (reject, node = '') => ({ ok: false, reject, node, notes: [], total: 0 })
  const legacyNoteId = (node, index) => `legacy:${createHash('sha256').update(`${node}\0${index}`).digest('hex')}`
  const noteIdOf = (note, node, index) => typeof note?.noteId === 'string' && note.noteId ? note.noteId : legacyNoteId(node, index)
  const publicEvidence = (value) => value && typeof value.sessionId === 'string' && Number.isInteger(value.seq)
    && typeof value.messageId === 'string' && typeof value.quote === 'string'
    ? { sessionId: value.sessionId, seq: value.seq, messageId: value.messageId, quote: value.quote } : null
  const publicRevision = (revision) => {
    const evidence = publicEvidence(revision?.studentEvidence)
    return { at: String(revision?.at ?? ''), summary: String(revision?.summary ?? ''),
      nextStep: String(revision?.nextStep ?? ''), supersededAt: String(revision?.supersededAt ?? ''),
      ...(evidence ? { studentEvidence: evidence } : {}) }
  }
  const publicNote = (note, node, index, includeHistory) => {
    const evidence = publicEvidence(note?.studentEvidence)
    return { noteId: noteIdOf(note, node, index), at: String(note?.at ?? ''),
      summary: String(note?.summary ?? ''), nextStep: String(note?.nextStep ?? ''),
      ...(typeof note?.revisedAt === 'string' ? { revisedAt: note.revisedAt } : {}),
      ...(evidence ? { studentEvidence: evidence } : {}),
      ...(includeHistory ? { revisions: Array.isArray(note?.revisions) ? note.revisions.map(publicRevision) : [] } : {}) }
  }
  const mostRecentNoteNode = (progress, ids) => {
    let latest = '', latestAt = ''
    for (const id of ids) {
      const at = progress.nodes[id]?.lessonNotes?.at(-1)?.at
      if (at && at >= latestAt) { latest = id; latestAt = at }
    }
    return latest
  }
  const resolveNode = (progress, node) => {
    if (node !== undefined) return typeof node === 'string' ? node.trim() : ''
    return mostRecentNoteNode(progress, Object.keys(progress.pendingActions || {}))
      || progress.cursor || mostRecentNoteNode(progress, Object.keys(progress.nodes))
  }
  const meaningful = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

  async function source(studentQuote, exec) {
    const fail = reject => ({ ok: false, reject })
    if (!meaningful(studentQuote, 1500)) return fail('请提供当前会话的学生完整报告原话，最多 1500 字。')
    const sessionId = exec?.agent?.session?.id
    if (!meaningful(sessionId, 500)) return fail('无法核对学生原话：当前调用缺少会话标识。')
    try {
      const query = getSessionQuery?.()
      if (typeof query?.readSession !== 'function') return fail('无法核对学生原话：宿主未提供会话查询服务。')
      const snapshot = await query.readSession(sessionId)
      if (snapshot?.session?.id && snapshot.session.id !== sessionId) return fail('会话查询返回了其他会话，未写入记录。')
      const event = Array.isArray(snapshot?.events) && snapshot.events.findLast(event => {
        const message = event.data
        return event.type === 'user/message' && message?.role === 'user' && message.source?.kind === 'user'
          && Number.isInteger(event.seq) && event.seq >= 0 && meaningful(message.id, 500)
          && Array.isArray(message.content) && message.content.filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text).join('\n').includes(studentQuote)
      })
      if (!event) return fail('当前会话中没有可核对的这段学生原话，未写入记录。')
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const start = text.indexOf(studentQuote)
      return { ok: true, reject: '', start, end: start + studentQuote.length,
        studentEvidence: { sessionId, seq: event.seq, messageId: event.data.id, quote: studentQuote } }
    } catch { return fail('会话查询失败，学生原话尚未核对，未写入记录。') }
  }

  function read({ node, limit = 5, includeHistory = false } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return failure('读取条数须为 1 到 20 的整数。')
    const progress = loadProgress()
    node = resolveNode(progress, node)
    if (!node || !loadMap().byId.has(node)) return failure('请指定有效的知识点或先设置游标。', node)
    const notes = progress.nodes[node]?.lessonNotes || []
    const start = Math.max(0, notes.length - limit)
    return { ok: true, reject: '', node,
      notes: notes.slice(start).map((note, offset) => publicNote(note, node, start + offset, includeHistory)), total: notes.length }
  }

  async function write({ node, summary, nextStep, studentQuote }, exec) {
    if (!meaningful(summary, 1000) || !meaningful(nextStep, 500)) return failure('教学摘要和下次接续必须有内容，分别最多 1000 和 500 字。')
    if (studentQuote !== undefined && !meaningful(studentQuote, 1500)) return failure('学生原话必须有内容，最多 1500 字。')
    let progress = loadProgress()
    node = node === undefined ? (progress.cursor || '') : typeof node === 'string' ? node.trim() : ''
    if (!node || !loadMap().byId.has(node)) return failure('请指定有效的知识点或先设置游标。', node)
    let studentEvidence = null
    if (studentQuote !== undefined) {
      const checked = await source(studentQuote, exec)
      if (!checked.ok) return failure(checked.reject, node)
      studentEvidence = checked.studentEvidence
      // Session lookup yields; keep any progress another tool saved in the meantime.
      progress = loadProgress()
    }
    const record = progress.nodes[node] || {}
    progress.nodes[node] = { ...record, lessonNotes: [...(record.lessonNotes || []), {
      noteId: `note:${randomUUID()}`, at: now(), summary: summary.trim(), nextStep: nextStep.trim(), studentEvidence,
    }] }
    saveProgress(progress)
    return read({ node })
  }

  async function revise({ node, noteId, summary, nextStep, studentQuote } = {}, exec) {
    if (!meaningful(noteId, 200)) return failure('请指定要更正的笔记 ID。')
    if (!meaningful(summary, 1000) || !meaningful(nextStep, 500)) return failure('更正后的教学摘要和下次接续必须有内容，分别最多 1000 和 500 字。')
    if (studentQuote !== undefined && !meaningful(studentQuote, 1500)) return failure('学生原话必须有内容，最多 1500 字。')
    if (node !== undefined && (typeof node !== 'string' || !loadMap().byId.has(node.trim()))) return failure('请指定有效的知识点。')
    let replacementEvidence = null
    if (studentQuote !== undefined) {
      const checked = await source(studentQuote, exec)
      if (!checked.ok) return failure(checked.reject)
      replacementEvidence = checked.studentEvidence
    }
    const progress = loadProgress()
    const matches = []
    for (const [id, record] of Object.entries(progress.nodes || {})) {
      if (node !== undefined && id !== node.trim()) continue
      const notes = Array.isArray(record?.lessonNotes) ? record.lessonNotes : []
      notes.forEach((note, index) => {
        if (noteIdOf(note, id, index) === noteId) matches.push({ id, index, note })
      })
    }
    if (matches.length !== 1) return failure(matches.length ? '笔记 ID 不唯一，未更正。' : '找不到这条笔记，未更正。', node || '')
    const { id, index, note } = matches[0]
    if (note.summary === summary.trim() && note.nextStep === nextStep.trim() && studentQuote === undefined) {
      return { ok: true, reject: '', node: id, notes: [publicNote(note, id, index, false)], total: progress.nodes[id].lessonNotes.length }
    }
    const studentEvidence = studentQuote === undefined ? note.studentEvidence ?? null : replacementEvidence
    const revisedAt = now()
    const previous = { at: note.at, summary: note.summary, nextStep: note.nextStep,
      studentEvidence: note.studentEvidence ?? null, supersededAt: revisedAt }
    const record = progress.nodes[id]
    const notes = [...record.lessonNotes]
    notes[index] = { ...note, noteId, summary: summary.trim(), nextStep: nextStep.trim(), studentEvidence,
      revisedAt, revisions: [...(Array.isArray(note.revisions) ? note.revisions : []), previous] }
    progress.nodes[id] = { ...record, lessonNotes: notes }
    saveProgress(progress)
    return { ok: true, reject: '', node: id, notes: [publicNote(notes[index], id, index, false)], total: notes.length }
  }

  function context(progress, preferredNode) {
    const node = resolveNode(progress, preferredNode)
    const note = progress.nodes[node]?.lessonNotes?.at(-1)
    if (!note) return ''
    const clip = (text, length) => text.replace(/\s+/g, ' ').slice(0, length)
    const lines = [
      `续课笔记 · ${clip(node, 60)} · ${note.at}`,
      `教练判断：${clip(note.summary, 200)}`,
      note.studentEvidence ? `学生原话已核对（不代表掌握）：${clip(note.studentEvidence.quote, 120)}` : '学生原话未核对；这是教练的教学观察。',
      `下次接续建议（可调整）：${clip(note.nextStep, 220)}`,
    ]
    return lines.join('\n')
  }
  return { read, write, revise, context, source }
}

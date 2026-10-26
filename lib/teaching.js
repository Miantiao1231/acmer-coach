/** Short lesson continuity notes; teaching judgments never change mastery records. */
export function createTeachingNotes({ loadProgress, saveProgress, loadMap, getSessionQuery, now = () => new Date().toISOString() }) {
  const failure = (reject, node = '') => ({ ok: false, reject, node, notes: [], total: 0 })
  const publicNote = ({ studentEvidence, ...note }) => studentEvidence ? { ...note, studentEvidence } : note
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

  function read({ node, limit = 5 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return failure('读取条数须为 1 到 20 的整数。')
    const progress = loadProgress()
    node = resolveNode(progress, node)
    if (!node || !loadMap().byId.has(node)) return failure('请指定有效的知识点或先设置游标。', node)
    const notes = progress.nodes[node]?.lessonNotes || []
    return { ok: true, reject: '', node, notes: notes.slice(-limit).map(publicNote), total: notes.length }
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
    progress.nodes[node] = { ...record, lessonNotes: [...(record.lessonNotes || []), { at: now(), summary: summary.trim(), nextStep: nextStep.trim(), studentEvidence }] }
    saveProgress(progress)
    return read({ node })
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
  return { read, write, context, source }
}

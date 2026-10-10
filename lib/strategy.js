// Goal-driven strategy layer for acmer-coach.
// It stores contest targets, VP evidence and postmortems separately from
// PROGRESS.yaml so the existing knowledge workflow keeps its meaning.
import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

const clean = (value) => String(value ?? '').trim()
const asArray = (value) => Array.isArray(value) ? value : []
const isoDay = (value) => {
  const day = clean(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const d = new Date(`${day}T12:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : ''
}

const emptyTarget = () => ({ version: 1, revision: 0, updated: '', contest: '', date: '', result: '', teamMode: 'solo', weeklyHours: 0, constraints: {}, priorities: [] })
const emptyVp = () => ({ version: 1, revision: 0, updated: '', events: [], postmortems: [] })

function readYaml(path, fallback) {
  try {
    const value = parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback()
  } catch (err) {
    if (err.code === 'ENOENT') return fallback()
    throw err
  }
}

function writeYaml(path, header, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  let moved = false
  try {
    writeFileSync(tmp, header + stringify(value, { lineWidth: 0 }), 'utf8')
    try { renameSync(tmp, path) } catch (err) {
      if (!['EPERM', 'EEXIST'].includes(err.code)) throw err
      // Windows sandbox may refuse rename over an existing file; keep the complete tmp file and replace by copy.
      try { unlinkSync(path) } catch (removeErr) { if (removeErr.code !== 'ENOENT') throw err }
      copyFileSync(tmp, path)
      unlinkSync(tmp)
    }
    moved = true
  } finally {
    if (!moved) {
      try { unlinkSync(tmp) } catch { /* best effort cleanup */ }
    }
  }
}

function normalizePriority(value) {
  if (!value || typeof value !== 'object') return null
  const id = clean(value.id || value.competency)
  const weight = Number(value.weight)
  if (!id || !Number.isFinite(weight) || weight <= 0) return null
  return { id, weight: Math.min(100, Math.round(weight)), reason: clean(value.reason) }
}

function normalizeProblem(value) {
  if (!value || typeof value !== 'object') return null
  const problemId = clean(value.problemId || value.id)
  if (!problemId) return null
  const status = clean(value.status || value.verdict || 'unknown').toUpperCase()
  return {
    problemId,
    status,
    readMinutes: Math.max(0, Number(value.readMinutes) || 0),
    solveMinutes: Math.max(0, Number(value.solveMinutes ?? value.elapsedMinutes) || 0),
    attempts: Math.max(0, Math.trunc(Number(value.attempts) || 0)),
    competencies: asArray(value.competencies || value.skills).map(clean).filter(Boolean).slice(0, 12),
    note: clean(value.note),
  }
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object') return null
  const eventId = clean(value.eventId || value.id)
  const contest = clean(value.contest || value.contestId)
  const date = isoDay(value.date || value.startedAt?.slice?.(0, 10))
  const durationMinutes = Math.max(0, Math.trunc(Number(value.durationMinutes) || 0))
  const problems = asArray(value.problems).map(normalizeProblem).filter(Boolean)
  if (!eventId || !contest || !date || !problems.length) return null
  return {
    eventId, contest, date, durationMinutes,
    virtual: value.virtual !== false,
    teamMode: clean(value.teamMode || 'solo'),
    problems,
    note: clean(value.note),
  }
}

function normalizePostmortem(value) {
  if (!value || typeof value !== 'object') return null
  const eventId = clean(value.eventId)
  if (!eventId) return null
  return {
    eventId,
    date: isoDay(value.date) || new Date().toISOString().slice(0, 10),
    competencies: asArray(value.competencies).map(clean).filter(Boolean).slice(0, 12),
    missedReads: asArray(value.missedReads).map(clean).filter(Boolean).slice(0, 20),
    decisionErrors: asArray(value.decisionErrors).map(clean).filter(Boolean).slice(0, 20),
    teamIssues: asArray(value.teamIssues).map(clean).filter(Boolean).slice(0, 20),
    rootCauses: asArray(value.rootCauses).map(clean).filter(Boolean).slice(0, 20),
    nextActions: asArray(value.nextActions).map(clean).filter(Boolean).slice(0, 20),
    note: clean(value.note),
  }
}

export function createStrategyStore({ dataDir, vpDir = dataDir, competenciesPath, now = () => new Date() }) {
  const targetPath = join(dataDir, 'TARGET.yaml')
  const vpPath = join(vpDir, 'VP_EVENTS.yaml')
  const validateTarget = (doc) => {
    const errors = []
    if (doc.version !== 1) errors.push('version 必须是 1')
    if (!Number.isInteger(doc.revision) || doc.revision < 0) errors.push('revision 必须是非负整数')
    if (!Array.isArray(doc.priorities)) errors.push('priorities 必须是数组')
    else if (doc.priorities.some((item) => !normalizePriority(item))) errors.push('priorities 含有无效的 id/weight')
    if (!doc.constraints || typeof doc.constraints !== 'object' || Array.isArray(doc.constraints)) errors.push('constraints 必须是对象')
    return errors
  }
  const validateVp = (doc) => {
    const errors = []
    if (doc.version !== 1) errors.push('version 必须是 1')
    if (!Number.isInteger(doc.revision) || doc.revision < 0) errors.push('revision 必须是非负整数')
    if (!Array.isArray(doc.events)) errors.push('events 必须是数组')
    else if (doc.events.some((item) => !normalizeEvent(item))) errors.push('events 含有无效记录')
    if (!Array.isArray(doc.postmortems)) errors.push('postmortems 必须是数组')
    else if (doc.postmortems.some((item) => !normalizePostmortem(item))) errors.push('postmortems 含有无效记录')
    return errors
  }
  const loadTarget = () => {
    const doc = { ...emptyTarget(), ...readYaml(targetPath, emptyTarget) }
    const errors = validateTarget(doc)
    if (errors.length) throw new Error(`TARGET.yaml 数据无效：${errors.join('；')}`)
    return doc
  }
  const loadVp = () => {
    const doc = { ...emptyVp(), ...readYaml(vpPath, emptyVp) }
    const errors = validateVp(doc)
    if (errors.length) throw new Error(`VP_EVENTS.yaml 数据无效：${errors.join('；')}`)
    return doc
  }
  const saveTarget = (doc) => writeYaml(targetPath, '# TARGET.yaml — 比赛目标与能力优先级\n', doc)
  const saveVp = (doc) => writeYaml(vpPath, '# VP_EVENTS.yaml — VP 记录与赛后复盘\n', doc)
  const loadCompetencies = () => readYaml(competenciesPath, () => ({ version: 1, competencies: [] })).competencies ?? []

  function target(action = 'read', args = {}) {
    let old
    try { old = loadTarget() } catch (err) {
      return { ok: false, reject: err.message, ...emptyTarget() }
    }
    if (action === 'read') return { ok: true, reject: '', ...old }
    if (!['set', 'clear'].includes(action)) return { ok: false, reject: 'action 只能是 read/set/clear。', ...old }
    if (args.expectedRevision !== old.revision) return { ok: false, reject: '目标版本已变化；先 read，再按当前 revision 更新。', ...old }
    if (action === 'clear') {
      const next = { ...emptyTarget(), revision: old.revision + 1, updated: now().toISOString() }
      saveTarget(next)
      return { ok: true, reject: '', ...next }
    }
    const date = clean(args.date)
    if (!clean(args.contest) || !isoDay(date) || !clean(args.result)) return { ok: false, reject: 'set 必须提供 contest、真实 YYYY-MM-DD 的 date 和 result。', ...old }
    const weeklyHours = Number(args.weeklyHours)
    if (!Number.isFinite(weeklyHours) || weeklyHours <= 0 || weeklyHours > 168) return { ok: false, reject: 'weeklyHours 必须在 0 和 168 之间。', ...old }
    const rawPriorities = asArray(args.priorities)
    const priorities = rawPriorities.map(normalizePriority).filter(Boolean)
    if (rawPriorities.length !== priorities.length) return { ok: false, reject: 'priorities 中有无效项；每项都要提供正数 weight 和非空 id。', ...old }
    if (!priorities.length) return { ok: false, reject: '至少给一个能力优先级：id + weight。', ...old }
    const known = new Set(loadCompetencies().map((item) => item.id))
    const unknown = priorities.map((item) => item.id).filter((id) => !known.has(id))
    if (unknown.length) return { ok: false, reject: `能力优先级没有范围卡片：${unknown.join('、')}。先补充 COMPETENCIES.yaml。`, ...old }
    const teamMode = clean(args.teamMode || old.teamMode || 'solo')
    if (!['solo', 'team'].includes(teamMode)) return { ok: false, reject: 'teamMode 只能是 solo 或 team。', ...old }
    const next = {
      ...old, contest: clean(args.contest), date, result: clean(args.result),
      teamMode, weeklyHours,
      constraints: args.constraints && typeof args.constraints === 'object' ? args.constraints : old.constraints,
      priorities, revision: old.revision + 1, updated: now().toISOString(),
    }
    saveTarget(next)
    return { ok: true, reject: '', ...next }
  }

  function vpImport(events = []) {
    let old
    try { old = loadVp() } catch (err) {
      return { ok: false, reject: err.message, imported: 0, total: 0, revision: 0, events: [], invalid: [] }
    }
    if (!Array.isArray(events) || !events.length) return { ok: false, reject: '至少导入一场含题目记录的 VP；空数组不会修改现有数据。', imported: 0, total: old.events.length, revision: old.revision, events: old.events, invalid: ['events 为空'] }
    const normalized = events.map(normalizeEvent)
    const invalid = normalized.map((event, index) => event ? '' : `第 ${index + 1} 条 VP 记录缺 eventId/contest/date/problems`).filter(Boolean)
    if (invalid.length) return { ok: false, reject: 'VP 导入被拒绝：' + invalid.join('；'), imported: 0, total: old.events.length, revision: old.revision, events: old.events, invalid }
    const existing = new Map(old.events.map((event) => [event.eventId, event]))
    for (const event of normalized) existing.set(event.eventId, event)
    const next = { ...old, events: [...existing.values()].sort((a, b) => `${a.date}|${a.eventId}`.localeCompare(`${b.date}|${b.eventId}`)), revision: old.revision + 1, updated: now().toISOString() }
    saveVp(next)
    return { ok: true, reject: '', imported: normalized.length, total: next.events.length, revision: next.revision, events: next.events, invalid: [] }
  }

  function postmortem(value) {
    const eventId = clean(value?.eventId)
    const vp = loadVp()
    if (!vp.events.some((event) => event.eventId === eventId)) return { ok: false, reject: `找不到 VP「${eventId}」，先导入这场 VP。`, postmortems: vp.postmortems }
    const record = normalizePostmortem(value)
    if (!record || (!record.competencies.length && !record.rootCauses.length && !record.nextActions.length)) return { ok: false, reject: '复盘至少要写 competencies、rootCauses 或 nextActions 之一。', postmortems: vp.postmortems }
    const list = vp.postmortems.filter((item) => item.eventId !== eventId)
    list.push(record)
    const next = { ...vp, postmortems: list, revision: vp.revision + 1, updated: now().toISOString() }
    saveVp(next)
    return { ok: true, reject: '', eventId, postmortems: next.postmortems, revision: next.revision }
  }

  function focus() {
    let targetDoc, vp
    try {
      targetDoc = loadTarget()
      vp = loadVp()
    } catch (err) {
      return {
        ok: false, reject: err.message, contest: '', deadline: '', focus: [], postponed: [],
        evidenceEvents: 0, postmortems: 0,
      }
    }
    const catalog = loadCompetencies()
    if (!targetDoc.contest) return {
      ok: false, reject: '还没有比赛目标，先用 coach_target set。', contest: '', deadline: '',
      focus: [], postponed: [], evidenceEvents: vp.events.length, postmortems: vp.postmortems.length,
    }
    const postmortemHits = new Map()
    for (const record of vp.postmortems) for (const id of [...record.competencies, ...record.rootCauses]) postmortemHits.set(id, (postmortemHits.get(id) ?? 0) + 1)
    const problemHits = new Map()
    for (const event of vp.events) {
      for (const id of new Set(event.problems.flatMap((problem) => problem.competencies))) {
        problemHits.set(id, (problemHits.get(id) ?? 0) + 1)
      }
    }
    const focus = targetDoc.priorities.map((priority) => {
      const meta = catalog.find((item) => item.id === priority.id) ?? { id: priority.id, title: priority.id, contestUse: '暂无比赛能力卡片，先补充定义。', nodes: [] }
      const evidence = (postmortemHits.get(priority.id) ?? 0) + (problemHits.get(priority.id) ?? 0)
      const urgency = Math.max(1, 30 - Math.floor((Date.parse(`${targetDoc.date}T12:00:00Z`) - Date.now()) / 86400000))
      const score = Math.round(priority.weight * (1 + evidence) * urgency / 10) / 10
      return { id: priority.id, title: meta.title ?? priority.id, score, evidenceCount: evidence, contestUse: meta.contestUse ?? '', nodes: meta.nodes ?? [], whyNow: evidence ? `最近复盘出现 ${evidence} 次相关问题；优先修复它。` : (priority.reason || '它是目标中的高权重能力，目前缺少 VP 证据。') }
    }).sort((a, b) => b.score - a.score)
    return { ok: true, reject: '', contest: targetDoc.contest, deadline: targetDoc.date, focus: focus.slice(0, 3), postponed: focus.slice(3).map((item) => item.id), evidenceEvents: vp.events.length, postmortems: vp.postmortems.length }
  }

  function scope(nodeOrId) {
    const catalog = loadCompetencies()
    const direct = catalog.find((item) => item.id === nodeOrId || item.nodes?.includes(nodeOrId))
    if (direct) return { ok: true, reject: '', found: true, ...direct }
    return { ok: false, reject: `「${nodeOrId}」还没有范围卡片，不能凭空编造适用范围；先补充 COMPETENCIES.yaml。`, found: false, id: nodeOrId, title: nodeOrId, contestUse: '', nodes: [], appliesTo: [], extensions: [], notFor: [], commonFailures: [], transferProblems: [], exitEvidence: [] }
  }

  function route(nodeOrId, { purpose = 'progress', courseBound = false } = {}) {
    const node = clean(nodeOrId)
    let targetDoc
    try { targetDoc = loadTarget() } catch (err) { return { ok: false, reject: err.message, node, purpose, courseBound: Boolean(courseBound), targetAligned: false, competencyIds: [] } }
    const base = { node, purpose, courseBound: Boolean(courseBound), targetAligned: true, competencyIds: [] }
    if (!targetDoc.contest || purpose !== 'progress' || courseBound) return { ok: true, reject: '', ...base }
    const catalog = loadCompetencies()
    const priorityIds = new Set(targetDoc.priorities.map((item) => item.id))
    const current = focus()
    const currentIds = new Set((current.focus ?? []).map((item) => item.id))
    const targetCards = catalog.filter((item) => priorityIds.has(item.id) && item.nodes?.includes(node))
    const currentCards = targetCards.filter((item) => currentIds.has(item.id))
    const mappedTarget = catalog.filter((item) => priorityIds.has(item.id) && item.nodes?.length)
    if (mappedTarget.length && !currentCards.length) {
      return { ok: false, reject: `「${node}」不服务当前比赛重点；当前重点是 ${current.focus.map((item) => item.id).join('、')}。如果这是课程主线，请带 curriculumRevision；如果是补漏/复习，请声明 purpose 和 routeReason。`, ...base, targetAligned: false, competencyIds: targetCards.map((item) => item.id) }
    }
    return { ok: true, reject: '', ...base, targetAligned: currentCards.length > 0, competencyIds: currentCards.map((item) => item.id) }
  }

  function evidence() {
    try {
      const vp = loadVp()
      const result = []
      const baselineStatuses = new Set(['AC', 'OK', 'ACCEPTED', 'SOLVED'])
      for (const event of vp.events) for (const problem of event.problems) {
        const signal = baselineStatuses.has(problem.status) ? 'baseline' : 'gap'
        for (const competency of new Set(problem.competencies)) {
          const id = `vp:${event.eventId}:${problem.problemId}:${competency}`
          result.push({ id, eventId: event.eventId, source: 'vp', node: '', competency,
            date: event.date, signal, summary: `${problem.problemId} ${problem.status} · ${competency}`, fingerprint: id })
        }
      }
      for (const record of vp.postmortems) for (const competency of new Set(record.competencies)) {
        const id = `postmortem:${record.eventId}:${competency}`
        result.push({ id, eventId: record.eventId, source: 'postmortem', node: '', competency,
          date: record.date, signal: 'gap', summary: `复盘指出 ${competency}`, fingerprint: id })
      }
      return { ok: true, reject: '', evidence: result }
    } catch (err) { return { ok: false, reject: err.message, evidence: [] } }
  }

  function context() {
    const t = loadTarget()
    if (!t.contest) return '- 比赛目标：尚未建立；先用 coach_target set，不要把 rating 当成长期目标。'
    const f = focus()
    return [
      `- 比赛目标：${t.contest}，目标日期 ${t.date}，结果目标 ${t.result}，团队模式 ${t.teamMode}`,
      `- 当前目标权重：${t.priorities.map((p) => `${p.id}(${p.weight})`).join('、')}`,
      f.focus?.length ? `- 本轮优先能力：${f.focus.map((x) => `${x.title}（${x.whyNow}）`).join('；')}` : '- 当前没有可计算的能力重点。',
      f.postponed?.length ? `- 暂缓能力：${f.postponed.join('、')}` : '',
      '- 每次布置前先说明它服务哪个比赛能力、适用范围、迁移题和退出条件。',
    ].filter(Boolean).join('\n')
  }

  return { target, vpImport, postmortem, focus, scope, route, evidence, context, loadTarget, loadVp, loadCompetencies }
}

export const normalizeVpEvent = normalizeEvent
export const normalizeVpPostmortem = normalizePostmortem

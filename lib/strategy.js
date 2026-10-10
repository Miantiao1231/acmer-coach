// Goal-driven strategy layer for acmer-coach.
// It stores contest targets, VP evidence and postmortems separately from
// PROGRESS.yaml so the existing knowledge workflow keeps its meaning.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  writeFileSync(tmp, header + stringify(value, { lineWidth: 0 }), 'utf8')
  renameSync(tmp, path)
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

export function createStrategyStore({ dataDir, competenciesPath, now = () => new Date() }) {
  const targetPath = join(dataDir, 'TARGET.yaml')
  const vpPath = join(dataDir, 'VP_EVENTS.yaml')
  const loadTarget = () => ({ ...emptyTarget(), ...readYaml(targetPath, emptyTarget) })
  const loadVp = () => ({ ...emptyVp(), ...readYaml(vpPath, emptyVp) })
  const saveTarget = (doc) => writeYaml(targetPath, '# TARGET.yaml — 比赛目标与能力优先级\n', doc)
  const saveVp = (doc) => writeYaml(vpPath, '# VP_EVENTS.yaml — VP 记录与赛后复盘\n', doc)
  const loadCompetencies = () => readYaml(competenciesPath, () => ({ version: 1, competencies: [] })).competencies ?? []

  function target(action = 'read', args = {}) {
    const old = loadTarget()
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
    const priorities = asArray(args.priorities).map(normalizePriority).filter(Boolean)
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
    const old = loadVp()
    const normalized = events.map(normalizeEvent).filter(Boolean)
    const existing = new Map(old.events.map((event) => [event.eventId, event]))
    for (const event of normalized) existing.set(event.eventId, event)
    const next = { ...old, events: [...existing.values()].sort((a, b) => `${a.date}|${a.eventId}`.localeCompare(`${b.date}|${b.eventId}`)), revision: old.revision + 1, updated: now().toISOString() }
    saveVp(next)
    return { ok: true, reject: '', imported: normalized.length, total: next.events.length, revision: next.revision, events: next.events }
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
    const targetDoc = loadTarget()
    const vp = loadVp()
    const catalog = loadCompetencies()
    if (!targetDoc.contest) return {
      ok: false, reject: '还没有比赛目标，先用 coach_target set。', contest: '', deadline: '',
      focus: [], postponed: [], evidenceEvents: vp.events.length, postmortems: vp.postmortems.length,
    }
    const postmortemHits = new Map()
    for (const record of vp.postmortems) for (const id of [...record.competencies, ...record.rootCauses]) postmortemHits.set(id, (postmortemHits.get(id) ?? 0) + 1)
    const focus = targetDoc.priorities.map((priority) => {
      const meta = catalog.find((item) => item.id === priority.id) ?? { id: priority.id, title: priority.id, contestUse: '暂无比赛能力卡片，先补充定义。', nodes: [] }
      const evidence = postmortemHits.get(priority.id) ?? 0
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

  return { target, vpImport, postmortem, focus, scope, context, loadTarget, loadVp, loadCompetencies }
}

export const normalizeVpEvent = normalizeEvent
export const normalizeVpPostmortem = normalizePostmortem

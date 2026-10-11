// Goal-driven strategy layer for acmer-coach.
// It stores contest targets, VP evidence and postmortems separately from
// PROGRESS.yaml so the existing knowledge workflow keeps its meaning.
import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { createHash } from 'node:crypto'
import { validOccurredAt } from './curriculum-evidence.js'

const clean = (value) => String(value ?? '').trim()
const asArray = (value) => Array.isArray(value) ? value : []
const accepted = new Set(['AC', 'OK', 'ACCEPTED', 'SOLVED'])
const localDay = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
const nonnegative = (value, integer = false) => value === undefined ||
  (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value)))
const isoDay = (value) => {
  const day = clean(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  const d = new Date(`${day}T12:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : ''
}

const emptyTarget = () => ({ version: 1, revision: 0, updated: '', contest: '', date: '', result: '', teamMode: 'solo', weeklyHours: 0, profileId: '', constraints: {}, priorities: [] })
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
  if (!nonnegative(value.readMinutes) || !nonnegative(value.solveMinutes ?? value.elapsedMinutes) || !nonnegative(value.attempts, true) ||
      (value.independent !== undefined && typeof value.independent !== 'boolean') ||
      (value.occurredAt !== undefined && !validOccurredAt(value.occurredAt))) return null
  const status = clean(value.status || value.verdict || 'unknown').toUpperCase()
  return {
    problemId,
    status,
    readMinutes: value.readMinutes ?? 0,
    solveMinutes: value.solveMinutes ?? value.elapsedMinutes ?? 0,
    attempts: value.attempts ?? 0,
    competencies: asArray(value.competencies || value.skills).map(clean).filter(Boolean).slice(0, 12),
    note: clean(value.note),
    ...(typeof value.independent === 'boolean' ? { independent: value.independent } : {}),
    ...(typeof value.occurredAt === 'string' && Number.isFinite(Date.parse(value.occurredAt)) ? { occurredAt: value.occurredAt } : {}),
  }
}

function normalizeMeasurement(value) {
  if (!value || typeof value !== 'object' || !clean(value.competency) || !clean(value.metric) ||
      typeof value.value !== 'number' || !Number.isFinite(value.value) || typeof value.passed !== 'boolean' ||
      (value.independent !== undefined && typeof value.independent !== 'boolean') ||
      (value.occurredAt !== undefined && !validOccurredAt(value.occurredAt))) return null
  return { competency: clean(value.competency), metric: clean(value.metric), value: value.value, passed: value.passed,
    ...(value.independent !== undefined ? { independent: value.independent } : {}),
    ...(value.occurredAt !== undefined ? { occurredAt: value.occurredAt } : {}) }
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object') return null
  const eventId = clean(value.eventId || value.id)
  const contest = clean(value.contest || value.contestId)
  const date = isoDay(value.date || value.startedAt?.slice?.(0, 10))
  const durationMinutes = value.durationMinutes ?? 0
  const problems = asArray(value.problems).map(normalizeProblem)
  const measurements = asArray(value.measurements).map(normalizeMeasurement)
  if (!eventId || !contest || !date || !nonnegative(durationMinutes, true) || !problems.length || problems.some(problem => !problem) ||
      (value.measurements !== undefined && (!Array.isArray(value.measurements) || measurements.some(item => !item) ||
       new Set(measurements.map(item => `${item.competency}:${item.metric}`)).size !== measurements.length))) return null
  return {
    eventId, contest, date, durationMinutes,
    virtual: value.virtual !== false,
    teamMode: clean(value.teamMode || 'solo'),
    problems,
    note: clean(value.note),
    ...(value.measurements !== undefined ? { measurements } : {}),
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
    findings: asArray(value.findings).map(finding => ({ competency: clean(finding?.competency),
      status: clean(finding?.status), cause: clean(finding?.cause), evidenceRefs: asArray(finding?.evidenceRefs).map(clean) })),
  }
}

function vpFacts(vp) {
  const result = []
  for (const event of vp.events) for (const input of event.problems) {
    const problem = normalizeProblem(input)
    const hash = createHash('sha256').update(JSON.stringify({ eventId: event.eventId, date: event.date, teamMode: event.teamMode, problem })).digest('hex')
    for (const competency of new Set(problem.competencies.length ? problem.competencies : [''])) {
      const id = `vp:${encodeURIComponent(event.eventId)}:${encodeURIComponent(problem.problemId)}:${encodeURIComponent(competency)}:${hash}`
      result.push({ id, eventId: event.eventId, source: 'vp', node: '', competency, date: event.date,
        signal: accepted.has(problem.status) && problem.independent === true ? 'baseline' : 'observation',
        summary: `${problem.problemId} ${problem.status} · ${competency}`, fingerprint: hash,
        ...(typeof problem.independent === 'boolean' ? { independent: problem.independent } : {}),
        ...(problem.solveMinutes > 0 ? { minutes: problem.solveMinutes } : {}),
        ...(problem.occurredAt ? { occurredAt: problem.occurredAt } : {}), teamMode: event.teamMode })
    }
  }
  for (const event of vp.events) for (const measurement of event.measurements ?? []) {
    const hash = createHash('sha256').update(JSON.stringify({ eventId: event.eventId, date: event.date, teamMode: event.teamMode, measurement })).digest('hex')
    result.push({ id: `vp-metric:${encodeURIComponent(event.eventId)}:${encodeURIComponent(measurement.metric)}:${hash}`,
      eventId: event.eventId, source: 'vp', node: '', competency: measurement.competency, date: event.date,
      signal: measurement.passed && measurement.independent === true ? 'baseline' : 'observation',
      summary: `${measurement.metric} = ${measurement.value}（${measurement.passed ? '已验收' : '仅观察'}）`, fingerprint: hash,
      metric: measurement.metric, value: measurement.value, teamMode: event.teamMode,
      ...(measurement.independent !== undefined ? { independent: measurement.independent } : {}),
      ...(measurement.occurredAt !== undefined ? { occurredAt: measurement.occurredAt } : {}) })
  }
  return result
}

export function createStrategyStore({ dataDir, vpDir = dataDir, competenciesPath,
  nodeScopesPath = join(dirname(competenciesPath), 'NODE_SCOPES.yaml'),
  contestProfilesPath = join(dirname(competenciesPath), 'CONTEST_PROFILES.yaml'), now = () => new Date() }) {
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
  const loadProfiles = () => readYaml(contestProfilesPath, () => ({ profiles: [] })).profiles ?? []
  const profileFor = id => loadProfiles().find(item => item.id === id) ?? { id: '', title: '', scope: '', status: 'unselected',
    sources: [], competencyIds: [], selectionGuidance: [], limitations: ['未选择比赛样本配置；不能把通用能力卡当作本场考纲。'] }

  function target(action = 'read', args = {}) {
    let old
    try { old = loadTarget() } catch (err) {
      return { ok: false, reject: err.message, ...emptyTarget(), availableProfiles: [] }
    }
    const availableProfiles = action === 'profiles' ? loadProfiles() : []
    old.availableProfiles = availableProfiles
    if (['read', 'profiles'].includes(action)) return { ok: true, reject: '', ...old }
    if (!['set', 'clear'].includes(action)) return { ok: false, reject: 'action 只能是 read/profiles/set/clear。', ...old }
    if (args.expectedRevision !== old.revision) return { ok: false, reject: '目标版本已变化；先 read，再按当前 revision 更新。', ...old }
    if (action === 'clear') {
      const next = { ...emptyTarget(), revision: old.revision + 1, updated: now().toISOString() }
      saveTarget(next)
      return { ok: true, reject: '', ...next, availableProfiles: [] }
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
    const profileId = args.profileId === undefined ? old.profileId : clean(args.profileId)
    if (profileId && !loadProfiles().some(item => item.id === profileId)) return { ok: false, reject: 'profileId 不存在；先用 coach_target profiles 查看带出处的样本配置。', ...old }
    if (args.constraints !== undefined && (!args.constraints || typeof args.constraints !== 'object' || Array.isArray(args.constraints))) return { ok: false, reject: 'constraints 必须是对象；不会修改现有目标。', ...old }
    const next = {
      ...old, contest: clean(args.contest), date, result: clean(args.result), profileId,
      teamMode, weeklyHours,
      constraints: args.constraints && typeof args.constraints === 'object' ? args.constraints : old.constraints,
      priorities, revision: old.revision + 1, updated: now().toISOString(),
    }
    delete next.availableProfiles
    saveTarget(next)
    return { ok: true, reject: '', ...next, availableProfiles: [] }
  }

  function vpImport(events = [], { source = 'manual' } = {}) {
    let old
    try { old = loadVp() } catch (err) {
      return { ok: false, reject: err.message, imported: 0, total: 0, revision: 0, events: [], invalid: [] }
    }
    if (!Array.isArray(events) || !events.length) return { ok: false, reject: '至少导入一场含题目记录的 VP；空数组不会修改现有数据。', imported: 0, total: old.events.length, revision: old.revision, events: old.events, invalid: ['events 为空'] }
    const existing = new Map(old.events.map((event) => [event.eventId, event]))
    const inputs = events.map(event => {
      const previous = existing.get(clean(event?.eventId || event?.id))
      if (source !== 'sync' || !previous) return event
      return { ...event, ...(previous.measurements ? { measurements: previous.measurements } : {}), problems: asArray(event.problems).map(problem => {
        const prior = previous.problems.find(item => item.problemId === clean(problem?.problemId || problem?.id))
        if (!prior) return problem
        return { ...problem, competencies: prior.competencies, readMinutes: prior.readMinutes, note: prior.note,
          ...(prior.independent !== undefined ? { independent: prior.independent } : {}) }
      }) }
    })
    const normalized = inputs.map(normalizeEvent)
    const known = new Set(loadCompetencies().map(item => item.id))
    const invalid = normalized.map((event, index) => event && !(event.measurements ?? []).some(item => !known.has(item.competency)) ? '' :
      `第 ${index + 1} 条 VP 记录有无效身份、日期、题目、数值或测量；用时非负，次数为整数，measurement需已知competency/metric/有限value/passed`).filter(Boolean)
    if (invalid.length) return { ok: false, reject: 'VP 导入被拒绝：' + invalid.join('；'), imported: 0, total: old.events.length, revision: old.revision, events: old.events, invalid }
    for (const event of normalized) existing.set(event.eventId, event)
    const next = { ...old, events: [...existing.values()].sort((a, b) => `${a.date}|${a.eventId}`.localeCompare(`${b.date}|${b.eventId}`)), revision: old.revision + 1, updated: now().toISOString() }
    saveVp(next)
    return { ok: true, reject: '', imported: normalized.length, total: next.events.length, revision: next.revision, events: next.events, invalid: [] }
  }

  function postmortem(value) {
    const eventId = clean(value?.eventId)
    const vp = loadVp()
    const reject = message => ({ ok: false, reject: message, eventId, revision: vp.revision, postmortems: vp.postmortems })
    const event = vp.events.find(event => event.eventId === eventId)
    if (!event) return reject(`找不到 VP「${eventId}」，先导入这场 VP。`)
    const record = normalizePostmortem(value)
    if (!record || (!record.competencies.length && !record.rootCauses.length && !record.nextActions.length && !record.findings.length)) return reject('复盘至少要写 findings、competencies、rootCauses 或 nextActions 之一。')
    if (value.findings !== undefined && (!Array.isArray(value.findings) || value.findings.length > 30)) return reject('findings 必须是最多30条结论的数组。')
    const facts = vpFacts(vp)
    const known = new Set(loadCompetencies().map(item => item.id))
    const seen = new Set()
    for (const finding of record.findings) {
      if (!known.has(finding.competency) || seen.has(finding.competency)) return reject('每项 finding 必须对应已知且不重复的比赛能力。')
      seen.add(finding.competency)
      if (!['hypothesis', 'confirmed', 'resolved'].includes(finding.status) || finding.cause.length < 10) return reject('finding 需 hypothesis/confirmed/resolved 和至少10字的具体原因；未确认时只用 hypothesis。')
      if (!Array.isArray(value.findings.find(item => item?.competency === finding.competency)?.evidenceRefs) ||
          new Set(finding.evidenceRefs).size !== finding.evidenceRefs.length || !finding.evidenceRefs.length) return reject('finding 必须引用不重复的事实 evidenceRefs；先 coach_curriculum assess 取引用。')
      const cited = finding.evidenceRefs.map(id => facts.find(fact => fact.id === id && fact.eventId === eventId && (!fact.competency || fact.competency === finding.competency)))
      if (cited.some(fact => !fact)) return reject('finding 引用了不存在、已变化、其它场次或无关能力的事实。')
      if (finding.status === 'resolved' && !cited.some(fact => fact.signal === 'baseline')) return reject('resolved 需要真实独立成功的记录，不能把猜测或失败改成成功。')
    }
    // A retrospective is dated by its observed event, not by the day somebody edits it.
    record.date = event.date
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
        evidenceEvents: 0, postmortems: 0, profile: profileFor(''), daysRemaining: 0,
      }
    }
    const catalog = loadCompetencies()
    if (!targetDoc.contest) return {
      ok: false, reject: '还没有比赛目标，先用 coach_target set。', contest: '', deadline: '',
      focus: [], postponed: [], evidenceEvents: vp.events.length, postmortems: vp.postmortems.length, profile: profileFor(''), daysRemaining: 0,
    }
    const day = localDay(now())
    const cutoff = new Date(Date.parse(`${day}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10)
    const recent = evidence().evidence.filter(entry => entry.date >= cutoff && entry.date <= day)
    const focus = targetDoc.priorities.map((priority) => {
      const meta = catalog.find((item) => item.id === priority.id) ?? { id: priority.id, title: priority.id, contestUse: '暂无比赛能力卡片，先补充定义。', nodes: [] }
      const entries = recent.filter(entry => entry.competency === priority.id)
      const count = signal => new Set(entries.filter(entry => entry.signal === signal).map(entry => entry.eventId)).size
      const gapCount = count('gap'), baselineCount = count('baseline'), observationCount = count('observation')
      const evidenceCount = new Set(entries.map(entry => entry.eventId)).size
      const score = priority.weight * (1 + gapCount)
      const whyNow = gapCount ? `近30天有 ${gapCount} 场已确认的相关短板；结合目标权重优先处理。`
        : baselineCount ? `近30天有 ${baselineCount} 场独立完成的能力起点；不是待修复问题，是否进阶需核对迁移与限时表现。`
          : observationCount ? `近30天有 ${observationCount} 场相关观察，原因尚待确认；先诊断，不能直接安排补短板。`
            : (priority.reason || '它是目标中的高权重能力，目前缺少近期 VP 证据；先取证。')
      return { id: priority.id, title: meta.title ?? priority.id, score, evidenceCount, gapCount, baselineCount, observationCount,
        evidenceRefs: entries.map(entry => entry.id), contestUse: meta.contestUse ?? '', nodes: meta.nodes ?? [], whyNow }
    }).sort((a, b) => b.score - a.score)
    const daysRemaining = Math.round((Date.parse(`${targetDoc.date}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000)
    return { ok: true, reject: '', contest: targetDoc.contest, deadline: targetDoc.date, focus: focus.slice(0, 3), postponed: focus.slice(3).map((item) => item.id),
      evidenceEvents: vp.events.length, postmortems: vp.postmortems.length, profile: profileFor(targetDoc.profileId), daysRemaining }
  }

  function scope(nodeOrId) {
    const catalog = loadCompetencies()
    const nodeCards = readYaml(nodeScopesPath, () => ({ nodes: [] })).nodes ?? []
    const direct = nodeCards.find(item => item.id === nodeOrId) ?? catalog.find(item => item.id === nodeOrId || item.nodes?.includes(nodeOrId))
    const base = { id: nodeOrId, title: nodeOrId, contestUse: '', nodes: [], appliesTo: [], extensions: [], notFor: [],
      commonFailures: [], transferProblems: [], exitEvidence: [], recognition: [], proofQuestions: [], sources: [] }
    if (direct) return { ok: true, reject: '', found: true, ...base, ...direct }
    return { ok: false, reject: `「${nodeOrId}」还没有范围卡片，不能凭空编造适用范围；先补充 NODE_SCOPES.yaml 或 COMPETENCIES.yaml。`, found: false, ...base }
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
      const result = vpFacts(vp)
      for (const record of vp.postmortems) for (const competency of new Set(record.competencies)) {
        const id = `postmortem:${record.eventId}:${competency}`
        result.push({ id, eventId: record.eventId, source: 'postmortem', node: '', competency,
          date: record.date, signal: 'observation', summary: `复盘提及 ${competency}，原因尚待核实`, fingerprint: id })
      }
      const facts = new Map(result.filter(entry => entry.source === 'vp').map(entry => [entry.id, entry]))
      for (const record of vp.postmortems) for (const finding of record.findings ?? []) {
        const cited = finding.evidenceRefs.map(id => facts.get(id))
        if (!cited.length || cited.some(fact => !fact || fact.eventId !== record.eventId || (fact.competency && fact.competency !== finding.competency))) continue
        const hash = createHash('sha256').update(JSON.stringify(finding)).digest('hex')
        result.push({ id: `finding:${encodeURIComponent(record.eventId)}:${finding.competency}:${hash}`, eventId: record.eventId,
          source: 'postmortem', node: '', competency: finding.competency, date: cited[0].date,
          signal: finding.status === 'confirmed' ? 'gap' : 'observation',
          summary: `${finding.status === 'confirmed' ? '复盘已确认' : finding.status === 'resolved' ? '复盘已解决' : '待确认假设'}：${finding.cause}`, fingerprint: hash })
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
      `- 距目标日期：${f.daysRemaining}天；剩余时间影响训练取舍，不能只给所有能力乘同一紧急系数。`,
      `- 比赛样本配置：${f.profile.title || '尚未选择'}（${f.profile.status}）；${f.profile.limitations.join('；')}`,
      `- 当前目标权重：${t.priorities.map((p) => `${p.id}(${p.weight})`).join('、')}`,
      f.focus?.length ? `- 本轮优先能力：${f.focus.map((x) => `${x.title}（${x.whyNow}）`).join('；')}` : '- 当前没有可计算的能力重点。',
      f.postponed?.length ? `- 暂缓能力：${f.postponed.join('、')}` : '',
      '- 每次布置前先说明它服务哪个比赛能力、适用范围、迁移题和退出条件。',
      '- 重点排序是目标权重与近30天已确认问题的参考；不是掌握度或金牌概率。先区分观察、假设、确认结论。',
      '- 按长期能力目标→本次比赛目标→当前阶段→今天一个动作解释取舍；临近比赛不擅自覆盖长期目标。',
    ].filter(Boolean).join('\n')
  }

  return { target, vpImport, postmortem, focus, scope, route, evidence, context, loadTarget, loadVp, loadCompetencies }
}

export const normalizeVpEvent = normalizeEvent
export const normalizeVpPostmortem = normalizePostmortem

// 课程路线保存教学决定；进度和检测证据仍从 PROGRESS 读取。
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'yaml'
import { collectEvidence } from './curriculum-evidence.js'
import { normalizePhases, validatePlan, knownNodes, prerequisitesOf, missingFreshEvidence } from './curriculum-planning.js'

const clean = (value) => String(value ?? '').trim()
const dateOf = (now) => {
  const d = now()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function validDate(value) {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
}
export function createCurriculumStore({ dataDir, loadMap, loadProgress, loadSchedule = () => ({ days: {} }), now = () => new Date() }) {
  const path = join(dataDir, 'CURRICULUM.yaml')
  const evidence = () => collectEvidence(loadProgress(), loadSchedule()).filter((entry) => loadMap().byId.has(entry.node))
  function enter(doc, catalog) {
    doc.enteredAt = now().toISOString()
    doc.entryEvidenceRefs = catalog.filter((entry) => doc.phases[doc.current].nodes.includes(entry.node)).map((entry) => entry.id)
    doc.entryEvidenceEvents = catalog.filter((entry) => doc.phases[doc.current].nodes.includes(entry.node)).map((entry) => entry.eventId)
  }
  function budget(doc) {
    const remainingEstimatedHours = doc.status === 'complete' ? 0 : doc.phases.slice(doc.current).reduce((sum, phase) => sum + phase.estimatedHours, 0)
    const estimatedWeeks = doc.weeklyHours ? Math.round(remainingEstimatedHours / doc.weeklyHours * 100) / 100 : 0
    const budgetWarnings = []
    if (!doc.weeklyHours) budgetWarnings.push('每周可用时间未确认，暂不能判断路线是否装得进时间预算。')
    if (doc.status !== 'complete' && doc.phases.slice(doc.current).some((phase) => phase.kind === 'provisional' && !phase.estimatedHours)) budgetWarnings.push('远期待定阶段尚未估时，当前总时长不代表完整路线成本。')
    if (doc.deadline && doc.weeklyHours) {
      const today = dateOf(now)
      const days = Math.max(0, (Date.parse(`${doc.deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000 + 1)
      const capacity = Math.round(doc.weeklyHours * days / 7 * 100) / 100
      if (remainingEstimatedHours > capacity) budgetWarnings.push(`阶段预计剩余${remainingEstimatedHours}小时，高于目标日期前按每周预算粗估的${capacity}小时；先调整范围或目标，近期排程再核实实际容量。`)
    }
    return { remainingEstimatedHours, estimatedWeeks, budgetWarnings }
  }
  function load() {
    let raw
    try { raw = readFileSync(path, 'utf8') } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    const doc = parse(raw)
    if (!doc || ![1, 2].includes(doc.version) || !Number.isInteger(doc.revision) || doc.revision < 1 ||
      !['active', 'complete'].includes(doc.status) || typeof doc.goal !== 'string' || !clean(doc.goal) ||
      typeof doc.baseline !== 'string' || typeof doc.deadline !== 'string' ||
      typeof doc.focusUntil !== 'string' || typeof doc.updated !== 'string' ||
      !Number.isFinite(Date.parse(doc.updated)) ||
      !Array.isArray(doc.phases) || !Number.isInteger(doc.current) ||
      doc.current < 0 || doc.current >= doc.phases.length || !Array.isArray(doc.history) ||
      doc.history.some((entry) => !entry || !Number.isInteger(entry.revision) || entry.revision < 1 ||
        !['create', 'revise', 'advance'].includes(entry.action) ||
        ['reason', 'at', 'fromPhase', 'toPhase'].some((key) => typeof entry[key] !== 'string'))) {
      throw new Error('CURRICULUM.yaml 损坏或版本不支持，请检查文件；不会当作没有计划覆盖它。')
    }
    doc.phases = normalizePhases(doc.phases, loadMap().byId, { legacy: doc.version === 1, completed: doc.phases.slice(0, doc.current) })
    if (doc.version === 2 && (typeof doc.enteredAt !== 'string' || !Number.isFinite(Date.parse(doc.enteredAt)) ||
      !Array.isArray(doc.entryEvidenceRefs) || doc.entryEvidenceRefs.some((ref) => typeof ref !== 'string') ||
      !Array.isArray(doc.entryEvidenceEvents) || doc.entryEvidenceEvents.some((ref) => typeof ref !== 'string'))) {
      throw new Error('课程的阶段进入记录无效；不能猜测哪些记录是在本阶段产生的。')
    }
    if (!Array.isArray(doc.focusNodes) || new Set(doc.focusNodes).size !== doc.focusNodes.length ||
      doc.focusNodes.some((n) => !doc.phases[doc.current].nodes.includes(n)) ||
      !validDate(doc.focusUntil) || !validDate(doc.deadline) || !Number.isFinite(doc.weeklyHours) || doc.weeklyHours < 0 || doc.weeklyHours > 168) {
      throw new Error('课程的本周主线、时间预算或日期无效，请检查 CURRICULUM.yaml。')
    }
    return doc
  }
  function save(doc) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, '# 课程路线；进度与检测证据仍以 PROGRESS.yaml 为准。\n' + stringify(doc, { lineWidth: 0 }), 'utf8')
      renameSync(temporary, path)
    } finally {
      try { unlinkSync(temporary) } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
  }
  function snapshot(doc = load()) {
    const empty = {
      ok: true, reject: '', exists: false, revision: 0, status: 'none', goal: '', baseline: '',
      weeklyHours: 0, deadline: '', phaseId: '', phaseTitle: '', outcome: '', exitCriteria: '',
      focusNodes: [], focusUntil: '', focusExpired: false, requiredVerified: [], missingVerified: [],
      pendingNodes: [], roadmap: [], history: [], updated: '',
      needsReview: false, planningWarnings: [], evidence: [], evidenceCount: 0, evidenceTruncated: false,
      missingPrerequisites: [], missingFreshEvidence: [],
      remainingEstimatedHours: 0, estimatedWeeks: 0, budgetWarnings: [],
    }
    if (!doc) return empty
    const phase = doc.phases[doc.current]
    const progress = loadProgress()
    const catalog = evidence()
    const planningWarnings = []
    try { validatePlan(doc.phases, { byId: loadMap().byId, progress, catalog, current: doc.current }) }
    catch (err) { planningWarnings.push(err.message) }
    const missingPrerequisites = phase.prerequisites.filter((node) => !knownNodes(progress).has(node))
    return {
      ...empty, exists: true, revision: doc.revision, status: doc.status, goal: doc.goal,
      baseline: doc.baseline, weeklyHours: doc.weeklyHours, deadline: doc.deadline,
      phaseId: phase.id, phaseTitle: phase.title, outcome: phase.outcome, exitCriteria: phase.exitCriteria,
      focusNodes: doc.focusNodes.length ? doc.focusNodes : phase.nodes,
      focusUntil: doc.focusUntil, focusExpired: Boolean(doc.focusUntil && doc.focusUntil < dateOf(now)),
      requiredVerified: phase.requiredVerified,
      missingVerified: phase.requiredVerified.filter((n) => progress.nodes?.[n]?.status !== 'verified'),
      pendingNodes: Object.entries(progress.pendingActions ?? {})
        .filter(([, action]) => !action.curriculum || action.curriculum.phaseId === phase.id).map(([node]) => node),
      roadmap: doc.phases.map((p, i) => ({ ...p, position: i + 1, active: doc.status === 'active' && i === doc.current })),
      history: doc.history.map(({ revision, action, reason, at, fromPhase, toPhase }) => ({ revision, action, reason, at, fromPhase, toPhase })),
      updated: doc.updated,
      needsReview: planningWarnings.length > 0, planningWarnings,
      evidence: catalog.filter((entry) => phase.nodes.includes(entry.node)).slice(-200),
      evidenceCount: catalog.filter((entry) => phase.nodes.includes(entry.node)).length,
      evidenceTruncated: catalog.filter((entry) => phase.nodes.includes(entry.node)).length > 200,
      missingPrerequisites,
      missingFreshEvidence: doc.version === 2 ? missingFreshEvidence(phase, catalog, doc.entryEvidenceRefs, dateOf(() => new Date(doc.enteredAt)), doc.entryEvidenceEvents) : [...phase.nodes],
      ...budget(doc),
    }
  }
  function execute(args) {
    try {
      const old = load()
      const action = clean(args?.action) || 'read'
      if (action === 'read') return snapshot(old)
      if (action === 'assess') {
        const requested = args.evidenceNodes
        if (requested !== undefined && (!Array.isArray(requested) || requested.some((node) => typeof node !== 'string' || !loadMap().byId.has(node)))) throw new Error('evidenceNodes 必须是地图节点数组。')
        const catalog = evidence().filter((entry) => !requested?.length || requested.includes(entry.node))
        return { ...snapshot(old), evidence: catalog.slice(-200), evidenceCount: catalog.length, evidenceTruncated: catalog.length > 200 }
      }
      if (!['create', 'revise', 'advance'].includes(action)) throw new Error('action 只能是 assess/read/create/revise/advance。')
      if (args?.expectedRevision !== (old?.revision ?? 0)) throw new Error('课程版本已变动或未提供 expectedRevision；先 read，再按当前版本提交。')
      const reason = clean(args?.reason)
      if (reason.length < 10) throw new Error('写课程必须说明至少 10 字的依据；调整还要说明是什么证据改变了判断。')
      const byId = loadMap().byId
      const catalog = evidence()
      let doc
      if (action === 'create') {
        if (old?.status === 'active') throw new Error('已有有效路线，请 revise；不能用 create 悄悄替换正在执行的课程。')
        doc = {
          version: 2, goal: clean(args.goal), baseline: clean(args.baseline),
          weeklyHours: args.weeklyHours ?? 0, deadline: clean(args.deadline),
          phases: normalizePhases(args.phases, byId), current: 0, status: 'active',
          focusNodes: [], focusUntil: '', history: old?.history ?? [],
        }
        enter(doc, catalog)
      } else {
        if (!old || old.status !== 'active') throw new Error('没有有效路线；先 create，完成旧路线后也用 create 开新路线。')
        doc = structuredClone(old)
        if (action === 'advance') {
          const state = snapshot(old)
          if (state.needsReview) throw new Error(state.planningWarnings.join('；'))
          if (state.missingFreshEvidence.length) throw new Error(`本阶段尚缺新${old.phases[old.current].kind === 'diagnostic' ? '诊断' : '独立完成或过卷'}记录：${state.missingFreshEvidence.join('、')}。不能复用进入阶段之前的记录。`)
          if (state.missingVerified.length) throw new Error(`阶段还缺检测证据：${state.missingVerified.join('、')}。不会按日历自动推进。`)
          if (state.pendingNodes.length) throw new Error('当前阶段还有押着的动作，先完成或撤销，再决定推进。')
          if (loadProgress().pending) throw new Error('还有检测卷未判，先判卷或撤卷，再决定推进。')
          if (old.current === old.phases.length - 1) {
            if (old.phases[old.current].kind === 'diagnostic') throw new Error('诊断已有结果，但后续路线尚未建立；先按新证据 revise 追加阶段，再 advance。')
            doc.status = 'complete'
          } else {
            if (doc.phases[doc.current + 1].kind === 'provisional') throw new Error('下一阶段仍待定；先 revise 补齐训练依据，或明确改为诊断。')
            doc.current++
            enter(doc, catalog)
          }
          doc.focusNodes = []
          doc.focusUntil = ''
        } else {
          for (const key of ['goal', 'baseline', 'weeklyHours', 'deadline']) if (args[key] !== undefined) doc[key] = key === 'weeklyHours' ? args[key] : clean(args[key])
          if (args.phases !== undefined) {
            const phases = normalizePhases(args.phases, byId, { completed: old.phases.slice(0, old.current) })
            if (phases[old.current]?.id !== old.phases[old.current].id ||
              JSON.stringify(phases.slice(0, old.current)) !== JSON.stringify(old.phases.slice(0, old.current))) {
              throw new Error('修订不能重写已完成阶段或跳过当前阶段；阶段推进走 advance。')
            }
            if (old.phases[old.current].kind === 'diagnostic' &&
              (phases[old.current].kind !== 'diagnostic' || old.phases[old.current].nodes.some((node) => !phases[old.current].nodes.includes(node)))) {
              throw new Error('当前诊断不能通过 revise 改成训练或删掉待诊断节点；先产生新记录，再 advance。')
            }
            doc.phases = phases
            const workKeys = ['kind', 'nodes', 'outcome', 'exitCriteria', 'basis', 'finding', 'evidenceRefs']
            if (old.version === 1 || workKeys.some((key) => JSON.stringify(doc.phases[doc.current][key]) !== JSON.stringify(old.phases[old.current][key]))) enter(doc, catalog)
          }
        }
      }
      if (!doc.goal) throw new Error('必须填写长期能力目标。')
      if (!Number.isFinite(doc.weeklyHours) || doc.weeklyHours < 0 || doc.weeklyHours > 168) throw new Error('weeklyHours 应为 0–168；0 表示尚未确认。')
      if (!validDate(doc.deadline)) throw new Error('deadline 必须为空或真实的 YYYY-MM-DD 日期。')
      if (action !== 'advance') {
        if (args.focusNodes !== undefined) doc.focusNodes = Array.isArray(args.focusNodes) ? args.focusNodes.map(clean) : (() => { throw new Error('focusNodes 必须为数组。') })()
        if (args.focusUntil !== undefined) doc.focusUntil = clean(args.focusUntil)
      }
      if (new Set(doc.focusNodes).size !== doc.focusNodes.length || doc.focusNodes.some((n) => !doc.phases[doc.current].nodes.includes(n))) throw new Error('本周主线必须属于当前阶段，不能直接跳到未来阶段。')
      if (!validDate(doc.focusUntil)) throw new Error('focusUntil 必须为空或真实的 YYYY-MM-DD 日期。')
      validatePlan(doc.phases, { byId, progress: loadProgress(), catalog, current: doc.current })
      doc.version = 2
      doc.revision = (old?.revision ?? 0) + 1
      doc.updated = now().toISOString()
      const previous = old ? { ...old } : null
      if (previous) delete previous.history
      doc.history.push({ revision: doc.revision, action, reason, at: doc.updated,
        fromPhase: old?.phases[old.current].id ?? '', toPhase: doc.phases[doc.current].id, previous })
      save(doc)
      return snapshot(doc)
    } catch (err) {
      return { ...snapshot(null), ok: false, reject: err.message }
    }
  }
  function assignment({ node, revision, purpose = 'progress', reason = '' }) {
    const doc = load()
    if (!doc) return { ok: true, reject: '', binding: null }
    if (doc.status !== 'active') return { ok: false, reject: '课程已经完成，请先明确下一条路线。', binding: null }
    if (revision !== doc.revision) return { ok: false, reject: '先读 coach_curriculum，用当前 revision 绑定这次训练，避免沿用旧路线。', binding: null }
    const state = snapshot(doc)
    if (state.needsReview) return { ok: false, reject: state.planningWarnings.join('；'), binding: null }
    if (!['progress', 'remediation', 'review'].includes(purpose)) return { ok: false, reject: 'purpose 只能是 progress/remediation/review。', binding: null }
    if (purpose === 'progress') {
      if (state.focusExpired) return { ok: false, reject: '本周主线已到期，先复盘并 revise；不会自动换专题。', binding: null }
      if (!state.focusNodes.includes(node)) return { ok: false, reject: `「${node}」不在当前阶段主线；调整走 revise，补漏/复习要声明 purpose 和 routeReason。`, binding: null }
    } else if (clean(reason).length < 10) return { ok: false, reject: '补漏/复习需至少 10 字的 routeReason，说明与当前阶段的关系和回归条件。', binding: null }
    if (purpose === 'review' && !['learned', 'verified'].includes(loadProgress().nodes?.[node]?.status)) return { ok: false, reject: '复习节点应有学过或已验证的记录；首次学习不能伪装成复习。', binding: null }
    if (doc.phases[doc.current].kind === 'training') {
      const missing = prerequisitesOf([node], loadMap().byId).filter((dependency) => !knownNodes(loadProgress()).has(dependency))
      if (missing.length) return { ok: false, reject: `当前训练还缺显式前置记录：${missing.join('、')}；游标不会自动证明前置已掌握。`, binding: null }
    }
    const other = state.pendingNodes.filter((n) => n !== node)
    if (other.length) return { ok: false, reject: `当前单元还有未完成动作：${other.join('、')}。先完成或撤销，避免又换一节。`, binding: null }
    return { ok: true, reject: '', binding: { revision: doc.revision, phaseId: state.phaseId,
      phaseTitle: state.phaseTitle, purpose, reason: clean(reason) } }
  }
  function context() {
    try {
      const state = snapshot()
      if (!state.exists) return '- 长期路线：尚未建立；长期训练请求先用 coach_curriculum 建立路线。'
      return [
        `- 长期目标：${state.goal}；课程版本 ${state.revision}（${state.status}）`,
        `- 当前阶段：${state.phaseTitle}（${state.phaseId}）；能力成果：${state.outcome}`,
        `- 主线节点：${state.focusNodes.join('、')}`,
        `- 阶段验收：${state.exitCriteria}`,
        `- 阶段编排依据：${state.roadmap.find((phase) => phase.active)?.basis ?? ''}`,
        ...state.planningWarnings.map((warning) => `- 编排待核查：${warning}`),
        ...state.budgetWarnings.map((warning) => `- 时间预算：${warning}`),
        state.missingFreshEvidence.length ? `- 本阶段还需新记录：${state.missingFreshEvidence.join('、')}` : '',
        state.pendingNodes.length ? `- 当前未完成单元：${state.pendingNodes.join('、')}，先继续，不另开一节。` : '',
        state.focusExpired ? '- 本周主线已到期：先复盘修订，保持长期目标。' : '',
        '- 改路线用 coach_curriculum revise，阶段推进用 advance；临时问答不改主线。',
      ].filter(Boolean).join('\n')
    } catch (err) { return `- 长期路线读取失败：${err.message}；先核查，禁止猜测或覆盖。` }
  }
  return { path, load, snapshot, execute, assignment, context }
}

const stringList = { type: 'array', items: { type: 'string' } }
const phaseProperties = {
  id: { type: 'string', required: true }, title: { type: 'string', required: true },
  outcome: { type: 'string', required: true }, nodes: { ...stringList, required: true },
  exitCriteria: { type: 'string', required: true }, requiredVerified: stringList,
  kind: { type: 'string', required: true, enum: ['diagnostic', 'training', 'provisional', 'legacy'], description: '诊断/有证据训练/远期待定；legacy只用于保留已完成历史。' },
  finding: { type: 'string', required: true, enum: ['gap', 'extension', 'unknown'] },
  basis: { type: 'string', required: true, description: '具体观察或待确认问题，至少10字。' },
  goalContribution: { type: 'string', required: true, description: '怎样服务长期目标，至少10字。' },
  priorityReason: { type: 'string', required: true, description: '为什么先安排它，至少10字。' },
  estimatedHours: { type: 'number', required: true, description: '预计投入小时，诊断/训练为正数；待定可为0。' },
  evidenceRefs: { ...stringList, required: true, description: 'assess返回的真实id；训练每个节点需对应短板/基线记录。' },
  uncertainty: { type: 'string', required: true, description: '诊断/待定阶段至少10字写明尚未确认什么；训练可空。' },
  diagnosticMethod: { type: 'string', required: true, description: '诊断阶段至少10字写取得新记录的方法；其它可空。' },
}
export function curriculumTool(store) {
  const required = (type) => ({ type, required: true })
  return {
    name: 'coach_curriculum',
    description: '按真实记录编排长期课程：assess取检测/判因/训练的证据id；read查看路线；create建立；revise按证据调整；advance验收后推进。训练阶段必须逐节点有真实短板或进阶起点，并按显式前置与必验阶段排序；无依据先diagnostic，远期可provisional但不能直接执行。阶段需目标贡献、优先级理由、时间估算。写操作带expectedRevision和reason；诊断/训练验收都需进入阶段后的新事件，不能复用旧记录。',
    parameters: {
      action: { type: 'string', required: true, enum: ['assess', 'read', 'create', 'revise', 'advance'] },
      evidenceNodes: { ...stringList, description: 'assess可按地图节点过滤；最多返回200条，截断时缩小节点范围。' },
      expectedRevision: { type: 'integer', description: 'read 返回的版本；首次 create 为 0。' },
      goal: { type: 'string', description: '长期能力目标。' }, baseline: { type: 'string', description: '已核实的起点和待确认信息，不能猜测。' },
      weeklyHours: { type: 'number', description: '每周可用小时；0 表示未确认。' }, deadline: { type: 'string', description: '目标日期 YYYY-MM-DD，可留空。' },
      phases: { type: 'array', description: '按证据与前置排序；training所有节点必验；diagnostic收集新记录；provisional保留远期假设。', items: { type: 'object', additionalProperties: false, properties: phaseProperties } },
      focusNodes: { ...stringList, description: '当前阶段内的本周主线，空数组表示沿用阶段节点。' },
      focusUntil: { type: 'string', description: '本周主线截止日期 YYYY-MM-DD，可留空；到期先复盘。' },
      reason: { type: 'string', description: '建立/调整的依据；advance 时写验收证据及记录来源，至少 10 字。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: required('boolean'), reject: required('string'), exists: required('boolean'), revision: required('integer'),
        status: required('string'), goal: required('string'), baseline: required('string'), weeklyHours: required('number'),
        deadline: required('string'), phaseId: required('string'), phaseTitle: required('string'), outcome: required('string'),
        exitCriteria: required('string'), focusUntil: required('string'), focusExpired: required('boolean'), updated: required('string'),
        focusNodes: { ...stringList, required: true }, requiredVerified: { ...stringList, required: true },
        missingVerified: { ...stringList, required: true }, pendingNodes: { ...stringList, required: true },
        needsReview: required('boolean'), planningWarnings: { ...stringList, required: true },
        missingPrerequisites: { ...stringList, required: true }, missingFreshEvidence: { ...stringList, required: true },
        evidenceCount: required('integer'), evidenceTruncated: required('boolean'),
        remainingEstimatedHours: required('number'), estimatedWeeks: required('number'), budgetWarnings: { ...stringList, required: true },
        evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties:
          Object.fromEntries(['id', 'eventId', 'source', 'node', 'date', 'signal', 'summary', 'fingerprint'].map((key) => [key, required('string')])) } },
        roadmap: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          ...phaseProperties, requiredVerified: { ...stringList, required: true }, position: required('integer'), active: required('boolean'),
          prerequisites: { ...stringList, required: true },
        } } },
        history: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          revision: required('integer'), action: required('string'), reason: required('string'), at: required('string'),
          fromPhase: required('string'), toPhase: required('string'),
        } } },
      } },
      render: (args, state) => [{ type: 'text', text: !state.ok ? `❌ 课程未更新：${state.reject}`
        : args?.action === 'assess' ? ['【实际编排依据】',
          ...state.evidence.map((entry) => `${entry.id}\n  ${entry.date} ${entry.node} · ${entry.signal} · ${entry.summary}`),
          state.evidenceCount ? `共${state.evidenceCount}条${state.evidenceTruncated ? '，仅返回最后200条；按evidenceNodes缩小范围' : ''}` : '没有可用记录。先建立诊断阶段，不凭rating或状态断言短板。',
          ...state.planningWarnings,
        ].join('\n')
        : !state.exists ? '尚无长期课程。先assess核查真实记录；缺依据先diagnostic，未来假设用provisional。'
          : [`【长期课程 · 版本 ${state.revision} · ${state.status}】${state.goal}`,
            ...state.roadmap.map((p) => `${p.active ? '▶ ' : ''}${p.position}. ${p.title} [${p.kind}]：${p.outcome}\n  依据：${p.basis}\n  排序：${p.priorityReason}；预计${p.estimatedHours}小时`),
            `当前主线：${state.focusNodes.join('、')}`, `验收：${state.exitCriteria}`,
            state.missingVerified.length ? `必验缺口：${state.missingVerified.join('、')}` : '必验节点已有记录；仍需判断能力成果是否达到，不能自动推进。',
            state.pendingNodes.length ? `先完成当前单元：${state.pendingNodes.join('、')}` : '',
            state.focusExpired ? '本周主线到期，先复盘并修订。' : '',
            ...state.planningWarnings.map((warning) => `编排待核查：${warning}`),
            ...state.budgetWarnings.map((warning) => `时间预算：${warning}`),
            state.missingFreshEvidence.length ? `本阶段还缺新记录：${state.missingFreshEvidence.join('、')}` : '',
            '布置用 coach_assign，带 curriculumRevision；阶段达到验收后用 advance。',
          ].filter(Boolean).join('\n') }],
    },
    execute: (args) => store.execute(args),
  }
}

const clean = (value) => String(value ?? '').trim()
const text = (value, field, phase) => {
  const result = clean(value)
  if (result.length < 10) throw new Error(`阶段 ${phase} 的 ${field} 需要至少 10 字的具体依据。`)
  return result
}
const coreKeys = ['id', 'title', 'outcome', 'nodes', 'competencies', 'exitCriteria', 'requiredVerified']
export const corePhase = (phase) => Object.fromEntries(coreKeys.map((key) => [key, phase[key]]))

export function prerequisitesOf(nodes, byId) {
  const result = new Set()
  const done = new Set()
  const visiting = new Set()
  function walk(node) {
    if (visiting.has(node)) throw new Error(`地图前置出现循环：${node}。先修地图，不猜测课程顺序。`)
    if (done.has(node)) return
    const entry = byId.get(node)
    if (!entry) throw new Error(`前置「${node}」不在地图里。`)
    visiting.add(node)
    for (const dependency of entry.depends ?? []) {
      result.add(dependency)
      walk(dependency)
    }
    visiting.delete(node)
    done.add(node)
  }
  nodes.forEach(walk)
  nodes.forEach((node) => result.delete(node))
  return [...result].sort()
}

export function normalizePhases(input, byId, { legacy = false, completed = [] } = {}) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 30) throw new Error('课程需要 1–30 个阶段。')
  const ids = new Set()
  return input.map((phase, index) => {
    const kind = legacy ? 'legacy' : clean(phase?.kind)
    const p = {
      id: clean(phase?.id), title: clean(phase?.title), outcome: clean(phase?.outcome),
      nodes: Array.isArray(phase?.nodes) ? phase.nodes.map(clean) : [],
      competencies: Array.isArray(phase?.competencies) ? [...new Set(phase.competencies.map(clean).filter(Boolean))] : [],
      exitCriteria: clean(phase?.exitCriteria),
      requiredVerified: Array.isArray(phase?.requiredVerified) ? phase.requiredVerified.map(clean)
        : (kind === 'training' || kind === 'legacy' ? [...(phase?.nodes ?? [])].map(clean) : []),
    }
    if (!p.id || p.id.length > 80 || ids.has(p.id)) throw new Error('阶段 id 必须非空且唯一，最长 80 字符。')
    ids.add(p.id)
    if (!p.title || !p.outcome || !p.exitCriteria) throw new Error(`阶段 ${p.id} 缺标题、能力成果或验收条件。`)
    if ((!p.nodes.length && !p.competencies.length) || p.nodes.length > 50 || new Set(p.nodes).size !== p.nodes.length) throw new Error(`阶段 ${p.id} 至少需要一个地图节点或比赛能力，地图节点最多 50 个。`)
    for (const node of p.nodes) if (!byId.has(node)) throw new Error(`阶段 ${p.id} 的节点「${node}」不在地图里。`)
    if (new Set(p.requiredVerified).size !== p.requiredVerified.length || p.requiredVerified.some((node) => !p.nodes.includes(node))) throw new Error(`阶段 ${p.id} 的必验节点必须属于该阶段，且不能重复。`)
    const prerequisites = prerequisitesOf(p.nodes, byId)
    if (legacy) return { ...p, kind, finding: 'unknown', basis: '', goalContribution: '', priorityReason: '',
      estimatedHours: 0, evidenceRefs: [], uncertainty: '', diagnosticMethod: '', prerequisites }
    if (kind === 'legacy' && completed[index]?.kind === 'legacy' &&
      JSON.stringify(corePhase(completed[index])) === JSON.stringify(p)) return { ...completed[index], prerequisites }
    if (!['diagnostic', 'training', 'provisional'].includes(kind)) throw new Error(`阶段 ${p.id} 必须声明 kind=diagnostic/training/provisional；旧路线需补齐编排依据。`)
    const finding = clean(phase.finding)
    if (kind === 'training' ? !['gap', 'extension'].includes(finding) : finding !== 'unknown') throw new Error(`阶段 ${p.id}：训练需声明 gap 或 extension；诊断/待定只能声明 unknown。`)
    if (!Array.isArray(phase.evidenceRefs) || phase.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim()) || new Set(phase.evidenceRefs).size !== phase.evidenceRefs.length) throw new Error(`阶段 ${p.id} 的 evidenceRefs 必须是不重复的真实记录引用数组。`)
    const estimatedHours = phase.estimatedHours
    if (!Number.isFinite(estimatedHours) || estimatedHours < 0 || estimatedHours > 10000 || (kind !== 'provisional' && estimatedHours === 0)) throw new Error(`阶段 ${p.id} 必须给正数 estimatedHours；待定阶段可用 0 表示未估算。`)
    if (kind === 'training' && p.nodes.some((node) => !p.requiredVerified.includes(node))) throw new Error(`训练阶段 ${p.id} 的节点必须全部列入 requiredVerified，不能用空验收绕过检测。`)
    if (kind !== 'training' && p.requiredVerified.length) throw new Error(`诊断/待定阶段 ${p.id} 不以既有 verified 验收，请使用新诊断记录。`)
    return { ...p, kind, finding, estimatedHours, prerequisites,
      basis: text(phase.basis, 'basis（观察或待确认问题）', p.id),
      goalContribution: text(phase.goalContribution, 'goalContribution（如何服务长期目标）', p.id),
      priorityReason: text(phase.priorityReason, 'priorityReason（为何先安排它）', p.id),
      evidenceRefs: [...phase.evidenceRefs],
      uncertainty: kind === 'training' ? clean(phase.uncertainty) : text(phase.uncertainty, 'uncertainty（尚未确认什么）', p.id),
      diagnosticMethod: kind === 'diagnostic' ? text(phase.diagnosticMethod, 'diagnosticMethod（怎么取得记录）', p.id) : clean(phase.diagnosticMethod),
    }
  })
}

export function knownNodes(progress) {
  return new Set(Object.entries(progress.nodes ?? {}).filter(([, entry]) => ['learned', 'verified'].includes(entry?.status)).map(([node]) => node))
}

export function validatePlan(phases, { byId, progress, catalog, current = 0 }) {
  if (phases[current].kind === 'legacy') throw new Error('当前旧阶段还没有编排依据；先 assess，再 revise 补齐当前及后续阶段。')
  if (phases[current].kind === 'provisional') throw new Error('待定阶段不可直接执行；先取得依据改为训练，或明确改为诊断。')
  const records = new Map(catalog.map((entry) => [entry.id, entry]))
  const available = knownNodes(progress)
  for (let i = current; i < phases.length; i++) {
    const phase = phases[i]
    for (const ref of phase.evidenceRefs) {
      const entry = records.get(ref)
      if (!entry) throw new Error(`阶段 ${phase.id} 的证据不存在或内容已变：${ref}。先 assess 重新取引用。`)
      const nodeMatch = entry.node && phase.nodes.includes(entry.node)
      const competencyMatch = entry.competency && phase.competencies.includes(entry.competency)
      if (!nodeMatch && !competencyMatch) throw new Error(`阶段 ${phase.id} 引用了无关的证据记录「${ref}」。`)
    }
    if (phase.kind !== 'training') continue
    const signal = phase.finding === 'gap' ? 'gap' : 'baseline'
    const uncovered = phase.nodes.filter((node) => !phase.evidenceRefs.some((ref) => {
      const entry = records.get(ref)
      return entry.node === node && entry.signal === signal
    }))
    if (uncovered.length) throw new Error(`阶段 ${phase.id} 的${signal === 'gap' ? '短板' : '进阶起点'}缺真实依据：${uncovered.join('、')}。先诊断；rating、状态或一段理由不能代替记录。`)
    const missingCompetencies = phase.competencies.filter((competency) => !phase.evidenceRefs.some((ref) => {
      const entry = records.get(ref)
      return entry.competency === competency && entry.signal === signal
    }))
    if (missingCompetencies.length) throw new Error(`阶段 ${phase.id} 的${signal === 'gap' ? '短板' : '进阶起点'}缺真实能力依据：${missingCompetencies.join('、')}。先记录 VP 或复盘，不用 rating 代替。`)
    // 同阶段节点按依赖顺序列出；只有前阶段的必验训练节点能作为未来前置。
    for (const node of phase.nodes) {
      const missing = prerequisitesOf([node], byId).filter((dependency) => !available.has(dependency))
      if (missing.length) throw new Error(`阶段 ${phase.id} 前置顺序不成立：「${node}」之前还缺 ${missing.join('、')}。先核实前置，或安排在此前的必验训练中。`)
      available.add(node)
    }
  }
}

export function missingFreshEvidence(phase, catalog, entryEvidenceRefs, enteredDate, entryEvidenceEvents = []) {
  const old = new Set(entryEvidenceRefs)
  const events = new Set(entryEvidenceEvents)
  const missingNodes = phase.nodes.filter((node) => !catalog.some((entry) => entry.node === node && !old.has(entry.id) &&
    !events.has(entry.eventId) && entry.date >= enteredDate && (phase.kind === 'diagnostic' || entry.signal === 'baseline')))
  const missingCompetencies = phase.competencies.filter((competency) => !catalog.some((entry) => entry.competency === competency && !old.has(entry.id) &&
    !events.has(entry.eventId) && entry.date >= enteredDate && (phase.kind === 'diagnostic' || entry.signal === 'baseline')))
  return [...missingNodes, ...missingCompetencies]
}

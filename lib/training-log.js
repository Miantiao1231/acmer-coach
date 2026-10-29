// Derived training history for the dashboard.
//
// This module deliberately has no write path. SCHEDULE, PROGRESS and
// CURRICULUM remain the only sources of truth; the dashboard gets a joined
// read model so a new account/workspace cannot silently fork the teaching log.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function dateText(value) {
  const text = String(value ?? '').trim()
  const authoredDate = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|T| )/)?.[1]
  if (authoredDate) {
    const parsedDay = Date.parse(`${authoredDate}T12:00:00Z`)
    if (!Number.isFinite(parsedDay) || new Date(parsedDay).toISOString().slice(0, 10) !== authoredDate) return ''
    return text === authoredDate || Number.isFinite(Date.parse(text)) ? authoredDate : ''
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : ''
}

function todayText() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function shiftDate(date, delta) {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function dateRange({ today, from, to, days }) {
  const end = dateText(to) || today
  const requestedFrom = dateText(from)
  const span = Math.max(1, Math.min(90, Number.isFinite(Number(days)) ? Math.round(Number(days)) : 14))
  const start = requestedFrom || shiftDate(end, -(span - 1))
  const safeStart = start <= end ? start : end
  const out = []
  for (let d = safeStart; d <= end && out.length < 90; d = shiftDate(d, 1)) out.push(d)
  return { from: out[0] || end, to: out.at(-1) || end, dates: out }
}

function nodeName(byId, node, competency) {
  if (competency) return competency
  const item = byId?.get?.(node)
  return String(item?.name || node || '未命名动作')
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function shortText(value, fallback = '') {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  return text || fallback
}

function pushEvent(days, date, event) {
  if (!DATE_RE.test(date) || !days.has(date)) return
  days.get(date).events.push(event)
}

function phaseStatus(snapshot, phase, index) {
  if (phase?.skipped === true) return 'skipped'
  const current = Number.isInteger(snapshot.current) ? snapshot.current
    : (Array.isArray(snapshot.roadmap) ? snapshot.roadmap.findIndex((item) => item?.active === true || item?.id === snapshot.phaseId) : -1)
  if (snapshot.status === 'complete' || index < current) return 'complete'
  if (index === current || phase?.active === true || phase?.id === snapshot?.phaseId) return 'current'
  return 'upcoming'
}

/**
 * Join the existing ledgers into a compact, UI-friendly read model.
 * `today` is injectable so this function stays deterministic in tests.
 */
export function buildTrainingLog({
  progress = {}, schedule = {}, curriculum = {}, vp = {}, byId = new Map(),
  today = todayText(), from = '', to = '', days = 14, passEvidence = () => ({ status: 'unknown' }),
} = {}) {
  const todayValue = dateText(today) || todayText()
  const range = dateRange({ today: todayValue, from, to, days })
  const buckets = new Map(range.dates.map((date) => [date, {
    date, planned: [], actual: [], events: [], plannedMinutes: 0, actualMinutes: 0,
  }]))
  const scheduleDays = schedule?.days && typeof schedule.days === 'object' ? schedule.days : {}

  for (const date of range.dates) {
    const source = scheduleDays[date] && typeof scheduleDays[date] === 'object' ? scheduleDays[date] : {}
    const day = buckets.get(date)
    day.rest = source.rest === true
    day.planned = (Array.isArray(source.planned) ? source.planned : []).map((block) => {
      const fromMin = String(block?.from ?? '')
      const toMin = String(block?.to ?? '')
      const a = /^\d{1,2}:\d{2}$/.test(fromMin) ? Number(fromMin.split(':')[0]) * 60 + Number(fromMin.split(':')[1]) : null
      const z = /^\d{1,2}:\d{2}$/.test(toMin) ? Number(toMin.split(':')[0]) * 60 + Number(toMin.split(':')[1]) : null
      const minutes = a !== null && z !== null && z > a ? z - a : 0
      return {
        from: fromMin, to: toMin, minutes,
        kind: shortText(block?.kind), kindName: shortText(block?.kindName, shortText(block?.kind, '训练')),
        node: shortText(block?.node), competency: shortText(block?.competency),
        nodeName: nodeName(byId, block?.node, block?.competency),
      }
    })
    day.plannedMinutes = day.planned.reduce((sum, item) => sum + item.minutes, 0)
    day.actual = (Array.isArray(source.actual) ? source.actual : []).map((item) => ({
      node: shortText(item?.node), competency: shortText(item?.competency),
      nodeName: nodeName(byId, item?.node, item?.competency),
      actualMin: numberOrNull(item?.actualMin), solved: item?.solved === true,
      ...(typeof item?.independent === 'boolean' ? { independent: item.independent } : {}),
      ...(shortText(item?.problemId) ? { problemId: shortText(item.problemId) } : {}),
      ...(shortText(item?.anchorSubmissionId) ? { anchorSubmissionId: shortText(item.anchorSubmissionId) } : {}),
      ...(shortText(item?.note) ? { note: shortText(item.note) } : {}),
    }))
    day.actualMinutes = day.actual.reduce((sum, item) => sum + (item.actualMin ?? 0), 0)
    if (day.rest) pushEvent(buckets, date, { type: 'rest', title: '休息日', detail: '主动安排休息，不计训练分钟' })
    for (const item of day.planned) {
      pushEvent(buckets, date, { type: 'planned', title: item.nodeName, detail: `${item.kindName} · ${item.minutes} 分钟`, node: item.node, competency: item.competency })
    }
    for (const item of day.actual) {
      const result = item.solved ? '完成' : '未完成'
      const minutes = item.actualMin === null ? '用时未记录' : `${item.actualMin} 分钟`
      pushEvent(buckets, date, { type: 'practice', title: item.nodeName, detail: `${result} · ${minutes}${item.independent === true ? ' · 独立' : item.independent === false ? ' · 有帮助' : ''}`, node: item.node, competency: item.competency, problemId: item.problemId || '', anchorSubmissionId: item.anchorSubmissionId || '' })
    }
  }

  const nodes = progress?.nodes && typeof progress.nodes === 'object' ? progress.nodes : {}
  for (const [node, record] of Object.entries(nodes)) {
    if (!record || typeof record !== 'object') continue
    const name = nodeName(byId, node, '')
    const statusDate = dateText(record.at)
    if (statusDate) pushEvent(buckets, statusDate, { type: 'status', title: name, detail: `标记为 ${shortText(record.status, '未学')}`, node })
    for (const note of Array.isArray(record.lessonNotes) ? record.lessonNotes : []) {
      const date = dateText(note?.at)
      if (date) pushEvent(buckets, date, { type: 'lesson', title: name, detail: shortText(note?.summary, '续课笔记'), nextStep: shortText(note?.nextStep), node })
    }
    for (const pass of Array.isArray(record.passes) ? record.passes : []) {
      const date = dateText(pass?.date)
      if (date) {
        const problemId = shortText(pass?.problemId)
        const day = buckets.get(date)
        const evidence = day ? passEvidence(pass, node, record.diagnoses ?? []) : { status: 'unknown' }
        const chainDetail = evidence?.status === 'linked'
          ? ` · 提交 ${evidence.attempts} 发，失败 ${evidence.failed} 发（${evidence.verdicts}）${evidence.diagnosisStatus === 'not-recorded' ? ' · 未见正式判因记录' : ''}` : ''
        const sameRound = item => item.node === node && (problemId ? item.problemId === problemId : true) &&
          (pass?.anchorSubmissionId ? item.anchorSubmissionId === String(pass.anchorSubmissionId) : !item.anchorSubmissionId)
        const alreadyLogged = day?.actual?.some(sameRound)
        if (alreadyLogged && chainDetail) {
          const event = day.events.find(item => item.type === 'practice' && sameRound(item))
          if (event) event.detail += chainDetail
        }
        if (!alreadyLogged) {
          pushEvent(buckets, date, { type: 'practice', title: name, detail: (pass?.solved === false ? '未完成记录' : `完成记录${pass?.independent === true ? ' · 独立' : pass?.independent === false ? ' · 有帮助' : ''}`) + chainDetail, node, problemId,
            anchorSubmissionId: shortText(pass?.anchorSubmissionId) })
          // coach_log normally writes SCHEDULE.actual and PROGRESS.passes together.
          // Older records or a partial disk failure can leave only the pass. Keep
          // that evidence visible and count its explicit minutes as a fallback;
          // never borrow the planned duration.
          if (day) {
            const minutes = numberOrNull(pass?.minutes ?? pass?.actualMin)
            day.actual.push({ node, competency: '', nodeName: name,
              actualMin: minutes, solved: pass?.solved === true,
              ...(typeof pass?.independent === 'boolean' ? { independent: pass.independent } : {}),
              ...(shortText(pass?.anchorSubmissionId) ? { anchorSubmissionId: shortText(pass.anchorSubmissionId) } : {}),
              ...(problemId ? { problemId } : {}) })
            day.actualMinutes += minutes ?? 0
          }
        }
      }
    }
    for (const check of Array.isArray(record.checks) ? record.checks : []) {
      const date = dateText(check?.date)
      if (date) pushEvent(buckets, date, { type: 'check', title: name, detail: `检测：${shortText(check?.outcome, '有结果')}`, node })
    }
    for (const diagnosis of Array.isArray(record.diagnoses) ? record.diagnoses : []) {
      const date = dateText(diagnosis?.date)
      if (date) pushEvent(buckets, date, { type: 'diagnosis', title: name, detail: shortText(diagnosis?.summary, shortText(diagnosis?.category, '判因记录')), node })
    }
  }

  const reviewed = new Set((Array.isArray(vp?.postmortems) ? vp.postmortems : []).map(item => item?.eventId))
  for (const event of Array.isArray(vp?.events) ? vp.events : []) {
    const date = dateText(event?.date)
    const eventId = shortText(event?.eventId)
    if (!date || !eventId) continue
    pushEvent(buckets, date, { type: 'vp', title: shortText(event?.contest, 'VP'), eventId,
      detail: `VP 记录 · ${Array.isArray(event?.problems) ? event.problems.length : 0} 题 · ${reviewed.has(eventId) ? '已关联复盘' : '暂无复盘'}` })
  }

  const dayRows = range.dates.map((date) => {
    const day = buckets.get(date)
    const hasActivity = day.planned.length > 0 || day.actual.length > 0 || day.events.some((event) => event.type !== 'planned')
    day.events.sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.title).localeCompare(String(b.title)))
    return {
      ...day,
      state: day.actual.length ? 'logged'
        : day.rest ? 'rest'
        : date < todayValue && day.planned.length && !day.events.some(event => event.type !== 'planned') ? 'planned-only'
          : hasActivity ? 'active' : 'empty',
      actualEntries: day.actual.length,
      untimedActualEntries: day.actual.filter((item) => item.actualMin === null).length,
      activityCount: day.events.length,
    }
  })

  const roadmap = Array.isArray(curriculum?.roadmap) ? curriculum.roadmap : []
  const phases = roadmap.map((phase, index) => ({
    id: shortText(phase?.id), title: shortText(phase?.title, `阶段 ${index + 1}`),
    kind: shortText(phase?.kind), status: phaseStatus(curriculum, phase, index),
    outcome: shortText(phase?.outcome), exitCriteria: shortText(phase?.exitCriteria),
    estimatedHours: numberOrNull(phase?.estimatedHours) ?? 0,
    nodes: Array.isArray(phase?.nodes) ? phase.nodes.map((id) => nodeName(byId, id, '') || id) : [],
    competencies: Array.isArray(phase?.competencies) ? phase.competencies : [],
    active: phase?.active === true,
    skippedMissing: Array.isArray(phase?.skippedMissing) ? phase.skippedMissing : [],
  }))
  const currentPhase = {
    id: shortText(curriculum?.phaseId), title: shortText(curriculum?.phaseTitle),
    outcome: shortText(curriculum?.outcome), exitCriteria: shortText(curriculum?.exitCriteria),
    focusNodes: Array.isArray(curriculum?.focusNodes) ? curriculum.focusNodes.map((id) => nodeName(byId, id, '') || id) : [],
    phaseCompetencies: Array.isArray(curriculum?.phaseCompetencies) ? curriculum.phaseCompetencies : [],
    missingVerified: Array.isArray(curriculum?.missingVerified) ? curriculum.missingVerified.map((id) => nodeName(byId, id, '') || id) : [],
    missingFreshEvidence: Array.isArray(curriculum?.missingFreshEvidence) ? curriculum.missingFreshEvidence : [],
    exitChecks: Array.isArray(curriculum?.exitCheckResults) ? curriculum.exitCheckResults : [],
    remainingEstimatedHours: numberOrNull(curriculum?.remainingEstimatedHours) ?? 0,
    estimatedWeeks: numberOrNull(curriculum?.estimatedWeeks) ?? 0,
    budgetWarnings: Array.isArray(curriculum?.budgetWarnings) ? curriculum.budgetWarnings : [],
  }

  // 「已记录」不等于「实际投入」：讲课、检测、VP 和没填分钟的练习都不在这个数里。
  // 汇总只说记录到的那部分；一条都没计时就报「有 N 条未计时」，不报 0。
  const actualMinutes = dayRows.reduce((sum, day) => sum + day.actualMinutes, 0)
  const actualEntries = dayRows.reduce((sum, day) => sum + day.actualEntries, 0)
  const untimedActualEntries = dayRows.reduce((sum, day) => sum + day.untimedActualEntries, 0)
  const timedActualEntries = actualEntries - untimedActualEntries

  return {
    ok: true, today: todayValue, from: range.from, to: range.to,
    cursor: shortText(progress?.cursor), updated: shortText(progress?.updated),
    totals: {
      plannedMinutes: dayRows.reduce((sum, day) => sum + day.plannedMinutes, 0),
      actualMinutes,
      actualEntries,
      untimedActualEntries,
      timedActualEntries,
      loggedDays: dayRows.filter((day) => day.actual.length > 0).length,
      activeDays: dayRows.filter((day) => day.activityCount > 0).length,
      recorded: {
        minutes: actualMinutes, timedEntries: timedActualEntries, untimedEntries: untimedActualEntries,
        text: timedActualEntries ? `${actualMinutes} 分钟`
          : untimedActualEntries ? `— / 有 ${untimedActualEntries} 条未计时` : '—',
      },
    },
    days: dayRows, curriculum: {
      exists: curriculum?.exists === true, status: shortText(curriculum?.status, 'none'),
      goal: shortText(curriculum?.goal), deadline: shortText(curriculum?.deadline),
      current: currentPhase, phases,
      history: Array.isArray(curriculum?.history) ? curriculum.history : [],
      needsReview: curriculum?.needsReview === true,
      // 目标和课程对不上时，今天卡片也要看得见同一句话 —— 只在小鲸那边报
      // 等于训练员永远不知道自己的计划是按旧目标排的。
      target: { state: shortText(curriculum?.targetState), note: shortText(curriculum?.targetNote) },
    },
  }
}


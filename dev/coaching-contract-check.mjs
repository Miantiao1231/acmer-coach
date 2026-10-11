import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function shape(schema, value) {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(key in schema.properties, `unexpected field ${key}`)
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      if (field.required) assert.ok(key in value, `missing field ${key}`)
      if (key in value) shape(field, value[key])
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value))
    if (schema.items) value.forEach(item => shape(schema.items, item))
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value))
  else assert.equal(typeof value, schema.type)
}

test('registered coaching tools expose cited findings, sourced teaching and complete refusal shapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-contract-'))
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  try {
    writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: []\n')
    process.env.COACH_DATA_DIR = dir
    process.env.COACH_DB = join(dir, 'unused.db')
    const { apply } = await import('../index.js?coaching-contract')
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, inject() {}, on() {} })
    const call = async (name, args) => {
      const tool = tools.get(name)
      const result = await tool.execute(args)
      shape(tool.output.schema, result)
      return result
    }
    assert.ok(tools.get('coach_postmortem').parameters.properties.findings)
    assert.ok(tools.get('coach_focus').output.schema.properties.profile.properties?.id, 'SDK needs explicit nested profile fields')
    assert.ok(tools.get('coach_vp_import').parameters.properties.events.items.properties.measurements)
    assert.ok((await call('coach_target', { action: 'profiles' })).availableProfiles.length)
    const missing = await call('coach_postmortem', { eventId: 'unknown', findings: [] })
    assert.equal(missing.ok, false)
    const target = await call('coach_target', { action: 'set', expectedRevision: 0, contest: '样本训练', date: '2026-10-17', result: '稳定发挥', weeklyHours: 25,
      priorities: [{ id: 'graph-modeling', weight: 10 }] })
    assert.equal(target.ok, true, target.reject)
    await call('coach_vp_import', { events: [{ eventId: 'vp-contract', contest: 'VP', date: '2026-10-10', problems: [{ problemId: 'A', status: 'WA' }] }] })
    const facts = await call('coach_curriculum', { action: 'assess' })
    const fact = facts.evidence.find(entry => entry.source === 'vp')
    assert.ok(fact)
    const saved = await call('coach_postmortem', { eventId: 'vp-contract', findings: [{ competency: 'graph-modeling', status: 'confirmed',
      cause: '对照题面和代码确认建图方向写反了', evidenceRefs: [fact.id] }] })
    assert.equal(saved.ok, true, saved.reject)
    const focus = await call('coach_focus', {})
    assert.equal(focus.focus[0].gapCount, 1)
    assert.match(focus.text, /已确认|确认短板/)
    const measurementImport = await call('coach_vp_import', { events: [{ eventId: 'measured-contract', contest: 'VP', date: '2026-10-10',
      problems: [{ problemId: 'A', status: 'AC' }], measurements: [{ competency: 'contest-reading', metric: 'missed-reading', value: 0, passed: true, independent: true }] }] })
    assert.equal(measurementImport.ok, true, measurementImport.reject)
    const measured = await call('coach_curriculum', { action: 'assess', evidenceEventIds: ['measured-contract'] })
    assert.equal(measured.evidence.find(entry => entry.metric === 'missed-reading')?.value, 0)
    const gap = (await call('coach_curriculum', { action: 'assess', evidenceEventIds: ['vp-contract'] })).evidence.find(entry => entry.signal === 'gap')
    const created = await call('coach_curriculum', { action: 'create', expectedRevision: 0, goal: '区域赛稳定建图', reason: '针对已经确认的建图错误，用两场零错误指标验收', phases: [{
      id: 'graph-measured', title: '稳定建图', kind: 'training', finding: 'gap', nodes: [], competencies: ['graph-modeling'],
      outcome: '两场不同的VP都能独立正确建模', exitCriteria: '两场独立验收无建模错误',
      basis: '对照题面和代码已确认建图方向错误', goalContribution: '减少区域赛建模题错误提交', priorityReason: '现有事实显示建模方向错误需要先修', estimatedHours: 5,
      evidenceRefs: [gap.id], uncertainty: '', diagnosticMethod: '', exitChecks: [{ competency: 'graph-modeling', minEvents: 2, independent: true, metric: 'model-errors', maxValue: 0 }],
    }] })
    assert.equal(created.ok, true, created.reject)
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    for (let i = 0; i < 2; i++) {
      assert.equal((await call('coach_vp_import', { events: [{ eventId: `metric-exit-${i}`, contest: 'VP', date, problems: [{ problemId: 'B', status: 'AC' }],
        measurements: [{ competency: 'graph-modeling', metric: 'model-errors', value: 0, passed: true, independent: true, occurredAt: new Date().toISOString() }] }] })).ok, true)
      const state = await call('coach_curriculum', { action: 'read' })
      assert.equal(state.exitCheckResults[0].matchedEvents, i + 1)
      if (i === 0) assert.equal((await call('coach_curriculum', { action: 'advance', expectedRevision: state.revision, reason: '只有一场，不能通过两场的验收条件' })).ok, false)
    }
    const finished = await call('coach_curriculum', { action: 'advance', expectedRevision: created.revision, reason: '两场不同的新VP都有独立且已验收的零建模错误测量' })
    assert.equal(finished.status, 'complete', finished.reject)
    const scope = await call('coach_scope', { id: '最短路' })
    assert.equal(scope.id, '最短路')
    assert.ok(scope.sources.length)
    assert.ok(scope.recognition.length)
    await call('coach_scope', { id: '不存在的卡片' })
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

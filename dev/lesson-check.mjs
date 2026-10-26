import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildTrainingLog } from '../lib/training-log.js'

// 教学模式：短回合记录学生回应，由教练决定下一步；独立完成仍要证据。
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coach-lesson-'))
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'MAP.yaml'),
    'meta: {version: 3}\nnodes:\n  - {id: 背包 DP, name: 背包 DP, domain: 动态规划, depends: []}\n')
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  process.env.COACH_DATA_DIR = join(dir, 'knowledge')
  process.env.COACH_DB = join(dir, 'unused.db')
  const tools = new Map(), hooks = new Map()
  const { apply } = await import(`../index.js?lesson=${dir.replace(/\\/g, '/')}`)
  apply({
    tools: { register(tool) { tools.set(tool.name, tool) } }, get() {}, effect: (cb) => cb(), inject() {},
    on(event, handler) { hooks.set(event, handler) },
  })
  const call = (name, args = {}) => tools.get(name).execute(args)
  return {
    dir, tools, hooks, call,
    cleanup() {
      for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a lesson records a student response without forcing five stages', async () => {
  const f = await fixture()
  try {
    const started = await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    assert.equal(started.ok, true, started.reject)
    assert.equal(started.stage, 'active')
    assert.match(started.text, /一句话/)
    assert.doesNotMatch(started.text, /第 1\/5 步/)

    const blocked = await f.call('coach_lesson', { action: 'advance' })
    assert.equal(blocked.ok, false, '没有学生证据就不能推进')
    assert.match(blocked.reject, /学生证据/)

    const moved = await f.call('coach_lesson', { action: 'advance', evidence: '他说：正序会让同一件物品用两次' })
    assert.equal(moved.ok, true, moved.reject)
    assert.equal(moved.stage, 'active')
    assert.equal(moved.evidenceCount, 1)
    assert.match(moved.next, /回应/)
  } finally { f.cleanup() }
})

test('ending before the independent solve is recorded as unverified', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP', problem: 'CF 1000' })
    const early = await f.call('coach_lesson', { action: 'end', outcome: 'unknown' })
    assert.equal(early.ok, true, early.reject)
    assert.equal(early.active, false)
    assert.match(early.text, /独立做题.*未核实/)
    assert.match(early.text, /未写续课笔记/)
    const saved = parse(readFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'utf8'))
    assert.equal(saved.nodes['背包 DP'], undefined, '空课时不能制造学习记录')
  } finally { f.cleanup() }
})

test('closing a lesson keeps its oral evidence in the existing continuity notes', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    await f.call('coach_lesson', { action: 'advance', evidence: '学生说：倒序是为了不重复拿同一件物品' })
    await f.call('coach_lesson', { action: 'advance', evidence: '学生写出状态转移，但还没有独立做题' })
    const ended = await f.call('coach_lesson', { action: 'end', outcome: 'unknown', evidence: '他解释倒序避免重复拿同一件物品，并写出状态转移；独立编码未验' })
    assert.equal(ended.ok, true, ended.reject)
    const saved = parse(readFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'utf8'))
    assert.equal(saved.lesson, undefined)
    assert.equal(saved.nodes['背包 DP'].lessonNotes.length, 1)
    assert.match(saved.nodes['背包 DP'].lessonNotes[0].summary, /倒序.*状态转移/)
    assert.doesNotMatch(saved.nodes['背包 DP'].lessonNotes[0].summary, /学生说：/)
    assert.match(saved.nodes['背包 DP'].lessonNotes[0].nextStep, /独立做题/)
    const note = await f.call('coach_note', { action: 'read', node: '背包 DP' })
    assert.equal(note.total, 1)
    const hook = f.hooks.get('agent/pre-step')
    const decision = await hook({ messages: [{ role: 'user' }], step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user' }] }))
    const injected = decision.messages.at(-1).content.map((block) => block.text).join('\n')
    assert.match(injected, /续课笔记.*背包 DP/)
    assert.match(injected, /倒序.*状态转移/)
    const day = note.notes[0].at.slice(0, 10)
    const log = buildTrainingLog({ progress: saved, today: day, days: 1 })
    assert.ok(log.days[0].events.some((event) => event.type === 'lesson' && /倒序/.test(event.detail)))
    assert.equal((await f.call('coach_lesson', { action: 'end', outcome: 'unknown' })).ok, false)
  } finally { f.cleanup() }
})

test('a mistaken classroom attribution can be corrected without duplicating the note', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    const noPrevious = await f.call('coach_lesson', { action: 'correct', evidence: '学生原话：倒序' })
    assert.equal(noPrevious.ok, false)
    await f.call('coach_lesson', { action: 'advance', evidence: '学生说：倒序因为已经会完整板子' })
    const corrected = await f.call('coach_lesson', { action: 'correct', evidence: '学生原话：倒序；完整板子是教练推测，尚未验证' })
    assert.equal(corrected.ok, true, corrected.reject)
    assert.equal(corrected.evidenceCount, 1, '更正不是一次新的学生回答')
    assert.match(corrected.text, /尚未验证/)
    const active = parse(readFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'utf8'))
    assert.equal(active.lesson.evidence[0].correctedAt?.length > 0, true)
    assert.equal(active.lesson.evidence[0].text, '学生原话：倒序；完整板子是教练推测，尚未验证')
    await f.call('coach_lesson', { action: 'end', outcome: 'unknown' })
    const saved = parse(readFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'utf8'))
    const summary = saved.nodes['背包 DP'].lessonNotes[0].summary
    assert.match(summary, /尚未验证/)
    assert.doesNotMatch(summary, /学生说：倒序因为已经会完整板子/)
    assert.equal(saved.nodes['背包 DP'].lessonNotes.length, 1)
  } finally { f.cleanup() }
})

test('an independent attempt can finish a lesson without artificial intermediate gates', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    const step = await f.call('coach_lesson', { action: 'advance', evidence: '他说倒序因为要读上一轮的值' })
    assert.equal(step.ok, true, step.reject)
    const blockedEnd = await f.call('coach_lesson', { action: 'end', outcome: 'independent' })
    assert.equal(blockedEnd.ok, false, '独立完成要有对应证据')
    const ended = await f.call('coach_lesson', { action: 'end', outcome: 'independent', evidence: '他自己写出倒序并通过样例' })
    assert.equal(ended.ok, true, ended.reject)
    assert.doesNotMatch(ended.text, /未核实/)
    assert.match(ended.text, /independent/)
  } finally { f.cleanup() }
})

test('lesson state survives another ledger writer and reaches the next turn', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    const response = '学生说：正序会重复拿同一件物品'
    const advanced = await f.call('coach_lesson', { action: 'advance', evidence: response })
    assert.match(advanced.text, /正序会重复拿同一件物品/)
    // 另一条写路径（coach_mark）不能把课时状态冲掉 —— 白名单漏字段就是这个症状。
    await f.call('coach_mark', { node: '背包 DP', status: 'studying' })
    const saved = parse(readFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'utf8'))
    assert.equal(saved.lesson?.stage, 'active', '课时状态必须留在账本里')

    const hook = f.hooks.get('agent/pre-step')
    const decision = await hook({ messages: [{ role: 'user' }], step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user' }] }))
    const text = decision.messages.at(-1).content.map((block) => block.text).join('\n')
    assert.match(text, /教学模式/)
    assert.match(text, /背包 DP/)
    assert.match(text, /正序会重复拿同一件物品/)
    assert.doesNotMatch(text, /游标：.*先问清/)
  } finally { f.cleanup() }
})

test('a recurring lesson window is saved once and injected into later turns', async () => {
  const f = await fixture()
  try {
    const invalid = await f.call('coach_schedule', { action: 'set_class_window', fromTime: '19:30', toTime: '19:00' })
    assert.equal(invalid.ok, false)
    const set = await f.call('coach_schedule', {
      action: 'set_class_window', fromTime: '19:00', toTime: '19:30', weekdays: [1, 2, 3, 4, 5, 6],
    })
    assert.equal(set.ok, true, set.reject)
    assert.deepEqual(set.classWindow, { from: '19:00', to: '19:30', weekdays: [1, 2, 3, 4, 5, 6] })
    assert.deepEqual(parse(readFileSync(join(f.dir, 'knowledge', 'SCHEDULE.yaml'), 'utf8')).classWindow, set.classWindow)
    const read = await f.call('coach_schedule')
    assert.deepEqual(read.classWindow, set.classWindow)
    const hook = f.hooks.get('agent/pre-step')
    const decision = await hook({ messages: [{ role: 'user' }], step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user' }] }))
    const text = decision.messages.at(-1).content.map((block) => block.text).join('\n')
    assert.match(text, /19:00.*19:30/)
    assert.match(text, /练习/)
    const cleared = await f.call('coach_schedule', { action: 'clear_class_window' })
    assert.equal(cleared.ok, true, cleared.reject)
    assert.equal(cleared.classWindow, undefined)
  } finally { f.cleanup() }
})

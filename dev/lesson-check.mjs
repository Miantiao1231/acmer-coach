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
    'meta: {version: 3}\nnodes:\n  - {id: 背包 DP, name: 背包 DP, domain: 动态规划, depends: []}\n  - {id: 最短路, name: 最短路, domain: 图论, depends: []}\n')
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, home: process.env.DSH_HOME }
  process.env.DSH_HOME = dir
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
      for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db], ['DSH_HOME', previous.home]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('active lessons keep only their own continuity note and problem in the next turn', async () => {
  const f = await fixture()
  try {
    await f.call('coach_note', { action: 'write', node: '最短路', summary: '其他课的距离定义', nextStep: '再看松弛' })
    await f.call('coach_note', { action: 'write', node: '背包 DP', summary: '公式讲法没讲通', nextStep: '改用一个物品容量为二的表格' })
    await f.call('coach_lesson', { action: 'start', node: '背包 DP', problem: '只有一件物品\n容量为二' })
    const hook = f.hooks.get('agent/pre-step')
    const turn = () => hook({ messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    const decision = await turn()
    const text = decision.messages.at(-1).content.map(block => block.text).join('\n')
    assert.match(text, /公式讲法没讲通/)
    assert.match(text, /改用一个物品容量为二的表格/)
    assert.match(text, /只有一件物品 容量为二/)
    assert.equal(text.split('续课笔记').length - 1, 1)
    assert.doesNotMatch(text, /其他课的距离定义|再看松弛/)
    assert.match(text, /不自动开启教学/)
    await f.call('coach_lesson', { action: 'end', outcome: 'unknown' })
    await f.call('coach_lesson', { action: 'start', node: '最短路' })
    const progressPath = join(f.dir, 'knowledge', 'PROGRESS.yaml')
    const progress = parse(readFileSync(progressPath, 'utf8'))
    delete progress.nodes['最短路'].lessonNotes
    // Keep an unrelated cursor note: an active lesson without notes must not borrow it.
    progress.cursor = '背包 DP'
    const { stringify } = await import('yaml')
    writeFileSync(progressPath, stringify(progress))
    const empty = await turn()
    assert.doesNotMatch(empty.messages.at(-1).content.map(block => block.text).join('\n'), /公式讲法没讲通|续课笔记/)
  } finally { f.cleanup() }
})

test('a lesson records a student response without forcing five stages', async () => {
  const f = await fixture()
  try {
    const started = await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    assert.equal(started.ok, true, started.reject)
    assert.equal(started.stage, 'active')
    assert.match(started.text, /学生现在的疑问/)
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

test('a concrete continuation survives closing and reopening without becoming mastery evidence', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP', problem: '上节题：一件物品\n容量二' + '，其余题面线索'.repeat(30) })
    await f.call('coach_lesson', { action: 'advance', evidence: '学生说公式没看懂，为什么不能正序' })
    const nextStep = '改用一个物品容量为二的表格，演示正序如何重复使用；听懂与否待核实'
    const ended = await f.call('coach_lesson', { action: 'end', outcome: 'unknown',
      evidence: '目前公式讲解未奏效，卡在同一物品重复使用' + '；其余讲解观察'.repeat(55), nextStep: `  ${nextStep}  ` })
    assert.equal(ended.ok, true, ended.reject)
    const note = await f.call('coach_note', { action: 'read', node: '背包 DP' })
    assert.equal(note.notes[0].nextStep, nextStep)
    assert.match(note.notes[0].summary, /公式讲解未奏效/)
    assert.match(note.notes[0].summary, /上节题：一件物品 容量二/)
    assert.match(note.notes[0].summary, /题面未核对/)
    await f.call('coach_lesson', { action: 'start', node: '背包 DP', problem: '一件物品装容量二的包' })
    const decision = await f.hooks.get('agent/pre-step')({ messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    const text = decision.messages.at(-1).content.map(block => block.text).join('\n')
    assert.match(text, /改用一个物品容量为二的表格/)
    assert.match(text, /上节题：一件物品 容量二/)
    assert.match(text, /目前公式讲解未奏效，卡在同一物品重复使用/)
    assert.match(text, /同知识点.*历史/)
    assert.match(text, /以当前题意和回应为准/)
    const saved = parse(readFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'utf8'))
    assert.notEqual(saved.nodes['背包 DP'].status, 'verified')
  } finally { f.cleanup() }
})

test('invalid continuation cannot partially close a lesson and an empty lesson cannot create a note', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP' })
    const path = join(f.dir, 'knowledge', 'PROGRESS.yaml')
    const before = readFileSync(path, 'utf8')
    for (const nextStep of ['', '   ', 'x'.repeat(501)]) {
      const result = await f.call('coach_lesson', { action: 'end', outcome: 'unknown', evidence: '公式还没讲懂', nextStep })
      assert.equal(result.ok, false, `invalid nextStep ${JSON.stringify(nextStep)}`)
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    for (const nextStep of [42, null]) {
      await assert.rejects(async () => f.call('coach_lesson', { action: 'end', outcome: 'unknown', evidence: '公式还没讲懂', nextStep }), /nextStep.*string/)
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    const ended = await f.call('coach_lesson', { action: 'end', outcome: 'unknown', nextStep: '下次用表格' })
    assert.equal(ended.ok, true, ended.reject)
    assert.match(ended.text, /未写续课笔记/)
    assert.equal((await f.call('coach_note', { action: 'read', node: '背包 DP' })).total, 0)
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
    assert.match(text, /正在接续/)
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
    // 用「昨天」的星期：核对时段事实，不从时段外推导必须练习。
    // 否则在 19:00–19:30 之间跑就会命中「在上课时段」，跟着日历自己红。
    const yesterday = (new Date().getDay() + 6) % 7
    const set = await f.call('coach_schedule', {
      action: 'set_class_window', fromTime: '19:00', toTime: '19:30', weekdays: [yesterday],
    })
    assert.equal(set.ok, true, set.reject)
    assert.deepEqual(set.classWindow, { from: '19:00', to: '19:30', weekdays: [yesterday] })
    assert.deepEqual(parse(readFileSync(join(f.dir, 'knowledge', 'SCHEDULE.yaml'), 'utf8')).classWindow, set.classWindow)
    const read = await f.call('coach_schedule')
    assert.deepEqual(read.classWindow, set.classWindow)
    const hook = f.hooks.get('agent/pre-step')
    const decision = await hook({ messages: [{ role: 'user' }], step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user' }] }))
    const text = decision.messages.at(-1).content.map((block) => block.text).join('\n')
    assert.match(text, /19:00.*19:30/)
    assert.match(text, /在时段外/)
    const cleared = await f.call('coach_schedule', { action: 'clear_class_window' })
    assert.equal(cleared.ok, true, cleared.reject)
    assert.equal(cleared.classWindow, undefined)
  } finally { f.cleanup() }
})

test('a reading turn gets her own background, not the student course state', async () => {
  const f = await fixture()
  try {
    await f.call('coach_lesson', { action: 'start', node: '背包 DP', problem: '只有一件物品\n容量为二' })
    const hook = f.hooks.get('agent/pre-step')
    const reading = {
      role: 'user', source: { kind: 'plugin:acmer-coach/reading' },
      content: [{ type: 'text', text: '现在是你的阅读时间。' }],
    }
    const decision = await hook({ messages: [reading], step: 1 },
      async () => ({ kind: 'enter', messages: [reading] }))
    const text = decision.messages.at(-1).content.map(block => block.text).join('\n')
    assert.match(text, /阅读时间/, 'the reading turn gets its own framing')
    assert.match(text, /coach_read/)
    assert.doesNotMatch(text, /正在接续|游标|押着一张卷|沿着学生当前卡点/)
  } finally { f.cleanup() }
})

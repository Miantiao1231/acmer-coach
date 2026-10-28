import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTeachingNotes } from '../lib/teaching.js'
import { buildTrainingLog } from '../lib/training-log.js'

const AT = '2026-10-11T10:00:00.000Z'
const EXEC = { agent: { session: { id: 'session-1' } } }
const QUOTE = '状态不需要保存选择顺序，只需要保存剩余容量。'
const userEvent = (overrides = {}) => ({
  type: 'user/message', seq: 7,
  data: { id: 'message-7', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: QUOTE }] },
  ...overrides,
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'acmer-coach-teaching-'))
  const path = join(root, 'PROGRESS.json')
  const initial = {
    version: 1, cursor: 'dp', updated: '2026-10-10',
    nodes: { dp: { status: 'verified', taught: '2026-10-09', passes: [{ date: '2026-10-10' }] } },
    pending: { node: 'graph', date: '2026-10-11', problems: ['fixture-problem'] },
    pendingActions: { dp: { node: 'dp', deliverable: '写出状态含义' } },
    verified_problems: { 'fixture-problem': { source: 'fixture' } },
  }
  writeFileSync(path, JSON.stringify(initial))
  t.after(() => { unlinkSync(path); rmdirSync(root) })
  const loadProgress = () => JSON.parse(readFileSync(path, 'utf8'))
  const saveProgress = (p) => { writeFileSync(path, JSON.stringify(p)); return p }
  const dependencies = {
    loadProgress, saveProgress,
    loadMap: () => ({ byId: new Map([['dp', { id: 'dp', name: '动态规划基础' }], ['graph', { id: 'graph', name: '最短路' }]]) }),
    getSessionQuery: () => undefined,
    now: () => AT,
  }
  return { initial, loadProgress, saveProgress, dependencies, create: () => createTeachingNotes(dependencies) }
}

test('续课笔记留在既有节点账本，重建后可读且不改变掌握与待测卷', async (t) => {
  const f = fixture(t)
  const result = await f.create().write({ summary: '状态含义还需检查', nextStep: '用三个物品的小例子让学生解释状态' })
  assert.equal(result.ok, true)
  assert.equal(result.node, 'dp')
  assert.deepEqual(result.notes, [{ noteId: result.notes[0].noteId, at: AT, summary: '状态含义还需检查', nextStep: '用三个物品的小例子让学生解释状态' }])
  assert.match(result.notes[0].noteId, /^note:/)
  assert.deepEqual(f.create().read(), result)
  const expected = structuredClone(f.initial)
  expected.nodes.dp.lessonNotes = [{ ...result.notes[0], studentEvidence: null }]
  assert.deepEqual(f.loadProgress(), expected)
})

test('按笔记 ID 更正时保留原文，但续课和训练日志只使用生效版本', async (t) => {
  const f = fixture(t)
  const notes = f.create()
  const written = await notes.write({ summary: '学生已掌握状态定义', nextStep: '直接开下一节' })
  const noteId = written.notes[0].noteId
  const revised = await notes.revise({ noteId, summary: '学生只说出状态含义，独立实现尚未验证', nextStep: '先让学生独立写出转移' })
  assert.equal(revised.ok, true, revised.reject)
  assert.equal(revised.total, 1, '更正不能算作新的一次教学')
  assert.equal(revised.notes[0].noteId, noteId)
  assert.equal(revised.notes[0].summary, '学生只说出状态含义，独立实现尚未验证')
  assert.doesNotMatch(notes.context(f.loadProgress()), /已掌握|直接开下一节/)
  assert.match(notes.context(f.loadProgress()), /独立实现尚未验证/)
  const saved = f.loadProgress().nodes.dp.lessonNotes
  assert.equal(saved.length, 1)
  assert.equal(saved[0].revisions.length, 1)
  assert.equal(saved[0].revisions[0].summary, '学生已掌握状态定义')
  const log = buildTrainingLog({ progress: f.loadProgress(), today: '2026-10-11', days: 1 })
  const lessonEvents = log.days[0].events.filter((event) => event.type === 'lesson')
  assert.equal(lessonEvents.length, 1)
  assert.match(lessonEvents[0].detail, /独立实现尚未验证/)
  assert.doesNotMatch(lessonEvents[0].detail, /已掌握/)
})

test('旧课时笔记也能按稳定 ID 更正，历史仅在显式请求时返回', async (t) => {
  const f = fixture(t)
  const progress = f.loadProgress()
  progress.nodes.dp.lessonNotes = [{ at: AT, summary: '误记：已经独立完成', nextStep: '进入新知识点', studentEvidence: null }]
  f.saveProgress(progress)
  const notes = f.create()
  const noteId = notes.read({ node: 'dp' }).notes[0].noteId
  assert.match(noteId, /^legacy:/)
  assert.equal(f.create().read({ node: 'dp' }).notes[0].noteId, noteId)
  const corrected = await notes.revise({ noteId, summary: '目前只有口头解释，独立做题未核实', nextStep: '找一道题独立完成' })
  assert.equal(corrected.ok, true, corrected.reject)
  assert.equal(corrected.total, 1)
  assert.equal(corrected.notes[0].noteId, noteId)
  assert.equal('revisions' in corrected.notes[0], false)
  const history = notes.read({ node: 'dp', includeHistory: true }).notes[0].revisions
  assert.equal(history.length, 1)
  assert.equal(history[0].summary, '误记：已经独立完成')
  assert.equal('studentEvidence' in history[0], false, '未核对的原话不应作为空证据返回')
  await notes.revise({ noteId, summary: '目前只有口头解释，独立做题未核实', nextStep: '找一道题独立完成' })
  assert.equal(notes.read({ node: 'dp', includeHistory: true }).notes[0].revisions.length, 1, '重复调用不制造新版本')
  assert.equal((await notes.revise({ noteId: 'legacy:missing', summary: '未知', nextStep: '未知' })).ok, false)
  assert.equal(f.loadProgress().nodes.dp.lessonNotes.length, 1)
})

test('更正未提供新学生原话时保留原有核对出处', async (t) => {
  const f = fixture(t)
  f.dependencies.getSessionQuery = () => ({ readSession: async () => ({ session: { id: 'session-1' }, events: [userEvent()] }) })
  const notes = f.create()
  const written = await notes.write({ summary: '初始判断', nextStep: '继续检查', studentQuote: QUOTE }, EXEC)
  const originalEvidence = written.notes[0].studentEvidence
  const revised = await notes.revise({ noteId: written.notes[0].noteId, summary: '修正判断', nextStep: '让学生独立写代码' })
  assert.equal(revised.ok, true, revised.reject)
  assert.deepEqual(revised.notes[0].studentEvidence, originalEvidence)
  assert.deepEqual(f.loadProgress().nodes.dp.lessonNotes[0].studentEvidence, originalEvidence)
})

test('更正较早的笔记直接回显那条笔记，而不是最近五条', async (t) => {
  const f = fixture(t)
  const notes = f.create()
  let oldId = ''
  for (let i = 0; i < 7; i++) {
    const added = await notes.write({ summary: `第 ${i} 次判断`, nextStep: '继续核对' })
    if (i === 0) oldId = added.notes[0].noteId
  }
  const revised = await notes.revise({ noteId: oldId, summary: '最早那条已纠正', nextStep: '改按新证据推进' })
  assert.equal(revised.ok, true, revised.reject)
  assert.equal(revised.total, 7)
  assert.equal(revised.notes.length, 1)
  assert.equal(revised.notes[0].noteId, oldId)
  assert.equal(revised.notes[0].summary, '最早那条已纠正')
})

test('读取旧笔记只输出工具契约允许的字段', (t) => {
  const f = fixture(t)
  const progress = f.loadProgress()
  progress.nodes.dp.lessonNotes = [{ at: AT, summary: '当前判断', nextStep: '继续验证', internalFlag: '旧字段',
    revisions: [{ at: AT, summary: '原判断', nextStep: '旧建议', supersededAt: AT, internalFlag: '旧字段' }] }]
  f.saveProgress(progress)
  const notes = f.create()
  assert.equal('internalFlag' in notes.read({ node: 'dp' }).notes[0], false)
  assert.equal('internalFlag' in notes.read({ node: 'dp', includeHistory: true }).notes[0].revisions[0], false)
})

test('无效知识点、空白和超长笔记不能写入账本', async (t) => {
  const f = fixture(t)
  const notes = f.create()
  const valid = { summary: '仍需辨析状态', nextStep: '解释一个反例' }
  for (const change of [
    { node: 'unknown' }, { node: 123 }, { summary: '   ' }, { summary: 'x'.repeat(1001) },
    { nextStep: '' }, { nextStep: 'x'.repeat(501) }, { studentQuote: ' ' },
    { studentQuote: 'x'.repeat(1501) },
  ]) {
    const result = await notes.write({ ...valid, ...change })
    assert.equal(result.ok, false, JSON.stringify(change))
    assert.deepEqual(result.notes, [])
    assert.equal(result.total, 0)
    assert.deepEqual(f.loadProgress(), f.initial)
  }
  for (const limit of [0, -1, 21, 1.5, '5']) assert.equal(notes.read({ limit }).ok, false)
})

test('学生原话通过当前原生会话核对并保存稳定出处', async (t) => {
  const f = fixture(t)
  let queried
  f.dependencies.getSessionQuery = () => ({ readSession: async (id) => {
    queried = id
    return { session: { id }, events: [userEvent()] }
  } })
  const result = await f.create().write({ summary: '能区分容量和顺序，尚未检查代码', nextStep: '独立实现转移', studentQuote: QUOTE }, EXEC)
  assert.equal(queried, 'session-1')
  assert.equal(result.ok, true)
  assert.deepEqual(result.notes[0].studentEvidence, { sessionId: 'session-1', seq: 7, messageId: 'message-7', quote: QUOTE })
  assert.equal(f.loadProgress().nodes.dp.status, 'verified')
})

test('伪造原话、插件消息、跨会话内容或缺失出处不能成为学生依据', async (t) => {
  const invalidEvent = [
    userEvent({ data: { ...userEvent().data, content: [{ type: 'text', text: '别的答复' }] } }),
    userEvent({ data: { ...userEvent().data, source: { kind: 'plugin:coach' } } }),
    userEvent({ data: { ...userEvent().data, role: 'assistant' } }),
    userEvent({ seq: -1 }), userEvent({ seq: undefined }),
    userEvent({ data: { ...userEvent().data, id: '' } }),
    userEvent({ type: 'compaction/message' }),
    userEvent({ data: { ...userEvent().data, content: [{ type: 'image', text: QUOTE }] } }),
  ]
  for (const event of invalidEvent) {
    const f = fixture(t)
    f.dependencies.getSessionQuery = () => ({ readSession: async () => ({ session: { id: 'session-1' }, events: [event] }) })
    const result = await f.create().write({ summary: '判断', nextStep: '继续', studentQuote: QUOTE }, EXEC)
    assert.equal(result.ok, false)
    assert.deepEqual(f.loadProgress(), f.initial)
  }
  const f = fixture(t)
  const params = { summary: '判断', nextStep: '继续', studentQuote: QUOTE }
  assert.equal((await f.create().write(params, EXEC)).ok, false, '无会话查询服务必须拒绝')
  f.dependencies.getSessionQuery = () => ({ readSession: async () => ({ session: { id: 'another-session' }, events: [userEvent()] }) })
  assert.equal((await f.create().write(params, EXEC)).ok, false)
  assert.equal((await f.create().write(params)).ok, false, '无当前调用会话必须拒绝')
  f.dependencies.getSessionQuery = () => ({ readSession: async () => { throw new Error('unavailable') } })
  assert.equal((await f.create().write(params, EXEC)).ok, false)
  assert.deepEqual(f.loadProgress(), f.initial)
})

test('没有游标时找最近一次续课，默认只读最近五条并保留全部历史', async (t) => {
  const f = fixture(t)
  const notes = f.create()
  for (let i = 1; i <= 6; i++) await notes.write({ summary: `第${i}次讲解`, nextStep: '继续解释转移' })
  assert.equal(notes.read().total, 6)
  assert.equal(notes.read().notes.length, 5)
  assert.equal(notes.read().notes[0].summary, '第2次讲解')
  f.dependencies.now = () => '2026-10-11T11:00:00.000Z'
  await f.create().write({ node: 'graph', summary: '图上松弛还要澄清', nextStep: '比较两条路径' })
  const progress = f.loadProgress()
  progress.cursor = ''
  progress.pendingActions = {}
  f.saveProgress(progress)
  assert.equal(f.create().read().node, 'graph')
  assert.equal(f.create().read({ node: 'dp', limit: 20 }).notes.length, 6)
})

test('续课上下文短且标明教练判断，核对原话不等于证明掌握', async (t) => {
  const f = fixture(t)
  const notes = f.create()
  assert.equal(notes.context(f.loadProgress()), '')
  await notes.write({ summary: '状态含义还需辨析'.repeat(100), nextStep: '用小例子解释状态'.repeat(60) })
  const context = notes.context(f.loadProgress())
  assert.ok(context.length <= 700)
  assert.match(context, /教练判断/)
  assert.match(context, /下次接续/)
  assert.equal(notes.context(f.loadProgress(), 'graph'), '')
  f.dependencies.getSessionQuery = () => ({ readSession: async () => ({ session: { id: 'session-1' }, events: [userEvent()] }) })
  await f.create().write({ summary: '对状态有一个合理解释', nextStep: '独立写出转移', studentQuote: QUOTE }, EXEC)
  const grounded = f.create().context(f.loadProgress())
  assert.match(grounded, /原话已核对/)
  assert.match(grounded, /不代表掌握/)
  assert.match(grounded, /独立写出转移/)
})

test('原话查询期间其他工具保存的进度不会被旧快照覆盖', async (t) => {
  const f = fixture(t)
  let release
  f.dependencies.getSessionQuery = () => ({ readSession: () => new Promise((resolve) => { release = resolve }) })
  const writing = f.create().write({ summary: '状态解释待验证', nextStep: '写出转移', studentQuote: QUOTE }, EXEC)
  const updated = f.loadProgress()
  updated.cursor = 'graph'
  updated.nodes.graph = { status: 'studying', checks: [{ outcome: 'needs-work' }] }
  updated.pendingActions.dp.deliverable = '更新后的动作'
  f.saveProgress(updated)
  release({ session: { id: 'session-1' }, events: [userEvent()] })
  assert.equal((await writing).ok, true)
  const saved = f.loadProgress()
  assert.equal(saved.cursor, 'graph')
  assert.deepEqual(saved.nodes.graph, updated.nodes.graph)
  assert.deepEqual(saved.pendingActions, updated.pendingActions)
  assert.deepEqual(saved.pending, updated.pending)
  assert.deepEqual(saved.verified_problems, updated.verified_problems)
  assert.equal(saved.nodes.dp.lessonNotes.length, 1)
})

test('续课优先最近未完动作的笔记，显式读取和默认写入不受选择影响', async (t) => {
  const f = fixture(t)
  await f.create().write({ summary: '游标节点的旧笔记', nextStep: '继续状态解释' })
  const progress = f.loadProgress()
  progress.pendingActions.graph = { node: 'graph', deliverable: '解释松弛' }
  f.saveProgress(progress)
  f.dependencies.now = () => '2026-10-11T11:00:00.000Z'
  await f.create().write({ node: 'graph', summary: '刚讲到路径比较', nextStep: '继续比较两条路径' })
  const notes = f.create()
  assert.equal(notes.read().node, 'graph')
  assert.match(notes.context(f.loadProgress()), /刚讲到路径比较/)
  assert.equal(notes.read({ node: 'dp' }).node, 'dp')
  assert.match(notes.context(f.loadProgress(), 'dp'), /游标节点的旧笔记/)
  f.dependencies.now = () => '2026-10-11T12:00:00.000Z'
  assert.equal((await f.create().write({ summary: '仍写入当前游标', nextStep: '继续游标节点' })).node, 'dp')
  assert.equal(f.loadProgress().cursor, 'dp')
  assert.deepEqual(f.loadProgress().pendingActions, progress.pendingActions)
  assert.equal(f.create().read().node, 'dp', '多个未完动作按笔记时间选最近')
  const finished = f.loadProgress()
  delete finished.pendingActions.graph
  delete finished.pendingActions.dp
  f.saveProgress(finished)
  assert.equal(f.create().read().node, 'dp', '没有未完动作回到当前游标')
})

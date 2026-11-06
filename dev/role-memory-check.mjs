import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompanionTool, emptyPerson, loadPerson, savePerson, personLines } from '../lib/person.js'
import { loadEvents, reduceEvents } from '../lib/claims.js'

const quote = '我喜欢下雨时窝着喝热可可。'
const context = { agent: { session: { id: 's1' } } }
const assistant = (text = quote) => ({ type: 'assistant/message', seq: 7, time: 1793779200000,
  data: { message: { id: 'a7', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } } })
const snapshot = (events = [assistant()]) => ({ session: { id: 's1' }, events })
const toolFor = (dir, data = snapshot()) => createCompanionTool(dir, {
  getSessionQuery: () => ({ readSession: async () => data }),
  verifyEvidence: async text => ({ ok: text === '以后你叫小蓝，喜欢热可可。', reject: '没有用户原话' }),
})
const remember = { action: 'role.remember', field: 'likes', text: '下雨时喝热可可', evidence: quote }
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-role-memory-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const active = dir => [...reduceEvents(loadEvents(dir)).values()].filter(item => item.status === 'active')

test('verified boundary provenance excludes legacy identity migration and unrelated concurrent changes', async t => {
  for (const concurrent of [false, true]) {
    const dir = temp(t), legacy = emptyPerson()
    legacy.profile.identity = '小鲸，蓝头发的鲸鱼娘，他的女儿，也是他的教练'
    assert.equal(savePerson(dir, legacy), true)
    const expectedIdentity = loadPerson(dir).profile.identity
    const studentEvidence = { sessionId: 's1', messageId: 'boundary-source', seq: 9, quote: '别催我' }
    const tool = createCompanionTool(dir, { verifyEvidence: async () => {
      if (concurrent) {
        const other = loadPerson(dir)
        other.profile.likes.push('并发保存的偏好')
        assert.equal(savePerson(dir, other), true)
      }
      return { ok: true, studentEvidence }
    } })
    const result = await tool.execute({ action: 'boundary.add', boundaryText: '别催我', evidence: studentEvidence.quote }, context)
    assert.equal(result.ok, true, result.reject)
    const identity = active(dir).find(claim => claim.key === 'profile:identity')
    assert.equal(identity.value.text, expectedIdentity, 'the legacy identity still migrates normally')
    assert.equal(identity.evidence.some(e => e.messageId === 'boundary-source'), false)
    const boundary = active(dir).find(claim => claim.kind === 'boundary')
    assert.deepEqual(boundary.evidence, [{ handle: 'user', ...studentEvidence }])
    assert.equal(active(dir).filter(claim => claim.evidence.some(e => e.messageId === 'boundary-source')).length, 1)
    if (concurrent) assert.ok(loadPerson(dir).profile.likes.includes('并发保存的偏好'))
  }
})

test('verified student facts keep exact source metadata without relabelling unrelated role defaults', async t => {
  const dir = temp(t)
  const studentEvidence = { sessionId: 's1', messageId: 'student-9', seq: 9, quote: '别叫主人，明天提醒我复习，记住先画图' }
  const tool = createCompanionTool(dir, { verifyEvidence: async () => ({ ok: true, studentEvidence }) })
  for (const args of [
    { action: 'boundary.add', boundaryText: '别叫主人' },
    { action: 'promise.add', promiseText: '明天提醒复习' },
    { action: 'pin.add', pinText: '先画图' },
  ]) assert.equal((await tool.execute({ ...args, evidence: studentEvidence.quote }, context)).ok, true)
  for (const kind of ['boundary', 'promise']) {
    const fact = active(dir).find(claim => claim.kind === kind)
    assert.ok(fact, kind)
    assert.deepEqual(fact.evidence[0], { handle: 'user', ...studentEvidence })
    assert.equal(fact.source, 'user')
  }
  assert.equal(active(dir).find(claim => claim.key === 'profile:identity').evidence.some(e => e.messageId === 'student-9'), false)
  assert.equal(loadPerson(dir).pinned[0].text, '先画图')
  assert.deepEqual(loadPerson(dir).pinned[0].studentEvidence, { handle: 'user', ...studentEvidence })
  const promise = loadPerson(dir).promises[0]
  assert.equal((await tool.execute({ action: 'promise.done', id: promise.id }, { origin: 'human' })).ok, true)
  assert.deepEqual(active(dir).find(claim => claim.kind === 'promise').evidence[0], { handle: 'user', ...studentEvidence })
})

test('own published quote persists once with exact role provenance, without relabelling defaults', async t => {
  const dir = temp(t), before = loadPerson(dir)
  const result = await toolFor(dir).execute(remember, context)
  assert.equal(result.ok, true, result.reject)
  assert.ok(loadPerson(dir).profile.likes.includes(remember.text))
  assert.equal(loadPerson(dir).profile.identity, before.profile.identity)
  const claim = active(dir).find(item => item.value.text === remember.text)
  assert.equal(claim.source, 'role-self')
  assert.equal(claim.value.subject, 'role')
  assert.deepEqual(claim.evidence[0], { handle: 'assistant', sessionId: 's1', messageId: 'a7', seq: 7,
    time: '2026-11-04T08:00:00.000Z', quote })
  assert.ok(active(dir).filter(item => item.id !== claim.id).every(item => item.source !== 'role-self'))
  assert.equal((await toolFor(dir).execute(remember, context)).ok, true)
  assert.equal(active(dir).filter(item => item.value.text === remember.text).length, 1)
  const read = await toolFor(dir).execute({ action: 'read', section: 'profile' })
  assert.match(read.summary, /role-self/)
  assert.match(read.summary, /a7/)
})

test('self memory rejects user, tool, plugin, unrecorded and foreign-session quotes', async t => {
  const dir = temp(t)
  const user = assistant(); user.type = 'user/message'; user.data.message.role = 'user'; user.data.message.source.kind = 'user'
  const tool = assistant(); tool.data.message.content.push({ type: 'tool-call', name: 'companion', arguments: {} })
  const plugin = assistant(); plugin.data.message.source.kind = 'plugin'
  const foreign = snapshot(); foreign.session.id = 'other'
  for (const data of [snapshot([user]), snapshot([tool]), snapshot([plugin]), snapshot([]), foreign]) {
    assert.equal((await toolFor(dir, data).execute(remember, context)).ok, false)
  }
  assert.equal((await toolFor(dir).execute(remember, {})).ok, false)
  assert.equal(loadPerson(dir).profile.likes.includes(remember.text), false)
  assert.equal(loadEvents(dir).length, 0)
})

test('self preference metadata does not relabel a simultaneous legacy identity correction', async t => {
  const dir = temp(t), legacy = emptyPerson()
  legacy.profile.identity = '小鲸，蓝头发的鲸鱼娘，他的女儿，也是他的教练'
  assert.equal(savePerson(dir, legacy), true)
  assert.equal((await toolFor(dir).execute(remember, context)).ok, true)
  const identity = active(dir).find(item => item.key === 'profile:identity')
  assert.match(identity.value.text, /亲密的伙伴/)
  assert.notEqual(identity.source, 'role-self')
  assert.equal(identity.evidence.some(item => item.messageId === 'a7'), false)
  assert.equal(active(dir).filter(item => item.source === 'role-self').length, 1)
})

test('model profile replacement needs verified user settings; the human page remains editable', async t => {
  const dir = temp(t), tool = toolFor(dir)
  assert.equal((await tool.execute({ action: 'profile.set', likes: [] }, context)).ok, false)
  assert.equal((await tool.execute({ action: 'profile.set', identity: '小蓝', evidence: '我猜的' }, context)).ok, false)
  assert.equal((await tool.execute({ action: 'profile.set', identity: '小蓝', likes: ['热可可'],
    evidence: '以后你叫小蓝，喜欢热可可。' }, context)).ok, true)
  assert.equal(loadPerson(dir).profile.identity, '小蓝')
  assert.equal((await tool.execute({ action: 'profile.set', likes: [] }, { origin: 'human' })).ok, true)
  assert.deepEqual(loadPerson(dir).profile.likes, [])
})

test('a verified student quote still cannot be written directly as the role biography', async t => {
  const dir = temp(t)
  const tool = createCompanionTool(dir, {
    verifyEvidence: async quote => ({ ok: quote === '我明天有英语课', studentEvidence: { quote, messageId: 'student-only', seq: 1 } }),
  })
  const before = loadPerson(dir).profile
  const result = await tool.execute({ action: 'profile.set', background: ['训练员明天有英语课'], evidence: '我明天有英语课' }, context)
  assert.equal(result.ok, false, '核对到学生说过，也不能把学生经历写成角色来历')
  assert.match(result.reject, /来历|档案页/)
  assert.deepEqual(loadPerson(dir).profile, before)
  assert.equal(active(dir).some(claim => claim.value.text === '训练员明天有英语课'), false)
  assert.equal((await tool.execute({ action: 'profile.set', background: ['来自深海的鲸鱼娘'] }, { origin: 'human' })).ok, true)
  assert.deepEqual(loadPerson(dir).profile.background, ['来自深海的鲸鱼娘'])
})

test('habit self memory is additive and cannot restore an unwelcome habit or evict older preferences', async t => {
  const dir = temp(t), person = loadPerson(dir)
  person.habits.push({ id: 'h1', situation: '下雨', action: '要热可可', feedback: 'unwelcome', evidence: '别这样', createdAt: new Date().toISOString() })
  person.profile.likes = Array.from({ length: 12 }, (_, i) => `偏好${i}`)
  assert.equal(savePerson(dir, person), true)
  const tool = toolFor(dir)
  assert.equal((await tool.execute(remember, context)).ok, false)
  assert.deepEqual(loadPerson(dir).profile.likes, person.profile.likes)
  const habit = { action: 'role.remember', field: 'habit', situation: '下雨', habitAction: '要热可可', evidence: quote }
  assert.equal((await tool.execute(habit, context)).ok, false)
  assert.equal(loadPerson(dir).habits[0].feedback, 'unwelcome')
  assert.equal((await tool.execute({ ...habit, situation: '复盘以后' }, context)).ok, true)
  const saved = active(dir).find(item => item.kind === 'habit' && item.value.situation === '复盘以后')
  assert.equal(saved.source, 'role-self')
  assert.equal(saved.value.subject, 'role')
})

test('brief preferences keep the core and recent additions', () => {
  const person = loadPerson('nonexistent-role-memory-fixture')
  person.profile.likes = ['核心偏好', '较早偏好', '最近偏好', '最新偏好']
  const text = personLines(person, new Date(), { includeDetails: false }).join('\n')
  assert.match(text, /核心偏好/)
  assert.match(text, /最近偏好/)
  assert.match(text, /最新偏好/)
  assert.doesNotMatch(text, /较早偏好/)
})

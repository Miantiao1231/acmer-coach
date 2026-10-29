import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCompanion, coalescePrivateInput } from '../lib/companion.js'

const user = text => ({ id: `user-${Math.random()}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const fixture = () => {
  const nextTurn = [], nextStep = [], claimed = [], discarded = []
  const inbox = { nextTurn, nextStep, claim(target, turn) {
    assert.equal(target, 'next-turn')
    assert.deepEqual(nextStep, [], 'claim must not pull unrelated next-step input')
    const message = nextTurn.shift()
    if (message) claimed.push({ id: message.id, turn })
    return message ? [message] : []
  }, splice(target, start, count, inserted) {
    assert.equal(target, 'next-turn')
    const removed = nextTurn.splice(start, count, ...inserted)
    discarded.push(...removed.map(message => message.id))
    return removed
  } }
  return { nextTurn, nextStep, claimed, discarded, agent: { inbox } }
}
const options = { quietMs: () => 25, maxMs: 100, pollMs: 5 }

test('consecutive private text is claimed into one turn, never discarded', async () => {
  const { nextTurn, claimed, discarded, agent } = fixture()
  const first = user('等一下，我还没说完')
  const second = user('我想说的是矩阵加速')
  const third = user('能从一句话开始讲吗？')
  const timer1 = setTimeout(() => nextTurn.push(second), 8)
  const timer2 = setTimeout(() => nextTurn.push(third), 17)
  try {
    const result = await coalescePrivateInput({ agent, messages: [first], turn: 7, step: 1, signal: new AbortController().signal },
      { kind: 'enter', messages: [first] }, options)
    assert.deepEqual(result.messages, [first, second, third])
    assert.deepEqual(nextTurn, [])
    assert.deepEqual(claimed, [{ id: second.id, turn: 7 }, { id: third.id, turn: 7 }])
    assert.deepEqual(discarded, [])
  } finally { clearTimeout(timer1); clearTimeout(timer2) }
})

test('merged user text stays together ahead of injected coach state', async () => {
  const { nextTurn, agent } = fixture()
  const first = user('前半句')
  const second = user('后半句')
  const state = { id: 'state', role: 'user', source: { kind: 'plugin:acmer-coach' },
    content: [{ type: 'text', text: '<coach_state>训练位置</coach_state>' }] }
  nextTurn.push(second)
  const result = await coalescePrivateInput({ agent, messages: [first], turn: 1, step: 1,
    signal: new AbortController().signal }, { kind: 'enter', messages: [first, state] }, options)
  assert.deepEqual(result.messages, [first, second, state])
})

test('attachments and plugin prompts stay in their own turns', async () => {
  const { nextTurn, agent } = fixture()
  const first = user('看这个')
  first.content.push({ type: 'image', source: 'fixture' })
  const followup = user('另外一件事')
  nextTurn.push(followup)
  const result = await coalescePrivateInput({ agent, messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
    { kind: 'enter', messages: [first] }, options)
  assert.deepEqual(result.messages, [first])
  assert.deepEqual(nextTurn, [followup])
})

test('a pending non-user item is not consumed or overtaken', async () => {
  const { nextTurn, agent } = fixture()
  const first = user('先说第一句')
  const reminder = { ...user('到点提醒'), source: { kind: 'schedule' } }
  nextTurn.push(reminder, user('后一句'))
  const result = await coalescePrivateInput({ agent, messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
    { kind: 'enter', messages: [first] }, options)
  assert.deepEqual(result.messages, [first])
  assert.equal(nextTurn[0], reminder)
  assert.equal(nextTurn.length, 2)
})

test('private input never coalesces prompts from different remote principals', async () => {
  const { nextTurn, agent } = fixture()
  const first = user('第一位的话')
  first.source.principal = { id: 'alice' }
  const other = user('第二位的话')
  other.source.principal = { id: 'bob' }
  nextTurn.push(other)
  const result = await coalescePrivateInput({ agent, messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
    { kind: 'enter', messages: [first] }, options)
  assert.deepEqual(result.messages, [first])
  assert.deepEqual(nextTurn, [other])
})

test('cancelling during quiet window leaves queued text untouched', async () => {
  const { nextTurn, claimed, discarded, agent } = fixture()
  const first = user('我先说一点')
  const second = user('这句不能丢')
  const controller = new AbortController()
  nextTurn.push(second)
  const timer = setTimeout(() => controller.abort(), 8)
  try {
    await assert.rejects(coalescePrivateInput({ agent, messages: [first], turn: 1, step: 1, signal: controller.signal },
      { kind: 'enter', messages: [first] }, { ...options, quietMs: () => 50 }), { name: 'AbortError' })
    assert.deepEqual(claimed, [])
    assert.deepEqual(discarded, [])
    assert.deepEqual(nextTurn, [second])
  } finally { clearTimeout(timer) }
})

test('next-step input stops coalescing without claiming queued turns', async () => {
  const { nextTurn, nextStep, claimed, discarded, agent } = fixture()
  const first = user('先说第一句'), second = user('第二句')
  nextTurn.push(second)
  nextStep.push(user('高优先级输入'))
  const result = await coalescePrivateInput({ agent, messages: [first], turn: 4, step: 1,
    signal: new AbortController().signal }, { kind: 'enter', messages: [first] }, options)
  assert.deepEqual(result.messages, [first])
  assert.deepEqual(nextTurn, [second])
  assert.deepEqual(claimed, [])
  assert.deepEqual(discarded, [])
})


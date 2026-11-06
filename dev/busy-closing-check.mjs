import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  busyBoundary, busyGateDecision, evaluateBusyGate, loadBusyGateState, MAX_BACKLOG,
} from '../lib/busy-gate.js'
import { closingKind, closingDecision, adaptiveDebounceMs } from '../lib/closing.js'
import { sanitizeSleepSettings } from '../lib/sleep-settings.js'

const at = (value) => new Date(value)
const SETTINGS = sanitizeSleepSettings({
  busyGate: true, busyMinDelaySeconds: 60, busyMaxDelaySeconds: 300,
  busyUrgentThreshold: 85, busyRecoveryMinutes: 10,
  closingGuard: true, closingWindowMinutes: 20, closingAckSeconds: 90,
})

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'busy-closing-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('busy boundary lets urgency and direct commands through', () => {
  assert.equal(busyBoundary('救命，我卡爆了').reason, 'urgent')
  assert.equal(busyBoundary('帮我看看这题').reason, 'command')
  assert.equal(busyBoundary('在吗').reason, 'checks_if_busy')
  assert.equal(busyBoundary('今天好热').reason, 'normal')
  assert.equal(busyBoundary('').reason, 'empty')
})

test('the busy gate only holds when she is actually busy', () => {
  const busy = { mode: 'busy', reason: '在看书', until: '2026-11-02T15:00:00' }
  const now = at('2026-11-02T14:00:00')
  const held = busyGateDecision({ text: '今天好热', now, presence: busy, settings: SETTINGS })
  assert.equal(held.action, 'hold')
  assert.equal(held.reason, 'busy')
  assert.ok(held.delayMs >= 60000 && held.delayMs <= 300000)
  assert.equal(held.until, new Date('2026-11-02T15:00:00').toISOString())

  // 急事和直接吩咐照样穿过去。
  assert.equal(busyGateDecision({ text: '救命', now, presence: busy, settings: SETTINGS }).action, 'reply')
  assert.equal(busyGateDecision({ text: '帮我改一下', now, presence: busy, settings: SETTINGS }).action, 'reply')
  // 没在忙 / 开关关了 → 不拦。
  assert.equal(busyGateDecision({ text: 'x', now, presence: { mode: 'normal' }, settings: SETTINGS }).action, 'reply')
  assert.equal(busyGateDecision({ text: 'x', now, presence: busy, settings: { ...SETTINGS, busyGate: false } }).reason, 'disabled')
})

test('held messages come back once, right after the busy window', () => {
  const t = tmp()
  try {
    const busy = { mode: 'busy', reason: '在看书', until: '2026-11-02T15:00:00' }
    const first = evaluateBusyGate(t.dir, { text: '第一句', now: at('2026-11-02T14:10:00'), presence: busy, settings: SETTINGS })
    assert.equal(first.decision.action, 'hold')
    evaluateBusyGate(t.dir, { text: '第二句', now: at('2026-11-02T14:20:00'), presence: busy, settings: SETTINGS })
    evaluateBusyGate(t.dir, { text: '第三句', now: at('2026-11-02T14:30:00'), presence: busy, settings: SETTINGS })
    assert.equal(loadBusyGateState(t.dir).backlog.length, 3)

    // 忙完的第一轮把积压交还一次。
    const released = evaluateBusyGate(t.dir, { text: '我回来了', now: at('2026-11-02T15:05:00'), presence: { mode: 'normal' }, settings: SETTINGS })
    assert.equal(released.decision.action, 'reply')
    assert.equal(released.decision.reason, 'busy_ended')
    assert.deepEqual(released.backlog.map(item => item.text), ['第一句', '第二句', '第三句'])
    // 只交还一次，不会每轮复读。
    const again = evaluateBusyGate(t.dir, { text: '嗯', now: at('2026-11-02T15:06:00'), presence: { mode: 'normal' }, settings: SETTINGS })
    assert.deepEqual(again.backlog, [])
  } finally { t.done() }
})

test('the busy backlog is bounded', () => {
  const t = tmp()
  try {
    const busy = { mode: 'busy', reason: '', until: '2026-11-02T15:00:00' }
    for (let i = 0; i < MAX_BACKLOG + 5; i += 1) {
      evaluateBusyGate(t.dir, { text: `第 ${i} 句`, now: at('2026-11-02T14:10:00'), presence: busy, settings: SETTINGS })
    }
    assert.equal(loadBusyGateState(t.dir).backlog.length, MAX_BACKLOG)
  } finally { t.done() }
})

test('closings are classified, 谢谢 is not a closing', () => {
  assert.equal(closingKind('晚安'), 'goodnight')
  assert.equal(closingKind('那我先睡啦'), 'goodnight')
  assert.equal(closingKind('拜拜'), 'bye')
  assert.equal(closingKind('谢谢啦'), 'thanks')
  assert.equal(closingKind('嗯'), 'ack')
  assert.equal(closingKind('嗯嗯嗯'), 'ack')
  assert.equal(closingKind('今天好热'), '')
})

test('the closing guard stops the goodnight ping-pong', () => {
  const now = at('2026-11-02T23:30:00')
  const previous = (role, text, at_) => ({ role, text, at: at_ })
  // 她已经说了晚安，他又说晚安 → 不再开新回合。
  assert.equal(closingDecision({
    text: '晚安', now, previous: previous('assistant', '晚安呀，做个好梦', '2026-11-02T23:29:00'), settings: SETTINGS,
  }).action, 'hold')
  // 收尾之后的「谢谢」也只是客气。
  assert.equal(closingDecision({
    text: '谢谢', now, previous: previous('assistant', '晚安', '2026-11-02T23:29:00'), settings: SETTINGS,
  }).action, 'hold')
  // 上一句不是收尾 → 正常回。
  assert.equal(closingDecision({
    text: '晚安', now, previous: previous('assistant', '这题的关键在二分边界', '2026-11-02T23:29:00'), settings: SETTINGS,
  }).action, 'reply')
  // 隔了太久 → 不拦。
  assert.equal(closingDecision({
    text: '晚安', now, previous: previous('assistant', '晚安', '2026-11-02T20:00:00'), settings: SETTINGS,
  }).action, 'reply')
  // 两边都在「嗯」。
  assert.equal(closingDecision({
    text: '嗯', now, previous: previous('user', '嗯', '2026-11-02T23:29:30'), settings: SETTINGS,
  }).action, 'hold')
  // 开关关了就不拦。
  assert.equal(closingDecision({
    text: '晚安', now, previous: previous('assistant', '晚安', '2026-11-02T23:29:00'), settings: { ...SETTINGS, closingGuard: false },
  }).reason, 'disabled')
})

test('adaptive debounce stays small and only reacts to unfinished lines', () => {
  assert.equal(adaptiveDebounceMs(''), 0)
  assert.equal(adaptiveDebounceMs('这题的边界怎么取？'), 0)
  assert.ok(adaptiveDebounceMs('我想想，') >= 600)
  assert.ok(adaptiveDebounceMs('嗯') > 0)
  assert.ok(adaptiveDebounceMs('很长的一句话'.repeat(20)) <= 1200)
})

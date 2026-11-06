import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceFromMessages, buildMaterials, parseReflection, parseStyle } from '../lib/reflection.js'

const NOW = new Date('2026-10-30T12:00:00')
const messages = [
  { text: '小鲸，你最近可以读读《海》', id: 'm1', seq: 1, time: '2026-10-30T10:00:00+08:00' },
  { text: '以后你就喜欢热可可吧', id: 'm2', seq: 2, time: '2026-10-30T11:00:00+08:00' },
  { text: '我卡住的时候你先问我想到哪一步', id: 'm3', seq: 3, time: '2026-10-30T11:30:00+08:00' },
  { text: '今天是第一次有人陪我上课', id: 'm4', seq: 4, time: '2026-10-30T11:40:00+08:00' },
]
const evidence = evidenceFromMessages(messages)
const allowed = new Map(evidence.map(item => [item.handle, item]))

test('evidence handles are stable and bounded', () => {
  assert.deepEqual(evidence.map(item => item.handle), ['s1', 's2', 's3', 's4'])
  assert.equal(evidence[0].messageId, 'm1')
  assert.equal(evidence[0].seq, 1)
  assert.ok(evidence[0].time.includes('T'))
})

test('reflection parses habit, anniversary, profile and library proposals', () => {
  const text = JSON.stringify({
    summary: '今天聊了不少。',
    proposals: [
      { kind: 'library', subject: 'role', fields: { title: '《海》', source: '书店' }, confidence: 0.7, evidence_handles: ['s1'] },
      { kind: 'habit', fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '不直接给答案' }, confidence: 0.8, evidence_handles: ['s3'] },
      { kind: 'anniversary', fields: { label: '第一次陪我上课', reason: '他原话' }, confidence: 0.9, evidence_handles: ['s4'] },
      { kind: 'profile', subject: 'role', fields: { likes: ['热可可'] }, confidence: 0.6, evidence_handles: ['s2'] },
    ],
  })
  const parsed = parseReflection(text, { allowedHandles: allowed, now: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.proposals.length, 4)
  assert.equal(parsed.proposals.find(item => item.kind === 'anniversary').fields.date, '2026-10-30')
  assert.equal(parsed.proposals.find(item => item.kind === 'habit').evidence[0].quote, messages[2].text)
  assert.equal(parsed.rejected.length, 0)
  assert.ok(parsed.proposals.filter(item => ['profile', 'library'].includes(item.kind)).every(item => item.subject === 'role'))
})

test('student and unknown subjects cannot become role profile or reading proposals', () => {
  const parsed = parseReflection(JSON.stringify({ summary: '学生自己的偏好不写进角色档案', proposals: [
    { kind: 'profile', subject: 'student', fields: { likes: ['黑咖啡'] }, confidence: 0.9, evidence_handles: ['s2'] },
    { kind: 'library', fields: { title: '学生自己看的书' }, confidence: 0.9, evidence_handles: ['s1'] },
  ] }), { allowedHandles: allowed, now: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.proposals.length, 0)
  assert.equal(parsed.rejected.length, 2)
})

test('unknown evidence, low-confidence anniversaries and extra fields are rejected', () => {
  const text = JSON.stringify({
    summary: 'x',
    proposals: [
      { kind: 'habit', fields: { situation: 'a', action: 'b' }, confidence: 0.8, evidence_handles: ['s9'] },
      { kind: 'anniversary', fields: { label: '第一次', reason: 'x' }, confidence: 0.5, evidence_handles: ['s1'] },
      { kind: 'profile', subject: 'role', fields: { likes: ['x'] }, confidence: 0.8, evidence_handles: ['s1'], extra: true },
    ],
  })
  const parsed = parseReflection(text, { allowedHandles: allowed, now: NOW })
  assert.equal(parsed.proposals.length, 0)
  assert.equal(parsed.rejected.length, 3)
})

test('reflection rejects a bad top level and caps anniversaries at one', () => {
  const bad = parseReflection(JSON.stringify({ summary: 'x', proposals: [], extra: 1 }), { allowedHandles: allowed, now: NOW })
  assert.equal(bad.ok, false)
  const two = parseReflection(JSON.stringify({
    summary: 'x',
    proposals: [
      { kind: 'anniversary', fields: { label: '第一次', reason: 'x' }, confidence: 0.9, evidence_handles: ['s1'] },
      { kind: 'anniversary', fields: { label: '第二次', reason: 'x' }, confidence: 0.9, evidence_handles: ['s4'] },
    ],
  }), { allowedHandles: allowed, now: NOW })
  assert.equal(two.proposals.length, 1)
  assert.equal(two.rejected.length, 1)
})

test('style parsing keeps only evidence-backed signals and normalizes applicability', () => {
  const text = JSON.stringify({
    summary: '他的节奏',
    signals: [
      { dimension: 'sentence_rhythm', observation: '短句多', pattern: '先两三个字确认，再补一句', situation: '日常', avoid: '', proposal: '自然化用', confidence: 0.7, evidence_handles: ['s1'],
        applicability: { channels: ['private'], relationship_stages: ['close'], emotion_gates: ['low'], intent: 'comfort', keywords: ['累'] } },
      { dimension: 'emoji', observation: 'x', pattern: 'y', situation: '', avoid: '', proposal: '', confidence: 0.7, evidence_handles: ['s9'] },
    ],
  })
  const parsed = parseStyle(text, { allowedHandles: allowed })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.signals.length, 1)
  assert.equal(parsed.signals[0].pattern, '先两三个字确认，再补一句')
  assert.deepEqual(parsed.signals[0].applicability.channels, ['private'])
  assert.deepEqual(parsed.signals[0].applicability.relationship_stages, ['close'])
  assert.equal(parsed.signals[0].applicability.intent, 'comfort')
  assert.equal(parsed.rejected.length, 1)
})

test('evidence redacts obvious secrets before it reaches the model or the file', () => {
  const secret = evidenceFromMessages([{ text: '我的 key 是 sk-abcdefghijklmnop，别告诉别人', id: 'm', seq: 1, time: '' }])
  assert.match(secret[0].text, /\[REDACTED\]/)
  assert.doesNotMatch(secret[0].text, /sk-abcdefghijklmnop/)
})

test('materials carry handles, current state and coverage', () => {
  const person = {
    profile: { likes: ['热可可'] },
    relation: { milestones: [{ label: '第一次', date: '2026-10-01' }] },
    habits: [], library: [], style: [{ status: 'active', dimension: 'emoji', pattern: 'x' }],
    rejected: [{ kind: 'library', fields: { title: '旧书' } }],
  }
  const raw = buildMaterials(person, evidence)
  assert.match(raw, /"handle": "s1"/)
  assert.match(raw, /"count": 4/)
  assert.match(raw, /热可可/)
  assert.match(raw, /旧书/)
})

test('reflection can propose one shared experience and one promise, dated from evidence', () => {
  const text = JSON.stringify({
    summary: '今天聊了第一次复盘。',
    proposals: [
      { kind: 'episode', fields: { summary: '他第一次主动说想认真复盘，我们把昨天的比赛过了一遍。', tags: ['复盘', '深夜'] }, confidence: 0.8, evidence_handles: ['s4'] },
      { kind: 'promise', fields: { text: '明天问他那道题的进度', dueAt: '2026-10-31' }, confidence: 0.8, evidence_handles: ['s3'] },
    ],
  })
  const parsed = parseReflection(text, { allowedHandles: allowed, now: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.proposals.length, 2)
  const episode = parsed.proposals.find(item => item.kind === 'episode')
  assert.equal(episode.fields.at, '2026-10-30')
  assert.deepEqual(episode.fields.tags, ['复盘', '深夜'])
  const promise = parsed.proposals.find(item => item.kind === 'promise')
  assert.equal(promise.fields.text, '明天问他那道题的进度')
  assert.equal(promise.fields.status, 'open')
})

test('reflection caps episodes and promises at one per run', () => {
  const text = JSON.stringify({
    summary: 'x',
    proposals: [
      { kind: 'episode', fields: { summary: '第一段足够长的共同经历。' }, confidence: 0.8, evidence_handles: ['s1'] },
      { kind: 'episode', fields: { summary: '第二段足够长的共同经历。' }, confidence: 0.8, evidence_handles: ['s2'] },
      { kind: 'promise', fields: { text: '第一件答应的事' }, confidence: 0.8, evidence_handles: ['s3'] },
      { kind: 'promise', fields: { text: '第二件答应的事' }, confidence: 0.8, evidence_handles: ['s4'] },
    ],
  })
  const parsed = parseReflection(text, { allowedHandles: allowed, now: NOW })
  assert.equal(parsed.proposals.length, 2)
  assert.equal(parsed.rejected.length, 2)
})

test('reflection can propose one explicit boundary and caps it at one', () => {
  const text = JSON.stringify({
    summary: '他划了线。',
    proposals: [
      { kind: 'boundary', fields: { text: '不要叫我宝贝' }, confidence: 0.9, evidence_handles: ['s1'] },
      { kind: 'boundary', fields: { text: '不要催我睡觉' }, confidence: 0.9, evidence_handles: ['s2'] },
    ],
  })
  const parsed = parseReflection(text, { allowedHandles: allowed, now: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.proposals.length, 1)
  assert.equal(parsed.proposals[0].fields.text, '不要叫我宝贝')
  assert.equal(parsed.rejected.length, 1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyPerson, applyProposal, createCompanionTool } from '../lib/person.js'
import { createLifeTick } from '../lib/life-tick.js'
import { saveScreenCapture, originalPath } from '../lib/screen-originals.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-preview-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('student profile candidates cannot change the role profile without attribution', () => {
  const person = emptyPerson()
  const result = applyProposal(person, {
    kind: 'profile', fields: { likes: ['黑咖啡'] }, confidence: 0.95,
    evidence: [{ handle: 's1', quote: '我喜欢黑咖啡', time: new Date().toISOString() }],
  })
  assert.equal(result.ok, false)
  assert.equal(person.profile.likes.includes('黑咖啡'), false)
})

test('a model cannot install an unverified user boundary', async t => {
  const tool = createCompanionTool(fixture(t))
  const result = await tool.execute({
    action: 'boundary.add', boundaryText: '训练员不要谈比赛', evidence: '会话里不存在的原话',
  })
  assert.equal(result.ok, false)
})

test('ordinary life ticks do not call a model without background opt-in', async t => {
  let calls = 0
  const tick = createLifeTick({
    dataDir: fixture(t),
    getRoute: () => ({ provider: 'fixture', model: 'fixture' }),
    getLlm: () => ({ async *stream() { calls++; yield { type: 'text-delta', text: '{}' } } }),
    now: () => new Date('2026-11-04T23:55:00+08:00'),
  })
  await tick()
  assert.equal(calls, 0)
})

test('screen observations keep metadata without retaining image bytes by default', t => {
  const dir = fixture(t)
  const saved = saveScreenCapture(dir, {
    image: { data: Buffer.alloc(2048), width: 100, height: 100 },
    observation: { summary: '在看题', kind: 'coding', confidence: 'high' },
  })
  assert.equal(saved.ok, true)
  assert.equal(existsSync(originalPath(dir, saved.capture.id)), false)
})

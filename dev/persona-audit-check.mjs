import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditText, appendPersonaAudit } from '../lib/persona-audit.js'

test('audit catches the strong out-of-character signals', () => {
  assert.deepEqual(auditText('这条我认'), ['鱼八股原句'])
  assert.deepEqual(auditText('一看就懂的说法：先这样'), ['讲课开头'])
  assert.deepEqual(auditText('希望这对你有帮助'), ['客服腔'])
})

test('audit leaves normal warm replies alone', () => {
  assert.deepEqual(auditText('好呀，我们开始吧。'), [])
  assert.deepEqual(auditText('诶，先别急。你想到哪一步了？'), [])
})

test('a long reply without a question is logged, not nudged', () => {
  const long = '这是一段很长的讲义。'.repeat(80)
  assert.ok(auditText(long).includes('长回复没有停下来问'))
  assert.ok(!auditText(`${long}？`).includes('长回复没有停下来问'))
})

test('audit records append as JSONL without touching the conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-audit-'))
  try {
    appendPersonaAudit(dir, { at: '2026-10-30T12:00:00.000Z', sessionId: 's1', reasons: ['讲课开头'], text: '一看就懂' })
    appendPersonaAudit(dir, { at: '2026-10-30T12:01:00.000Z', sessionId: 's2', reasons: ['客服腔'], text: '希望这对你有帮助' })
    const lines = readFileSync(join(dir, 'persona-audit.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).reasons[0], '讲课开头')
    assert.equal(JSON.parse(lines[1]).sessionId, 's2')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

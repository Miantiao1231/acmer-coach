import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditText, appendPersonaAudit, NUDGE_REASONS } from '../lib/persona-audit.js'

test('audit catches the strong out-of-character signals', () => {
  assert.deepEqual(auditText('这条我认'), ['鱼八股原句'])
  assert.deepEqual(auditText('一看就懂的说法：先这样'), ['讲课开头'])
  assert.deepEqual(auditText('希望这对你有帮助'), ['客服腔'])
})

test('audit leaves normal warm replies alone', () => {
  assert.deepEqual(auditText('好呀，我们开始吧。'), [])
  assert.deepEqual(auditText('诶，先别急。你想到哪一步了？'), [])
})

test('audit catches lecture-style scaffolding in teaching replies', () => {
  assert.ok(auditText('首先我们把题意读一遍，其次建图，最后跑最短路。').includes('讲义腔'))
  assert.ok(auditText('综上所述，这题就是最短路。').includes('讲义腔'))
  assert.ok(auditText('简而言之，状态就是剩余容量。').includes('讲义腔'))
  assert.ok(auditText('## 思路\n先建图再跑。').includes('讲义腔'))
  assert.ok(auditText('**总结：** 这题就是最短路。').includes('讲义腔'))
  assert.ok(auditText('我们先来看这道题。').includes('讲课开头'))
  assert.ok(auditText('希望这能帮到你。').includes('客服腔'))
  assert.ok(auditText('希望对你有帮助。').includes('客服腔'))
  assert.ok(auditText('希望以上这些内容能对你有所帮助。').includes('客服腔'))
  assert.ok(auditText('这不是贪心，而是动态规划。').includes('对仗八股'))
  assert.ok(NUDGE_REASONS.has('讲义腔'), '讲义腔登记为强信号（该集合只用于统计/未来接线，当前不改写对话）')
  assert.ok(!NUDGE_REASONS.has('对仗八股'), '对仗八股只记日志，不据此提醒')
})

test('lecture audit stays quiet on normal teaching talk', () => {
  for (const text of [
    '先别急，你把那条边画出来我看看。',
    '这题你上次卡在建图，还记得卡在哪吗？',
    '从终点往回走一步，能到谁？你画一下箭头。',
    '不是 30，而是 60？那是题目里的哪句话？',
  ]) assert.deepEqual(auditText(text), [], text)
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

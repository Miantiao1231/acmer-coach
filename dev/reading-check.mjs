import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readingSource, readingSourceSnapshot } from '../lib/reading.js'
import { updateActivityLedger, loadActivityLedger, planActivity } from '../lib/activity-ledger.js'

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 32)

test('reading resumes at a verified position and keeps the real text boundaries', () => {
  const excerpt = ' '.repeat(3) + '甲'.repeat(6002) + '末尾'
  const person = { library: [{ id: 'b', title: '章节', state: 'reading', scope: 'chapter', excerpt,
    readingHash: hash(excerpt), readingOffset: 6000 }] }
  const source = readingSource(person)
  assert.equal(source.text, excerpt.slice(6000))
  assert.equal(source.start, 6000)
  assert.equal(source.end, excerpt.length)
  assert.equal(source.total, excerpt.length)
  assert.equal(source.contentHash, hash(excerpt))
  assert.equal(source.scope, 'chapter')
  person.library[0].excerpt = '修改后的正文'
  assert.equal(readingSource(person).start, 0, 'changed source cannot reuse an old position')
})

test('a source snapshot survives the activity ledger without silently losing most of the reading', t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const excerpt = '段'.repeat(6500)
  const source = readingSource({ library: [{ id: 'b', title: '文章', state: 'reading', excerpt }] })
  const snapshot = readingSourceSnapshot(source)
  assert.equal(snapshot.text.length, 6000)
  updateActivityLedger(dir, ledger => {
    planActivity(ledger, { id: 'r', title: '文章', source: snapshot })
    return ledger
  })
  assert.deepEqual(loadActivityLedger(dir).activities[0].source, snapshot)
})

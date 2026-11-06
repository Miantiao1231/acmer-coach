import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompanionTool, emptyPerson, loadPerson, savePerson } from '../lib/person.js'
import { compactEvents } from '../lib/claims.js'

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-reading-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, tool: createCompanionTool(dir) }
}

test('reading text and source scope survive companion writes and fact reloads', async t => {
  const { dir, tool } = fixture(t)
  const excerpt = '  第一章\n保留开头空格，字符游标才不偏移。\n'
  const fetchedAt = '2026-11-06T10:20:00+08:00'
  const added = await tool.execute({ action: 'library.add', title: '公开章节夹具', kind: 'book',
    source: 'https://example.test/chapter', excerpt, readingOffset: 2, readingHash: 'source-hash', fetchedAt, scope: 'chapter' })
  assert.equal(added.ok, true, added.reject)
  const book = loadPerson(dir).library[0]
  assert.equal(book.excerpt, excerpt)
  assert.equal(book.readingOffset, 2)
  assert.equal(book.readingHash, 'source-hash')
  assert.equal(book.fetchedAt, '2026-11-06T02:20:00.000Z')
  assert.equal(book.scope, 'chapter')
  assert.equal(book.state, 'reading', 'one chapter is not a finished book')
  const saved = loadPerson(dir)
  saved.library[0].readingOffset = excerpt.length
  saved.library[0].readingHash = 'new-hash'
  assert.equal(savePerson(dir, saved), true)
  const loaded = loadPerson(dir).library[0]
  assert.equal(loaded.readingOffset, excerpt.length)
  assert.equal(loaded.readingHash, 'new-hash')
  assert.equal(loaded.excerpt, excerpt)
  const events = readFileSync(join(dir, 'person-events.jsonl'), 'utf8')
  assert.match(events, /new-hash/)
})

test('replacing text resets its cursor unless the update explicitly supplies one; invalid updates do not write', async t => {
  const { dir, tool } = fixture(t)
  assert.equal((await tool.execute({ action: 'library.add', title: '游标夹具', excerpt: '原始正文', readingOffset: 2, readingHash: 'old' })).ok, true)
  const id = loadPerson(dir).library[0].id
  assert.equal((await tool.execute({ action: 'library.update', id, excerpt: '另一段正文', readingHash: 'discarded' })).ok, true)
  let book = loadPerson(dir).library[0]
  assert.equal(book.readingOffset, 0)
  assert.equal(book.readingHash, '')
  assert.equal((await tool.execute({ action: 'library.update', id, excerpt: '最终正文', readingOffset: 4, readingHash: 'final', scope: 'article' })).ok, true)
  book = loadPerson(dir).library[0]
  assert.equal(book.readingOffset, 4)
  assert.equal(book.readingHash, 'final')
  assert.equal(book.scope, 'article')
  const before = readFileSync(join(dir, 'person-events.jsonl'), 'utf8')
  for (const patch of [
    { readingOffset: -1 }, { readingOffset: 1.5 }, { readingOffset: 5 }, { readingOffset: null },
    { excerpt: '字'.repeat(60001) }, { excerpt: null }, { readingHash: null },
    { fetchedAt: '2026-11-06 12:00:00' }, { fetchedAt: 'broken' }, { fetchedAt: null }, { fetchedAt: '2026-02-30T12:00:00Z' },
    { scope: 'book' }, { scope: null },
  ]) {
    const result = await tool.execute({ action: 'library.update', id, title: '不应改名', ...patch }).catch(error => {
      if (error.code === 'INVALID_ARGS') return { ok: false }
      throw error
    })
    assert.equal(result.ok, false, JSON.stringify(patch).slice(0, 120))
    assert.equal(readFileSync(join(dir, 'person-events.jsonl'), 'utf8'), before)
    assert.equal(loadPerson(dir).library[0].title, '游标夹具')
  }
})

test('the completion date only records a real transition to done, and survives notes edits', async t => {
  const { dir, tool } = fixture(t)
  await tool.execute({ action: 'library.add', title: '完成日夹具', excerpt: '正文' })
  const id = loadPerson(dir).library[0].id
  assert.equal(loadPerson(dir).library[0].doneAt ?? '', '')
  assert.equal((await tool.execute({ action: 'library.update', id, state: 'done', note: '读完了' })).ok, true)
  const doneAt = loadPerson(dir).library[0].doneAt
  assert.ok(Number.isFinite(Date.parse(doneAt)), 'a real finish records when it happened')
  // Saving the page form again (same state, new note) must not move that date.
  assert.equal((await tool.execute({ action: 'library.update', id, state: 'done', note: '改一下备注' })).ok, true)
  assert.equal(loadPerson(dir).library[0].doneAt, doneAt)
  // Re-reading is an explicit state change, so the old finish date is cleared.
  assert.equal((await tool.execute({ action: 'library.update', id, state: 'reading' })).ok, true)
  assert.equal(loadPerson(dir).library[0].doneAt, '')
})

test('a book keeps its public id after the claim log is compacted', async t => {
  const { dir, tool } = fixture(t)
  await tool.execute({ action: 'library.add', title: '身份夹具', excerpt: '第一版' })
  const id = loadPerson(dir).library[0].id
  for (const note of ['第一次改', '第二次改', '第三次改']) {
    assert.equal((await tool.execute({ action: 'library.update', id, note })).ok, true)
  }
  // Compaction keeps only active claims; the id must not depend on ancestors
  // that are gone, or the shelf would claim the book does not exist.
  const result = compactEvents(dir, { thresholdBytes: 1, keepArchives: 1 })
  assert.equal(result.compacted, true)
  assert.equal(loadPerson(dir).library[0].id, id)
  assert.equal((await tool.execute({ action: 'library.update', id, note: '压缩之后还能改' })).ok, true)
  assert.match(loadPerson(dir).library[0].note, /压缩之后还能改/)
})

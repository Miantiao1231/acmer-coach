import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'acmer-coach-storage-'))
const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
process.env.COACH_DATA_DIR = dir
process.env.COACH_DB = join(dir, 'unused.db')
const { progressApi } = await import('../index.js')

test('existing but invalid personal ledgers never read as empty', () => {
  for (const [name, read] of [
    ['PROGRESS.yaml', progressApi.load], ['SCHEDULE.yaml', progressApi.loadSchedule],
  ]) {
    writeFileSync(join(dir, name), 'null\n')
    assert.throws(read, new RegExp(name.replace('.', '\\.')))
  }
})

test('failed replacement preserves progress and schedule', () => {
  const progressPath = join(dir, 'PROGRESS.yaml'), schedulePath = join(dir, 'SCHEDULE.yaml')
  progressApi.save({ version: 1, cursor: 'A', nodes: { A: { status: 'studying' } } })
  progressApi.saveSchedule({ version: 1, days: { '2026-10-25': { busy: [] } } })
  const before = [readFileSync(progressPath, 'utf8'), readFileSync(schedulePath, 'utf8')]
  const rename = fs.renameSync, copy = fs.copyFileSync
  try {
    fs.renameSync = () => { const error = new Error('simulated replace failure'); error.code = 'EEXIST'; throw error }
    fs.copyFileSync = () => { const error = new Error('simulated copy failure'); error.code = 'EIO'; throw error }
    syncBuiltinESMExports()
    assert.throws(() => progressApi.save({ version: 1, cursor: 'B', nodes: {} }))
    assert.throws(() => progressApi.saveSchedule({ version: 1, days: {} }))
    assert.equal(readFileSync(progressPath, 'utf8'), before[0])
    assert.equal(readFileSync(schedulePath, 'utf8'), before[1])
  } finally { fs.renameSync = rename; fs.copyFileSync = copy; syncBuiltinESMExports() }
})

test.after(() => {
  if (previous.data === undefined) delete process.env.COACH_DATA_DIR
  else process.env.COACH_DATA_DIR = previous.data
  if (previous.db === undefined) delete process.env.COACH_DB
  else process.env.COACH_DB = previous.db
  rmSync(dir, { recursive: true, force: true })
})

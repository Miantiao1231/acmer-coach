import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  withOperationId, argsDigest, replayOperation, recordOperation,
} from '../lib/tool-operations.js'
import { readJsonFile } from '../lib/json-store.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'tool-ops-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeTool(handler) {
  return {
    name: 'coach_fake',
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
    execute: handler,
  }
}

test('operation_id replays the first result instead of running twice', async () => {
  const t = tmp()
  try {
    let runs = 0
    const tool = withOperationId(fakeTool(async () => { runs += 1; return { ok: true, summary: `run ${runs}` } }), t.dir)
    assert.ok(tool.parameters.properties.operation_id, 'operation_id is declared for the model')
    const first = await tool.execute({ action: 'x', operation_id: 'op-1' })
    const second = await tool.execute({ action: 'x', operation_id: 'op-1' })
    assert.equal(runs, 1)
    assert.deepEqual(second, first)
    assert.equal(second.summary, 'run 1')
  } finally { t.done() }
})

test('without an operation_id nothing is deduplicated', async () => {
  const t = tmp()
  try {
    let runs = 0
    const tool = withOperationId(fakeTool(async () => { runs += 1; return { ok: true, summary: `run ${runs}` } }), t.dir)
    await tool.execute({ action: 'read' })
    await tool.execute({ action: 'read' })
    assert.equal(runs, 2)
  } finally { t.done() }
})

test('the same id with different arguments is not a replay', async () => {
  const t = tmp()
  try {
    let runs = 0
    const tool = withOperationId(fakeTool(async () => { runs += 1; return { ok: true, summary: `run ${runs}` } }), t.dir)
    await tool.execute({ action: 'a', operation_id: 'op-2' })
    const second = await tool.execute({ action: 'b', operation_id: 'op-2' })
    assert.equal(runs, 2)
    assert.equal(second.summary, 'run 2')
    assert.notEqual(argsDigest({ action: 'a' }), argsDigest({ action: 'b' }))
  } finally { t.done() }
})

test('failures are not cached, so a retry still runs', async () => {
  const t = tmp()
  try {
    let runs = 0
    const tool = withOperationId(fakeTool(async () => {
      runs += 1
      return runs === 1 ? { ok: false, reject: '写不进去' } : { ok: true, summary: '好了' }
    }), t.dir)
    assert.equal((await tool.execute({ operation_id: 'op-3' })).ok, false)
    assert.equal((await tool.execute({ operation_id: 'op-3' })).ok, true)
    assert.equal(runs, 2)
  } finally { t.done() }
})

test('an accepted=false rejection can succeed after its prerequisite changes', async () => {
  const t = tmp()
  try {
    let ready = false, runs = 0
    const tool = withOperationId(fakeTool(async () => {
      runs++
      return ready ? { accepted: true, reject: '' } : { accepted: false, reject: '前置尚未满足' }
    }), t.dir)
    assert.equal((await tool.execute({ operation_id: 'assignment' })).accepted, false)
    ready = true
    assert.equal((await tool.execute({ operation_id: 'assignment' })).accepted, true)
    assert.equal(runs, 2)
  } finally { t.done() }
})

test('concurrent registry instances share one execution for the same operation', async () => {
  const t = tmp()
  let release
  const gate = new Promise(resolve => { release = resolve })
  try {
    let runs = 0
    const handler = async () => { runs++; await gate; return { ok: true, summary: '只记一次' } }
    const first = withOperationId(fakeTool(handler), t.dir)
    const second = withOperationId(fakeTool(handler), t.dir)
    const a = first.execute({ action: 'write', operation_id: 'concurrent' })
    const b = second.execute({ action: 'write', operation_id: 'concurrent' })
    release()
    const values = await Promise.all([a, b])
    assert.equal(runs, 1)
    assert.deepEqual(values[0], values[1])
  } finally { release(); t.done() }
})

test('an exception after a side effect never authorizes an automatic repeat', async () => {
  const t = tmp()
  try {
    let effects = 0
    const tool = withOperationId(fakeTool(async () => { effects++; throw new Error('reply lost after write') }), t.dir)
    await assert.rejects(tool.execute({ operation_id: 'uncertain' }), /reply lost/)
    await assert.rejects(tool.execute({ operation_id: 'uncertain' }), /执行结果无法确认|未缓存/)
    assert.equal(effects, 1)
  } finally { t.done() }
})

test('nested result changes run again while object key order still replays', async () => {
  const t = tmp()
  try {
    let runs = 0
    const tool = withOperationId(fakeTool(async (args) => ({ ok: true, solved: args.results[0].solved, runs: ++runs })), t.dir)
    const first = { operation_id: 'nested', results: [{ problemId: 'P1', solved: false, minutes: 40 }] }
    const corrected = { operation_id: 'nested', results: [{ problemId: 'P1', solved: true, minutes: 20 }] }
    await tool.execute(first)
    assert.equal((await tool.execute(corrected)).solved, true)
    assert.equal(runs, 2, 'a corrected nested result must execute')
    const reordered = { results: [{ minutes: 20, solved: true, problemId: 'P1' }], operation_id: 'nested' }
    assert.equal((await tool.execute(reordered)).runs, 2)
    assert.equal(runs, 2, 'JSON object key order is not a new operation')
  } finally { t.done() }
})

test('oversized results are not stored', () => {
  const t = tmp()
  try {
    const big = { ok: true, summary: 'x'.repeat(9000) }
    assert.equal(recordOperation(t.dir, { tool: 'coach_fake', args: { operation_id: 'op-big' }, result: big }), false)
    assert.equal(replayOperation(t.dir, { tool: 'coach_fake', args: { operation_id: 'op-big' } }), null)
  } finally { t.done() }
})

test('expired entries stop replaying', () => {
  const t = tmp()
  try {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    assert.equal(recordOperation(t.dir, { tool: 'coach_fake', args: { operation_id: 'op-old' }, result: { ok: true, summary: '旧' }, now: old }), true)
    assert.equal(replayOperation(t.dir, { tool: 'coach_fake', args: { operation_id: 'op-old' } }), null)
    assert.ok(readJsonFile(t.dir, 'tool-operations.json'))
  } finally { t.done() }
})

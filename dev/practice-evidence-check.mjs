import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

const exec = { agent: { session: { id: 'source-session' } } }
async function fixture(run, reports) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-source-'))
  const old = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: [{id: A, name: 基础}]\n')
  writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\ncursor: A\nnodes: {A: {status: studying}}\n')
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  const events = reports.map((text, i) => ({ type: 'user/message', seq: i + 1,
    data: { id: `report-${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }))
  try {
    const { apply } = await import(`../index.js?source-${Math.random()}`)
    const tools = new Map()
    apply({ tools: { register: t => tools.set(t.name, t) }, inject() {}, on() {},
      get: name => name === 'sessionQuery' ? { readSession: async () => ({ session: { id: exec.agent.session.id }, events }) } : undefined })
    await run({ tools, events, call: (args) => tools.get('coach_log').execute({ node: 'A', ...args }, exec),
      read: file => parse(readFileSync(join(dir, file), 'utf8')), dir })
  } finally {
    for (const [key, value] of [['COACH_DATA_DIR', old.data], ['COACH_DB', old.db]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('hinted report cannot be stored as independent, and invented 2 does not match reported 12', async () => {
  const quote = '我用了教练提示，不是独立完成，总共12分钟。'
  await fixture(async ({ call, read }) => {
    for (const args of [{ actualMin: 12, independent: true }, { actualMin: 2, independent: false }]) {
      const r = await call({ ...args, solved: true, studentQuote: quote })
      assert.equal(r.ok, false, r.reject)
      assert.equal(read('PROGRESS.yaml').nodes.A.passes, undefined)
    }
  }, [quote])
})

test('same sourced report relabeled updates once; genuinely different reports remain separate', async () => {
  const one = '第一题用了提示，12分钟做出。', two = '第二题独立完成，20分钟。'
  await fixture(async ({ call, read }) => {
    const a = await call({ solved: true, independent: false, actualMin: 12, problemId: '区间调度', studentQuote: one })
    assert.equal(a.ok, true, a.reject)
    const b = await call({ solved: true, independent: false, actualMin: 12, problemId: '闭区间版', studentQuote: one })
    assert.equal(b.ok, true, b.reject); assert.equal(b.replaced, true)
    assert.equal(read('PROGRESS.yaml').nodes.A.passes.length, 1)
    const c = await call({ solved: true, independent: true, actualMin: 20, problemId: '另一题', studentQuote: two })
    assert.equal(c.ok, true, c.reject)
    assert.equal(read('PROGRESS.yaml').nodes.A.passes.length, 2)
    assert.equal(read('SCHEDULE.yaml').days[a.date].actual.length, 2)
  }, [`${one}\n${two}`])
})

test('unknown time and independence stay unknown in ledgers and tool rendering', async () => {
  const quote = '这题我完成了，但忘记计时，也没说明是否有帮助。'
  await fixture(async ({ call, read, tools }) => {
    const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    assert.equal((await tools.get('coach_plan').execute({ date, blocks: [{ from: '10:00', node: 'A', kind: 'diagnostic', minutes: 15 }] })).ok, true)
    const r = await call({ solved: true, studentQuote: quote })
    assert.equal(r.ok, true, r.reject)
    assert.equal(read('PROGRESS.yaml').nodes.A.passes[0].minutes, undefined)
    assert.equal(read('PROGRESS.yaml').nodes.A.passes[0].independent, undefined)
    const text = tools.get('coach_log').output.render({}, r)[0].text
    assert.match(text, /未报告|未知/); assert.doesNotMatch(text, /0 分钟|看了题解/)
    for (const name of ['coach_status', 'coach_schedule']) {
      const tool = tools.get(name), value = await tool.execute({})
      assert.match(tool.output.render({}, value)[0].text, /未报告|未知/)
    }
  }, [quote])
})

test('native missing, forged, and plugin quotes fail before writing', async () => {
  const quote = '我独立完成，12分钟。'
  await fixture(async ({ call, events, read }) => {
    const args = { solved: true, independent: true, actualMin: 12 }
    assert.equal((await call(args)).ok, false)
    assert.equal((await call({ ...args, studentQuote: '不存在的原话' })).ok, false)
    events[0].data.source.kind = 'plugin:coach'
    assert.equal((await call({ ...args, studentQuote: quote })).ok, false)
    assert.equal(read('PROGRESS.yaml').nodes.A.passes, undefined)
  }, [quote])
})

test('explicit no-help statement is not mistaken for having used a hint', async () => {
  const quote = '我独立完成，没有用提示，没看题解，用了12分钟。'
  await fixture(async ({ call }) => {
    const r = await call({ solved: true, independent: true, actualMin: 12, studentQuote: quote })
    assert.equal(r.ok, true, r.reject)
  }, [quote])
})

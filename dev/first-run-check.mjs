import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 首次使用引导：账本空的给一个可执行入口；写过进度的不再打扰。
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coach-first-run-'))
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'MAP.yaml'),
    'meta: {version: 3}\nnodes:\n  - {id: 背包 DP, name: 背包 DP, domain: 动态规划, depends: []}\n')
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB }
  process.env.COACH_DATA_DIR = join(dir, 'knowledge')
  process.env.COACH_DB = join(dir, 'unused.db')
  const hooks = new Map(), tools = new Map()
  const { apply } = await import(`../index.js?first-run=${dir.replace(/\\/g, '/')}`)
  apply({
    tools: { register(tool) { tools.set(tool.name, tool) } }, get() {}, effect: (cb) => cb(), inject() {},
    on(event, handler) { hooks.set(event, handler) },
  })
  const step = async (text = '我想练区域赛') => {
    const incoming = [{ role: 'user', content: [{ type: 'text', text }] }]
    const decision = await hooks.get('agent/pre-step')({ messages: incoming, step: 1 },
      async () => ({ kind: 'enter', messages: incoming }))
    return decision.messages
  }
  return {
    dir, step, tools,
    cleanup() {
      for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('an empty ledger gets one executable first-run step, not a guessed lesson', async () => {
  const f = await fixture()
  try {
    const messages = await f.step()
    assert.equal(messages.length, 2, '首次使用要注入一条引导')
    const text = messages.at(-1).content.map((block) => block.text).join('\n')
    assert.match(text, /coach_setup status/)
    assert.match(text, /别先讲知识点/)
    assert.doesNotMatch(text, /游标/)

    // 静默降级要能被体检看见：假宿主没有 systemPrompt，规则必须报 missing。
    const ping = await f.tools.get('coach_ping').execute({})
    assert.equal(ping.rulesLoaded, 'missing')
    assert.ok(ping.stateInjectedAt, '状态注入成功要留时间戳')
    assert.equal(ping.lastError, '')
  } finally { f.cleanup() }
})

test('once the ledger exists the first-run hint stops', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'version: 1\ncursor: ""\nnodes: {}\n')
    const messages = await f.step('继续聊')
    assert.equal(messages.length, 1, '已配置的用户不该每轮被提醒')
  } finally { f.cleanup() }
})

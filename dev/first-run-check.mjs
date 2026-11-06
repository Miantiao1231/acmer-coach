import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 首次使用引导：账本空的给一个可执行入口；写过进度的不再打扰。
async function fixture(services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-first-run-'))
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'MAP.yaml'),
    'meta: {version: 3}\nnodes:\n  - {id: 背包 DP, name: 背包 DP, domain: 动态规划, depends: []}\n')
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, home: process.env.DSH_HOME }
  process.env.DSH_HOME = dir
  process.env.COACH_DATA_DIR = join(dir, 'knowledge')
  process.env.COACH_DB = join(dir, 'unused.db')
  const hooks = new Map(), tools = new Map()
  const { apply } = await import(`../index.js?first-run=${dir.replace(/\\/g, '/')}`)
  apply({
    tools: { register(tool) { tools.set(tool.name, tool) } }, get(name) { return services[name] }, effect: (cb) => cb(), inject() {},
    on(event, handler) { hooks.set(event, handler) },
  })
  const agent = { session: {} }
  const decide = async (text = '我想练区域赛') => {
    const incoming = [{ role: 'user', content: [{ type: 'text', text }] }]
    const decision = await hooks.get('agent/pre-step')({ messages: incoming, step: 1, agent },
      async () => ({ kind: 'enter', messages: incoming }))
    return decision
  }
  const step = async text => (await decide(text)).messages
  return {
    dir, step, decide, tools, agent, hooks,
    cleanup() {
      for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db], ['DSH_HOME', previous.home]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('native hosts receive current coach state as named context and keep identity on proactive wakes', async () => {
  const contexts = new Map()
  const f = await fixture({ systemPrompt: { refreshContext() {}, context(definition) { contexts.set(definition.name, definition) } } })
  try {
    assert.equal((await f.tools.get('companion').execute({ action: 'profile.set', identity: '小鲸，训练员的伙伴' }, { origin: 'human' })).ok, true)
    const messages = await f.step('聊聊天')
    assert.equal(messages.length, 1, 'native context replaces an extra durable plugin message')
    const state = contexts.get('coach:state')
    assert.match(state.text({ agent: f.agent }), /<coach_state>/)
    const other = { session: {} }
    assert.equal(state.text({ agent: other }), '', 'one session cannot see another session snapshot')
    const wake = [{ role: 'user', source: { kind: 'plugin:acmer-coach/proactive' }, content: [{ type: 'text', text: 'fixture wake' }] }]
    const woken = await f.hooks.get('agent/pre-step')({ messages: wake, step: 1, agent: f.agent }, async () => ({ kind: 'enter', messages: wake }))
    const wakeText = state.text({ agent: f.agent })
    assert.match(wakeText, /小鲸，训练员的伙伴/, 'a wake keeps the current identity')
    assert.doesNotMatch(wakeText, /coach_setup status|游标|押着一张卷/, 'a wake does not inherit previous training context')
    assert.equal(woken.messages.length, 1)
    const later = await f.hooks.get('agent/pre-step')({ messages: woken.messages, step: 2, agent: f.agent }, async () => woken)
    assert.equal(later.messages.length, 1, 'later steps do not inject the warm-up again')
  } finally { f.cleanup() }
})

test('a legacy host fallback wakes once with identity and boundaries, not on every step', async () => {
  const f = await fixture()
  try {
    await f.tools.get('companion').execute({ action: 'profile.set', identity: '小鲸，训练员的伙伴' }, { origin: 'human' })
    assert.equal((await f.tools.get('companion').execute({ action: 'boundary.add', boundaryText: '今天别催我做题', evidence: '今天别催我做题' }, { origin: 'human' })).ok, true)
    const wake = [{ role: 'user', source: { kind: 'plugin:acmer-coach/proactive' }, content: [{ type: 'text', text: 'fixture wake' }] }]
    const first = await f.hooks.get('agent/pre-step')({ messages: wake, step: 1, agent: f.agent }, async () => ({ kind: 'enter', messages: wake }))
    assert.equal(first.messages.length, 2, 'legacy hosts get one durable background message')
    const text = first.messages.at(-1).content.map(block => block.text).join('\n')
    assert.match(text, /小鲸，训练员的伙伴/)
    assert.match(text, /今天别催我做题/)
    assert.doesNotMatch(text, /coach_setup status|账本还是空的|游标/)
    const second = await f.hooks.get('agent/pre-step')({ messages: first.messages, step: 2, agent: f.agent }, async () => ({ kind: 'enter', messages: first.messages }))
    assert.equal(second.messages.length, 2, 'a second step does not stack another copy')
  } finally { f.cleanup() }
})

test('a host with context registration but no request refresh keeps the message fallback', async () => {
  const contexts = []
  const f = await fixture({ systemPrompt: { context(value) { contexts.push(value) } } })
  try {
    const messages = await f.step('聊聊天')
    assert.equal(messages.length, 2)
    assert.match(messages.at(-1).content[0].text, /coach_state/)
    assert.equal(contexts.length, 0, 'do not advertise native context without fresh request admission')
  } finally { f.cleanup() }
})

test('an outdated native system head starts one canonical request series without touching foreign system messages', async () => {
  const prompt = { context() {}, async assemble() { return { sections: [{ name: 'fixture-current', text: 'CURRENT FIXTURE PROMPT' }], variables: {}, contexts: [], tools: [] } } }
  const f = await fixture({ systemPrompt: prompt })
  try {
    const native = { type: 'system/message', data: { message: { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'OLD FIXTURE PROMPT' }] } } }
    const foreign = { type: 'system/message', data: { message: { source: { kind: 'another-plugin' }, content: [{ type: 'text', text: 'FOREIGN FIXTURE' }] } } }
    const session = events => ({ surface: { nodes: events.map((_, i) => i) }, eventAt: seq => events[seq], deriveEventMessage: event => event.data.message })
    f.agent.session = session([native])
    assert.equal((await f.decide()).startsRequestSeries, true)
    assert.notEqual((await f.decide()).startsRequestSeries, true, 'unchanged static setup is not reassembled every turn')
    f.hooks.get('system-prompt/change')()
    assert.equal((await f.decide()).startsRequestSeries, true)
    f.agent.session = session([native, foreign])
    assert.notEqual((await f.decide()).startsRequestSeries, true)
    assert.equal(f.agent.session.eventAt(0), native, 'the plugin does not write historical events')
  } finally { f.cleanup() }
})

test('an injection failure returns the original host decision instead of breaking the turn', async () => {
  const f = await fixture()
  try {
    const chat = { kind: 'enter', messages: undefined }
    const chatted = await f.hooks.get('agent/pre-step')({ messages: [], step: 1, agent: f.agent }, async () => chat)
    assert.equal(chatted, chat, 'a failed injection must not throw over the host decision')
    const wake = [{ role: 'user', source: { kind: 'plugin:acmer-coach/proactive' }, content: [{ type: 'text', text: 'fixture wake' }] }]
    const woken = await f.hooks.get('agent/pre-step')({ messages: wake, step: 1, agent: f.agent },
      async () => ({ kind: 'enter', messages: undefined }))
    assert.equal(woken.kind, 'enter')
    assert.equal(woken.messages, undefined)
  } finally { f.cleanup() }
})

test('an empty ledger gets one executable first-run step, not a guessed lesson', async () => {
  const f = await fixture()
  try {
    const messages = await f.step()
    assert.equal(messages.length, 2, '首次使用要注入一条引导')
    const text = messages.at(-1).content.map((block) => block.text).join('\n')
    assert.match(text, /coach_setup status/)
    assert.match(text, /普通闲聊不做体检/)
    assert.match(text, /别先讲知识点/)
    assert.match(text, /明确要开始训练/)
    assert.match(text, /临时提问.*不问建档/)
    assert.doesNotMatch(text, /游标/)

    // 静默降级要能被体检看见：假宿主没有 systemPrompt，规则必须报 missing。
    const ping = await f.tools.get('coach_ping').execute({})
    assert.equal(ping.rulesLoaded, 'missing')
    assert.ok(ping.stateInjectedAt, '状态注入成功要留时间戳')
    assert.equal(ping.lastError, '')
  } finally { f.cleanup() }
})

test('training status distinguishes memory lookup from saving new memories', async () => {
  const f = await fixture()
  try {
    const tool = f.tools.get('coach_status')
    const value = await tool.execute({})
    assert.equal(value.memoryRecallState, 'disabled')
    assert.equal(value.memoryRetainState, 'disabled')
    assert.equal(value.memoryLastRetainError, '')
    const rendered = tool.output.render({}, { ...value, memoryState: 'unavailable',
      memoryRecallState: 'ready', memoryRetainState: 'failed', memoryLastRetainError: 'HTTP 503' })
      .map(block => block.text).join('\n')
    assert.match(rendered, /记忆保存失败/)
    assert.doesNotMatch(rendered, /记忆召回暂不可用/)
  } finally { f.cleanup() }
})

test('once the ledger exists the first-run hint stops', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'version: 1\ncursor: ""\nnodes: {}\n')
    const messages = await f.step('继续聊')
    const text = messages.slice(1).flatMap(message => message.content.map(block => block.text)).join('\n')
    assert.doesNotMatch(text, /coach_setup status|账本还是空的/, '已配置的用户不该每轮被提醒')
  } finally { f.cleanup() }
})

test('an empty training ledger still carries the saved companion identity and boundaries', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.dir, 'knowledge', 'PROGRESS.yaml'), 'version: 1\ncursor: ""\nnodes: {}\n')
    const companion = f.tools.get('companion')
    assert.equal((await companion.execute({ action: 'profile.set', identity: '小鲸，训练员的亲密伙伴' }, { origin: 'human' })).ok, true)
    assert.equal((await companion.execute({ action: 'boundary.add', boundaryText: '今天别催我做题', evidence: '今天别催我做题' }, { origin: 'human' })).ok, true)
    const messages = await f.step('今天只想闲聊')
    const text = messages.slice(1).flatMap(message => message.content.map(block => block.text)).join('\n')
    assert.match(text, /小鲸，训练员的亲密伙伴/)
    assert.match(text, /今天别催我做题/)
    assert.doesNotMatch(text, /coach_setup status|账本还是空的/)
  } finally { f.cleanup() }
})

test('ordinary chat keeps identity and boundaries without the unrelated life appendix', async () => {
  const f = await fixture()
  try {
    const companion = f.tools.get('companion')
    const human = { origin: 'human' }
    assert.equal((await companion.execute({ action: 'profile.set', identity: '小鲸，训练员的伙伴', likes: ['小鱼干'] }, human)).ok, true)
    assert.equal((await companion.execute({ action: 'boundary.add', boundaryText: '不要催睡觉', evidence: '不要催睡觉' }, human)).ok, true)
    assert.equal((await companion.execute({ action: 'library.add', title: '月光书架噪音', note: '与眼前聊天无关' }, human)).ok, true)
    assert.equal((await companion.execute({ action: 'habit.add', situation: '闲聊', habitAction: '旧习惯噪音', evidence: '旧习惯原话' }, human)).ok, true)
    const messages = await f.step('我们聊点别的')
    const text = messages.slice(1).flatMap(message => message.content.map(block => block.text)).join('\n')
    assert.match(text, /小鲸，训练员的伙伴/)
    assert.match(text, /小鱼干/)
    assert.match(text, /不要催睡觉/)
    assert.doesNotMatch(text, /月光书架噪音|旧习惯噪音|你今天的小日记|你最近学到的说法/)
    const library = await companion.execute({ action: 'read', section: 'library' })
    assert.equal(library.ok, true)
    assert.match(library.summary, /月光书架噪音/)
    const habits = await companion.execute({ action: 'read', section: 'habits' })
    assert.match(habits.summary, /旧习惯噪音/)
  } finally { f.cleanup() }
})

// 情绪与作息的对话注入验收（issue #16）：
// - <coach_state> 必须带身体/心情/作息，且明确「只影响语气，不改判断/账本/工具参数」；
// - 睡觉状态只来自 sleep-ledger：正在睡/刚被叫醒/刚睡醒，聊天时不会假装自己还在睡；
// - persona 告诉模型她有作息、可以用 companion presence.set 记 sleep/nap。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBody, sleepStateNote, stateToneLines } from '../lib/body-state.js'
import { emptySleepLedger, startSleepEpisode, finishSleepEpisode, interruptSleepEpisode } from '../lib/sleep-ledger.js'

let imports = 0

// presence 是页面、下一轮注入和叫醒判断共用的真相：测试直接读落盘文件，不读内存快照。
const readPresence = (f) => JSON.parse(readFileSync(f.personPath, 'utf8')).presence

// 睡眠结算依赖「现在」：用可拨的假时钟复现同一夜的两段睡眠（照 WS4 的 verify-sleep-cycle.mjs）。
function fakeClock(t, iso) {
  const RealDate = Date
  let clock = new RealDate(iso).getTime()
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(clock) }
    static now() { return clock }
  }
  globalThis.Date = FakeDate
  t.after(() => { globalThis.Date = RealDate })
  return (nextIso) => { clock = new RealDate(nextIso).getTime() }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// 和 first-run-check 同一个套路：走公开 apply 入口、抓注入消息，不碰真实数据目录。
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-mood-tone-'))
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  const previous = { data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB, home: process.env.DSH_HOME }
  process.env.DSH_HOME = dir
  process.env.COACH_DATA_DIR = join(dir, 'knowledge')
  process.env.COACH_DB = join(dir, 'unused.db')
  t.after(() => {
    for (const [key, value] of [['COACH_DATA_DIR', previous.data], ['COACH_DB', previous.db], ['DSH_HOME', previous.home]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'knowledge', 'MAP.yaml'),
    'meta: {version: 3}\nnodes:\n  - {id: 背包 DP, name: 背包 DP, domain: 动态规划, depends: []}\n')
  const { apply } = await import(`../index.js?mood-tone=${++imports}`)
  const tools = new Map(), hooks = new Map()
  apply({
    tools: { register(tool) { tools.set(tool.name, tool) } },
    get() { return undefined },
    effect: (callback) => callback(),
    inject() {},
    on(event, handler) { hooks.set(event, handler) },
  })
  const agent = { session: {} }
  const statePath = join(dir, 'knowledge', 'companion-state.json')
  const personPath = join(dir, 'knowledge', 'person.json')
  return {
    dir,
    tools,
    hooks,
    agent,
    statePath,
    personPath,
    // 预置一份状态文件：测试要控制精力/困倦/生活状态，而不依赖真实时钟和历史。
    saveState(body, roleState = null) {
      const payload = { version: 1, lastUserAt: '', body, ...(roleState ? { roleState } : {}) }
      writeFileSync(statePath, JSON.stringify(payload))
    },
    async step(text) {
      const incoming = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]
      const decision = await hooks.get('agent/pre-step')({ messages: incoming, step: 1, agent },
        async () => ({ kind: 'enter', messages: incoming }))
      return decision.messages.map((message) => Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        : '').join('\n')
    },
  }
}

test('sleep state comes from the sleep ledger, never from prose', () => {
  const now = new Date('2026-10-30T12:00:00')
  const active = emptySleepLedger(0)
  startSleepEpisode(active, { kind: 'night', baseNeedMinutes: 480, now: new Date('2026-10-30T00:00:00') })
  assert.match(sleepStateNote(active, now), /正在睡/)
  // 被真人消息叫醒的这一轮：账本还停在 active 也不能说“正在睡”。
  assert.match(sleepStateNote(active, now, { woken: true }), /被叫醒/)
  assert.doesNotMatch(sleepStateNote(active, now, { woken: true }), /正在睡/)
  assert.doesNotMatch(stateToneLines(emptyBody(now), { sleepLedger: active, now, woken: true }).join('\n'), /正在睡/)

  const paused = emptySleepLedger(0)
  const started = startSleepEpisode(paused, { kind: 'night', baseNeedMinutes: 480, now: new Date('2026-10-30T05:00:00') })
  interruptSleepEpisode(paused, started.episode.id, { now: new Date('2026-10-30T06:00:00') })
  assert.match(sleepStateNote(paused, new Date('2026-10-30T06:05:00')), /被叫醒/)

  const completed = emptySleepLedger(0)
  const done = startSleepEpisode(completed, { kind: 'night', baseNeedMinutes: 480, now: new Date('2026-10-30T00:00:00') })
  finishSleepEpisode(completed, done.episode.id, { now: new Date('2026-10-30T08:00:00') })
  assert.match(sleepStateNote(completed, new Date('2026-10-30T08:05:00')), /刚睡醒/)
  assert.equal(sleepStateNote(completed, new Date('2026-10-30T09:00:00')), '', '几小时前睡过不算当下状态')

  const nap = emptySleepLedger(0)
  startSleepEpisode(nap, { kind: 'nap', baseNeedMinutes: 30, now: new Date('2026-10-30T13:00:00') })
  assert.match(sleepStateNote(nap, new Date('2026-10-30T13:05:00')), /正在午休/)
})

test('state tone lines carry body, mood, life and sleep in one place', () => {
  const now = new Date('2026-10-30T12:00:00')
  const body = emptyBody(now)
  body.energy = 28
  body.fatigue = 72
  const paused = emptySleepLedger(0)
  const started = startSleepEpisode(paused, { kind: 'night', baseNeedMinutes: 480, now: new Date('2026-10-30T05:00:00') })
  interruptSleepEpisode(paused, started.episode.id, { now: new Date('2026-10-30T06:00:00') })
  const lines = stateToneLines(body, {
    roleState: { sleepiness: 75, hunger: 70, health: 40, busy: false, location: '在教室' },
    sleepLedger: paused,
    now,
  })
  assert.match(lines[0], /精力 28\/100/)
  assert.match(lines[0], /心情：/)
  const life = lines.join('\n')
  assert.match(life, /- 生活：/)
  assert.match(life, /很困/)
  assert.match(life, /有点饿/)
  assert.match(life, /身体不太舒服/)
  assert.match(life, /被叫醒/)
  assert.match(life, /在教室/)
})

test('coach state injects the current body, mood and life with a clear tone-only boundary', async (t) => {
  const f = await fixture(t)
  const now = new Date()
  const body = emptyBody(now)
  body.energy = 28
  body.fatigue = 72
  f.saveState(body, {
    sleepiness: 75, hunger: 70, health: 40, busy: false,
    mood: '平静', location: '在教室', conditions: [], updatedAt: now.toISOString(),
  })
  const text = await f.step('陪我聊两句')
  assert.match(text, /<coach_state>/)
  assert.match(text, /- 身体：精力 28\/100/)
  assert.match(text, /心情：平静/)
  assert.match(text, /- 生活：/)
  assert.match(text, /很困/)
  assert.match(text, /有点饿/)
  assert.match(text, /在教室/)
  // 边界必须写在注入里：只影响语气，不改判断/账本/工具参数，也不逐项播报。
  assert.match(text, /只影响你此刻的语气、关注点和要不要劝他休息/)
  assert.match(text, /不改变训练判断、账本事实和工具参数/)
  assert.match(text, /不用每轮逐项播报/)
})

test('a praised user message lifts the injected mood and is persisted for later turns', async (t) => {
  const f = await fixture(t)
  f.saveState(emptyBody(new Date()))
  const text = await f.step('你好厉害，太谢谢你了')
  assert.match(text, /心情：开心/, '被夸后注入的心情该跟着四轴走')
  const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
  assert.ok(saved.body.joy > 6, `社交情绪要落进状态，面板和下一轮才有变化：got ${saved.body.joy}`)
})

test('repeated complaints change the injected tone word, and an apology settles it', async (t) => {
  const f = await fixture(t)
  f.saveState(emptyBody(new Date()))
  let text = ''
  // 负面轴要能累积到语气词变化（阈值 3，一条消息还不够，连续几条才「有点气」）。
  for (const message of ['最近好烦', '真的好烦', '烦死了']) text = await f.step(message)
  assert.match(text, /心情：有点气/, '连续被烦到，注入的心情词该变')
  const settled = await f.step('对不起，我错了')
  assert.match(settled, /心情：平静/, '道歉后气消了，语气词该回稳')
})

test('a real message wakes her: presence returns to auto and later turns stay awake', async (t) => {
  const f = await fixture(t)
  const set = await f.tools.get('companion').execute({ action: 'presence.set', mode: 'sleep' }, { origin: 'human' })
  assert.equal(set.ok, true)
  assert.equal(readPresence(f).mode, 'sleep', 'presence.set 后先确认她在睡')

  const woken = await f.step('我回来啦')
  assert.doesNotMatch(woken, /正在睡|正在午休/, '正在聊天时不能声称自己还睡着')
  assert.match(woken, /被叫醒|刚睡醒|刚午休醒来|还没完全清醒/, '这一轮要说明刚被叫醒')
  assert.equal(readPresence(f).mode, 'auto', '被真人消息叫醒后 presence 必须回 auto，否则页面和下一轮还会显示睡着')

  // 下一轮不靠这一轮的临时标记：presence 已落盘、sleep-ledger 已结算，仍不能说正在睡。
  const next = await f.step('刚才说到哪了')
  assert.doesNotMatch(next, /正在睡|正在午休/)
  assert.equal(readPresence(f).mode, 'auto')
})

test('a proactive wake does not clear an explicit sleep presence', async (t) => {
  const f = await fixture(t)
  const set = await f.tools.get('companion').execute({ action: 'presence.set', mode: 'sleep' }, { origin: 'human' })
  assert.equal(set.ok, true)
  const wake = [{ role: 'user', source: { kind: 'plugin:acmer-coach/proactive' }, content: [{ type: 'text', text: 'fixture wake' }] }]
  await f.hooks.get('agent/pre-step')({ messages: wake, step: 1, agent: f.agent },
    async () => ({ kind: 'enter', messages: wake }))
  assert.equal(readPresence(f).mode, 'sleep', '主动唤醒不是真人消息，不该清掉她自己的睡觉状态')
})

test('waking from one night and going back to sleep does not repay the whole night twice', async (t) => {
  const setClock = fakeClock(t, '2026-11-10T00:10:00')
  const f = await fixture(t)
  const companion = f.tools.get('companion')
  const ledgerPath = join(f.dir, 'knowledge', 'sleep-ledger.json')

  assert.equal((await companion.execute({ action: 'presence.set', mode: 'sleep' }, { origin: 'human' })).ok, true)
  setClock('2026-11-10T00:55:00') // 第一段睡 45 分钟，被真人消息叫醒
  await f.step('还在吗')
  assert.equal(Math.round(readJson(f.statePath).body.sleepDebt), 435, '单次叫醒：480 - 45')

  // 她说「继续去睡」：同一夜续睡只该补剩下的需求，不再按整夜 480 分钟重算。
  assert.equal((await companion.execute({ action: 'presence.set', mode: 'sleep' }, { origin: 'human' })).ok, true)
  setClock('2026-11-10T02:00:00') // 第二段 65 分钟，再被叫醒
  await f.step('我又来了')
  const body = readJson(f.statePath).body
  assert.ok(Math.abs(body.sleepDebt - 370) <= 5, `同一夜 45+65 分钟应约 480-110=370，got ${body.sleepDebt}`)
  assert.ok(body.energy >= 0 && body.energy <= 100, `energy 越界：${body.energy}`)
  assert.ok(body.fatigue >= 0 && body.fatigue <= 100, `fatigue 越界：${body.fatigue}`)

  const episodes = readJson(ledgerPath).episodes
  assert.deepEqual(episodes.map((episode) => episode.baseNeedMinutes), [45, 435],
    '旧段 base 改成实际睡眠（债务贡献归零），新段只带这一夜剩余需求')
})

test('one wake without going back to sleep keeps the plain short-night debt', async (t) => {
  const setClock = fakeClock(t, '2026-11-10T00:10:00')
  const f = await fixture(t)
  const companion = f.tools.get('companion')
  const ledgerPath = join(f.dir, 'knowledge', 'sleep-ledger.json')

  assert.equal((await companion.execute({ action: 'presence.set', mode: 'sleep' }, { origin: 'human' })).ok, true)
  setClock('2026-11-10T00:55:00')
  await f.step('还在吗')
  assert.equal(Math.round(readJson(f.statePath).body.sleepDebt), 435, '没续睡就保持现有行为：480 - 45')
  const episodes = readJson(ledgerPath).episodes
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].baseNeedMinutes, 480, '没有续睡时不该改写整夜需求')
})

test('mood is style-only: the injection never turns it into judgment or tool arguments', async (t) => {
  const f = await fixture(t)
  const now = new Date()
  const body = emptyBody(now)
  body.joy = 2
  body.anger = 9
  body.sorrow = 8
  f.saveState(body)
  const text = await f.step('我好烦，好难过')
  assert.match(text, /不改变训练判断、账本事实和工具参数/)
  for (const pattern of [
    /因为(心情|情绪|累|困)/,
    /(心情|情绪)不好.*(就别|不用|跳过|降低|放宽)/,
    /降低(标准|要求)/,
    /跳过(训练|检测)/,
    /别(做|开)检测/,
    /不要提醒他/,
  ]) {
    assert.doesNotMatch(text, pattern, `情绪不得越界：${pattern}`)
  }
  // 没有睡眠记录时，不能凭空说自己睡了/睡够了。
  assert.doesNotMatch(text, /已经睡了|睡饱了|睡够了/)
})

test('persona tells her she has a schedule and should record sleep through the companion tool', () => {
  const persona = readFileSync(new URL('../assets/persona/xiaojing-coach.md', import.meta.url), 'utf8')
  assert.match(persona, /## 我的作息/)
  assert.match(persona, /会困/)
  assert.match(persona, /presence\.set/)
  assert.match(persona, /sleep.*nap|nap.*sleep/)
  assert.match(persona, /不要否认自己有睡觉功能/)
  assert.match(persona, /不要编造/)
  // presence.set 的 mode 枚举只有 auto/busy/away/sleep/nap：写错枚举模型会调一个必被拒的参数。
  const schedule = persona.slice(persona.indexOf('## 我的作息'), persona.indexOf('## 主动联系'))
  assert.match(schedule, /醒来再改回 `auto`/)
  assert.doesNotMatch(schedule, /`online`|`offline`|`sleeping`|`napping`/, '作息段只能出现 presence.set 接受的枚举')
})

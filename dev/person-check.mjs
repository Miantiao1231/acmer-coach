import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyPerson, loadPerson, savePerson, createCompanionTool,
  effectivePresence, presenceDelay, personLines, memoryLines, relationStage,
  studentContextSnapshot,
} from '../lib/person.js'
import { emptyCompanionState, saveCompanionState, loadCompanionState } from '../lib/companion-state.js'
import {
  startSleepEpisode, finishSleepEpisode, updateSleepLedger, loadSleepLedger,
} from '../lib/sleep-ledger.js'

const NOW = new Date('2026-10-30T12:00:00')

test('student context defaults to its source day and never mutates the saved record', () => {
  const source = new Date(2026, 9, 31, 9)
  const midnight = new Date(2026, 10, 1)
  const context = { quote: '今天临时有课', at: source.toISOString(), messageId: 'm1', expiresAt: new Date(2026, 10, 7).toISOString() }
  const original = structuredClone(context)
  assert.equal(studentContextSnapshot(context, new Date(midnight.getTime() - 1)).status, 'active')
  assert.equal(studentContextSnapshot(context, midnight).status, 'expired')
  assert.equal(studentContextSnapshot(context, midnight).expiresAt, midnight.toISOString())
  assert.deepEqual(context, original)
  const earlier = { ...context, expiresAt: new Date(2026, 9, 31, 10).toISOString() }
  assert.equal(studentContextSnapshot(earlier, new Date(2026, 9, 31, 10)).status, 'expired')
  for (const at of [undefined, '', 'bad-date']) assert.equal(studentContextSnapshot({ ...context, at }, source).status, 'unknown')
  assert.equal(studentContextSnapshot({ ...context, at: new Date(source.getTime() + 1).toISOString() }, source).status, 'unknown')
  assert.equal(studentContextSnapshot({ ...context, expiresAt: 'broken' }, source).status, 'unknown')
  assert.equal(studentContextSnapshot({ ...context, expiryMode: 'explicit', expiresAt: source.toISOString() }, source).status, 'unknown')
  assert.equal(studentContextSnapshot({ quote: context.quote, at: source.toISOString() }, source).status, 'active')
  assert.equal(studentContextSnapshot(null, source), null)
  const explicit = { ...context, expiryMode: 'explicit', expiresAt: new Date(2026, 10, 2).toISOString() }
  assert.equal(studentContextSnapshot(explicit, new Date(2026, 10, 1, 12)).status, 'active')
})

test('explicit student context survives claims projection and same-quote deadline corrections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-context-deadline-'))
  try {
    const person = loadPerson(dir)
    person.context = { quote: '这两天都有课', at: new Date(2026, 10, 4, 10).toISOString(), messageId: 'm1',
      expiryMode: 'explicit', expiresAt: new Date(2026, 10, 6).toISOString() }
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir)
    assert.equal(loaded.context.expiryMode, 'explicit')
    assert.equal(studentContextSnapshot(loaded.context, new Date(2026, 10, 5, 12)).status, 'active')
    loaded.context = { ...loaded.context, at: new Date(2026, 10, 5, 10).toISOString(),
      expiresAt: new Date(2026, 10, 5, 11).toISOString(), expiryMode: 'day' }
    assert.equal(savePerson(dir, loaded), true)
    assert.deepEqual(loadPerson(dir).context, loaded.context)
    assert.equal(studentContextSnapshot(loadPerson(dir).context, new Date(2026, 10, 5, 12)).status, 'expired')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// These CRUD fixtures stand in for the host's current-session quote lookup.
const verifiedTool = (dir, quotes) => createCompanionTool(dir, {
  verifyEvidence: async quote => ({ ok: quotes.includes(quote), reject: '夹具会话没有这段原话' }),
})

test('defaults give her a self; missing or corrupt files fall back without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const defaults = loadPerson(dir, NOW)
    assert.equal(defaults.profile.identity.includes('小鲸'), true)
    assert.ok(defaults.profile.likes.length)
    assert.deepEqual(defaults.relation, { milestones: [] })
    assert.deepEqual(defaults.habits, [])
    assert.deepEqual(defaults.library, [])
    assert.equal(defaults.presence.mode, 'auto')

    writeFileSync(join(dir, 'person.json'), '{bad json', 'utf8')
    assert.deepEqual(loadPerson(dir, NOW).relation, { milestones: [] })
    writeFileSync(join(dir, 'person.json'), JSON.stringify({ version: 99 }), 'utf8')
    assert.equal(loadPerson(dir, NOW).profile.identity.includes('小鲸'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('person state round-trips and stays bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const person = emptyPerson(NOW)
    person.profile.likes = Array.from({ length: 30 }, (_, i) => `喜欢${i}`)
    person.relation.milestones.push({ id: 'm1', label: '第一次说心里话', date: '2026-10-01', evidence: '原话', createdAt: NOW.toISOString() })
    assert.equal(savePerson(dir, person), true)
    const loaded = loadPerson(dir, NOW)
    assert.equal(loaded.profile.likes.length, 12)
    assert.equal(loaded.relation.milestones[0].label, '第一次说心里话')
    assert.match(readFileSync(join(dir, 'person.json'), 'utf8'), /第一次说心里话/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('read sections expose saved life and archive data without settling or generating them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-read-'))
  try {
    savePerson(dir, emptyPerson())
    writeFileSync(join(dir, 'companion-state.json'), JSON.stringify({
      ...emptyCompanionState(NOW), life: { day: '2026-10-30', description: '在看星星', updatedAt: NOW.toISOString() },
      journal: { day: '2026-10-30', text: '只是一条兜底模板', at: NOW.toISOString() },
    }))
    writeFileSync(join(dir, 'journal-archive.json'), JSON.stringify({ version: 1, entries: [] }))
    const beforePerson = readFileSync(join(dir, 'person.json'), 'utf8')
    const beforeState = readFileSync(join(dir, 'companion-state.json'), 'utf8')
    const tool = createCompanionTool(dir)
    const life = await tool.execute({ action: 'read', section: 'life' })
    assert.equal(life.ok, true)
    assert.match(life.summary, /在看星星/)
    const journal = await tool.execute({ action: 'read', section: 'journal' })
    assert.equal(journal.ok, true)
    assert.doesNotMatch(journal.summary, /只是一条兜底模板/)
    await assert.rejects(() => tool.execute({ action: 'read', section: 'unknown' }), /section/)
    assert.equal(readFileSync(join(dir, 'person.json'), 'utf8'), beforePerson)
    assert.equal(readFileSync(join(dir, 'companion-state.json'), 'utf8'), beforeState)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('context trimming retains the last explicit boundary and pinned request', () => {
  const person = emptyPerson()
  person.boundaries = Array.from({ length: 12 }, (_, n) => ({ id: `b${n}`, text: `明确边界${n}` }))
  person.pinned = Array.from({ length: 12 }, (_, n) => ({ id: `p${n}`, text: `置顶请求${n}` }))
  const text = memoryLines(person, NOW, { lastUserText: '聊聊' }).join('\n')
  assert.match(text, /明确边界11/)
  assert.match(text, /置顶请求11/)
})

test('read distinguishes absent saved life and keeps archive sources and recent wording', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-read-sources-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tool = createCompanionTool(dir)
  const read = async section => JSON.parse((await tool.execute({ action: 'read', section, limit: 1 })).summary.split('\n').slice(1).join('\n'))
  assert.equal(await read('life'), null)
  writeFileSync(join(dir, 'companion-state.json'), '{bad json')
  assert.equal(await read('life'), null)
  writeFileSync(join(dir, 'companion-state.json'), JSON.stringify({ version: 1, life: {} }))
  assert.equal(await read('life'), null)
  writeFileSync(join(dir, 'journal-archive.json'), JSON.stringify({ version: 1, entries: [{
    day: '2026-11-04', kind: 'journal', body: '模板日记', source: 'fallback', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  }] }))
  const journal = await read('journal')
  assert.equal(journal[0].source, 'fallback')
  assert.equal(journal[0].createdAt, NOW.toISOString())
  writeFileSync(join(dir, 'habit-candidates.json'), JSON.stringify({ version: 1, items: [
    { sig: 'recent', text: '最近说法', count: 20, lastAt: '2026-11-04T00:00:00Z' },
    { sig: 'old', text: '旧说法', count: 1, lastAt: '2026-10-01T00:00:00Z' },
  ] }))
  assert.equal((await read('habits')).observedWording[0].text, '最近说法')
})

test('profile.set replaces only the fields it is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const tool = createCompanionTool(dir)
    const before = await tool.execute({ action: 'read' })
    assert.equal(before.ok, true)
    const result = await tool.execute({ action: 'profile.set', likes: ['热可可', '被摸头'] }, { origin: 'human' })
    assert.equal(result.ok, true)
    const read = await tool.execute({ action: 'read' })
    assert.match(read.summary, /热可可/)
    assert.match(read.summary, /小鲸/)
    assert.equal((await tool.execute({ action: 'profile.set', identity: '小鲸，蓝头发的鲸鱼娘' }, { origin: 'human' })).ok, true)
    assert.equal(loadPerson(dir, NOW).profile.identity, '小鲸，蓝头发的鲸鱼娘')
    assert.deepEqual(loadPerson(dir, NOW).profile.likes, ['热可可', '被摸头'])
    assert.equal((await tool.execute({ action: 'profile.set', identity: ' ' }, { origin: 'human' })).ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('relation.add needs a real date and evidence, rejects the future and dedupes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const tool = createCompanionTool(dir)
    // 模型这一侧只能提候选：纪念日是对关系的解读，采用权在他。
    const proposed = await tool.execute({ action: 'relation.add', label: '第一次见面', date: '2026-10-30', evidence: '今天第一次说话' })
    assert.equal(proposed.ok, true)
    assert.match(proposed.summary, /待确认/)
    assert.equal((await tool.execute({ action: 'relation.add', label: '第一次见面', date: '2026-10-30', evidence: '今天第一次说话' })).ok, true)
    assert.equal((await tool.execute({ action: 'relation.add', label: '未来的事', date: '2099-01-01', evidence: 'x' })).ok, false)
    assert.equal((await tool.execute({ action: 'relation.add', label: '没有证据', date: '2026-10-01', evidence: '' })).ok, false)
    assert.match((await tool.execute({ action: 'read' })).summary, /纪念日：0 条/)

    // 页面上是他本人，才真的写进纪念日。
    const human = await tool.execute(
      { action: 'relation.add', label: '第一次见面', date: '2026-10-30', evidence: '今天第一次说话' },
      { origin: 'human' },
    )
    assert.equal(human.ok, true)
    assert.match((await tool.execute({ action: 'read' })).summary, /纪念日：1 条/)

    // 采用候选也只能他来点。
    const pendingId = (await tool.execute({ action: 'pending.list' })).summary.match(/\[([^\]]+)\]/)?.[1]
    assert.ok(pendingId)
    assert.equal((await tool.execute({ action: 'pending.accept', id: pendingId })).ok, false)
    assert.equal((await tool.execute({ action: 'pending.accept', id: pendingId }, { origin: 'human' })).ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('habit.add needs evidence and dedupes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const tool = verifiedTool(dir, ['他说不会捏'])
    const args = { action: 'habit.add', situation: '他卡住时', habitAction: '先问想到哪一步', boundary: '不直接给答案', evidence: '他说不会捏' }
    assert.equal((await tool.execute(args)).ok, true)
    assert.equal((await tool.execute(args)).ok, true)
    assert.equal((await tool.execute({ ...args, evidence: '' })).ok, false)
    const read = await tool.execute({ action: 'read' })
    assert.match(read.summary, /习惯：1 条/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('library reads expose metadata and a short preview, not the saved text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-library-view-'))
  try {
    const tool = createCompanionTool(dir)
    const excerpt = '开头标记' + '正'.repeat(59990) + '结尾标记'
    const added = await tool.execute({ action: 'library.add', title: '长文', excerpt, readingOffset: 0, readingHash: 'h' }, { origin: 'internal' })
    assert.equal(added.ok, true, added.reject)
    const read = await tool.execute({ action: 'read', section: 'library' })
    assert.equal(read.ok, true, read.reject)
    assert.match(read.summary, /excerptLength/)
    assert.match(read.summary, /59998/, 'the length is reported')
    assert.match(read.summary, /开头标记/)
    assert.doesNotMatch(read.summary, /结尾标记/, 'the saved text is not returned')
    assert.ok(read.summary.length < 2000, `library read is ${read.summary.length} chars`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('library add / progress / share', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const tool = createCompanionTool(dir)
    assert.equal((await tool.execute({ action: 'share' })).ok, false, 'empty shelf cannot share')
    assert.equal((await tool.execute({ action: 'library.add', title: '《海》', source: '书店', note: '讲潮汐的那段很好' }, { origin: 'internal' })).ok, true)
    assert.equal((await tool.execute({ action: 'library.add', title: '《海》' }, { origin: 'internal' })).ok, false, 'duplicate title')
    assert.equal((await tool.execute({ action: 'library.progress', title: '《海》', progress: 0.4, note: '看到第三章' }, { origin: 'internal' })).ok, true)
    const share = await tool.execute({ action: 'share' })
    assert.equal(share.ok, true)
    assert.match(share.summary, /《海》/)
    assert.match(share.summary, /看到第三章/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('model shelf writes become pending candidates; the page still adopts them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-library-pending-'))
  try {
    const tool = createCompanionTool(dir, {
      verifyEvidence: async quote => quote === '我在读《海》'
        ? { ok: true, studentEvidence: { quote, messageId: 'm1', seq: 1 } }
        : { ok: false, reject: 'no quote' },
    })
    // 「我在读…」是学生自己的阅读，没明确说是给小鲸的：仍然只提候选。
    const proposed = await tool.execute({ action: 'library.add', title: '《海》', evidence: '我在读《海》' })
    assert.equal(proposed.ok, true, proposed.reject)
    assert.match(proposed.summary, /待审/)
    assert.equal(loadPerson(dir).library.length, 0)
    const pending = loadPerson(dir).pending.find(item => item.kind === 'library')
    assert.ok(pending, 'library candidate is pending')
    assert.equal(pending.subject, 'role')
    const accepted = await tool.execute({ action: 'pending.accept', id: pending.id }, { origin: 'human' })
    assert.equal(accepted.ok, true, accepted.reject)
    assert.equal(loadPerson(dir).library.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('explicit role-directed quotes write preferences and the shelf directly; ambiguous quotes stay pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-directed-'))
  try {
    const quotes = new Set(['你以后喜欢被摸头吧', '我喜欢热可可，你记住了吗', '这本书你拿去读', '我在读《海》', '你在看什么书？'])
    const tool = createCompanionTool(dir, {
      verifyEvidence: async quote => quotes.has(quote)
        ? { ok: true, studentEvidence: { quote, messageId: 'm-directed', seq: 1 } }
        : { ok: false, reject: 'no quote' },
    })
    // 第二人称和偏好词在同一小句：按用户指令直写，不再堆成候选。
    const direct = await tool.execute({ action: 'profile.set', likes: ['被摸头'], evidence: '你以后喜欢被摸头吧' })
    assert.equal(direct.ok, true, direct.reject)
    assert.doesNotMatch(direct.summary, /待审/)
    assert.ok(loadPerson(dir).profile.likes.includes('被摸头'))
    assert.equal(loadPerson(dir).pending.length, 0)
    // 重复写同一条不重复追加。
    assert.equal((await tool.execute({ action: 'profile.set', likes: ['被摸头'], evidence: '你以后喜欢被摸头吧' })).ok, true)
    assert.equal(loadPerson(dir).profile.likes.filter(item => item === '被摸头').length, 1)

    // 「我喜欢热可可，你记住了吗」主角仍是学生自己：即使句尾有「你」也只入待审。
    const ambiguous = await tool.execute({ action: 'profile.set', dislikes: ['恐怖片'], evidence: '我喜欢热可可，你记住了吗' })
    assert.equal(ambiguous.ok, true, ambiguous.reject)
    assert.match(ambiguous.summary, /待审/)
    assert.equal(loadPerson(dir).profile.dislikes.includes('恐怖片'), false)
    assert.ok(loadPerson(dir).pending.some(item => item.kind === 'profile' && item.subject === 'role'))

    // 书架同理：明确说给她读的直写；学生自己的书仍入待审。
    const shelf = await tool.execute({ action: 'library.add', title: '海', evidence: '这本书你拿去读' })
    assert.equal(shelf.ok, true, shelf.reject)
    assert.doesNotMatch(shelf.summary, /待审/)
    assert.deepEqual(loadPerson(dir).library.map(item => item.title), ['海'])
    const ownBook = await tool.execute({ action: 'library.add', title: '算法导论', evidence: '我在读《海》' })
    assert.equal(ownBook.ok, true, ownBook.reject)
    assert.match(ownBook.summary, /待审/)
    // 问她在读什么只是在打听，不等于把书给她；也不直写。
    const asking = await tool.execute({ action: 'library.add', title: '算法竞赛入门', evidence: '你在看什么书？' })
    assert.equal(asking.ok, true, asking.reject)
    assert.match(asking.summary, /待审/)
    assert.deepEqual(loadPerson(dir).library.map(item => item.title), ['海'])

    // 身份/来历仍然只能由页面编辑；模型也不能靠直写清空列表。
    assert.equal((await tool.execute({ action: 'profile.set', background: ['来自深海'], evidence: '你以后喜欢被摸头吧' })).ok, false)
    assert.equal((await tool.execute({ action: 'profile.set', likes: [], evidence: '你以后喜欢被摸头吧' })).ok, false)
    assert.deepEqual(loadPerson(dir).profile.background, [])

    // 上限守卫在直写路径同样生效，且不会淘汰旧项。
    const person = loadPerson(dir)
    person.profile.likes = Array.from({ length: 12 }, (_, index) => `喜欢${index}`)
    assert.equal(savePerson(dir, person), true)
    const full = await tool.execute({ action: 'profile.set', likes: ['被摸头'], evidence: '你以后喜欢被摸头吧' })
    assert.equal(full.ok, false)
    assert.match(full.reject, /12/)
    assert.equal(loadPerson(dir).profile.likes.length, 12)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('entering and leaving sleep does not instantly refill or erase the body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const now = new Date()
    const companion = emptyCompanionState(now)
    companion.lastUserAt = now.toISOString()
    companion.body = {
      ...companion.body,
      energy: 20, fatigue: 80, sleepDebt: 400, updatedAt: now.toISOString(),
    }
    assert.equal(saveCompanionState(dir, companion), true)
    const tool = createCompanionTool(dir)
    assert.equal((await tool.execute({ action: 'presence.set', mode: 'sleep' })).ok, true)
    const sleeping = loadCompanionState(dir, now)
    assert.ok(sleeping.body.fatigue >= 79, `setting sleep must not instantly recover fatigue, got ${sleeping.body.fatigue}`)
    assert.ok(sleeping.body.sleepDebt <= 1, 'the new ledger starts with no old buggy debt')
    assert.equal((await tool.execute({ action: 'presence.set', mode: 'auto' })).ok, true)
    const awake = loadCompanionState(dir, now)
    assert.ok(awake.body.fatigue >= 79, `switching back must not refill fatigue, got ${awake.body.fatigue}`)
    assert.ok(awake.body.sleepDebt <= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a legacy sleep without since does not explode sleep debt when switched off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const now = new Date()
    const updated = new Date(now.getTime() - 10 * 60 * 1000)
    const companion = emptyCompanionState(updated)
    companion.lastUserAt = updated.toISOString()
    companion.body = {
      ...companion.body,
      energy: 20, fatigue: 80, sleepDebt: 400, updatedAt: updated.toISOString(),
    }
    assert.equal(saveCompanionState(dir, companion), true)
    const person = loadPerson(dir, now)
    person.presence = { mode: 'sleep', until: '', reason: '' }
    assert.equal(savePerson(dir, person), true)
    const tool = createCompanionTool(dir)
    assert.equal((await tool.execute({ action: 'presence.set', mode: 'auto' })).ok, true)
    const after = loadCompanionState(dir, now)
    assert.ok(after.body.sleepDebt <= 400, `a 10min legacy sleep must not add a night of debt, got ${after.body.sleepDebt}`)
    assert.equal(loadPerson(dir, now).presence.mode, 'auto')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a nap is recorded as a nap, not as a short night', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const now = new Date()
    const companion = emptyCompanionState(now)
    companion.lastUserAt = now.toISOString()
    companion.body = { ...companion.body, energy: 30, fatigue: 60, sleepDebt: 0, updatedAt: now.toISOString() }
    assert.equal(saveCompanionState(dir, companion), true)
    const tool = createCompanionTool(dir)
    assert.equal((await tool.execute({ action: 'presence.set', mode: 'nap' })).ok, true)
    const sleeping = loadSleepLedger(dir)
    assert.equal(sleeping.episodes.length, 1)
    assert.equal(sleeping.episodes[0].kind, 'nap')
    assert.equal(sleeping.episodes[0].state, 'active')
    assert.equal((await tool.execute({ action: 'presence.set', mode: 'auto' })).ok, true)
    const after = loadSleepLedger(dir)
    assert.equal(after.episodes[0].state, 'completed')
    assert.equal(after.episodes[0].kind, 'nap')
    assert.equal(after.episodes[0].baseNeedMinutes, 30)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('switching off a presence sleep that already settled does not add a second episode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const now = new Date()
    const since = new Date(now.getTime() - 8 * 3600 * 1000)
    const companion = emptyCompanionState(since)
    companion.lastUserAt = since.toISOString()
    companion.body = { ...companion.body, energy: 20, fatigue: 80, sleepDebt: 0, updatedAt: since.toISOString() }
    assert.equal(saveCompanionState(dir, companion), true)
    updateSleepLedger(dir, (ledger) => {
      const started = startSleepEpisode(ledger, {
        kind: 'night', baseNeedMinutes: 480, targetMinutes: 480,
        now, startedAt: since,
      })
      if (started.ok) finishSleepEpisode(ledger, started.episode.id, { now })
      ledger.presenceStarted = since.toISOString()
      return ledger
    }, { openingDebt: 0 })
    const person = loadPerson(dir, now)
    person.presence = { mode: 'sleep', until: '', since: since.toISOString(), reason: '睡了' }
    assert.equal(savePerson(dir, person), true)
    const tool = createCompanionTool(dir)
    assert.equal((await tool.execute({ action: 'presence.set', mode: 'auto' })).ok, true)
    const ledger = loadSleepLedger(dir)
    assert.equal(ledger.episodes.length, 1, 'the settled sleep must not be recorded twice')
    assert.equal(ledger.episodes[0].state, 'completed')
    assert.equal(loadPerson(dir, now).presence.mode, 'auto')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('switching presence persists the previous sleep into the body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const now = new Date()
    const since = new Date(now.getTime() - 8 * 3600 * 1000)
    const companion = emptyCompanionState(since)
    companion.lastUserAt = since.toISOString()
    companion.body = {
      ...companion.body,
      energy: 20, fatigue: 80, sleepDebt: 400, updatedAt: since.toISOString(),
    }
    assert.equal(saveCompanionState(dir, companion), true)
    const person = loadPerson(dir, now)
    person.presence = { mode: 'sleep', until: '', since: since.toISOString(), reason: '睡了' }
    assert.equal(savePerson(dir, person), true)

    const tool = createCompanionTool(dir)
    const result = await tool.execute({ action: 'presence.set', mode: 'auto', reason: '醒了' })
    assert.equal(result.ok, true, result.reject)
    const after = loadCompanionState(dir, now)
    assert.ok(after.body.fatigue < 80, `fatigue should stay recovered, got ${after.body.fatigue}`)
    assert.ok(after.body.sleepDebt < 400, `sleep debt should stay repaid, got ${after.body.sleepDebt}`)
    assert.equal(loadPerson(dir, now).presence.mode, 'auto')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('presence derives sleep/nap/busy and delays only when it should', async () => {
  const late = new Date('2026-10-30T23:45:00')
  const sleep = effectivePresence({ presence: { mode: 'auto' } }, late, { lastUserAt: '2026-10-30T21:00:00' })
  assert.equal(sleep.mode, 'sleep')
  // 正在聊天时不能说她睡了
  assert.equal(effectivePresence({ presence: { mode: 'auto' } }, late, { lastUserAt: '2026-10-30T23:44:00' }).mode, 'normal')
  const noon = new Date('2026-10-30T13:10:00')
  assert.equal(effectivePresence({ presence: { mode: 'auto' } }, noon, { lastUserAt: '2026-10-30T11:00:00' }).mode, 'nap')
  // 上课和午休同时出现是自相矛盾；上课优先
  assert.equal(effectivePresence({ presence: { mode: 'auto' } }, noon, { lastUserAt: '2026-10-30T11:00:00', inClass: true }).mode, 'normal')
  const busy = effectivePresence({ presence: { mode: 'busy', until: '2026-10-30T14:00:00', reason: '在看书' } }, NOW)
  assert.equal(busy.mode, 'busy')
  assert.equal(busy.reason, '在看书')
  // 没有截止时间也要生效，直到 auto 清掉
  assert.equal(effectivePresence({ presence: { mode: 'busy', until: '' } }, NOW).mode, 'busy')
  assert.ok(presenceDelay(busy) >= 500)
  assert.equal(presenceDelay({ mode: 'normal' }), 0)
  assert.ok(presenceDelay(sleep) >= 700)
})

test('a fresh person does not claim day one', () => {
  const lines = personLines(emptyPerson(NOW), NOW)
  assert.ok(!lines.some(line => line.includes('第 1 天')))
})

test('pending accept applies a proposal and style accept activates a note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const person = emptyPerson(NOW)
    person.pending.push({ id: 'p1', kind: 'habit',
      fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' },
      evidence: [{ handle: 's1', quote: '他说不会', time: '', messageId: '', seq: 1 }],
      confidence: 0.8, createdAt: NOW.toISOString(), status: 'pending' })
    person.style.push({ id: 'st1', dimension: 'sentence_rhythm', observation: '短句',
      pattern: '先说反应再说内容', situation: '他累的时候', avoid: '他认真问问题时', proposal: '', confidence: 0.7,
      evidence: [{ handle: 's1', quote: '短句', time: '', messageId: '', seq: 1 }],
      createdAt: NOW.toISOString(), status: 'pending' })
    savePerson(dir, person)
    const tool = createCompanionTool(dir)
    assert.match((await tool.execute({ action: 'pending.list' })).summary, /p1/)
    // 采用是审阅动作，只有他本人在页面上能做。
    assert.equal((await tool.execute({ action: 'pending.accept', id: 'p1' })).ok, false)
    assert.equal((await tool.execute({ action: 'pending.accept', id: 'p1' }, { origin: 'human' })).ok, true)
    assert.match((await tool.execute({ action: 'read' })).summary, /习惯：1 条/)
    assert.equal((await tool.execute({ action: 'style.accept', id: 'st1' })).ok, false)
    assert.equal((await tool.execute({ action: 'style.accept', id: 'st1' }, { origin: 'human' })).ok, true)
    const lines = personLines(loadPerson(dir, NOW), NOW)
    assert.ok(lines.some(line => line.includes('先说反应')))
    assert.ok(lines.some(line => line.includes('他累的时候')))
    assert.ok(lines.some(line => line.includes('别用于他认真问问题时')))
    const short = personLines(loadPerson(dir, NOW), NOW, { includeDetails: false })
    assert.ok(short.some(line => line.includes('先说反应')), 'ordinary chat keeps the adopted speaking style')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an due promise is a fact, not an automatic reminder command', () => {
  const person = emptyPerson(NOW)
  person.promises.push({ id: 'pr1', text: '周末复盘这场比赛', dueAt: '2026-10-29', status: 'open',
    evidence: '周末复盘', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
  const lines = memoryLines(person, NOW)
  const dueLine = lines.find(line => line.includes('周末复盘'))
  assert.ok(dueLine, 'the due promise is still a fact')
  assert.doesNotMatch(dueLine, /主动提/)
})

test('a preference listed as both liked and disliked is surfaced as a conflict', () => {
  const person = emptyPerson(NOW)
  person.profile.likes = ['小鱼干', '甜食']
  person.profile.dislikes = ['小鱼干']
  const text = personLines(person, NOW, { includeDetails: false }).join('\n')
  assert.match(text, /冲突/)
  assert.match(text, /小鱼干/)
})

test('discard remembers the proposal and habit feedback is stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const person = emptyPerson(NOW)
    person.pending.push({ id: 'p1', kind: 'habit',
      fields: { situation: '他卡住时', action: '先问', boundary: '' },
      evidence: [{ handle: 's1', quote: '原话', time: '', messageId: '', seq: 1 }],
      confidence: 0.8, createdAt: NOW.toISOString(), status: 'pending' })
    savePerson(dir, person)
    const tool = verifiedTool(dir, ['原话', '这条习惯先别用了'])
    assert.equal((await tool.execute({ action: 'pending.discard', id: 'p1' })).ok, true)
    assert.equal(loadPerson(dir, NOW).rejected.length, 1)
    assert.match((await tool.execute({ action: 'read' })).summary, /已拒：1 条/)
    assert.equal((await tool.execute({ action: 'habit.add', situation: '他卡住时', habitAction: '先问', evidence: '原话' })).ok, true)
    const id = loadPerson(dir, NOW).habits[0].id
    assert.equal((await tool.execute({ action: 'habit.feedback', id, feedback: 'unwelcome', evidence: '这条习惯先别用了' })).ok, true)
    assert.equal(loadPerson(dir, NOW).habits[0].feedback, 'unwelcome')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('person lines carry profile, upcoming anniversary, habit and book', () => {
  const person = emptyPerson(NOW)
  person.profile.likes = ['热可可']
  person.profile.dislikes = ['被当客服']
  person.relation.milestones.push({ id: 'm1', label: '第一次说心里话', date: '2025-11-02', evidence: '原话', createdAt: NOW.toISOString() })
  person.habits.push({ id: 'h1', situation: '他卡住时', action: '先问想到哪一步', boundary: '', evidence: '原话', createdAt: NOW.toISOString() })
  person.library.push({ id: 'b1', title: '《海》', source: '', kind: 'book', state: 'reading', progress: 0.4, note: '潮汐', addedAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
  const lines = personLines(person, NOW)
  assert.ok(lines.some(line => line.includes('热可可')))
  assert.ok(lines.some(line => line.includes('还有 3 天')))
  assert.ok(lines.some(line => line.includes('他卡住时')))
  assert.ok(lines.some(line => line.includes('《海》')))
  assert.ok(lines.length <= 5)
})

test('shared experience and promise actions share the same evidence and bounds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const tool = verifiedTool(dir, ['他说记得问我', '那道题已经问过了', '还是要问，改到11月1号'])
    const episode = { action: 'episode.add', summary: '他第一次主动说想认真复盘，我们把昨天的比赛过了一遍。', at: '2026-10-30', tags: ['复盘'], evidence: '他说今天想认真复盘' }
    // 模型只能提候选；页面上由他采用后才进共同经历。
    assert.equal((await tool.execute(episode)).ok, true)
    assert.equal((await tool.execute(episode)).ok, true)
    assert.equal((await tool.execute(episode, { origin: 'human' })).ok, true)
    assert.equal((await tool.execute({ ...episode, at: '2099-01-01' })).ok, false)
    assert.equal((await tool.execute({ ...episode, summary: '太短' })).ok, false)

    const promise = { action: 'promise.add', promiseText: '明天问他那道题的进度', dueAt: '2026-10-31', evidence: '他说记得问我' }
    assert.equal((await tool.execute(promise)).ok, true)
    assert.equal((await tool.execute(promise)).ok, true)
    const read = await tool.execute({ action: 'read' })
    assert.match(read.summary, /共同经历：1 条/)
    assert.match(read.summary, /承诺：1 条未完成/)

    const loaded = loadPerson(dir, NOW)
    const promiseId = loaded.promises[0].id
    assert.equal((await tool.execute({ action: 'promise.done', id: promiseId, evidence: '那道题已经问过了' })).ok, true)
    assert.equal(loadPerson(dir, NOW).promises[0].status, 'done')
    assert.equal((await tool.execute({ action: 'promise.update', id: promiseId, promiseStatus: 'open', dueAt: '2026-11-01', evidence: '还是要问，改到11月1号' })).ok, true)
    assert.equal(loadPerson(dir, NOW).promises[0].dueAt, '2026-11-01')

    const lines = memoryLines(loadPerson(dir, NOW), NOW)
    assert.match(lines.join('\n'), /共同经历/)
    assert.match(lines.join('\n'), /答应过他/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('relationship stage derives from milestones and shared experiences', () => {
  const person = emptyPerson(NOW)
  assert.equal(relationStage(person), 'stranger')
  person.episodes.push({ id: 'e1', summary: '第一次一起复盘', at: '2026-10-20' })
  assert.equal(relationStage(person), 'familiar')
  person.relation.milestones.push({ id: 'm1', label: '第一次约定', date: '2026-10-01' })
  person.relation.milestones.push({ id: 'm2', label: '第二次约定', date: '2026-10-02' })
  person.relation.milestones.push({ id: 'm3', label: '第三次约定', date: '2026-10-03' })
  assert.equal(relationStage(person), 'close')
})

test('boundaries and pinned facts are bounded and require evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-'))
  try {
    const unverified = createCompanionTool(dir)
    assert.equal((await unverified.execute({ action: 'boundary.add', boundaryText: '不要叫我宝贝', evidence: '别叫我宝贝' })).ok, false,
      'a nonempty quote cannot substitute for a host verifier')
    const tool = verifiedTool(dir, ['别叫我宝贝', '我在准备区域赛', '取消这条称呼边界', '这句不用置顶了'])
    assert.equal((await tool.execute({ action: 'boundary.add', boundaryText: '不要叫我宝贝', evidence: '会话里不存在的证据' })).ok, false)
    assert.equal((await tool.execute({ action: 'boundary.add', boundaryText: '不要叫我宝贝', evidence: '别叫我宝贝' })).ok, true)
    assert.equal((await tool.execute({ action: 'boundary.add', boundaryText: '不要叫我宝贝', evidence: '别叫我宝贝' })).ok, true)
    assert.equal((await tool.execute({ action: 'boundary.add', boundaryText: '不要催睡' })).ok, false)
    assert.equal((await tool.execute({ action: 'pin.add', pinText: '我在准备区域赛', evidence: '我在准备区域赛' })).ok, true)
    assert.equal((await tool.execute({ action: 'pin.add', pinText: '我在准备区域赛', evidence: '我在准备区域赛' })).ok, true)
    const read = await tool.execute({ action: 'read' })
    assert.match(read.summary, /边界：1 条/)
    assert.match(read.summary, /置顶：1 条/)
    const loaded = loadPerson(dir, NOW)
    assert.equal((await tool.execute({ action: 'boundary.remove', id: loaded.boundaries[0].id, evidence: '取消这条称呼边界' })).ok, true)
    assert.equal((await tool.execute({ action: 'pin.remove', id: loaded.pinned[0].id, evidence: '这句不用置顶了' })).ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pending candidates are surfaced once, not nagged every turn', () => {
  const person = emptyPerson(NOW)
  person.pending.push({ id: 'p1', kind: 'habit',
    fields: { situation: '他卡住时', action: '先问想到哪一步', boundary: '' },
    evidence: [{ handle: 's1', quote: '原话', time: '', messageId: '', seq: 1 }],
    confidence: 0.8, createdAt: NOW.toISOString(), status: 'pending' })
  const line = personLines(person, NOW).find(item => item.includes('待审候选'))
  assert.ok(line, 'the prompt tells her candidates exist')
  assert.match(line, /人格档案/)
  assert.match(line, /别每轮催/)
  assert.doesNotMatch(line, /他问起时再看，不主动念/)
})

test('question-like quotes never direct-write the role profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-person-question-'))
  try {
    const quotes = ['你叫外卖的时候，喜欢顺便买杯奶茶吗？', '你怕什么', '你平时喜欢什么', '你喜欢什么样的电影']
    const tool = createCompanionTool(dir, {
      verifyEvidence: async quote => quotes.includes(quote)
        ? { ok: true, studentEvidence: { quote, messageId: 'm-question', seq: 1 } }
        : { ok: false, reject: 'no quote' },
    })
    const cases = [
      ['likes', '奶茶', quotes[0]],
      ['quirks', '怕黑', quotes[1]],
      ['likes', '逛街', quotes[2]],
      ['dislikes', '苦情片', quotes[3]],
    ]
    for (const [field, value, quote] of cases) {
      const result = await tool.execute({ action: 'profile.set', [field]: [value], evidence: quote })
      assert.equal(result.ok, true, result.reject)
      assert.match(result.summary, /待审/, `${quote} 只是在问/打听，必须只提候选`)
      assert.equal(loadPerson(dir).profile[field].includes(value), false, `${quote} 不能直写进角色档案`)
    }
    assert.equal(loadPerson(dir).pending.filter(item => item.kind === 'profile').length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

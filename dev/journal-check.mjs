import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  journalDueDay, journalAt, emptyJournalArchive, normalizeJournalArchive, loadJournalArchive,
  upsertJournalEntry, journalFor, recentJournals, setJournalEntryState, buildMaterials,
  parseJournalOutput, parseDreamOutput, writeJournalEntry, writeDreamEntry, settleJournalArchive,
  journalEntryText,
} from '../lib/journal.js'
import {
  readingSource, sourceIsCurrent, writeReadingReflection, readingReceipt,
} from '../lib/reading.js'
import { settleActivities, settleReadingReceipts } from '../lib/activity-runtime.js'
import { loadActivityLedger, updateActivityLedger, planActivity, startActivity, finishActivity } from '../lib/activity-ledger.js'

const at = (value) => new Date(value)
const at2500 = at('2026-11-02T23:55:00')
const at0010 = at('2026-11-03T00:10:00')

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'journal-check-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const fakeLlm = (text) => ({
  stream: () => (async function* () {
    yield { type: 'text-delta', text }
  })(),
})

const night = {
  id: 'night-1', kind: 'night', state: 'completed',
  startedAt: '2026-11-01T23:30:00', endedAt: '2026-11-02T07:10:00',
  updatedAt: '2026-11-02T07:10:00', sleptSeconds: 460 * 60, interruptions: 1,
  qualityMin: 70, qualityMax: 90,
}

test('the daily journal is due at 23:50 and catches up only within 12h', () => {
  assert.equal(journalDueDay(at2500), '2026-11-02')
  assert.equal(journalDueDay(at0010), '2026-11-02')
  assert.equal(journalDueDay(at('2026-11-02T12:00:00')), '')
  assert.equal(journalDueDay(at('2026-11-02T13:00:00')), '')
  assert.equal(journalDueDay(at('2026-11-02T23:50:00')), '2026-11-02')
  assert.deepEqual(journalAt({}), { hour: 23, minute: 50 })
  assert.deepEqual(journalAt({ journalAt: '7:05' }), { hour: 7, minute: 5 })
  assert.deepEqual(journalAt({ journalAt: 'nope' }), { hour: 23, minute: 50 })
})

test('the archive keeps every revision and supports delete and restore', () => {
  const t = tmp()
  try {
    const first = upsertJournalEntry(t.dir, {
      day: '2026-11-02', kind: 'journal', body: '今天看了一点点书，脑子里还在转那道题。',
      source: 'model', now: at2500,
    })
    assert.equal(first.ok, true)
    assert.equal(first.entry.revision, 1)
    const second = upsertJournalEntry(t.dir, {
      day: '2026-11-02', kind: 'journal', body: '改了一遍，今天其实更困。', source: 'model', now: at2500,
    })
    assert.equal(second.entry.revision, 2)
    assert.equal(second.entry.body, '改了一遍，今天其实更困。')
    assert.equal(normalizeJournalArchive(emptyJournalArchive()).entries.length, 0)
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02' }).revision, 2)

    assert.equal(setJournalEntryState(t.dir, { day: '2026-11-02', state: 'deleted', now: at2500 }), true)
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02' }), null)
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02', includeDeleted: true }).state, 'deleted')
    assert.equal(setJournalEntryState(t.dir, { day: '2026-11-02', state: 'final', now: at2500 }), true)
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02' }).body, '改了一遍，今天其实更困。')
  } finally { t.done() }
})

test('the archive ignores unusable entries and caps recent journals by day', () => {
  assert.equal(upsertJournalEntry('/tmp/no-such-dir-x', { day: '2026-11-02', body: '' }).ok, false)
  const archive = normalizeJournalArchive({
    version: 1, entries: [
      { day: '2026-11-01', kind: 'journal', body: '昨天。' },
      { day: '2026-11-02', kind: 'journal', body: '今天。' },
      { day: '2026-11-02', kind: 'dream', body: '一个梦。' },
      { day: 'bad', kind: 'journal', body: 'x' },
    ],
  })
  assert.equal(archive.entries.length, 3)
  assert.deepEqual(recentJournals(archive, { days: 3, now: at2500 }).map((entry) => entry.day), ['2026-11-01', '2026-11-02'])
  assert.equal(journalEntryText(archive.entries[1]).includes('今天。'), true)
})

test('materials carry real events, not invented ones', () => {
  const materials = buildMaterials({
    now: at2500,
    person: { library: [{ id: 'b1', title: '具体数学', state: 'reading', progress: 0.4, note: '第二章讲和式' }] },
    activities: [
      { kind: 'reading', state: 'completed', title: '《具体数学》', minutes: 25, createdAt: '2026-11-02T10:00:00' },
      { kind: 'reading', state: 'completed', title: '《旧书》', minutes: 25, createdAt: '2026-11-01T10:00:00' },
    ],
    sleepLedger: { episodes: [night] },
    roleState: { mood: '平静', location: '自己房间' },
    messages: [{ text: '今天好困' }],
  })
  const text = materials.map((item) => item.text).join('|')
  assert.match(text, /25 分钟/)
  assert.doesNotMatch(text, /旧书/, 'yesterday’s activity is not today’s material')
  assert.match(text, /夜里睡了/)
  assert.match(text, /在读《具体数学》/)
  assert.match(text, /他说：今天好困/)
})

test('journal materials keep source dates and unfinished states', () => {
  const now = at('2026-11-06T23:55:00')
  const yesterday = new Date(2026, 10, 5, 15).toISOString()
  const materials = buildMaterials({
    now,
    activities: [
      { kind: 'reading', title: '《计划中的书》', state: 'planned', createdAt: now.toISOString(), minutes: 0 },
      { kind: 'practice', title: '《昨天做过的题》', state: 'completed', createdAt: yesterday, minutes: 30 },
    ],
    messages: [
      { at: yesterday, text: '昨天说的比赛结果' },
      { text: '没有时间戳的话' },
    ],
  })
  const planned = materials.find(item => item.text.includes('计划中的书'))
  assert.match(planned.text, /计划|还没做/)
  assert.equal(materials.some(item => item.text.includes('昨天做过的题')), false, 'older activities stay out of today')
  const old = materials.find(item => item.text.includes('昨天说的比赛结果'))
  assert.equal(old.date, '2026-11-05', 'a message keeps its source day')
  const unknown = materials.find(item => item.text.includes('没有时间戳的话'))
  assert.equal(unknown.date, '', 'an unknown date stays unknown instead of being stamped today')
  // 本地 11/6 01:00 的 ISO 是 11/5 17:00Z；按本地日期比较，同一天的活动不能被丢掉。
  const kept = buildMaterials({ now: at('2026-11-06T02:00:00'),
    activities: [{ kind: 'practice', title: '《凌晨完成》', state: 'completed', createdAt: new Date(2026, 10, 6, 1).toISOString(), minutes: 20 }] })
  assert.ok(kept.some(item => item.text.includes('凌晨完成')), 'a local-day activity is not dropped because its UTC date is yesterday')
})

test('the journal request carries dates and planned state to the model', async () => {
  const captured = []
  const llm = { async *stream(request) { captured.push(request); yield { type: 'text-delta', text: '{"body":"这是一份只用于捕获输入提示的离线日记占位内容。","recall":"","afterglow":""}' } } }
  const now = at('2026-11-06T23:55:00')
  const yesterday = new Date(2026, 10, 5, 15).toISOString()
  const materials = buildMaterials({
    now,
    activities: [{ kind: 'reading', title: '《计划中的书》', state: 'planned', createdAt: now.toISOString(), minutes: 0 }],
    messages: [{ at: yesterday, text: '昨天说的比赛结果' }],
  })
  await writeJournalEntry({ llm, route: { provider: 'p', model: 'm' }, materials, now })
  const request = JSON.stringify(captured[0])
  assert.match(request, /2026-11-05/, 'the source day survives into the request')
  assert.match(request, /计划/)
  assert.match(request, /回忆/)
})

test('journal and dream both use recorded sleep, not the bedtime span', async () => {
  const now = at('2026-11-06T23:55:00')
  const span = {
    id: 'night-span', kind: 'night', state: 'completed',
    startedAt: new Date(2026, 10, 5, 23).toISOString(),
    endedAt: new Date(2026, 10, 6, 7).toISOString(),
    updatedAt: new Date(2026, 10, 6, 7).toISOString(),
    sleptSeconds: 4 * 3600, interruptions: 1, qualityMin: 70, qualityMax: 90,
  }
  const materials = buildMaterials({ now, sleepLedger: { episodes: [span] } })
  const sleep = materials.find(item => item.kind === 'sleep')
  assert.match(sleep.text, /4 小时 0 分/, 'the journal uses the recorded sleep, not the 8-hour span')
  const captured = []
  const llm = { async *stream(request) { captured.push(request); yield { type: 'text-delta', text: '{"body":"梦里一直有一块没有写完的黑板，粉笔灰落在窗台上。","fragments":["黑板"]}' } } }
  await writeDreamEntry({ llm, route: { provider: 'p', model: 'm' }, night: span, materials: [], now })
  assert.match(JSON.stringify(captured[0]).replaceAll('\\"', '"'), /"sleptMinutes":\s*240/, 'the dream receipt uses the recorded sleep too')
})

test('a title-only reading never asks the model to fake a takeaway', async () => {
  const t = tmp()
  try {
    updateActivityLedger(t.dir, (ledger) => {
      const planned = planActivity(ledger, { kind: 'reading', title: '《只有书名》', plannedMinutes: 25,
        source: { bookId: 'b1', title: '《只有书名》', kind: 'title', text: '', hash: 'fixture-hash' },
        now: at('2026-11-02T12:00:00') })
      assert.equal(startActivity(ledger, planned.activity.id, { now: at('2026-11-02T12:00:00') }).ok, true)
      assert.equal(finishActivity(ledger, planned.activity.id, { now: at('2026-11-02T12:25:00') }).ok, true)
      return ledger
    })
    let calls = 0
    const llm = { async *stream() { calls += 1; yield { type: 'text-delta', text: '{"reflection":"空材料也能编出的读后感内容"}' } } }
    const settled = await settleReadingReceipts(t.dir, {
      now: at('2026-11-02T12:30:00'), person: { library: [{ id: 'b1', title: '《只有书名》', state: 'reading' }] },
      llm, route: { provider: 'p', model: 'm' }, canContinue: () => true,
    })
    assert.equal(settled, 0)
    assert.equal(calls, 0, 'a bare title cannot be turned into a reading reflection')
    assert.ok(!loadActivityLedger(t.dir).activities[0].receipt, 'no fake receipt is attached')
    const reflection = await writeReadingReflection({ llm, route: { provider: 'p', model: 'm' },
      source: readingSource({ library: [{ id: 'b1', title: '《只有书名》', state: 'reading' }] }), minutes: 25 })
    assert.equal(reflection, null, 'the generator itself also refuses a title-only source')
  } finally { t.done() }
})

test('journal and dream output must be real text, not a placeholder', () => {
  const journal = parseJournalOutput('{"body":"今天在窗边坐了很久，脑子里还是那道没做出来的题。","form":"narration","recall":"他说的那句再想想","afterglow":"有点不甘心"}')
  assert.equal(journal.form, 'narration')
  assert.equal(journal.afterglow, '有点不甘心')
  assert.equal(parseJournalOutput('{"body":""}'), null)
  assert.equal(parseJournalOutput('{"body":"嗯"}'), null)
  assert.equal(parseJournalOutput('no json'), null)
  assert.equal(parseDreamOutput('{"body":"","fragments":[]}'), null)
  assert.deepEqual(parseDreamOutput('{"body":"灯一直亮着，黑板上的字往下掉。","fragments":["灯","黑板"]}').fragments, ['灯', '黑板'])
})

test('the model-written journal is archived with provenance', async () => {
  const t = tmp()
  try {
    const entry = await writeJournalEntry({
      llm: fakeLlm('{"body":"今天把那道题又看了一遍，还是卡在第二步。窗外很安静。","recall":"他说再想想","afterglow":"明天再试"}'),
      route: { provider: 'p', model: 'm' },
      materials: buildMaterials({ now: at2500, messages: [{ text: '再想想' }] }),
      now: at2500,
    })
    assert.equal(entry.source, 'model')
    assert.equal(entry.materialIds.length, 1)
    assert.equal((await writeJournalEntry({ llm: null, materials: [{ id: 'm1', text: 'x' }], now: at2500 })), null)
    assert.equal(await writeDreamEntry({ llm: fakeLlm('{"body":"x"}'), night, materials: [], now: at2500 }), null)
  } finally { t.done() }
})

test('settleJournalArchive writes both the daily journal and the night dream', async () => {
  const t = tmp()
  try {
    const wrote = await settleJournalArchive(t.dir, {
      now: at2500, route: { provider: 'p', model: 'm' },
      llm: fakeLlm('{"body":"夜里醒过一次，早上起来还是有点沉。今天没做什么大事。","recall":"醒来时天还没亮","afterglow":"想再睡一会儿"}'),
      person: { library: [] },
      sleepLedger: { episodes: [night] },
      messages: [{ text: '晚安' }],
    })
    assert.ok(wrote.journal)
    assert.ok(wrote.dream)
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02', kind: 'journal' }).source, 'model')
    assert.equal(journalFor(loadJournalArchive(t.dir), { day: '2026-11-02', kind: 'dream' }).nightId, 'night-1')

    const again = await settleJournalArchive(t.dir, {
      now: at2500, route: { provider: 'p', model: 'm' }, llm: fakeLlm('{"body":"不该再写一遍的日记内容。"}'),
      sleepLedger: { episodes: [night] },
    })
    assert.equal(again.journal, null, 'same day is never rewritten')
    assert.equal(again.dream, null)
  } finally { t.done() }
})

test('a reading source uses the excerpt, then the note, then a bare title', () => {
  const excerpt = readingSource({ library: [{ id: 'b', title: '书', state: 'reading', excerpt: '第一章。\n第二章。', note: '摘记' }] })
  assert.equal(excerpt.kind, 'excerpt')
  assert.equal(excerpt.hash.length, 32)
  assert.equal(readingSource({ library: [{ id: 'b', title: '书', state: 'reading', note: '摘记' }] }).kind, 'note')
  assert.equal(readingSource({ library: [{ id: 'b', title: '书', state: 'reading' }] }).kind, 'title')
  assert.equal(readingSource({ library: [] }), null)
  const changed = readingSource({ library: [{ id: 'b', title: '书', state: 'reading', excerpt: '改过的正文' }] })
  assert.equal(sourceIsCurrent({ hash: excerpt.hash }, changed), false)
})

test('a reading receipt records the source hash and the takeaway', () => {
  const source = readingSource({ library: [{ id: 'b', title: '书', state: 'reading', excerpt: '正文' }] })
  const receipt = readingReceipt({ id: 'r1', minutes: 25, source: { hash: source.hash } }, source, '这段讲得很清楚。', { now: at2500 })
  assert.equal(receipt.contentHash, source.hash)
  assert.equal(receipt.sourceChanged, false)
  assert.equal(receipt.minutes, 25)
  const stale = readingReceipt({ id: 'r2', minutes: 10, source: { hash: 'other' } }, source, '嗯', { now: at2500 })
  assert.equal(stale.sourceChanged, true)
})

test('reading reflection comes only from the model', async () => {
  const source = readingSource({ library: [{ id: 'b', title: '书', state: 'reading', excerpt: '正文' }] })
  const reflection = await writeReadingReflection({
    llm: fakeLlm('{"reflection":"这一章把求和换序讲得很直白。"}'),
    route: { provider: 'p', model: 'm' }, source, minutes: 25, now: at2500,
  })
  assert.equal(reflection, '这一章把求和换序讲得很直白。')
  assert.equal(await writeReadingReflection({ llm: fakeLlm('{"reflection":"短"}'), route: { provider: 'p', model: 'm' }, source, now: at2500 }), null)
  assert.equal(await writeReadingReflection({ llm: null, source, now: at2500 }), null)
})

test('settleActivities plans reading with its source and only uses archived journal text', () => {
  const t = tmp()
  try {
    const person = { library: [{ id: 'b', title: '具体数学', state: 'reading', excerpt: '正文' }] }
    settleActivities(t.dir, { now: at2500, presence: { mode: 'normal' }, person })
    const ledger = loadActivityLedger(t.dir)
    const reading = ledger.activities.find((activity) => activity.kind === 'reading')
    assert.equal(reading.source.kind, 'excerpt')
    assert.equal(ledger.activities.some((activity) => activity.kind === 'journal'), false, 'no archive entry, no journal activity')

    settleActivities(t.dir, {
      now: at2500, presence: { mode: 'normal' }, person,
      journal: { day: '2026-11-02', text: '今天的日记。' },
      dream: { id: 'dream-night-1', day: '2026-11-02', text: '一个梦。', nightId: 'night-1' },
    })
    const next = loadActivityLedger(t.dir)
    assert.equal(next.activities.find((activity) => activity.kind === 'journal').receipt.kind, 'journal')
    assert.equal(next.activities.find((activity) => activity.kind === 'dream').receipt.nightId, 'night-1')
  } finally { t.done() }
})

test('settleReadingReceipts attaches one takeaway per completed reading', async () => {
  const t = tmp()
  try {
    const person = { library: [{ id: 'b', title: '具体数学', state: 'reading', excerpt: '正文' }] }
    // The background tick heartbeats every minute; 5-minute steps stay inside
    // the 10-minute stale window while covering the planned 25 minutes.
    for (let minute = 0; minute <= 30; minute += 5) {
      const clock = new Date(Date.parse('2026-11-02T09:00:00') + minute * 60000)
      settleActivities(t.dir, { now: clock, presence: { mode: 'normal' }, person })
    }
    const completed = loadActivityLedger(t.dir).activities.find((activity) => activity.kind === 'reading' && activity.state === 'completed')
    assert.ok(completed, 'reading finished after the planned minutes')

    const count = await settleReadingReceipts(t.dir, {
      now: at('2026-11-02T10:05:00'), person,
      llm: fakeLlm('{"reflection":"今天读的那一节讲得挺清楚。"}'), route: { provider: 'p', model: 'm' },
    })
    assert.equal(count, 1)
    const receipt = loadActivityLedger(t.dir).activities.find((activity) => activity.id === completed.id).receipt
    assert.equal(receipt.title, '具体数学')
    assert.equal(receipt.reflection, '今天读的那一节讲得挺清楚。')
    assert.equal(await settleReadingReceipts(t.dir, { now: at('2026-11-02T10:06:00'), person, llm: fakeLlm('{"reflection":"不该再写一条。"}'), route: { provider: 'p', model: 'm' } }), 0)
  } finally { t.done() }
})

test('reading takeaway uses the completed activity snapshot after switching books', async () => {
  const t = tmp()
  try {
    const start = at('2026-11-02T10:00:00')
    const source = readingSource({ library: [{ id: 'a', title: '书A', state: 'reading', excerpt: 'A的真实材料' }] })
    updateActivityLedger(t.dir, ledger => {
      const p = planActivity(ledger, { kind: 'reading', title: '书A', source, now: start })
      startActivity(ledger, p.activity.id, { now: start })
      finishActivity(ledger, p.activity.id, { now: at('2026-11-02T10:05:00') })
      return ledger
    })
    const requests = []
    const llm = { async *stream(request) { requests.push(request); yield { type: 'text-delta', text: '{"reflection":"这段A材料让我想到慢慢拆开眼前的问题。"}' } } }
    const person = { library: [{ id: 'b', title: '书B', state: 'reading', excerpt: 'B的不同材料' }] }
    assert.equal(await settleReadingReceipts(t.dir, { now: at('2026-11-02T10:06:00'), person, llm, route: { provider: 'p', model: 'm' } }), 1)
    assert.match(JSON.stringify(requests), /A的真实材料/)
    assert.doesNotMatch(JSON.stringify(requests), /B的不同材料/)
    const receipt = loadActivityLedger(t.dir).activities[0].receipt
    assert.equal(receipt.bookId, 'a')
    assert.equal(receipt.sourceChanged, true)
    updateActivityLedger(t.dir, ledger => { ledger.activities[0].source = null; ledger.activities[0].receipt = null; return ledger })
    assert.equal(await settleReadingReceipts(t.dir, { now: at('2026-11-02T10:06:00'), person, llm, route: { provider: 'p', model: 'm' } }), 0)
    assert.equal(requests.length, 1, 'missing historical source must not borrow the current book')
  } finally { t.done() }
})

test('losing a worker lease during journal generation stops dream calls and archive writes', async () => {
  const t = tmp()
  let owned = true, calls = 0
  try {
    const llm = { async *stream() { calls++; owned = false; yield { type: 'text-delta', text: '{"body":"这是一段有效的日记正文，记录了今天想起的事。"}' } } }
    await settleJournalArchive(t.dir, { now: at2500, llm, route: { provider: 'p', model: 'm' },
      sleepLedger: { episodes: [night] }, canContinue: () => owned })
    assert.equal(calls, 1)
    assert.equal(loadJournalArchive(t.dir).entries.length, 0)
  } finally { t.done() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { emptyPerson, savePerson } from '../lib/person.js'

test('skilltree recognizes proven and exposes keyboard-focusable nodes', () => {
  const html = readFileSync(new URL('../assets/knowledge/skilltree.html', import.meta.url), 'utf8')
  assert.match(html, /proven: "已证明"/)
  assert.match(html, /tabindex: "0", role: "button"/)
  assert.match(html, /addEventListener\("keydown"/)
  const source = html.slice(html.indexOf('const statusOf'), html.indexOf('// ── 重点'))
  const sandbox = { progress: { nodes: {
    A: { status: 'learned', proven: true },
    B: { status: 'verified', proven: true },
    C: { status: 'studying' },
  } } }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\nresult = [statusOf("A"), statusOf("B"), statusOf("C")]`, sandbox)
  assert.deepEqual(Array.from(sandbox.result), ['proven', 'verified', 'studying'])
})

test('diagnosis history escapes model text before it reaches innerHTML', () => {
  const html = readFileSync(new URL('../assets/knowledge/skilltree.html', import.meta.url), 'utf8')
  const escSource = html.slice(html.indexOf('const esc ='), html.indexOf('function mdInline'))
  const histSource = html.slice(html.indexOf('function histSection'), html.indexOf('function daysSince'))
  const sandbox = { progress: { nodes: { A: { diagnoses: [{
    category: '<b>不会</b>', date: '<i>2026-01-01</i>', summary: '<img src=x onerror=alert(1)>',
  }] } } } }
  vm.createContext(sandbox)
  vm.runInContext(`${escSource}\n${histSource}`, sandbox)
  const out = sandbox.histSection({ id: 'A' })
  assert.doesNotMatch(out, /<img|<b>|<i>/)
  assert.match(out, /&lt;img/)
  assert.match(out, /&lt;b&gt;/)
})

test('person page separates expired or undated context from current state and dates the last reflection', () => {
  const html = readFileSync(new URL('../assets/knowledge/person.html', import.meta.url), 'utf8')
  const source = html.slice(html.indexOf('function renderStatus()'), html.indexOf('function toLocalInput('))
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '当前处境' })
    return nodes.get(id)
  }
  let clock = new Date(2026, 10, 5, 18).getTime()
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  const DATA = { presence: { mode: 'auto' }, body: { energy: 50, fatigue: 10, sleepDebt: 0 },
    context: { quote: '临时处境夹具', at: new Date(2026, 9, 31, 15, 55).toISOString(),
      expiresAt: new Date(2026, 10, 1).toISOString(), status: 'expired' },
    reflection: { day: '2026-11-03', lastAt: new Date(2026, 10, 3, 8, 55).toISOString(), lastSummary: '上次整理的摘要', reflectCallsToday: 2 } }
  const sandbox = { DATA, Date: Clock, $: node, document: { querySelectorAll: () => [] },
    esc: value => String(value), pct: () => 0, toLocalInput: () => '',
    presenceTouched: false, proactiveTouched: false, PRESENCE_LABEL: { normal: '在线' } }
  vm.createContext(sandbox)
  vm.runInContext(source + '\nrenderStatus()', sandbox)
  assert.equal(node('#contextTitle').textContent, '历史处境')
  assert.match(node('#contextBody').innerHTML, /仅作历史/)
  assert.doesNotMatch(node('#contextBody').innerHTML, /生效中/)
  assert.match(node('#reflectionBody').innerHTML, /上次反思/)
  assert.match(node('#reflectionBody').innerHTML, /今天反思 0 次/)

  DATA.context = { quote: '无日期夹具', at: '', expiresAt: '', status: 'unknown' }
  vm.runInContext('renderStatus()', sandbox)
  assert.match(node('#contextBody').innerHTML, /时间不明/)
  assert.doesNotMatch(node('#contextBody').innerHTML, /生效中/)

  DATA.context = { quote: '当天夹具', at: new Date(2026, 10, 5, 18).toISOString(),
    expiresAt: new Date(2026, 10, 6).toISOString(), status: 'active' }
  vm.runInContext('renderStatus()', sandbox)
  assert.equal(node('#contextTitle').textContent, '当前处境')
  assert.match(node('#contextBody').innerHTML, /生效中/)
  clock = new Date(2026, 10, 6).getTime()
  vm.runInContext('renderRecentState()', sandbox)
  assert.equal(node('#contextTitle').textContent, '历史处境', 'an open page must stop showing active after midnight')
  assert.doesNotMatch(node('#contextBody').innerHTML, /生效中/)
})

test('bundled first-run map uses the current coach UI shell', () => {
  const template = readFileSync(new URL('../coach/skilltree_template.html', import.meta.url), 'utf8')
  const bundled = readFileSync(new URL('../assets/knowledge/skilltree.html', import.meta.url), 'utf8')
  const shell = (html) => html.replace(/\bconst DATA = [^\r\n]+;/, 'const DATA = /*__DATA__*/null;').replace(/\r\n/g, '\n')
  assert.equal(shell(bundled), shell(template))
})

let imports = 0
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-pages-'))
  const old = Object.fromEntries(['COACH_DATA_DIR', 'COACH_DB'].map(key => [key, process.env[key]]))
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 3}\nnodes: []\n')
  writeFileSync(join(dir, 'PROGRESS.yaml'), 'version: 1\ncursor: custom-node\nnodes: {}\n')
  let handler
  const ctx = {
    tools: { register() {} }, on() {}, get() {},
    effect: cb => cb(),
    webServer: { register: route => { handler = route.handler; return () => {} } },
    inject: (services, cb) => { if (services.includes('webServer')) cb(ctx) },
  }
  const { apply } = await import(`../index.js?pages-check=${++imports}`)
  apply(ctx)
  assert.equal(typeof handler, 'function')
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const request = async (url, overrides = {}) => {
    const { json, ...rest } = overrides
    const res = { status: undefined, headers: {}, body: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.body = body },
    }
    const req = { url, method: 'GET', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' }, ...rest }
    if (json !== undefined) {
      req.method = 'POST'
      req.headers = { ...req.headers, 'content-type': 'application/json' }
      req[Symbol.asyncIterator] = async function* () { yield JSON.stringify(json) }
    }
    await handler(req, res)
    return res
  }
  return { dir, request }
}

test('skilltree route applies the current packaged UI without replacing the user graph or writing ledgers', async t => {
  const { dir, request } = await fixture(t)
  const data = { nodes: [{ id: 'custom-node', name: "用户自己的地图; $& $` $' \u2028 </script><script>bad()</script>", domain: '测试', x: 10, y: 10, w: 120, h: 44, pre: [], suc: [] }],
    edges: [], bands: [], size: [900, 600], domainColors: { 测试: ['#2b7fe0', '#4aa3f7'] } }
  const cached = `<!doctype html><title>old UI</title><script>const DATA = ${JSON.stringify(data)};\n</script>`
  writeFileSync(join(dir, 'skilltree.html'), cached)
  const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')])
  const before = snapshot()
  const res = await request('/coach/skilltree.html')
  assert.equal(res.status, 200)
  const html = String(res.body)
  const template = readFileSync(new URL('../coach/skilltree_template.html', import.meta.url), 'utf8')
  assert.ok(html.startsWith(template.split('/*__DATA__*/null')[0]), 'cached map must use the current UI template')
  assert.deepEqual(JSON.parse(html.match(/const DATA = ([^\r\n]+);[ \t]*\r?\n/)[1]), data)
  assert.ok(!html.includes('</script><script>bad()'), 'map labels cannot close the inline script')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(snapshot(), before)
})

test('skilltree marks integrated concepts on an older cached map without rewriting it', async t => {
  const { dir, request } = await fixture(t)
  writeFileSync(join(dir, 'MAP.yaml'), 'meta: {version: 3}\nnodes:\n  - {id: 离散化, name: 离散化, domain: 杂项, depends: []}\n')
  const data = { nodes: [{ id: '离散化', name: '离散化', domain: '杂项', x: 10, y: 10, w: 120, h: 44, pre: [], suc: [] }], edges: [], bands: [], size: [900, 600], domainColors: { 杂项: ['#2b7fe0', '#4aa3f7'] } }
  const cached = `<!doctype html><script>const DATA = ${JSON.stringify(data)};\n</script>`
  writeFileSync(join(dir, 'skilltree.html'), cached)
  const res = await request('/coach/skilltree.html')
  assert.equal(JSON.parse(String(res.body).match(/const DATA = ([^\r\n]+);[ \t]*\r?\n/)[1]).nodes[0].role, 'integrated')
  assert.equal(readFileSync(join(dir, 'skilltree.html'), 'utf8'), cached)
})

test('unknown or invalid cached skilltree formats are preserved without silent data substitution', async t => {
  const { dir, request } = await fixture(t)
  for (const cached of ['<html>custom external page</html>', '<script>const DATA = notJSON;\n</script>', '<script>const DATA = null;\n</script>',
    '<script>const DATA = {"nodes":[]};\n</script>', '<script>const DATA = {"nodes":[],"size":[0,600],"bands":[],"edges":[],"domainColors":{}};\n</script>',
    '<script>const DATA = {"nodes":[{"id":"A","name":"A","domain":"math","x":1,"y":1,"w":100,"h":40,"pre":[],"suc":[]}],"size":[900,600],"bands":[],"edges":[],"domainColors":{"math":["#112233","#445566"],"constructor":null}};\n</script>']) {
    writeFileSync(join(dir, 'skilltree.html'), cached)
    const res = await request('/coach/skilltree.html')
    assert.equal(res.status, 200)
    assert.ok(String(res.body) === cached, 'Unknown or incomplete map data must retain the original page')
  }
})

test('bundled fonts use an authenticated exact-path route without opening arbitrary asset files', async t => {
  const { request } = await fixture(t)
  for (const file of ['geist-latin-wght-normal.woff2', 'geist-mono-latin-400-normal.woff2']) {
    const res = await request('/coach/fonts/' + file)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'font/woff2')
    assert.ok(Buffer.isBuffer(res.body))
    assert.equal(res.body.subarray(0, 4).toString(), 'wOF2')
  }
  assert.equal((await request('/coach/fonts/unknown.woff2')).status, 404)
  assert.equal((await request('/coach/fonts/geist-latin-wght-normal.woff2', { socket: { remoteAddress: '203.0.113.7' } })).status, 403)
})

test('training-log endpoint returns a read-only joined view with a bounded range', async t => {
  const { dir, request } = await fixture(t)
  const before = readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')])
  const res = await request('/coach/api/training-log?days=7')
  assert.equal(res.status, 200)
  const body = JSON.parse(String(res.body))
  assert.equal(body.ok, true)
  assert.equal(body.days.length, 7)
  assert.equal(body.curriculum.exists, false)
  assert.equal(body.totals.actualMinutes, 0)
  assert.deepEqual(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')]), before)
})

test('regional contest endpoint serves the source index and real cohort counts without writing user data', async t => {
  const { dir, request } = await fixture(t)
  const before = readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')])
  const list = await request('/coach/api/contests')
  assert.equal(list.status, 200)
  assert.equal(JSON.parse(String(list.body)).summary.regionals, 45)
  const detail = await request('/coach/api/contests?year=2025&site=%E8%A5%BF%E5%AE%89')
  assert.equal(detail.status, 200)
  const item = JSON.parse(String(detail.body)).contests[0]
  assert.equal(item.site, '西安')
  assert.equal(item.scoreboard.teamsWith4, 94)
  assert.equal(item.scoreboard.problems.find(p => p.label === 'I').solvedBy5, 76)
  assert.equal((await request('/coach/api/contests?year=wrong')).status, 400)
  assert.deepEqual(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')]), before)
})

test('progress endpoint exposes existing pending work for the today card without changing the ledger', async t => {
  const { dir, request } = await fixture(t)
  const source = 'version: 1\ncursor: custom-node\nnodes: {}\npendingActions:\n  custom-node:\n    at: 2026-10-25\n    deliverable: 完成一道限时题\n    why: 本阶段缺独立限时证据\n    totalMinutes: 60\n'
  writeFileSync(join(dir, 'PROGRESS.yaml'), source)
  const res = await request('/coach/api/progress')
  assert.equal(res.status, 200)
  const body = JSON.parse(String(res.body))
  assert.equal(body.pendingActions['custom-node'].deliverable, '完成一道限时题')
  assert.equal(body.pendingActions['custom-node'].totalMinutes, 60)
  assert.equal(readFileSync(join(dir, 'PROGRESS.yaml'), 'utf8'), source)
})

test('schedule endpoint exposes the fixed lesson window to the timetable UI', async t => {
  const { dir, request } = await fixture(t)
  writeFileSync(join(dir, 'SCHEDULE.yaml'),
    'version: 1\nupdated: 2026-10-26\nclassWindow:\n  from: "19:00"\n  to: "19:30"\n  weekdays: [1, 2, 3, 4, 5, 6]\ndays: {}\n')
  const res = await request('/coach/api/schedule')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(String(res.body)).classWindow,
    { from: '19:00', to: '19:30', weekdays: [1, 2, 3, 4, 5, 6] })
})

test('person panel serves the packaged page and reads the profile projection without writing', async t => {
  const { dir, request } = await fixture(t)
  const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')])
  const before = snapshot()
  const page = await request('/coach/person.html')
  assert.equal(page.status, 200)
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.ok(String(page.body).includes('人格档案'))
  assert.ok(String(page.body).includes('./person.html'))
  assert.ok(String(page.body).includes('共同经历'))
  assert.ok(String(page.body).includes('答应过的事'))
  const read = await request('/coach/api/person')
  assert.equal(read.status, 200)
  const body = JSON.parse(String(read.body))
  assert.equal(body.ok, true)
  assert.match(body.profile.identity, /小鲸/)
  assert.ok(Array.isArray(body.habits))
  assert.ok(Array.isArray(body.episodes))
  assert.ok(Array.isArray(body.promises))
  assert.ok(Array.isArray(body.boundaries))
  assert.ok(Array.isArray(body.pinned))
  assert.ok(body.life?.description)
  assert.equal(body.proactive?.enabled, false)
  assert.ok(Number.isFinite(body.body.energy))
  assert.equal(body.pending.length, 0)
  assert.deepEqual(snapshot(), before)
  assert.equal((await request('/coach/api/person', { socket: { remoteAddress: '203.0.113.7' } })).status, 403)
  assert.equal((await request('/coach/person.html', { socket: { remoteAddress: '203.0.113.7' } })).status, 403)
})

test('person API marks legacy context as history without rewriting its saved claim', async t => {
  const { dir, request } = await fixture(t)
  const person = emptyPerson()
  const recorded = new Date()
  recorded.setDate(recorded.getDate() - 5)
  const oldDeadline = new Date(recorded.getTime() + 7 * 86400000)
  person.context = { quote: '五天前的临时处境夹具', at: recorded.toISOString(), messageId: 'fixture-context', expiresAt: oldDeadline.toISOString() }
  assert.equal(savePerson(dir, person), true)
  const before = ['person.json', 'person-events.jsonl'].map(file => readFileSync(join(dir, file), 'utf8'))
  const data = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(data.context.quote, person.context.quote, 'the page retains the old quote for inspection')
  assert.equal(data.context.status, 'expired')
  assert.ok(Date.parse(data.context.expiresAt) < Date.now())
  assert.deepEqual(['person.json', 'person-events.jsonl'].map(file => readFileSync(join(dir, file), 'utf8')), before)
})

test('person API edits flow through the companion tool and are visible on the next read', async t => {
  const { dir, request } = await fixture(t)
  const post = async (json) => {
    const res = await request('/coach/api/person', { json })
    return { status: res.status, body: JSON.parse(String(res.body)) }
  }
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  const profile = await post({ action: 'profile.set', likes: ['手冲咖啡'], dislikes: [], quirks: [], background: [] })
  assert.equal(profile.status, 200)
  assert.equal(profile.body.ok, true)
  assert.ok(readFileSync(join(dir, 'person-events.jsonl'), 'utf8').includes('手冲咖啡'))

  const added = await post({ action: 'relation.add', label: '第一次复盘', date: yesterday, evidence: '他说今天想认真复盘' })
  assert.equal(added.status, 200)
  let read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.deepEqual(read.profile.likes, ['手冲咖啡'])
  assert.equal(read.relation.milestones.length, 1)
  const milestoneId = read.relation.milestones[0].id

  const updated = await post({ action: 'relation.update', id: milestoneId, label: '第一次一起复盘' })
  assert.equal(updated.status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.relation.milestones[0].label, '第一次一起复盘')

  const habit = await post({ action: 'habit.add', situation: '他半天没回', habitAction: '先问是不是卡住', boundary: '别连问三次', evidence: '他说今天怎么不催我' })
  assert.equal(habit.status, 200)
  const library = await post({ action: 'library.add', title: '算法导论', source: '书架', kind: 'book', note: '在第三章' })
  assert.equal(library.status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.habits.length, 1)
  assert.equal(read.library.length, 1)

  const removed = await post({ action: 'relation.remove', id: read.relation.milestones[0].id })
  assert.equal(removed.status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.relation.milestones.length, 0)

  assert.equal((await post({ action: 'read' })).status, 400)
  assert.equal((await post({ action: 'library.remove', id: read.library[0].id })).status, 200)
  assert.equal((await post({ action: 'nope' })).status, 400)
  const renamed = await post({ action: 'profile.set', identity: '小鲸，蓝色的鲸鱼娘' })
  assert.equal(renamed.status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.profile.identity, '小鲸，蓝色的鲸鱼娘')
})

test('person panel accepts reflection candidates and style notes through the same ledger', async t => {
  const { dir, request } = await fixture(t)
  writeFileSync(join(dir, 'person.json'), JSON.stringify({
    version: 1,
    revision: 0,
    pending: [{
      id: 'p-test', kind: 'habit',
      fields: { situation: '他说不会', action: '先问卡在哪，不直接讲' },
      evidence: [{ handle: 's1', quote: '这题我真不会' }],
      confidence: 0.82, createdAt: '2026-10-29T10:00:00.000Z', status: 'pending',
    }, {
      id: 'p-episode', kind: 'episode',
      fields: { summary: '他第一次主动说想认真复盘，我们把比赛过了一遍。', tags: ['复盘'] },
      evidence: [{ handle: 's1', quote: '他说今天想认真复盘', time: '2026-10-29T10:00:00.000Z' }],
      confidence: 0.8, createdAt: '2026-10-29T10:00:00.000Z', status: 'pending',
    }, {
      id: 'p-promise', kind: 'promise',
      fields: { text: '明天问他那道题的进度', dueAt: '2026-10-31' },
      evidence: [{ handle: 's1', quote: '他说记得问我' }],
      confidence: 0.8, createdAt: '2026-10-29T10:00:00.000Z', status: 'pending',
    }],
    style: [{
      id: 'st-test', dimension: 'diction', observation: '他会用「捏」结尾',
      pattern: '句尾偶尔跟一个「捏」', situation: '轻松的时候', avoid: '讲题结论',
      proposal: '', applicability: { channels: ['private'] }, confidence: 0.7,
      evidence: [{ handle: 's1', quote: '就这样捏' }],
      createdAt: '2026-10-29T10:00:00.000Z', status: 'pending',
    }],
  }, null, 2))
  const post = async (json) => {
    const res = await request('/coach/api/person', { json })
    return { status: res.status, body: JSON.parse(String(res.body)) }
  }
  assert.equal((await post({ action: 'pending.accept', id: 'p-test' })).status, 200)
  assert.equal((await post({ action: 'pending.accept', id: 'p-episode' })).status, 200)
  assert.equal((await post({ action: 'pending.accept', id: 'p-promise' })).status, 200)
  assert.equal((await post({ action: 'style.accept', id: 'st-test' })).status, 200)
  const read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.habits.length, 1)
  assert.equal(read.habits[0].situation, '他说不会')
  assert.equal(read.episodes.length, 1)
  assert.equal(read.episodes[0].at, '2026-10-29')
  assert.equal(read.promises.length, 1)
  assert.equal(read.promises[0].status, 'open')
  assert.equal(read.style[0].status, 'active')
  assert.equal(read.pending.length, 0)
  assert.ok(readFileSync(join(dir, 'person-events.jsonl'), 'utf8').includes('先问卡在哪'))
})

test('person API edits shared experiences and promises through the same ledger', async t => {
  const { dir, request } = await fixture(t)
  const post = async (json) => {
    const res = await request('/coach/api/person', { json })
    return { status: res.status, body: JSON.parse(String(res.body)) }
  }
  const episode = await post({
    action: 'episode.add',
    summary: '他第一次主动说想认真复盘，我们把昨天的比赛过了一遍。',
    at: '2026-10-30',
    tags: ['复盘'],
    evidence: '他说今天想认真复盘',
  })
  assert.equal(episode.status, 200)
  assert.equal(episode.body.ok, true)
  const promise = await post({
    action: 'promise.add',
    promiseText: '明天问他那道题的进度',
    dueAt: '2026-10-31',
    evidence: '他说记得问我',
  })
  assert.equal(promise.status, 200)
  let read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.episodes.length, 1)
  assert.equal(read.promises.length, 1)
  assert.match(read.episodes[0].summary, /复盘/)
  assert.equal(read.promises[0].status, 'open')

  const promiseId = read.promises[0].id
  assert.equal((await post({ action: 'promise.done', id: promiseId })).status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.promises[0].status, 'done')

  const episodeId = read.episodes[0].id
  assert.equal((await post({ action: 'episode.update', id: episodeId, summary: '他第一次主动说想认真复盘，我们把比赛过了一遍，还约了明天继续。' })).status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  const updatedEpisodeId = read.episodes[0].id
  assert.equal((await post({ action: 'episode.remove', id: updatedEpisodeId })).status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.episodes.length, 0)
  assert.ok(readFileSync(join(dir, 'person-events.jsonl'), 'utf8').includes('复盘'))
})


test('person panel arms and disarms the proactive worker through the page API', async t => {
  const { dir, request } = await fixture(t)
  writeFileSync(join(dir, 'proactive-state.json'), JSON.stringify({
    version: 2, enabled: false, sessionId: 'sess-test', recent: [], contacts: [],
  }, null, 2))
  const post = async (json) => {
    const res = await request('/coach/api/person', { json })
    return { status: res.status, body: JSON.parse(String(res.body)) }
  }
  const armed = await post({ action: 'proactive.arm' })
  assert.equal(armed.status, 200)
  assert.equal(armed.body.ok, true)
  let read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.proactive.enabled, true)
  assert.equal(read.proactive.sessionId, 'sess-test')
  const settings = await post({ action: 'proactive.settings', intensity: 'light', arbiter: false,
    external: true, weatherCity: '郑州', weatherKey: 'secret-key', weatherHost: 'test.qweatherapi.com', newsSources: 'zhihu,weibo', screenVision: true,
    autonomousReading: true })
  assert.equal(settings.status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.proactive.rhythm.intensity, 'light')
  assert.equal(read.proactive.settings.arbiter, false)
  assert.equal(read.proactive.settings.weatherCity, '郑州')
  assert.equal(read.proactive.settings.weatherHost, 'test.qweatherapi.com')
  assert.equal(read.proactive.settings.newsSources, 'zhihu,weibo')
  assert.equal(read.proactive.settings.autonomousReading, true)
  assert.equal(read.proactive.effective.autonomousReading, true)
  assert.equal(read.proactive.hasWeatherKey, true)
  assert.equal(read.proactive.settings.weatherKey, '***')
  const disarmed = await post({ action: 'proactive.disarm' })
  assert.equal(disarmed.status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.proactive.enabled, false)
})


test('person API lists and serves compacted event archives without exposing other files', async t => {
  const { dir, request } = await fixture(t)
  const name = 'person-events.archive-1700000000000-123.jsonl'
  writeFileSync(join(dir, name), '{"type":"claim","text":"旧账本"}\n')
  writeFileSync(join(dir, 'person-events.jsonl'), '{"type":"claim","text":"当前"}\n')
  const read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.archives.length, 1)
  assert.equal(read.archives[0].name, name)
  const download = await request(`/coach/api/person/archives/${name}`)
  assert.equal(download.status, 200)
  assert.match(String(download.body), /旧账本/)
  assert.match(String(download.headers['content-disposition']), /attachment/)
  assert.equal((await request('/coach/api/person/archives/..%2Fperson-events.jsonl')).status, 404)
})

test('person API stores boundaries and pinned facts, and resolves identity conflicts', async t => {
  const { dir, request } = await fixture(t)
  const post = async (json) => {
    const res = await request('/coach/api/person', { json })
    return { status: res.status, body: JSON.parse(String(res.body)) }
  }
  assert.equal((await post({ action: 'boundary.add', boundaryText: '不要叫我宝贝', evidence: '别叫我宝贝' })).status, 200)
  assert.equal((await post({ action: 'pin.add', pinText: '我在准备区域赛' })).status, 200)
  let read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.boundaries.length, 1)
  assert.equal(read.pinned.length, 1)

  const claims = await import('../lib/claims.js')
  claims.appendEvents(dir, [
    claims.eventForClaim('profile', { field: 'identity', text: '小鲸A' }),
    claims.eventForClaim('profile', { field: 'identity', text: '小鲸B' }),
  ])
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.conflicts.length, 1)
  assert.equal((await post({ action: 'conflict.resolve', kind: 'identity', value: '小鲸A' })).status, 200)
  read = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(read.profile.identity, '小鲸A')
  assert.equal(read.conflicts.length, 0)
})

test('person page polls the read-only API and refreshes content plus read-only status blocks', async () => {
  const html = readFileSync(new URL('../assets/knowledge/person.html', import.meta.url), 'utf8')
  const start = html.indexOf('/* ── 自动刷新')
  const end = html.indexOf('/* ── 渲染')
  assert.ok(start > 0 && end > start, 'the page has an auto-refresh section')
  assert.match(html, /setInterval\(\(\) => \{ refreshNow\(\) \}, REFRESH_MS\)/, 'the page polls on a timer before the first draw')
  // renderStatus 拆成「编辑表单」+「只读块」；自动刷新只重画只读块，不碰表单。
  const status = html.slice(html.indexOf('function renderStatus()'), html.indexOf('function renderRecentState()'))
  assert.match(status, /function renderStatus\(\) \{\s*renderPresenceEditor\(\)\s*renderRuntime\(\)/)
  assert.match(status, /function renderRuntime\(\) \{[\s\S]{0,120}renderPresenceStatus\(\)\s*\n\s*renderBodyMeters\(\)/)
  assert.match(status, /if \(!proactiveTouched\) renderProactive\(\)/)
  assert.match(status, /renderLife\(\)\s*\n\s*renderRecentState\(\)/)
  assert.match(status, /#presenceActual/)
  assert.match(html.slice(start, end), /renderContent\(\)\s*\n\s*renderRuntime\(\)/, 'a refresh repaints the read-only blocks too')

  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, className: '' })
    return nodes.get(id)
  }
  const base = {
    profile: { identity: '小鲸' }, relation: { milestones: [] }, habits: [], library: [], episodes: [],
    promises: [], boundaries: [], pinned: [], context: null, conflicts: [], pending: [], style: [],
    reflection: {}, rejectedCount: 0,
    body: { energy: 55, fatigue: 20, joy: 6, anger: 1, sorrow: 1, fear: 1, sleepDebt: 120, sleepPressure: 30,
      awakeMinutes: 100, updatedAt: '2026-11-12T00:00:00.000Z' },
    effectivePresence: { mode: 'normal', reason: '' },
    life: { day: '2026-11-12', kind: 'idle', source: 'ambient', description: '在看星星',
      startedAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', modelPlan: null },
    journal: { day: '2026-11-12', text: '今天的小日记', at: '2026-11-12T00:00:00.000Z' },
    proactive: { enabled: false, settings: { backgroundLlm: false }, recentContacts: [] },
  }
  const rendered = []
  let served = base
  let fetches = 0
  const sandbox = {
    DATA: base, $: node, esc: value => String(value), document: { activeElement: null }, dialog: { open: false },
    renderContent: () => rendered.push('content'), renderRuntime: () => rendered.push('runtime'),
    fetch: async () => { fetches += 1; return { ok: true, json: async () => ({ ok: true, ...served }) } },
    Date,
  }
  vm.createContext(sandbox)
  vm.runInContext(html.slice(start, end), sandbox)

  // 后台反思新增了书和待审候选：内容指纹变化，内容栏 + 只读块各重排一次。
  served = { ...base,
    pending: [{ id: 'p-new', kind: 'library', subject: 'role', fields: { title: '海' }, confidence: 0.6, evidence: [] }],
    library: [{ id: 'b1', title: '海' }] }
  assert.equal(await sandbox.refreshNow(), true)
  assert.deepEqual(rendered, ['content', 'runtime'])
  assert.equal(fetches, 1)
  assert.match(node('#status').innerHTML, /已刷新/)

  // 只有 updatedAt / awakeMinutes 变、展示值没变：不重排，避免每拍闪屏。
  served = { ...served, body: { ...served.body, updatedAt: '2026-11-12T00:01:00.000Z', awakeMinutes: 101 } }
  assert.equal(await sandbox.refreshNow(), false)
  assert.equal(rendered.length, 2)

  // 身体/心情的展示取整值变了：只读块要刷新（情绪数值在打开页面时也要能看到变化）。
  rendered.length = 0
  served = { ...served, body: { ...served.body, energy: 40, joy: 8 } }
  assert.equal(await sandbox.refreshNow(), true)
  assert.deepEqual(rendered, ['content', 'runtime'])

  // 在线状态从 normal 变 sleep、她今天也变：只读状态块跟着刷新。
  rendered.length = 0
  served = { ...served, effectivePresence: { mode: 'sleep', reason: '' },
    life: { ...served.life, kind: 'resting', description: '在补觉' } }
  assert.equal(await sandbox.refreshNow(), true)
  assert.deepEqual(rendered, ['content', 'runtime'])

  // 对话框打开或输入框聚焦时跳过，完全不发请求。
  sandbox.dialog.open = true
  const beforeSkip = fetches
  assert.equal(await sandbox.refreshNow(), false)
  sandbox.dialog.open = false
  sandbox.document.activeElement = { tagName: 'TEXTAREA' }
  assert.equal(await sandbox.refreshNow(), false)
  assert.equal(fetches, beforeSkip, 'editing never hits the API')

  // 刷新失败只提示，继续用上次读到的数据。
  sandbox.document.activeElement = null
  sandbox.fetch = async () => { fetches += 1; return { ok: false, status: 500, json: async () => ({}) } }
  assert.equal(await sandbox.refreshNow(), false)
  assert.match(node('#status').innerHTML, /刷新失败/)
  assert.equal(sandbox.DATA.library.length, 1, 'the last good data stays on screen')
})

test('person page refresh ignores now-derived proactive fields', () => {
  const html = readFileSync(new URL('../assets/knowledge/person.html', import.meta.url), 'utf8')
  const start = html.indexOf('/* ── 自动刷新')
  const end = html.indexOf('/* ── 渲染')
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(html.slice(start, end), sandbox)
  const base = {
    profile: { identity: '小鲸' }, relation: { milestones: [] }, habits: [], library: [], episodes: [],
    promises: [], boundaries: [], pinned: [], context: null, conflicts: [], pending: [], style: [],
    reflection: {}, rejectedCount: 0, body: null, effectivePresence: null, life: null, journal: null,
    proactive: { enabled: true, settings: { backgroundLlm: true }, recentContacts: [],
      nextAt: '2026-11-13T01:00:00.000Z', nextReason: 'ready' },
  }
  // armed 且到点时 nextAt 由 GET 用 now() 现算：只有它变不能触发每拍重排。
  const nextTick = { ...base, proactive: { ...base.proactive, nextAt: '2026-11-13T01:00:15.000Z' } }
  assert.equal(sandbox.contentSignature(base), sandbox.contentSignature(nextTick))
  // 真正的开关变化仍要触发刷新。
  const off = { ...base, proactive: { ...base.proactive, enabled: false } }
  assert.notEqual(sandbox.contentSignature(base), sandbox.contentSignature(off))
})

test('person page surfaces archive and style candidates at the top and keeps the GET read-only', async t => {
  const { dir, request } = await fixture(t)
  const html = String((await request('/coach/person.html')).body)
  assert.match(html, /id="pendingBanner"/)
  assert.match(html, /href="#sec-pending"/)
  assert.match(html, /href="#sec-style"/)
  assert.match(html, /id="stylePendingCount"/)
  const before = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(before.pending.length, 0)
  assert.equal(before.style.length, 0)
  writeFileSync(join(dir, 'person.json'), JSON.stringify({
    version: 1, revision: 0,
    pending: [{
      id: 'p-banner', kind: 'library', subject: 'role', fields: { title: '海' },
      evidence: [{ handle: 'u1', quote: '这本书你拿去读' }], confidence: 0.6,
      createdAt: new Date().toISOString(), status: 'pending',
    }],
    style: [{
      id: 'st-banner', dimension: 'diction', observation: '句尾会跟「捏」', pattern: '句尾加「捏」',
      situation: '轻松时', avoid: '讲题结论', proposal: '', applicability: {},
      evidence: [{ handle: 'u1', quote: '就这样捏' }], confidence: 0.6,
      createdAt: new Date().toISOString(), status: 'pending',
    }],
  }, null, 2))
  const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'hex')])
  const frozen = snapshot()
  const after = JSON.parse(String((await request('/coach/api/person')).body))
  assert.equal(after.pending.length, 1, 'the refresh source sees the new archive candidate')
  assert.equal(after.style.filter(item => item.status === 'pending').length, 1, 'and the new style candidate')
  assert.deepEqual(snapshot(), frozen, 'the page refresh GET writes nothing')

  // 横幅同时提示待审档案候选与待审说法候选。
  const source = html.slice(html.indexOf('function renderPendingBanner()'), html.indexOf('function renderConflicts()'))
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false })
    return nodes.get(id)
  }
  const sandbox = {
    DATA: { pending: after.pending, style: after.style }, $: node,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('renderPendingBanner()', sandbox)
  assert.equal(node('#pendingBanner').hidden, false)
  assert.equal(node('#pendingBannerCount').textContent, 2)
  assert.match(node('#pendingBannerText').innerHTML, /1 条待审候选/)
  assert.match(node('#pendingBannerText').innerHTML, /1 条说法候选/)
  assert.match(node('#pendingBannerText').innerHTML, /#sec-pending/)
  assert.match(node('#pendingBannerText').innerHTML, /#sec-style/)

  // 只有说法候选时也要提示，并锚到说法区。
  vm.runInContext('DATA.pending = []\nrenderPendingBanner()', sandbox)
  assert.equal(node('#pendingBanner').hidden, false)
  assert.equal(node('#pendingBannerCount').textContent, 1)
  assert.match(node('#pendingBannerText').innerHTML, /#sec-style/)
  vm.runInContext('DATA.style = []\nrenderPendingBanner()', sandbox)
  assert.equal(node('#pendingBanner').hidden, true)

  // 自动刷新复用的内容渲染会同步目录/统计/说法标题里的待审计数。
  const content = html.slice(html.indexOf('function renderContent()'), html.indexOf('function renderPendingBanner()'))
  assert.match(content, /\$\('#navPending'\)\.textContent = DATA\.pending\.length/)
  assert.ok(content.includes("$('#pendingCount').textContent = `${DATA.pending.length} 条`"))
  assert.match(content, /\$\('#stylePendingCount'\)\.hidden = pendingStyles === 0/)
  assert.ok(content.includes("$('#stylePendingCount').textContent = `${pendingStyles} 条待审`"))
  assert.match(content, /renderPendingBanner\(\)/)
})

test('person page marks a closed background reflection and shows how old the summary is', () => {
  const html = readFileSync(new URL('../assets/knowledge/person.html', import.meta.url), 'utf8')
  const source = html.slice(html.indexOf('function renderStatus()'), html.indexOf('function toLocalInput('))
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '当前处境' })
    return nodes.get(id)
  }
  let clock = new Date(2026, 10, 5, 18).getTime()
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  const DATA = {
    presence: { mode: 'auto', reason: '', until: '' },
    effectivePresence: { mode: 'normal' },
    body: { energy: 50, fatigue: 10, sleepDebt: 0, joy: 6, anger: 1, sorrow: 1, fear: 1 },
    proactive: { enabled: false, settings: { backgroundLlm: false }, effective: {} },
    reflection: {
      day: '2026-11-03', lastAt: new Date(2026, 9, 28, 8, 55).toISOString(),
      lastSummary: '上次整理的摘要', reflectCallsToday: 2,
    },
  }
  const sandbox = {
    DATA, Date: Clock, $: node, document: { querySelectorAll: () => [] },
    esc: value => String(value), pct: () => 0, toLocalInput: () => '',
    presenceTouched: false, proactiveTouched: false, PRESENCE_LABEL: { normal: '在线' },
  }
  vm.createContext(sandbox)
  vm.runInContext(source + '\nrenderStatus()', sandbox)
  assert.match(node('#reflectionBody').innerHTML, /上次整理的摘要/)
  assert.match(node('#reflectionBody').innerHTML, /后台反思已关闭，摘要不会自动更新/)
  assert.match(node('#reflectionBody').innerHTML, /8 天前/, 'the panel shows a relative age, not just a date')
  assert.match(node('#reflectionBody').innerHTML, /今天反思 0 次/)

  // 环境变量强制关闭时 effective 与设置不一致，也要提示。
  DATA.proactive = { enabled: false, settings: { backgroundLlm: true }, effective: { backgroundLlm: false } }
  vm.runInContext('renderRecentState()', sandbox)
  assert.match(node('#reflectionBody').innerHTML, /后台反思已关闭/)

  // 真正开着时不吓人。
  DATA.proactive = { enabled: false, settings: { backgroundLlm: true }, effective: { backgroundLlm: true } }
  vm.runInContext('renderRecentState()', sandbox)
  assert.doesNotMatch(node('#reflectionBody').innerHTML, /后台反思已关闭/)
  assert.match(node('#reflectionBody').innerHTML, /上次反思/)
  assert.match(node('#reflectionBody').innerHTML, /8 天前/)
})

test('person page shows the derived sleep mode without silently selecting auto', () => {
  const html = readFileSync(new URL('../assets/knowledge/person.html', import.meta.url), 'utf8')
  const source = html.slice(html.indexOf('function renderStatus()'), html.indexOf('function toLocalInput('))
  const nodes = new Map()
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, value: '' })
    return nodes.get(id)
  }
  const buttons = ['auto', 'busy', 'away'].map(mode => ({
    dataset: { mode }, pressed: 'true',
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = String(value) },
  }))
  const DATA = {
    presence: { mode: 'auto', reason: '', until: '' },
    effectivePresence: { mode: 'sleep' },
    body: { energy: 40, fatigue: 70, sleepDebt: 300, joy: 3, anger: 1, sorrow: 2, fear: 1 },
    proactive: null, life: null, journal: null, context: null, reflection: {},
  }
  const sandbox = {
    DATA, presenceTouched: false, proactiveTouched: false,
    PRESENCE_LABEL: { normal: '在线', sleep: '睡着了', nap: '午休' },
    $: node, document: { querySelectorAll: () => buttons },
    esc: value => String(value), pct: () => 0, toLocalInput: () => '',
  }
  vm.createContext(sandbox)
  vm.runInContext(source + '\nrenderStatus()', sandbox)
  // 睡眠是自动推导出来的：只读显示真实模式，编辑表单不能静默勾「自动」。
  assert.equal(node('#presenceActual').hidden, false)
  assert.match(node('#presenceActual').innerHTML, /睡着了/)
  assert.match(node('#presenceActual').innerHTML, /发消息会叫醒她/)
  assert.deepEqual(buttons.map(button => button.pressed), ['false', 'false', 'false'])

  DATA.effectivePresence = { mode: 'nap' }
  vm.runInContext('renderStatus()', sandbox)
  assert.match(node('#presenceActual').innerHTML, /午休/)

  DATA.effectivePresence = { mode: 'normal' }
  DATA.presence = { mode: 'busy', reason: '在写题解', until: '' }
  vm.runInContext('renderStatus()', sandbox)
  assert.equal(node('#presenceActual').hidden, true)
  assert.deepEqual(buttons.map(button => button.pressed), ['false', 'true', 'false'])
  assert.equal(node('#presenceReason').value, '在写题解')

  // 用户明确点过按钮后，即使还在睡也显示他选的那个模式。
  DATA.effectivePresence = { mode: 'sleep' }
  sandbox.presenceTouched = true
  vm.runInContext('renderStatus()', sandbox)
  assert.match(node('#presenceActual').innerHTML, /睡着了/)
  assert.deepEqual(buttons.map(button => button.pressed), ['false', 'true', 'false'])
})

test('person page keeps unsaved proactive settings while refreshing the read-only blocks', () => {
  const html = readFileSync(new URL('../assets/knowledge/person.html', import.meta.url), 'utf8')
  const source = html.slice(html.indexOf('function renderRuntime()'), html.indexOf('function renderPresenceStatus()'))
  assert.ok(source.includes('if (!proactiveTouched) renderProactive()'), 'the form guard lives in the runtime renderer')
  const calls = []
  const sandbox = {
    proactiveTouched: false,
    renderPresenceStatus: () => calls.push('presence'),
    renderBodyMeters: () => calls.push('body'),
    renderProactive: () => calls.push('proactive'),
    renderLife: () => calls.push('life'),
    renderRecentState: () => calls.push('recent'),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  vm.runInContext('renderRuntime()', sandbox)
  assert.deepEqual(calls, ['presence', 'body', 'proactive', 'life', 'recent'])

  // 用户动过主动联系的设置表单（还没保存）：刷新时保留输入，其他只读块照常更新。
  calls.length = 0
  vm.runInContext('proactiveTouched = true\nrenderRuntime()', sandbox)
  assert.deepEqual(calls, ['presence', 'body', 'life', 'recent'])
})

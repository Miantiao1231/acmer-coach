import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { emptyPerson, savePerson } from '../lib/person.js'

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
    esc: value => String(value), pct: () => 0, toLocalInput: () => '' }
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

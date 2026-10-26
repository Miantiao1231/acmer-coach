import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    const res = { status: undefined, headers: {}, body: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.body = body },
    }
    await handler({ url, method: 'GET', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' }, ...overrides }, res)
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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const html = readFileSync(new URL('../assets/knowledge/vp.html', import.meta.url), 'utf8')
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1])

test('VP page links back to the skilltree, schedule, and training log', () => {
  assert.match(html, /href="\.\/skilltree\.html">技能树与日程/)
  assert.match(html, /href="\.\/skilltree\.html#log">训练日志/)
})

test('VP supports embedded mode without duplicating the coach shell header', () => {
  assert.match(html, /URLSearchParams\(location\.search\).*embed.*dataset\.embedded/s)
  assert.match(html, /html\[data-embedded="1"\] \.site-header\s*\{\s*display:none;/)
})

function page(saved, blocked = false) {
  let context
  const events = []
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], { hidden: false, style: {}, dataset: {}, classList: { toggle() {} }, textContent: '', innerHTML: '', value: '', setAttribute(key, value) { this[key] = value }, focus() { context.document.activeElement = this } }]))
  const listeners = {}
  const storage = new Map(saved === undefined ? [] : [['coach.theme', saved]])
  context = vm.createContext({
    document: { documentElement: { dataset: {} }, getElementById: id => nodes[id], querySelectorAll: selector => selector === '.event' ? events : [], addEventListener: (name, listener) => { listeners[name] = listener } },
    localStorage: { getItem(key) { if (blocked) throw Error('storage denied'); return storage.get(key) ?? null }, setItem(key, value) { if (blocked) throw Error('storage denied'); storage.set(key, value) } },
    window: { addEventListener: (name, listener) => { listeners[name] = listener }, open() {} },
    fetch: async () => ({ ok: true, json: async () => ({ connected: false }) }),
    console, Date, Error, Number, String, Math, JSON, encodeURIComponent,
    URLSearchParams, location: { search: '' },
  })
  scripts.forEach(script => vm.runInContext(script, context))
  return { context, nodes, listeners, storage, events }
}

test('VP uses the platform dark default and keeps an existing shared light choice', () => {
  assert.equal(page().context.document.documentElement.dataset.theme, 'dark')
  assert.equal(page('light').context.document.documentElement.dataset.theme, 'light')
  assert.equal(page('dark').context.document.documentElement.dataset.theme, 'dark')
  assert.equal(page('unexpected').context.document.documentElement.dataset.theme, 'dark')
})

test('theme toggle updates the accessible button and persists the shared choice', () => {
  const p = page()
  assert.equal(p.nodes.themeToggle['aria-label'], '切换到浅色')
  p.nodes.themeToggle.onclick()
  assert.equal(p.context.document.documentElement.dataset.theme, 'light')
  assert.equal(p.storage.get('coach.theme'), 'light')
  assert.equal(p.nodes.themeToggle['aria-label'], '切换到深色')
})

test('blocked browser storage does not prevent the replay page or theme toggle', () => {
  const p = page(undefined, true)
  p.nodes.themeToggle.onclick()
  assert.equal(p.context.document.documentElement.dataset.theme, 'light')
  assert.equal(typeof p.nodes.refresh.onclick, 'function')
})

test('theme follows the other coach page without accepting an invalid storage value', () => {
  const p = page()
  p.listeners.storage({ key: 'coach.theme', newValue: 'light' })
  assert.equal(p.context.document.documentElement.dataset.theme, 'light')
  assert.equal(p.nodes.themeToggle['aria-label'], '切换到深色')
  p.listeners.storage({ key: 'coach.theme', newValue: 'unexpected' })
  assert.equal(p.context.document.documentElement.dataset.theme, 'light')
})

test('timeline submission detail is available with Enter and Space as well as a click', () => {
  const p = page()
  const mark = { dataset: { event: '0' } }
  p.events.push(mark)
  p.context.render({ visualization: { duration_seconds: 18000, team_events: [{ problem: 'A', verdict: 'AC', second: 900, display_name: '队员' }] }, problems: [{ label: 'A', title: '<script>bad</script>', id: 'A' }] })
  for (const key of ['Enter', ' ']) {
    let prevented = false
    mark.onkeydown({ key, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(p.nodes.message.textContent, 'A · AC · 15 分钟 · 队员')
  }
  assert.match(p.nodes.timeline.innerHTML, /role="button" aria-label="A · AC · 15 分钟"/)
  assert.match(p.nodes.problems.innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/)
})

test('authorization dialog focuses its input, wraps Tab, and closes with Escape', () => {
  const p = page()
  p.nodes.syncEmpty.onclick()
  assert.equal(p.nodes.modal.hidden, false)
  assert.equal(p.context.document.activeElement, p.nodes.code)
  p.listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault() {} })
  assert.equal(p.context.document.activeElement, p.nodes.finish)
  p.listeners.keydown({ key: 'Tab', shiftKey: false, preventDefault() {} })
  assert.equal(p.context.document.activeElement, p.nodes.code)
  p.listeners.keydown({ key: 'Escape' })
  assert.equal(p.nodes.modal.hidden, true)
  assert.equal(p.context.document.activeElement, p.nodes.start)
})

test('a disconnected account clears the previous account contest list', async () => {
  const p = page()
  p.nodes.contests.innerHTML = 'previous account private contest'
  p.nodes.heroTitle.textContent = 'previous account private title'
  p.nodes.metrics.innerHTML = 'previous account private metrics'
  p.nodes.timeline.innerHTML = 'previous account private events'
  p.nodes.problems.innerHTML = 'previous account private problems'
  await p.context.loadStatus()
  assert.doesNotMatch(p.nodes.contests.innerHTML, /previous account/)
  assert.doesNotMatch(p.nodes.heroTitle.textContent, /previous account/)
  for (const id of ['metrics', 'timeline', 'problems']) assert.doesNotMatch(p.nodes[id].innerHTML, /previous account/)
  assert.equal(p.nodes.workspace.hidden, true)
  assert.equal(p.nodes.connectCard.hidden, false)
})

test('status request failure has a visible error rather than a permanent checking state', async () => {
  const p = page()
  p.context.fetch = async () => { throw Error('服务暂时不可用') }
  await p.context.loadStatus()
  assert.equal(p.nodes.message.textContent, '服务暂时不可用')
  assert.match(p.nodes.status.innerHTML, /连接检查失败/)
  assert.match(p.nodes.contests.innerHTML, /暂时无法读取比赛/)
})

test('switching contests shows loading and ignores the older replay response', async () => {
  const p = page()
  await p.context.loadStatus()
  const finish = new Map()
  p.context.fetch = path => new Promise(resolve => finish.set(path, resolve))
  const old = p.context.selectContest(11)
  assert.match(p.nodes.timeline.innerHTML, /正在读取回放/)
  const current = p.context.selectContest(12)
  finish.get('./api/vp/replay?contestId=12')({ ok: true, json: async () => ({ result: { solved: 2 }, visualization: { duration_seconds: 18000 } }) })
  await current
  const currentView = p.nodes.metrics.innerHTML
  finish.get('./api/vp/replay?contestId=11')({ ok: true, json: async () => ({ result: { solved: 99 }, visualization: { duration_seconds: 18000 } }) })
  await old
  assert.equal(p.nodes.metrics.innerHTML, currentView)
})

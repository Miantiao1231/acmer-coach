import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
const template = readFileSync(new URL('../coach/skilltree_template.html', import.meta.url), 'utf8')
const boot = template.match(/<script>([\s\S]*?)<\/script>/)[1]
for (const stored of [null, 'dark', 'light', 'invalid']) {
  test(`map starts with saved preference: ${stored}`, () => {
    const html = { dataset: { theme: 'dark' }, style: {} }
    vm.runInNewContext(boot, { document: { documentElement: html }, localStorage: { getItem: () => stored } })
    const expected = stored === 'light' ? 'light' : 'dark'
    assert.equal(html.dataset.theme, expected)
    assert.equal(html.style.colorScheme, expected)
    assert.equal(html.style.background, expected === 'dark' ? '#071528' : '#eef5fc')
  })
}
test('map loads with browser storage disabled', () => {
  const html = { dataset: { theme: 'dark' }, style: {} }
  vm.runInNewContext(boot, { document: { documentElement: html }, localStorage: { getItem: () => { throw new Error('blocked') } } })
  assert.equal(html.dataset.theme, 'dark')
  assert.equal(html.style.colorScheme, 'dark')
})

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function clientHarness(stored, source = clientSource) {
  const calls = [], updates = [], effects = [], listeners = new Map()
  const dialog = { showModal: () => calls.push('open'), close: () => calls.push('close') }
  const React = {
    useRef: () => ({ current: dialog }),
    useState: init => [typeof init === 'function' ? init() : init, value => updates.push(value)],
    useEffect: effect => effects.push(effect),
  }
  let api
  vm.runInNewContext(source.replace('return { apply, inject };', 'return { apply, inject, useCoachPanel, closeBackdrop };'), {
    localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored } },
    window: {
      __ModuleLoader__: { load: ({ factory }) => { api = factory(name => name === 'react' ? React : {}) } },
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: name => listeners.delete(name),
    },
  })
  return { api, calls, updates, effects, listeners }
}

test('native coach panel opens modally and cleans up its listeners', () => {
  const h = clientHarness('light')
  assert.equal(h.api.useCoachPanel().theme, 'light')
  const dispose = h.effects[0]()
  assert.deepEqual(h.calls, ['open'])
  h.listeners.get('storage')({ key: 'other', newValue: 'dark' })
  assert.deepEqual(h.updates, [])
  h.listeners.get('storage')({ key: 'coach.theme', newValue: 'dark' })
  assert.deepEqual(h.updates, ['dark'])
  dispose()
  assert.deepEqual(h.calls, ['open', 'close'])
  assert.equal(h.listeners.size, 0)
})
test('native coach panel defaults to VP dark when storage is blocked', () => {
  assert.equal(clientHarness(new Error('blocked')).api.useCoachPanel().theme, 'dark')
})
test('clicks inside dialog bounds do not dismiss the workbench', () => {
  const { api } = clientHarness(null)
  const dialog = { getBoundingClientRect: () => ({ left: 20, top: 20, right: 400, bottom: 500 }) }
  let closed = 0
  const close = () => closed++
  api.closeBackdrop({ target: dialog, currentTarget: dialog, clientX: 25, clientY: 25 }, close)
  assert.equal(closed, 0)
  api.closeBackdrop({ target: dialog, currentTarget: dialog, clientX: 5, clientY: 5 }, close)
  assert.equal(closed, 1)
})

test('map filter control collapses on narrow screens and can reopen', () => {
  const source = template.slice(template.indexOf('const filterButton ='), template.indexOf('$("#modeSeg").onclick'))
  const attrs = {}, button = { setAttribute: (name, value) => { attrs[name] = value } }
  const body = { dataset: {} }
  let fitted = 0
  vm.runInNewContext(source, { $: () => button, document: { body }, matchMedia: () => ({ matches: true }), fit: () => fitted++ })
  assert.equal(body.dataset.filters, 'closed')
  assert.equal(attrs['aria-expanded'], 'false')
  button.onclick()
  assert.equal(body.dataset.filters, 'open')
  assert.equal(attrs['aria-expanded'], 'true')
  assert.equal(fitted, 1)
  button.onclick()
  assert.equal(body.dataset.filters, 'closed')
  assert.equal(attrs['aria-expanded'], 'false')
  assert.equal(fitted, 2)
})

test('map shortcuts do not consume schedule scrolling or form controls', () => {
  const source = template.slice(template.indexOf('addEventListener("keydown", (e) => {'), template.indexOf('addEventListener("resize", () => fit());'))
  for (const scenario of [{ view: 'sched', interactive: false }, { view: 'tree', interactive: true }]) {
    let handler, intercepted = 0
    vm.runInNewContext(source, {
      addEventListener: (_, fn) => { handler = fn },
      document: { body: { dataset: { view: scenario.view } } },
      selected: 'A', select: () => intercepted++, setStatus: () => intercepted++, nextAfter: () => 'B',
    })
    handler({ key: 'ArrowRight', target: { closest: () => scenario.interactive }, preventDefault: () => intercepted++ })
    assert.equal(intercepted, 0)
  }
})

test('both template scripts compile without altering the data marker', () => {
  assert.equal(template.split('/*__DATA__*/null').length, 2)
  for (const [, script] of template.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script)
})

test('empty search results give a visible recovery hint', () => {
  const source = template.slice(template.indexOf('function apply() {'), template.indexOf('function paintChain(id)'))
  const empty = { hidden: true }, count = {}
  vm.runInNewContext(source + '\napply();', {
    NODES: [], visible: () => false, nodeEls: new Map(), edgeEls: [], selected: null,
    buildLegend: () => {}, paintChain: () => {}, $: selector => selector === '#mapEmpty' ? empty : count,
  })
  assert.equal(empty.hidden, false)
})

test('closed filters hide their panel and mobile filters stay inside map content', () => {
  const css = template.match(/<style>([\s\S]*?)<\/style>/)[1]
  const closed = css.match(/body\[data-filters="closed"\] \.side\{([^}]*)\}/)?.[1] || ''
  assert.match(closed, /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/)
  const base = css.match(/(?:^|\n)\.side\{([^}]*)\}/)?.[1] || ''
  assert.match(base, /grid-area:side/)
  assert.match(base, /padding:/)
  const mobile = css.slice(css.indexOf('@media(max-width:680px)'))
  assert.match(mobile.match(/\.side\{([^}]*)\}/)?.[1] || '', /grid-area:stage/)
})

test('unmount restores focus to the still-connected opener button', () => {
  const h = clientHarness(null)
  const calls = []
  h.api.useCoachPanel({ current: { isConnected: true, focus: () => calls.push('focus') } })
  h.effects[0]()()
  assert.deepEqual(calls, ['focus'])
})

test('unmount does not focus an opener removed with its host conversation', () => {
  const h = clientHarness(null)
  const calls = []
  h.api.useCoachPanel({ current: { isConnected: false, focus: () => calls.push('focus') } })
  h.effects[0]()()
  assert.deepEqual(calls, [])
})

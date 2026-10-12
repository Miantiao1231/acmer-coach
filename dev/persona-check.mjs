import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const personaPath = new URL('../assets/persona/xiaojing-coach.md', import.meta.url)
const rulesPath = new URL('../assets/rules/coach-rules.md', import.meta.url)
let imports = 0

async function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'coach-persona-'))
  const previous = Object.fromEntries(['COACH_DATA_DIR', 'COACH_DB', 'COACH_RULES_DIR'].map(key => [key, process.env[key]]))
  process.env.COACH_DATA_DIR = dir
  process.env.COACH_DB = join(dir, 'unused.db')
  delete process.env.COACH_RULES_DIR
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { apply } = await import(`../index.js?persona-check=${++imports}`)
  const tools = new Map(), hooks = new Map(), sections = []
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: name => name === 'systemPrompt' ? { section: section => sections.push(section) } : undefined,
    on: (name, handler) => hooks.set(name, handler),
    inject() {},
  }
  return { dir, apply, ctx, tools, hooks, sections }
}

function denyReads(t, denied) {
  const read = fs.readFileSync
  const mocked = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (denied(String(path).replaceAll('\\', '/'))) throw Object.assign(new Error('fixture missing file'), { code: 'ENOENT' })
    return read(path, ...args)
  })
  syncBuiltinESMExports()
  return () => { mocked.mock.restore(); syncBuiltinESMExports() }
}

function assertTools(f) {
  assert.equal(f.tools.size, 31)
  assert.ok(f.tools.has('coach_status'))
  assert.ok(f.tools.has('coach_note'))
}

test('apply loads packaged static persona before custom style without local personas', async t => {
  const f = await fixture(t)
  const restore = denyReads(t, path => path.includes('/personas/'))
  try { f.apply(f.ctx) } finally { restore() }
  const persona = f.sections.find(section => section.name === 'coach:persona')
  assert.ok(persona, 'packaged persona must load through the public apply entry')
  assert.equal(persona.text, fs.readFileSync(personaPath, 'utf8'))
  assert.equal(persona.order, -100)
  const rules = f.sections.find(section => section.name === 'coach:rules')
  assert.equal(rules.text, fs.readFileSync(rulesPath, 'utf8'))
  assert.equal(rules.order, 400)
  const custom = { name: 'deployment:persona-prefix', order: 0, text: '自定义风格' }
  assert.deepEqual([...f.sections, custom].sort((a, b) => a.order - b.order).map(section => section.name),
    ['coach:persona', 'deployment:persona-prefix', 'coach:rules'])
  assertTools(f)
})

test('missing packaged persona leaves rules and tools available', async t => {
  const f = await fixture(t)
  const restore = denyReads(t, path => path.endsWith('/assets/persona/xiaojing-coach.md'))
  try { f.apply(f.ctx) } finally { restore() }
  assert.deepEqual(f.sections.map(section => section.name), ['coach:rules'])
  assert.equal(f.sections[0].text, fs.readFileSync(rulesPath, 'utf8'))
  assertTools(f)
})

test('rejected persona section leaves rules and tools available', async t => {
  const f = await fixture(t)
  f.ctx.get = () => ({ section(section) {
    if (section.name === 'coach:persona') throw new Error('host rejects persona section')
    f.sections.push(section)
  } })
  f.apply(f.ctx)
  assert.deepEqual(f.sections.map(section => section.name), ['coach:rules'])
  assert.equal(f.sections[0].text, fs.readFileSync(rulesPath, 'utf8'))
  assertTools(f)
})

test('missing rules leaves packaged persona and tools available', async t => {
  const f = await fixture(t)
  const restore = denyReads(t, path => path.endsWith('/assets/rules/coach-rules.md'))
  try { f.apply(f.ctx) } finally { restore() }
  assert.deepEqual(f.sections.map(section => section.name), ['coach:persona'])
  assert.equal(f.sections[0].text, fs.readFileSync(personaPath, 'utf8'))
  assertTools(f)
})

test('rejected rules section leaves packaged persona and tools available', async t => {
  const f = await fixture(t)
  f.ctx.get = () => ({ section(section) {
    if (section.name === 'coach:rules') throw new Error('host rejects rules section')
    f.sections.push(section)
  } })
  f.apply(f.ctx)
  assert.deepEqual(f.sections.map(section => section.name), ['coach:persona'])
  assert.equal(f.sections[0].text, fs.readFileSync(personaPath, 'utf8'))
  assertTools(f)
})

for (const unavailable of ['missing service', 'missing get', 'throwing get']) {
  test(`all 31 tools load with ${unavailable}`, async t => {
    const f = await fixture(t)
    if (unavailable === 'missing get') delete f.ctx.get
    else f.ctx.get = () => {
      if (unavailable === 'throwing get') throw new Error('service unavailable')
      return undefined
    }
    assert.doesNotThrow(() => f.apply(f.ctx))
    assert.deepEqual(f.sections, [])
    assertTools(f)
    const result = await f.tools.get('coach_target').execute({ action: 'profiles' })
    assert.equal(result.ok, true)
    assert.ok(result.availableProfiles.length)
  })
}

test('persona is read once into static sections, never messages or training ledgers', async t => {
  const f = await fixture(t)
  fs.writeFileSync(join(f.dir, 'MAP.yaml'), 'meta: {version: 1}\nnodes: [{id: fixture-node, name: 测试节点}]\n')
  fs.writeFileSync(join(f.dir, 'PROGRESS.yaml'), 'version: 1\ncursor: fixture-node\nnodes: {}\npending: null\n')
  const snapshot = () => fs.readdirSync(f.dir).sort().map(name => [name, fs.readFileSync(join(f.dir, name), 'utf8')])
  const before = snapshot()
  const reads = []
  const restore = denyReads(t, path => {
    if (path.endsWith('/assets/persona/xiaojing-coach.md') || path.endsWith('/assets/rules/coach-rules.md')) reads.push(path)
    return false
  })
  try {
    f.apply(f.ctx)
    assert.equal(f.sections.length, 2)
    assert.ok(f.sections.every(section => typeof section.text === 'string'))
    const initial = structuredClone(f.sections)
    const hook = f.hooks.get('agent/pre-step')
    for (const step of [1, 2, 1]) {
      const messages = [{ role: 'user', content: [{ type: 'text', text: '继续' }] }]
      const result = await hook({ messages, step }, async () => ({ kind: 'enter', messages }))
      assert.deepEqual(result.messages[0], messages[0])
      for (const message of result.messages.slice(1)) {
        assert.ok(message.content.every(block => block.type === 'text' && block.text.startsWith('<coach_state>\n')))
      }
      assert.ok(!JSON.stringify(result.messages).includes('鲸鱼娘'))
    }
    assert.deepEqual(f.sections, initial)
    assert.equal(reads.filter(path => path.endsWith('/xiaojing-coach.md')).length, 1)
    assert.equal(reads.filter(path => path.endsWith('/coach-rules.md')).length, 1)
  } finally { restore() }
  assert.deepEqual(snapshot(), before)
  assertTools(f)
})

test('bundle declares a native 小鲸教练 preset with the stock standard capability composition', async () => {
  const patches = parse(fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  const entries = patches.flatMap(patch => patch.insert ?? [])
  const preset = entries.find(entry => entry.config?.id === 'acmer-coach-xiaojing')
  assert.ok(preset, 'installing the bundle must declare the selectable native 小鲸教练 preset')
  assert.equal(preset.id, 'preset-acmer-coach-xiaojing')
  assert.equal(preset.name, '@deepseek-ai/dsh-agent-preset')
  const config = preset.config
  assert.equal(config.name, '小鲸教练')
  assert.equal(entries.filter(entry => entry.name === 'acmer-coach').length, 1)
  assert.ok(!entries.some(entry => entry.id === 'agent-preset-registry'), 'bundle must not change the selected default')
  const persona = config.plugins.find(entry => entry.id === 'persona')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.ok(persona.config.prefix.includes('coach:persona'))
  assert.ok(persona.config.prefix.includes('coach:rules'))
  assert.ok(persona.config.prefix.length < 200, 'reuse packaged persona without duplicating its full text')
  assert.equal(persona.config.suffix, 'Your working directory is {{cwd}}.')
  const ids = config.plugins.map(entry => entry.id)
  for (const id of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill',
    'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present']) assert.ok(ids.includes(id), id)
  const delegation = config.plugins.find(entry => entry.id === 'delegation')
  for (const id of ['tool-subagent-codex', 'tool-subagent-claude-code', 'tool-ralph']) {
    assert.equal(delegation.config.find(entry => entry.id === id).disabled, true, `${id} stays disabled`)
  }
  assert.equal(config.plugins.find(entry => entry.id === 'tool-bash').disabled, "process.platform === 'win32'")
  assert.equal(config.plugins.find(entry => entry.id === 'tool-pwsh').disabled, "process.platform !== 'win32'")
  assert.equal(config.plugins.find(entry => entry.id === 'tool-plugin-manager').disabled, true)
  assert.ok(!JSON.stringify(config).match(/[A-Z]:[\\/]|accountId|userId|handle|rating/), 'preset must contain no private profile paths or account data')
})

test('packaged preset passes the installed native loader and configuration schemas', async t => {
  let boot, presets, registry, loader
  try {
    [boot, presets, registry, loader] = await Promise.all([
      import('@deepseek-ai/dsh-app-boot'), import('@deepseek-ai/dsh-agent-preset'),
      import('@deepseek-ai/dsh-agent-preset-registry'), import('@deepseek-ai/cordis-plugin-loader'),
    ])
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    t.skip('native preset packages are supplied by the dsh host; portable bundle checks still run')
    return
  }
  const entries = boot.composeEntries([boot.loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))])
  const row = entries.find(entry => entry.config?.id === 'acmer-coach-xiaojing')
  assert.ok(row)
  const config = presets.default.Config(row.config)
  assert.equal(registry.entryListProblem(config.plugins), undefined)
  const enabledShell = config.plugins.filter(entry => ['tool-bash', 'tool-pwsh'].includes(entry.id))
    .filter(entry => !loader.interpolate({}, entry.disabled)).map(entry => entry.id)
  assert.deepEqual(enabledShell, [process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash'])
  async function validate(rows) {
    for (const entry of rows) {
      if (entry.group) { await validate(entry.config); continue }
      if (loader.interpolate({}, entry.disabled)) continue
      const plugin = await import(entry.name)
      const schema = plugin.Config ?? plugin.default?.Config
      if (schema) assert.doesNotThrow(() => schema(entry.config ?? {}), entry.name)
      if (plugin.resolveConfig) assert.doesNotThrow(() => plugin.resolveConfig(entry.config ?? {}), entry.name)
    }
  }
  await validate(config.plugins)
  let standardPath
  try { standardPath = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json'))), 'presets', 'standard.patch.yml') }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  if (standardPath && fs.existsSync(standardPath)) {
    const stock = boot.composeEntries([boot.loadOverlayPatches('dsh', standardPath)]).find(entry => entry.config?.id === 'standard')
    const actual = structuredClone(config.plugins)
    actual.find(entry => entry.id === 'persona').config.prefix = stock.config.plugins.find(entry => entry.id === 'persona').config.prefix
    assert.deepEqual(actual, stock.config.plugins, 'stock capability snapshot differs only in the persona prefix')
  }
})

// 数据边界静态检查：每个持久文件只属于一个域、只有一个写入者。
//
// 规则见 docs/数据边界.md。这里只做机器能判的那一半：运行时代码里出现某个
// 存储文件名时，所在模块必须是 owner 或显式登记的 reader。新增存储文件必须
// 先登记，否则测试失败——防止下一次又悄悄长出一个「第六种记忆」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = ['index.js', ...readdirSync(join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => `lib/${name}`)]

// 包内知识资产，不是用户数据；它们只读，不参与写入归属。
const ASSETS = new Set([
  'COMPETENCIES.yaml', 'NODE_SCOPES.yaml', 'CONTEST_PROFILES.yaml', 'NODE_META.yaml',
  'CONTEST_INDEX.json', 'node-pages.json', 'chunks.jsonl', 'DEPENDS.yaml',
])

// 租约锁不是数据存储；只保证 runtime 独占，不参与域。
const LOCKS = new Set(['proactive-worker.lock'])

// owner = 唯一写入者；readers = 允许直接读该文件的模块。
// 跨域读侧应优先调用 owner 导出的函数；这里列的是当前实现，缩小要靠重构，不靠放宽。
const STORES = {
  'PROGRESS.yaml': { domain: 'training', owner: 'index.js', readers: ['lib/workspace-migration.js'] },
  'SCHEDULE.yaml': { domain: 'training', owner: 'index.js', readers: ['lib/workspace-migration.js'] },
  'CURRICULUM.yaml': { domain: 'training', owner: 'lib/curriculum.js', readers: ['lib/workspace-migration.js'] },
  'TARGET.yaml': { domain: 'training', owner: 'lib/strategy.js', readers: ['lib/workspace-migration.js'] },
  'VP_EVENTS.yaml': { domain: 'training', owner: 'lib/strategy.js', readers: [] },
  'training.db': { domain: 'training', owner: 'index.js', readers: [] },
  'MAP.yaml': { domain: 'training', owner: 'lib/map-upgrade.js', readers: ['index.js'] },
  '.map-shipped.json': { domain: 'training', owner: 'lib/map-upgrade.js', readers: [] },
  'MAP-upgrade-report.json': { domain: 'training', owner: 'lib/map-upgrade.js', readers: [] },
  'person-events.jsonl': { domain: 'role', owner: 'lib/claims.js', readers: [] },
  'person.json': { domain: 'role', owner: 'lib/person.js', readers: ['lib/claims.js'] }, // 迁移前备份，见 docs 例外
  'companion-state.json': { domain: 'life', owner: 'lib/companion-state.js', readers: [] },
  'journal-archive.json': { domain: 'life', owner: 'lib/journal.js', readers: [] },
  'activities.json': { domain: 'life', owner: 'lib/activity-ledger.js', readers: [] },
  'sleep-ledger.json': { domain: 'life', owner: 'lib/sleep-ledger.js', readers: [] },
  'sleep-settings.json': { domain: 'life', owner: 'lib/sleep-settings.js', readers: [] },
  'growth-notes.json': { domain: 'life', owner: 'lib/growth.js', readers: [] },
  'habit-candidates.json': { domain: 'life', owner: 'lib/habits.js', readers: [] },
  'memory-cursor.json': { domain: 'life', owner: 'lib/episodes.js', readers: [] },
  'interaction-log.json': { domain: 'life', owner: 'lib/interaction-log.js', readers: [] },
  'state-patrol.json': { domain: 'life', owner: 'lib/state-patrol.js', readers: [] },
  'persona-audit.jsonl': { domain: 'process', owner: 'lib/persona-audit.js', readers: [] },
  'tasks.json': { domain: 'process', owner: 'lib/task-queue.js', readers: [] },
  'tool-operations.json': { domain: 'process', owner: 'lib/tool-operations.js', readers: [] },
  'reflection-batch.json': { domain: 'process', owner: 'lib/reflection-batch.js', readers: [] },
  'reading-receipt.json': { domain: 'process', owner: 'lib/reading.js', readers: [] },
  'proactive-state.json': { domain: 'process', owner: 'lib/proactive-state.js', readers: [] },
  'screen-captures.json': { domain: 'process', owner: 'lib/screen-originals.js', readers: [] },
  'screen-consent.json': { domain: 'process', owner: 'lib/screen-consent.js', readers: [] },
  'rest-gate.json': { domain: 'process', owner: 'lib/rest-gate.js', readers: [] },
  'busy-gate.json': { domain: 'process', owner: 'lib/busy-gate.js', readers: [] },
  'external-cache.json': { domain: 'process', owner: 'lib/external-sources.js', readers: [] },
  'hindsight.json': { domain: 'external', owner: 'lib/hindsight.js', readers: [] },
  'VP_ACCOUNTS.json': { domain: 'external', owner: 'lib/vp-client.js', readers: [] },
  'TOKEN.json': { domain: 'external', owner: 'lib/vp-client.js', readers: [] },
  'SYNC.json': { domain: 'external', owner: 'lib/vp-client.js', readers: [] },
  'PERSONAL_MIGRATION.json': { domain: 'migration', owner: 'lib/workspace-migration.js', readers: [] },
}

function stripComments(source) {
  let out = ''
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += source[i + 1] ?? ''; i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; out += '\n'; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

const sources = new Map(RUNTIME.map((file) => [file, stripComments(readFileSync(join(root, file), 'utf8'))]))
const mentions = (text, file) => text.includes(`'${file}'`) || text.includes(`"${file}"`)

test('每个存储文件只被 owner 或登记过的 reader 直接引用', () => {
  const violations = []
  for (const [file, spec] of Object.entries(STORES)) {
    const allowed = new Set([spec.owner, ...spec.readers])
    for (const [module, text] of sources) {
      if (allowed.has(module)) continue
      if (mentions(text, file)) violations.push(`${file}（${spec.domain}）被 ${module} 直接引用；owner=${spec.owner}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('lib 里每个 const FILE 都在边界表登记', () => {
  const missing = []
  for (const [module, text] of sources) {
    for (const match of text.matchAll(/const\s+FILE\s*=\s*['"]([^'"]+)['"]/g)) {
      const file = match[1]
      if (ASSETS.has(file) || LOCKS.has(file) || STORES[file]) continue
      missing.push(`${module} → ${file}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('运行时代码里的存储文件名没有漏登记的第六种 store', () => {
  const known = new Set([...Object.keys(STORES), ...ASSETS])
  const unknown = new Set()
  for (const text of sources.values()) {
    for (const match of text.matchAll(/['"]([A-Za-z0-9_.-]+\.(?:json|jsonl|yaml|yml|db))['"]/g)) {
      if (!known.has(match[1])) unknown.add(match[1])
    }
  }
  // 测试/文档里出现的临时名字不算；这里只看运行时源码。
  assert.deepEqual([...unknown].sort(), [], '新增存储文件先登记到 docs/数据边界.md 与 dev/data-boundary-check.mjs')
})

test('边界文档包含五个域和六条规则', () => {
  const doc = readFileSync(join(root, 'docs', '数据边界.md'), 'utf8')
  for (const domain of ['训练事实', '角色与关系', '角色生活', '进程', '外部']) assert.ok(doc.includes(domain), domain)
  assert.ok(doc.includes('六条规则'))
  assert.ok(doc.includes('已知例外'))
})

// 供其它检查复用的失败信息前缀，避免 silent pass。
test('the boundary check itself reads real runtime files', () => {
  assert.ok(sources.size >= 60)
  assert.ok(relative(root, join(root, 'index.js')) === 'index.js')
})

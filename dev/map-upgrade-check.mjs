import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncPackagedMap } from '../lib/map-upgrade.js'

const OLD = `meta: {version: 3}
nodes:
  - {id: A, name: A, domain: 基础, depends: [], tier: core, entry: 1200, pool: 3}
  - {id: B, name: B, domain: 基础, depends: [A], tier: core, entry: 1300, pool: 0}
`
const NEW = `meta: {version: 3}
nodes:
  - {id: A, name: A, domain: 基础, depends: [], tier: core, entry: 1200, pool: 5}
  - {id: B, name: B, domain: 基础, depends: [A], tier: core, entry: 1300, pool: 0}
  - {id: C, name: C, domain: 图论, depends: [B], tier: normal, entry: 1500, pool: 4}
`
const hash = (text) => createHash('sha256').update(text).digest('hex')

function fixture({ local = OLD, packaged = NEW, legacy = [hash(OLD)] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coach-map-upgrade-'))
  const packagedPath = join(dir, 'packaged-MAP.yaml')
  writeFileSync(packagedPath, packaged)
  const dataDir = join(dir, 'knowledge')
  mkdirSync(dataDir, { recursive: true })
  if (local !== null) writeFileSync(join(dataDir, 'MAP.yaml'), local)
  // 账本：升级不许碰它们
  writeFileSync(join(dataDir, 'PROGRESS.yaml'), 'version: 1\ncursor: A\nnodes: {}\n')
  writeFileSync(join(dataDir, 'CURRICULUM.yaml'), 'version: 3\ngoal: 测试\n')
  const run = () => syncPackagedMap({ dataDir, packagedPath, legacyHashes: legacy,
    pluginVersion: '9.9.9', now: () => new Date('2026-10-26T12:00:00Z') })
  return { dir, dataDir, packagedPath, run, packaged: packaged }
}

test('a clean map shipped by an older version is upgraded and backed up', async () => {
  const f = fixture()
  const html = (p) => readFileSync(join(f.dataDir, p), 'utf8')
  const progressBefore = html('PROGRESS.yaml'), curriculumBefore = html('CURRICULUM.yaml')
  try {
    const result = f.run()
    assert.equal(result.action, 'upgraded')
    assert.equal(html('MAP.yaml'), NEW, '干净旧图应拿到随包新增的节点与题池')
    assert.equal(html('MAP.yaml.prev'), OLD, '旧图要留一份可回退的备份')
    assert.ok(existsSync(join(f.dataDir, '.map-shipped.json')), '要记下这次发的是哪一版')
    assert.equal(html('PROGRESS.yaml'), progressBefore)
    assert.equal(html('CURRICULUM.yaml'), curriculumBefore)
    assert.equal(existsSync(join(f.dataDir, 'MAP-upgrade-report.json')), false)

    // 下一版再来：manifest 记住了上次发的哈希，仍算干净
    writeFileSync(f.packagedPath, OLD)
    const next = syncPackagedMap({ dataDir: f.dataDir, packagedPath: f.packagedPath, legacyHashes: [],
      pluginVersion: '9.9.10', now: () => new Date('2026-10-27T12:00:00Z') })
    assert.equal(next.action, 'upgraded')
    assert.equal(html('MAP.yaml'), OLD)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('a Linux-published LF map matches a known Windows CRLF release', () => {
  const f = fixture({ legacy: [hash(OLD.replace(/\n/g, '\r\n'))] })
  try {
    const result = f.run()
    assert.equal(result.action, 'upgraded', 'npm on Linux keeps LF even when a Windows checkout used CRLF')
    assert.equal(readFileSync(join(f.dataDir, 'MAP.yaml'), 'utf8'), NEW)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('a user-edited map is never overwritten; the package diff is reported instead', async () => {
  const local = OLD.replace('  - {id: B', '  - {id: USER, name: 用户自己加的, domain: 本地, depends: []}\n  - {id: B')
  const f = fixture({ local })
  try {
    const result = f.run()
    assert.equal(result.action, 'conflict')
    assert.equal(readFileSync(join(f.dataDir, 'MAP.yaml'), 'utf8'), local, '改过的图一个字都不能动')
    assert.equal(existsSync(join(f.dataDir, 'MAP.yaml.prev')), false, '没覆盖就不该有备份')
    const report = JSON.parse(readFileSync(join(f.dataDir, 'MAP-upgrade-report.json'), 'utf8'))
    assert.deepEqual(report.addedNodes, ['C'])
    // 方向是「你的图 → 随包地图」：用户自己加的节点在随包里没有，
    // 报出来是对的（可能是包删的，也可能是他自己加的）。
    assert.deepEqual(report.removedNodes, ['USER'])
    const changedA = report.changed.find((item) => item.id === 'A')
    assert.deepEqual(changedA.fields.pool, { before: 3, after: 5 })
    assert.equal(report.reason.includes('未覆盖'), true)

    // 反复启动不刷屏：内容一样就不再重写
    const first = readFileSync(join(f.dataDir, 'MAP-upgrade-report.json'), 'utf8')
    const again = f.run()
    assert.equal(again.action, 'conflict')
    assert.equal(readFileSync(join(f.dataDir, 'MAP-upgrade-report.json'), 'utf8'), first)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('an up-to-date map records its hash and clears a stale report', async () => {
  const f = fixture({ local: NEW, legacy: [] })
  try {
    writeFileSync(join(f.dataDir, 'MAP-upgrade-report.json'), '{"stale":true}\n')
    const result = f.run()
    assert.equal(result.action, 'current')
    assert.equal(existsSync(join(f.dataDir, 'MAP-upgrade-report.json')), false, '合并完的旧报告要清掉')
    const manifest = JSON.parse(readFileSync(join(f.dataDir, '.map-shipped.json'), 'utf8'))
    assert.equal(manifest.shippedHash, hash(NEW))
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('a missing map is installed from the package without a report', async () => {
  const f = fixture({ local: null, legacy: [] })
  try {
    const result = f.run()
    assert.equal(result.action, 'installed')
    assert.equal(readFileSync(join(f.dataDir, 'MAP.yaml'), 'utf8'), NEW)
    assert.equal(existsSync(join(f.dataDir, 'MAP-upgrade-report.json')), false)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

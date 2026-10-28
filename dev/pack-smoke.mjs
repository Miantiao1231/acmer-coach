// 打包产物烟测：npm pack → 装进空目录 → import → apply。
//
// 源码目录里能跑，不等于发出去的包里能跑（漏 assets、exports 写错、
// 依赖只在 devDependencies 里）。发布前用安装副本跑一次，别让用户替你发现。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const shell = process.platform === 'win32'   // npm.cmd 在 Windows 上要经 shell 启动
const repo = process.cwd()
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const packed = JSON.parse(execFileSync(npm, ['pack', '--json'], { cwd: repo, encoding: 'utf8', shell }))
const tarball = join(repo, packed[0].filename)
const dir = mkdtempSync(join(tmpdir(), 'coach-pack-smoke-'))

try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'coach-smoke', private: true }))
  execFileSync(npm, ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
    tarball, `@deepseek-ai/dsh-tools@${pkg.devDependencies['@deepseek-ai/dsh-tools']}`],
  { cwd: dir, stdio: 'inherit', shell })

  process.env.COACH_DATA_DIR = join(dir, 'data')
  process.env.COACH_DB = join(dir, 'data', 'coach.db')
  const require = createRequire(join(dir, 'package.json'))
  const entry = require.resolve('acmer-coach')
  const mod = await import(pathToFileURL(entry).href)
  assert.equal(typeof mod.apply, 'function', '安装副本必须导出 apply')

  const tools = new Map()
  await mod.apply({
    tools: { register: (tool) => tools.set(tool.name, tool) },
    on() {}, get() {}, effect: (cb) => cb(), inject() {},
  })
  assert.ok(tools.size >= 30, `安装副本注册的工具太少：${tools.size}`)
  assert.ok(tools.has('coach_vp_sync') && tools.has('coach_curriculum'), '关键工具缺失')
  const catalog = await tools.get('coach_target').execute({ action: 'contests' })
  assert.equal(catalog.ok, true, catalog.reject)
  assert.equal(catalog.availableContests.length, 56)
  assert.equal(catalog.contestSummary.scoredRegionals, 38)
  console.log(`✓ 安装副本可用：${tools.size} 个工具，版本 ${pkg.version}`)
} finally {
  rmSync(tarball, { force: true })
  rmSync(dir, { recursive: true, force: true })
}

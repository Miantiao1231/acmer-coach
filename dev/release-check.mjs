// 发布门禁：把主验收和三个 legacy 检查接进 `npm test`。
//
// CI 的 workflow 只跑 npm test，因此不需要改 .github/workflows；本地 `npm test`
// 也会得到同一套机器门禁。verify.mjs 在 CI 模式直接验源码（安装副本另由
// pack-smoke 验），legacy 检查各自用子进程跑，失败会汇总成非零退出码。
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 发布门禁不连真实记忆/后台模型；与 dev.sh 的环境隔离保持一致。
const isolated = { COACH_HINDSIGHT: '0', COACH_BACKGROUND_LLM: '0', TZ: 'Asia/Shanghai' }
const checks = [
  { name: 'verify', args: ['verify.mjs'], env: { CI: '1' } },
  { name: 'w1-check', args: ['dev/w1-check.mjs'] },
  { name: 'setup-check', args: ['dev/setup-check.mjs'] },
  { name: 'wiki-check', args: ['dev/wiki-check.mjs'] },
  { name: 'page-syntax', args: ['coach/check_page_syntax.mjs', 'coach/skilltree_template.html'] },
]

let failed = 0
for (const check of checks) {
  console.log(`\n── release check: ${check.name} ──`)
  const result = spawnSync(process.execPath, check.args, {
    cwd: root, stdio: 'inherit', env: { ...process.env, ...isolated, ...check.env },
  })
  if (result.error) {
    console.error(`✗ ${check.name}: ${result.error.message}`)
    failed += 1
  } else if (result.status !== 0) {
    console.error(`✗ ${check.name}: exit ${result.status}`)
    failed += 1
  }
}
if (failed) {
  console.error(`\n✗ 发布门禁有 ${failed} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n✓ 发布门禁全绿')
}

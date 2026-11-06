// 全套测试入口：node dev/run-tests.mjs
// 用子进程跑 `node --import dev/test-env.mjs --test ...`，隔离预加载照旧。
// 必须走子进程：legacy 自检会 process.exit，不能塞进同一个测试进程。
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TEST_FILES } from './test-files.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const child = spawn(process.execPath, [
  // Windows 上 --import 不接受裸绝对路径（会被当成 c: 协议），必须转 file:// URL。
  '--import', pathToFileURL(join(here, 'test-env.mjs')).href,
  '--test', ...TEST_FILES.map(file => join(root, file)),
], { cwd: root, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))

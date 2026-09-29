// 语法级体检：把 skilltree.html 里的内联 script 抽出来过一遍 V8 解析。
//
// 为什么要它：改模板（CYCLE 数组、键盘映射、图例文字）时最容易的坏法是
// 把某处语句写坏 —— 那样的页面**照样 HTTP 200**，打开来是一片空白，
// 而 curl 看不出来。这里只做**解析**，不执行（不碰 DOM）。
//
// 用法: node check_page_syntax.mjs [要检查的 html]
//   不给参数就检查**模板本身**（coach/skilltree_template.html）。
//   要检查渲染产物就传路径，或用 COACH_DATA_DIR 指到数据目录。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = process.argv[2]
  || join(process.env.COACH_DATA_DIR || join(homedir(), '.dsh', 'knowledge'), 'skilltree.html')
const html = readFileSync(FILE, 'utf8')
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).filter((c) => c.trim())

console.log(`skilltree.html：${html.length} 字符，内联 script 块 ${blocks.length} 个`)
let bad = 0
blocks.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `inline-${i}.js` })
    console.log(`  块 ${i}: 语法 OK（${code.length} 字符）`)
  } catch (e) {
    bad++
    console.log(`  块 ${i}: ✗ ${e.message}`)
  }
})

// 顺带把这次改动关心的三件事也钉一下（不执行页面，只查文本）
const asserts = [
  ['CYCLE 只有三档', /const CYCLE = \["none", "studying", "learned"\]/.test(html)],
  ['键盘映射是 123', /"123"\.indexOf\(e\.key\)/.test(html)],
  ['没有残留的 "1234"', !html.includes('"1234"')],
  ['图例不再说「→ 已验证」循环', !html.includes('未学 → 在学 → 学过 → 已验证')],
  ['verified 仍留在显示用的 LABEL / COLOR 里', html.includes('verified: "已验证"')],
]
console.log('')
for (const [label, ok] of asserts) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) bad++
}
process.exit(bad ? 1 : 0)

// W5 验收：OI Wiki 本地检索。
//
// 用**教练真实会发的查询**验，不是编几个能过的：
//   · 节点名（地图上的）        → 应该走精确表，第一条就得对
//   · 分类节点（网络流这种）    → 应该落到子树里的页面
//   · 自由文本 / 口语化提问     → 应该靠正文匹配兜住
//   · 压根不存在的              → 应该**如实说找不到**，不是硬凑一个
//
// 跑法：node dev/wiki-check.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

// 这个工具不碰数据目录，但插件加载时要有个能读的地图（其它工具用）
const tmp = mkdtempSync(join(tmpdir(), 'wiki-'))
writeFileSync(join(tmp, 'MAP.yaml'), 'meta: {version: 3}\nnodes:\n  - id: A\n    name: A\n    domain: 测试\n    depends: []\n    tier: normal\n')
writeFileSync(join(tmp, 'DEPENDS.yaml'), 'meta: {version: 1}\nrequires:\n  A: []\n')
writeFileSync(join(tmp, 'skilltree.html'), '<html></html>')
process.env.COACH_DATA_DIR = tmp

const mod = await import('../index.js?wiki=1')
const registered = []
mod.apply({ tools: { register: (t) => registered.push(t) }, inject: () => {}, on: () => {} })
const wiki = registered.find((t) => t.name === 'coach_wiki')
check('注册了 coach_wiki', Boolean(wiki))

const call = (a) => wiki.execute(a, undefined)

// ── 1. 节点精确表 ─────────────────────────────────────────────────
console.log('\n── 1. 节点 → 页面（精确表）──')
for (const [node, want] of [
  ['线段树', 'ds/seg.md'],
  ['区间 DP', 'dp/interval.md'],
  ['插头 DP', 'dp/plug.md'],
  ['复杂度', 'basic/complexity.md'],
]) {
  const r = await call({ action: 'node', node })
  const top = r.pages[0]?.src
  check(`${node} → ${want}`, top === want, top ?? r.note)
}

console.log('\n── 2. 分类节点（自己没有页面，落在子树里）──')
{
  const r = await call({ action: 'node', node: '网络流' })
  const srcs = r.pages.map((p) => p.src)
  check('网络流 命中多个页面', srcs.length >= 3, `${srcs.length} 个`)
  check('含最大流', srcs.some((s) => s.includes('max-flow')), srcs.slice(0, 3).join(' '))
}
{
  const r = await call({ action: 'node', node: '莫队算法' })
  check('莫队算法 落在子树页面（第四层也能收到）',
    r.pages.some((p) => p.src.includes('mo-algo')), r.pages[0]?.src ?? r.note)
}

console.log('\n── 3. 自由文本 / 口语化 ──')
for (const [q, wantSub] of [
  ['Dijkstra', 'graph/'],
  ['四边形不等式', 'dp/'],
  ['字符串', 'string/'],
]) {
  const r = await call({ action: 'search', query: q, topK: 5 })
  const ok = r.pages.some((p) => p.src.includes(wantSub))
  check(`搜「${q}」命中 ${wantSub}`, ok, r.pages.map((p) => p.src).slice(0, 3).join(' ') || r.note)
}

console.log('\n── 4. 读整页 ──')
{
  const r = await call({ action: 'page', src: 'ds/seg.md' })
  check('读到 ds/seg.md', r.ok && r.text.length > 500, `${r.text.length} 字符`)
  check('正文是中文', /[一-龥]/.test(r.text))
  const bad = await call({ action: 'page', src: '不存在/的页面.md' })
  check('不存在的路径 → 如实报错，不是空字符串', !bad.ok && bad.note.length > 0, bad.note)
}

console.log('\n── 5. 查不到时必须说实话（不许硬凑）──')
{
  const r = await call({ action: 'search', query: 'zzz不存在的知识点qqq', topK: 5 })
  check('无关查询 → 0 结果', r.pages.length === 0, `${r.pages.length} 个`)
  check('并且给出「照实说」的提示', r.note.includes('不确定'), r.note)
}

console.log('\n── 6. 输出形状合规（dsh 严格校验）──')
{
  const r = await call({ action: 'search', query: '线段树', topK: 3 })
  const shape = ['ok', 'note', 'pages', 'text', 'truncated', 'available']
  check('顶层键齐全', shape.every((k) => k in r), Object.keys(r).join(','))
  check('pages 每项四字段', r.pages.every((p) =>
    typeof p.src === 'string' && typeof p.title === 'string' &&
    typeof p.via === 'string' && typeof p.excerpt === 'string'))
  check('render 不抛', Array.isArray(wiki.output.render({}, r)))
}

console.log(`\n${fail === 0 ? '✓ 全绿' : '✗ 有失败'} — ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

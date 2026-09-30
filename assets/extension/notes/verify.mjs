// 验收：把插件跑起来，看工具干得对不对。
//
// 为什么不信「boot 一下没崩」：boot 只能告诉你没炸，不能告诉你工具在、算得对。
// 而「模块加载失败 / 导出形状错 / id 对不上 / 工具静默不注册」这四种坏法里，
// 后三种在 boot 日志里**都是静默的**。直接调 apply() 才当场看得见。
//
// 全部跑在**自造的 fixture** 上：临时知识库（迷你地图 + 进度）+ 临时 vault。
// 不需要你配任何东西，跑完自动清理。
// 唯一会碰真实环境的地方是第 8 节的条件式只读性检查（配了才查，没配就跳过）。
//
// 用法：node verify.mjs
//   NOTES_INSTALLED=<已安装副本目录>  可选 —— 额外核对源码与副本一致（file: 硬链接会静默分家）
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))

// 覆盖 env 之前先把真实环境记下来（第 8 节的条件式指纹检查要用）
const ORIG_DATA = process.env.COACH_DATA_DIR || process.env.DSH_KNOWLEDGE_DIR || ''
const ORIG_VAULT = process.env.OBSIDIAN_VAULT || ''

// ── 0. 源码 vs 已安装副本（可选关）────────────────────────────────
console.log('── 0. 源码 vs 已安装副本 ──')
let target = `file:///${SRC.replace(/\\/g, '/')}/index.js`
const INSTALLED = process.env.NOTES_INSTALLED || ''
if (INSTALLED && existsSync(join(INSTALLED, 'index.js'))) {
  // ⚠️ file: 依赖装出来的是硬链接；改名式写入（Edit 工具 / 编辑器原子保存）会断开链接，
  //    两边分家，而 dsh plugin add 认不出分家、不重链也不报错 —— 静默测了老代码。
  const a = readFileSync(join(SRC, 'index.js'), 'utf8')
  const b = readFileSync(join(INSTALLED, 'index.js'), 'utf8')
  console.log(`  已安装副本：${INSTALLED}`)
  console.log(`${a === b ? '  OK  ' : '  FAIL'} 源码与副本一致${a === b ? '' : '  → 副本是旧的，先重装/重链'}`)
  if (a !== b) process.exit(1)
  target = `file:///${INSTALLED.replace(/\\/g, '/')}/index.js`
} else {
  console.log('  （没设 NOTES_INSTALLED，直接测源码）')
}

// ── 1. 造 fixture ──────────────────────────────────────────────────
console.log('\n── 1. fixture（迷你地图 + 迷你 vault）──')
const TMP = join(tmpdir(), `whale-notes-verify-${Date.now()}`)
mkdirSync(TMP, { recursive: true })

// 迷你地图：只造测试用得到的节点，带一条前置链和一组兄弟节点
writeFileSync(join(TMP, 'MAP.yaml'), `
nodes:
  - id: 动态规划基础
    depends: []
  - id: 区间 DP
    depends: [动态规划基础]
  - id: 区间 DP 优化
    depends: [区间 DP]
  - id: 图的基本概念
    depends: []
  - id: 最短路
    depends: [图的基本概念]
  - id: 并查集
    depends: []
  - id: 最小生成树
    depends: [并查集]
  - id: 网络流
    depends: [图的基本概念]
  - id: 2-SAT
    depends: [图的基本概念]
`)
writeFileSync(join(TMP, 'PROGRESS.yaml'), `
version: 1
cursor: 区间 DP
nodes:
  动态规划基础:
    status: learned
    at: 2026-01-01
`)

// 迷你 vault
const VAULT = join(TMP, 'vault')
const NOTES = {
  '五、DP/5.区间dp.md': '# 区间 DP\n\n区间 DP 的笔记正文，讲怎么枚举断点。\n',
  '四、图论/3. Dijkstra  单源最短路.md': '# Dijkstra\n\n单源最短路，堆优化。\n',
  '四、图论/4. Floyd 最短路.md': '# Floyd\n\n多源最短路。\n',
  '四、图论/5. Bellman-Ford 最短路.md': '# Bellman-Ford\n\n带负权的最短路。\n',
  '四、图论/12. Tarjan SCC.md': '# Tarjan SCC\n\n强连通分量。\n',
  '四、图论/13. Tarjan 割点.md': '# Tarjan 割点\n',
  '四、图论/14. Tarjan 缩点.md': '# Tarjan 缩点\n',
  '四、图论/7. Kruskal 最小生成树.md': '# Kruskal\n\n排序边 + 并查集。\n',
  '一、数据结构/3. 并查集.md': '# 并查集\n\n路径压缩。\n',
  '一、数据结构/2. 图.md': '# 图\n\n邻接矩阵、边集数组。\n',
  '一、数据结构/1. STL/容器/顺序容器/1.vector.md': '# vector\n',
  '筛法求欧拉函数.md': '# 筛法\n\n埃氏筛、线性筛。\n',
  '大文件.md': '# 大文件\n' + 'x'.repeat(25000),
}
for (const [rel, body] of Object.entries(NOTES)) {
  const p = join(VAULT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

// ⚠️ env 必须在 **import 之前** 设好 —— index.js 的知识库路径是加载时读的。
process.env.COACH_DATA_DIR = TMP
process.env.OBSIDIAN_VAULT = VAULT
console.log(`  OK   fixture 在 ${TMP}（NOTE_MAP.yaml 不造 = 从空账本开始）`)

const mod = await import(target)
const fails = []
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${label}${extra ? '  → ' + extra : ''}`)
  if (!cond) fails.push(label)
}

// ── 2. 导出形状 ────────────────────────────────────────────────────
console.log('\n── 2. 导出形状 ──')
check('导出 name/inject/apply', mod.name === 'whale-notes' && Array.isArray(mod.inject) && typeof mod.apply === 'function',
  `name=${mod.name} inject=${JSON.stringify(mod.inject)}`)
check('name 与包名一致', JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).name === mod.name)

// ── 3. 挂工具 ──────────────────────────────────────────────────────
const registered = new Map()
mod.apply({ tools: { register: (t) => registered.set(t.name, t) } })
console.log('\n── 3. 注册的工具 ──')
check('注册了 3 个工具', registered.size === 3, [...registered.keys()].join(', '))
for (const t of ['note_context', 'note_map_status', 'note_map_set']) check(`有 ${t}`, registered.has(t))

const call = (n, args) => registered.get(n).execute(args ?? {}, undefined)

// ── 4. 归一化（这是整个插件的地基，错一个字全盘皆输）────────────────
console.log('\n── 4. 名字归一化 ──')
const norm = (s) => s.replace(/^(\d+(\.\d+)*\s*[.、]\s*|\d+\s+)/, '').replace(/\.md$/i, '')
  .replace(/[\s　]+/g, '').replace(/[（(][^）)]*[）)]/g, '').toLowerCase()
const cases = [
  ['5.区间dp.md', '区间dp'], ['6 矩阵快速幂.md', '矩阵快速幂'], ['1.1.set.md', 'set'],
  ['12. Tarjan SCC.md', 'tarjanscc'], ['区间 DP', '区间dp'], ['字典树 (Trie)', '字典树'],
]
let normBad = 0
for (const [inp, want] of cases) {
  const got = norm(inp)
  if (got !== want) { normBad++; console.log(`  FAIL ${JSON.stringify(inp)} → ${JSON.stringify(got)}，想要 ${JSON.stringify(want)}`) }
}
check('笔记名/节点名归一化', normBad === 0, normBad ? `${normBad} 条错` : '6 条全对')
// ⚠️ 这条最阴：2-SAT 剥序号会变成 -SAT，然后**永远匹配不上且静默**
check('2-SAT 不被剥成 -SAT', norm('2-SAT') === '2-sat', `得到 ${JSON.stringify(norm('2-SAT'))}`)

// ── 5. note_context：核心工具 ──────────────────────────────────────
console.log('\n── 5. note_context ──')
const r1 = await call('note_context', { query: '区间 DP' })
check('按节点名查：找得到', r1.found === true)
check('  命中节点正确', r1.nodes.includes('区间 DP'), r1.nodes.join(','))
check('  前置正确', JSON.stringify(r1.requires) === JSON.stringify(['动态规划基础']), r1.requires.join(','))
check('  后继非空（反查成功）', r1.dependents.length > 0, r1.dependents.join(','))
check('  找到笔记正文', (r1.content ?? '').includes('区间'), `${(r1.content ?? '').length} 字符`)
// 区间 DP 不在 PROGRESS.yaml 里 → 未学 → 不返回 progress 字段。这是**对的行为**：
// 「不写 = 没碰过」，工具不该凭空编一个状态出来。
check('  未学的不编状态', r1.progress === undefined, r1.progress ?? '（正确地没给）')

// 换一个**确实有状态**的节点，验状态真的被带出来了
const r1b = await call('note_context', { query: '动态规划基础' })
check('有状态的节点带回 state', (r1b.progress ?? '').includes('learned'), r1b.progress ?? '（没带出来）')

const r2 = await call('note_context', { query: 'Dijkstra  单源最短路' })
check('按笔记名查（图上没有 Dijkstra 这个节点）', r2.found === true && r2.noteExists === true, r2.notePaths?.[0] ?? '')
check('  未登记时标记 mapped=false', r2.mapped === false, `mapped=${r2.mapped}`)

const r3 = await call('note_context', { query: '五、DP/5.区间dp.md' })
check('按路径查', r3.found === true && r3.notePaths[0] === '五、DP/5.区间dp.md', r3.notePaths.join(','))

// ── 子串搜文件名 ───────────────────────────────────────────────────
// 人嘴里蹦的是「Dinic」「Tarjan」这种**关键词**，不是完整文件名。
// 只撞完整名 → 在最常用的问法上哑火。
console.log('\n── 5b. 关键词子串搜笔记名 ──')
const k1 = await call('note_context', { query: 'Dijkstra' })
check('★ 查「Dijkstra」能命中（关键词不是完整名）', k1.found === true && k1.notePaths.includes('四、图论/3. Dijkstra  单源最短路.md'),
  k1.notePaths.join(' / ') || '（找不到）')

const k2 = await call('note_context', { query: 'Tarjan' })
check('  查「Tarjan」命中多篇', k2.notePaths.length === 3, `${k2.notePaths.length} 篇：${k2.notePaths.join(' / ')}`)

const k3 = await call('note_context', { query: '最短路' })
check('  查「最短路」子串命中三篇最短路笔记', k3.notePaths.length === 3, k3.notePaths.join(' / '))

// 单字会命中一大片 → 门槛挡掉，不许炸出一屏。
// ⚠️ 样例字得挑**只作为子串存在**的：「法」只出现在 `筛法求欧拉函数.md` 这类名字内部。
const k4 = await call('note_context', { query: '法' })
check('  单字不做子串扫描（防炸屏）', k4.notePaths.length === 0, `命中 ${k4.notePaths.length} 篇`)
// 反证：同一个字如果是**完整**笔记名，就该走精确命中拿到
const k4b = await call('note_context', { query: '图' })
check('  但单字若是完整笔记名，精确命中照给', k4b.notePaths.includes('一、数据结构/2. 图.md'), k4b.notePaths.join(' / '))

// 精确匹配优先于子串：查「并查集」不该被子串结果淹没
const k5 = await call('note_context', { query: '并查集' })
check('  精确命中优先于子串', k5.notePaths.includes('一、数据结构/3. 并查集.md') && k5.notePaths[0] === '一、数据结构/3. 并查集.md',
  k5.notePaths.join(' / '))

const r4 = await call('note_context', { query: '这不存在的知识点xyz' })
check('查不存在的：found=false 且给理由', r4.found === false && (r4.reason ?? '').length > 10)

const r5 = await call('note_context', { query: '大文件' })
check('大文件被截断', r5.truncated === true && r5.content.length <= 20000, `${r5.content?.length} 字符`)

// ── 6. note_map_set：登记 + 校验 ───────────────────────────────────
console.log('\n── 6. note_map_set ──')
const s1 = await call('note_map_set', { note: '四、图论/3. Dijkstra  单源最短路.md', nodes: ['最短路'] })
check('登记一个真实节点', s1.ok === true, JSON.stringify(s1.nodes))

const s2 = await call('note_map_set', { note: '四、图论/3. Dijkstra  单源最短路.md', nodes: ['Dijkstra'] })
check('⚠️ 登记图上不存在的节点 → 必须拒绝', s2.ok === false && (s2.error ?? '').includes('不存在'))
// '网络流算法' 不存在，但 '网络流' 是它的子串 → 必须给出这个候选
const s2b = await call('note_map_set', { note: '四、图论/3. Dijkstra  单源最短路.md', nodes: ['网络流算法'] })
check('  拒绝理由里给相近的候选', (s2b.error ?? '').includes('网络流') && s2b.error.includes('不存在'),
  s2b.error?.split('\n')[1] ?? '（没给候选）')
// Dijkstra → 最短路 这种**翻译式**的名字差，子串匹配救不了 —— 明说，别让人以为工具坏了
const s2c = await call('note_map_set', { note: '四、图论/3. Dijkstra  单源最短路.md', nodes: ['Dijkstra'] })
check('  译文式名字差时说明缘故', (s2c.error ?? '').includes('颗粒度'), '点破了「你的分法和图不一样」')

const s3 = await call('note_map_set', { note: '四、图论/9. 不存在的笔记.md', nodes: ['最短路'] })
check('登记不存在的笔记 → 拒绝', s3.ok === false)

const s4 = await call('note_map_set', { note: '四、图论/7. Kruskal 最小生成树.md', nodes: ['最小生成树', '并查集'] })
check('一篇登记多个节点（多对多）', s4.ok === true && s4.nodes.length === 2, s4.nodes.join(','))

// 登记后再查，mapped 必须变 true —— 证明写入真的生效了
const r6 = await call('note_context', { query: 'Dijkstra  单源最短路' })
check('登记后 mapped 变 true', r6.mapped === true && r6.nodes.includes('最短路'), `mapped=${r6.mapped} nodes=${r6.nodes}`)
// ⚠️ 这条是**主 bug 的回归**：反向查（节点 → 笔记）曾经根本没实现，
//    后果是问「讲讲最短路」，工具报「你还没写过笔记」——空答案冒充结论。
const r7 = await call('note_context', { query: '最短路' })
check('★ 从节点反查回登记的那篇', r7.notePaths.includes('四、图论/3. Dijkstra  单源最短路.md'),
  r7.notePaths.join(' / ') || '（没查回）')
check('  反查也要挂上图节点', r7.nodes.includes('最短路'), r7.nodes.join(','))

// ⚠️ 这条是**第二个真 bug**：「并查集」既是笔记名又是节点名。
//    正向命中 一、数据结构/3.并查集.md 之后就收手 → 漏掉 Kruskal 那篇（也讲了并查集）。
//    正解是**并集**：两篇都要给。答案不全是最难发现的那种错。
const r8 = await call('note_context', { query: '并查集' })
check('★ 同名节点+笔记时给并集（两篇都要）',
  r8.notePaths.includes('一、数据结构/3. 并查集.md') && r8.notePaths.includes('四、图论/7. Kruskal 最小生成树.md'),
  r8.notePaths.join(' / ') || '（没查回）')

// 指名道姓给路径时不许并 —— 要的就是那**一篇**
const r8b = await call('note_context', { query: '四、图论/7. Kruskal 最小生成树.md' })
check('  显式路径时不强塞别的笔记', r8b.notePaths.length === 1 && r8b.content !== undefined,
  r8b.notePaths.join(' / '))

// 没登记的节点 → 走「把节点名当笔记名」的兜底（区间 DP → 5.区间dp.md）
const r9 = await call('note_context', { query: '区间 DP' })
check('  兜底：节点名当代笔记名', r9.notePaths.includes('五、DP/5.区间dp.md'), r9.notePaths.join(' / '))

// ── 7. note_map_status ─────────────────────────────────────────────
console.log('\n── 7. note_map_status ──')
const st = await call('note_map_status')
check('统计到登记数', st.mappedNotes === 2, `mappedNotes=${st.mappedNotes}`)
// ⚠️ 断言写成**不变量**，不写绝对值 —— 绝对数会随测试数据变，不变量不会。
check('已登记 + 未登记 == 总数（不变量）', st.mappedNotes + st.unmapped.length === st.totalNotes,
  `${st.mappedNotes} + ${st.unmapped.length} vs ${st.totalNotes}`)
check('列出未登记的', st.unmapped.length > 0, `${st.unmapped.length} 条`)
check('图上有节点没笔记（正常）', st.nodesWithoutNote > 0, `nodesWithoutNote=${st.nodesWithoutNote}`)

// ── 7b. 「登记」≠「挂上」──────────────────────────────────────────
//
// 事故形状：账本里一批是空映射（登记入册、节点是 []）。
// 工具若报「N / N 篇已挂上图」—— 把空映射的口子用一句「全挂上了」盖住，
// 而那批**永远不会被 note_context 命中**：讲某知识点前查笔记，永远想不起来去查它们。
//
// 判据两条：① 输出里「挂上」的数**不许**把空映射算进来，且两个数都要出现；
//          ② 得说得出是哪几篇留空、为什么。
console.log('\n── 7b. 登记 ≠ 挂上 ──')
// 直接写副本账本：note_map_set 不收空 nodes（那是对的 —— 登记就该有目标），
// 但历史遗留的空映射工具必须如实报出来，所以夹具得手写。
writeFileSync(join(TMP, 'NOTE_MAP.yaml'), [
  'version: 1',
  "updated: '2026-01-01'",
  'map:',
  "  '五、DP/5.区间dp.md':",
  '    - 区间 DP',
  "  '一、数据结构/1. STL/容器/顺序容器/1.vector.md': []",
  '',
].join('\n'))
const st2 = await call('note_map_status')
const txt2 = registered.get('note_map_status').output.render({}, st2)[0].text
check('登记数语义不变', st2.mappedNotes === 2, `mappedNotes=${st2.mappedNotes}`)
check('★ 挂上了节点的只有 1 篇', st2.attachedNotes === 1, `attachedNotes=${st2.attachedNotes}`)
check('★ 留空的报成 1 篇', st2.blankNotes === 1, `blankNotes=${st2.blankNotes}`)
check('★ 登记 = 挂上 + 留空（不变量）',
  st2.mappedNotes === st2.attachedNotes + st2.blankNotes,
  `${st2.mappedNotes} vs ${st2.attachedNotes}+${st2.blankNotes}`)
check('★ 留空的是哪一篇要说得出（至少前 5 条）',
  (st2.blankExamples ?? []).some((s) => s.includes('1.vector.md')),
  (st2.blankExamples ?? []).join(' / ') || '（一条都没给）')
check('★ 渲染里两个数都出现', txt2.includes('挂上 1') && txt2.includes('留空 1'),
  txt2.split('\n')[0])

// ── 8. 没有副作用 ──────────────────────────────────────────────────
//
// fixture 全程跑在 TMP 里，理论上碰不到真实数据；但**万一有哪条路径忘了走 env、
// 落了默认真实路径**，这一节就能抓到 —— 这是回归保险，别删。
// 配了真实环境（COACH_DATA_DIR / OBSIDIAN_VAULT 或默认 ~/.dsh/knowledge）才查，没配就跳过。
console.log('\n── 8. 没有副作用（条件式指纹比对）──')
const REAL_KNOWLEDGE = ORIG_DATA || join(homedir(), '.dsh', 'knowledge')
const realMap = join(REAL_KNOWLEDGE, 'NOTE_MAP.yaml')
let sampleNote = ''
if (ORIG_VAULT && existsSync(ORIG_VAULT)) {
  const md = []
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith('.')) continue
      const p = join(d, e)
      try { statSync(p).isDirectory() ? walk(p) : (e.endsWith('.md') && md.push(p)) } catch {}
    }
  }
  try { walk(ORIG_VAULT); sampleNote = md[0] ?? '' } catch {}
}
if (existsSync(realMap) || sampleNote) {
  const fingerprint = () => [
    existsSync(realMap) ? readFileSync(realMap, 'utf8') : '<真账本不存在>',
    sampleNote ? readFileSync(sampleNote, 'utf8') : '<无样本>',
  ].join('\u0000')
  // ⚠️ 指纹**跑之前**拍 —— 这一节全部意义就是「真数据一个字不动」，
  //    写成自比（文件 === 文件自己）就永远为真，绿着却什么都没验。
  const before = fingerprint()
  await call('note_context', { query: '任意查询', full: true })
  await call('note_map_status')
  check('真账本 + 真笔记原文 一字未动', fingerprint() === before,
    `${existsSync(realMap) ? `真账本 ${readFileSync(realMap, 'utf8').length} 字符` : '真账本不存在'}｜样本 ${sampleNote || '无'}`)
} else {
  console.log('  SKIP  没有真实环境可查（真账本、真实 OBSIDIAN_VAULT 都不存在）—— fixture 全程在 tmp，本就不会碰真数据')
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${fails.length ? `❌ ${fails.length} 项没过：\n   ${fails.join('\n   ')}` : '✅ 全过'}`)
process.exit(fails.length ? 1 : 0)

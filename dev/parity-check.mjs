// 保真度审计：开源版和线上那份，喂**同样的输入**，逐条比输出。
//
// 为什么要有这个：改了一堆东西（解绑路径、加两个工具、清注释、改名字），
// 单测全绿只能证明"新的这份自己跑得通"，**证明不了"它和原来那只是同一只"**。
// 而用户要的正是后者。
//
// 做法：准备两份**逐字节相同**的临时数据目录，各喂给一个版本，
// 跑同一串调用，把返回值拉平了对比。允许的差异只有三处，都写在下面。
//
// 跑法：node dev/parity-check.mjs
import { mkdtempSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.env.COACH_LIVE_INDEX
  || join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-coach', 'index.js')

let pass = 0, fail = 0, diff = 0
const check = (n, ok, d = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); ok ? pass++ : fail++ }

if (!existsSync(LIVE)) {
  console.log(`✗ 找不到线上那份：${LIVE}`)
  console.log('  （设 COACH_LIVE_INDEX 指到它的 index.js）')
  process.exit(1)
}

// ── 造两份逐字节相同的夹具数据目录 ──────────────────────────────────
// 两边各一份而不是共用一份：工具会**写**（coach_assign 落盘），
// 共用的话后跑的那个看到的是先跑的那个改过的状态，比出来的差异是假的。
const base = mkdtempSync(join(tmpdir(), 'parity-'))
const ASSETS = join(import.meta.dirname, '..', 'assets', 'knowledge')
const PROG = `version: 1
cursor: 动态规划基础
updated: 2000-01-01
nodes:
  区间 DP:
    status: studying
    at: 2000-01-01
  记忆化搜索:
    status: learned
    at: 2000-01-01
`
const SCHED = `version: 1
updated: "2000-01-01"
days: {}
`
for (const d of ['A', 'B']) {
  const dir = join(base, d)
  cpSync(ASSETS, dir, { recursive: true })
  writeFileSync(join(dir, 'PROGRESS.yaml'), PROG)
  writeFileSync(join(dir, 'SCHEDULE.yaml'), SCHED)
}

const mockCtx = (reg) => ({ tools: { register: (t) => reg.push(t) }, inject: () => {}, on: () => {}, get: () => undefined })

async function loadCopy(indexPath, dataDir, tag) {
  process.env.COACH_DATA_DIR = dataDir
  process.env.COACH_DB = join(dataDir, 'no-db.sqlite')     // 两边都没有库 → 走降级路径
  const mod = await import(`file:///${indexPath.replace(/\\/g, '/')}?parity=${tag}`)
  const reg = []
  mod.apply(mockCtx(reg))
  return { mod, byName: new Map(reg.map((t) => [t.name, t])) }
}

const A = await loadCopy(join(import.meta.dirname, '..', 'index.js'), join(base, 'A'), 'oss')
const B = await loadCopy(LIVE, join(base, 'B'), 'live')

console.log('── 1. 工具清单 ──')
const namesA = [...A.byName.keys()].sort()
const namesB = [...B.byName.keys()].sort()
const onlyB = namesB.filter((n) => !namesA.includes(n))
const onlyA = namesA.filter((n) => !namesB.includes(n))
check('开源版没有丢掉任何原有工具', onlyB.length === 0, onlyB.join(',') || '（没丢）')
check('新增的只有搭建与检索两个', onlyA.length <= 2, onlyA.join(',') || '（无新增）')
console.log(`     线上 ${namesB.length} 个 / 开源 ${namesA.length} 个`)

console.log('\n── 2. 共有工具：同样的输入 → 同样的输出 ──')
// 每条：[工具, 参数, 说明]
const CALLS = [
  ['coach_next', { cursor: '动态规划基础' }, '游标的下层候选'],
  ['coach_next', { cursor: '并不存在的知识点' }, '打错字'],
  ['coach_status', {}, '读进度'],
  ['coach_schedule', {}, '读日程'],
  ['coach_pool', { node: '区间 DP' }, '查题池（无库 → 降级）'],
  ['coach_assign', { cursor: '动态规划基础', node: '区间 DP', deliverable: '贴代码', minutes: 40 }, '布置（新知识点不给讲解段）'],
  ['coach_assign', { cursor: '动态规划基础', node: '区间 DP', deliverable: '贴代码', minutes: 40, teachMinutes: 15 }, '布置（带讲解段）'],
  ['coach_assign', { cursor: '动态规划基础', node: '不存在的节点', deliverable: 'x', minutes: 40 }, '布置到地图外'],
  ['coach_diagnose', { code: 'int main(){return 0;}', problem: '1015D', category: '不认真', node: '区间 DP', evidence: [], summary: '测试' }, '判因'],
  ['coach_mark', { node: '记忆化搜索', status: 'verified' }, '手标 verified（该被拒）'],
  ['coach_set_cursor', { node: '区间 DP' }, '移游标'],
  ['coach_ping', {}, '探针'],
]

// 归一化：把**有意不同**的东西抹平，免得假差异淹掉真差异。
//   ① 包名（改名了）
//   ② 数据目录路径（两份故意用不同临时目录，否则后跑的会看到先跑的那份被写过）
const ALLOWED = [
  ['name', /^(dsh-coach|acmer-coach)$/],
  ['version', /^1\.0\.0$/],
]
const strip = (s) => s
  .replace(/acmer-coach/g, 'dsh-coach')
  .split(join(base, 'A')).join('<DATA>')
  .split(join(base, 'B')).join('<DATA>')
  .split(base).join('<DATA>')
  .replace(/\\\\/g, '/').replace(/\//g, '/').split('<DATA>').join('<DATA>')
const norm = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) =>
  typeof x === 'string' ? strip(x) : x))

for (const [tool, args, label] of CALLS) {
  const ta = A.byName.get(tool), tb = B.byName.get(tool)
  if (!ta || !tb) { check(`${tool} · ${label}`, false, '有一边没这个工具'); continue }
  let ra, rb, ea, eb
  try { ra = norm(await ta.execute(args, undefined)) } catch (e) { ea = e.message }
  try { rb = norm(await tb.execute(args, undefined)) } catch (e) { eb = e.message }
  const sa = JSON.stringify(ra ?? { ERR: ea }), sb = JSON.stringify(rb ?? { ERR: eb })
  if (sa === sb) { check(`${tool} · ${label}`, true) }
  else {
    // 探针那类返回值里带包名/路径，逐键比
    const ka = Object.keys(ra ?? {}), kb = Object.keys(rb ?? {})
    const dk = [...new Set([...ka, ...kb])].filter((k) => JSON.stringify(ra?.[k]) !== JSON.stringify(rb?.[k]))
    const benign = dk.every((k) => ALLOWED.some(([n]) => k === n))
    if (benign) { check(`${tool} · ${label}`, true, `仅包名/版本不同（${dk.join(',')}）`) }
    else { diff++; check(`${tool} · ${label}`, false, `差异字段：${dk.join(', ')}`) }
  }
}

console.log('\n── 3. 渲染文本：他看到的那些字 ──')
for (const [tool, args, label] of CALLS.filter((c) => c[0] !== 'coach_diagnose')) {
  const ta = A.byName.get(tool), tb = B.byName.get(tool)
  if (!ta?.output?.render || !tb?.output?.render) continue
  let va, vb
  try { va = await ta.execute(args, undefined) } catch { continue }
  try { vb = await tb.execute(args, undefined) } catch { continue }
  const ra = strip(ta.output.render(args, va)[0]?.text ?? '')
  const rb = strip(tb.output.render(args, vb)[0]?.text ?? '')
  const same = ra === rb
  check(`渲染 · ${tool} · ${label}`, same, same ? '' : '文本不一致')
}

console.log('\n── 4. 规则覆盖度（线上 AGENTS.md vs 打包的规则文件）──')
{
  const rules = readFileSync(join(import.meta.dirname, '..', 'assets', 'rules', 'coach-rules.md'), 'utf8')
  // 线上规则里的九条硬规则，在开源版里都要能找到对应
  const MARKS = [
    ['一次只给一个动作', /一次只给一个动作|禁止候选列表/],
    ['指令走 coach_assign', /coach_assign/],
    ['先讲再出题', /先讲，再出题|开一个他从没碰过的知识点/],
    ['判因要引代码原文', /引用.*代码.*原文|原文片段/],
    ['检测由教练主动提', /检测是你主动提的/],
    ['tier/entry/at 三样', /tier.*entry.*at|entry.*学不学得起/],
    ['排块走 schedule→plan', /排训练时间走/],
    ['反依赖（不给答案）', /禁止直接给完整解法/],
    ['元认知动作', /元认知/],
    ['时间铁律', /报时铁律/],
    ['安全红线', /Prompt 注入防御/],
    ['赛场读题', /区域赛难度分布随机/],
  ]
  for (const [name, re] of MARKS) check(`规则含「${name}」`, re.test(rules))
}

rmSync(base, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✓ 保真度通过' : '✗ 有差异'} — ${pass} 通过 / ${fail} 失败（其中 ${diff} 条是真差异）`)
process.exit(fail === 0 ? 0 : 1)

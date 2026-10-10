// 全工具形状扫描：把 acmer-coach 注册的每个工具都真跑一次，
// 返回值**递归**对 output.schema 校验（type / required / additionalProperties）。
//
// 为什么需要这把尺子：dsh 对工具返回值是**严格校验**的 —— schema 里写了
// additionalProperties:false，返回值多一个键就是校验错，而报错会把工具真正
// 想说的话（"你排错了" / "这个知识点不在图上"）盖成"工具坏了"。
//
// 和 verify.mjs 的分工：verify.mjs 的 shapeDiff 也递归，但断言只挂在
// **写过的那些地方**；这把尺子扫的是**全部工具 / 全部调用路径**，
// 每条都带拒绝分支（被拒那条最容易形状不齐），还会跑一遍
// coach_pool → coach_test → coach_grade 的成功链路。
//
// 它抓的就是 coach_next 兜底分支那种错：`frontier[].at` 返回里有、schema
// 里没有 → 214 个末端节点全走那条路，工具 100% 报错。
//
// 全程在临时目录里跑（COACH_DATA_DIR / COACH_DB 指过去），真数据一动不动。
// 退出码非 0 = 有错配。

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 跑的是 profile 里那份**已安装副本**（不是本目录的源码）——
// 副本才是运行时真正加载的东西。路径派生，要换 profile 就设 COACH_VERIFY_PROFILE。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = process.env.COACH_VERIFY_PROFILE || 'web'
const INSTALLED = pathToFileURL(
  path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'acmer-coach', 'index.js')).href
const tmp = mkdtempSync(path.join(os.tmpdir(), 'coach-sweep-'))

// ── 夹具：小地图 + 进度 + 空日程 ────────────────────────────────
writeFileSync(path.join(tmp, 'MAP.yaml'),
  `meta: { version: 9, node_count: 6 }
nodes:
  - id: A
    name: A
    domain: 测试
    depends: []
  - id: B
    name: B
    domain: 测试
    depends: [A]
    tier: core
    entry: 1500
  - id: C
    name: C
    domain: 测试
    depends: [A]
    tier: normal
    entry: 1600
  - id: 叶子
    name: 叶子
    domain: 测试
    depends: [A]
    tier: core
    entry: 1700
  - id: 够不着
    name: 够不着
    domain: 测试
    depends: [A]
    tier: core
    entry: 2900
  - id: 缺前置
    name: 缺前置
    domain: 测试
    depends: [C]
    tier: rare
    entry: 1500
`)
writeFileSync(path.join(tmp, 'PROGRESS.yaml'),
  `version: 1
cursor: A
updated: 2026-09-14
nodes:
  A:
    status: learned
  叶子:
    status: studying
    at: 2026-09-01
`)
writeFileSync(path.join(tmp, 'SCHEDULE.yaml'), 'version: 1\ndays: {}\n')
writeFileSync(path.join(tmp, 'DEPENDS.yaml'), 'version: 1\n')
writeFileSync(path.join(tmp, 'skilltree.html'), '<html></html>')
// （探针不再 stat 项目文档，所以这里也不放那份夹具了，见 index.js 的 PROBE_FILES）

process.env.COACH_DATA_DIR = tmp
process.env.COACH_DB = path.join(tmp, 'training.db')

// ── 夹具库：让 coach_pool / coach_test / coach_grade 走得通 ──
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(process.env.COACH_DB)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, cf_handle TEXT);
    CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT,
      problem_id TEXT, verdict TEXT, time_ms INTEGER, language TEXT, submitted_at TEXT);
    CREATE TABLE unified_problems (id INTEGER PRIMARY KEY, platform TEXT, problem_id TEXT,
      title TEXT, difficulty REAL, tags TEXT, url TEXT);
    CREATE TABLE diff_rating_map (platform TEXT, diff INTEGER, cf_rating INTEGER,
      PRIMARY KEY (platform, diff));
    CREATE TABLE rating_history (id INTEGER PRIMARY KEY, user_id INTEGER, rating INTEGER,
      rank TEXT, max_rating INTEGER, recorded_at TEXT, platform TEXT);
    INSERT INTO users VALUES (1, 'trainer', 'trainer', 'trainer');
    INSERT INTO rating_history VALUES (1, 1, 1800, '900', 1800, '2026-09-09T00:35:00+08:00', 'codeforces');
    INSERT INTO unified_problems VALUES (1,'luogu','P1','易题',3,'A','u');
    INSERT INTO unified_problems VALUES (2,'luogu','P2','中题',5,'A','u');
    INSERT INTO unified_problems VALUES (3,'luogu','P3','难题',8,'A','u');
    INSERT INTO unified_problems VALUES (4,'luogu','P4','B题',5,'B','u');
    INSERT INTO diff_rating_map VALUES ('luogu', 3, 1500);
    INSERT INTO diff_rating_map VALUES ('luogu', 5, 1800);
    INSERT INTO diff_rating_map VALUES ('luogu', 8, 2400);
    INSERT INTO unified_submissions VALUES (1,1,'codeforces','1015D','WA',15,'C++23','2026-09-11T20:09:45+08:00');
    INSERT INTO unified_submissions VALUES (2,1,'codeforces','1015D','AC',46,'C++23','2026-09-11T20:10:54+08:00');
  `)
  db.close()
}

const mockCtx = (registered) => ({
  tools: { register: (t) => registered.push(t) },
  inject: () => {},
  // 钩子（agent/pre-step）。这里只收不调 —— 钩子的行为在第 32 节验，
  // 这边只要保证"apply() 在有 on 的环境里不炸"。
  on: () => {},
})

// ── 递归校验 ───────────────────────────────────────────────────
function validate(schema, value, at, errs) {
  const t = schema?.type
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errs.push(`${at}: 期望 object，实到 ${Array.isArray(value) ? 'array' : typeof value}`); return
    }
    const props = schema.properties ?? {}
    for (const k of Object.keys(value)) {
      if (!(k in props)) errs.push(`${at}.${k}: schema 未声明（additionalProperties:false → dsh 校验会拒）`)
    }
    for (const [k, s] of Object.entries(props)) {
      if (!(k in value)) { if (s.required) errs.push(`${at}.${k}: 缺 required 字段`); continue }
      validate(s, value[k], `${at}.${k}`, errs)
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) { errs.push(`${at}: 期望 array，实到 ${typeof value}`); return }
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, errs))
  } else if (t === 'integer') {
    if (!Number.isInteger(value)) errs.push(`${at}: 期望 integer，实到 ${JSON.stringify(value)}`)
  } else if (t === 'number') {
    if (typeof value !== 'number') errs.push(`${at}: 期望 number，实到 ${typeof value}`)
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') errs.push(`${at}: 期望 boolean，实到 ${typeof value}`)
  } else if (t === 'string') {
    if (typeof value !== 'string') errs.push(`${at}: 期望 string，实到 ${typeof value}`)
  }
}

const mod = await import(`${INSTALLED}?sweep=${Date.now()}`)
const registered = []
mod.apply(mockCtx(registered))
const T = (n) => {
  const t = registered.find((x) => x.name === n)
  if (!t) throw new Error(`没注册 ${n}`)
  return t
}

const today = new Date().toLocaleDateString('sv-SE')   // YYYY-MM-DD（本地）

// 每个工具至少两条路：走得通的 + 被拒的（**被拒的那条最容易形状不齐**）
const cases = [
  ['coach_ping', {}],
  ['coach_target', { action: 'read' }],
  ['coach_target', { action: 'set', expectedRevision: 0, contest: '测试区域赛', date: '2026-10-18', result: '金牌', teamMode: 'team', weeklyHours: 20, priorities: [{ id: 'contest-reading', weight: 80, reason: '测试目标' }] }],
  // 真正走一遍「目标 → 动作」硬闸：不属于当前能力的 progress 节点必须拒绝，
  // 再切回无地图能力的读题卡，保留后续旧夹具的成功路径。
  ['coach_target', { action: 'set', expectedRevision: 1, contest: '测试区域赛', date: '2026-10-18', result: '金牌', teamMode: 'team', weeklyHours: 20, priorities: [{ id: 'dp-modeling', weight: 80, reason: '测试硬闸' }] }],
  ['coach_assign#target-gate', { node: 'B', deliverable: '把代码贴给我', why: '测试目标硬闸', minutes: 60, teachMinutes: 25 }],
  ['coach_target', { action: 'set', expectedRevision: 2, contest: '测试区域赛', date: '2026-10-18', result: '金牌', teamMode: 'team', weeklyHours: 20, priorities: [{ id: 'contest-reading', weight: 80, reason: '测试目标' }] }],
  ['coach_vp_import', { events: [{ eventId: 'shape-vp', contest: '测试 VP', date: today, durationMinutes: 300, problems: [{ problemId: 'A', status: 'AC', competencies: ['contest-reading'] }] }] }],
  ['coach_vp_connect', { action: 'status' }],
  ['coach_vp_sync', {}],
  ['coach_vp_contests', {}],
  ['coach_vp_replay', { contestId: 1 }],
  ['coach_postmortem', { eventId: 'shape-vp', competencies: ['contest-reading'], rootCauses: ['测试复盘'], nextActions: ['测试动作'] }],
  ['coach_focus', {}],
  ['coach_scope', { id: 'contest-reading' }],
  ['coach_scope', { id: '不存在的能力' }],
  // 无课程的读取 / 无课程的推进拒绝，不建立课程以免改变后续旧工具夹具。
  ['coach_curriculum', { action: 'read' }],
  ['coach_curriculum', { action: 'assess' }],
  ['coach_curriculum', { action: 'advance', expectedRevision: 0, reason: '测试：没有课程时不能推进阶段' }],
  // 搭建/同步：体检是常走的成功路；不给 handle 走拒绝路（**不联网**）
  ['coach_setup', { action: 'status' }],
  ['coach_setup', { action: 'sync' }],
  // 记录导入：有记录（成功） / 没记录（拒） / 认不出（跳过计数）
  ['coach_import', { records: [{ platform: 'luogu', problem_id: 'P1', verdict: '12' }] }],
  ['coach_import', {}],
  ['coach_import', { records: [{ platform: 'atcoder', problem_id: 'x', verdict: 'AC' }] }],
  // OI Wiki 检索：四条路都要扫 —— 命中、读页、空结果、参数缺失
  ['coach_wiki', { action: 'search', query: '线段树', topK: 3 }],
  ['coach_wiki', { action: 'node', node: '线段树' }],
  ['coach_wiki', { action: 'page', src: 'ds/seg.md' }],
  ['coach_wiki', { action: 'page', src: '没有这个页面.md' }],   // 拒：路径不存在
  ['coach_wiki', { action: 'search', query: 'zzz查不到的东东qqq' }], // 空结果分支
  ['coach_wiki', { action: 'node' }],                          // 拒：缺参数
  ['coach_next', { cursor: 'A' }],
  ['coach_next', { cursor: '叶子' }],                 // ← 兜底分支
  ['coach_next', { cursor: '并不存在' }],              // 打错字
  ['coach_next', {}],                                  // 游标空 → 读夹具
  ['coach_status', {}],
  ['coach_set_cursor', { node: 'B' }],
  ['coach_set_cursor', { node: 'ZZZ' }],               // 拒
  ['coach_mark', { node: 'C', status: 'studying' }],
  ['coach_mark', { node: 'ZZZ', status: 'studying' }], // 拒
  // 开新知识点必须带 teachMinutes —— 所以这条是**成功分支**
  ['coach_assign', { node: 'B', deliverable: '把代码贴给我', why: '测试', minutes: 60, teachMinutes: 25 }],
  // 不带 teachMinutes 撞上"全新知识点" → 走拒绝分支（顺便把这条新闸也扫到）
  ['coach_assign', { node: 'C', deliverable: '把代码贴给我', why: '测试', minutes: 60 }],
  ['coach_assign', { node: 'ZZZ', deliverable: 'x', why: 'y' }],       // 拒
  ['coach_assign', { node: '缺前置', deliverable: 'x', why: 'y' }],     // 拒（不在下一层）
  // ── 押着的训练动作（需求 #6）──
  // 上面 175 那条 assign **成功时已经押上了 B**，所以这三条按实际状态写顺序：
  //   撤掉（成功）→ 再撤一次（拒）→ 撤一个没押着动作的节点（拒）
  ['coach_unassign', { node: 'B', reason: '测试：撤掉刚押上的那条' }],
  ['coach_unassign', { node: 'B', reason: '再撤一次' }],
  ['coach_unassign', { node: 'ZZZ', reason: '不在图上' }],
  ['coach_pool', { node: 'A' }],
  ['coach_pool', { node: 'ZZZ' }],                     // 拒
  ['coach_schedule', {}],
  ['coach_plan', { date: today, blocks: [{ from: '09:00', kind: 'review', node: 'A' }] }],
  ['coach_plan', { date: today, blocks: [{ from: '09:00', kind: 'review', node: 'A' }] }], // 已排过 → 拒
  ['coach_unplan', { date: today, from: '09:00' }],
  ['coach_unplan', { date: today }],                   // 没给 from/all → 拒
  ['coach_diagnose', {
    code: 'int main(){ int a; return 0; }',
    category: '不认真', node: 'B',
    evidence: [{ quote: 'int main(){ int a;', kind: 'wrong', why: '测试用的判据' }],
    summary: '测试判因', problem: '1015D',
  }],
  // ── 后补的两个工具 ──
  // coach_log：上面 coach_plan 那条给今天排了 09:00 的 A，所以这条能算出 plannedMin
  ['coach_log', { node: 'A', actualMin: 95, solved: true, independent: false }],
  ['coach_log', { node: 'A', actualMin: 70, solved: true, independent: true }],  // 覆盖同一天同一点
  ['coach_log', { node: 'B', actualMin: 40, solved: false, independent: false }], // 没做出来也要记
  ['coach_log', { node: 'ZZZ', actualMin: 30, solved: true, independent: true }], // 拒：不在图上
  ['coach_log', { node: 'A', actualMin: 0, solved: true, independent: true }],    // 拒：时长非正
  // ── coach_verify（需求 #1 的工具）。它一度不在扫描范围里，
  //    于是出现"工具总数 17、扫到 16"的缺口，而且没报错 ──
  // check:false = 不起网络，形状照样能验（成功 + 拒绝两条路都要扫）
  ['coach_verify', { problems: [{ platform: 'nowcoder', problemId: 'NC1',
    gist: '打开题面看过：考的是区间 DP，和别人 AC 代码一致', node: 'A' }], check: false }],
  ['coach_verify', { problems: [{ platform: 'nowcoder', problemId: 'NC2', gist: '太短' }], check: false }],  // 拒
  // ⚠️ coach_cancel 的两条**不能放在这里** —— 它们是**有状态的**（有没有卷子），
  // 而这一批是在开卷那一坨**之前**全部构造好的：放这儿的话，
  // 循环跑到时卷子已经在手里了，"手里没卷 → 拒"这条就测不到，
  // 两条分支会悄悄换位置。所以挪到下面开卷序列里，顺序写死。
]

// 开卷 → 判卷，得串起来做
const pool = await T('coach_pool').execute({ node: 'A' }, undefined)
const picked = (pool.bands ?? []).flatMap((b) => b.candidates ?? b.items ?? []).slice(0, 3)
if (picked.length >= 3) {
  const paper = await T('coach_test').execute({
    node: 'A',
    problems: [
      { platform: picked[0].platform, problemId: picked[0].problemId, band: '易' },
      { platform: picked[1].platform, problemId: picked[1].problemId, band: '中' },
      { platform: picked[2].platform, problemId: picked[2].problemId, band: '难' },
    ],
  }, undefined)
  cases.push(['coach_test#real', null, paper])
  const graded = await T('coach_grade').execute({
    results: picked.slice(0, 3).map((p) => ({ problemId: p.problemId, solved: true, minutes: 15 })),
  }, undefined)
  cases.push(['coach_grade#real', null, graded])

  // ⚠️ 撤卷是**有状态**的（手里有没有卷），而这一段是"先把卷开好、再放进
  // 用例表"，卷子在循环开始前就已经在手里了。第一版在这里先塞了一条
  // "手里没卷→拒"，结果它跑到时手上有卷，**两条分支悄悄换了位置**，
  // 输出看着全绿、测的是反的。所以顺序照实际状态写：
  //   开好第二张 → 撤掉（成功）→ 再撤一次（拒）
  const paper2 = await T('coach_test').execute({
    node: 'A',
    problems: [
      { platform: picked[0].platform, problemId: picked[0].problemId, band: '易' },
      { platform: picked[1].platform, problemId: picked[1].problemId, band: '中' },
      { platform: picked[2].platform, problemId: picked[2].problemId, band: '难' },
    ],
  }, undefined)
  cases.push(['coach_test#again', null, paper2])
  cases.push(['coach_cancel', { reason: '他说今天没时间做了，明天再说' }])  // 成功：撤掉 paper2
  cases.push(['coach_cancel', { reason: '撤完再撤一次' }])                  // 拒：手里已经空了
} else {
  cases.push(['coach_test', { node: 'A', problems: [] }])            // 拒
  cases.push(['coach_grade', { results: [] }])                        // 无卷 → 拒
}

// ── 跑 ─────────────────────────────────────────────────────────
let bad = 0
const seen = new Set()
for (const [name, args, preset] of cases) {
  seen.add(name.split('#')[0])
  const tool = T(name.split('#')[0])
  let out
  try {
    out = preset ?? await tool.execute(args ?? {}, undefined)
  } catch (err) {
    console.log(`  THROW ${name}  → ${err.message}`)
    bad++
    continue
  }
  if (name === 'coach_assign#target-gate' && out.accepted !== false) {
    console.log(`  FAIL ${name}  → 目标硬闸没有拒绝无关 progress 节点`)
    bad++
    continue
  }
  const errs = []
  validate(tool.output.schema, out, 'out', errs)
  let renderNote = ''
  try {
    const blocks = tool.output.render(args ?? {}, out)
    if (!Array.isArray(blocks) || blocks[0]?.type !== 'text') renderNote = '  render 形状不对'
  } catch (err) {
    renderNote = `  render 抛错：${err.message}`
  }
  if (errs.length || renderNote) {
    bad++
    console.log(`  FAIL ${name}${renderNote}`)
    for (const e of errs.slice(0, 6)) console.log(`         ${e}`)
    if (errs.length > 6) console.log(`         …还有 ${errs.length - 6} 条`)
  } else {
    const n = out.ok === false || out.accepted === false ? '（走拒绝分支）' : ''
    console.log(`  OK   ${name}${n}`)
  }
}

const all = registered.map((t) => t.name)
const missing = all.filter((n) => !seen.has(n))
console.log()
console.log(`工具总数 ${all.length}，扫到 ${seen.size}${missing.length ? `，没扫到：${missing.join(', ')}` : ''}`)
console.log(bad ? `✗ ${bad} 条用例形状不合格` : '✓ 所有用例的形状都和 schema 对齐')
process.exit(bad ? 1 : 0)

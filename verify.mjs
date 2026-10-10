// 验收：直接 import **已安装的那一份**，把 apply() 跑起来看工具干得对不对。
//
// 为什么不 boot dsh web 就算数：boot 只能告诉你"没崩"，不能告诉你"工具在、
// 算得对"。而「模块加载失败 / 导出形状错 / id 对不上」这三种坏法里，
// 后两种在 boot 日志里**都是静默的**。直接调 apply() 才当场看得见。
//
// 注意 import 的是 profile 里那份**已安装副本**，不是源码目录。
// 副本才是运行时真正加载的东西 —— 拿源码目录测等于没测。
//
// 路径一律派生，不写死：本文件住在源码目录里，profile 在 dsh 家目录下。
// 要测别的 profile，设 COACH_VERIFY_PROFILE。
const { readFileSync, writeFileSync, mkdtempSync, utimesSync, statSync, rmSync, copyFileSync, readdirSync } = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const { pathToFileURL } = await import('node:url')

const SOURCE_DIR = import.meta.dirname
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = process.env.COACH_VERIFY_PROFILE || 'web'
const INSTALLED_DIR = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'acmer-coach')
const INSTALLED = pathToFileURL(path.join(INSTALLED_DIR, 'index.js')).href
// 插件从「profile 的 insert 行」切到 **bundle 层**，
// 所以 patch 文件的真相源也跟着挪了位置 —— 现在是插件自己那份。
// profile 那份仍要读，但读的是反面：**它不该再有 acmer-coach 的 insert 行**
// （两处都写 = 插件挂两次）。
const PATCH = path.join(SOURCE_DIR, 'cordis.patch.yml')
const PROFILE_PATCH = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')

// ⚠️ **纪律：任何新加的夹具 / 试跑脚本，必须先拷副本再跑**//
// 起因：本文件前面几关原来用**默认数据目录**（＝真账本）。需求 #6 让
// `coach_assign` 开始落盘之后，第 11 节那条「布置成功」就直接把一条幻影任务
// 写进了真 `PROGRESS.yaml`（重启后教练会去追一个不存在的活）。
//
// 规矩只有一条 —— **任何 import 插件、要调工具的脚本**，先：
//     const tmp = mkdtempSync(path.join(os.tmpdir(), 'xxx-'))
//     拷一份 knowledge/  →  process.env.COACH_DATA_DIR = tmp
// 而且必须在 **import 插件之前**设 —— `DATA_DIR` 是模块级 const，import 之后再设没用。
//
// 三道防线，各管一段：
//   ① 这条纪律（事前，靠人看）          ② `schedApi` 的闸门（拦夹具写接口）
//   ③ `dev.sh` 跑完自动比真账本 sha256（事后报警，变了立刻 exit 1）
// ⚠️ 工具路径（coach_plan/assign/log/unplan）**没闸也拦不了** —— 它们就是要写
// 真账本的（生产路径），所以那类只能靠 ① 和 ③。

const fails = []
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${label}${extra ? '  → ' + extra : ''}`)
  if (!cond) fails.push(label)
}

// 需求 #1：**题库里的题也要 verified** —— 一句话的核实凭据样本。
// ≥12 字才算（和 source=web 同一套门槛）。下面几十个夹具用它当"我打开看过"。
const V = '打开题面看过：要的是区间 DP（状态 dp[l][r] 合并区间），和别人 AC 代码一致'

// ── 0. 副本新不新（这一关专门堵"静默测了个旧版本"）────────────────
// `file:` 依赖装出来的是**硬链接**。原地写两边同变，但改名式写入（Edit 工具、
// VS Code 原子保存、vim backupcopy=no）会断开链接 → 两边分家，而
// `dsh plugin add` 认不出分家、**不重链也不报错**。于是"改完 → 重装 → 测试绿"
// 能一路绿到底却验的是老代码。所以这一关放最前面，不一致直接退，不许往下测。
console.log('── 0. 已安装副本 vs 源码 ──')
// ⚠️ statSync 必须在列表里。第 15 关那条「没留下 .tmp 残file」把它包在
// try/catch 里 —— 漏 import 的话它抛 ReferenceError，被 catch 吞掉，
// 断言**永远为真**。假绿比没测更坏，因为它看起来测过了。
// （fs / os / path 已经在文件头 import 过了，这里别再抄一遍。）

// ⚠️ **前面这些关不许碰真账本**。
//
// coach_assign 会落盘（押着的训练动作）。而下面 11~14 关用的是
// 「真地图 + 默认数据目录」那个实例 —— 于是「布置成功」那条会往**真的
// PROGRESS.yaml** 写一条押着的动作：账本里就多出一条幻影任务，
// 重启后教练会去追一个根本不存在的活。
//
// 修法：数据目录换成一份**临时副本** —— 地图要真（校验依赖它的结构），
// 账本要假（一个字节都不许碰真的）。后面各关再各自换自己的临时目录。
// 只有**写**才是问题：读真数据的行为一点不变，现有断言的前提照旧成立。
//
// 地图取自随包发的 `assets/knowledge/` —— 那才是随包交付的那一份，
// 测试要验的正是"包里的地图能不能跑通"。
const KNOWLEDGE = path.join(SOURCE_DIR, 'assets', 'knowledge')
const tmpEarly = mkdtempSync(path.join(os.tmpdir(), 'coach-early-'))
// 整目录拷（**不写白名单**：第一版只列了 5 个文件，结果 coach_ping 那关
// 因为缺 DEPENDS.yaml / skilltree.html 当场红 —— 白名单会漂，目录不会）。
// 跳过隐藏文件和 .bak 备份：那些不是数据。
for (const f of readdirSync(KNOWLEDGE)) {
  if (f.startsWith('.') || f.includes('.bak')) continue
  try {
    copyFileSync(path.join(KNOWLEDGE, f), path.join(tmpEarly, f))
  } catch { /* 拷不动就跳过：这几关不依赖它 */ }
}
process.env.COACH_DATA_DIR = tmpEarly
let stale = []
for (const f of ['index.js', 'package.json', 'lib/setup.js', 'lib/curriculum.js', 'lib/curriculum-evidence.js', 'lib/curriculum-planning.js', 'assets/rules/coach-rules.md']) {
  let same = true
  try {
    same = readFileSync(`${SOURCE_DIR}\\${f}`, 'utf8') === readFileSync(`${INSTALLED_DIR}\\${f}`, 'utf8')
  } catch {
    same = false
  }
  if (!same) stale.push(f)
}
check('副本和源码一致', stale.length === 0,
  stale.length ? `不一致：${stale.join(', ')}` : '')
if (stale.length) {
  // 必须**当场退**。继续测的后果是：后面几关拿旧代码跑出绿色的 OK，
  // 看上去"验收通过"—— 这正是这一关要防的东西。
  console.log()
  console.log(`✗ 副本是旧的，后面几关测的会是老代码，不跑了。`)
  console.log(`  → 跑 bash dev.sh 同步源码及运行时模块，再来。`)
  process.exit(1)
}

console.log('── 1. 模块能不能加载 ──')
let mod
try {
  mod = await import(INSTALLED)
} catch (err) {
  console.log(`  FAIL import 直接炸了：${err.message}`)
  process.exit(1)
}
check('import 成功', true)
check('导出 name', typeof mod.name === 'string', mod.name)
check('导出 apply 是函数', typeof mod.apply === 'function')
check('inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'),
  JSON.stringify(mod.inject))

console.log('── 2. id 和 patch 行对不对得上 ──')
// 对不上 → 工具静默不注册。这是最阴的一种坏法，必须机器验，不能靠眼看。
const patch = readFileSync(PATCH, 'utf8')
const idLine = patch.split('\n').find((l) => /^\s*-?\s*id:\s*acmer-coach\s*$/.test(l))
const nameLine = patch.split('\n').find((l) => /^\s*name:\s*'?acmer-coach'?\s*$/.test(l))
check('插件 patch 里有 acmer-coach 行', Boolean(idLine))
// ⚠️ 这条**必须同时**查 idLine/nameLine 和 mod.name。旧版只比了 mod.name，
// 于是 patch 文件读错了地方（读到 undefined）它照样绿 —— 一条看不见东西的断言。
check('★ patch 的 id/name 与导出的 name 逐字相同',
  Boolean(idLine) && Boolean(nameLine) && mod.name === 'acmer-coach',
  `${idLine?.trim()} / ${nameLine?.trim()} vs name=${mod.name}`)

const pkg = JSON.parse(readFileSync(`${SOURCE_DIR}\\package.json`, 'utf8'))
check('package.json 声明了 dsh.bundle.patch（走 bundle 层）',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh?.bundle))
check('package.json 声明了 dsh.client（客户端 UI）',
  pkg.dsh?.client?.platform === 'web' && Array.isArray(pkg.dsh?.client?.inject),
  JSON.stringify(pkg.dsh?.client))
check('exports 里有 ./client 指向 client.js',
  pkg.exports?.['./client'] === './lib/client.js', JSON.stringify(pkg.exports?.['./client']))
// 两条路不能并存 —— 双挂的症状是工具注册两遍、按钮出现两个。
// profile 那份可能压根不存在（新装的 profile 是个空数组），缺了按空处理。
let profilePatch = ''
try { profilePatch = readFileSync(PROFILE_PATCH, 'utf8') } catch { /* 没有 = 不会双挂 */ }
check('★ profile 那边**没有**重复的 acmer-coach insert 行（否则双挂）',
  !/^\s*-?\s*id:\s*acmer-coach\s*$/.test(profilePatch))

// 版本号躺在两个文件里（index.js 的 VERSION 和 package.json 的 version），
// 对齐过一次 —— 之前是 0.4.0 vs 0.1.0，两份真相差了四个版本。
// 探针报的是 index.js 那个，装包系统看的是 package.json 那个：
// 不校验的话，报出来的版本号永远有一半是假的。
check('两处版本号一致（index.js VERSION vs package.json）',
  pkg.version === mod.VERSION, `package.json=${pkg.version} index.js=${mod.VERSION}`)

// ── apply() 的桩上下文 ──────────────────────────────────────────────
// 每处调用点手写一份的话，插件每多一个服务依赖就得改 N 个地方，漏一个就是
// TypeError（加 webServer 时就撞了：6 个调用点全炸）。
//
// inject 的默认桩**故意不调回调** —— 那正是 cordis 的真实语义：
// 依赖的服务不在时回调不会被调用。所以默认桩顺带验了「没有 webServer 的
// 环境（headless CLI）插件照样加载、工具照样注册」。要测页面路由的
// 调用点自己传 onWebServer（见第 25 节）。
const mockCtx = (registered, opts = {}) => ({
  tools: { register: (t) => registered.push(t) },
  inject: (_deps, cb) => { if (opts.onWebServer) cb(opts.onWebServer) },
  // 钩子。传 opts.hooks 就把注册的钩子收进去（第 32 节要直接调它）。
  // 不传 = 什么都不做，其它节的行为一点不变。
  on: (event, fn) => { if (opts.hooks) opts.hooks.push({ event, fn }) },
})

console.log('── 3. apply() 注册了哪些工具 ──')
const registered = []
mod.apply(mockCtx(registered))
const byName = new Map(registered.map((t) => [t.name, t]))
check('注册了 coach_ping', byName.has('coach_ping'))
check('注册了 coach_next', byName.has('coach_next'))
check('每个工具都有 output.schema（defineTool 必填项）',
  registered.every((t) => Boolean(t.output?.schema)))
check('每个工具都有 output.render',
  registered.every((t) => typeof t.output?.render === 'function'))
check('执行方法一律叫 execute 不叫 run',
  registered.every((t) => typeof t.execute === 'function' && t.run === undefined))

console.log('── 4. coach_ping 实跑 ──')
const ping = byName.get('coach_ping')
const v = await ping.execute({}, undefined)
check('ok 为真（三个数据文件都读得到）', v?.ok === true,
  v?.ok ? '' : v?.files?.filter((f) => f.status !== 'ok').map((f) => f.file).join(','))
// 探针条目 4 → 3。原来第 4 个是 `coach-plugin-roadmap.md` ——
// 一份插件开发用的路线图，混在数据文件里被当健康检查项。
// 它同时也是**污染小鲸工作区**的那份（knowledge/ 是教练的数据目录）。
check('探的**全是数据文件**，只有 3 个',
  Array.isArray(v?.files) && v.files.length === 3 &&
  v.files.every((f) => /\.(yaml|html)$/.test(f.file)),
  v?.files?.map((f) => f.file).join(' / '))
check('每个探针三字段同构', v.files.every((f) =>
  typeof f.file === 'string' && typeof f.status === 'string' && typeof f.detail === 'string'))

console.log('── 5. coach_ping render ──')
const blocks = ping.output.render({}, v)
check('render 返回 ContentBlock[]', Array.isArray(blocks) && blocks[0]?.type === 'text')
console.log(blocks[0].text.split('\n').map((l) => '     │ ' + l).join('\n'))

// ══════════════════════════════════════════════════════════════════
// 验收 —— 给游标「动态规划基础」，
// 吐出「区间 DP / 背包 DP / 数位 DP …」这批
// ══════════════════════════════════════════════════════════════════
console.log('── 6. coach_next：线路图的验收用例 ──')
const next = byName.get('coach_next')
const r = await next.execute({ cursor: '动态规划基础' }, undefined)
const ids = r.candidates.map((c) => c.id)
check('游标认得', r.notFound === false)
check('候选不是空的', ids.length > 0, `${ids.length} 个`)
for (const want of ['区间 DP', '背包 DP', '数位 DP']) {
  check(`候选里含「${want}」`, ids.includes(want))
}
// 只依赖「动态规划基础」的那批，前置应当全满足
for (const want of ['区间 DP', '背包 DP', '状压 DP', 'DP 优化', '其它 DP 方法']) {
  const c = r.candidates.find((x) => x.id === want)
  check(`「${want}」判为可开`, c?.ready === true, c ? `missing=${JSON.stringify(c.missing)}` : '不在候选里')
}
// 数位 DP 还挂着「位运算」这个独立前置 —— 这是**图里的真事实**，不该被抹平。
//
// 但「它现在开不开得了」取决于训练员标没标位运算，**那是会变的数据**。
// 这里翻过一次车：断言写死「缺 位运算」，而他真的把位运算标成了
// 已验证 —— 前提当场变假，红的是测试不是代码。
// 教训：**进度数据一有内容，写死的假设就开始过期。** 所以这条按实际标记分叉，
// 两边都验：没标 → 如实报缺；标了 → 必须放行（那正是今天修的 bug 本体）。
const digit = r.candidates.find((c) => c.id === '数位 DP')
const wyAssumed = r.assumedLearned.includes('位运算')
check(wyAssumed
  ? '「数位 DP」可开（训练员已标「位运算」—— 这次修的 bug 本体）'
  : '「数位 DP」判为待补，且指名缺「位运算」',
  wyAssumed
    ? digit?.ready === true
    : (digit?.ready === false && digit?.missing?.includes('位运算')),
  digit ? `ready=${digit.ready} missing=${JSON.stringify(digit.missing)}` : '不在候选里')
check('假定已学里含前置闭包（枚举、递归 & 分治）',
  r.assumedLearned.includes('枚举') && r.assumedLearned.includes('递归 & 分治'),
  r.assumedLearned.join(' / '))
check('mapStamp 非空（能追溯是哪版地图算的）', typeof r.mapStamp === 'string' && r.mapStamp.length > 0, r.mapStamp)

console.log('── 7. coach_next：补了前置就该放行 ──')
const r2 = await next.execute({ cursor: '动态规划基础', learned: ['位运算'] }, undefined)
check('补上「位运算」后，「数位 DP」转为可开',
  r2.candidates.find((c) => c.id === '数位 DP')?.ready === true)

console.log('── 8. coach_next：边界 ──')
const bad = await next.execute({ cursor: '动态规划基' }, undefined)
check('游标打错字 → notFound，不抛异常', bad.notFound === true)
check('打错字时给出相近建议', bad.suggestions.length > 0, bad.suggestions.join(' / '))
const dead = await next.execute({ cursor: '图论相关概念' }, undefined)
check('末端节点 → 空候选也是合法结果', Array.isArray(dead.candidates) && dead.notFound === false)

console.log('── 9. render 出的人话 ──')
const nb = next.output.render({ cursor: '动态规划基础' }, r)
check('render 返回 ContentBlock[]', Array.isArray(nb) && nb[0]?.type === 'text')
console.log(nb[0].text.split('\n').map((l) => '     │ ' + l).join('\n'))

// ══════════════════════════════════════════════════════════════════
// 10. 缓存按 mtime 失效 —— 拿**合成小地图**验，不碰真地图
// ══════════════════════════════════════════════════════════════════
// 为什么非验不可：地图重跑（build_map.py）后插件若还拿旧图算候选，
// 就是"数据陈旧却报得像新的"——今天一整天在治的病，不能自己再埋一个。
console.log('── 10. 地图缓存按 mtime 失效（合成小地图）──')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'coach-map-'))
const mini = (extra) => `meta: { version: 9, node_count: 3 }\nnodes:\n` +
  `  - id: A\n    name: A\n    domain: 测试\n    depends: []\n` +
  `  - id: B\n    name: B\n    domain: 测试\n    depends: [A]\n` +
  `  - id: C\n    name: C\n    domain: 测试\n    depends: [A]\n` + extra
const mapFile = path.join(tmp, 'MAP.yaml')
writeFileSync(mapFile, mini(''))
utimesSync(mapFile, new Date(), new Date())

process.env.COACH_DATA_DIR = tmp
const mod2 = await import(`${INSTALLED}?fresh=1`)   // 换 env 必须重新 import
const reg2 = []
mod2.apply(mockCtx(reg2))
const next2 = reg2.find((t) => t.name === 'coach_next')

const before = await next2.execute({ cursor: 'A' }, undefined)
check('读合成地图，游标 A 出 2 个候选', before.candidates.length === 2, `${before.candidates.length}`)

// 追加第三个后继 D，并把 mtime 往后推（同秒内写入 mtime 可能不变）
const later = new Date(Date.now() + 5000)
writeFileSync(mapFile, mini(`  - id: D\n    name: D\n    domain: 测试\n    depends: [A]\n`))
utimesSync(mapFile, later, later)

const after = await next2.execute({ cursor: 'A' }, undefined)
check('改完地图立刻读到新的（缓存真失效了）', after.candidates.length === 3,
  `${after.candidates.length} 个${after.candidates.length === 2 ? ' ← 缓存没失效，读到的是旧图' : ''}`)
check('mapStamp 跟着地图变了', before.mapStamp !== after.mapStamp, `${before.mapStamp} → ${after.mapStamp}`)

// ══════════════════════════════════════════════════════════════════
// 验收 —— 「问『今天干什么』，回的是**一个动作**，不是列表」
// ══════════════════════════════════════════════════════════════════
// coach_assign 的价值全在**校验**上，不在格式壳。所以每一条校验都要有
// **反向测试**：只测「正常布置成功」等于没测 —— 那正是挡不住东西的写法。
console.log('── 11. coach_assign：正常布置 ──')
const assign = byName.get('coach_assign')
check('注册了 coach_assign', Boolean(assign))

// ⚠️ 这里多了一步 —— 「区间 DP」在这份夹具里是**全新知识点**，
// 而开新知识点**必须先给讲解段**（不然就是直接扔题，不讲）。
// 所以 a1 带上 teachMinutes；不带的那条单独有反向断言（见下面 a1notaught）。
const a1 = await assign.execute({
  cursor: '动态规划基础', node: '区间 DP',
  deliverable: '把代码贴给我', why: '依赖已满足，且它向下解锁 2 个',
  teachMinutes: 20,
}, undefined)
check('布置成功', a1.accepted === true, a1.reject)
// 需求 #7：`minutes` 的定义从「整块长度」改成「净时间」——
// 断言跟着改期望值（默认净 40 = 整块 60），强度不变、条数不删。
check('时间盒默认：净 40（整块 60）',
  a1.minutes === 40 && a1.tailMinutes === 20,
  JSON.stringify({ 净: a1.minutes, 收尾: a1.tailMinutes }))
check('★ 开新知识点：块结构是 讲20/做40/10/10（讲解排在最前）',
  JSON.stringify(a1.blocks.map((b) => b.minutes)) === '[20,40,10,10]' &&
  a1.blocks[0].kind === 'teach',
  JSON.stringify(a1.blocks.map((b) => `${b.kind}:${b.minutes}`)))
check('★ 总时长把讲解和收尾都算进去（净40 + 收尾20 + 讲20 = 80）',
  a1.totalMinutes === 80, String(a1.totalMinutes))
check('讲解段的 label 带着三段式（推导→命名→扩展）',
  a1.blocks[0].label.includes('推导') && a1.blocks[0].label.includes('扩展'),
  a1.blocks[0].label)
check('三件套齐全（做什么 / 时间盒 / 交付物）',
  Boolean(a1.node) && a1.minutes > 0 && Boolean(a1.deliverable))

// ── 反向：开新知识点不给讲解段 = 又回到"直接出题" ──
const a1notaught = await assign.execute({
  cursor: '动态规划基础', node: '区间 DP',
  deliverable: '把代码贴给我', why: '测试',
}, undefined)
check('★ 开新知识点不给 teachMinutes → 拒（堵的就是"直接出题"）',
  a1notaught.accepted === false && a1notaught.reject.includes('全新知识点'),
  a1notaught.reject.split('\n')[0])
const a1short = await assign.execute({
  cursor: '动态规划基础', node: '区间 DP',
  deliverable: '把代码贴给我', why: '测试', teachMinutes: 3,
}, undefined)
check('★ 讲解短于下限 → 拒（讲 3 分钟等于念结论）',
  a1short.accepted === false && a1short.reject.includes('太短'), a1short.reject.split('\n')[0])

console.log('── 12. coach_assign：校验不过必须挡住（反向测试）──')
const denyCase = async (label, args, wantSubstr) => {
  const r = await assign.execute(args, undefined)
  const ok = r.accepted === false && r.reject.includes(wantSubstr)
  check(label, ok, ok ? '' : `accepted=${r.accepted} reject="${r.reject}"`)
}
// ① 编知识点 —— 这条挡住幻觉
await denyCase('编造不存在的知识点 → 拒绝',
  { cursor: '动态规划基础', node: '树上莫队分块', deliverable: '贴代码' }, '别自己造')
// ② 不在下一层 —— 挡住跳阶段
await denyCase('挑了个不是下一层的节点 → 拒绝',
  { cursor: '动态规划基础', node: '树链剖分', deliverable: '贴代码' }, '不是')
// ③ 缺前置 —— 挡住空头指令
//
// 从这条搬走了：原先拿真地图的「数位 DP 缺 位运算」当用例，
// 而训练员已经把位运算标成已验证 —— 它不再是个"缺前置"的场景了。
// **别在会变的真实进度上写死假设。** 等价用例（更严）在第 24 节的合成夹具里。
// ④ 时间盒太短
await denyCase('净时间低于 30 分钟 → 拒绝',
  { cursor: '动态规划基础', node: '区间 DP', deliverable: '贴代码', minutes: 15 }, '太短')
// ⑤ 没交付物
await denyCase('没写交付物 → 拒绝',
  { cursor: '动态规划基础', node: '区间 DP', deliverable: '' }, '交付物')
// ⑥ 游标不存在
await denyCase('游标打错 → 拒绝',
  { cursor: '动态规划基', node: '区间 DP', deliverable: '贴代码' }, '游标')

console.log('── 13. coach_assign：拒绝时不许改用列表交差 ──')
// 拒绝理由用「不在下一层」—— 它跟训练员的标记无关，永远拒得掉。
// （原先借的是「数位 DP 缺 位运算」，那条前提已经随他的标记失效了）
const rejBlocks = assign.output.render({}, await assign.execute(
  { cursor: '动态规划基础', node: '树链剖分', deliverable: '贴代码' }, undefined))
const rejText = rejBlocks[0].text
check('render 里明确禁止改用候选列表', rejText.includes('不要') && rejText.includes('coach_next'),
  rejText.split('\n')[0])

console.log('── 14. coach_assign：布置成功时的人话 ──')
const okBlocks = assign.output.render({}, a1)
check('render 返回 ContentBlock[]', Array.isArray(okBlocks) && okBlocks[0]?.type === 'text')
check('输出里只有**一个**知识点', (okBlocks[0].text.match(/【今天这一个动作】/g) || []).length === 1)
console.log(okBlocks[0].text.split('\n').map((l) => '     │ ' + l).join('\n'))

// ══════════════════════════════════════════════════════════════════
// 验收 —— 「你标完，小鲸下次说得出『你在哪，下一步开 X』」
// ══════════════════════════════════════════════════════════════════
// 全程在**临时目录**里跑（COACH_DATA_DIR 指过去），绝不碰真的 PROGRESS.yaml。
console.log('── 15. 进度读写（临时目录）──')
const tmp3 = mkdtempSync(path.join(os.tmpdir(), 'coach-prog-'))
const miniMap = `meta: { version: 9, node_count: 4 }
nodes:
  - id: A
    name: A
    domain: 测试
    depends: []
  - id: B
    name: B
    domain: 测试
    depends: [A]
  - id: C
    name: C
    domain: 测试
    depends: [A]
  - id: D
    name: D
    domain: 测试
    depends: [B]
`
writeFileSync(path.join(tmp3, 'MAP.yaml'), miniMap)
const progFile = path.join(tmp3, 'PROGRESS.yaml')

process.env.COACH_DATA_DIR = tmp3
const mod3 = await import(`${INSTALLED}?fresh=l3`)
const reg3 = []
mod3.apply(mockCtx(reg3))
const T = (n) => reg3.find((t) => t.name === n)

check('注册了 coach_status / coach_mark / coach_set_cursor',
  Boolean(T('coach_status') && T('coach_mark') && T('coach_set_cursor')))

// 没有 PROGRESS.yaml 时：不该炸，该当成空进度
const s0 = await T('coach_status').execute({}, undefined)
check('文件不存在 → 空进度，不抛异常', s0.verifiedCount === 0 && s0.cursor === '', JSON.stringify(s0.cursor))

// 标记
//
// ⚠️ **verified 手标不了了**。它不是「自评」，是「过检测」，
// 只能由 coach_grade 判卷产生（下面这道新闸专门测它走不通）。
// 所以 A 先标 learned，再往夹具文件里改成 verified ——
// 本节验的是**四级统计能分开**，不是「能不能手标」（那个已经堵死）。
const m1 = await T('coach_mark').execute({ node: 'A', status: 'learned' }, undefined)
check('标记 A 为学过（自评）', m1.ok === true && m1.to === 'learned', m1.reject)
const m2 = await T('coach_mark').execute({ node: 'B', status: 'learned' }, undefined)
check('标记 B 为学过（自评）', m2.ok === true && m2.to === 'learned', m2.reject)
// 「在学」是刻意加的：一天学不完是常态，
// 而且它和游标不是一回事（开过没学完的可以有好几个）
const m3 = await T('coach_mark').execute({ node: 'C', status: 'studying' }, undefined)
check('标记 C 为在学', m3.ok === true && m3.to === 'studying', m3.reject)

// ★ 新闸：verified 手标必须走不通（自评不能冒充检测结论）
let verifiedBlocked = false
try { await T('coach_mark').execute({ node: 'A', status: 'verified' }, undefined) }
catch { verifiedBlocked = true }
check('★ 手标 verified 走不通（schema 的 enum 里就没有它）', verifiedBlocked)

// 摆夹具：把 A 改成 verified。**这是测试在造场景，不是应用逻辑** ——
// 真实系统里只有 coach_grade 写得出这个状态。（文件里第一个 learned 就是 A）
writeFileSync(progFile,
  readFileSync(progFile, 'utf8').replace('status: learned', 'status: verified'))

// **四级必须分清，尤其 learned / verified 不能合** —— 最容易做错的地方
const s1 = await T('coach_status').execute({}, undefined)
check('四级分开统计',
  s1.verifiedCount === 1 && s1.learnedCount === 1 && s1.studyingCount === 1,
  `verified=${s1.verifiedCount} learned=${s1.learnedCount} studying=${s1.studyingCount}`)
check('各归各位：A 已验证 / B 学过 / C 在学',
  s1.verified.join() === 'A' && s1.learned.join() === 'B' && s1.studying.join() === 'C',
  `v=[${s1.verified}] l=[${s1.learned}] s=[${s1.studying}]`)

// 游标
const c1 = await T('coach_set_cursor').execute({ node: 'A' }, undefined)
check('移游标到 A', c1.ok === true && c1.to === 'A', c1.reject)

// ★ 游标落盘的核心收益：coach_next **不传游标**也该从文件里读
const n1 = await T('coach_next').execute({}, undefined)
check('★ coach_next 不传 cursor 时从 PROGRESS.yaml 读游标',
  n1.cursor === 'A' && n1.candidates.length === 2,
  `cursor=${n1.cursor} 候选=${n1.candidates.length}`)
check('候选带四级状态：B 学过 / C 在学',
  n1.candidates.find((c) => c.id === 'B')?.status === 'learned' &&
  n1.candidates.find((c) => c.id === 'C')?.status === 'studying',
  n1.candidates.map((c) => `${c.id}:${c.status}`).join(' '))

// 文件真的落盘了
const onDisk = readFileSync(progFile, 'utf8')
check('PROGRESS.yaml 真写到磁盘', onDisk.includes('cursor: A') && onDisk.includes('status: verified'))
const tmpDetector = () => !(() => { try { statSync(`${progFile}.tmp`); return true } catch { return false } })()
check('没留下 .tmp 残file', tmpDetector())
// 「测试要能失败」：上面那条断言原本漏了 import，ReferenceError 被 catch 吞掉，
// 于是它**永远为真** —— 一条看不见任何东西的探测器，看起来却像测过了。
// 所以这里故意造一个 .tmp，逼它看见；看不见就说明它又瞎了。
writeFileSync(`${progFile}.tmp`, 'x')
check('★ .tmp 探测器本身有效（故意造一个，它得看见）', tmpDetector() === false)
rmSync(`${progFile}.tmp`)

// 边界
const bad1 = await T('coach_mark').execute({ node: '不存在', status: 'learned' }, undefined)
check('标记不存在的知识点 → 拒绝', bad1.ok === false && bad1.reject.includes('没有'))
// 非法 status 被 parameters 的 enum 在**进 execute 之前**就挡住（比代码里那道检查更早）。
// execute 里那道白名单（只有 studying / learned）是第二道防线 ——
// 它管的正是「verified 也不许」：绕过工具层直接调内部 API 时才用得上。
let enumBlocked = false
try { await T('coach_mark').execute({ node: 'A', status: 'mastered' }, undefined) }
catch { enumBlocked = true }
check('非法 status 被 schema enum 挡住', enumBlocked)
const bad3 = await T('coach_set_cursor').execute({ node: '不存在' }, undefined)
check('游标移到不存在的点 → 拒绝', bad3.ok === false)
// 前置没满足要**警告但不拦** —— 复习旧节、横向补漏都要能移
const c2 = await T('coach_set_cursor').execute({ node: 'B' }, undefined)
check('游标可移到前置未满足的点（只警告）', c2.ok === true, c2.reject)

// ⚠️ 安全测试：文件损坏时绝不能拿空进度覆盖真相源
console.log('── 16. 安全：损坏的 PROGRESS.yaml 不许被静默覆盖 ──')
const garbage = '{[}\n'
const PROGRESS_SEED = readFileSync(progFile, 'utf8')   // 弄坏之前留一份好的，后面 cli 测试要用
writeFileSync(progFile, garbage)
let threw = false
try { await T('coach_status').execute({}, undefined) } catch { threw = true }
check('文件损坏 → 抛异常（不是静默当空进度）', threw)
const survived = readFileSync(progFile, 'utf8') === garbage
check('★ 且原文件没被覆盖', survived, survived ? '' : '被空进度覆盖了 = 丢数据')

// ══════════════════════════════════════════════════════════════════
// 17. progress-cli.mjs —— 技能树页面的服务端靠它写进度
// ══════════════════════════════════════════════════════════════════
// 这一层存在的唯一理由是**只有一个 YAML 写入实现**：
// 服务端（Python）不自己读写 YAML，shell 出来跑它。
// 所以必须验它跑得起来、并且和插件看到的是同一份数据。
console.log('── 17. progress-cli（服务端写进度的通道）──')
const { execFileSync } = await import('node:child_process')
const CLI = `${INSTALLED_DIR}\\progress-cli.mjs`
const runCli = (...args) => JSON.parse(execFileSync(
  process.execPath, [CLI, ...args],
  { env: { ...process.env, COACH_DATA_DIR: tmp3 }, encoding: 'utf8' }))

// 先修好刚才故意弄坏的文件
// 修好文件并把游标归位 —— 上面「游标可移到前置未满足的点」那关把它移到 B 了，
// 不归位的话下面这条断言会拿 B 去比 A（我第一版就是这么错的）
writeFileSync(progFile, PROGRESS_SEED)
let cli1
try {
  runCli('cursor', 'A')          // 顺带把 cursor 命令也测了
  cli1 = runCli('get')
} catch (e) { cli1 = { ok: false, reject: String(e.message) } }
check('cli cursor + get 跑得通', cli1.ok === true && cli1.cursor === 'A',
  cli1.ok ? `cursor=${cli1.cursor}` : JSON.stringify(cli1.reject ?? ''))

const cli2 = runCli('mark', 'D', 'studying')
check('cli mark 在学', cli2.ok === true && cli2.status === 'studying', JSON.stringify(cli2.reject ?? ''))

// ★ 关键：cli 写完，**插件**要能读到 —— 两个入口同一份真相
const afterCli = await T('coach_status').execute({}, undefined)
check('★ cli 写的、插件读得到（同一个真相源）',
  afterCli.studying.includes('D'), `studying=[${afterCli.studying}]`)

// cli 也要挡住不存在的节点 —— 页面点出来的 id 一定是合法的，但接口不能靠这个假设
let cliBlocked = false
try { runCli('mark', '不存在', 'learned') } catch { cliBlocked = true }
check('cli 挡住不存在的节点', cliBlocked)

// ══════════════════════════════════════════════════════════════════
// 18. 判因 —— 贴代码 + 提交记录 → 读出「为什么错」
// ══════════════════════════════════════════════════════════════════
// 这一关的灵魂不是格式对不对，是**那句话必须指得着代码**。
//
// 判因最常犯的错不是判错，是判得含糊（「你 WA 了」「边界没处理好」）——
// 那种话对训练员零价值，还没法反驳、没法验证。
// 所以每条判因都要引用**代码原文**，并且当场机器校验那段原文真在代码里。
// 抄不出来就拒绝。这跟 coach_assign「节点 id 只能从地图取到」是同一个把戏：
// 让含糊的话**物理上说不出口**。
//
// 机械证据（提交序列 / WA→AC 秒数 / 难度标签）用 node:sqlite 只读查，
// 这里造一个**临时小库**灌两行真数据，绝不碰真的 training.db。
console.log('── 18. 判因（临时库 + 临时地图）──')
const { DatabaseSync } = await import('node:sqlite')
const dbFile = path.join(tmp3, 'training.db')
const miniDb = new DatabaseSync(dbFile)
miniDb.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT, display_name TEXT, cf_handle TEXT);
  CREATE TABLE unified_submissions (id INTEGER PRIMARY KEY, user_id INTEGER, platform TEXT,
    problem_id TEXT, verdict TEXT, time_ms INTEGER, language TEXT, submitted_at TEXT);
  CREATE TABLE unified_problems (id INTEGER PRIMARY KEY, platform TEXT, problem_id TEXT,
    title TEXT, difficulty REAL, tags TEXT);
  INSERT INTO users VALUES (1, 'trainer', 'trainer', 'trainer');
  INSERT INTO unified_submissions VALUES
    (1, 1, 'codeforces', '1015D', 'WA', 15, 'GNU C++17', '2026-09-11T20:09:45+08:00'),
    (2, 1, 'codeforces', '1015D', 'AC', 46, 'GNU C++17', '2026-09-11T20:10:54+08:00');
  INSERT INTO unified_problems VALUES
    (1, 'codeforces', '1015D', 'Walking Between Houses', 1600, 'constructive algorithms,greedy');
`)
miniDb.close()
process.env.COACH_DB = dbFile          // 指向临时库，真库一动不动

const diag = T('coach_diagnose')
check('注册了 coach_diagnose', Boolean(diag))

// 一段像样的 WA 代码。故意在边界那一行埋错，让「引用原文」有的可引。
const CODE = [
  'int solve() {',
  '  int n, k; cin >> n >> k;',
  '  if (k > n - 1) { cout << "NO" << endl; return 0; }',
  '  vector<int> temp;',
  '  int cur = 1;',
  '  for (int i = 1; i <= k; i++) {',
  '    cur += (i % 2 ? n - 1 : -(n - 1));',
  '    temp.push_back(cur);',
  '  }',
  '  cout << "YES" << endl;',
  '  return 0;',
  '}',
].join('\n')
const EV_BAD = [{
  quote: 'if (k > n - 1) { cout << "NO"',
  kind: 'wrong',
  why: '上界判反了：k 最大能到 n-1，这一行把整类可行解判成了 NO',
}]

// ── 正向：判因跑得通，且机械证据自己算得出来 ──────────────────
const d1 = await diag.execute({
  code: CODE, problem: '1015D', category: '不认真', node: 'A',
  evidence: EV_BAD,
  summary: '不是不会构造，是边界判反了 —— 状态没问题，错在判特例那一行',
}, undefined)
check('判因跑通', d1.ok === true, d1.reject)
check('证据回带时标出「在代码里找到了」',
  d1.evidence.length === 1 && d1.evidence[0].found === true, JSON.stringify(d1.evidence))

check('★ 机械证据从提交记录算出来（2 次提交）',
  d1.mech.found === true && d1.mech.attempts === 2, JSON.stringify(d1.mech))
// 20:09:45 WA → 20:10:54 AC = 69 秒。秒级修好 = 「不认真」的机械指纹。
check('★ WA→AC 间隔算得对（69 秒）', d1.mech.lastWaToAcSec === 69, String(d1.mech.lastWaToAcSec))
check('题目元信息带上了（难度 1600 / 标签）',
  d1.mech.difficulty === 1600 && d1.mech.tags.includes('greedy'), JSON.stringify(d1.mech.tags))

// 去向**不是模型填的，是从分类推出来的** —— 让模型自由填只会填错
check('去向由分类推导：不认真 → 重写', d1.nextMove.kind === 'redo', JSON.stringify(d1.nextMove))
const dNot = await diag.execute({
  code: CODE, category: '不会', node: 'B', evidence: EV_BAD, summary: '缺机制',
}, undefined)
check('去向由分类推导：不会 → 补课', dNot.nextMove.kind === 'backfill', JSON.stringify(dNot.nextMove))
const dUnf = await diag.execute({
  code: CODE, category: '不熟', node: 'B', evidence: EV_BAD, summary: '会但慢',
}, undefined)
check('去向由分类推导：不熟 → 限时加练', dUnf.nextMove.kind === 'drill', JSON.stringify(dUnf.nextMove))

// 库里查不到的题：降级，不许炸
const dMiss = await diag.execute({
  code: CODE, problem: '99999Z', category: '不熟', node: 'A', evidence: EV_BAD, summary: '查不到',
}, undefined)
check('查不到的题 → found:false，不炸', dMiss.ok === true && dMiss.mech.found === false,
  JSON.stringify(dMiss.mech))
check('没给题号也能判（代码才是主证据）',
  (await diag.execute({ code: CODE, category: '不熟', node: 'A', evidence: EV_BAD, summary: 'x' },
    undefined)).ok === true)

// 空白规范化：从别处复制来的引用常带不同缩进/空格，不该因此被拒
const dWs = await diag.execute({
  code: CODE, category: '不熟', node: 'A', summary: '空白规范化',
  evidence: [{ quote: 'int n, k;   cin >> n >> k;', kind: 'wrong', why: '空白不同也该认' }],
}, undefined)
check('引用允许空白差异（复制粘贴的常态）', dWs.ok === true, dWs.reject)

// ── 反向：含糊的话必须被挡住 ────────────────────────────────
console.log('── 18b. coach_diagnose：含糊的话必须说不出口（反向测试）──')
const denyD = async (label, args, want) => {
  const r = await diag.execute(args, undefined)
  const ok = r.ok === false && r.reject.includes(want)
  check(label, ok, ok ? '' : `ok=${r.ok} reject="${r.reject}"`)
}
await denyD('贴的代码太短 → 拒绝（判不了）',
  { code: 'int main(){}', category: '不认真', node: 'A', evidence: EV_BAD, summary: 'x' }, '太短')
await denyD('编造不存在的知识点 → 拒绝',
  { code: CODE, category: '不会', node: '树上莫队分块', evidence: EV_BAD, summary: 'x' }, '别自己造')
await denyD('一条证据都没有 → 拒绝',
  { code: CODE, category: '不认真', node: 'A', evidence: [], summary: 'x' }, '证据')
// ★ 这一条是整关的招牌：引用一段代码里根本没有的原文 = 在编
await denyD('★ 引用一段不在代码里的原文 → 拒绝',
  {
    code: CODE, category: '不认真', node: 'A', summary: 'x',
    evidence: [{ quote: 'for (int j = 0; j < m; j++)', kind: 'wrong', why: '这是别的题的代码' }],
  }, '代码里没有')
await denyD('引用太短（等于没指）→ 拒绝',
  {
    code: CODE, category: '不认真', node: 'A', summary: 'x',
    evidence: [{ quote: 'cur', kind: 'wrong', why: '含糊' }],
  }, '太短')
// 「不认真」是**具体的错**，不能靠一句「这里缺了什么」糊过去
await denyD('说不认真、却指不出具体写错的那处 → 拒绝',
  {
    code: CODE, category: '不认真', node: 'A', summary: 'x',
    evidence: [{ quote: 'for (int i = 1; i <= k; i++)', kind: 'missing', why: '这里缺了东西' }],
  }, '具体')
await denyD('没写一句话判因 → 拒绝',
  { code: CODE, category: '不熟', node: 'A', evidence: EV_BAD, summary: '' }, '一句话')
let catBlocked = false
try {
  await diag.execute({ code: CODE, category: '不会写', node: 'A', evidence: EV_BAD, summary: 'x' },
    undefined)
} catch { catBlocked = true }
check('非法分类被 schema enum 挡住', catBlocked)

// ── 人话 ────────────────────────────────────────────────────
const diagBlocks = diag.output.render({}, d1)
check('render 返回 ContentBlock[]', Array.isArray(diagBlocks) && diagBlocks[0]?.type === 'text')
check('render 里引到了代码原文', diagBlocks[0].text.includes('if (k > n - 1)'))
check('render 里给了下一步去向', diagBlocks[0].text.includes('重写') || diagBlocks[0].text.includes('redo'))
console.log(diagBlocks[0].text.split('\n').map((l) => '     │ ' + l).join('\n'))

// ══════════════════════════════════════════════════════════════════
// 19. 出卷 —— 给节点算候选题池
// ══════════════════════════════════════════════════════════════════
// 这一步是"程序算机械的"那一半：AI 挑题之前得先有**真实的候选项**，
// 否则它在四万道题里凭印象挑，挑出来的题号十有八九是编的。
//
// 两条必须机器验的事：**排除他 AC 过的**（不重复喂已经会的题）、
// **题号真实存在**（挡幻觉）。这两条一立，"挑题"才是个收敛的动作。
//
// 全程用临时小库 + 临时小地图，真库真地图一动不动。
console.log('── 19. coach_pool：候选题池（临时库 + 临时地图）──')
const tmp5 = mkdtempSync(path.join(os.tmpdir(), 'coach-l5-'))
writeFileSync(path.join(tmp5, 'MAP.yaml'), `meta: { version: 1, node_count: 2 }
nodes:
  - id: 区间 DP
    name: 区间 DP
    domain: 测试
    depends: []
  - id: 线段树
    name: 线段树
    domain: 测试
    depends: []
`)
const l5db = path.join(tmp5, 'training.db')
const d5 = new DatabaseSync(l5db)
d5.exec(`
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
  INSERT INTO diff_rating_map VALUES
    ('luogu', 3, 1500), ('luogu', 4, 1700), ('luogu', 5, 2000),
    ('luogu', 6, 2300), ('luogu', 7, 2600),
    -- 牛客档必须也给：不给的话下面那两条牛客题会因为"没难度数据"被过滤掉，
    -- 于是「NC100 被排除」那条断言会**因为错误的原因通过** —— 假绿。
    ('nowcoder', 4, 2000), ('nowcoder', 5, 2400);
  -- 难度铺开，保证三档都取得到
  INSERT INTO unified_problems VALUES
    (1, 'luogu', 'P1', '区间入门',   3, '区间 DP',      'u1'),
    (2, 'luogu', 'P2', '区间进阶',   4, '区间 DP',      'u2'),
    (3, 'luogu', 'P3', '区间中档',   4, '区间 DP,贪心',  'u3'),
    (4, 'luogu', 'P4', '区间难一',   5, '区间 DP',      'u4'),
    (5, 'luogu', 'P5', '区间难二',   5, '区间 DP',      'u5'),
    (6, 'luogu', 'P6', '区间高难',   6, '区间 DP',      'u6'),
    (7, 'luogu', 'P7', '区间天花板', 7, '区间 DP',      'u7'),
    (8, 'luogu', 'P8', '他做过了',   4, '区间 DP',      'u8'),
    (9, 'luogu', 'P9', '压根无关',   4, '贪心',         'u9'),
    (10, 'nowcoder', 'NC100', '牛客带前缀', 4, '区间 DP', 'u10'),
    (11, 'nowcoder', '101',   '牛客裸号',   5, '区间 DP', 'u11'),
    -- 同一道题的两个写法。真库里真有这情况（NC15121 / 15121），
    -- 不去重的话池子会把它列两遍，看起来像两道不同的题。
    (12, 'nowcoder', 'NC102', '牛客重复题', 4, '区间 DP', 'u12'),
    (13, 'nowcoder', '102',   '牛客重复题', 4, '区间 DP', 'u13');
  -- P8 他已经 AC（必须被排除）；牛客那条用**裸号**提交 ——
  -- 题库里存的是 NC100，两边命名空间不同，不归一就排除不掉
  INSERT INTO unified_submissions VALUES
    (1, 1, 'luogu', 'P8', 'AC', 30, 'C++', '2026-09-01T10:00:00+08:00'),
    (2, 1, 'nowcoder', '100', 'AC', 30, 'C++', '2026-09-01T10:00:00+08:00');
`)
d5.close()
process.env.COACH_DATA_DIR = tmp5
process.env.COACH_DB = l5db
const mod5 = await import(`${INSTALLED}?fresh=l5`)
const reg5 = []
mod5.apply(mockCtx(reg5))
const T5 = (n) => reg5.find((t) => t.name === n)

const pool = T5('coach_pool')
check('注册了 coach_pool', Boolean(pool))
const pb = await pool.execute({ node: '区间 DP' }, undefined)
check('出池成功', pb.ok === true, pb.reject)
check('标签匹配是精确级', pb.matchKind === 'exact', pb.matchKind)
check('池子里的题号全是真的（来自题库表）',
  pb.bands.every((b) => b.candidates.every((c) => c.title && c.url)))
// ★ 不重复喂已经会的题
const allIds = pb.bands.flatMap((b) => b.candidates.map((c) => c.problemId))
// 下面几条"排除"断言在**空池子**上会全部假通过。先钉死池子非空。
check('池子里真有题（否则下面几条排除断言会假通过）', allIds.length > 0, `${allIds.length} 道`)
check('★ 排除他 AC 过的（P8 不在池子里）', !allIds.includes('P8'), allIds.join(','))
check('★ 牛客题号归一也排得掉（NC100 不在池子里）', !allIds.includes('NC100'), allIds.join(','))
check('无关标签的题不进池子（P9 不在）', !allIds.includes('P9'), allIds.join(','))
// ★ 真库上撞出来的：题库表里 `NC102` 和 `102` 是同一道题的两行，
// 不去重就会把它列两遍，看起来像两道不同的题，很能骗人。
const dupN = allIds.filter((x) => x === 'NC102' || x === '102').length
check('★ 同一题的双写法只留一个（NC102 / 102）', dupN === 1, `出现了 ${dupN} 次`)
check('留下的是带前缀的规范写法', allIds.includes('NC102'), allIds.join(','))
check('三档齐全', pb.bands.map((b) => b.band).join() === '易,中,难', pb.bands.map((b) => b.band).join())
check('每档都有候选', pb.bands.every((b) => b.candidates.length > 0),
  pb.bands.map((b) => `${b.band}:${b.candidates.length}`).join(' '))
const easy = pb.bands[0].anchorRating, hard = pb.bands[2].anchorRating
check('难档锚点高于易档', hard > easy, `${easy} → ${hard}`)
// ★ 光报一个 rating 数字没用 —— 教练要的是"该看哪档"。
const poolTxt = pool.output.render({}, pb)[0].text
check('★ 渲染里有难度带指引', poolTxt.includes('难度带'),
  (poolTxt.match(/.*难度带.*/) ?? ['（没有）'])[0].slice(0, 70))
check('★ 难度带按 +100~200 算（夹具 rating 1800 → 1900~2000）',
  poolTxt.includes('1900~2000'),
  (poolTxt.match(/目标 \d+~\d+/) ?? ['（没有）'])[0])
console.log(pool.output.render({}, pb)[0].text.split('\n').slice(0, 12)
  .map((l) => '     │ ' + l).join('\n'))

// ── 需求 #1：题面链接 + 已核实标记 ────────────────────
// ① 题库里的 url 靠不住：真库 42600 道里 12378 道是空的，抽出来全是空。
//    夹具里填的 'u1' 更是假的 ——
//    工具必须**现推**一条能打开的；推不出来就明说，别印个空行。
const hardUrls = pb.bands.flatMap((b) => b.candidates).filter((c) => !/^https?:\/\//.test(c.url))
check('★ 每道候选都有 http 开头的题面链接（夹具里 url 是 u1，工具现推）',
  hardUrls.length === 0, JSON.stringify(hardUrls.map((c) => `${c.problemId}:${c.url}`)))
check('★ 推出来的链接形状对（洛谷题号直接拼）',
  pb.bands.flatMap((b) => b.candidates).some((c) => c.url === 'https://www.luogu.com.cn/problem/P1'),
  pb.bands[0].candidates[0]?.url)
check('★ 渲染把链接印出来（开卷前唯一能核实解法的通道）',
  poolTxt.includes('https://www.luogu.com.cn/problem/'),
  (poolTxt.match(/.*luogu\.com.*/) ?? ['（没有）'])[0].slice(0, 60))

// ② 已经在核实台账里的题，候选行上标出来
const led5 = mod5.progressApi.load()
led5.verified_problems = {
  'luogu|P1': { at: '2026-09-20', gist: '打开题面看过，正解就是区间合并', node: '区间 DP' },
}
mod5.progressApi.save(led5)
const pb2 = await pool.execute({ node: '区间 DP' }, undefined)
const p1c = pb2.bands.flatMap((b) => b.candidates).find((c) => c.problemId === 'P1')
check('★ 核实过的题在候选里标出来（不用靠"试开卷被拒还是放行"反推）',
  p1c?.verified === true && p1c.verifiedAt === '2026-09-20',
  JSON.stringify(p1c && { v: p1c.verified, at: p1c.verifiedAt }))
check('★ 渲染里看得见 ✓已核实',
  pool.output.render({}, pb2)[0].text.includes('✓已核实'),
  (pool.output.render({}, pb2)[0].text.match(/.*已核实.*/) ?? ['（没有）'])[0].slice(0, 70))
check('没核实过的题不许带标记（带了标记就失去意义）',
  pb2.bands.flatMap((b) => b.candidates).filter((c) => c.problemId !== 'P1')
    .every((c) => c.verified === false), '')

// 匹配不到 → 拒绝，**不许给一个空池子装作成功**
const pMiss = await pool.execute({ node: '线段树' }, undefined)
check('题库里没这个标签 → 拒绝，不静默给空池',
  pMiss.ok === false && pMiss.reject.includes('题库'), pMiss.reject)
const pBad = await pool.execute({ node: '不存在的节点' }, undefined)
check('节点不在地图 → 拒绝', pBad.ok === false && pBad.reject.includes('别自己造'), pBad.reject)

// ══════════════════════════════════════════════════════════════════
// 20. 开卷 —— 校验挑的题，落盘 pending
// ══════════════════════════════════════════════════════════════════
// 这一关挡的是**幻觉题号**。AI 从四万道题里挑三道的正确姿势是先调 coach_pool
// 拿到真实候选，再挑；但"正确姿势"不能靠自觉 —— 得让错的路走不通。
//
// 手法和判因一模一样：那边要求「引用的代码原文必须真在代码里」，
// 这里要求「题号必须真在题库里，且他没做过」。抄不出来 / 查不到，就拒绝。
console.log('── 20. coach_test：校验挑的题并开卷 ──')
const test = T5('coach_test')
check('注册了 coach_test', Boolean(test))

const PAPER3 = [
  { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
  { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
]

// ── 20a. 前置闸：**没讲过就不许开卷**（需求 #5）────────
// 09-21 撤卷的根因：17:35 刚讲完「矩阵加速递推」→ 18:00 就能给它开卷。
// 改之前只挡「他 AC 过没有」，不挡「这块他还没被讲过」。
//
// ⚠️ 这条**必须在 mark 之前跑** —— 一旦标了在学就有记录了，闸就不响了。
const noTaught = await test.execute({ node: '区间 DP', problems: PAPER3 }, undefined)
check('★ 没有教学记录 → 拒开（需求 #5 验收 ①）',
  noTaught.ok === false && noTaught.reject.includes('尚无教学记录'), noTaught.reject)
check('★ 拒绝理由说的是「先讲」而不是「换题」—— 别把人往错的方向指',
  noTaught.reject.includes('先讲过') || noTaught.reject.includes('先讲再开卷'), noTaught.reject)

// ③ 「讲过没」对教练**可查** —— 正反两面都验，**留白等于没报**：
//    报告里空着，教练照样会去开卷然后被拒，白跑一趟。
//    判据跟开卷时用的是**同一个函数**（taughtEvidence），不另写一份 ——
//    两处各写一份的话，"status 说讲过、开卷说没讲过"这种自相矛盾迟早出现。
const cursorWas = (await T5('coach_status').execute({}, undefined)).cursor
await T5('coach_set_cursor').execute({ node: '区间 DP' }, undefined)
const stNo = await T5('coach_status').execute({}, undefined)
check('★ 没记录：cursorTaught 空 + render 明确警告（验收 ③ 反面）',
  stNo.cursorTaught === '' &&
  T5('coach_status').output.render({}, stNo)[0].text.includes('还没有教学记录'),
  `cursorTaught=${JSON.stringify(stNo.cursorTaught)}`)

// ② 讲过一次之后同一节点可以正常开卷（不重复拦）—— 下面 mark 完再开就是这条。
const mark = T5('coach_mark')
const marked20 = await mark.execute({ node: '区间 DP', status: 'studying' }, undefined)
check('标「在学」建立教学记录（这是"讲过"的机械痕迹）', marked20.ok === true, marked20.reject)

// ③ 正面：标过之后同一行要报出「最早的教学痕迹」
const stYes = await T5('coach_status').execute({}, undefined)
check('★ 标过之后：报出最早的教学痕迹 + render 看得见「讲于 X」（验收 ③ 正面）',
  /^\d{4}-\d{2}-\d{2}$/.test(stYes.cursorTaught) &&
  T5('coach_status').output.render({}, stYes)[0].text.includes(`讲于 ${stYes.cursorTaught}`),
  `cursorTaught=${JSON.stringify(stYes.cursorTaught)}`)
// 游标还原 —— 下面几关的夹具是照着"游标本来就是空的"搭的
if (cursorWas) await T5('coach_set_cursor').execute({ node: cursorWas }, undefined)

const paper = await test.execute({ node: '区间 DP', problems: PAPER3 }, undefined)
check('★ 讲过一次之后同一节点可以正常开卷，不重复拦（需求 #5 验收 ②）',
  paper.ok === true, paper.reject)
check('每题都补上了标题/难度/权重（来自题库，不是 AI 说的）',
  paper.problems.every((p) => p.title && p.cfRating > 0 && p.weight > 0),
  JSON.stringify(paper.problems.map((p) => `${p.problemId}:${p.cfRating}/${p.weight}`)))
check('满分 6（易1+中2+难3）', paper.maxScore === 6, String(paper.maxScore))
check('通过线 4', paper.passScore === 4, String(paper.passScore))
check('总限时 90（20+30+40）', paper.totalMinutes === 90, String(paper.totalMinutes))
check('render 说清了三件套', test.output.render({}, paper)[0].text.includes('90'))

// ★ pending 必须落盘 —— 中间隔着几十分钟，甚至跨会话，靠对话上下文记不住
const prog5 = path.join(tmp5, 'PROGRESS.yaml')
const onDisk5 = readFileSync(prog5, 'utf8')
check('★ 卷子落盘了（pending）', onDisk5.includes('pending') && onDisk5.includes('P1'),
  onDisk5.includes('pending') ? '' : '文件里没有 pending')

// ── 反向：幻觉和偷懒必须被挡住 ──────────────────────────────
console.log('── 20b. coach_test：幻觉题号必须挡下来（反向测试）──')
const denyT = async (label, args, want) => {
  const r = await test.execute(args, undefined)
  const ok = r.ok === false && r.reject.includes(want)
  check(label, ok, ok ? '' : `ok=${r.ok} reject="${r.reject}"`)
}
const ok3 = [
  { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
  { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
]
// 已经押着上一张卷没判 —— 同时开两张，判卷时就不知道判哪张
await denyT('上一张卷还没判就想开新的 → 拒绝',
  { node: '区间 DP', problems: ok3 }, '还没判')
await denyT('★ 编一个题库里没有的题号 → 拒绝',
  { node: '线段树', problems: [
    { platform: 'luogu', problemId: 'P99999', band: '易', verified: V },
    { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
    { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
  ] }, '题库里没有')
await denyT('挑他已 AC 过的题 → 拒绝（不重复喂已经会的）',
  { node: '线段树', problems: [
    { platform: 'luogu', problemId: 'P8', band: '易', verified: V },
    { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
    { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
  ] }, 'AC 过')
await denyT('三档不齐（两道易一道中）→ 拒绝',
  { node: '线段树', problems: [
    { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
    { platform: 'luogu', problemId: 'P2', band: '易', verified: V },
    { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
  ] }, '三档')
await denyT('只给两道 → 拒绝',
  { node: '线段树', problems: [
    { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
    { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
  ] }, '三道')
await denyT('同一道题报两遍 → 拒绝',
  { node: '线段树', problems: [
    { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
    { platform: 'luogu', problemId: 'P1', band: '中', verified: V },
    { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
  ] }, '不止一遍')
await denyT('节点不在地图 → 拒绝',
  { node: '不存在', problems: ok3 }, '别自己造')

// ══════════════════════════════════════════════════════════════════
// 21. 判卷 —— 过 / 不过 / 过了但太慢
// ══════════════════════════════════════════════════════════════════
// 判卷是检测闭环的收口：**「掌握」由检测决定，不由数据推断**。
// 所以过了要写进 verified —— 那是 verified 这一级的定义，不是锦上添花。
//
// 三种结局，别合并：
//   passed   分够 + 没超时 → 真过了，标 verified，可以推进
//   overTime 分够 + 超时   → **不算过**。三分类里这是「不熟」，去向是加练不是推进
//   failed   分不够         → 不过，交 coach_diagnose 判因
console.log('── 21. coach_grade：判卷 ──')
const grade = T5('coach_grade')
check('注册了 coach_grade', Boolean(grade))
const progPath5 = () => readFileSync(prog5, 'utf8')

// 卷子还在（第 20 关开的）：P1 易 / P4 中 / P6 难，限时 90，通过线 4
const g1 = await grade.execute({
  results: [
    { problemId: 'P1', solved: true, minutes: 15 },
    { problemId: 'P4', solved: true, minutes: 25 },
    { problemId: 'P6', solved: true, minutes: 30 },
  ],
}, undefined)
check('判卷成功', g1.ok === true, g1.reject)
check('三题全下 → 6 分', g1.score === 6, String(g1.score))
check('用时 70 ≤ 90 → 过', g1.outcome === 'passed', g1.outcome)
const after1 = progPath5()
check('★ 写过检测记录（checks）', after1.includes('checks'), after1.includes('checks') ? '' : '没写')
check('★ 过了就把状态标成 verified（这就是 verified 的定义）',
  after1.includes('status: verified'), after1.includes('status') ? '' : '没写 status')
// 注意别拿**文件头注释**当数据测：头里就写着 "pending 是正押着的那张检测卷"，
// 用 includes('pending') 永远为真、永远测不出东西。要盯的是 YAML 顶层键。
check('判完清掉 pending', !/\npending:/.test(after1), /\npending:/.test(after1) ? '还押着' : '')
check('render 给了下一步', grade.output.render({}, g1)[0].text.includes('下一步'))

// ── 反向 ────────────────────────────────────────────────────
console.log('── 21b. coach_grade：判不了的情况（反向测试）──')
const denyG = async (label, args, want) => {
  const r = await grade.execute(args, undefined)
  const ok = r.ok === false && r.reject.includes(want)
  check(label, ok, ok ? '' : `ok=${r.ok} reject="${r.reject}"`)
}
const r3 = [
  { problemId: 'P1', solved: true, minutes: 10 },
  { problemId: 'P4', solved: true, minutes: 10 },
  { problemId: 'P6', solved: true, minutes: 10 },
]
await denyG('手里没押卷就判卷 → 拒绝', { results: r3 }, '没押着')

// 再开两张卷，分别走「超时」和「分数不够」两条路。
// **换一个干净节点**（线段树）—— 上面那张已经把 区间 DP 标成 verified 了，
// 在同一个节点上测"超时不该给 verified"测的是残留状态，不是这次判定。
//
// ⚠️ 换节点之后**得先建立教学记录**（需求 #5 的前置闸：没讲过不许开卷）。
// 夹具原来一步就开卷，那在真实用法里不会发生 —— 开卷前一定是讲过了的。
await mark.execute({ node: '线段树', status: 'studying' }, undefined)
await test.execute({ node: '线段树', problems: [
  { platform: 'luogu', problemId: 'P2', band: '易', verified: V },
  { platform: 'luogu', problemId: 'P5', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P7', band: '难', verified: V },
] }, undefined)
await denyG('结果少给一道 → 拒绝', { results: r3.slice(0, 2) }, '一道都不能少')
await denyG('报了个不在卷子里的题号 → 拒绝',
  { results: [...r3.slice(0, 2), { problemId: 'P99999', solved: true, minutes: 5 }] }, '卷子里没有')

const g2 = await grade.execute({
  results: [
    { problemId: 'P2', solved: true, minutes: 20 },
    { problemId: 'P5', solved: true, minutes: 30 },
    { problemId: 'P7', solved: true, minutes: 50 },   // 合计 100 > 90
  ],
}, undefined)
check('★ 分数够但超时 → 判「不熟」，不算过', g2.outcome === 'overTime', g2.outcome)
check('超时不给 verified（慢 ≠ 掌握）', g2.score === 6 && g2.status !== 'verified',
  `score=${g2.score} status=${g2.status}`)

// 第三张：只做出一道，分数不够
await test.execute({ node: '线段树', problems: [
  { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
  { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
] }, undefined)
const g3 = await grade.execute({
  results: [
    { problemId: 'P1', solved: true, minutes: 18 },
    { problemId: 'P4', solved: false, minutes: 30 },
    { problemId: 'P6', solved: false, minutes: 20 },
  ],
}, undefined)
check('分数不够 → 不过', g3.outcome === 'failed', g3.outcome)
check('只拿下易题 = 1 分，够不上 4 分线', g3.score === 1, String(g3.score))
check('三次检测记录都留在文件里', (progPath5().match(/- date:/g) || []).length >= 3,
  String((progPath5().match(/- date:/g) || []).length))

// ══════════════════════════════════════════════════════════════════
// 21c. 网上找的题 —— 组卷的第二条路
// ══════════════════════════════════════════════════════════════════
// 题池不再只有 coach_pool：他自己上网找的好题也能进卷子。代价是**核实的责任
// 挪到了他这边** —— 每道 web 题必须写清「我看过，正解真的用了这个算法」。
// 标签写着像不算数，所以 verified 是入场券，写不清就拒。
console.log('── 21c. coach_test：网上找的题 ──')
const webProb = (extra) => ({
  platform: 'atcoder', problemId: 'ABC300-F', band: '易', source: 'web',
  title: '网上找的题', url: 'https://atcoder.jp/tasks/abc300_f',
  verified: '在 OI Wiki 的词条里看到的例题，正解是轮廓线 DP + 记忆化',
  ...extra,
})
const okPool2 = [
  { platform: 'luogu', problemId: 'P1', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P4', band: '难', verified: V },
]
// ⚠️ 「不写」得真的把键删掉：写成 `verified: undefined` 会被 dsh 的
// 参数校验挡在**工具外面**（must be a lossless JSON object），根本走不到我们这层。
const webNoVerified = webProb({})
delete webNoVerified.verified
await denyT('★ 网上找的题不写 verified → 拒（核实过才算数）',
  { node: '线段树', problems: [webNoVerified, ...okPool2] }, 'verified')
await denyT('★ verified 只写两个字（"看过"）→ 拒',
  { node: '线段树', problems: [webProb({ verified: '看过' }), ...okPool2] }, 'verified')
await denyT('★ 网上找的题不给链接 → 拒（他做完要照着去交）',
  { node: '线段树', problems: [webProb({ url: 'abc300_f' }), ...okPool2] }, 'url')
await denyT('网上找的题不给标题 → 拒',
  { node: '线段树', problems: [webProb({ title: '' }), ...okPool2] }, 'title')

// 走通：一道网上的 + 两道库里的。他报的估值（2600）**不许**进 verifiedAt ——
// 那是他估的，不是库里的真值；两道路谷题最高 1800，所以验证段位该是 1800。
const gWeb = await test.execute({ node: '线段树', problems: [
  webProb({ rating: 2600 }), ...okPool2,
] }, undefined)
check('★ 网上找的题能开卷（三条校验都过）', gWeb.ok === true, gWeb.reject)
check('卷面上分得出来源', gWeb.problems.some((p) => p.source === 'web') &&
  gWeb.problems.filter((p) => p.source === 'pool').length === 2,
  gWeb.problems.map((p) => `${p.problemId}:${p.source}`).join(' '))
const webTxt = test.output.render({}, gWeb)[0].text
check('★ 卷面写明「网上找的 · 核实：…」（他要能复核）',
  webTxt.includes('网上找的') && webTxt.includes('轮廓线 DP'), webTxt.split('\n').slice(0, 6).join(' / '))

const gWebR = await grade.execute({
  results: [
    { problemId: 'ABC300-F', solved: true, minutes: 15 },
    { problemId: 'P1', solved: true, minutes: 20 },
    { problemId: 'P4', solved: true, minutes: 30 },
  ],
}, undefined)
check('★ 全下 → 过', gWebR.ok === true && gWebR.outcome === 'passed', `${gWebR.outcome} ${gWebR.reject}`)
// 夹具里 P4（难度 5）→ 2000，是三道里库内的最高值；网上那道自报 2600 必须被排除
check('★ 自报的 2600 不算「验证于的段位」（估的不算证明）',
  gWebR.verifiedAt === 2000, `verifiedAt=${gWebR.verifiedAt}（应为库里最高的 2000）`)

// ── 21d. 题库里的题也要核实 + 核实台账（需求 #1）──────
//
// 事故（09-21）：给「快速幂」开检测卷，三题里两道其实考的是矩阵加速递推 ——
// 一道都没打开看过，全靠标签挑。原来只有 source=web 要 verified，
// 题库来的题一路放行：**同一个风险两套门槛**。现在两条路一个标准。
// 台账：核实过的题号落进 PROGRESS.yaml，同一道题第二次被挑中不用重写。
console.log('── 21d. 题库题也要核实 + 台账 ──')
const barePool = [
  { platform: 'luogu', problemId: 'P1', band: '易' },
  { platform: 'luogu', problemId: 'P4', band: '中' },
  { platform: 'luogu', problemId: 'P6', band: '难' },
]
// 21c 那张卷里 P1/P4 是带 verified 开的 —— 顺手证明「开卷即写台账」。
// ⚠️ 判据走 progressApi 读**数据**，不用 grep 文件文本：文件头那段说明里
//    就写着 verified_problems 这个词，grep 会永远为真（假绿）。
const p5api = mod5.progressApi
check('★ 21c 那张卷的核实结论已经写进台账（开卷即落盘）',
  Boolean(p5api.load().verified_problems?.['luogu|P1']?.gist),
  JSON.stringify(Object.keys(p5api.load().verified_problems ?? {})))
// ⚠️ 要验"不写 verified 会被拒"，得先把台账清干净 —— 否则上面那道题
//    会走"沿用台账"这条路放行，拒的是别的东西（测的就不是这道闸了）。
const p5doc = p5api.load()
delete p5doc.verified_problems
p5api.save(p5doc)
check('夹具：台账已清空', !p5api.load().verified_problems)

const noV = await test.execute({ node: '区间 DP', problems: barePool }, undefined)
check('★ 题库里的题不写 verified → 拒（和网上找的题同一套门槛）',
  noV.ok === false && noV.reject.includes('verified'), `ok=${noV.ok} reject="${noV.reject}"`)
check('★ 拒绝理由要指路：题面链接在哪 + 为什么（标签满足 ≠ 这题只考这个）',
  noV.reject.includes('coach_pool') && noV.reject.includes('标签满足'),
  noV.reject.slice(0, 70))

const okV = await test.execute({
  node: '区间 DP', problems: barePool.map((x) => ({ ...x, verified: V })) }, undefined)
check('写了 verified → 放行', okV.ok === true, okV.reject)
check('★ 卷面把核实写出来（他要能复核为什么是这道题）',
  test.output.render({}, okV)[0].text.includes('已核实'),
  (test.output.render({}, okV)[0].text.match(/.*已核实.*/) ?? ['（没有）'])[0].slice(0, 60))
check('★ 台账落盘：平台|归一题号 → 核实结论',
  Boolean(p5api.load().verified_problems?.['luogu|P1']?.gist &&
    p5api.load().verified_problems?.['luogu|P6']?.gist),
  JSON.stringify(Object.keys(p5api.load().verified_problems ?? {})))
check('★ 新核实的 verifiedReused=false（这次真核了，不是沿用）',
  okV.problems.every((x) => x.verifiedReused === false && x.verifiedAt),
  JSON.stringify(okV.problems.map((x) => `${x.problemId}:${x.verifiedReused}`)))

// 判掉这张卷，才能开第二张（一次只开一张）
const gFirst = await grade.execute({
  results: [
    { problemId: 'P1', solved: true, minutes: 15 },
    { problemId: 'P4', solved: true, minutes: 25 },
    { problemId: 'P6', solved: true, minutes: 35 },
  ],
}, undefined)
check('夹具：第一张卷判掉了', gFirst.ok === true, gFirst.reject)

// 第二张卷：**同一个题号，一个 verified 都不写** —— 该走台账沿用
const reuse = await test.execute({ node: '区间 DP', problems: barePool }, undefined)
check('★ 核实过的题第二次被挑中：不写 verified 也能开（沿用台账）',
  reuse.ok === true, reuse.reject)
check('★ 输出里 verifiedReused=true + 带原核实日期（别让人以为它这次又核了一遍）',
  reuse.problems.every((x) => x.verifiedReused === true && /^\d{4}-\d{2}-\d{2}$/.test(x.verifiedAt)),
  JSON.stringify(reuse.problems.map((x) => `${x.problemId}:${x.verifiedReused}/${x.verifiedAt}`)))
check('★ 卷面上写明是沿用台账记录',
  test.output.render({}, reuse)[0].text.includes('沿用台账记录'),
  (test.output.render({}, reuse)[0].text.match(/.*沿用台账.*/) ?? ['（没有）'])[0].slice(0, 60))
const gSecond = await grade.execute({
  results: [
    { problemId: 'P1', solved: true, minutes: 15 },
    { problemId: 'P4', solved: true, minutes: 25 },
    { problemId: 'P6', solved: true, minutes: 35 },
  ],
}, undefined)
check('夹具：第二张卷也判掉了（不留 pending 给后面几节）', gSecond.ok === true, gSecond.reject)

// ── 21e. coach_verify：写台账的窄口子（需求 #1 补）──────
//
// 缺口：「写台账」和「开卷」被绑在一起了 —— 核实过一道题
// 但还没开卷时，它手上没有写入口，只能为了记一条核实去开一张卷。
// 09-21 逐个核过的 P9032 / P2216 / P4085 就是这种处境：卷面有据，台账里没有。
//
// 这条口子的要害是**核实的证据要能被工具看见**：
//   页面标题对得上 → how=auto；**对不上 → 拒**（照着错链接"核实"是给错题打勾）；
//   **抓不到 → 不拒**（那是"这条路走不通"，不是"没核实过"），记 how=manual。
// 用本地假站点测，不起真网络 —— 结果确定、不依赖外面的站开不开。
console.log('── 21e. coach_verify：写台账的窄口子 ──')
const { createServer } = await import('node:http')
let PAGE_TITLE = 'P1 区间入门 - 假站点'
const fakeSite = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<html><head><title>${PAGE_TITLE}</title></head><body>ok</body></html>`)
})
await new Promise((r) => fakeSite.listen(0, '127.0.0.1', r))
const SITE = `http://127.0.0.1:${fakeSite.address().port}`
const d5b = new DatabaseSync(l5db)
// P1/P4 指向假站点（标题对得上 / 对不上各验一次）；P6 指向一个**没人听的端口**
// （模拟站点抓不到）。⚠️ 三道都得指向本地 —— 漏一道它就会去抓真洛谷，
// 测出来的"对不对得上"取决于外面那个站开不开，那就不是在测我们的逻辑了
// （第一版就漏了 P4，于是"对不上→拒绝"那条**因为抓不到而假绿**）。
d5b.exec(`UPDATE unified_problems SET url = '${SITE}/p1' WHERE problem_id = 'P1';
          UPDATE unified_problems SET url = '${SITE}/p4' WHERE problem_id = 'P4';
          UPDATE unified_problems SET url = 'http://127.0.0.1:1/dead' WHERE problem_id = 'P6';`)
d5b.close()

// 台账清空，isolate 这一节（否则验的是 21d 留下的残留）
const led5e = p5api.load()
delete led5e.verified_problems
p5api.save(led5e)

const verifyTool = T5('coach_verify')
check('注册了 coach_verify', Boolean(verifyTool))
// ⚠️ check 不传时**不能**写成 `{problems, check: undefined}` —— dsh 的参数校验
// 会把它挡在工具外面（must be a lossless JSON object），根本走不到我们这层。
// 这个坑 21c 已经踩过一次（webNoVerified 那条注释），这是第二次。
const vf = (problems, check) => (check === undefined
  ? verifyTool.execute({ problems }, undefined)
  : verifyTool.execute({ problems, check }, undefined))

const v1 = await vf([{ platform: 'luogu', problemId: 'P1', gist: V }])
check('★ 页面标题对得上 → 落账，记成 auto（工具核过的）',
  v1.ok === true && v1.entries[0]?.how === 'auto' && v1.autoChecked === 1, JSON.stringify(v1.entries))
check('★ 台账真落盘了，而且 how 一起存住（字段白名单那个坑的回归闸）',
  p5api.load().verified_problems?.['luogu|P1']?.how === 'auto',
  JSON.stringify(p5api.load().verified_problems?.['luogu|P1']))
check('★ 渲染说得清"自动核对"和"自报"的区别',
  verifyTool.output.render({}, v1)[0].text.includes('已核对'),
  verifyTool.output.render({}, v1)[0].text.split('\n')[0])

// 抓不到 ≠ 没核实过：退路必须留
const v2 = await vf([{ platform: 'luogu', problemId: 'P6', gist: V, node: '区间 DP' }])
check('★ 抓不到页面标题 → **不拒**，按自报落账（记 how=manual）',
  v2.ok === true && v2.entries[0]?.how === 'manual' && v2.manualRecorded === 1, JSON.stringify(v2.entries))
check('★ 拒绝理由里说清"是抓不到，不是没核实"',
  String(v2.entries[0]?.warn ?? '').includes('没抓成页面标题'), String(v2.entries[0]?.warn))
check('★ 自报和自动核对**分开存**，不混着读',
  p5api.load().verified_problems?.['luogu|P6']?.how === 'manual')

// 对不上 → 拒（这是这条口子的入场券）
PAGE_TITLE = 'P4 完全不相干的题 - 假站点'
const v3 = await vf([{ platform: 'luogu', problemId: 'P4', gist: V }])
check('★ 页面标题对不上 → 拒绝落账（照着错链接核实 = 给错题打勾）',
  v3.ok === false && v3.reject.includes('对不上'), `ok=${v3.ok} reject="${v3.reject}"`)
check('★ 拒绝时两个标题都摆出来（他才能判断是链接错还是题号错）',
  v3.reject.includes(PAGE_TITLE) && v3.reject.includes('区间难一'), v3.reject.slice(0, 90))
check('★ 拒了就不许留下半条记录', p5api.load().verified_problems?.['luogu|P4'] === undefined)

// 反向：编的题号 / 写不清的依据
const v4 = await vf([{ platform: 'luogu', problemId: 'P99999', gist: V }])
check('★ 题号不在题库 → 拒（挡编造）', v4.ok === false && v4.reject.includes('编'), v4.reject)
const v5 = await vf([{ platform: 'luogu', problemId: 'P1', gist: '看过' }])
check('★ gist 写不清 → 拒', v5.ok === false && v5.reject.includes('gist'), v5.reject)
// check=false：不起网络，直接按自报落
const v6 = await vf([{ platform: 'luogu', problemId: 'P4', gist: V }], false)
check('check=false → 不起网络核对，按自报落账（已知站点抓不到时用）',
  v6.ok === true && v6.entries[0]?.how === 'manual', JSON.stringify(v6.entries))

// ── 闭环：coach_verify 记过的题，coach_test 不用再写 verified ──
// 台账只放 P1/P4/P6 —— 就是"这三道我核过了，但还没开卷"的真实处境。
const closetLedger = p5api.load()
closetLedger.verified_problems = Object.fromEntries(['P1', 'P4', 'P6'].map((id) => [
  `luogu|${id}`, { at: '2026-09-20', gist: V, node: '区间 DP', how: 'auto' },
]))
p5api.save(closetLedger)
const closX = await test.execute({ node: '区间 DP', problems: [
  { platform: 'luogu', problemId: 'P1', band: '易' },
  { platform: 'luogu', problemId: 'P4', band: '中' },
  { platform: 'luogu', problemId: 'P6', band: '难' },
] }, undefined)
check('★ 闭环：coach_verify 记过的题，coach_test 不写 verified 也能开',
  closX.ok === true, closX.reject)
check('★ 并且逐道标出是沿用的（三道都要，不能只认一道）',
  closX.ok === true && closX.problems.every((x) => x.verifiedReused === true),
  JSON.stringify(closX.problems.map((x) => `${x.problemId}:${x.verifiedReused}`)))
// 先判掉这张卷，才能开下一张（一次只开一张）—— 不然下面那条会**因为
// "上一张没判"被拒，看着像通过，其实拒的理由跟本关要验的完全无关。
const gClos = await grade.execute({
  results: [
    { problemId: 'P1', solved: true, minutes: 15 },
    { problemId: 'P4', solved: true, minutes: 25 },
    { problemId: 'P6', solved: true, minutes: 35 },
  ],
}, undefined)
check('夹具：闭环那张卷判掉了（不留 pending）', gClos.ok === true, gClos.reject)
// 防退化：台账里**没有**的题仍旧必须被拒 —— 「有台账」不等于「全放行」。
// ⚠️ P2/P3/P5 都不在台账里（上面只放了 P1/P4/P6），而且**一个 verified 都不带**
//    —— 第一版给 P2 带了 verified 又让 P4/P6 走沿用，三道全过、卷子直接开出来了，
//    于是这条断言假红、还顺手留下一张没人判的卷（后面的 22b 全跟着红）。
const closY = await test.execute({ node: '区间 DP', problems: [
  { platform: 'luogu', problemId: 'P2', band: '易' },
  { platform: 'luogu', problemId: 'P3', band: '中' },
  { platform: 'luogu', problemId: 'P5', band: '难' },
] }, undefined)
check('★ 防退化：台账里没有的题仍然要被拒（不是"有台账就全放行"）',
  closY.ok === false && closY.reject.includes('P2'), closY.reject.slice(0, 70))
check('★ 被拒就不许押卷（不然下一关会以"上一张没判"的形式红，指向完全不相干的地方）',
  p5api.load().pending === null, JSON.stringify(p5api.load().pending))
await new Promise((r) => fakeSite.close(r))

// ══════════════════════════════════════════════════════════════════
// 22. 补两笔欠账：判因落盘 + verified 带段位
// ══════════════════════════════════════════════════════════════════
// 这两笔是同一个目的：**让教练能自己看见"他弱在哪"**，而不是去扒提交记录猜。
//
//   判因落盘 → 知道"哪个知识点、错在哪一类"（不会 / 不熟 / 不认真）
//   verified 带段位 → 知道"当初是在什么难度上验证过的"
//
// 第二条为什么必要：「1600 分时验证过」不等于「2000 分还掌握」。
// 同一道区间 DP，1000 分段考入门转移，2000 分段考四边形不等式优化。
// 知识点没变，考法随分段变 —— 所以 verified 不该是个永久戳。
console.log('── 22. 判因落盘 ──')
const CODE5 = `int solve() {
  int n, k; cin >> n >> k;
  if (k > n - 1) { cout << "NO" << endl; return 0; }
  vector<int> temp;
  int cur = 1;
  for (int i = 1; i <= k; i++) cur += (i % 2 ? n - 1 : -(n - 1));
  cout << "YES" << endl;
  return 0;
}`
const EV5 = [{ quote: 'if (k > n - 1) { cout << "NO"', kind: 'wrong', why: '上界判反' }]
const diag5 = T5('coach_diagnose')
const d22 = await diag5.execute({
  code: CODE5, problem: 'P1', category: '不认真', node: '区间 DP',
  evidence: EV5, summary: '边界判反，不是不会构造',
}, undefined)
check('判因跑通', d22.ok === true, d22.reject)
check('★ 判因写进了 PROGRESS.yaml', progPath5().includes('diagnoses'),
  progPath5().includes('diagnoses') ? '' : '没写')
check('带上了分类和一句话判因',
  progPath5().includes('category: 不认真') && progPath5().includes('边界判反'),
  '')
check('带的证据引用了代码原文', progPath5().includes('if (k > n'), '')
// 同一个节点判两次，两次都要在 —— 这是弱点分析的证据链，不能被覆盖
await diag5.execute({
  code: CODE5, category: '不会', node: '区间 DP',
  evidence: EV5, summary: '第二次判因', problem: 'P4',
}, undefined)
check('★ 同一节点的多次判因会累加，不覆盖',
  (progPath5().match(/category: /g) || []).length >= 2,
  String((progPath5().match(/category: /g) || []).length))

console.log('── 22b. verified 带段位 ──')
// ⚠️ 这一句原先丢了返回值 —— 开卷被拒的话，下面几条会以"判卷结果不对"的形式
// 红，指向的地方完全不相干。开卷结果是夹具的一部分，必须钉住。
const open22 = await test.execute({ node: '线段树', problems: [
  { platform: 'luogu', problemId: 'P1', band: '易', verified: V },
  { platform: 'luogu', problemId: 'P4', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P6', band: '难', verified: V },
] }, undefined)
check('夹具：22b 那张卷开出来了', open22.ok === true, open22.reject)
const g22 = await grade.execute({
  results: [
    { problemId: 'P1', solved: true, minutes: 12 },
    { problemId: 'P4', solved: true, minutes: 22 },
    { problemId: 'P6', solved: true, minutes: 35 },
  ],
}, undefined)
check('全下 → 过', g22.outcome === 'passed', g22.outcome)
// 「验证于什么段位」= 他拿下的题里最高的那个 cfRating（P6 是 2300）
check('★ verifiedAt = 拿下的题里最高段位（2300）', g22.verifiedAt === 2300, String(g22.verifiedAt))
check('每道题都记了 cfRating（以后算复检要靠它）',
  g22.problems.every((p) => p.cfRating > 0),
  JSON.stringify(g22.problems.map((p) => p.cfRating)))
check('verifiedAt 落进了文件', progPath5().includes('verifiedAt'), '')

// 没过的时候不该有 verifiedAt —— 没证明过任何段位
await test.execute({ node: '线段树', problems: [
  { platform: 'luogu', problemId: 'P2', band: '易', verified: V },
  { platform: 'luogu', problemId: 'P5', band: '中', verified: V },
  { platform: 'luogu', problemId: 'P7', band: '难', verified: V },
] }, undefined)
const g22b = await grade.execute({
  results: [
    { problemId: 'P2', solved: true, minutes: 10 },
    { problemId: 'P5', solved: false, minutes: 30 },
    { problemId: 'P7', solved: false, minutes: 30 },
  ],
}, undefined)
check('没过 → verifiedAt 为 0（没证明过任何段位）',
  g22b.outcome === 'failed' && g22b.verifiedAt === 0, `${g22b.outcome}/${g22b.verifiedAt}`)

// ══════════════════════════════════════════════════════════════════
// 22c. coach_status 要看得到检测 / 判因的历史（后补的读口子）
// ══════════════════════════════════════════════════════════════════
// 在这之前这两个记录是**只写不读**的：只有网页读得出来给训练员看。
// 而「综合他的学习进度决定要不要检测」这条规则需要它们 ——
// 教练得知道「上次验是什么时候、结果如何、他最近老犯哪类错」，
// 不然"综合判断"是一句空话（规则写了也执行不了）。
console.log('── 22c. coach_status：检测 / 判因的历史 ──')
const st22 = await T5('coach_status').execute({}, undefined)
check('★ 检测记录报出来了（条数 + 明细）',
  st22.checkTotal >= 4 && st22.recentChecks.length > 0 &&
  st22.recentChecks.every((c) => c.nodeName && c.outcome),
  `total=${st22.checkTotal} 最近=${JSON.stringify(st22.recentChecks[0])}`)
check('★ 判因记录报出来了',
  st22.diagnoseTotal >= 2 && st22.recentDiagnoses.some((d) => d.category === '不认真'),
  `total=${st22.diagnoseTotal} ${JSON.stringify(st22.recentDiagnoses.slice(0, 2))}`)
check('★ 历史按日期倒序（最近的在前）',
  st22.recentChecks.every((c, i, a) => i === 0 || a[i - 1].date >= c.date) &&
  st22.recentDiagnoses.every((d, i, a) => i === 0 || a[i - 1].date >= d.date), '')
const st22txt = T5('coach_status').output.render({}, st22)[0].text
check('★ render 把历史摆出来（不是只报四个状态）',
  st22txt.includes('检测记录') && st22txt.includes('判因记录'),
  st22txt.split('\n').slice(-5).join(' / '))
check('render 提醒「该不该开卷是你的判断」', st22txt.includes('自己判断'), '')

// ══════════════════════════════════════════════════════════════════
// 23. 把两条轴用起来 —— tier（重不重要）+ entry（学不学得起）
// ══════════════════════════════════════════════════════════════════
// 到这一关为止，地图才有了回答「你现在该学什么」的能力：
//   之前它只会说「谁是谁的前置」——**允许**学什么
//   现在它会说「这个重不重要」+「什么水平学得起」——**合适**学什么
//
// 要验的两件事：
//   ① coach_next 直接后继为空（或全够不着）时，退到**前沿候选**，按 tier 排，
//      并且把「远超他水平」的直接滤掉 —— 否则 1200 分的人会被推去学树链剖分
//   ② coach_assign 允许指向**游标自己** —— 62% 的节点是末端，这是它们唯一的出路
console.log('── 23. tier + entry 用起来（临时地图 + 临时库）──')
const tmp6 = mkdtempSync(path.join(os.tmpdir(), 'coach-l6-'))
writeFileSync(path.join(tmp6, 'MAP.yaml'), `meta: { version: 1, node_count: 6 }
nodes:
  - id: 根
    name: 根
    domain: 测试
    depends: []
    tier: core
    entry: 1200
  - id: 叶子
    name: 叶子
    domain: 测试
    depends: [根]
    tier: core
    entry: 1300
  - id: 核心
    name: 核心
    domain: 测试
    depends: [根]
    tier: core
    entry: 1600
  - id: 中档
    name: 中档
    domain: 测试
    depends: [根]
    tier: normal
    entry: 1700
  - id: 冷门
    name: 冷门
    domain: 测试
    depends: [根]
    tier: rare
    entry: 1300
  - id: 够不着
    name: 够不着
    domain: 测试
    depends: [根]
    tier: normal
    entry: 2600
  - id: 更远
    name: 更远
    domain: 测试
    depends: [够不着]
    tier: core
    entry: 2800
`)
const d6 = new DatabaseSync(path.join(tmp6, 'training.db'))
d6.exec(`
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
`)
d6.close()
process.env.COACH_DATA_DIR = tmp6
process.env.COACH_DB = path.join(tmp6, 'training.db')
const mod6 = await import(`${INSTALLED}?fresh=l6`)
const reg6 = []
mod6.apply(mockCtx(reg6))
const T6 = (n) => reg6.find((t) => t.name === n)

// ── ① 末端节点：直接后继为空 → 退到前沿候选 ──
//
// 后来补的夹具：一个「在学」节点。兜底那条路是 214/349 个末端节点的
// **唯一**入口，而 AGENTS.md 第 8 条要求「接着放了没几天的 > 开全新的」——
// 那条判断在过去**没有任何依据**：兜底列表既不显示状态、也不显示放了多久。
writeFileSync(path.join(tmp6, 'PROGRESS.yaml'), `version: 1
nodes:
  核心:
    status: studying
    at: '2026-09-01'
`)
const n6 = await T6('coach_next').execute({ cursor: '叶子' }, undefined)
check('末端节点：直接后继为空', n6.candidates.length === 0, String(n6.candidates.length))
check('★ 退到了前沿候选（不是空手而归）', n6.frontier.length > 0,
  `${n6.frontier.length} 个`)
check('标明了用的是兜底模式', n6.fallbackUsed === true, String(n6.fallbackUsed))
// ★ 关键：够不着的别推给他。他 1800，够不着 entry 2600/2800 的
const sugIds = n6.frontier.map((s) => s.id)
check('★ 远超他水平的节点被滤掉（够不着不在）', !sugIds.includes('够不着'), sugIds.join(','))
check('前置没满足的也不推（更远不在）', !sugIds.includes('更远'), sugIds.join(','))
check('★ 按 tier 排：core 在 rare 前面',
  sugIds.indexOf('核心') < sugIds.indexOf('冷门'), sugIds.join(','))
check('兜底候选也带 entry（能被复核）',
  n6.frontier.every((s) => typeof s.entry === 'number'), '')

// ★ 兜底这条路的两条防回归 —— 它同时踩了「schema 缺字段」和
// 「render 不显示字段」两个坑，而且**两个都没被任何断言看见**（一个不递归、
// 一个只看内容不看形状）。
const sd6 = shapeDiff(T6('coach_next'), n6)
check('★ 兜底输出和 schema 递归对齐（多一个键 dsh 就拒收整个工具）',
  !sd6.extra.length && !sd6.missing.length, `多=${sd6.extra} 少=${sd6.missing}`)
const n6txt = T6('coach_next').output.render({}, n6)[0].text
check('★ 兜底列表显示状态和放了多久（第 8 条判断靠它）',
  /▶在学（\d+ 天前）/.test(n6txt),
  n6txt.split('\n').filter((l) => l.includes('核心')).join(' / ') || n6txt.split('\n').slice(-8).join(' / '))

// ── ② 有后继，但后继全都够不着 → 也要给退路 ──
const n6b = await T6('coach_next').execute({ cursor: '根' }, undefined)
check('游标有后继时，候选照常返回', n6b.candidates.length === 5, String(n6b.candidates.length))
check('候选带 tier 和 entry',
  n6b.candidates.every((c) => c.tier && typeof c.entry === 'number'),
  JSON.stringify(n6b.candidates.map((c) => `${c.id}:${c.tier}/${c.entry}`)))
check('★ 够不着的后继被标出来（reachable=false）',
  n6b.candidates.find((c) => c.id === '够不着')?.reachable === false,
  String(n6b.candidates.find((c) => c.id === '够不着')?.reachable))
check('够得着的标 true（核心 entry 1600 ≤ 1800+300）',
  n6b.candidates.find((c) => c.id === '核心')?.reachable === true, '')
check('有够得着的后继时**不用**兜底', n6b.fallbackUsed === false, String(n6b.fallbackUsed))

// ── ③ coach_assign 允许指游标自己 ──
console.log('── 23b. coach_assign：允许指向游标自己（末端节点的唯一出路）──')
const assign6 = T6('coach_assign')
// 游标自己的豁免是**有条件的** —— 这个节点得「讲过」。
// 原先那是无条件例外，于是游标停在一个从没讲过的新节点上时能整个绕过先讲闸门
// （小鲸在活进程里发现的洞）。所以这条路现在要按规矩带讲授段；
// 「没讲过就不给放行」的反向用例在 §38。
const a6 = await assign6.execute(
  { cursor: '叶子', node: '叶子', deliverable: '把线性基写出来贴给我', teachMinutes: 20 }, undefined)
check('★ 指游标自己（讲过）→ 放行', a6.accepted === true, a6.reject)
check('放行时说明这是「就在当前节点上做」', a6.selfTarget === true, String(a6.selfTarget))

// 但**已经验证过**的节点不许再当目标 —— 学完了就该往前走。
// verified 手标不了（这条口子被堵死了），所以夹具直接写进文件 ——
// 这里验的是 coach_assign 的行为，不是能不能手标。
writeFileSync(path.join(tmp6, 'PROGRESS.yaml'), `version: 1
cursor: 叶子
nodes:
  叶子:
    status: verified
`)
const a6b = await assign6.execute(
  { cursor: '叶子', node: '叶子', deliverable: '重学一遍' }, undefined)
check('★ 已经 verified 的节点 → 拒绝（学完了就往前走）',
  a6b.accepted === false && a6b.reject.includes('往前走'), a6b.reject)

// ── 23c. entry 不许静默缺失（需求 #4）──────────────────
//
// 事故：全图 349 个节点里只有 110 个有 entry。而渲染写的是
// `c.entry ? ' ≈'+c.entry : ''` —— **「没数据」和「够不着」长得一模一样**
// （都是不显示）。更坏的是 reachableOf 对没 entry 的**一律放行**，
// 于是这些点上面永远不会出现 ⚠️够不着，"没数据"很容易被读成"没问题、可以学"。
// AGENTS.md 要求「entry 高出他 rating 300 以上不推」—— 连数据都没有就没法判。
console.log('── 23c. entry 不许静默缺失 ──')
const tmp4 = mkdtempSync(path.join(os.tmpdir(), 'coach-entry-'))
writeFileSync(path.join(tmp4, 'MAP.yaml'), `meta: { version: 1, node_count: 4 }
nodes:
  - id: 根
    name: 根
    domain: 测试
    depends: []
    tier: core
    entry: 1200
  - id: 有数据
    name: 有数据
    domain: 测试
    depends: [根]
    tier: core
    entry: 2600
  - id: 没数据
    name: 没数据
    domain: 测试
    depends: [根]
    tier: rare
  - id: 也没数据
    name: 也没数据
    domain: 测试
    depends: [根]
    tier: normal
`)
writeFileSync(path.join(tmp4, 'PROGRESS.yaml'), 'version: 1\nnodes: {}\n')
process.env.COACH_DATA_DIR = tmp4
process.env.COACH_DB = path.join(tmp6, 'training.db')   // 复用 23 节的库（rating 1800）
const mod4 = await import(`${INSTALLED}?fresh=23c`)
const reg4 = []
mod4.apply(mockCtx(reg4))
const T4 = (n) => reg4.find((t) => t.name === n)

const nx4 = await T4('coach_next').execute({ cursor: '根' }, undefined)
const nx4txt = T4('coach_next').output.render({}, nx4)[0].text
check('★ 每个候选都带 hasEntry（不再靠 0 当"没数据"的哨兵）',
  nx4.candidates.length === 3 && nx4.candidates.every((c) => typeof c.hasEntry === 'boolean'),
  JSON.stringify(nx4.candidates.map((c) => `${c.id}:${c.hasEntry}`)))
check('★ 有 entry 的候选：hasEntry=true 且值正确',
  nx4.candidates.find((c) => c.id === '有数据')?.hasEntry === true,
  String(nx4.candidates.find((c) => c.id === '有数据')?.entry))
check('★ 没 entry 的候选：hasEntry=false', nx4.candidates.find((c) => c.id === '没数据')?.hasEntry === false)
check('★ 渲染里每个候选都有 entry 的呈现（有值给 ≈，没值明写"无数据"）',
  nx4txt.includes('≈2600') && (nx4txt.match(/entry 无数据/g) ?? []).length === 2,
  (nx4txt.match(/entry 无数据/g) ?? []).length + ' 处')
check('★ 候选行给出与 rating 的差（2600 − 1800 = +800）', nx4txt.includes('差 +800'),
  (nx4txt.match(/.*差 \+800.*/) ?? ['（没有）'])[0].slice(0, 80))
check('★ 缺数据的候选被点出来 + 给了下一步（别把"没数据"读成"够得着"）',
  nx4txt.includes('没有 entry 数据') && nx4txt.includes('coach_pool'),
  (nx4txt.match(/.*没有 entry 数据.*/) ?? ['（没有）'])[0].slice(0, 90))
check('★ 老行为不变：没 entry 的仍然放行（reachable=true，只是现在说得出来）',
  nx4.candidates.find((c) => c.id === '没数据')?.reachable === true)

// ══════════════════════════════════════════════════════════════════
// 24. 「已学集合」的语义
// ══════════════════════════════════════════════════════════════════
// 背景：coach_next / coach_assign 原先只展开**游标自己**的前置闭包，
// 训练员显式标过的几十个节点全当没看见 —— 他标了「位运算」，
// 教练还说「数位 DP 缺前置 位运算」。三个工具里只有 set_cursor 读了进度。
// 修法：抽一个 assumedLearned() 三家共用 =
//      闭包(你站的位置) ∪ 显式标为 学过/已验证 的节点（标记本身不展开）。
//
// 这一节**不碰真地图、不碰真进度**。第 6 / 12 节原先拿真实数据写断言，
// 训练员一标记前提就假了 —— 教训是「进度数据一有内容，写死的假设开始过期」。
// 所以这里用合成夹具，把三条口径钉死：
//   ① 学过 / 已验证 的标记必须被看见     ← 这次修的 bug 本体
//   ② 「在学」不算                       ← 开了头没达标，不能当地基
//   ③ 标记**不展开**它的前置             ← 他会 概率 DP ≠ 他学过 概率论
console.log('── 24. 已学集合的语义（合成夹具，三条口径）──')
const tmp7 = mkdtempSync(path.join(os.tmpdir(), 'coach-sem-'))
// 夹具形状照真实场景搭：工具（只有显式标记才能解锁）、缺料的（前置没标）、
// 概率论 / 概率 DP（未标 vs 在学/学过，验「不展开」）
writeFileSync(path.join(tmp7, 'MAP.yaml'), `meta: { version: 9, node_count: 8 }
nodes:
  - id: 基础
    name: 基础
    domain: 测试
    depends: []
  - id: 工具
    name: 工具
    domain: 测试
    depends: []
  - id: 未标工具
    name: 未标工具
    domain: 测试
    depends: []
  - id: 进阶
    name: 进阶
    domain: 测试
    depends: [基础, 工具]
  - id: 缺料的
    name: 缺料的
    domain: 测试
    depends: [基础, 未标工具]
  - id: 概率论
    name: 概率论
    domain: 测试
    depends: []
  - id: 概率 DP
    name: 概率 DP
    domain: 测试
    depends: [概率论]
  - id: 概率进阶
    name: 概率进阶
    domain: 测试
    depends: [概率 DP]
`)
const semProg = (tail) => `version: 1
cursor: 基础
updated: 2026-09-13
nodes:
  基础:
    status: verified
  工具:
    status: learned
${tail}`
const prog7 = path.join(tmp7, 'PROGRESS.yaml')
// 概率 DP 标「在学」—— 真实数据里常这么躺着
writeFileSync(prog7, semProg(`  概率 DP:
    status: studying
`))
process.env.COACH_DATA_DIR = tmp7
process.env.COACH_DB = path.join(tmp6, 'training.db')   // 复用 23 节的临时库，不碰真库
const mod7 = await import(`${INSTALLED}?fresh=sem`)
const reg7 = []
mod7.apply(mockCtx(reg7))
const T7 = (n) => reg7.find((t) => t.name === n)

const n7 = await T7('coach_next').execute({ cursor: '基础' }, undefined)
const cand7 = (id) => n7.candidates.find((c) => c.id === id)
const assumed7 = new Set(n7.assumedLearned)

// ① 标记要被看见：游标的闭包只覆盖「基础」，「工具」全靠 learned 标记
check('★ ① 显式标记「工具」(learned) 进了已学集合',
  assumed7.has('工具'), n7.assumedLearned.join(' / '))
check('★ ① 「进阶」两道前置（闭包 + 标记）都满足 → 可开',
  cand7('进阶')?.ready === true,
  cand7('进阶') ? `missing=${JSON.stringify(cand7('进阶').missing)}` : '不在候选里')
// 真缺的照旧挡住 —— 别把「标记被看见」修成「什么都放行」
check('缺前置的照旧挡，并指名缺哪个',
  cand7('缺料的')?.ready === false && cand7('缺料的')?.missing?.includes('未标工具'),
  cand7('缺料的') ? `missing=${JSON.stringify(cand7('缺料的').missing)}` : '不在候选里')

// ② 「在学」不算已学
check('★ ② 「概率 DP」标的是 studying → 不进已学集合',
  !assumed7.has('概率 DP'), n7.assumedLearned.join(' / '))
// set_cursor 的警告（种子 = 旧游标）也要跟着这个口径
const set7 = await T7('coach_set_cursor').execute({ node: '概率进阶' }, undefined)
check('★ ② set_cursor 警告：目标的前置只是在学 → 如实报缺',
  set7.ok === true && set7.prereqMissing.includes('概率 DP'),
  JSON.stringify(set7.prereqMissing))

// coach_assign 的 ④ 校验走同一份集合
const assign7 = T7('coach_assign')
const a7 = await assign7.execute(
  { cursor: '基础', node: '进阶', deliverable: '贴代码', teachMinutes: 20 }, undefined)
check('★ ① coach_assign 也看得见标记（这次修的 bug 本体）', a7.accepted === true, a7.reject)
const a7b = await assign7.execute(
  { cursor: '基础', node: '缺料的', deliverable: '贴代码' }, undefined)
check('★ coach_assign 缺前置照旧拒绝，并指名缺什么',
  a7b.accepted === false && a7b.reject.includes('未标工具'), a7b.reject)

// ③ 标记不展开前置：把 概率 DP 改成 learned —— 他学过概率 DP，
//    但「概率论」他自己没标（真实数据里正是这个形状：DP 会，前置没学）
writeFileSync(prog7, semProg(`  概率 DP:
    status: learned
`))
const n7b = await T7('coach_next').execute({ cursor: '基础' }, undefined)
const assumed7b = new Set(n7b.assumedLearned)
check('★ ③ 标记「概率 DP」之后它自己进了已学集合',
  assumed7b.has('概率 DP'), n7b.assumedLearned.join(' / '))
check('★ ③ 但它的前置「概率论」**没有**被顺带假定 —— 学过 A ≠ 学过 A 的前置',
  !assumed7b.has('概率论'), n7b.assumedLearned.join(' / '))

// ══════════════════════════════════════════════════════════════════
// 25. /coach 路由 —— 技能树页面由插件自己 serve
// ══════════════════════════════════════════════════════════════════
// 页面原先挂在 Python 的 serve_map.py 上（另一个要照看的进程、和 dsh 不同源），
// 现在由插件的 host 半边自己 serve。这一节验搬运之后那条通道是通的，
// 而且**只对本机开放**（页面里是全部学习进度）。
//
// 不满足于「注册了路由」：造一对 req/res 桩把 handler **真跑一遍**。
// 只断言"注册了"等于没测 —— 那是"看起来测过了"的典型形状。
// 全程在临时目录跑（COACH_DATA_DIR 指过去），不碰真的 PROGRESS.yaml。
console.log('── 25. /coach 路由（临时目录）──')
const tmp8 = mkdtempSync(path.join(os.tmpdir(), 'coach-pages-'))
writeFileSync(path.join(tmp8, 'MAP.yaml'), mini(''))
writeFileSync(path.join(tmp8, 'skilltree.html'), '<html>stub 技能树</html>')
process.env.COACH_DATA_DIR = tmp8
const mod8 = await import(`${INSTALLED}?fresh=8`)

const routes = []
const gateSeen = []
mod8.apply({
  tools: { register: () => {} },
  inject: (_deps, cb) => cb({
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    effect: (fn) => fn(),
    // dsh 的闸：connection 服务。真实现是
    //   isTrustedApiRequest(Host) ? (cookie 校验通过 ? undefined : 401) : 403
    // 注意它**看 Host + cookie，不看 remoteAddress** —— 所以这里也按那个语义桩。
    get: (n) => (n === 'connection' ? {
      requestRejection: (req) => {
        const h = String(req.headers?.host ?? '')
        gateSeen.push(h)
        return h.startsWith('evil') ? 403 : h.startsWith('noauth') ? 401 : undefined
      },
    } : undefined),
  }),
  on: () => {},                 // 钩子：本节只测路由，钩子不参与（第 32 节专测）
})
const route = routes.find((r) => r.path === '/coach')
check('注册了 /coach 路由（prefix）', route?.kind === 'prefix',
  JSON.stringify(routes.map((r) => `${r.kind}:${r.path}`)))

// ── req/res 桩：够 handler 用的最小面 ──
// 写成「传 route 进来」而不是闭包捕获，因为下面还要拿另一个 mod 的 route 跑回退路径。
const callOn = (rt) => async (method, url, body, opts = {}) => {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  const req = {
    method, url,
    headers: { host: opts.host ?? '127.0.0.1:3080' },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
    destroy() {},
  }
  const res = {
    status: 0, headers: {}, body: '',
    writeHead(code, headers) { this.status = code; this.headers = headers ?? {} },
    end(buf) {
      if (buf !== undefined) this.body = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
    },
  }
  await rt.handler(req, res)
  return res
}
const call = callOn(route)

const page = await call('GET', '/coach/skilltree.html')
check('GET 页面 → 200 且内容对', page.status === 200 && page.body.includes('stub 技能树'),
  `status=${page.status}`)
check('内容类型是 html', String(page.headers['content-type'] ?? '').includes('text/html'),
  page.headers['content-type'])

const redirect = await call('GET', '/coach')
check('GET /coach → 302 到页面（不给目录列表）',
  redirect.status === 302 && redirect.headers.location === '/coach/skilltree.html',
  `status=${redirect.status} location=${redirect.headers.location}`)

check('★ 闸走了 dsh 的 connection 服务（不是自己手写那套）',
  gateSeen.length > 0, `requestRejection 被调了 ${gateSeen.length} 次`)
const rebound = await call('GET', '/coach/skilltree.html', undefined, { host: 'evil.example.com' })
check('★ Host 不是本机（DNS rebinding）→ 403', rebound.status === 403, `status=${rebound.status}`)
const needAuth = await call('GET', '/coach/skilltree.html', undefined, { host: 'noauth.local:3080' })
check('★ 没登录 → 401，且告知去哪拿钥匙', needAuth.status === 401 && /网址|钥匙/.test(needAuth.body),
  `status=${needAuth.status} body=${needAuth.body.slice(0, 40)}`)

const empty = JSON.parse((await call('GET', '/coach/api/progress')).body)
check('GET 空进度 → ok:true 且没节点', empty.ok === true && Object.keys(empty.nodes ?? {}).length === 0,
  JSON.stringify(empty).slice(0, 120))

const marked = await call('POST', '/coach/api/progress',
  JSON.stringify({ op: 'mark', node: 'A', status: 'learned' }))
check('POST 标记学过', marked.status === 200 && JSON.parse(marked.body).ok === true,
  marked.body.slice(0, 140))

const afterRead = JSON.parse((await call('GET', '/coach/api/progress')).body)
check('★ 写完立刻读得到（同一份真相，不是各存一份）',
  afterRead.nodes?.A?.status === 'learned', JSON.stringify(afterRead.nodes))

// 这条是**跨层的**：页面那条通道和教练工具必须守同一条规矩。
// 两处各写一遍校验就迟早会分家 —— 所以它俩现在共用 markStatus。
const blocked = await call('POST', '/coach/api/progress',
  JSON.stringify({ op: 'mark', node: 'A', status: 'verified' }))
check('★ 手标 verified 照样走不通（和 coach_mark 同一条规矩）',
  blocked.status === 400 && JSON.parse(blocked.body).ok === false, blocked.body.slice(0, 140))

const fakeNode = await call('POST', '/coach/api/progress',
  JSON.stringify({ op: 'mark', node: '不存在的节点', status: 'learned' }))
check('不存在的节点 → 400（不是静默成功）', fakeNode.status === 400, fakeNode.body.slice(0, 120))

const moved = await call('POST', '/coach/api/progress', JSON.stringify({ op: 'cursor', node: 'B' }))
check('POST 移游标', moved.status === 200 && JSON.parse(moved.body).cursor === 'B',
  moved.body.slice(0, 120))

const badOp = await call('POST', '/coach/api/progress', JSON.stringify({ op: '瞎写' }))
check('未知 op → 400', badOp.status === 400, badOp.body.slice(0, 120))
const badBody = await call('POST', '/coach/api/progress', '这不是 JSON')
check('请求体不是 JSON → 400（不炸）', badBody.status === 400, badBody.body.slice(0, 120))
const badPath = await call('GET', '/coach/别的什么')
check('未知路径 → 404', badPath.status === 404, `status=${badPath.status}`)

check('★ 进度真落到了磁盘（不是内存里演一遍）',
  readFileSync(path.join(tmp8, 'PROGRESS.yaml'), 'utf8').includes('status: learned'))

// 页面文件不在时要说清楚怎么办，不能给个白屏
rmSync(path.join(tmp8, 'skilltree.html'))
const gone = await call('GET', '/coach/skilltree.html')
check('页面文件不在 → 404 且指名 render_skilltree.py',
  gone.status === 404 && gone.body.includes('render_skilltree.py'), gone.body.slice(0, 140))

// ── 回退路径：老 dsh（没有 connection 服务）──
// 这条路是**弱化版**：只保证「本机」，保证不了「登录过」——
// 但老版本本来就没有登录这回事，所以够用。留着它是因为插件得能在
// 没有 connection 的环境里跑（headless 之类）。
const tmp10 = mkdtempSync(path.join(os.tmpdir(), 'coach-gate-fallback-'))
writeFileSync(path.join(tmp10, 'MAP.yaml'), mini(''))
writeFileSync(path.join(tmp10, 'skilltree.html'), '<html>stub</html>')
process.env.COACH_DATA_DIR = tmp10
const mod10 = await import(`${INSTALLED}?fresh=10`)
const routes10 = []
mod10.apply({
  tools: { register: () => {} },
  inject: (_d, cb) => cb({
    webServer: { register: (r) => { routes10.push(r); return () => {} } },
    effect: (fn) => fn(),
    // 故意**不给 get** —— 模拟没有 connection 服务的老版本
  }),
  on: () => {},                 // 钩子不参与本节（第 32 节专测）
})
const call10 = callOn(routes10.find((r) => r.path === '/coach'))
const far = await call10('GET', '/coach/skilltree.html', undefined, { remote: '192.168.1.9' })
check('★ 回退路径：没有 connection 服务时，远机照样被挡', far.status === 403, `status=${far.status}`)
const near = await call10('GET', '/coach/skilltree.html')
check('回退路径：本机放行', near.status === 200, `status=${near.status}`)

// ══════════════════════════════════════════════════════════════════
// 26. 客户端那一半（lib/client.js）
// ══════════════════════════════════════════════════════════════════
// 浏览器端代码在 node 里跑不起来 —— 但**形状**验得了，而踩过的坑全在形状上：
//   · factory 忘了 return {apply, inject} → 槽位系统拿到 undefined，
//     报错是 "received undefined"，跟根因隔了十万八千里（踩过一次）
//   · __ModuleLoader__.load 的 id 和包名对不上 → 静默不注册
//   · 槽位名打错一个字 → 静默不显示
// 这三种在浏览器里**都不报错**。所以造一个最小的浏览器壳把它整个跑一遍：
// 假 window 接住 load、假 require 顶掉 react、假 document 接住样式注入。
// 渲染效果验不了（那要靠 CDP 真点），但"挂没挂上去"在这里就见了分晓。
console.log('── 26. 客户端插件（lib/client.js）──')
const vm = await import('node:vm')
const clientSrc = readFileSync(`${SOURCE_DIR}\\lib\\client.js`, 'utf8')

let spec = null
const styleTags = []
const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { spec = s } } },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el) => styleTags.push(el) },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  console,
}
try {
  vm.runInNewContext(clientSrc, sandbox, { filename: 'client.js' })
  check('语法解析通过', true)
} catch (err) {
  check('语法解析通过', false, err.message)
}
check('★ 调了 __ModuleLoader__.load', spec !== null)
check('★ 注册 id 和包名逐字相同（对不上会静默不注册）',
  spec?.id === 'acmer-coach', `id=${spec?.id}`)
check('factory 是函数', typeof spec?.factory === 'function')

// react 用桩顶掉：这一节验的是**形状**，不是渲染。
// 连 require 了别的模块都会抛 —— 多一个依赖在这里就当场现形。
const fakeRequire = (name) => {
  if (name === 'react') return { useState: (v) => [v, () => {}], useEffect: () => {}, Fragment: () => null }
  if (name === 'react/jsx-runtime') return { jsx: (...a) => a, jsxs: (...a) => a }
  if (name === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`client.js require 了没桩的模块：${name}`)
}
let api = null
try {
  api = spec.factory(fakeRequire)
  check('factory 跑得起来', true)
} catch (err) {
  check('factory 跑得起来', false, err.message)
}
check('★ factory 返回 {apply, inject}（忘了 return 就是 received undefined）',
  typeof api?.apply === 'function' && Array.isArray(api?.inject),
  JSON.stringify(api && Object.keys(api)))

const slots = []
const clientCtx = {
  slots: {
    inject: (_name, cb) => { cb() },
    register: (desc, comp) => { slots.push({ desc, comp }); return () => {} },
  },
}
try {
  api.apply(clientCtx)
  check('apply 跑得起来', true)
} catch (err) {
  check('apply 跑得起来', false, err.message)
}
check('★ 挂在 conversation.session.header.utilities 上（打错一个字就静默不显示）',
  slots.some((s) => s.desc?.name === 'conversation.session.header.utilities'),
  JSON.stringify(slots.map((s) => s.desc?.name)))
check('注册项带 id（槽位系统的去重键）',
  slots.length > 0 && slots.every((s) => typeof s.desc?.id === 'string' && s.desc.id.length > 0),
  JSON.stringify(slots.map((s) => s.desc?.id)))
check('注册项给了组件（不是 undefined）', slots.every((s) => typeof s.comp === 'function'))
check('样式注入了（浮层没样式就是一块白板）', styleTags.length === 1, `${styleTags.length} 个`)
check('inject 声明了 slots 服务', api.inject.includes('slots'), JSON.stringify(api.inject))

// 防回归：弹层必须 portal 到 body。就地渲染会被 header 的 transform 抓住
// （transform 非 none 的祖先 = fixed 后代的包含块），整个面板跑出屏幕 ——
// CDP 实测 y=-340，「点了什么都不出现」。源码上只差一个词，症状却完全不像。
// 正则用 [\s\S]{0,200}? 不是 [^)]* —— createPortal 的第一个参数里就有 `)`
// （jsx(...) 那层括号），[^)]* 会当场匹配失败。写错的是断言不是代码，
// 这种红比没测更费时间，记在这里。
check('★ 弹层 portal 到 body（就地渲染会被 header 的 transform 抓走）',
  /createPortal\([\s\S]{0,200}?document\.body/.test(clientSrc))

// ══════════════════════════════════════════════════════════════════
// 27. 节点日期 `at` —— 「什么时候变成这个状态的」
// ══════════════════════════════════════════════════════════════════
// 这个字段是后加的。用途是让教练能问「这个『在学』放了几天了」——
// 没有它，排序只能瞎猜。语义是**变成这个状态的时间**，不是"最后点它"：
// 当后者用的话，重复点同一个状态就刷成今天，「放了 12 天」永远算不出来。
// 这条差别在当天写当天测是看不出来的（都是今天），所以要把夹具改成过去的
// 日期才能验——这正是"测试要能失败"。
console.log('── 27. 节点日期 at（临时目录）──')
const tmp9 = mkdtempSync(path.join(os.tmpdir(), 'coach-at-'))
writeFileSync(path.join(tmp9, 'MAP.yaml'), mini(''))
process.env.COACH_DATA_DIR = tmp9
const mod9 = await import(`${INSTALLED}?fresh=9`)
const reg9 = []
mod9.apply(mockCtx(reg9))
const mark9 = reg9.find((t) => t.name === 'coach_mark')
const prog9 = path.join(tmp9, 'PROGRESS.yaml')
const read9 = () => readFileSync(prog9, 'utf8')
const atLines = () => read9().split('\n').filter((l) => l.includes('at:')).map((l) => l.trim()).join(' | ')
const todayStr = new Date().toLocaleDateString('sv-SE')   // sv-SE 恰好是 YYYY-MM-DD

await mark9.execute({ node: 'A', status: 'learned' }, undefined)
check('标记后写上了日期', read9().includes(`at: ${todayStr}`), atLines())

// 摆一个"很久以前"的日期，这样"没被刷新"才验得出来
writeFileSync(prog9, read9().replace(`at: ${todayStr}`, 'at: 2020-01-01'))
check('夹具生效（日期已改成 2020-01-01）', read9().includes('at: 2020-01-01'), atLines())

await mark9.execute({ node: 'A', status: 'learned' }, undefined)
check('★ 重复标**同一状态**，日期不动 —— 否则「放了几天」永远算不出来',
  read9().includes('at: 2020-01-01'), atLines())

await mark9.execute({ node: 'A', status: 'studying' }, undefined)
check('★ 状态**真的变了**，日期更新成今天', read9().includes(`at: ${todayStr}`), atLines())

// 存量数据（早先标的那批没有这个字段）得能补上
writeFileSync(prog9, read9().replace(/\n    at: .*/, ''))
check('夹具生效（把 at 删了）', !read9().includes('at:'), atLines())
await mark9.execute({ node: 'A', status: 'studying' }, undefined)
check('★ 老数据（没 at）重复标也要补上日期，不能永远显示"无日期"',
  read9().includes(`at: ${todayStr}`), atLines())

// ── 日期要**报给**小鲸，不是拿它排序 ──
// 排序是 LLM 的判断（原则 2；index.js 里 09-12 撤掉 unlocks 排序就是这条）。
// 但判断的前提是看得见数据 —— 以前它只看得见「▶在学」，分不出昨天开的还是三周前开的。
writeFileSync(prog9, 'version: 1\ncursor: A\nnodes:\n  B:\n    status: studying\n    at: 2026-01-01\n')
const next9 = reg9.find((t) => t.name === 'coach_next')
const n9 = await next9.execute({ cursor: 'A' }, undefined)
const b9 = n9.candidates.find((c) => c.id === 'B')
check('★ 候选带上 at（小鲸看得见日期了）', b9?.at === '2026-01-01',
  JSON.stringify(b9 && { id: b9.id, at: b9.at }))
const txt9 = next9.output.render({}, n9)[0].text
check('★ 渲染成「N 天前」（分得出昨天开的还是三周前开的）',
  /▶在学（\d+ 天前）/.test(txt9), (txt9.match(/▶在学[^\s]*/) ?? ['（没匹配到）'])[0])

// ══════════════════════════════════════════════════════════════════
// 28. 日程表 SCHEDULE.yaml 与它的 API
// ══════════════════════════════════════════════════════════════════
// 三级数据写的人不同：busy 是他手标的，planned 是教练排的（固化不重排），
// actual 是实际用时（校准真实速度的唯一来源）。
console.log('── 28. 日程表（临时目录）──')
const tmp12 = mkdtempSync(path.join(os.tmpdir(), 'coach-sched-'))
writeFileSync(path.join(tmp12, 'MAP.yaml'), mini(''))
process.env.COACH_DATA_DIR = tmp12
const mod12 = await import(`${INSTALLED}?fresh=12`)
const routes12 = []
mod12.apply({
  tools: { register: () => {} },
  inject: (_d, cb) => cb({
    webServer: { register: (r) => { routes12.push(r); return () => {} } },
    effect: (fn) => fn(),
    get: () => undefined,          // 不给 connection -> 走回退（本机放行）
  }),
  on: () => {},                 // 钩子不参与本节（第 32 节专测）
})
const call12 = callOn(routes12.find((r) => r.path === '/coach'))
const putSched = async (date, field, value) => {
  const r = await call12('POST', '/coach/api/schedule', JSON.stringify({ date, field, value }))
  return { status: r.status, body: JSON.parse(r.body) }
}

const sc0 = JSON.parse((await call12('GET', '/coach/api/schedule')).body)
check('刚开始是空的', sc0.ok === true && Object.keys(sc0.days).length === 0,
  JSON.stringify(sc0).slice(0, 80))

const w1 = await putSched('2026-09-14', 'busy', [{ from: '09:00', to: '12:00', label: '上课' }])
check('写一段 busy', w1.status === 200 && w1.body.count === 1, JSON.stringify(w1.body))
const sc1 = JSON.parse((await call12('GET', '/coach/api/schedule')).body)
check('★ 写完读得到（同一份真相）',
  sc1.days['2026-09-14']?.busy?.[0]?.label === '上课', JSON.stringify(sc1.days).slice(0, 120))

const badDate = await putSched('9月14日', 'busy', [])
check('★ 日期格式不对 → 400', badDate.status === 400, badDate.body.reject)
// 改过路：这条**本来测的就是 setScheduleField 的白名单**，
// 不是页面通道。页面通道现在多了一层"字段分权"闸（见下面 planned 那几条），
// 拿它测白名单会撞在分权闸上，测不到底下那一层。所以直连那个函数。
const badField = mod12.progressApi.setSchedule('2026-09-14', 'busy2', [])
check('★ 字段不在白名单 → 拒（不静默写进真相源）', badField.ok === false, badField.reject)
const badValue = await putSched('2026-09-14', 'busy', '不是数组')
check('★ 值不是数组 → 400', badValue.status === 400, badValue.body.reject)

await putSched('2026-09-14', 'busy', [])
const sc2 = JSON.parse((await call12('GET', '/coach/api/schedule')).body)
check('★ 传空数组 → 这一项消失（不留 busy: [] 这种空壳）',
  sc2.days['2026-09-14'] === undefined, JSON.stringify(sc2.days))

// ⚠️ 后来翻过来了。
//
// 这里原来是用页面通道写 `planned` 并断言"真的落到 SCHEDULE.yaml"——
// **测试给这扇门发了通行证**，而隔壁第 29 节的注释写着「planned 只能从
// coach_plan 进来，这节验的就是那扇门守得严不严」。三边说三套。
// 现在页面通道按字段分权：busy / actual 放行（那是他报的事实），
// planned 一律 403。测试跟着守门的方向走。
const pagePlanned = await putSched('2026-09-15', 'planned',
  [{ from: '20:00', to: '21:00', node: 'A', blocks: [] }])
check('★ 页面通道写 planned → 403（计划只能从 coach_plan 进来）',
  pagePlanned.status === 403, `${pagePlanned.status} ${JSON.stringify(pagePlanned.body.reject)}`)

const pageActual = await putSched('2026-09-16', 'actual',
  [{ node: 'A', plannedMin: 60, actualMin: 95, independent: false }])
check('页面通道写 actual 放行（实际用时是他报的事实，不是计划）',
  pageActual.status === 200, `${pageActual.status}`)

const raw12 = readFileSync(path.join(tmp12, 'SCHEDULE.yaml'), 'utf8')
check('★ actual 真的落到 SCHEDULE.yaml', raw12.includes('actualMin'))
check('★ 被拒的 planned 一个字都没写进真相源（拒绝必须是全有或全无）',
  !/planned:/.test(raw12), (raw12.match(/.*planned.*/g) ?? ['（没有 planned 行）']).join(' | '))
check('文件头还在（没被 YAML dump 冲掉）', raw12.includes('唯一真相源'),
  raw12.split('\n')[1]?.slice(0, 40))

// ══════════════════════════════════════════════════════════════════
// 29. 排块：coach_schedule（读）+ coach_plan（写）
// ══════════════════════════════════════════════════════════════════
// **排块是教练的活**。页面上只给他标 busy 的口子，
// planned 只能从 coach_plan 进来。这一节验的就是那扇门守得严不严 ——
// 门松了，他会照着一张排错的表做一整天，而错在哪他当时看不出来。
//
// 日期不能用写死的常量：工具校验的是「今天 ~ 今天+6」，
// 写死一个日期过两天就自动变成"已过去"，测试会莫名其妙开始红。
console.log('── 29. 排块（临时目录）──')
const tmp13 = mkdtempSync(path.join(os.tmpdir(), 'coach-plan-'))
writeFileSync(path.join(tmp13, 'MAP.yaml'), mini(''))
process.env.COACH_DATA_DIR = tmp13
const mod13 = await import(`${INSTALLED}?fresh=13`)
const reg13 = []
mod13.apply(mockCtx(reg13))
const byName13 = new Map(reg13.map((t) => [t.name, t]))
const sched = mod13.schedApi
const planT = byName13.get('coach_plan')
const schedT = byName13.get('coach_schedule')

const SP2 = (n) => String(n).padStart(2, '0')
const sd = (off) => {
  const d = new Date()
  d.setDate(d.getDate() + off)
  return `${d.getFullYear()}-${SP2(d.getMonth() + 1)}-${SP2(d.getDate())}`
}
const TODAY = sd(0)
const D = [0, 1, 2, 3, 4, 5, 6].map(sd)
const setBusy = (date, list) => mod13.progressApi.setSchedule(date, 'busy', list)
const plannedOf = (date) => mod13.progressApi.loadSchedule().days?.[date]?.planned

check('注册了 coach_schedule / coach_plan', Boolean(schedT) && Boolean(planT))

// ── 网格范围必须和页面模板一致 ──
// 这条是「两处真相」的防线。不一致时排块照样成功（host 说了算），
// 但页面画不出来 —— 而"排了看不见"比"排不进去"更糟，他会以为工具坏了。
const tplSrc = readFileSync(
  path.join(SOURCE_DIR, 'coach', 'skilltree_template.html'), 'utf8')
const tplGrid = /const HOUR_FROM = (\d+), HOUR_TO = (\d+)/.exec(tplSrc)
check('★ 网格范围和页面模板逐字一致（不一致 = 排了块页面画不出来）',
  Boolean(tplGrid) && Number(tplGrid[1]) === sched.FROM_H && Number(tplGrid[2]) === sched.TO_H,
  tplGrid ? `页面 ${tplGrid[1]}-${tplGrid[2]} vs host ${sched.FROM_H}-${sched.TO_H}` : '模板里没有 HOUR_FROM')

// 块型短名也得是同一套。对不上时页面拿 id 兜底显示，不崩，
// 但那个块看着就像坏了 —— 这种"不报错的坏"正是要拿测试盯住的。
const tplKindBlock = /const KIND_NAME = \{([^}]*)\}/.exec(tplSrc)
const tplKinds = {}
if (tplKindBlock) {
  for (const m of tplKindBlock[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) tplKinds[m[1]] = m[2]
}
check('★ 块型短名和 host 逐字一致',
  Object.keys(sched.kinds).every((k) => tplKinds[k] === sched.kinds[k].name),
  Object.keys(sched.kinds).map((k) =>
    `${k}: 页面「${tplKinds[k] ?? '没有'}」/ host「${sched.kinds[k].name}」`).join('　'))

// 排了块，页面上得真画出来 —— 不然计划只存在于 YAML 和对话里。
check('★ 页面有 planned 的渲染（排完看得见）',
  tplSrc.includes('class="pbar') && /day\.planned/.test(tplSrc),
  `pbar=${tplSrc.includes('class="pbar')} 读 planned=${/day\.planned/.test(tplSrc)}`)

// ── 读：给的是**整张表**，不是"还剩多少" ──
//
// 空闲/容量不再给教练看（排多少是他的判断），工具输出里
// 那几个字段一起撤了。所以这一节拆成两件事：
//   ① 钉住「工具不再返回空闲/容量」—— 撤了的东西别偷偷回来
//   ② 那几条拿真 bug 换来的边界，**改成直接验纯函数** ——
//      函数还在（退位不删，`schedApi` 还导着），覆盖不能跟着字段一起丢
const o0 = sched.scheduleOverview(1, TODAY)
check('★ 日程输出不再带空闲/容量（容量校验撤了）',
  !('free' in o0.days[0]) && !('freeMin' in o0.days[0]) &&
  !('capMin' in o0.days[0]) && !('leftMin' in o0.days[0]),
  Object.keys(o0.days[0]).join(','))
check('空日程：整天都是空闲', sched.freeMinutes({}) === 960, String(sched.freeMinutes({})))

// 11:00-12:00 完全被 09:00-13:00 包住。合并时用 `cur = b.z` 而不是 max，
// 游标会**倒退**回 12:00，于是 12:00-13:00 被算成空闲 —— 凭空多出一小时。
const mergedF = sched.freeMinutes({ busy: [
  { from: '09:00', to: '13:00' }, { from: '11:00', to: '12:00' }] })
check('★ 重叠的忙事合并（被包住的那段不该再算成空闲）',
  mergedF === 720, `空闲 ${mergedF}，应为 720（960−240）`)

// 越界的忙事按窗口夹住：7:00 的课占的就是 8:00-9:00
const clamped = sched.freeSlots({ busy: [{ from: '07:00', to: '09:00' }] })
check('★ 越界的忙事按窗口夹住（7:00 的课占的就是 8:00-9:00）',
  clamped.length === 1 && clamped[0].a === 9 * 60,
  JSON.stringify(clamped))

// "24:00" 是页面拖到最底下时写出来的结束时间。host 不认它的话，
// 「23:00–24:00 有事」整段会被静默丢掉 —— 空闲里凭空多一小时，
// 而教练正好会把唯一那个块排进去。这条是拿真 bug 换来的（29 节首跑抓到的）。
const lateDay = { busy: [{ from: '23:00', to: '24:00' }] }
check('★ "24:00" 当结束时间要认（页面拖到底就是这个值）',
  sched.freeMinutes(lateDay) === 900 &&
  sched.freeSlots(lateDay).at(-1).z === 23 * 60,
  `空闲 ${sched.freeMinutes(lateDay)}，末段到 ${sched.freeSlots(lateDay).at(-1)?.z}（分钟数）`)
setBusy(TODAY, [])

// 时间轴还是完整的（"整张表"就是这个）：他标的忙事必须原样在里面
setBusy(TODAY, [{ from: '09:00', to: '11:30', label: '上选修课' }])
const oAxis = sched.scheduleOverview(1, TODAY)
check('★ 日程带完整时间轴（忙事 + 已排的块都在）',
  oAxis.days[0].busy.length === 1 && oAxis.days[0].busy[0].label === '上选修课' &&
  oAxis.days[0].busy[0].from === '09:00',
  JSON.stringify(oAxis.days[0].busy))
setBusy(TODAY, [])

const o3 = sched.scheduleOverview(10, sd(-2))
check('过去的日子标 past 且排不了', o3.days[0].state === 'past' && o3.days[0].plannable === false)
const o4 = sched.scheduleOverview(10, TODAY)
check('今天是 today 且能排', o4.days[0].state === 'today' && o4.days[0].plannable === true)
check('★ 窗口边界：+6 能排、+7 不能',
  o4.days[6].plannable === true && o4.days[7].plannable === false,
  `+6=${o4.days[6].plannable} +7=${o4.days[7].plannable}`)

// ── 写：正常排 ──
const p1 = sched.planDay(D[0], [{ from: '19:30', kind: 'cycle', node: 'A' }])
check('排一个循环块', p1.ok === true, p1.reject)
check('结束时间 = 起点 + 60（时长是常量，不由调用方给）', p1.planned?.[0]?.to === '20:30',
  JSON.stringify(p1.planned?.[0]))
check('★ 真落盘了（不是内存里演一遍）', plannedOf(D[0])?.[0]?.from === '19:30',
  JSON.stringify(plannedOf(D[0])))

// ── 写：五道硬拦 ──
setBusy(D[1], [{ from: '19:00', to: '21:30', label: '上选修课' }])
const hit1 = sched.planDay(D[1], [{ from: '19:30', kind: 'cycle', node: 'A' }])
check('★ 压在忙事上 → 拒（那段时间他人在别处）',
  hit1.ok === false && hit1.reject.includes('上选修课'), hit1.reject)

// 空闲 09:00-12:20 = 200 分钟，三个循环块 180 分钟 —— 放得下。
// 早先这条会被「容量 = 空闲 × 0.75 = 150」拦掉；那条
// 硬校验：排多排少是教练的判断，工具只拦物理上不可能的。
setBusy(D[2], [
  { from: '08:00', to: '09:00', label: '早课' },
  { from: '12:20', to: '24:00', label: '一天剩下的' },
])
const over = sched.planDay(D[2], [
  { from: '09:00', kind: 'cycle', node: 'A' },
  { from: '10:00', kind: 'cycle', node: 'B' },
  { from: '11:00', kind: 'cycle', node: 'C' },
])
check('★ 排得下就放行（容量校验撤了，排多排少归教练）',
  over.ok === true, over.reject)

const c3 = sched.planDay(D[3], [
  { from: '09:00', kind: 'cycle', node: 'A' },
  { from: '09:30', kind: 'review', node: 'B' },
])
check('★ 块和块叠在一起 → 拒', c3.ok === false && c3.reject.includes('叠'), c3.reject)

const c4 = sched.planDay(D[4], [{ from: '09:00', kind: 'cycle', node: 'ZZZ' }])
check('★ 知识点不在图上 → 拒（挡幻觉节点）',
  c4.ok === false && c4.reject.includes('ZZZ'), c4.reject)

const c5a = sched.planDay(D[4], [{ from: '09:02', kind: 'cycle', node: 'A' }])
check('★ 起止没对齐 5 分钟 → 拒（页面拖拽就是这个粒度）',
  c5a.ok === false && c5a.reject.includes('5 分钟'), c5a.reject)
const c5b = sched.planDay(D[4], [{ from: '09:00', kind: '瞎写', node: 'A' }])
check('★ kind 非法 → 拒', c5b.ok === false && c5b.reject.includes('kind'), c5b.reject)
const c5c = sched.planDay(D[4], [{ from: '23:30', kind: 'cycle', node: 'A' }])
check('★ 排到网格外 → 拒（23:30 + 60 越过 24:00）',
  c5c.ok === false && c5c.reject.includes('网格'), c5c.reject)
const c5d = sched.planDay(D[4], [{ from: '23:00', kind: 'cycle', node: 'A' }])
check('23:00 加 60 分钟正好落在 24:00（边界放行）', c5d.ok === true, c5d.reject)

// ── 写：窗口 ──
check('★ 过去的日子 → 拒（回顾期只读）', sched.planDay(sd(-1), [{ from: '09:00', kind: 'cycle', node: 'A' }]).ok === false)
check('★ 太远的日子 → 拒', sched.planDay(sd(7), [{ from: '09:00', kind: 'cycle', node: 'A' }]).ok === false)
const border = sched.planDay(sd(6), [{ from: '07:00', kind: 'review', node: 'A' }])
check('07:00 在网格外 → 拒', border.ok === false && border.reject.includes('网格'), border.reject)
const last6 = sched.planDay(sd(6), [{ from: '09:00', kind: 'review', node: 'A' }])
check('+6 是窗口最后一天（边界放行）', last6.ok === true, last6.reject)

// ── 写：原子性 ──
const at1 = sched.planDay(D[5], [
  { from: '09:00', kind: 'cycle', node: 'A' },
  { from: '11:00', kind: 'cycle', node: 'ZZZ' },
])
check('★ 整批原子：一个块非法 → 一个都不写（半张计划比没有计划更坏）',
  at1.ok === false && plannedOf(D[5]) === undefined,
  `ok=${at1.ok} 落盘=${JSON.stringify(plannedOf(D[5]))}`)

// ── 写：固化 ──
const f1 = sched.planDay(sd(6), [{ from: '13:00', kind: 'review', node: 'B' }])
check('★ 排过就不让重排（计划固化，要改得明说）',
  f1.ok === false && f1.reject.includes('已经排过') && f1.reject.includes('replace'), f1.reject)
const f2 = sched.planDay(sd(6), [
  { from: '13:00', kind: 'review', node: 'B' },
  { from: '14:00', kind: 'review', node: 'C' },
], { replace: true })
check('★ 明说 replace 才覆盖', f2.ok === true && f2.replaced === 1 && f2.count === 2,
  JSON.stringify({ ok: f2.ok, replaced: f2.replaced, count: f2.count, reject: f2.reject }))
const cl = sched.planDay(sd(6), [], { replace: true })
check('replace + 空数组 = 清空这天的计划',
  cl.ok === true && plannedOf(sd(6)) === undefined, JSON.stringify(plannedOf(sd(6))))
check('空数组但不 replace → 拒（没东西可排）', sched.planDay(sd(1), []).ok === false)

// ── 工具层：形状和 render ──
// schema 里字段全是 required 且 additionalProperties:false ——
// 返回多了字段、少了字段，在 dsh 那边都是**校验错**，
// 而报错会把真正的拒绝理由盖掉（教练看到的会是"工具坏了"而不是"你排错了"）。
// 形状对账：**递归**比返回值和 output.schema —— 顶层键、数组元素的键、嵌套对象的键。
//
// 为什么得递归：dsh 对工具返回值是严格校验的，schema 里写了
// additionalProperties:false，返回多一个键就是**校验错** —— 而报错会把工具真正
// 想说的话（"你排错了"）盖成"工具坏了"。
//
// 第一版只比**顶层**键，于是 coach_next 兜底分支的 `frontier[].at` 一路绿着漏到
// 线上（游标是末端节点时那个工具 100% 报错，而全图 61% 是末端）。
// 它当时没被测到，是靠另写的一把尺子（verify-shape.mjs）扫出来的。
//
// 只在 schema 显式写了 additionalProperties:false 的地方判"多键" ——
// 没写的地方 dsh 也不拦，跟着它走，免得造出假警报。
// 用 function 声明（不用 const 箭头）是为了**提升**：第 23 节要在这儿之前就用它。
function shapeDiff(tool, out) {
  const walk = (schema, value, prefix) => {
    const extra = []
    const missing = []
    // 路径拼接：`a.b` / `a[0].b` —— 点号只在**有下一段**时加，
    // 不然数组下标会写成 `frontier.[0].at`（第一次就写错了，报错里一眼看到）。
    const child = (key) => (prefix ? `${prefix}.${key}` : key)
    if (schema?.type === 'object' && value && typeof value === 'object') {
      const props = schema.properties ?? {}
      for (const k of Object.keys(value)) {
        if (schema.additionalProperties === false && !(k in props)) extra.push(child(k))
      }
      for (const [k, s] of Object.entries(props)) {
        if (s?.required && !(k in value)) missing.push(child(k))
        else if (k in value) {
          const d = walk(s, value[k], child(k))
          extra.push(...d.extra); missing.push(...d.missing)
        }
      }
    } else if (schema?.type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((v, i) => {
        const d = walk(schema.items, v, `${prefix}[${i}]`)
        extra.push(...d.extra); missing.push(...d.missing)
      })
    }
    return { extra, missing }
  }
  return walk(tool.output.schema, out ?? {}, '')
}
const t1 = await planT.execute({ date: D[3], blocks: [{ from: '10:00', kind: 'review', node: 'A' }] })
check('工具层：排得进去', t1.ok === true && t1.count === 1, t1.reject)
const sd1 = shapeDiff(planT, t1)
check('★ 工具层输出和 schema 逐字对齐（多一个键 dsh 就拒）',
  !sd1.extra.length && !sd1.missing.length, `多=${sd1.extra} 少=${sd1.missing}`)
const t2 = await planT.execute({ date: D[5], blocks: [{ from: '11:00', kind: 'cycle', node: 'ZZZ' }] })
const sd2 = shapeDiff(planT, t2)
check('★ 被拒时形状也齐（少字段会把真正的理由盖成校验错）',
  t2.ok === false && !sd2.extra.length && !sd2.missing.length, `多=${sd2.extra} 少=${sd2.missing}`)
const t3 = await planT.execute({ date: '乱写', blocks: [] })
check('日期乱写不炸，走正常拒绝', t3.ok === false && typeof t3.reject === 'string' && t3.reject.length > 0, t3.reject)

const t1txt = planT.output.render({}, t1)[0].text
check('render 说清了几点到几点做什么', t1txt.includes('10:00–10:25') && t1txt.includes('复习一题'),
  t1txt.split('\n')[1] ?? '')
check('被拒时 render 不炸', planT.output.render({}, t2)[0].text.includes('排不进去'))
check('循环块的 render 带上 40/10/10', planT.output.render({}, p1)[0].text.includes('40 自己做'))

// 默认窗口要**带上回顾期**：教练排今天之前得先看前两天实际做到了什么，
// 只给"今天往后"等于让他闭着眼睛排。
const schDef = await schedT.execute({})
check('★ 默认给整个滚动窗口（今天-3 ~ 今天+6）',
  schDef.ok === true && schDef.days.length === sched.WINDOW && schDef.days[0].date === sd(-3),
  `${schDef.days.length} 天，首日 ${schDef.days[0]?.date}，末日 ${schDef.days.at(-1)?.date}`)

const sch1 = await schedT.execute({ days: 5 })
check('工具层：读得到日程', sch1.ok === true && sch1.days.length === 5, sch1.reject)
const sd3 = shapeDiff(schedT, sch1)
check('★ coach_schedule 输出和 schema 对齐', !sd3.extra.length && !sd3.missing.length,
  `多=${sd3.extra} 少=${sd3.missing}`)
const sch1txt = schedT.output.render({}, sch1)[0].text
check('★ render 只给整张表（有 ★· 时间轴，不再报空档/容量）',
  sch1txt.includes('★') && sch1txt.includes('·') &&
  !sch1txt.includes('空档') && !sch1txt.includes('容量'), sch1txt.slice(0, 120))

// ── 时段 vs 汇总数 ──
// 要求：「要能看到所有已经排过的时间段，
// 而不是我还有多少时间可以使用」。汇总数说不出「这 50 分钟夹在哪两件事之间」，
// 而块放不放得下、要不要跨过饭点，全由那个位置决定。
const planB = await planT.execute({ date: D[1], blocks: [{ from: '09:00', kind: 'cycle', node: 'A' }] })
const txtB = planT.output.render({}, planB)[0].text
check('★ 排完回一条完整时间轴：刚排的块 + 他标的忙事都在',
  planB.ok === true && txtB.includes('★ 09:00–10:00') && txtB.includes('上选修课'),
  txtB.split('\n').slice(0, 6).join(' / '))

// ── 范围只认他说的那天 ──
// 这条**不靠描述劝，靠接口形状保证**：date 是单个字符串，一次调用动不了两天。
// 描述只是防他顺手连调七次。
// defineTool 会把 parameters 包成 JSON Schema（type / properties / required），
// 所以要看的是 .properties，不是 parameters 本身。
const planParams = planT.parameters.properties ?? {}
check('★ 排块接口是单日的（结构上就排不了多天）',
  Object.keys(planParams).sort().join(',') === 'blocks,date,replace' &&
  planParams.date.type === 'string' &&
  !Object.keys(planParams).some((k) => /days|range|dates|list/i.test(k)),
  Object.keys(planParams).join(','))

// ══ 撤块 ══
// 要的：「我说这个时间不合理，直接让他撤回这个日程就行」。
// 撤和排**分开**，不合成一个参数 —— 合起来教练迟早会在该撤的时候顺手重排，
// 而重排会把他没意见的块也一起换掉。
const unplanT = byName13.get('coach_unplan')
check('注册了 coach_unplan', Boolean(unplanT))

check('D[4] 上排着一个块（撤块测试的起点，上面 c5d 排的）',
  (plannedOf(D[4]) ?? []).length === 1, JSON.stringify(plannedOf(D[4])))

const u0 = await unplanT.execute({ date: D[4] })
check('★ 不说撤哪个 → 拒，并把候选列给他挑',
  u0.ok === false && u0.reject.includes('23:00'), u0.reject)
const u1 = await unplanT.execute({ date: D[4], from: '08:00' })
check('★ 撤一个不存在的时刻 → 拒（不猜"大概是那个吧"）',
  u1.ok === false && u1.reject.includes('23:00'), u1.reject)
const u2 = await unplanT.execute({ date: D[5] })
check('没排过块的日子 → 拒', u2.ok === false && u2.reject.includes('没排过'), u2.reject)
check('过去的日子撤不了', (await unplanT.execute({ date: sd(-1) })).ok === false)
check('窗口外撤不了', (await unplanT.execute({ date: sd(7) })).ok === false)

const u3 = await unplanT.execute({ date: D[4], from: '23:00' })
check('撤掉 23:00 那个块', u3.ok === true && u3.removedCount === 1, u3.reject)
check('★ 真落盘了（那天回到没排的状态）',
  plannedOf(D[4]) === undefined, JSON.stringify(plannedOf(D[4])))
// 那天只有这一个块，撤完就一个不剩。
const u3txt = unplanT.output.render({}, u3)[0].text
check('★ 撤完的输出里不再有空档/容量',
  !('free' in u3) && !('freeMin' in u3) && !u3txt.includes('空档') && !u3txt.includes('容量'),
  Object.keys(u3).join(','))
check('render 说清撤了什么、还剩什么',
  u3txt.includes('23:00–24:00') && u3txt.includes('没有别的块'), u3txt.split('\n').slice(0, 3).join(' / '))

// 排两个、撤一个 —— 别的不许动
await planT.execute({ date: D[6], blocks: [
  { from: '09:00', kind: 'review', node: 'A' },
  { from: '10:00', kind: 'review', node: 'B' },
] })
const u4 = await unplanT.execute({ date: D[6], from: '09:00' })
check('★ 只撤一个，别的块原地不动',
  u4.ok === true && u4.removedCount === 1 && (plannedOf(D[6]) ?? []).length === 1 &&
  plannedOf(D[6])[0].from === '10:00', JSON.stringify(plannedOf(D[6])))
check('★ 撤完报的是「还剩哪些块」（不再报空档）',
  u4.leftCount === 1 && u4.left[0].from === '10:00' && !('free' in u4),
  `ok=${u4.ok} left=${JSON.stringify(u4.left)} keys=${Object.keys(u4).join(',')}`)
const u5 = await unplanT.execute({ date: D[6], all: true })
check('all=true 撤掉整天', u5.ok === true && u5.removedCount === 1 && plannedOf(D[6]) === undefined)

// ★ 撤块绝不能碰 busy —— 那是他标的事实，不是计划
const busyBefore = JSON.stringify(mod13.progressApi.loadSchedule().days[D[1]]?.busy)
await unplanT.execute({ date: D[1], all: true })
const busyAfter = JSON.stringify(mod13.progressApi.loadSchedule().days[D[1]]?.busy)
check('★ 撤块不动他标的忙事（事实不是计划，撤事实等于篡改真相源）',
  busyBefore === busyAfter && busyBefore !== undefined && busyBefore.includes('选修课'), busyBefore)

const sd4 = shapeDiff(unplanT, u3)
check('★ coach_unplan 输出和 schema 对齐',
  !sd4.extra.length && !sd4.missing.length, `多=${sd4.extra} 少=${sd4.missing}`)
const sd5 = shapeDiff(unplanT, u0)
check('被拒时形状也齐', !sd5.extra.length && !sd5.missing.length, `多=${sd5.extra} 少=${sd5.missing}`)
check('撤块被拒时 render 不炸', unplanT.output.render({}, u0)[0].text.includes('撤不了'))

// ── openSlots：排过的块也算占用 ──
//
// 这一对函数从"显示用"退成纯函数了（工具不再报空档），但那条口径
// 本身是拿真 bug 换来的 —— 教练看到"21:00–22:30 空着 90 分钟"而那里排着块，
// 他会以为还能再塞一个。所以留着当锚点，直接喂合成对象验。
//
// 两条口径**必须分开**：freeSlots = 他人在不在（排块校验用，重排时旧块会扔），
// openSlots = 还能排哪。混成一条的话二选一必错。
const twoRails = {
  busy: [{ from: '14:00', to: '15:00', label: '开会' }],
  planned: [{ from: '21:00', to: '22:00', kind: 'cycle', node: 'A' }],
}
check('★ 两条口径分开，差正好是那个已排的块（60 分钟）',
  sched.freeMinutes(twoRails) - sched.openMinutes(twoRails) === 60 &&
  !sched.openSlots(twoRails).some((f) => f.a === 21 * 60),
  `free ${sched.freeMinutes(twoRails)} / open ${sched.openMinutes(twoRails)}`)
check('读失败时 render 不炸', schedT.output.render({}, { ok: false, reject: 'x' })[0].text.includes('读不到'))

// ── 退回未学：只清状态，不删证据 ──
//
// 修过。原来 `markStatus(id,'none')` 用 `delete p.nodes[id]` 删**整条记录**，
// 而 `checks`（检测记录）和 `diagnoses`（判因台账）挂在同一条记录上 ——
// 于是"点一下状态按钮"就把「他哪天考了多少分、判过几次不认真」一起销毁了。
// 那是历史证据，状态操作不该有权力删它。
const progApi = mod13.progressApi
progApi.setStatus('A', 'learned')
const progSeed = progApi.load()
progSeed.nodes.A.checks = [{ date: '2026-09-13', outcome: 'passed', score: 5 }]
progSeed.nodes.A.diagnoses = [{ date: '2026-09-12', kind: '不会' }]
progApi.save(progSeed)
const seeded = progApi.load().nodes.A
check('夹具生效（检测记录 + 判因都塞进去了）',
  (seeded?.checks?.length ?? 0) === 1 && (seeded?.diagnoses?.length ?? 0) === 1,
  JSON.stringify(seeded))

check('退回未学本身要成功', progApi.setStatus('A', 'none').ok === true)
const backA = progApi.load().nodes?.A
check('★ 状态清掉了', backA?.status === undefined, JSON.stringify(backA))
check('★ 但检测记录还在（点一下状态按钮不该销毁历史）',
  (backA?.checks?.length ?? 0) === 1, JSON.stringify(backA?.checks))
check('★ 判因台账也还在', (backA?.diagnoses?.length ?? 0) === 1, JSON.stringify(backA?.diagnoses))

// 反过来：没有任何证据的节点，退回未学之后不该留空壳
progApi.setStatus('B', 'learned')
progApi.setStatus('B', 'none')
check('没别的可留时整条删掉（不留 `{}` 这种残渣）',
  progApi.load().nodes?.B === undefined, JSON.stringify(progApi.load().nodes?.B))

// ── 写盘的时间/日期必须带引号 ──
//
// 裸写的 `11:40` 在 YAML 1.1（PyYAML）里是**六十进制整数 700**，
// 在 YAML 1.2（node/yaml，插件用的这套）里是字符串 "11:40" ——
// 同一份文件两个答案。日期更狠：裸的 `2026-09-14` 被 PyYAML 读成 **Date 对象**，
// 于是 `days["2026-09-14"]` 直接 KeyError。
// 现在只有 node/yaml 读它所以没炸，但这属于"埋着的"，而埋着的雷最贵。
progApi.saveSchedule({
  version: 1, updated: '',
  days: { '2026-09-14': { busy: [{ from: '11:40', to: '08:00', label: 'x' }] } },
})
const rawSched = readFileSync(path.join(tmp13, 'SCHEDULE.yaml'), 'utf8')
check('★ 时间值带引号（裸写的 11:40 在 PyYAML 里是整数 700）',
  rawSched.includes('from: "11:40"') && rawSched.includes('to: "08:00"'),
  (rawSched.match(/^\s*(?:- )?(?:from|to):.*$/m) ?? ['（没找到）'])[0].trim())
check('★ 日期 key 带引号（裸的会被 PyYAML 读成 Date，按字符串索引直接 KeyError）',
  rawSched.includes('"2026-09-14":'), (rawSched.match(/^\s*\d{4}-\d{2}-\d{2}:.*$/m) ?? ['（没找到）'])[0].trim())
check('★ updated 也带引号', /updated: "\d{4}-\d{2}-\d{2}"/.test(rawSched),
  (rawSched.match(/^updated:.*$/m) ?? ['（没找到）'])[0])

// ══════════════════════════════════════════════════════════════════
// 30. 审查补丁：静默骗人的那几条
// ══════════════════════════════════════════════════════════════════
// 这一节全部来自一次对外审查。它们有个共同形状：**降级是真的，但不说**。
// 每条都先能红（改之前实测过症状），再谈修。
console.log('── 30. 静默降级 / 隐形的卷 / 假近似 ──')
const tmp30 = mkdtempSync(path.join(os.tmpdir(), 'coach-fix30-'))
writeFileSync(path.join(tmp30, 'MAP.yaml'), mini(''))
process.env.COACH_DATA_DIR = tmp30
const mod30 = await import(`${INSTALLED}?fresh=30`)
const reg30 = []
mod30.apply(mockCtx(reg30))
const T30 = new Map(reg30.map((t) => [t.name, t]))
const prog30 = mod30.progressApi

// ── ① suggest() 的假近似 ──
// 匹配规则是「互相包含」，空串被任何字符串包含 → 命中全部 → slice(0,5)
// 给出的是**地图顺序前五个**。它长得像"相关推荐"，实际是随机的。
const nearCount = (r) => (String(r.reject).includes('相近的有') ? 1 : 0)
check('★ 空 node 不再报「相近的」（原来会给地图前五个）',
  nearCount(prog30.setStatus('', 'studying')) === 0, prog30.setStatus('', 'studying').reject)
check('★ 单字符也不再报（`a` 会命中 Alpha-Beta / Manacher…）',
  nearCount(prog30.setStatus('a', 'studying')) === 0, prog30.setStatus('a', 'studying').reject)
// 反过来：真的打错一个双字节点名，还得给回头路 —— 别把回头路一起堵死
const typo30 = prog30.setStatus('AB', 'studying')
check('双字以上的近似仍然给（回头路没被一起堵死）',
  nearCount(typo30) === 1, typo30.reject)

// ── ② rating 拿不到时必须说出来 ──
// rating=0 会**关掉整个难度护栏**（reachableOf 对 0 一律放行），
// 而原来 render 里 `trainerRating ? … : ''` —— 查不到就整行消失，
// 读起来和"本来就没这行"一模一样。coach_pool 在同样情况下会打警告，这边漏了。
const oldDb30 = process.env.COACH_DB
process.env.COACH_DB = path.join(tmp30, 'no-such.db')
const n30 = await T30.get('coach_next').execute({ cursor: 'A' })
const n30txt = T30.get('coach_next').output.render({}, n30)[0].text
check('rating 确实降级成 0 了（夹具成立）', n30.trainerRating === 0, `${n30.trainerRating}`)
check('★ rating 拿不到时渲染里明说「护栏没生效」',
  n30txt.includes('没查到他的 rating') && n30txt.includes('没生效'),
  (n30txt.match(/.*没查到.*/) ?? ['（没有这一行）'])[0])
process.env.COACH_DB = oldDb30

// ── ③ 三个查询各只有一份实现 ──
// 这节的判据是**形状**：同一个查询在 index.js 里出现两次就是两份真相。
// 规范版（acSet / ratingOf / trainerId）就在同一个文件里，抄第二遍没有任何理由。
// 改之前实测：AC 集合 2 份、rating 2 份、训练员账号 2 份。
const src30 = readFileSync(path.join(SOURCE_DIR, 'index.js'), 'utf8')
const times30 = (re) => (src30.match(re) ?? []).length
check('★ 「他 AC 过哪些题」只有一份实现', times30(/verdict = 'AC'/g) === 1,
  `${times30(/verdict = 'AC'/g)} 份`)
check('★ 「他的 rating」只有一份实现', times30(/FROM rating_history/g) === 1,
  `${times30(/FROM rating_history/g)} 份`)
check('★ 「训练员账号」只有一份实现', times30(/cf_handle = \? OR handle = \?/g) === 1,
  `${times30(/cf_handle = \? OR handle = \?/g)} 份`)

// ── ④ coach_status 要报出押着的卷 ──
// 在这之前 pending 对教练是**隐形**的：出卷跨会话，而 status 只报游标和四个状态，
// 于是他永远不知道手里有卷，直到试开新卷被拒才发现。
const paper30 = [
  { platform: 'nowcoder', problemId: 'NC15121', band: '易', title: 'T1', difficulty: 800,
    cfRating: 800, url: '', source: 'pool', verified: '', weight: 1, minutes: 20 },
  { platform: 'codeforces', problemId: '1015D', band: '中', title: 'T2', difficulty: 1500,
    cfRating: 1500, url: '', source: 'pool', verified: '', weight: 2, minutes: 30 },
  { platform: 'codeforces', problemId: '1016E', band: '难', title: 'T3', difficulty: 2000,
    cfRating: 2000, url: '', source: 'pool', verified: '', weight: 3, minutes: 40 },
]
const p30 = prog30.load()
p30.pending = { node: 'A', date: '2026-09-16', at: '2026-09-16 10:00:00',
  totalMinutes: 90, passScore: 4, maxScore: 6, problems: paper30 }
prog30.save(p30)

const st30 = await T30.get('coach_status').execute({})
const st30txt = T30.get('coach_status').output.render({}, st30)[0].text
check('★ coach_status 报出押着的卷（node / 道数 / 限时）',
  st30.pendingNode === 'A' && st30.pendingProblems === 3 && st30.pendingMinutes === 90,
  JSON.stringify({ n: st30.pendingNode, p: st30.pendingProblems, m: st30.pendingMinutes }))
check('★ 渲染里看得见「手上押着一张卷」', st30txt.includes('手上押着一张卷'),
  (st30txt.match(/.*押着.*/) ?? ['（没有这一行）'])[0])
check('★ 并且给出了撤卷的出口（不然模型只能编成绩）',
  st30txt.includes('coach_cancel'), (st30txt.match(/.*coach_cancel.*/) ?? ['（没有）'])[0])

// ── ⑤ 牛客裸号要和卷子里的 NC 号对上 ──
// 判卷比对题号时平台在结果数组里传不进来（结果只有 problemId），
// 原先传空串 = 不归一 → 卷子存 `NC15121`、小鲸报 `15121` 就撞不上，
// 判成「卷子里没有这条结果」。判卷是闭环最后一步，错在这整张卷就没了。
const g30 = await T30.get('coach_grade').execute({ results: [
  { problemId: '15121', solved: true, minutes: 15 },   // ← 裸号
  { problemId: '1015D', solved: true, minutes: 25 },
  { problemId: '1016E', solved: true, minutes: 35 },
]})
check('★ 牛客裸号能对上卷子里的 NC15121', g30.ok === true, JSON.stringify(g30.reject))
check('判完之后卷子清掉了', prog30.load().pending === null,
  JSON.stringify(prog30.load().pending))
const st30b = await T30.get('coach_status').execute({})
check('★ 判完 coach_status 不再报卷', st30b.pendingNode === '' && st30b.pendingProblems === 0,
  JSON.stringify({ n: st30b.pendingNode, p: st30b.pendingProblems }))

// ── ⑥ 自述题（网上找的）必须在记录里留痕 ──
// 它本身不是错（这是刻意开的一条通道），错的是**事后看不出来**：
// 一张全自述的卷和一张全是真题的卷，在 checks 里长得一模一样，
// 而只有后者能当"他证明过这个水平"。
const p30c = prog30.load()
p30c.pending = { node: 'A', date: '2026-09-16', at: '2026-09-16 11:00:00',
  totalMinutes: 90, passScore: 4, maxScore: 6, problems: [
    { platform: 'codeforces', problemId: '1015D', band: '易', title: 'T1', difficulty: 800,
      cfRating: 800, url: '', source: 'pool', verified: '', weight: 1, minutes: 20 },
    { platform: 'codeforces', problemId: '1016E', band: '中', title: 'T2', difficulty: 1500,
      cfRating: 1500, url: '', source: 'pool', verified: '', weight: 2, minutes: 30 },
    { platform: 'atcoder', problemId: 'abc999_c', band: '难', title: 'T3', difficulty: 0,
      cfRating: 2400, url: 'http://x.invalid/3', source: 'web',
      verified: '我看过官方题解，正解就是二分', weight: 3, minutes: 40 },
  ] }
prog30.save(p30c)
const gw = await T30.get('coach_grade').execute({ results: [
  { problemId: '1015D', solved: true, minutes: 10 },
  { problemId: '1016E', solved: true, minutes: 20 },
  { problemId: 'abc999_c', solved: true, minutes: 30 },
]})
check('★ 判卷报出自述题数', gw.selfReported === 1, `${gw.selfReported}`)
check('★ 自述题数落进 checks（事后翻记录分得出这张卷的成色）',
  prog30.load().nodes.A.checks.slice(-1)[0].selfReported === 1,
  JSON.stringify(prog30.load().nodes.A.checks.slice(-1)[0].selfReported))
check('★ 自述题**不算进验证段位**（那道自报 2400 的没被当成"他证明过 2400"）',
  gw.verifiedAt === 1500, `${gw.verifiedAt}（库里两道题的 cfRating 是 800/1500）`)
const gwTxt = T30.get('coach_grade').output.render({}, gw)[0].text
check('★ 结论旁边就写着「其中 N 道是网上找的」', gwTxt.includes('网上找的'),
  (gwTxt.match(/.*网上找的.*/) ?? ['（没有这一行）'])[0].slice(0, 60))
const st30c = await T30.get('coach_status').execute({})
check('★ coach_status 的历史行也带［含 N 道自述题］',
  st30c.recentChecks.some((c) => c.selfReported === 1),
  JSON.stringify(st30c.recentChecks.map((c) => c.selfReported)))

// ── ⑦ 排 exam 块而手里没卷子 → 提醒（不拦）──
// 排块时工具只检查"物理上排不排得下"，不检查"手里有没有卷子"。
// 于是能排出 14:00–15:30 的检测块，而那时候还没开卷 —— 到点他不知道做哪三道。
// 不拦（排块是教练的判断），但必须说，因为这事**到点才暴露**。
const pr30 = await T30.get('coach_plan').execute({
  date: sd(2), blocks: [{ from: '14:00', kind: 'exam', node: 'A' }] })
check('排 exam 块本身要成功（提醒不等于拦）', pr30.ok === true, JSON.stringify(pr30.reject))
check('★ 手里没卷子时给出提醒', pr30.notes.length === 1, JSON.stringify(pr30.notes))
const pr30txt = T30.get('coach_plan').output.render({}, pr30)[0].text
check('★ 提醒出现在渲染里（不然它躺在返回值里没人念）',
  pr30txt.includes('还没有卷子'), (pr30txt.match(/.*还没有卷子.*/) ?? ['（没有）'])[0].slice(0, 50))

// 反过来：手里有卷子的时候不该瞎提醒
const p30d = prog30.load()
p30d.pending = { node: 'A', date: '2026-09-16', at: 'x', totalMinutes: 90, passScore: 4,
  maxScore: 6, problems: paper30 }
prog30.save(p30d)
const pr30b = await T30.get('coach_plan').execute({
  date: sd(3), blocks: [{ from: '14:00', kind: 'exam', node: 'A' }] })
check('手里有卷时不提醒（提醒本身也得准）', pr30b.ok === true && pr30b.notes.length === 0,
  JSON.stringify(pr30b.notes))
// ⚠️ 换一天 —— sd(3) 上一句刚排过 exam，同一天再排会被「计划固化」拦掉，
// 那样测到的就是"排不进去"而不是"没提醒"（第一版就是这么红的）。
const pr30c = await T30.get('coach_plan').execute({
  date: sd(4), blocks: [{ from: '10:00', kind: 'cycle', node: 'B' }] })
check('排 cycle 跟卷子无关，不提醒', pr30c.ok === true && pr30c.notes.length === 0,
  JSON.stringify(pr30c.notes))

// ══════════════════════════════════════════════════════════════════
// 31. 两个新工具：coach_cancel（撤卷）+ coach_log（记实际用时）
// ══════════════════════════════════════════════════════════════════
// 它们补的是**设计里写了、但两头都断着**的两条链路：
//   · 撤卷 —— pending 原先只有 coach_grade 一个出口，他不做了就死锁，
//     而唯一的"出路"是编三条成绩喂给判卷（往真相源里写假数据）。
//   · actual —— 字段从第一天就写着"校准真实速度的唯一来源"，但全项目零写入者。
console.log('── 31. 撤卷 / 记录实际用时 ──')
// 接着 30 节跑：此时 tmp30 里押着一张卷（p30d 塞的 paper30），node 是 A
check('夹具成立：手里有卷', prog30.load().pending !== null,
  String(prog30.load().pending?.node))

// ── coach_cancel ──
// 「压根没传 reason」轮不到这里判 —— dsh 的 defineTool 在进 execute 之前
// 就按 schema 抛 ToolArgsError 了（实测确认过）。所以这里测的是**下一层**：
// 传了但全是空白。两层都要有，缺了这层 `reason: '   '` 就能溜进去。
const c30a = await T30.get('coach_cancel').execute({ reason: '   ' })
check('★ 理由全是空白也撤不了（"为什么没做"是这件事里唯一有价值的部分）',
  c30a.ok === false, c30a.reject)

const before30 = prog30.load().nodes.A?.status
const c30b = await T30.get('coach_cancel').execute({ reason: '他说今天没时间做了' })
check('★ 写理由能撤', c30b.ok === true, JSON.stringify(c30b.reject))
check('★ 撤完卷子真没了（这就是那个死锁的出口）',
  prog30.load().pending === null, JSON.stringify(prog30.load().pending))
check('★ 撤完**能再开卷**（coach_test 的唯一闸就是 pending 非空，它空了闸就开了）',
  prog30.load().pending === null)
check('★ 撤卷不动状态（没做检测 ≠ 没学，也 ≠ 学了）',
  prog30.load().nodes.A?.status === before30, `${before30} → ${prog30.load().nodes.A?.status}`)
const abandoned = prog30.load().nodes.A.checks.filter((c) => c.outcome === 'abandoned')
check('★ 撤卷**留了台账**（撤不是删 —— "开了卷没做"本身就是信号）',
  abandoned.length === 1 && abandoned[0].reason === '他说今天没时间做了',
  JSON.stringify(abandoned[0]?.reason))
check('★ 台账里保留了当时那三道题（撤完卷面就没了，不存就查不到）',
  Array.isArray(abandoned[0]?.problems) && abandoned[0].problems.length === 3 &&
  abandoned[0].problems[0].problemId === 'NC15121' &&
  abandoned[0].problems.every((x) => 'source' in x && 'cfRating' in x),
  JSON.stringify(abandoned[0]?.problems?.map((x) => x.problemId)))

const c30c = await T30.get('coach_cancel').execute({ reason: '再撤一次' })
check('手里空了之后再撤 → 拒（不是静默成功）', c30c.ok === false, c30c.reject)

const st30d = await T30.get('coach_status').execute({})
check('★ coach_status 的历史里读得出「弃考」（不是混进"没过"）',
  st30d.recentChecks.some((c) => c.outcome === 'abandoned'),
  JSON.stringify(st30d.recentChecks.map((c) => c.outcome)))
const st30dtxt = T30.get('coach_status').output.render({}, st30d)[0].text
check('★ 渲染成人话「弃考（没做）」', st30dtxt.includes('弃考'),
  (st30dtxt.match(/.*弃考.*/) ?? ['（没有）'])[0].slice(0, 60))

// ★ 卡住 / 弃考**分开判** —— 夹具用的是真踩过的形状：
//   B = 2 次没过 + 2 次作废，但**最后一次通过** → 不该报卡住（会冤枉人）
//   A = 连续两次没过且最后一次没过 → 该报卡住
// 在这之前只有一个"没过几次"的粗口径，于是「二分」那张被撤了两次的卷子
// 会被读成"他四次都没过"，而事实是他最后 4 分过了、状态已是 verified。
const p31f = prog30.load()
// 夹具用完必须**还回去**：这份 PROGRESS 后面几节还要读（coach_log 那条
// 「做对一道题不动 status」读的就是 B 的 status）。把共享夹具改脏 = 让别的
// 用例冤枉地红 —— 第一版就是这么红的。
const keep31 = { A: p31f.nodes.A, B: p31f.nodes.B }
p31f.nodes.B = { ...(p31f.nodes.B ?? {}), status: 'verified', checks: [
  { date: '2026-09-01', outcome: 'abandoned', reason: '卷面难度结构失衡' },
  { date: '2026-09-02', outcome: 'failed', score: 3, maxScore: 6, passScore: 4 },
  { date: '2026-09-03', outcome: 'failed', score: 0, maxScore: 6, passScore: 4 },
  { date: '2026-09-04', outcome: 'abandoned', reason: '题已被他 AC 过' },
  { date: '2026-09-05', outcome: 'passed', score: 4, maxScore: 6, passScore: 4 },
] }
p31f.nodes.A = { ...(p31f.nodes.A ?? {}), status: 'studying', checks: [
  ...((p31f.nodes.A?.checks) ?? []).filter((c) => c.outcome === 'abandoned'),
  { date: '2026-09-06', outcome: 'failed', score: 1, maxScore: 6, passScore: 4 },
  { date: '2026-09-07', outcome: 'failed', score: 2, maxScore: 6, passScore: 4 },
] }
prog30.save(p31f)
const st31 = await T30.get('coach_status').execute({})
const stuckNodes = st31.stuck.map((s) => s.node)
const dropNodes = st31.cancelled.map((s) => s.node)
check('★ 后来通过了的不算卡住（"二分"那个形状）', !stuckNodes.includes('B'), JSON.stringify(stuckNodes))
check('★ 连最后一次都没过 → 报卡住', stuckNodes.includes('A'), JSON.stringify(stuckNodes))
check('★ 两次作废进的是"卷子作废"，不是"他没过"', dropNodes.includes('B'), JSON.stringify(dropNodes))
check('★ 作废没被算进没过次数（B 的作废 2 次 ≠ 再给他加 2 次失败）',
  st31.cancelled.find((c) => c.node === 'B')?.drops === 2 &&
  String(st31.cancelled.find((c) => c.node === 'B')?.reason).includes('AC 过'),
  JSON.stringify(st31.cancelled.find((c) => c.node === 'B')))
const st31txt = T30.get('coach_status').output.render({}, st31)[0].text
check('★ 两条都渲染成人话（躺返回值里没人念等于没收）',
  st31txt.includes('卡住') && st31txt.includes('卷子反复作废'),
  (st31txt.match(/.*卡住.*/) ?? ['（没有卡住行）'])[0].slice(0, 70))

// 还回原样：下面的 coach_log / 32 / 33 都接着这份进度跑
const p31r = prog30.load()
p31r.nodes = { ...p31r.nodes }
for (const [k, v] of Object.entries(keep31)) {
  if (v === undefined) delete p31r.nodes[k]
  else p31r.nodes[k] = v
}
prog30.save(p31r)

// ── coach_log ──
// 排一个块当对照，再记实际用时 —— plannedMin 由工具从 SCHEDULE 里自己算。
// ⚠️ 用**今天**（sd(0)）：coach_log 拒绝往未来记（未来的"实际用时"是编的），
// 第一版用了 sd(5)，于是"记不上"——而那是它**该**拒的。
const lp30 = await T30.get('coach_plan').execute({
  date: sd(0), blocks: [{ from: '20:00', kind: 'review', node: 'A' }] })
check('夹具：给今天排了一个 25 分钟的复习块', lp30.ok === true, JSON.stringify(lp30.reject))

const l30a = await T30.get('coach_log').execute({
  node: 'A', actualMin: 40, solved: true, independent: false, date: sd(0), note: '卡在边界上' })
check('★ 记上了', l30a.ok === true, JSON.stringify(l30a.reject))
check('★ plannedMin 是工具自己从表里算的（25 = review 的块长，不让调用方填）',
  l30a.plannedMin === 25, `${l30a.plannedMin}`)
check('★ 差值算得出来（40 实际 - 25 计划 = +15）', l30a.deviation === 15, `${l30a.deviation}`)
check('independent 原样落盘', l30a.independent === false)

const log30txt = T30.get('coach_log').output.render({}, l30a)[0].text
// 需求 #8：这句**故意收掉了** —— 偏差对训练员没有可执行动作
// （拿到"超了 15 分钟"他能干嘛？加速？那是表现目标），但教练要用它调排课密度。
// 所以断言反过来钉：人话里不许再有偏差，而 structured 里必须有（上面 2803/2805
// 那两条已经在钉了 —— 挪过去 ≠ 删掉）。
check('★ 给训练员看的那句只剩中性回显（需求 #8：偏差挪教练侧）',
  log30txt.includes('记住了：40 分钟') && !log30txt.includes('比排的'),
  (log30txt.match(/.*记住了.*/) ?? ['（没有）'])[0])

const sched30 = prog30.loadSchedule()
check('★ 真落进 SCHEDULE.yaml 的 actual 里',
  sched30.days[sd(0)]?.actual?.[0]?.actualMin === 40,
  JSON.stringify(sched30.days[sd(0)]?.actual))

const l30b = await T30.get('coach_log').execute({
  node: 'A', actualMin: 22, solved: true, independent: true, date: sd(0) })
check('★ 同一天同一个点再记 → 覆盖，不叠成两条（这张表没有开始时间，两条分不清）',
  l30b.replaced === true && l30b.totalLogged === 1, `replaced=${l30b.replaced} 总数=${l30b.totalLogged}`)
check('★ 覆盖后表里只有一条，值是新的',
  prog30.loadSchedule().days[sd(0)].actual.length === 1 &&
  prog30.loadSchedule().days[sd(0)].actual[0].actualMin === 22,
  JSON.stringify(prog30.loadSchedule().days[sd(0)].actual))

const l30c = await T30.get('coach_log').execute({ node: 'A', actualMin: 0, solved: true, independent: true })
check('时长非正 → 拒', l30c.ok === false, l30c.reject)

// 这条最容易被忽略：**没做出来也要记**。
// 「我想了 40 分钟没做出来」正是校准真实速度最需要的那条数据 ——
// 只记成功的，样本就全是幸存者，算出来的速度会偏快。
const l30d = await T30.get('coach_log').execute({
  node: 'B', actualMin: 40, solved: false, independent: false, note: '没做出来' })
check('★ 没做出来的也算一条（只记成功的，样本全是幸存者偏差）',
  l30d.ok === true && l30d.actualMin === 40, JSON.stringify(l30d.reject))
check('这天它没排过块 → plannedMin 是 0（"没有计划可对照"是个事实，不是错误）',
  l30d.plannedMin === 0, `${l30d.plannedMin}`)

// ── 掌握证据落盘（后加的那半）─────────────────────────────────
// 设计方针里那条一直空着的数据：「独立做出 vs 听了讲才会」。
// coach_diagnose 只记失败、coach_grade 只记检测卷、coach_mark 两档都是自评 ——
// 做对了一道题，原先**没有落盘的地方**。
//
// ⚠️ 断言要取**最终态**：上面 l30a（40分/非独立）被 l30b（22分/独立）覆盖过了，
//    而节点 A 在本节前面被判过卷、status 已经是 verified ——
//    拿 A 去验"不动 status"是在验夹具，不是在验代码（第一版就这么错的）。
//    所以"不动 status"这条挂在**节点 B** 上：它没被判过卷。
check('★ 做对了要落进 passes（掌握证据不是只留在日程表里）',
  l30a.recorded === true && l30a.passCount === 1, JSON.stringify({ r: l30a.recorded, n: l30a.passCount }))
const recA = prog30.load().nodes.A
check('★ passes 落的是最新那条（同日同点覆盖，不叠）',
  recA?.passes?.length === 1 && recA.passes[0].solved === true &&
  recA.passes[0].independent === true && recA.passes[0].minutes === 22,
  JSON.stringify(recA?.passes))

const recB = prog30.load().nodes.B
check('★ 没做出来的也有一条 passes（solved:false 是事实，不是缺失）',
  recB?.passes?.length === 1 && recB.passes[0].solved === false &&
  recB.passes[0].minutes === 40, JSON.stringify(recB?.passes))
check('★ **不动 status**（做对一道题 ≠ 这个知识点学完了，那是检测的活）',
  recB?.status === undefined, `B.status=${recB?.status}（B 全程没被判过卷，记 passes 不该动它）`)

// 渲染是**小鲸最容易照抄的模板** —— 它必须正向，否则小鲸会自己往判因那边滑
const logTxt = T30.get('coach_log').output.render({}, l30b)[0].text
check('★ 独立做对了的渲染是正向的（夸 + 往下走，不接着挑毛病）',
  logTxt.includes('独立做出来的') && logTxt.includes('夸'),
  (logTxt.match(/.*夸.*/) ?? ['（没有）'])[0].slice(0, 50))
const logTxtNo = T30.get('coach_log').output.render({}, l30d)[0].text
check('★ 没做出来的不是骂（"这很正常"），也不是不管（"看卡在哪"）',
  logTxtNo.includes('很正常') && logTxtNo.includes('卡在哪'),
  (logTxtNo.match(/.*很正常.*/) ?? ['（没有）'])[0].slice(0, 50))

// coach_status 要把「独立做出」这条腿报出来 —— 不报出来小鲸就看不见，
// 记了等于没收
const st30p = await T30.get('coach_status').execute({})
check('★ coach_status 报出 passTotal / passSolved / passIndependent',
  st30p.passTotal === 2 && st30p.passSolved === 1 && st30p.passIndependent === 1,
  JSON.stringify({ t: st30p.passTotal, s: st30p.passSolved, i: st30p.passIndependent }))
const st30pText = T30.get('coach_status').output.render({}, st30p)[0].text
check('★ 渲染成人话，独立做出那条腿单列',
  st30pText.includes('独立做出'), (st30pText.match(/.*做完记录.*/) ?? ['（没有）'])[0].slice(0, 70))

// ── 31b. 条目 ≠ 题：同一天同一节点两道题（需求 #2）─────
//
// 事故（09-21，ST 表）：同一天同一节点他做了两道 —— P2880 16 分钟**独立** AC、
// CF1548B 48 分钟**带提示** AC。旧口径按「一天一节点一条」去重，两道压成一条，
// 题号只能塞备注。于是 coach_status 报「做完记录 6 条（做出来 6，独立 5）」——
// **从数字上完全看不出他独立做出过 ST 表的题**，而那正是该不该开检测卷的依据。
console.log('── 31b. 条目 ≠ 题 ──')
// 这一节会往日程/进度里写，跑完**还回原样**（32/33 接着这份进度跑）
const snapProg31b = JSON.parse(JSON.stringify(prog30.load()))
const snapSched31b = JSON.parse(JSON.stringify(prog30.loadSchedule()))
// ⚠️ 先清成干净状态。不清的话这一节量的是**前面几节的残留** ——
//    第一版就是这么错的：断言「独立 1」实得 3，因为 31 节早给 A 记过一条独立的。
const wipeP = prog30.load()
for (const n of ['A', 'B']) if (wipeP.nodes[n]) wipeP.nodes[n] = { ...wipeP.nodes[n], passes: [] }
prog30.save(wipeP)
const wipeS = prog30.loadSchedule()
if (wipeS.days?.[sd(0)]) wipeS.days[sd(0)].actual = []
prog30.saveSchedule(wipeS)

const l31i = await T30.get('coach_log').execute({
  node: 'A', problemId: 'P2880', actualMin: 16, solved: true, independent: true, date: sd(0) })
check('★ 带题号记第一道：记上了', l31i.ok === true && l31i.replaced === false,
  `replaced=${l31i.replaced} reject=${l31i.reject}`)
check('★ 题号回显', l31i.problemId === 'P2880', l31i.problemId)
check('★ 这天这个点现在 1 条', l31i.sameDayEntries === 1, `${l31i.sameDayEntries}`)

const l31j = await T30.get('coach_log').execute({
  node: 'A', problemId: 'CF1548B', actualMin: 48, solved: true, independent: false, date: sd(0) })
check('★ 带题号记第二道：**不覆盖第一道**（原来这一天这个点只存得下一条）',
  l31j.ok === true && l31j.replaced === false && l31j.sameDayEntries === 2,
  `replaced=${l31j.replaced} 条数=${l31j.sameDayEntries}`)

const l31k = await T30.get('coach_log').execute({
  node: 'A', problemId: 'CF1548B', actualMin: 50, solved: true, independent: false, date: sd(0) })
check('★ 同一个题号再记 → 才是覆盖（题号是去重键的一半）',
  l31k.replaced === true && l31k.sameDayEntries === 2,
  `replaced=${l31k.replaced} 条数=${l31k.sameDayEntries}`)

const l31m1 = await T30.get('coach_log').execute({
  node: 'B', actualMin: 30, solved: true, independent: false, date: sd(0) })
const l31m2 = await T30.get('coach_log').execute({
  node: 'B', actualMin: 35, solved: true, independent: false, date: sd(0) })
check('★ 不给题号 = 老行为：仍然是覆盖（老调用不受影响）',
  l31m1.replaced === false && l31m2.replaced === true,
  `第一次 replaced=${l31m1.replaced} 第二次 replaced=${l31m2.replaced}`)

const schedA = prog30.loadSchedule().days[sd(0)].actual.filter((r) => r.node === 'A')
check('★ 落盘：同一天同节点两条，各带自己的题号',
  schedA.length === 2 &&
  schedA.map((r) => r.problemId).join(',') === 'P2880,CF1548B',
  JSON.stringify(schedA.map((r) => `${r.problemId || '(无题号)'}:${r.actualMin}`)))

const st31b = await T30.get('coach_status').execute({})
const st31bTxt = T30.get('coach_status').output.render({}, st31b)[0].text
check('★ 汇总把题号带出来了（不报出来 = 记了等于没收）',
  st31b.recentPasses.some((x) => x.problemId === 'P2880') && st31bTxt.includes('P2880'),
  (st31bTxt.match(/.*做完记录.*/) ?? ['（没有）'])[0].slice(0, 110))
check('★ 条目数与题数都报（这个夹具里两者相等：3 条 = 3 题）',
  st31b.passTotal === 3 && st31b.problemTotal === 3,
  `条目=${st31b.passTotal} 题=${st31b.problemTotal}`)
check('★ 独立做出按**题**算：P2880 独立、CF1548B 不独立 → 独立 1',
  st31b.problemTotal === 3 && st31b.problemSolved === 3 && st31b.problemIndependent === 1,
  JSON.stringify({ 题: st31b.problemTotal, 做出: st31b.problemSolved, 独立: st31b.problemIndependent }))

prog30.save(snapProg31b)
prog30.saveSchedule(snapSched31b)

// ══════════════════════════════════════════════════════════════════
// 32. agent/pre-step 钩子：每个 turn 注入「他站在哪」
// ══════════════════════════════════════════════════════════════════
// 方针 §五 第四层。前面十五个工具是"能调"，这个钩子是"不用调就知道"。
// 它也是唯一一条**每一轮都会跑**的代码 —— 所以最要紧的性质不是"注入得对"，
// 是"**注入失败绝不能影响对话**"。这一节的最后几条就是钉这个的。
console.log('── 32. pre-step 钩子 ──')
const tmp32 = mkdtempSync(path.join(os.tmpdir(), 'coach-hook-'))
writeFileSync(path.join(tmp32, 'MAP.yaml'), mini(''))
process.env.COACH_DATA_DIR = tmp32
const mod32 = await import(`${INSTALLED}?fresh=32`)
const hooks32 = []
mod32.apply(mockCtx([], { hooks: hooks32 }))
const pre32 = hooks32.find((h) => h.event === 'agent/pre-step')?.fn
check('★ 钩子注册上了（挂在 agent/pre-step 上）', typeof pre32 === 'function',
  JSON.stringify(hooks32.map((h) => h.event)))

// next() 的返回值：一个"进入这一步"的决定，带一条已有的消息
const enter = (extra = {}) => async () => ({
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: '（原来的消息）' }] }],
  ...extra,
})
const textOf32 = (d) => d.messages.at(-1)?.content?.[0]?.text ?? ''

// ① 没有游标的空进度 —— 不该注入（空状态块只是白烧 token）
const d_empty = await pre32({ messages: [], step: 1 }, enter())
check('空进度不注入（三样都没有就闭嘴，别白烧 token）',
  d_empty.messages.length === 1, `${d_empty.messages.length} 条`)

// ② 有游标 + 在学 + 押着卷 —— 该注入，而且三样都要在里面
const h32 = { version: 1, cursor: 'A', updated: '2026-09-16', nodes: {
  B: { status: 'studying', at: '2026-09-01' },
  C: { status: 'learned', at: '2026-09-01' },
}, pending: { node: 'A', date: '2026-09-16', totalMinutes: 90, passScore: 4, maxScore: 6,
  problems: [{ problemId: 'X1' }, { problemId: 'X2' }, { problemId: 'X3' }] } }
writeFileSync(path.join(tmp32, 'PROGRESS.yaml'), JSON.stringify(h32))
const d_state = await pre32({ messages: [], step: 1 }, enter())
const txt32 = textOf32(d_state)
check('★ 有位置时注入了一条消息（追加在末尾，不碰 system prompt）',
  d_state.messages.length === 2 && d_state.messages.at(-1)?.source?.kind === 'plugin:acmer-coach',
  `${d_state.messages.length} 条，source=${JSON.stringify(d_state.messages.at(-1)?.source)}`)
check('★ 注入里带着游标', txt32.includes('游标：A'), (txt32.match(/.*游标.*/) ?? [''])[0])
check('★ 带着「在学」', txt32.includes('在学') && txt32.includes('B'),
  (txt32.match(/.*在学.*/) ?? [''])[0])
check('★ 带着押着的卷 + 撤卷出口（不然模型又只有"编成绩"一条路）',
  txt32.includes('押着一张卷') && txt32.includes('coach_cancel'),
  (txt32.match(/.*押着.*/) ?? [''])[0])
check('「学过但没验证」的不算在学（learned ≠ studying）', !txt32.includes('C'),
  txt32.includes('C') ? 'C 混进来了' : 'ok')

// ③ 只在 turn 的第一步注入 —— 每步都塞的话，一次工具往返就多一份重复的
const d_step2 = await pre32({ messages: [], step: 2 }, enter())
check('★ step≠1 不注入（一次工具往返不重复塞）', d_step2.messages.length === 1,
  `${d_step2.messages.length} 条`)
const d_skip = await pre32({ messages: [], step: 1 }, async () => ({ kind: 'skip', messages: [] }))
check('decision 不是 enter 时原样放过', d_skip.kind === 'skip')

// ④ **注入失败不能影响对话** —— 这是这个钩子最要紧的性质。
// 挂在每一轮的第一步上：它抛错 = 每一轮都炸。
// 这里故意给一个 messages 不是数组的 decision，逼它在拼消息那步炸掉。
const broken32 = { kind: 'enter', messages: undefined, marker: '原样还我' }
const d_broken = await pre32({ messages: [], step: 1 }, async () => broken32)
check('★ 注入炸了也只原样放过（每一轮都跑的代码，抛错等于每轮都炸）',
  d_broken === broken32 && d_broken.marker === '原样还我', JSON.stringify(d_broken)?.slice(0, 60))

// ══════════════════════════════════════════════════════════════════
// 33. 火候：排课时把「哪些放得最久」摆出来
// ══════════════════════════════════════════════════════════════════
// 教练**能**判断该不该复习/开卷，但前提是它主动去查
// 那些数据 —— 不查就废。所以摆进**排课这个动作**的输出里：
// 他让它排课，它就一定看得见，不依赖"它记得去看"。
//
// ⚠️ 只报**事实**（放了多少天、做过几题、独立几次），不报"该复习了"。
// AGENTS.md 规则 7 明写那些天数是「数字，不是开关」——
// 一旦把 7 天 / 30 天写进代码，软信号就变成硬规则了。
console.log('── 33. 火候（排课时看得见）──')
const tmp33 = mkdtempSync(path.join(os.tmpdir(), 'coach-ready-'))
writeFileSync(path.join(tmp33, 'MAP.yaml'), mini(''))
// 两个节点，故意造出"放得久的在前"的对比：
//   老人：verified，**没有 at**（模拟 coach_grade 修之前写下的老记录）→ 要回退到判卷日期
//   新人：studying，at 是 3 天前
writeFileSync(path.join(tmp33, 'PROGRESS.yaml'), [
  'version: 1',
  'cursor: B',
  'updated: 2026-09-16',
  'nodes:',
  '  A:',
  '    status: verified',
  '    checks:',
  '      - date: 2026-06-01',
  '        outcome: passed',
  '        score: 6',
  '        maxScore: 6',
  '        passScore: 4',
  '        minutes: 60',
  '        limit: 90',
  '        verifiedAt: 1700',
  '        selfReported: 0',
  '        problems: []',
  '    passes:',
  '      - date: 2026-05-30',
  '        solved: true',
  '        independent: true',
  '        minutes: 30',
  '  B:',
  '    status: studying',
  // ⚠️ **相对**日期，别写死：写死的那版在 9-16 跑出来是"3 天前"，9-18 就成了
  // 5 天 —— 断言跟着日历自己烂掉（这是一次既有失败，不是新代码引入的）
  `    at: ${sd(-3)}`,
  '',
].join('\n'))
process.env.COACH_DATA_DIR = tmp33
const mod33 = await import(`${INSTALLED}?fresh=33`)
const reg33 = []
mod33.apply(mockCtx(reg33))
const T33 = new Map(reg33.map((t) => [t.name, t]))

const sch33 = await T33.get('coach_schedule').execute({ days: 2 })
check('★ coach_schedule 带上火候了', Array.isArray(sch33.readiness) && sch33.readiness.length === 2,
  JSON.stringify(sch33.readiness?.map((r) => r.node)))
const rA33 = sch33.readiness.find((r) => r.node === 'A')
const rB33 = sch33.readiness.find((r) => r.node === 'B')
check('★ verified 但缺 at 的老记录 → 回退到「最后一次判过的日期」',
  rA33?.since === '2026-06-01' && rA33.days > 100,
  JSON.stringify({ since: rA33?.since, days: rA33?.days }))
check('★ 按放得最久的排前面（排序是事实，排序不是阈值）',
  sch33.readiness[0].node === 'A', sch33.readiness.map((r) => r.node).join('>'))
check('★ 报的是独立做出那一条腿（做过 1 / 独立 1）',
  rA33?.passTotal === 1 && rA33.passIndependent === 1, JSON.stringify(rA33))
check('studying 的用 at 算天数（3 天前标的）', rB33?.days === 3, `${rB33?.days}`)

const txt33 = T33.get('coach_schedule').output.render({}, sch33)[0].text
check('★ 渲染里摆得出来，且标明"该不该动是你判"',
  txt33.includes('火候') && txt33.includes('该不该动是你判'), (txt33.match(/.*火候.*/) ?? [''])[0])
check('★ 排课提醒里带着「复习别把新知识挤没」',
  txt33.includes('复习别把新知识挤没了') && txt33.includes('留给推进'),
  (txt33.match(/.*复习别把.*/) ?? ['（没有）'])[0].slice(0, 50))

// 没有火候（全是未学/没有记录）时不该硬塞一段
const tmp33b = mkdtempSync(path.join(os.tmpdir(), 'coach-ready-b-'))
writeFileSync(path.join(tmp33b, 'MAP.yaml'), mini(''))
process.env.COACH_DATA_DIR = tmp33b
const mod33b = await import(`${INSTALLED}?fresh=33b`)
const reg33b = []
mod33b.apply(mockCtx(reg33b))
const sch33b = await mod33b.schedApi.scheduleOverview()
check('没有在学/已验证的节点时火候是空的（不留空壳段）',
  sch33b.readiness.length === 0, JSON.stringify(sch33b.readiness))

// ══════════════════════════════════════════════════════════════════
// 34. 押着的训练动作（需求 #6）
// ══════════════════════════════════════════════════════════════════
// 布置的动作原先**只活在当次调用的返回里**：不落盘、不进 coach_status。
// 跨会话再开时教练不知道他手上有没有活，只能去翻会话日志的散文 ——
// 今天真发生过（17:55 布置过 P1004，21:35 回来时查不到，差一点重复布置）。
// 三条验收都是布尔的：布置后报得出来 / **换个模块实例（＝新会话）**仍报得出来 /
// 落地或被撤之后不再出现。
console.log('── 34. 押着的训练动作（需求 #6）──')
const tmp34 = mkdtempSync(path.join(os.tmpdir(), 'coach-pending-'))
// 用中文 id 的合成地图：验收①要求输出里出现**节点 id**，
// 拿 A/B/C 那种单字母做夹具的话，"出现"可能是别处的巧合。
const map34 = `meta: { version: 9, node_count: 3 }
nodes:
  - id: 记忆化搜索
    name: 记忆化搜索
    domain: 测试
    depends: []
  - id: 区间 DP
    name: 区间 DP
    domain: 测试
    depends: [记忆化搜索]
  - id: 树形 DP
    name: 树形 DP
    domain: 测试
    depends: [记忆化搜索]
`
writeFileSync(path.join(tmp34, 'MAP.yaml'), map34)
process.env.COACH_DATA_DIR = tmp34
const mod34 = await import(`${INSTALLED}?fresh=34`)
const reg34 = []
mod34.apply(mockCtx(reg34))
const T34 = new Map(reg34.map((t) => [t.name, t]))
const asg34 = T34.get('coach_assign')
const sta34 = T34.get('coach_status')
const log34 = T34.get('coach_log')
const una34 = T34.get('coach_unassign')
const txt34 = (t, v) => t.output.render({}, v)[0].text
const prog34 = () => readFileSync(path.join(tmp34, 'PROGRESS.yaml'), 'utf8')
check('注册了 coach_unassign（撤销出口）', Boolean(una34))

// ── 布置：游标 = 记忆化搜索，区间 DP 是它的下一层（未学 → 必须带讲解段）──
const a34 = await asg34.execute({
  cursor: '记忆化搜索', node: '区间 DP',
  deliverable: 'P1004 的代码 + 一句话状态定义', why: '依赖已满足', teachMinutes: 15,
})
const a34txt = txt34(asg34, a34)
check('布置成功', a34.accepted === true, a34.reject)
check('★ 布置时押进账本', a34.pendingRecorded === true, String(a34.pendingRecorded))
check('★ 第一次布置不算覆盖', a34.pendingReplaced === false, String(a34.pendingReplaced))
check('★ render 说得出"押上了"', a34txt.includes('押上了'),
  a34txt.split('\n').filter((l) => l.includes('押')).join(' / '))
check('★ 落盘：文件里搜得到交付物关键词（复现件里"搜 P1004 → 0 命中"的反面）',
  prog34().includes('P1004'), (prog34().match(/.*P1004.*/) ?? ['（没有）'])[0].trim().slice(0, 60))

// ── 验收 ①：布置后 coach_status 报得出来（节点 id / 交付物 / 时间盒）──
const s34 = await sta34.execute({})
const s34txt = txt34(sta34, s34)
check('★ 验收①：status 报出押着的动作（一条）', s34.pendingActions.length === 1,
  JSON.stringify(s34.pendingActions.map((x) => x.node)))
check('★ 验收①：节点 id 在输出里', s34txt.includes('区间 DP'),
  (s34txt.match(/.*押着的动作.*/) ?? ['（没有那一段）'])[0])
check('★ 验收①：交付物在输出里', s34txt.includes('P1004'))
check('★ 验收①：时间盒在输出里（自己做 40 + 收尾 20 = 60，另加先讲 15 共 75）',
  s34txt.includes('自己做 40') && s34txt.includes('收尾 20') &&
  s34txt.includes('= 60 分钟') && s34txt.includes('共 75'),
  (s34txt.match(/.*时间盒.*/) ?? ['（没有）'])[0].trim())
check('★ 押了几天跟着报（今天押的 → 0 天）', s34.pendingActions[0].days === 0,
  JSON.stringify({ at: s34.pendingActions[0].at, days: s34.pendingActions[0].days }))

// ── 验收 ②：**换个模块实例 = 新会话**，仍报得出来 ──
const mod34b = await import(`${INSTALLED}?fresh=34b`)
const reg34b = []
mod34b.apply(mockCtx(reg34b))
const sta34b = reg34b.find((t) => t.name === 'coach_status')
const s34b = await sta34b.execute({})
check('★ 验收②：新会话（重新 import）仍报得出它 —— 判据是输出含交付物关键词',
  s34b.pendingActions.length === 1 && sta34b.output.render({}, s34b)[0].text.includes('P1004'),
  `条数=${s34b.pendingActions.length}`)

// ── 白名单关：saveProgress 是显式白名单，漏一个字段就静默冲掉 ──
const lg34x = await log34.execute({ node: '树形 DP', actualMin: 20, solved: true, independent: true })
check('（前置）记一条别的节点的做完记录成功', lg34x.ok === true, lg34x.reject)
check('★ 记完别的之后押着的还在（白名单漏了就会静默消失）',
  (await sta34.execute({})).pendingActions.length === 1)

// ── 覆盖：同一节点再布置 → 只剩新的那条 ──
const a34b = await asg34.execute({
  cursor: '记忆化搜索', node: '区间 DP',
  deliverable: 'P11753 的题解复述', why: '换一道', teachMinutes: 15,
})
check('★ 同节点再布置 = 覆盖（pendingReplaced）', a34b.pendingReplaced === true, String(a34b.pendingReplaced))
const s34c = await sta34.execute({})
check('★ 覆盖之后只剩一条，而且是新的那条',
  s34c.pendingActions.length === 1 && s34c.pendingActions[0].deliverable.includes('P11753'),
  JSON.stringify(s34c.pendingActions.map((x) => x.deliverable)))

// ── 验收 ③-a：落地即销（coach_log）──
const lg34 = await log34.execute({ node: '区间 DP', actualMin: 22, solved: true, independent: true })
check('★ 验收③a：记完做完记录 → actionCleared', lg34.actionCleared === true, String(lg34.actionCleared))
const lg34txt = txt34(log34, lg34)
check('★ 落地那条 render 里说出来', lg34txt.includes('销了'),
  lg34txt.split('\n').filter((l) => l.includes('销')).join(' / '))
const s34d = await sta34.execute({})
check('★ 验收③a：再调 status，它不再出现',
  s34d.pendingActions.length === 0 && !txt34(sta34, s34d).includes('押着的动作'))

// ── 验收 ③-b：撤销出口 ──
await asg34.execute({
  cursor: '记忆化搜索', node: '树形 DP', deliverable: 'P2880 的代码', why: '测试', teachMinutes: 10,
})
const u34 = await una34.execute({ node: '树形 DP', reason: '他说先不做了' })
check('★ 验收③b：撤得掉', u34.ok === true && u34.remaining === 0, u34.reject)
const u34txt = txt34(una34, u34)
check('★ 撤销 render 说明"状态没动"', u34txt.includes('没动'), u34txt.replace(/\n/g, ' / '))
const s34e = await sta34.execute({})
check('★ 验收③b：撤完不再出现',
  s34e.pendingActions.length === 0 && !txt34(sta34, s34e).includes('押着的动作'))
check('★ 撤销**不碰知识点状态**（撤动作 ≠ 没学，也 ≠ 学了）',
  !prog34().includes('status: verified'), '（夹具里本来就没有 verified）')

// ── 反向测试：别静默成功、别拿数量含糊 ──
const u34none = await una34.execute({})
check('★ 手上没押着动作 → 拒绝（不是静默成功）',
  u34none.ok === false && u34none.reject.includes('没有押着'), u34none.reject)

await asg34.execute({
  cursor: '记忆化搜索', node: '区间 DP', deliverable: 'P1004 的代码', why: '测试', teachMinutes: 10,
})
await asg34.execute({
  cursor: '记忆化搜索', node: '树形 DP', deliverable: 'P2880 的代码', why: '测试', teachMinutes: 10,
})
const u34amb = await una34.execute({})
check('★ 押着两条、不说是哪条 → 拒绝并列出候选',
  u34amb.ok === false && u34amb.reject.includes('区间 DP') && u34amb.reject.includes('树形 DP'),
  u34amb.reject)
const s34f = await sta34.execute({})
check('★ 两条都报得出来（按押的时间正序）', s34f.pendingActions.length === 2,
  s34f.pendingActions.map((x) => x.node).join(','))
const u34miss = await una34.execute({ node: '记忆化搜索' })
check('★ 撤一个没押着动作的节点 → 拒绝（别静默当成功）',
  u34miss.ok === false && u34miss.reject.includes('没有押着'), u34miss.reject)

// ══════════════════════════════════════════════════════════════════
// 35. 时间盒口径统一：40 = 他自己做多久（需求 #7）
// ══════════════════════════════════════════════════════════════════
// 改之前：coach_assign 的参数是**整块长度**（工具内部减 20 才是自己做），
// 而 coach_plan 的 cycle 和 AGENTS.md 说的「40 分钟止损点」都是"自己做" ——
// 同一个 40 两个意思，小鲸排课时报时间线直接卡住（传 40 只拿到 20 自己做）。
// 现在全局只有一种单位：**净时间**；整块 = 净 + 收尾 20（固定不压缩）。
console.log('── 35. 时间盒口径：净时间（需求 #7）──')
const tmp35 = mkdtempSync(path.join(os.tmpdir(), 'coach-net-'))
writeFileSync(path.join(tmp35, 'MAP.yaml'), map34)   // 复用 34 节的中文地图
process.env.COACH_DATA_DIR = tmp35
const mod35 = await import(`${INSTALLED}?fresh=35`)
const reg35 = []
mod35.apply(mockCtx(reg35))
const T35 = (n) => reg35.find((t) => t.name === n)
const asg35 = T35('coach_assign')
const txt35 = (t, v) => t.output.render({}, v)[0].text
const base35 = { cursor: '记忆化搜索', node: '区间 DP', deliverable: 'P1004 的代码', teachMinutes: 15 }

const a35 = await asg35.execute({ ...base35 })
check('★ 默认 = 净 40（整块 60）—— 跟改之前的行为**一模一样**',
  a35.accepted === true && a35.minutes === 40 && a35.tailMinutes === 20 && a35.totalMinutes === 75,
  JSON.stringify({ 净: a35.minutes, 收尾: a35.tailMinutes, 共: a35.totalMinutes }))
check('★ 块表 = 讲15 / 做40 / 遗留10 / 重写10',
  JSON.stringify(a35.blocks.map((b) => b.minutes)) === '[15,40,10,10]',
  JSON.stringify(a35.blocks.map((b) => `${b.kind}:${b.minutes}`)))
const t35a = txt35(asg35, a35)
check('★ 渲染把两个数都印出来（同一个 40 两个意思，就是这条要治的病）',
  t35a.includes('自己做 40') && t35a.includes('收尾 20') && t35a.includes('= 共 60 分钟'),
  (t35a.match(/.*时间盒.*/) ?? ['（没有）'])[0].trim())
check('★ 默认时不啰嗦（boxNote 空）', a35.boxNote === '' && !t35a.includes('止损点'), a35.boxNote)

const a35b = await asg35.execute({ ...base35, minutes: 30 })
check('★ 净 30 → 整块 50（30+20），并提醒「你压的是止损点，不是块」',
  a35b.accepted === true && a35b.totalMinutes === 65 && a35b.boxNote.includes('你压的是止损点'),
  a35b.boxNote)
check('★ 净 ≠ 40 时点出「表上排不出这个形状」（表上只有 60/25/90）',
  a35b.boxNote.includes('排不出这个形状') && a35b.boxNote.includes('cycle 60 / review 25 / exam 90'),
  a35b.boxNote)
const t35b = txt35(asg35, a35b)
check('★ 提醒印进人话里', t35b.includes('⚠️') && t35b.includes('止损点'),
  (t35b.match(/.*⚠️.*/) ?? ['（没有）'])[0].trim())

const a35c = await asg35.execute({ ...base35, minutes: 29 })
check('★ 净 29（低于下限 30）→ 拒，理由指路换更小的题 / review 块',
  a35c.accepted === false && a35c.reject.includes('太短') && a35c.reject.includes('review'),
  a35c.reject.split('\n')[0])
check('★ 被拒时形状也齐（新字段漏一个，理由就会被盖成校验错）',
  a35c.minutes === 29 && a35c.tailMinutes === 20 && a35c.boxNote === '',
  JSON.stringify({ 净: a35c.minutes, 收尾: a35c.tailMinutes, boxNote: a35c.boxNote }))

const a35d = await asg35.execute({ ...base35, minutes: 60 })
check('★ 净 60 → 整块 80，同样提醒形状对不上',
  a35d.accepted === true && a35d.totalMinutes === 95 && a35d.boxNote.includes('排不出这个形状'),
  a35d.boxNote)

// 账本（#6 的 pendingActions）里存的必须是**拆开的数**，口径才不会下次再漂
const pa35 = (await T35('coach_status').execute({})).pendingActions
check('★ 账本里存拆开的数：自己做 60 / 收尾 20 / 讲 15 / 共 95',
  pa35.length === 1 && pa35[0].solveMinutes === 60 && pa35[0].tailMinutes === 20 &&
  pa35[0].teachMinutes === 15 && pa35[0].totalMinutes === 95, JSON.stringify(pa35[0]))

// ══════════════════════════════════════════════════════════════════
// 36. 计划 vs 实际接上了 + plannedMin 不再存快照（需求 #8）
// ══════════════════════════════════════════════════════════════════
// 改之前：实际用时早就在 SCHEDULE.yaml 里，coach_schedule 却一行都不印 ——
// 排课时只能拍脑袋；而且 plannedMin 是"记的时候算一次"的快照，计划一改就过期
// （09-21 的真实案例：文件里存 120、按现在的表算是 60）。
console.log('── 36. 计划 vs 实际 + plannedMin 现算（需求 #8）──')
const tmp36 = mkdtempSync(path.join(os.tmpdir(), 'coach-plan-actual-'))
writeFileSync(path.join(tmp36, 'MAP.yaml'), map34)
writeFileSync(path.join(tmp36, 'SCHEDULE.yaml'), [
  'version: 1',
  `updated: "${sd(0)}"`,
  'days:',
  `  "${sd(0)}":`,          // 今天：排 1 块、记 1 条，而且文件里放着**过期的** plannedMin
  '    planned:',
  '      - { from: "10:00", to: "11:00", kind: cycle, node: 区间 DP }',
  '    actual:',
  '      - { node: 区间 DP, plannedMin: 999, actualMin: 47, solved: true, independent: true }',
  `  "${sd(-1)}":`,         // 昨天：同节点排 2 块（25 + 60）、只记到 1 条
  '    planned:',
  '      - { from: "10:00", to: "10:25", kind: review, node: 树形 DP }',
  '      - { from: "10:30", to: "11:30", kind: cycle, node: 树形 DP }',
  '    actual:',
  '      - { node: 树形 DP, actualMin: 15, solved: true, independent: true }',
  `  "${sd(-2)}":`,         // 前天：排了块、一条记录都没有
  '    planned:',
  '      - { from: "09:00", to: "10:00", kind: cycle, node: 记忆化搜索 }',
  '',
].join('\n'))
process.env.COACH_DATA_DIR = tmp36
const mod36 = await import(`${INSTALLED}?fresh=36`)
const reg36 = []
mod36.apply(mockCtx(reg36))
const T36 = (n) => reg36.find((t) => t.name === n)
const sch36 = T36('coach_schedule')
const log36 = T36('coach_log')
const v36 = await sch36.execute({ days: 4 })
const txt36 = sch36.output.render({}, v36)[0].text
const day36 = (off) => v36.days.find((d) => d.date === sd(off))

check('★ 计划块后面接上了实际：实际分钟 / 做出来没有 / 独立没有，三样都要',
  txt36.includes('实际 47 分钟，独立做出'),
  (txt36.match(/.*↳.*/) ?? ['（没有回填行）'])[0].trim())
check('★ plannedMin **现算**：文件里写的是 999（过期快照），渲染必须是 60',
  txt36.includes('排 60 分钟 / 实际 47 分钟'),
  (txt36.match(/.*↳ 排.*/) ?? ['（没有）'])[0].trim())
check('★ 结构化输出里也是现算的（不是 999）',
  day36(0)?.actual?.[0]?.plannedMin === 60, String(day36(0)?.actual?.[0]?.plannedMin))
check('★ 条数对不上要明说：同节点排 2 块、记到 1 条（09-17 就是这个形状）',
  txt36.includes('排 85 分钟') && txt36.includes('排了 2 块，记到 1 条'),
  (txt36.match(/.*↳ 排 85.*/) ?? ['（没有）'])[0].trim())
check('★ 排了没记 → 「无实际记录」（陈述，不是判决：不许出现"计划了没做"）',
  txt36.includes('无实际记录') && !txt36.includes('计划了没做'),
  (txt36.match(/.*无实际记录.*/) ?? ['（没有）'])[0].trim())
check('★ 排 0 记 0 的天不印空壳段（回填行正好 3 条 = 三个有排块的天）',
  (txt36.match(/↳/g) ?? []).length === 3, `${(txt36.match(/↳/g) ?? []).length} 条`)

// coach_log：落盘不带快照 + 给训练员看的话是中性回显
const lg36 = await log36.execute({ node: '区间 DP', actualMin: 47, solved: true, independent: true, date: sd(0) })
const lg36txt = log36.output.render({}, lg36)[0].text
check('★ 给训练员看的那句只留中性回显（不带「比排的多花/少花」）',
  lg36txt.includes('记住了：47 分钟') && !lg36txt.includes('比排的') && !lg36txt.includes('计划 60'),
  lg36txt.split('\n')[1])
check('★ 教练侧仍拿得到偏差（挪过去，不是删掉）',
  lg36.plannedMin === 60 && lg36.actualMin === 47 && lg36.deviation === -13,
  JSON.stringify({ 计划: lg36.plannedMin, 实际: lg36.actualMin, 差: lg36.deviation }))
const file36 = readFileSync(path.join(tmp36, 'SCHEDULE.yaml'), 'utf8')
check('★ 落盘里不再写 plannedMin 快照（夹具里那条老的被覆盖后，全文 0 次）',
  (file36.match(/plannedMin/g) ?? []).length === 0,
  `全文 ${(file36.match(/plannedMin/g) ?? []).length} 次`)

// ══════════════════════════════════════════════════════════════════
// 37. 前沿候选的可执行下一步（需求 #9）+ 夹具写接口闸门（需求 #10）
// ══════════════════════════════════════════════════════════════════
console.log('── 37. 前沿的下一步 + 夹具写接口闸门（需求 #9 / #10）──')
const tmp37 = mkdtempSync(path.join(os.tmpdir(), 'coach-fixgate-'))
writeFileSync(path.join(tmp37, 'MAP.yaml'), map34)
process.env.COACH_DATA_DIR = tmp37
const mod37 = await import(`${INSTALLED}?fresh=37`)
const reg37 = []
mod37.apply(mockCtx(reg37))
const T37 = (n) => reg37.find((t) => t.name === n)

// ── 需求 #9：游标停在末端节点 → next 给前沿，且必须写明"怎么才能布置" ──
const nx37 = await T37('coach_next').execute({ cursor: '区间 DP' })
const nx37txt = T37('coach_next').output.render({}, nx37)[0].text
check('（前置）游标停在末端节点 → 走兜底前沿', nx37.fallbackUsed === true,
  `fallbackUsed=${nx37.fallbackUsed}　前沿=${nx37.frontier?.length ?? 0} 个`)
check('★ 需求 #9：前沿那段给出**可执行的下一步**（先把游标挪过去）',
  nx37txt.includes('coach_set_cursor') && nx37txt.includes('先把游标挪过去'),
  (nx37txt.match(/.*挪过去.*/) ?? ['（没有）'])[0].trim().slice(0, 100))
check('★ 需求 #9：并说清为什么（assign 只认下一层，直接布置会被拒）',
  nx37txt.includes('会被拒'), (nx37txt.match(/.*会被拒.*/) ?? ['（没有）'])[0].trim().slice(0, 100))

// ── 需求 #10：夹具写接口不许写真账本 ──
// 判据是「**没**显式指定 COACH_DATA_DIR」—— 那种情况下 DATA_DIR 就是默认目录，
// 也就是用户的真账本。所以这一段故意**不设** COACH_DATA_DIR，验它会被拒。
// ⚠️ 闸门要是失效，这里就会真的写进默认目录 —— 所以先取指纹、跑完再比一次。
// 必须和 index.js 的推导**逐字一致**：`COACH_DATA_DIR || ~/.dsh/knowledge`。
// （早先这里写成 $DSH_HOME/knowledge，而插件用的是 homedir() —— 比的不是
//  同一个目录，等于这条指纹校验形同虚设。测试自己的路径也得是单一真相。）
const DEFAULT_KNOWLEDGE = process.env.COACH_DEFAULT_KNOWLEDGE
  || path.join(os.homedir(), '.dsh', 'knowledge')
const ledger37 = () => ['PROGRESS.yaml', 'SCHEDULE.yaml']
  .map((f) => { try { return readFileSync(path.join(DEFAULT_KNOWLEDGE, f), 'utf8') } catch { return '' } })
  .join('\u0000')
const before37 = ledger37()
delete process.env.COACH_DATA_DIR
const mod37real = await import(`${INSTALLED}?fresh=37real`)
let gate37 = null
try {
  mod37real.schedApi.planDay(sd(0), [{ from: '09:00', kind: 'review', node: '记忆化搜索' }])
} catch (err) { gate37 = err }
check('★ 需求 #10①：没显式指定数据目录 → 夹具写接口抛错，理由点明"夹具 / 真账本"',
  gate37 instanceof Error && gate37.message.includes('夹具') && gate37.message.includes('真账本'),
  gate37 ? gate37.message.slice(0, 110) : '（没拒！）')
check('★ 需求 #10①：这一跑之后默认目录一字未动',
  ledger37() === before37, ledger37() === before37 ? '一字未动' : '（被改了！）')

// ② 临时目录上照常成功（闸门不许把夹具的正常用法一起掐掉）
process.env.COACH_DATA_DIR = tmp37
const mod37b = await import(`${INSTALLED}?fresh=37b`)
const r37 = mod37b.schedApi.planDay(sd(0), [{ from: '09:00', kind: 'review', node: '记忆化搜索' }])
check('★ 需求 #10②：临时目录上同一个调用正常成功', r37?.ok === true, JSON.stringify(r37).slice(0, 100))

// ③ 不误伤生产路径：四个写工具走的都是工具入口，不经过夹具接口
// ⚠️ 顺序有讲究：② 那一步已经在 sd(0) 排了 09:00 一块，而「排一次就固化」
// 会拦下第二次排块（那是**正确行为**，不是闸门误伤）—— 所以先撤掉它再排。
const unplan37 = await T37('coach_unplan').execute({ date: sd(0), from: '09:00' })
check('★ 需求 #10③：coach_unplan 照常（工具入口，不经过 schedApi）', unplan37.ok === true, unplan37.reject)
const plan37 = await T37('coach_plan').execute({ date: sd(0), blocks: [{ from: '10:00', kind: 'cycle', node: '区间 DP' }] })
check('★ 需求 #10③：coach_plan 照常', plan37.ok === true, plan37.reject)
const asg37 = await T37('coach_assign').execute({
  cursor: '记忆化搜索', node: '区间 DP', deliverable: 'X 的代码', teachMinutes: 10 })
check('★ 需求 #10③：coach_assign 照常', asg37.accepted === true, asg37.reject)
const lg37 = await T37('coach_log').execute({ node: '区间 DP', actualMin: 20, solved: true, independent: true })
check('★ 需求 #10③：coach_log 照常', lg37.ok === true, lg37.reject)

// ══════════════════════════════════════════════════════════════════
// 38. 先讲闸门在游标节点上的洞// ══════════════════════════════════════════════════════════════════
// 小鲸在活进程里发现的：`coach_assign(node=游标, 不给 teachMinutes)` 被放行，
// 而 coach_status 同时报「还没有教学记录」。闸门里那条例外是**有意开的**
// （游标＝接着做，不逼重讲），但它没条件 —— 游标停在一个从没讲过的新节点上时，
// 豁免就等于把整个闸门绕过去。补法：豁免**限定在"讲过"**，而"讲过"要先有痕迹
// （原先讲完不留任何记录）。
console.log('── 38. 先讲闸门的游标例外 ──')
const tmp38 = mkdtempSync(path.join(os.tmpdir(), 'coach-teachgate-'))
writeFileSync(path.join(tmp38, 'MAP.yaml'), map34)
process.env.COACH_DATA_DIR = tmp38
const mod38 = await import(`${INSTALLED}?fresh=38`)
const reg38 = []
mod38.apply(mockCtx(reg38))
const T38 = (n) => reg38.find((t) => t.name === n)
const asg38 = T38('coach_assign')
const prog38 = () => readFileSync(path.join(tmp38, 'PROGRESS.yaml'), 'utf8')
// 夹具里的游标是空的 —— 先设上。（`coach_status` 报「讲于哪」读的是
// PROGRESS.yaml 里的游标，不是 assign 那条路径传进来的 cursor 参数。）
await T38('coach_set_cursor').execute({ node: '记忆化搜索' })

// ① 洞本身：游标停在**没讲过**的新节点上 → 不给 teachMinutes 必须被拒
const g38a = await asg38.execute({ cursor: '记忆化搜索', node: '记忆化搜索', deliverable: '贴代码', minutes: 40 })
check('★ 游标节点 + 没讲过 + 不给 teachMinutes → 拒（这就是那个洞）',
  g38a.accepted === false && g38a.reject.includes('全新知识点'), g38a.reject.split('\n')[0])

// ② 带讲授段 → 放行，而且**留下教学痕迹**
const g38b = await asg38.execute({
  cursor: '记忆化搜索', node: '记忆化搜索', deliverable: '贴代码', minutes: 40, teachMinutes: 20 })
check('★ 带 teachMinutes → 放行', g38b.accepted === true, g38b.reject)
check('★ 讲授段落盘：节点上记下 `taught`',
  prog38().includes('taught:'), (prog38().match(/.*taught.*/) ?? ['（没有）'])[0].trim())
const st38 = await T38('coach_status').execute({})
check('★ coach_status 报得出「讲于」那天（以前永远是"还没有教学记录"）',
  st38.cursorTaught !== '', `cursorTaught=${st38.cursorTaught || '（空）'}`)
check('★ 记讲授**不动 status**（讲了 ≠ 学会了 —— 自评/检测才是那两级）',
  st38.studyingCount === 0 && st38.learnedCount === 0 && st38.verifiedCount === 0,
  JSON.stringify({ 在学: st38.studyingCount, 学过: st38.learnedCount, 已验证: st38.verifiedCount }))

// ③ 讲过了 → 同一个游标节点再布置，不用重讲（豁免还在，只是有了条件）
const g38c = await asg38.execute({ cursor: '记忆化搜索', node: '记忆化搜索', deliverable: '贴代码', minutes: 40 })
check('★ 讲过之后：游标节点再布置**不用**重讲（豁免仍然生效）', g38c.accepted === true, g38c.reject)

// ④ 不误伤：非游标的新节点照样要讲
const g38d = await asg38.execute({ cursor: '记忆化搜索', node: '区间 DP', deliverable: '贴代码', minutes: 40 })
check('★ 非游标的新节点：不给 teachMinutes 照样拒（原有闸门没松）',
  g38d.accepted === false && g38d.reject.includes('全新知识点'), g38d.reject.split('\n')[0])

console.log()
if (fails.length) {
  console.log(`✗ ${fails.length} 条没过：`)
  fails.forEach((f) => console.log(`   · ${f}`))
  process.exit(1)
}
console.log('✓ 全部通过')

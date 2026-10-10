// acmer-coach
// ══════════════════════════════════════════════════════════════════
// 小鲸教练插件。目标：把「位置 + 判断」从小鲸的转述里拿回来 ——
// 给它唯一动作、让它读代码判因、按检测推进，而不是报一堆百分比。
//
// 注册走 bundle 层：package.json 声明 `dsh.bundle.patch`，由
// cordis.patch.yml 里那行 insert 挂上去。
//
// ⚠️ 改完代码**必须重启 dsh web**。
//    cordis 的 HMR 只重载**配置**，不重新 import **模块本体** ——
//    ESM 模块在进程里只求值一次，之后永远命中缓存，旧代码一直跑着，
//    **不报错、不报警**，看起来和正常一模一样。
//    日常迭代不用重启：`dev.sh` 用 verify.mjs **全新 import** 验，不走活进程。
//
// ── 调 API 时容易踩的几条 ────────────────────────────────────────
//   · 导出必须是 { apply, inject, name }。inject 少了下场是 ctx.tools 为
//     undefined 直接崩，不是静默降级。
//   · insert 行的 id 和这里导出的 name 不一致 → 工具**静默不注册**，不报错；
//     name 还必须和**包名**一致。verify.mjs 第 2 关盯这个。
//   · defineTool 的执行方法叫 execute，不叫 run；output 是**必填**。
//   · output.schema 是**原始 JSON Schema**（required 写在每个属性里）；
//     parameters 才是那套 DSL（对象必须显式写 additionalProperties）。
//   · `file:` 依赖装出来的是**硬链接**，不是拷贝。原地写两边同变，但改名式
//     写入（Edit 工具、VS Code 原子保存）会**断开链接**，断了两边分家，
//     而 `dsh plugin add` 认不出分家、不重链也不报错 —— 所以改完一律跑 dev.sh。
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse, stringify } from 'yaml'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { initDataDir, syncCodeforces, contactEvidence, importPool, importRecords } from './lib/setup.js'
import { createCurriculumStore, curriculumTool } from './lib/curriculum.js'
import { createStrategyStore } from './lib/strategy.js'

const name = 'acmer-coach'
const inject = ['tools']

const VERSION = '2.0.0'

// 块结构（方针 §4.1.1）：40 自己做 + 10 解决遗留 + 10 重写 = 60 分钟。
// 这是**一个题目循环**的固定形状。时间不够该换更小的题，不是把块压扁。
//
// ⚠️ **单位统一（需求 #7）**：系统里说「40 分钟」，一律指
// **他自己动手做题的净时间** —— 止损点就是它。收尾那 20 分钟（遗留 10 +
// 重写 10）**固定**、不随净时间压缩。
//   净 40（默认）→ 整块 60；净 30（下限）→ 整块 50
// coach_assign 的参数曾经是"总时长"（工具内部减 20 才是自己做），而
// coach_plan 的 cycle 和规则文件里的 40 都是"自己做" —— 同一个数两个意思，
// 报时间线就会卡在这儿（传 40，实际只拿到 20 分钟自己做）。
const NET_DEFAULT_MIN = 40        // 自己做：默认
const NET_FLOOR_MIN = 30          // 自己做：下限。再短就该换更小的题，不是压扁循环
const TAIL_MIN = 20               // 解决遗留(10) + 重写(10)，不随净时间压缩
const CYCLE_TOTAL_MIN = NET_DEFAULT_MIN + TAIL_MIN   // 60：题目循环的整块长度（plan 的 cycle 就是它）

// 开新知识点时「先讲一遍」那段的下限。
//
// 为什么有下限但**没有上限**：这个块的时间分配是教学判断，交给教练，
// 不给他卡死。上限会把它变成"填一个不超过 X 的数"，
// 而讲多久本来就该由教练定。
// 下限只挡没意义的输入（讲 1 分钟等于没讲），不表达任何偏好。
const TEACH_FLOOR_MIN = 10

// 数据根：教练的全部真相源都在这一个目录下。
// 默认落在 dsh 家目录下；COACH_DATA_DIR 可覆盖 ——
// 探针后端套路（在副本上验，不脏真库）和夹具写接口的闸门都靠它。
//
// ⚠️ `DATA_DIR_EXPLICIT` 必须在**同一时刻**、和 DATA_DIR 一起定下来。
// 早先夹具闸门是**调用时**去读 process.env 判断的，而 DATA_DIR 是加载时定的
// —— 两个时刻的事实可以不一样，于是"数据目录是默认的、闸门却放行"。
// 那正是这个闸门当初要治的那类 bug（两份真相），别让它自己再长一个出来。
const DATA_DIR_EXPLICIT = Boolean(process.env.COACH_DATA_DIR)
const DATA_DIR = process.env.COACH_DATA_DIR || join(homedir(), '.dsh', 'knowledge')
const MAP_PATH = () => join(DATA_DIR, 'MAP.yaml')
const curriculum = createCurriculumStore({ dataDir: DATA_DIR, loadMap, loadProgress, loadSchedule })
const strategy = createStrategyStore({
  dataDir: DATA_DIR,
  competenciesPath: join(import.meta.dirname, 'assets', 'knowledge', 'COMPETENCIES.yaml'),
})

// 探针要的文件，各自代表一条后面的依赖：
//   MAP.yaml      地图（coach_next 读它算候选）
//   DEPENDS.yaml  前置的**手改**源头（MAP.yaml 由它生成）
//   skilltree.html           技能树视图（页面上「标记已学」写 PROGRESS）
//
// ⚠️ 探针**只探数据文件**，别把项目文档塞进这个列表。两个理由：
//   ① 探针的职责是「数据目录通不通」，一份项目文档不是数据；
//   ② 更要紧的是它**污染教练的工作区**：`knowledge/` 是教练的数据目录，
//      教练每天看着它，那里不该躺着一份"插件还没做哪些功能"的清单。
const PROBE_FILES = [
  'MAP.yaml',
  'DEPENDS.yaml',
  'skilltree.html',
]

// 时间一律走**本地时区**。早先这里用 toISOString() 出的是 UTC，
// 于是 09:57 改的文件显示成 01:57 —— 看着像 8 小时前的旧货。
// 教练要拿它报"数据新鲜度"，差 8 小时会直接误导判断。
//
// 精度到**秒**，不是分钟。这不是洁癖：mapStamp 的契约是"能追溯这份候选是从
// 哪一版地图算出来的"，而缓存失效用的是 mtimeMs（毫秒）—— 两版地图只要在同
// 一分钟内落盘，分钟精度的 stamp 就会撞车，两个内容不同的版本顶着同一个标识符。
// 标识符不该有碰撞 —— 否则就会出现"标签一样、内容不同"。
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 只 stat 不 parse：够证明"读得到"就行。
// 统一返回三字段，避免 ok/error 两种形状让 output schema 变复杂。
function probe(file) {
  try {
    const st = statSync(join(DATA_DIR, file))
    const kb = (st.size / 1024).toFixed(1)
    return { file, status: 'ok', detail: `${kb} KB · ${localStamp(st.mtime)}` }
  } catch (err) {
    return { file, status: 'missing', detail: err.code || 'unknown' }
  }
}

// ── 地图（延迟加载 + 按 mtime 失效）─────────────────────────────
// 按 mtime 失效不是洁癖：今天一整天都在治「数据陈旧却报得像新的」这个病
// （日报断更、training-targets 过期、会话日志停更）。地图自己也必须守这条，
// 否则 build_map.py 重跑完，插件还在拿旧图算候选 —— 同一个病换个地方复发。
let _map = null

function loadMap() {
  const path = MAP_PATH()
  const mtime = statSync(path).mtimeMs
  if (_map && _map.mtime === mtime) return _map

  const doc = parse(readFileSync(path, 'utf8'))
  const nodes = doc.nodes ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // 反向索引：谁依赖我。技能树里的「下一层」就是查这个。
  const dependents = new Map()
  for (const n of nodes) {
    for (const d of n.depends ?? []) {
      if (!dependents.has(d)) dependents.set(d, [])
      dependents.get(d).push(n.id)
    }
  }

  _map = { meta: doc.meta ?? {}, nodes, byId, dependents, mtime, stamp: localStamp(new Date(mtime)) }
  return _map
}

// ── 进度（PROGRESS.yaml，和 MAP.yaml 并列的唯一真相源）──────────
//
// 四级状态：
//   不写       = 未学      没碰过
//   studying   = 在学      开了头、还没达标。**跨天是常态**，不是异常
//   learned    = 学过      训练员自评「我学过这个」，没做检测
//   verified   = 已验证    过了章节检测，有证据
//
// **「在学」不能省**：
//   游标 ≠ 在学。游标是「今天聚焦哪个」，一天一个；但开过没学完的可以有**好几个**。
//   比如今天要复习旧节、游标移走了，某个学了一半的知识点就会丢掉痕迹，
//   教练明天会对着没做完的题从头讲。而且「在学」是教练的排序信号：接着昨天的 > 开新的。
//
// **自评 ≠ 掌握，两级必须分开**（原则 3）：learned 和 verified 合成一个
// 「会/不会」是这套设计里最容易犯的错 —— 那等于又退回「从数据推断掌握度」。
//
// 只记**非未学**的节点。349 个全列出来是噪音，而且那样「没写」和「未学」
// 就分不清了 —— 缺省即未学，写了才算数。
//
// 游标显式存，不靠"已验证的最大深度"推 —— 推出来的东西没法手改，
// 而且他想复习某节时游标要能停在那儿。
const PROGRESS_PATH = () => join(DATA_DIR, 'PROGRESS.yaml')

function emptyProgress() {
  return { version: 1, cursor: '', updated: '', nodes: {}, pending: null }
}

function loadProgress() {
  let raw
  try {
    raw = readFileSync(PROGRESS_PATH(), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return emptyProgress()   // 还没有 = 空进度，正常
    throw err
  }
  const doc = parse(raw)
  return {
    version: doc?.version ?? 1,
    cursor: String(doc?.cursor ?? ''),
    updated: String(doc?.updated ?? ''),
    // 防御：手改文件时可能写成 null 或数组
    nodes: (doc?.nodes && typeof doc.nodes === 'object' && !Array.isArray(doc.nodes))
      ? doc.nodes : {},
    // 正押着的那张检测卷。**必须在这里显式接住** ——
    // loadProgress 只返回它认识的字段，漏了的话 saveProgress 一写就把它冲掉，
    // 而且是静默的：卷子没了，谁也不知道。
    pending: (doc?.pending && typeof doc.pending === 'object' && !Array.isArray(doc.pending))
      ? doc.pending : null,
    // 核实台账（需求 #1）。**和 pending 同一个道理**：这个函数
    // 只返回它认识的字段，漏一个就等着一写就把它冲掉 —— 而且静默：
    // 台账看着生效过，下一张卷又开始要求重核，谁也不知道为什么。
    // （这条规则在 pending 上面写着，我第一版还是漏了，测试当场抓住。）
    verified_problems: (doc?.verified_problems && typeof doc.verified_problems === 'object'
      && !Array.isArray(doc.verified_problems)) ? doc.verified_problems : null,
    // 押着的训练动作（需求 #6）。coach_assign 布置时写、coach_log 落地时销、
    // coach_unassign 撤销时销。**和 pending / verified_problems 是同一个坑**：
    // 这个函数只返回它认识的字段，漏一个就等着一写就把它冲掉 —— 而且静默：
    // 布置过的动作看起来"从没存在过"，下个会话就会把同一道题再布置一遍。
    pendingActions: (doc?.pendingActions && typeof doc.pendingActions === 'object'
      && !Array.isArray(doc.pendingActions)) ? doc.pendingActions : null,
  }
}

// 文件头。写的时候由代码贴回去 —— yaml 库的 stringify **不吃注释**，
// 直接 dump 会把这段说明冲掉（第一次 coach_mark 就没了）。
// 放代码里而不是文件里，好处是每次写出来的完全一致，不会一次一个样。
const PROGRESS_HEADER = `
# ══════════════════════════════════════════════════════════════
# PROGRESS.yaml — 进度 · 唯一真相源（本文件由 acmer-coach 插件写入）
#
# 四级状态：
#   不写       = 未学      没碰过
#   studying   = 在学      开了头、还没达标。**跨天是常态**，不是异常
#   learned    = 学过      训练员自评「我学过」，没做检测
#   verified   = 已验证    过了章节检测，有证据
#
#   learned 和 verified **必须分开**（自评 ≠ 掌握）。合成一个「会/不会」
#   等于退回「从数据推断掌握度」—— 数据能说「花了很久」，说不出「卡在哪」。
#
#   「在学」和游标是两回事：游标是「今天聚焦哪个」，一天一个；
#   开过没学完的可以有**好几个**。
#
# 游标显式存，不靠「已验证的最大深度」推 —— 推出来的没法手改，
# 而且回头复习某节时游标得能停在那儿。游标只前进不倒退。
#
# pending 是**正押着的那张检测卷**：出卷到判卷之间可能跨会话，靠对话
# 上下文记不住，所以必须落盘。判完由 coach_grade 清掉。
# 节点下面还可能挂 checks —— 历次检测的结果、diagnoses —— 判因台账。
#
# pendingActions 是**押着的训练动作**（需求 #6）：coach_assign 布置的
#   那个「一个动作」落在这里，键 = 节点 id（一个节点同时只押一个，新布置覆盖旧的）。
#   值 = { at, deliverable, solveMinutes, tailMinutes, teachMinutes, totalMinutes, why }
#   两个出口：coach_log 在这个节点落地时自动销；不做了走 coach_unassign 撤。
#   **不自动过期** —— 跨天是常态（17:55 布置、21:35 才回来），按天过期会把真活当成没有。
#
# verified_problems 是**核实台账**：题号 → 那次核实的依据。
# 出卷时每道题都要"打开看过"才准进卷子（标签满足 ≠ 这题只考这个），
# 核实过一次的题进这里，同一道题第二次被挑中就不用重写依据。
#   键 = "平台|归一题号"（牛客 NC 前缀已剥）
#   值 = { at, gist, node, how, title? }
#        how='auto'   抓过题面页、页面标题和题库标题对得上（工具核过的）
#        how='manual' 站点抓不到 / 没起网络核对（**自报的**，可信度不一样，别混读）
#
# 本文件由 acmer-coach 插件写入，手改容易和游标/工具对不上。
# ══════════════════════════════════════════════════════════════
`

// 原子写：先写 .tmp 再 rename。半路崩了也不会把真相源撕成半个文件。
// ⚠️ 千万不要在解析失败时静默返回空进度再写回 —— 那是**拿空数据覆盖真相源**。
//    loadProgress 遇到非 ENOENT 的错一律抛，就是要让这种情况炸出来。
function saveProgress(p) {
  p.updated = localStamp(new Date()).slice(0, 10)
  // 显式列出要落盘的字段，而不是 `stringify(p)` 一把梭 ——
  // 一把梭会把 `pending: null` 这种空壳也写进文件，读起来像"押着一张空卷"。
  const out = { version: p.version, cursor: p.cursor, updated: p.updated, nodes: p.nodes }
  if (p.pending) out.pending = p.pending
  // 核实台账（需求 #1）：出卷时核实过的题号 → 依据。**必须在这个白名单里**，
  // 不然 coach_test 写进去了、saveProgress 一写文件就把它抹掉 ——
  // 症状是"台账看着生效了，重启后又全都要求重核"，而且不报错。
  if (p.verified_problems && Object.keys(p.verified_problems).length) {
    out.verified_problems = p.verified_problems
  }
  // 押着的训练动作（需求 #6）：同一个白名单，理由也一样 ——
  // 漏了的话 coach_assign 写进去、下一次 saveProgress（比如 coach_log 记一条）
  // 就把它抹掉，症状是"当场查得到、干点别的就没了"，而且不报错。
  if (p.pendingActions && Object.keys(p.pendingActions).length) {
    out.pendingActions = p.pendingActions
  }
  const tmp = `${PROGRESS_PATH()}.tmp`
  writeFileSync(tmp, PROGRESS_HEADER + stringify(out, { lineWidth: 0 }), 'utf8')
  renameSync(tmp, PROGRESS_PATH())
  return p
}

// ── SCHEDULE.yaml：时间容量 ───────────────────────────────────────
//
// 和 PROGRESS 一样：**只有一个写实现**。页面和工具都调这里，谁也别自己动。
//
// 结构（设计见 教练设计方针.md §4.1）：
//   days:
//     "2026-09-14":
//       busy:    [{ from: "09:00", to: "12:00", label: "上课" }]      ← 他手标的
//       planned: [{ from, to, node, blocks: [{ from, to, kind, label }] }] ← 教练排的
//       actual:  [{ node, plannedMin, actualMin, independent }]        ← 实际用时
//
// ⚠️ days 用**对象**不用数组（方针 §4.1.2 写的是数组）：日期是天然主键，
// 查一天就该是 days["2026-09-14"]，而不是遍历去找。数组还得自己维护顺序和去重。
//
// `actual` 是**校准真实做题速度**的唯一来源 —— 计划 60 分钟实际 95 分钟，
// 攒几周才知道他的速度到底是多少。这条现在一条数据都没有，所以排程只能保守。
const SCHEDULE_PATH = () => join(DATA_DIR, 'SCHEDULE.yaml')

function emptySchedule() {
  return { version: 1, updated: '', days: {} }
}

function loadSchedule() {
  let raw
  try {
    raw = readFileSync(SCHEDULE_PATH(), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return emptySchedule()
    throw err
  }
  const doc = parse(raw)
  return {
    version: doc?.version ?? 1,
    updated: String(doc?.updated ?? ''),
    // 防御：手改文件时可能写成数组或 null
    days: (doc?.days && typeof doc.days === 'object' && !Array.isArray(doc.days))
      ? doc.days : {},
  }
}

const SCHEDULE_HEADER = `
# ══════════════════════════════════════════════════════════════
# SCHEDULE.yaml — 时间容量 · 唯一真相源（本文件由 acmer-coach 插件写入）
#
# 滚动窗口：今天-3 ~ 今天-1 只读回顾，今天 ~ 今天+6 可排。
#
# 三级数据，写它们的人不同：
#   busy    训练员标的「这段时间有事」—— 任意区间，精确到分钟
#   planned 教练排的块。**排一次就固化**，再问直接读，不重排 ——
#           重排会让「计划」变成「每天都变的东西」，那样就没法拿它对照实际了
#   actual  实际用了多久。**这是校准真实速度的唯一来源**，
#           没有它，排程只能靠猜。
#
# 一个块 = 一道题的完整循环：
#   40min 自己做（限时，到点必须停 ← 止损点在这里）
#   10min 解决遗留
#   10min 重写
#
# 排多少由教练定，工具**不设容量上限** —— 只管物理上做不到的：
# 压着忙事、块叠块、出网格。排太满的后果让「计划 vs 实际」事后说话。
#
# 本文件由 acmer-coach 插件写入。
# ══════════════════════════════════════════════════════════════
`

function saveSchedule(s) {
  s.updated = localStamp(new Date()).slice(0, 10)
  const tmp = `${SCHEDULE_PATH()}.tmp`
  let body = stringify(
    { version: s.version, updated: s.updated, days: s.days }, { lineWidth: 0 })
  // 时间值**强制加引号**。
  //
  // 裸写的 `11:40` 在 YAML 1.1（PyYAML）里是**六十进制整数 700**，
  // 而 YAML 1.2（node/yaml —— 插件用的这套）读成字符串 "11:40"。
  // 同一份文件两套解析器得出不同结果，正是这个项目一直在治的"两处真相"。
  // （`08:00` 这种前导零的反而不匹配六十进制，两边都当字符串 ——
  //   所以真出问题时，一份文件里会是"有的字段 int、有的 str"这种更难查的分布。）
  //
  // 现在只有 node/yaml 读它所以没炸，但 `serve_map.py` 那条路随时可能接进来。
  // 加引号后两边都是字符串，歧义永久消除。
  // ⚠️ 两处都要引号，而且**不是一类问题**：
  //   时间值  `11:40`      → YAML 1.1 当六十进制整数 700
  //   日期     `2026-09-14` → YAML 1.1 当 **Date 对象**（`days["2026-09-14"]` 直接 KeyError）
  // 少了 `(?:- )?` 就只修得动 `to`（数组里的第一个字段 `from` 前面有 `- `，
  // 第一版漏了它，diff 里一眼能看出"怎么只给 to 加了引号"）。
  body = body.replace(/^(\s*(?:- )?(?:from|to):\s*)(\d{1,2}:\d{2})\s*$/gm, '$1"$2"')
  body = body.replace(/^(\s*(?:- )?(?:updated|date):\s*)(\d{4}-\d{2}-\d{2})\s*$/gm, '$1"$2"')
  // days 的 key 本身就是日期，也裸着 —— PyYAML 会读成 Date，按字符串索引就 KeyError
  body = body.replace(/^(\s*)(\d{4}-\d{2}-\d{2}):(\s*)$/gm, '$1"$2":')
  writeFileSync(tmp, SCHEDULE_HEADER + body, 'utf8')
  renameSync(tmp, SCHEDULE_PATH())
  return s
}

// 写某一天的某个字段。字段名**走白名单** —— 手滑传个 busy2 进来，
// 不拦的话会静默写进真相源，然后谁也说不清那个字段是什么。
const SCHEDULE_FIELDS = ['busy', 'planned', 'actual']

// **页面通道能写的字段**。planned 不在里面，而且是刻意的。
//
// 这个口子是后补的。在这之前 `/coach/api/schedule` 把 field 原样透给
// setScheduleField，白名单是全部三个 —— 也就是说「计划只能从工具进来」
// 这条规矩**只由客户端 JS 守着**。页面当时确实只发 busy，所以没坏；
// 但守门的站在客户端，等于没守：改一次页面、或者谁直接打这个接口，
// 「计划 vs 实际」那个对照就废了 —— 而它废掉的时候不会报错。
//
// 更要命的是测试文件自己就在用这条通道写 planned 并断言"写进去了"，
// 而旁边那节的注释写着"这扇门守得严不严"。三边说三套。
//
// 分工：busy / actual 是**他报的事实**，页面写没问题；planned 是**教学判断**，
// 只能从 coach_plan 进来（方针 §4.1「排一次就固化」全靠这条站着）。
const PAGE_FIELDS = ['busy', 'actual']

function setScheduleField(date, field, value) {
  const d = String(date ?? '').trim()
  const f = String(field ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, reject: `日期要 YYYY-MM-DD 格式，收到「${d}」` }
  }
  if (!SCHEDULE_FIELDS.includes(f)) {
    return { ok: false, reject: `字段只能是 ${SCHEDULE_FIELDS.join(' / ')}，收到「${f}」` }
  }
  if (!Array.isArray(value)) {
    return { ok: false, reject: `${f} 必须是数组` }
  }

  const s = loadSchedule()
  const day = { ...(s.days[d] ?? {}) }
  if (value.length) day[f] = value
  else delete day[f]            // 空数组 = 清掉这一项，不留 `busy: []` 这种空壳
  if (Object.keys(day).length) s.days[d] = day
  else delete s.days[d]         // 三项全空 = 这一天删掉，别留 `{}`
  saveSchedule(s)

  return {
    ok: true, reject: '', date: d, field: f,
    count: (s.days[d]?.[f] ?? []).length, updated: s.updated,
  }
}

// ── 排块：planned 只从工具进来 ─────────────────────────────────────
//
// 这条规矩是刻意立的。页面上只有标 busy 的入口（他标「我什么时候有事」），
// planned 一律走这里。**为什么不让页面排**：计划要是能随手改，
// 「计划 vs 实际」这个对照立刻失效 —— 人不会跟自己排错的计划较劲，他会改计划。
// 而排程本身是**教学判断**（先补哪个点、排多密、今天要不要减量），
// 那正是教练存在的理由，不该退回给训练员。
//
// 三种块（方针 §4.1.2）。**时长是常量，调用方不能传** ——
// 传了就会冒出「排个 37 分钟的循环块」，而 40/10/10 的止损点全靠这个时长守着。
const SCHED_KINDS = {
  cycle: { min: 60, name: '题目循环' },
  review: { min: 25, name: '复习一题' },
  exam: { min: 90, name: '章节检测' },
}

// 网格范围。⚠️ **必须和 skilltree_template.html 里的 HOUR_FROM / HOUR_TO 逐字一致**：
// 不一致的后果是「排了个 7:30 的块，页面根本画不出来」——
// 排了看不见比不排更糟，他会以为工具坏了。verify.mjs 有一条专门盯这个。
const SCHED_FROM_H = 8
const SCHED_TO_H = 24
const SCHED_SNAP_MIN = 5       // 页面拖拽按 5 分钟吸附，工具对齐同一个粒度
const SCHED_AHEAD = 6          // 今天 ~ 今天+6 可排（方针 §4.1）
const SCHED_BACK = 3           // 今天-3 ~ 今天-1 只读回顾
// 整个滚动窗口 = 回顾 3 天 + 今天 + 可排 6 天。
// 默认就把回顾期带上：教练排今天之前得先看前两天**实际做到了什么**，
// 只给"今天往后"等于让他闭着眼睛排。
const SCHED_WINDOW = SCHED_BACK + SCHED_AHEAD + 1
const SCHED_FILL = 0.75        // 容量 = 空闲 × 0.75

const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const ymdToday = () => ymd(new Date())
const addDays = (d, n) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + n)
  return x
}
/** "YYYY-MM-DD" → Date（本地零点）。不合法返回 null。 */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** "HH:MM" → 从 0:00 起的分钟数。不合法返回 null —— 别抛，调用方要一次报好几条。 */
function hmMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (mi > 59) return null
  // "24:00" 必须收 —— 它是**页面拖到最底下时会写出来的结束时间**。
  // 第一版这里写的是 `h < 24`，于是「23:00–24:00 有事」整段被静默丢掉，
  // 空闲里凭空多出一小时，教练正好会把块排进那段时间。
  // 页面认 24:00、host 不认 —— 静默的两处真相，正是这轮一直在治的病。
  // （作为**起点** 24:00 也会返回 1440，但那样算出的结束时间必然越过网格下沿，
  //   会被「超出网格范围」挡掉，不会漏进来。）
  if (h === 24) return mi === 0 ? 1440 : null
  return h < 24 ? h * 60 + mi : null
}
const minHM = (t) => `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`

/** 把一串占用区间合成 [8:00, 24:00) 里剩下的段，按时间排好序。 */
function slotsFrom(spans) {
  const lo = SCHED_FROM_H * 60, hi = SCHED_TO_H * 60
  const used = (Array.isArray(spans) ? spans : [])
    .map((b) => {
      const a = hmMin(b?.from), z = hmMin(b?.to)
      // 越界的占用按窗口夹住：7:00-9:00 的课，占的就是 8:00-9:00 这一段
      return a === null || z === null || z <= a ? null
        : { a: Math.max(a, lo), z: Math.min(z, hi) }
    })
    .filter((b) => b && b.z > b.a)
    .sort((x, y) => x.a - y.a)

  const out = []
  let cur = lo
  for (const b of used) {
    if (b.a > cur) out.push({ a: cur, z: b.a })
    // 两段占用重叠时取 max —— 直接赋值会把已经占掉的时段又吐回来当空闲
    cur = Math.max(cur, b.z)
  }
  if (cur < hi) out.push({ a: cur, z: hi })
  return out
}

/** 他**人不在**的时段（只减 busy）。排块校验用它 —— 重排时旧块会被扔掉。 */
const freeSlots = (day) => slotsFrom(day?.busy)

/**
 * 还能**排东西**的时段（busy 和已经排好的块一起减掉）。给教练看的是这个。
 *
 * 和 freeSlots 只在有 planned 时才分家。不分开的后果：
 * 教练看到"21:00–22:30 空着 90 分钟"，而那里已经排着一个块 ——
 * 他会以为还能再塞一个，或者把"90 分钟空档"当成真的空档去规划。
 */
const openSlots = (day) => slotsFrom([
  ...(Array.isArray(day?.busy) ? day.busy : []),
  ...(Array.isArray(day?.planned) ? day.planned : []),
])

const sumMin = (slots) => slots.reduce((t, x) => t + (x.z - x.a), 0)
const freeMinutes = (day) => sumMin(freeSlots(day))
const openMinutes = (day) => sumMin(openSlots(day))
const capacityMin = (day) => Math.floor(freeMinutes(day) * SCHED_FILL)

/**
 * 给一天排块。**整批要么全过要么全拒** —— 部分写进去等于留下半天的计划，
 * 那比没有计划更坏：他会照着做，而计划本身是残的。
 *
 * `opts.replace` 才允许覆盖已有的 planned。默认不覆盖，因为方针 §4.1 写死了
 * 「排一次就固化，再问直接读，不重排」—— 每次都重排，计划就成了「每天都会变的东西」，
 * 拿它对照实际就没有意义了。
 */
function planDay(date, blocks, opts = {}) {
  const d = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, reject: `日期要 YYYY-MM-DD，收到「${d}」。` }
  }
  const today = ymdToday()
  const lastDay = ymd(addDays(new Date(), SCHED_AHEAD))
  if (d < today) {
    return { ok: false, reject: `「${d}」已经过去了（今天是 ${today}）—— ` +
      `过去的日子只读，能排的是 ${today} ~ ${lastDay}。` }
  }
  if (d > lastDay) {
    return { ok: false, reject: `「${d}」太远了。窗口是 ${today} ~ ${lastDay}` +
      `（今天起 ${SCHED_AHEAD + 1} 天）—— 再远的日子他也不知道有没有事，排了也是假的。` }
  }

  const s = loadSchedule()
  const day = s.days?.[d] ?? {}
  const had = Array.isArray(day.planned) ? day.planned : []
  const list = Array.isArray(blocks) ? blocks : []
  // replace + 空数组 = 清掉这天的计划，所以要放在 had 那关之前判
  if (!list.length && !opts.replace) {
    return { ok: false, reject: 'blocks 是空的 —— 没东西可排。' }
  }
  if (had.length && !opts.replace) {
    return { ok: false, reject: `「${d}」已经排过了：\n` +
      had.map((b) => `  ${b.from}–${b.to}　${SCHED_KINDS[b.kind]?.name ?? b.kind}　${b.node}`).join('\n') +
      '\n\n计划**排一次就固化**：要改得明说重排（replace=true）。每次都重排的话，' +
      '计划就成了「每天都会变的东西」，拿它对照实际就没有意义了。' }
  }

  const { byId } = loadMap()
  const out = []
  const errs = []
  list.forEach((b, i) => {
    const no = `第 ${i + 1} 个块`
    const kind = String(b?.kind ?? '').trim()
    const spec = SCHED_KINDS[kind]
    if (!spec) {
      errs.push(`${no}：kind 只能是 ${Object.keys(SCHED_KINDS).join(' / ')}，收到「${kind}」。`)
      return
    }
    const a = hmMin(b?.from)
    if (a === null) { errs.push(`${no}：from 要 "HH:MM"（24 小时制），收到「${b?.from ?? ''}」。`); return }
    if (a % SCHED_SNAP_MIN) {
      errs.push(`${no}：起始时间要对齐 ${SCHED_SNAP_MIN} 分钟一格（页面拖拽就是这个粒度），` +
        `「${minHM(a)}」不是。`)
      return
    }
    const node = String(b?.node ?? '').trim()
    if (!byId.has(node)) {
      const near = suggest(node, [...byId.values()])
      errs.push(`${no}：地图里没有「${node}」这个知识点，别自己造。` +
        (near.length ? `相近的有：${near.join(' / ')}` : '先用 coach_next 看他该学什么。'))
      return
    }
    out.push({ a, z: a + spec.min, kind, node, no })
  })

  // 排到网格外面的块，页面画不出来
  const lo = SCHED_FROM_H * 60, hi = SCHED_TO_H * 60
  for (const b of out) {
    if (b.a < lo || b.z > hi) {
      errs.push(`${b.no}（${minHM(b.a)}–${minHM(b.z)}）超出网格范围 ` +
        `${minHM(lo)}–${minHM(hi)} —— 页面画不出来。`)
    }
  }

  // 和他的忙事撞车。这是**物理不可能**，不是「不建议」—— 那段时间他人在别处
  const busy = (Array.isArray(day.busy) ? day.busy : [])
    .map((x) => ({ ...x, a: hmMin(x.from), z: hmMin(x.to) }))
    .filter((x) => x.a !== null && x.z !== null && x.z > x.a)
  for (const b of out) {
    const hit = busy.find((x) => b.a < x.z && x.a < b.z)
    if (hit) {
      errs.push(`${b.no}（${minHM(b.a)}–${minHM(b.z)}）压着他标的「${hit.label || '有事'}」` +
        `（${hit.from}–${hit.to}）—— 那段时间他人在别处，排了也做不了。`)
    }
  }

  // 块之间自己撞
  const sorted = out.slice().sort((x, y) => x.a - y.a)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].a < sorted[i - 1].z) {
      errs.push(`${sorted[i].no} 和 ${sorted[i - 1].no} 叠在一起了：` +
        `${minHM(sorted[i].a)} 早于前一个块的结束 ${minHM(sorted[i - 1].z)}。`)
    }
  }

  // 分工：工具拦物理冲突（压着忙事、块叠块、出网格），排多排少归教练。
  // 排太满的后果由表里的「计划 vs 实际」事后说话，不由工具提前拦。
  const planMin = sorted.reduce((t, b) => t + (b.z - b.a), 0)

  if (errs.length) return { ok: false, reject: errs.join('\n') }

  const planned = sorted.map((b) => ({
    from: minHM(b.a), to: minHM(b.z), kind: b.kind, node: b.node,
  }))
  const w = setScheduleField(d, 'planned', planned)
  if (!w.ok) return w

  return {
    ok: true, reject: '', date: d, count: planned.length,
    planned: sorted.map((b) => ({
      from: minHM(b.a), to: minHM(b.z), minutes: b.z - b.a,
      kind: b.kind, kindName: SCHED_KINDS[b.kind].name,
      node: b.node, nodeName: byId.get(b.node)?.name ?? b.node,
      domain: byId.get(b.node)?.domain ?? '',
    })),
    // 只报「这天一共排了多少分钟」这个**事实**（他排完之后自己看表用）。
    planMin,
    replaced: had.length, updated: w.updated,
    // 带上他标的忙事 —— 排完要能回一条**完整的时间轴**给他。
    busy: (Array.isArray(day.busy) ? day.busy : []).map((b) => ({
      from: String(b?.from ?? ''), to: String(b?.to ?? ''), label: String(b?.label ?? ''),
    })),
  }
}

/**
 * 撤块。他说「这个时间不合理」时走这条。
 *
 * **只撤教练排的（planned）**，他自己标的 busy 动不了 —— 那是事实不是计划，
 * 撤事实等于篡改真相源。要改 busy 得他自己在页面上改。
 *
 * 为什么不复用 planDay 的 replace：那条路是**整天重排**，撤一次会把他
 * 没意见的块也一起换掉。而他要的是"把这一个拿走"。撤和排是两件事，
 * 混成一个参数，教练迟早会在该撤的时候重排。
 */
function unplanDay(date, opts = {}) {
  const d = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, reject: `日期要 YYYY-MM-DD，收到「${d}」。` }
  }
  const today = ymdToday()
  const lastDay = ymd(addDays(new Date(), SCHED_AHEAD))
  if (d < today) {
    return { ok: false, reject: `「${d}」已经过去了 —— 回顾期只读，撤不了。` }
  }
  if (d > lastDay) {
    return { ok: false, reject: `「${d}」在窗口外，能撤的是 ${today} ~ ${lastDay}。` }
  }

  const s = loadSchedule()
  const day = s.days?.[d] ?? {}
  const had = Array.isArray(day.planned) ? day.planned : []
  if (!had.length) {
    return { ok: false, reject: `「${d}」本来就没排过块，没什么可撤的。` }
  }

  const brief = (b) => `  ${b.from}–${b.to}　${SCHED_KINDS[b.kind]?.name ?? b.kind}　${b.node}`
  let removed, left

  if (opts.all === true) {
    removed = had
    left = []
  } else {
    const want = String(opts.from ?? '').trim()
    if (!want) {
      // 不给目标就拒绝，并**把候选列出来** —— 让他照着挑，
      // 而不是猜一个"大概是那个吧"然后撤错。
      return { ok: false, reject: `要撤哪个块？给我它的开始时间（from）：\n` +
        had.map(brief).join('\n') + '\n整天都撤就说 all=true。' }
    }
    const a = hmMin(want)
    const hit = had.filter((b) => a !== null && hmMin(b.from) === a)
    if (!hit.length) {
      return { ok: false, reject: `「${d}」没有 ${want} 开始的块。有的是：\n` +
        had.map(brief).join('\n') }
    }
    if (hit.length > 1) {
      return { ok: false, reject: `「${d}」有 ${hit.length} 个块都是 ${want} 开始的 —— ` +
        '排块时叠块会被拦，所以这是手改进 SCHEDULE.yaml 的，先去把文件理一下。' }
    }
    removed = hit
    left = had.filter((b) => b !== hit[0])
  }

  const w = setScheduleField(d, 'planned', left)
  if (!w.ok) return w

  const { byId } = loadMap()
  const nameOf = (b) => byId.get(String(b?.node ?? ''))?.name ?? String(b?.node ?? '')
  const pack = (b) => ({
    from: String(b?.from ?? ''), to: String(b?.to ?? ''),
    kind: String(b?.kind ?? ''), kindName: SCHED_KINDS[b?.kind]?.name ?? String(b?.kind ?? ''),
    node: String(b?.node ?? ''), nodeName: nameOf(b),
  })
  return {
    ok: true, reject: '', date: d,
    removed: removed.map(pack), removedCount: removed.length,
    left: left.map(pack), leftCount: left.length,
    updated: w.updated,
    // 「撤完还剩哪些块」报给他，外加整天的忙事 —— 这就是撤完的**整张表**。
    busy: (Array.isArray(day.busy) ? day.busy : []).map((b) => ({
      from: String(b?.from ?? ''), to: String(b?.to ?? ''), label: String(b?.label ?? ''),
    })),
  }
}

/**
 * 排程要看的全部事实：忙事、空闲段、容量、已经排好的块。
 * **只摆数，不给方案** —— 挑哪几天排、排什么，是教练的判断。
 */
// 「这个状态从什么时候开始的」。
//
// `at` 的正常来源是标记动作。但 coach_grade 曾经**不写它**，
// 所以真实数据里 `排序` 那种"已验证但没有日期"的记录是存在的 ——
// 那批补不回来，退到**最后一次判过的日期**：那是同一件事的另一份记录
// （checks 里 outcome=passed 的 date），比"不知道"强。
function statusSince(rec) {
  if (rec?.at) return String(rec.at)
  const checks = Array.isArray(rec?.checks) ? rec.checks : []
  for (let i = checks.length - 1; i >= 0; i--) {
    if (checks[i]?.outcome === 'passed' && checks[i]?.date) return String(checks[i].date)
  }
  return ''
}

// ── 火候：排课时摆出来的「哪些放得最久」──────────────────────────
//
// 教练**能**判断该不该复习/开卷，但前提是它主动去查那些数据 ——
// 不查就废。所以把火候摆进**排课这个动作的输出里**：他让它排课，它就一定看得见，
// 不依赖"它记得去看"。
//
// ⚠️ **只报事实，不报裁决，也不写阈值。**
// AGENTS.md 规则 7 明写那些天数是「数字，不是开关」—— 一旦把 7 天 / 30 天写进代码，
// 软信号就变成硬规则，正好背叛那条设计。所以这里**只按"放得最久的排前面"取前几个**：
// 排序是事实，阈值是判断。
function readinessOf(progress, byId, limit = 5) {
  const rows = []
  for (const [id, rec] of Object.entries(progress?.nodes ?? {})) {
    const st = rec?.status
    if (st !== 'studying' && st !== 'verified') continue
    const since = statusSince(rec)
    const passes = Array.isArray(rec?.passes) ? rec.passes : []
    rows.push({
      node: id,
      nodeName: byId.get(id)?.name ?? id,
      status: st,
      since,
      days: daysSinceDate(since) ?? -1,   // -1 = 没有日期（不是"0 天前"）
      passTotal: passes.length,
      passSolved: passes.filter((p) => p?.solved === true).length,
      // **独立做出**那一条腿才是证据 —— 看了题解才会的，做十次也不说明会
      passIndependent: passes.filter((p) => p?.solved === true && p?.independent === true).length,
    })
  }
  rows.sort((a, b) => b.days - a.days || a.node.localeCompare(b.node))
  return rows.slice(0, limit)
}

function scheduleOverview(days = SCHED_WINDOW, fromDate = '') {
  const start = parseYmd(fromDate) ?? addDays(new Date(), -SCHED_BACK)
  const n = Math.max(1, Math.min(14, Math.round(Number(days) || SCHED_WINDOW)))
  const s = loadSchedule()
  const today = ymdToday()
  const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const { byId } = loadMap()

  const out = []
  for (let i = 0; i < n; i++) {
    const dt = addDays(start, i)
    const key = ymd(dt)
    const day = s.days?.[key] ?? {}
    const planned = (Array.isArray(day.planned) ? day.planned : []).map((b) => {
      const a = hmMin(b?.from), z = hmMin(b?.to)
      return {
        from: String(b?.from ?? ''), to: String(b?.to ?? ''),
        minutes: a !== null && z !== null ? Math.max(0, z - a) : 0,
        kind: String(b?.kind ?? ''),
        kindName: SCHED_KINDS[b?.kind]?.name ?? String(b?.kind ?? ''),
        node: String(b?.node ?? ''),
        nodeName: byId.get(String(b?.node ?? ''))?.name ?? String(b?.node ?? ''),
      }
    })
    const planMin = planned.reduce((t, b) => t + b.minutes, 0)
    out.push({
      date: key, weekday: DOW[dt.getDay()],
      state: key < today ? 'past' : key === today ? 'today' : 'future',
      // 回顾期（今天之前）只读，排不了 —— 让教练一眼看出哪天能动手
      plannable: key >= today && key <= ymd(addDays(new Date(), SCHED_AHEAD)),
      busy: (Array.isArray(day.busy) ? day.busy : []).map((b) => ({
        from: String(b?.from ?? ''), to: String(b?.to ?? ''), label: String(b?.label ?? ''),
      })),
      planned, planMin,
      // ⚠️ **必须逐条归一，不能原样透传。**
      // `actual` 的形状后来变了（coach_log 加了 solved / note），
      // 而 output.schema 是 additionalProperties:false —— 原样透传的话，
      // 只要他记过一次 coach_log，**coach_schedule 整个工具就会因为
      // "返回里有 schema 没声明的键"而被 dsh 拒掉**。那不是某个字段错，
      // 是整个读日程的能力消失，而报错长这样：工具坏了。
      // 老记录（加字段之前写的）也要兜底 —— 缺键同样过不了校验。
      // 需求 #8：plannedMin **现算**，不读文件里那个快照 —— 有实例：
      // 09-21 的 ST 表那条存的是 120（记的时候那天确实有两个 60 分钟的块，
      // 后来计划被 replace 过一次），按现在的表算是 60。两个数都不算错，
      // 错的是它们被当成同一个数在用。真相源只有 `planned`。
      actual: (Array.isArray(day.actual) ? day.actual : []).map((a) => {
        const nodeId = String(a?.node ?? '')
        const e = {
          node: nodeId,
          plannedMin: planned
            .filter((b) => String(b.node) === nodeId)
            .reduce((t, b) => t + Number(b.minutes ?? 0), 0),
          actualMin: Number(a?.actualMin ?? 0),
          solved: a?.solved === true,
          independent: a?.independent === true,
        }
        if (a?.note) e.note = String(a.note)
        return e
      }),
    })
  }

  return {
    today,
    windowFrom: out[0]?.date ?? '', windowTo: out[out.length - 1]?.date ?? '',
    planTo: ymd(addDays(new Date(), SCHED_AHEAD)),
    blockKinds: Object.entries(SCHED_KINDS).map(([k, v]) => ({ kind: k, minutes: v.min, name: v.name })),
    days: out,
    // 火候：排课时一定看得见，不依赖"它记得去查 coach_status"
    readiness: readinessOf(loadProgress(), byId),
  }
}

// 游标解析：显式传参优先，否则读 PROGRESS.yaml。
// 游标落盘最实际的收益 —— 工具调用不必再到处传游标，改一处文件全局生效。
function resolveCursor(explicit) {
  const s = String(explicit ?? '').trim()
  return s || loadProgress().cursor
}

// 状态读取。**缺省即未学** —— 只有非未学的节点才会被写进文件。
function nodeStatus(progress, id) {
  const s = progress?.nodes?.[id]?.status
  return s === 'verified' || s === 'learned' || s === 'studying' ? s : 'none'
}

const STATUS_MARK = { none: '', studying: '  ▶在学', learned: '  ◦学过', verified: '  ✓已验证' }

// 检测结局的短标签（coach_status 的历史行用）。三种结局**不合并** ——
// 「分够但超时」是「不熟」的机械形态，跟"没过"是两种病（见 coach_grade）。
const OUTCOME_TAG = {
  passed: '过', overTime: '超时（算不熟）', failed: '没过',
  // 弃考：卷子开了但没做。**不是失败，也不是没发生** —— 它是一条独立的记录
  // （见 coach_cancel）。归到"没过"里去的话，「他最近三次都没过」和
  // 「他最近三次都没做」就读成同一句话了，而这是两种完全不同的信号。
  abandoned: '弃考（没做）',
}

// 距今几天。按**本地零点**对齐，不拿时间戳直接减 ——
// 直接减的话「昨天 23:00」和「今天 09:00」差 10 小时，取整成 0 天，显示"今天"，
// 可它明明是昨天标的。（技能树页面 `daysSince` 是同一套算法，两边要一致。）
function daysSinceDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  const n = new Date()
  return Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - d) / 86400000)
}

// ── 卡住 / 弃考：两种信号，别混─────────────────────────
//
// 「没过」说明练法对他无效；「没做」说明**卷子**有问题。混在一起报，
// 教练就会拿"他最近三次都没过"的口气说出一件"他三次都没做"的事
// —— 二分那个节点真踩过：2 次没过 + 2 次作废，而**最后一次是 4 分通过**。
//
// 三条判据（每条都对应一个踩过的坑）：
//   1. 只看 passed / failed，abandoned **不算一次测量**（它不是成绩）
//   2. **他后来过了就不算卡住**（只看"错过几次"会冤枉人）
//   3. 卡住 = 最近一次真做过的检测没过，且累计没过 ≥2
const STUCK_FAILS = 2
const STUCK_IDLE_DAYS = 14
const DROP_REASON_MAX = 60

function nodeFlags(progress, byId) {
  const stuck = []
  const cancelled = []
  for (const [id, rec] of Object.entries(progress?.nodes ?? {})) {
    const name = byId.get(id)?.name ?? id
    const checks = Array.isArray(rec?.checks) ? rec.checks : []
    const valid = checks
      .filter((c) => (c?.outcome === 'passed' || c?.outcome === 'failed') && c?.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const fails = valid.filter((c) => c.outcome === 'failed')
    const drops = checks.filter((c) => c?.outcome === 'abandoned')
    const last = valid[valid.length - 1]
    const idle = daysSinceDate(rec?.at)

    const why = []
    if (last?.outcome === 'failed' && fails.length >= STUCK_FAILS) {
      why.push(`最近一次检测没过（累计没过 ${fails.length} 次）`)
    }
    if (rec?.status === 'studying' && idle !== null && idle >= STUCK_IDLE_DAYS) {
      why.push(`在学放了 ${idle} 天还没验`)
    }
    if (why.length) stuck.push({ node: id, name, why: why.join('；') })

    // 作废多了是**组卷质量**的问题，不是人的问题（标签太泛？题已被他 AC？）
    if (drops.length >= STUCK_FAILS) {
      cancelled.push({
        node: id, name, drops: drops.length,
        reason: String(drops[drops.length - 1]?.reason ?? '').trim().slice(0, DROP_REASON_MAX),
      })
    }
  }
  return { stuck, cancelled }
}

// ── 「这个知识点他学过没有」—— 开卷的前提（需求 #5）────────
//
// 背景：coach_test 原来只挡「他 AC 过没有」，**不挡「这块他还没被讲过」**。
// 于是出现这条路：17:35 刚讲完「矩阵加速递推」→ 18:00 就能给它开卷 →
// 当场被指出「这个我还没学会」→ 撤卷。
// 这不是出题选错，是**没学的东西被开了卷**。
//
// 判据 = 进度文件里**有没有关于这个节点的记录**。缺省即未学（见 nodeStatus：
// 只有非未学的节点才会被写进文件），所以"记录存在"本身就说明有东西发生过：
//   · `rec.at`   —— 教练标过「在学」的那天（见 markStatus：只在状态真变时更新）
//   · `taught`   —— 布置过讲授段的那天（coach_assign 带 teachMinutes）
//   · `passes`   —— 他打过卡（coach_log）
//   · `checks`   —— 判过一次卷（coach_grade）
//
// 返回 null = **没有教学记录**；否则给一份能报出来的痕迹。
//
// ⚠️ **它只答"有没有被碰过"，答不了"够不够熟"。** 时间粒度是**天**
//    （rec.at / passes[].date 都只有 YYYY-MM-DD），所以"讲完 30 分钟就开卷"
//    这种**当天**的情形在这条闸下**照样通过**。要挡那个得另加冷却期，
//    那是另一条闸，得单独决定 —— 别偷偷塞进来。
function taughtEvidence(progress, id) {
  const rec = progress?.nodes?.[id]
  if (!rec) return null
  const dates = [
    String(rec.at ?? ''),
    // 讲授段的落点：在这之前，讲过的节点**不留任何痕迹** ——
    // coach_status 会一直报「还没有教学记录」，而"游标节点豁免先讲闸门"这条
    // 也就永远没法按"讲过没"来判断（这个漏洞就是从这儿反推出来的）。
    ...(Array.isArray(rec.taught) ? rec.taught.map((t) => String(t ?? '')) : []),
    ...(Array.isArray(rec.passes) ? rec.passes.map((p) => String(p?.date ?? '')) : []),
    ...(Array.isArray(rec.checks) ? rec.checks.map((c) => String(c?.date ?? '')) : []),
  ].filter(Boolean).sort()
  if (!dates.length && nodeStatus(progress, id) === 'none') return null
  return {
    status: nodeStatus(progress, id),
    first: dates[0] ?? '',          // 最早那条 = 「什么时候进的门」
    last: dates[dates.length - 1] ?? '',
    n: dates.length,
  }
}

// 前置闭包：seeds 加上它们的全部前置，递归。
// 「学过 动态规划基础」在逻辑上就意味着「递归 & 分治、枚举」也学过 ——
// 没学过前者推不出后者。所以游标要先展开成闭包，否则
// 区间 DP（只依赖 动态规划基础）会被误判成"缺前置"。
function prereqClosure(seeds, byId) {
  const out = new Set()
  const stack = [...seeds]
  while (stack.length) {
    const id = stack.pop()
    if (out.has(id)) continue
    out.add(id)
    for (const d of byId.get(id)?.depends ?? []) if (!out.has(d)) stack.push(d)
  }
  return out
}

// 「已学集合」—— 三个工具共用这一份，别再各算各的。
//
// 修过一处：原先 coach_next / coach_assign 只展开「游标自己」，
// 训练员显式标过的几十个节点全当没看见 —— 他明明标了「位运算」，
// 教练还说「数位 DP 缺前置 位运算」。三个工具里只有 coach_set_cursor 读了进度。
//
// 集合 = **种子（你现在站的地方）的前置闭包** ∪ **显式标为 学过/已验证 的节点**。
//
// 两条口径，都不是随手定的：
//
// 1. **「在学」不算。** 在学 = 开了头、还没达标。拿它当地基等于把「正在爬」
//    当成「已经站在上面」。他的真实数据里就躺着反例：概率论和概率 DP 都标着
//    「在学」—— 认了它，教练就会顺着「他会概率 DP」推出「他肯定也会概率论」，
//    可他这学期才开概率论。（在学不算已学）
//
// 2. **显式标记的节点不展开它的前置。** 同一个道理：他会概率 DP ≠ 他学过
//    概率论。闭包只对**种子**展开 —— 站在「动态规划基础」上，逻辑上就意味着
//    「递归 & 分治」「枚举」也学过，这个闭包成立；标记不是。
//
// 种子取谁：coach_next / coach_assign 取**当前游标**；coach_set_cursor 取
// **旧游标**（移走之前站的地方）。统一成一句话：**你站的位置 + 你声明会的**。
function assumedLearned(progress, byId, seeds = []) {
  const out = prereqClosure(seeds, byId)
  for (const id of Object.keys(progress?.nodes ?? {})) {
    const s = nodeStatus(progress, id)
    // 只有 learned / verified 算。「在学」和「未学」一样，什么都不算。
    if (s === 'learned' || s === 'verified') out.add(id)
  }
  return out
}

// 游标打错字时给几个近似 —— 让 LLM 有回头路，而不是收到一个空列表就瞎猜。
//
// ⚠️ **短输入必须直接返回空**。匹配规则是「互相包含」，
// 而空串被任何字符串包含 —— `setStatus('')` 于是命中**全部**节点，
// 再 `slice(0,5)` 就变成"地图顺序前五个"。它长得像"相近的推荐"，
// 实际是随机的：实测空串会报出「RMQ / 并查集应用 / 括号序列…」，
// 打一个 `a` 会报出「Stoer–Wagner / Manacher / Dancing Links」。
// 这条消息是专门给 LLM 铺回头路的，递假线索比不给更坏 ——
// 它可能真的顺着那个假的"相近"去改游标。
// 两个字符是下限：地图里有「二分」「贪心」这种双字节点。
function suggest(cursor, nodes) {
  const c = String(cursor ?? '').trim()
  if (c.length < 2) return []
  return nodes
    .map((n) => n.id)
    .filter((id) => id.includes(c) || c.includes(id))
    .slice(0, 5)
}

// ══════════════════════════════════════════════════════════════════
// 判因的零件
// ══════════════════════════════════════════════════════════════════

// 判因分类 → 下一步去向。**映射写死在这，不让模型填。**
// 理由是逻辑必然，不是我的偏好：
//   「不会」→ 缺的是机制，光重做一遍还是不会，得回去补那个知识点；
//   「不熟」→ 会，只是慢，那就换个题限时加练（重做原题没用，你已经知道怎么做了）；
//   「不认真」→ 方法没问题，是手上毛躁，重写一遍并强制跑边界。
// 让模型自由填这个字段，它一定会把「不认真」配上「补课」这类拧巴的组合。
//
// 单位跟着 #7 一起统一：这里给的是**他自己动手的净时间**（不是整块长度）。
// backfill / drill 就是一个标准循环（净 40 → 整块 60，跟以前一样）；
// redo 给下限净 30 —— 旧口径下它写的是"总 30"，拆开只有 10 分钟自己做，
// 而净 10 现在连下限都够不上（工具会拒），所以它必须抬到净 30 才自洽。
const MOVES = {
  '不会': { kind: 'backfill', label: '回头把这个知识点补上', minutes: NET_DEFAULT_MIN },
  '不熟': { kind: 'drill', label: '换个题、限时加练同一套路', minutes: NET_DEFAULT_MIN },
  '不认真': { kind: 'redo', label: '重写本题，写完先自己跑边界', minutes: NET_FLOOR_MIN },
}

// 引用的原文至少要有这么多个**有效字符**（去掉空白后）。
// 引一个变量名等于没指 —— 「cur 这里有问题」和「你 WA 了」是同一种废话。
const EVIDENCE_MIN_CHARS = 6

// 去掉全部空白再比对。从别处复制过来的引用常带着不同缩进，
// 因为空白差一点就判它"抄错"是误伤。判断"这段在不在代码里"只需比对有效字符。
const squash = (s) => String(s ?? '').replace(/\s+/g, '')

// 训练库：提交记录的**唯一**来源。只读打开，绝不写。
// COACH_DB 可覆盖 —— verify.mjs 靠它指向临时小库，真库一动不动。
const DB_PATH = () => process.env.COACH_DB || join(homedir(), '.dsh', 'data', 'training.db')
// 教练服务的账号。COACH_TRAINER 没给就取训练库里第一条用户
// —— 一个人一张库是常态，没有理由写死某个 handle。
const TRAINER = process.env.COACH_TRAINER || null

function emptyMech(problem, platform) {
  return {
    found: false, problem, platform, title: '', difficulty: 0, tags: [],
    attempts: 0, verdicts: '', lastWaToAcSec: -1, note: '',
  }
}

// 机械证据：提交序列、WA→AC 秒数、题目难度标签。
//
// **为什么必须工具自己查，不能靠模型回忆** ——
// 程序算机械的，LLM 做判断的。「他这题提交了几次、最后一次卡了多久」
// 是查一下就有的**事实**，让模型凭印象说就是让它编。
//
// 查不到一律降级（found:false + note 说明），绝不抛异常、绝不阻塞判因：
// 代码才是主证据，提交记录是佐证。库里没有这条题，照样该判得出来。
async function loadMech(problem, platform) {
  const base = emptyMech(problem, platform)
  if (!problem) return { ...base, note: '没给题号 —— 判因只凭代码' }

  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return { ...base, note: '这台机器没有 node:sqlite —— 判因只凭代码' }
  }

  let db
  try {
    db = new DatabaseSync(DB_PATH(), { readOnly: true })
  } catch (err) {
    return { ...base, note: `训练库打不开（${err.code || err.message}）—— 判因只凭代码` }
  }

  try {
    // 走 trainerId()，不自己再抄一遍 users 那条 SQL
    const uid = trainerId(db)
    if (uid == null) return { ...base, note: `训练库里找不到训练员账号（${TRAINER}）` }

    const subs = db.prepare(
      `SELECT verdict, submitted_at FROM unified_submissions
       WHERE user_id = ? AND platform = ? AND problem_id = ?
       ORDER BY submitted_at`).all(uid, platform, problem)
    if (!subs.length) return { ...base, note: `训练库里没有 ${problem} 的提交记录` }

    const prob = db.prepare(
      `SELECT title, difficulty, tags FROM unified_problems
       WHERE platform = ? AND problem_id = ? LIMIT 1`).get(platform, problem)

    // 「最后一次卡了多久才 AC」：从最后一个 AC 往回找最近的失败。
    // 这个数字是判因最有用的一条机械指纹 —— 23 秒修好和卡 20 分钟，
    // 是两种完全不同的病，而 verdict 列本身分不出来。
    let lastWaToAcSec = -1
    const acIdx = subs.map((s) => s.verdict).lastIndexOf('AC')
    if (acIdx > 0) {
      for (let i = acIdx - 1; i >= 0; i--) {
        if (subs[i].verdict !== 'AC') {
          const gap = (Date.parse(subs[acIdx].submitted_at) - Date.parse(subs[i].submitted_at)) / 1000
          if (Number.isFinite(gap) && gap >= 0) lastWaToAcSec = Math.round(gap)
          break
        }
      }
    }

    let note
    if (lastWaToAcSec < 0) note = `${subs.length} 次提交，还没 AC`
    else if (lastWaToAcSec <= 120) note = `最后卡了 ${lastWaToAcSec} 秒就过了 —— 秒级修好，是「不认真」的机械指纹`
    else if (lastWaToAcSec >= 900) note = `最后卡了 ${Math.round(lastWaToAcSec / 60)} 分钟才过 —— 更像思路不顺，而不是手滑`
    else note = `最后一次失败到 AC 隔了 ${Math.round(lastWaToAcSec / 60)} 分钟`

    return {
      found: true, problem, platform,
      title: String(prob?.title ?? ''), difficulty: Number(prob?.difficulty ?? 0),
      tags: String(prob?.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      attempts: subs.length,
      verdicts: subs.map((s) => s.verdict).join(' → '),
      lastWaToAcSec, note,
    }
  } catch (err) {
    return { ...base, note: `查库出错（${err.message}）—— 判因只凭代码` }
  } finally {
    try { db.close() } catch { /* 关不掉也不影响判因 */ }
  }
}

// ══════════════════════════════════════════════════════════════════
// 检测闭环的零件
// ══════════════════════════════════════════════════════════════════

// 难度权重 / 各档时限 / 通过线。**这几个数字是拍的，不是从数据推出来的。**
// 形状来自方针 §4.1 的「3 题限时 60min，独立完成 ≥2」，但把口径从
// "数题数"改成"按难度加权"：只拿下易题不算掌握 —— 那正好是"不熟"。
//
// 满分 6，通过线 4 = 必须拿下「中」或「难」其中之一。
//   易+中 = 3 不过 ／ 易+难 = 4 过 ／ 中+难 = 5 过 ／ 三题全下 = 6 过
const BAND_WEIGHT = { '易': 1, '中': 2, '难': 3 }
const BAND_MINUTES = { '易': 20, '中': 30, '难': 40 }
const PASS_SCORE = 4
const BANDS = ['易', '中', '难']
const POOL_PER_BAND = 8      // 每档给几道候选。给太多等于让 AI 重新面对茫茫题海

// 题号归一。**牛客有双命名空间**：题库里存 `NC234021` 和 `14834` 两种写法，
// 提交表里只有裸数字。不归一就排除不掉他做过的题 —— 那正好犯了
// AGENTS.md 那条「挑题前先查 AC 记录，不重复喂已经会的题」。
const normId = (platform, id) => {
  const s = String(id ?? '').trim()
  return platform === 'nowcoder' ? s.replace(/^NC/i, '') : s
}

// 训练库只读打开。所有查询走这一个口子，调用方自己 catch。
// 题面链接。**题库里的 url 不全** —— 42600 道里 12378 道是空的
// （牛客 `NC` 开头那批尤其多，实测里报出来的三道全是空串）。
// 而"打不开题目"等于这道题没法交，所以按平台**现推**一条；推不出来就返回空串
// —— 宁可空着，也别给一条 404 让他照着去交题。
//
// ponytail: 只支持能推的三家（牛客/洛谷/CF）。atcoder 要场次名、推不出来，
// 那种就靠题库里的 url；真要支持，在题库侧补字段比在这儿猜题号靠谱。
const problemUrl = (platform, id, url) => {
  const given = String(url ?? '').trim()
  if (/^https?:\/\//i.test(given)) return given
  const s = String(id ?? '').trim()
  if (!s) return ''
  if (platform === 'nowcoder') return `https://ac.nowcoder.com/acm/problem/${normId('nowcoder', s)}`
  if (platform === 'luogu') return `https://www.luogu.com.cn/problem/${s}`
  // CF 的题号是「场号 + 字母」（1548B）—— 拆得开才拼得出来
  const cf = platform === 'codeforces' ? /^(\d+)([A-Z]\d?)$/i.exec(s) : null
  return cf ? `https://codeforces.com/problemset/problem/${cf[1]}/${cf[2].toUpperCase()}` : ''
}

// 抓一次页面的 <title>，拿来和题库标题交叉核对（coach_verify 用）。
// **必须有超时** —— 站点卡住不能把工具一起卡死。
async function pageTitle(url, timeoutMs = 8000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; acmer-coach/1.0; +local)' },
    })
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` }
    const html = await r.text()
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    const title = m ? m[1].replace(/\s+/g, ' ').trim() : ''
    return title ? { ok: true, title } : { ok: false, why: '页面里没有 <title>' }
  } catch (e) {
    return {
      ok: false,
      why: e?.name === 'AbortError'
        ? `超时 ${timeoutMs}ms`
        : String(e?.cause?.code || e?.code || e?.message || '抓取失败'),
    }
  } finally {
    clearTimeout(timer)
  }
}

// 标题对不对得上。**宽松匹配**：站点会在标题后面缀自己的名字
// （洛谷「P2880 … - 洛谷」、牛客「递推_牛客题霸_牛客网」），逐字相等永远为假。
// 只要一边包含另一边就算对上。**太短的（<2 字）返回 null = 判不了** ——
// 「T1」这种匹配上说明不了什么，把判不了说成对得上就是在替调用方背书。
const normTitle = (s) => String(s ?? '').toLowerCase().replace(/[\s　]+/g, '')
const titleMatches = (bankTitle, pageTitle) => {
  const a = normTitle(bankTitle)
  const b = normTitle(pageTitle)
  if (a.length < 2 || b.length < 2) return null
  return a.includes(b) || b.includes(a)
}

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(DB_PATH(), { readOnly: true })
}

function trainerId(db) {
  const u = TRAINER
    ? db.prepare('SELECT id FROM users WHERE cf_handle = ? OR handle = ? LIMIT 1').get(TRAINER, TRAINER)
    : db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()
  return u?.id ?? null
}

// 节点名 → 题库标签。**两级匹配，且如实报告用了哪一级。**
//
// 为什么非要有这一层：地图是细粒度中文（区间 DP / 插头 DP），
// 题库标签是另一套词汇，两边不是一对一的。硬做映射表会变成第二份真相；
// 直接按名字找又会有歧义。所以：先找**逐字相同**的标签，
// 找不到才退到"标签包含节点名"，并且把用了哪级明说 ——
// 退级时池子会明显变胖，教练和训练员有权知道这卷子考的还是不是他以为的那个点。
function matchTags(db, node) {
  const want = squash(node)
  const rows = db.prepare(
    `SELECT DISTINCT tags FROM unified_problems WHERE tags <> '' AND tags LIKE '%' || ? || '%'`)
    .all(node)
  const exact = new Set(), fuzzy = new Set()
  for (const r of rows) {
    for (const t of String(r.tags).split(',')) {
      const tag = t.trim()
      if (!tag) continue
      if (tag === node) exact.add(tag)
      else if (squash(tag).includes(want)) fuzzy.add(tag)
    }
  }
  if (exact.size) return { kind: 'exact', tags: [...exact] }
  if (fuzzy.size) return { kind: 'substring', tags: [...fuzzy] }
  return { kind: 'none', tags: [] }
}

// 难度 → CF rating。CF 自己的 difficulty 就是 rating，不进换算表。
function ratingFn(db) {
  const map = new Map(db.prepare('SELECT platform, diff, cf_rating FROM diff_rating_map').all()
    .map((r) => [`${r.platform}|${r.diff}`, r.cf_rating]))
  return (platform, difficulty) => {
    const d = Number(difficulty ?? 0)
    if (!d) return 0
    return platform === 'codeforces' ? d : (map.get(`${platform}|${d}`) ?? 0)
  }
}

// 他 AC 过的题（集合，键是 `平台|归一题号`）。挑题和判卷都靠它。
function acSet(db, uid) {
  return new Set(db.prepare(
    `SELECT platform, problem_id FROM unified_submissions
     WHERE user_id = ? AND verdict = 'AC'`).all(uid)
    .map((r) => `${r.platform}|${normId(r.platform, r.problem_id)}`))
}

// 按题号从题库取详情。**牛客的双命名空间在这里归一** ——
// AI 可能报裸号 `15121`，题库里存的是 `NC15121`，两边都得查得到，
// 否则一道真题会被判成"编的"。
function fetchProblem(db, platform, problemId, ac) {
  const bare = String(problemId ?? '').trim().replace(/^NC/i, '')
  if (!bare) return { found: false }
  const variants = platform === 'nowcoder' ? [bare, `NC${bare}`] : [String(problemId).trim()]
  const row = db.prepare(
    `SELECT problem_id, title, difficulty, url FROM unified_problems
     WHERE platform = ? AND problem_id IN (${variants.map(() => '?').join(',')})
     ORDER BY LENGTH(problem_id) DESC LIMIT 1`).get(platform, ...variants)
  if (!row) return { found: false }
  const canonicalId = String(row.problem_id)
  return {
    found: true, problemId: canonicalId,
    title: String(row.title ?? ''), difficulty: Number(row.difficulty ?? 0),
    url: problemUrl(platform, canonicalId, row.url),
    solved: ac.has(`${platform}|${normId(platform, canonicalId)}`),
  }
}

// 节点名 → 题池。**全项目唯一一份"节点 ↔ 题"的匹配实现。**
// coach_pool 和 build-node-meta（算入门段位那个脚本）都走它 ——
// 两份实现就会有两套匹配口径，那是这个项目反复在治的病。
//
// SQL 的 LIKE 只能粗筛（'%区间 DP%' 会捞到 '二维区间 DP'），
// 所以拿到行之后按**标签词**再精确复核一遍。宁可少，不可串味。
function nodePool(db, node) {
  const m = matchTags(db, node)
  if (m.kind === 'none') return { kind: 'none', tags: [], hits: [] }
  const like = m.tags.map(() => 'tags LIKE ?').join(' OR ')
  const rows = db.prepare(
    `SELECT platform, problem_id, title, difficulty, tags, url
     FROM unified_problems WHERE ${like}`).all(...m.tags.map((t) => `%${t}%`))
  const tagSet = new Set(m.tags)
  const hits = rows.filter((r) =>
    String(r.tags).split(',').map((s) => s.trim()).some((t) => tagSet.has(t)))
  return { kind: m.kind, tags: m.tags, hits }
}

// 「够得着」的缓冲。节点的入门段位比他当前 rating 高出超过这个数，就先别推。
//
// 这个数字是**拍的**，但它的存在不是：地图只说了「谁是谁的前置」——**允许**学什么。
// 1200 分的人学完 DFS，后继里有树链剖分、支配树、可持久化线段树，前置全满足，
// 一个都学不了。**允许 ≠ 合适。**
const REACH_BUFFER = 300

// tier 的排序权重：core 最先，skip 直接不推。
const TIER_RANK = { core: 0, normal: 1, rare: 2, skip: 3 }

// 「他现在的 CF rating」**唯一实现**，收一个已经打开的句柄。
//
// 收拢过一处：coach_pool 原先自己内联了一份同样的 SQL —— 同一时刻
// "他的 rating"就会有两个可能的值（一个查不到、一个查得到，或者反过来）。
// 拆成收 db 的形式，是因为调用方处境不同：currentRating 自己开库自己关，
// coach_pool 手里已经有一个开着的库。**共用一个实现，不共用连接。**
//
// 拿不到返回 0 —— 调用方据此**关掉**难度过滤，而不是当成"rating 0"去过滤
// （那会把所有节点都判成够不着，比不过滤还坏）。**但关掉必须说出来**，
// 见 coach_next 的 render。
function ratingOf(db, uid) {
  if (uid == null) return 0
  const rr = db.prepare(
    `SELECT rating FROM rating_history
     WHERE user_id = ? AND platform = 'codeforces'
     ORDER BY recorded_at DESC LIMIT 1`).get(uid)
  return Number(rr?.rating ?? 0)
}

async function currentRating() {
  try {
    const db = await openDb()
    try { return ratingOf(db, trainerId(db)) }
    finally { try { db.close() } catch { /* 关不掉不影响结果 */ } }
  } catch {
    return 0
  }
}

// 够不够得着。**没标 entry 的一律放行** —— 没有数据不等于"太难"，
// 把"不知道"当成"不行"会静默挡掉 239 个节点。
const reachableOf = (entry, rating) =>
  !entry || !rating || Number(entry) <= rating + REACH_BUFFER

const SKILLTREE_HTML = () => join(DATA_DIR, 'skilltree.html')

// ── /coach 路由：把技能树挂在 dsh 自己的 web 服务上 ──────────────────
//
// 这条通道是后加的。之前页面靠 Python 的 serve_map.py 单独占 8770 端口，三个代价：
//   · 它是**另一个要照看的进程** —— 重启电脑就没了（当天就发生过）
//   · 和 dsh 不同源，iframe 嵌进去要处理跨源
//   · 每次标记都要 shell 出去另起一个 node 进程跑 progress-cli
// 挂到 ctx.webServer 之后：dsh web 活着技能树就活着；同源；写操作直接调
// markStatus，连子进程都省了。
//
// 只注册**一条** prefix 路由吃下 /coach 整棵子树，内部再分发 ——
// webServer 对重复的 (kind, path) 是直接 throw，注册一次最省心。
//
// ⚠️ 页面里的 fetch 必须是**相对路径**（./api/progress）：
// 同一份 html 要能同时在 /coach/skilltree.html（dsh 挂法）和
// /skilltree.html（serve_map.py 挂法）下工作 —— 写成绝对路径 /api/progress
// 会打到 dsh 的 API 网关上去，那是别人的地盘。
//
// ⚠️ 走**可选注入**：没有 webServer 的环境（headless CLI）跳过这一块，
// 工具照样能用。所以顶上的 inject 数组里**不写** webServer。
function registerPages(ctx) {
  // ── 闸：优先用 dsh 自己的那套 ─────────────────────────────────────
  //
  // 后来改过。**dsh 0.1.5 给所有路由上了锁**（签名 cookie），而本插件
  // 口子还裸着 —— 只绑 127.0.0.1 时不算漏，但新版支持 LAN 访问，
  // 真开出去它就是**绕过鉴权的后门**。
  //
  // dsh 把两件事收在一个入口里（`connection` 服务的 `requestRejection`）：
  //   ① Host fence —— 挡 DNS rebinding
  //   ② 浏览器鉴权 —— 校验签名 cookie
  // 返回 403 / 401 / undefined（通过）。**直接用它，别自己再手写一套** ——
  // 手写的那套挡不住 DNS rebinding＋LAN 的组合，而且 dsh 改规则时它不会跟着变。
  //
  // 老版本（0.1.1 那会儿）没有这个服务，所以留了回退：只查 loopback。
  // 那个回退是**弱化版**，够用但不等于安全 —— 下面的注释里写明了。
  const isLocalAddr = (addr) => {
    const a = String(addr ?? '').replace(/^::ffff:/, '')
    return a === '127.0.0.1' || a === '::1' || /^127\./.test(a)
  }
  const isLocalHost = (host) => {
    const h = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    return h === '127.0.0.1' || h === '::1' || h === 'localhost' ||
      h === 'dsh.internal' || /^127\./.test(h)
  }
  const gate = (req) => {
    const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (conn && typeof conn.requestRejection === 'function') {
      return conn.requestRejection(req)
    }
    // 回退：老 dsh 或没装 connection 服务。只能保证「本机」，
    // 保证不了「登录过」—— 这个环境下本来也没有登录这回事。
    return (!isLocalAddr(req.socket?.remoteAddress) || !isLocalHost(req.headers?.host))
      ? 403 : undefined
  }

  const send = (res, code, type, body, extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    res.writeHead(code, {
      'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', ...extra,
    })
    res.end(buf)
  }
  const sendJson = (res, code, obj) =>
    send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj))

  const handler = async (req, res) => {
    const code = gate(req)
    if (code) {
      return send(res, code, 'text/plain; charset=utf-8', code === 401
        ? 'dsh web 要先登录：用它启动时终端打印的那行网址打开一次（那行带钥匙）'
        : 'forbidden：这个页面只对本机开放')
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname

    // 访问根路径不该给**目录列表** —— 那长得像文件系统不像技能树，
    // 还得手敲文件名。重定向过去，地址栏也跟着对。
    if (pathname === '/coach' || pathname === '/coach/') {
      res.writeHead(302, { location: '/coach/skilltree.html' })
      res.end()
      return
    }

    if (pathname === '/coach/skilltree.html') {
      let html
      try {
        html = readFileSync(SKILLTREE_HTML())
      } catch (err) {
        return send(res, 404, 'text/plain; charset=utf-8',
          `还没有 skilltree.html（${err?.code ?? err?.message}）—— 先跑 python render_skilltree.py`)
      }
      return send(res, 200, 'text/html; charset=utf-8', html)
    }

    if (pathname === '/coach/api/progress') {
      if (req.method === 'GET') {
        // 读失败**必须报错**，不能悄悄给个空进度 —— 那会让页面显示"什么都没标"，
        // 而真相是文件坏了。这个区分是特意留的。
        try {
          const p = loadProgress()
          return sendJson(res, 200, { ok: true, cursor: p.cursor, updated: p.updated, nodes: p.nodes })
        } catch (err) {
          return sendJson(res, 500, { ok: false, reject: String(err?.message ?? err) })
        }
      }
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 1_000_000) { req.destroy(); return }
        }
        let payload
        try { payload = JSON.parse(body || '{}') }
        catch { return sendJson(res, 400, { ok: false, reject: '请求体不是 JSON' }) }

        const op = String(payload?.op ?? '')
        const r = op === 'mark' ? markStatus(payload?.node, payload?.status)
          : op === 'cursor' ? moveCursor(payload?.node)
            : { ok: false, reject: `未知 op「${op}」，只有 mark / cursor` }
        return sendJson(res, r.ok ? 200 : 400, r)
      }
      return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    }

    if (pathname === '/coach/api/schedule') {
      if (req.method === 'GET') {
        try {
          const s = loadSchedule()
          return sendJson(res, 200, { ok: true, updated: s.updated, days: s.days })
        } catch (err) {
          return sendJson(res, 500, { ok: false, reject: String(err?.message ?? err) })
        }
      }
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 1_000_000) { req.destroy(); return }
        }
        let payload
        try { payload = JSON.parse(body || '{}') }
        catch { return sendJson(res, 400, { ok: false, reject: '请求体不是 JSON' }) }

        // 一次写一天的一项。页面把整天算好了发过来，
        // 这里不做增量合并 —— 合并逻辑放两处就是两份真相。
        //
        // ⚠️ **字段要分权**（见 PAGE_FIELDS）：这个口子是他报事实用的，
        // 不是排计划用的。计划只有 coach_plan 一个入口。
        const field = String(payload?.field ?? '').trim()
        if (!PAGE_FIELDS.includes(field)) {
          return sendJson(res, 403, {
            ok: false, reject:
              `页面通道只能写 ${PAGE_FIELDS.join(' / ')}，收到「${field}」。` +
              (field === 'planned'
                ? '计划只能从 coach_plan 进来 —— 计划要是能随手改，' +
                  '「计划 vs 实际」这个对照立刻失效：人不会跟自己排错的计划较劲，他会改计划。'
                : ''),
          })
        }
        const r = setScheduleField(payload?.date, field, payload?.value)
        return sendJson(res, r.ok ? 200 : 400, r)
      }
      return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    }

    return send(res, 404, 'text/plain; charset=utf-8', 'not found')
  }

  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/coach', handler }))
}

// ── 强制力：把「他现在站在哪」注入每个 turn ──────────────────────────
//
// 方针 §五 第四层 —— 写在文档里的规则是**建议**，写在钩子里的才是**法律**。
// 这是那一层。（前十五个工具是"能调"，这个是"不用调就知道"。）
//
// 注入的是**位置**，不是规则清单：游标 / 在学 / 押着的卷。
// 为什么偏偏是位置 —— 教练的价值命题就是那句「教练的价值不是知识，是位置」，
// 而位置恰好是最容易丢的东西：新开一个会话、或者聊长了，
// 小鲸手上就只剩一个人格空壳，得先问一句「你现在在学什么」才知道。
//
// ⚠️ **注入走消息流末尾，绝不碰 system prompt 前缀**。
// DeepSeek 的 prompt cache 是前缀命中：system prompt 每轮变动会让后面
// 所有 token 全部 cache miss，费用暴涨。whale-hindsight 里记着同一条。
//
// ⚠️ **整个过程包在 try/catch 里，任何一步出问题就原样放过**。
// 钩子挂在每个 turn 的第一步上：它抛错 = 每一轮对话都炸。
// 注入失败只是"小鲸少知道一点"，和"对话打不开"根本不是一个量级。
//
// 为什么**不做** compaction/prune（路线图 #2 的另一半）：
// 它要防的是"规则被长对话压掉"，而规则在 AGENTS.md 里 —— 那是 system prompt，
// 压根不参与压缩。真正会丢的是**位置**，而 pre-step 每轮都重注一遍，
// 压掉的下一轮就回来了。所以那半条是多余的。
function registerStateHook(ctx) {
  ctx.on('agent/pre-step', async ({ messages, step }, next) => {
    const decision = await next()
    try {
      // 只在每个 turn 的**第一步**注入一次。每步都塞的话，
      // 一次工具调用的往返就多一份一模一样的状态。
      if (step !== 1 || decision.kind !== 'enter') return decision

      const p = loadProgress()
      const cursor = String(p.cursor ?? '')
      const pending = p.pending
      const studying = Object.entries(p.nodes ?? {})
        .filter(([, r]) => r?.status === 'studying')
        .map(([id]) => id)

      // 课程可以先于游标存在；即使尚未布置动作，也要在新会话继续同一路线。
      let hasCurriculum = false
      try { hasCurriculum = Boolean(curriculum.load()) } catch { hasCurriculum = true }
      let hasTarget = false
      try { hasTarget = Boolean(strategy.loadTarget().contest) } catch { hasTarget = true }
      if (!cursor && !pending && !studying.length && !hasCurriculum && !hasTarget) return decision

      const { byId } = loadMap()
      const nameOf = (id) => byId.get(String(id))?.name ?? String(id)
      const node = byId.get(cursor)
      const lines = ['<coach_state>', '（教练插件注入的位置，不用再调工具问）']
      lines.push(strategy.context())
      lines.push(curriculum.context())
      lines.push(cursor
        ? `- 游标：${nameOf(cursor)}（${cursor}）${node?.domain ? `　[${node.domain}]` : ''}`
        : '- 游标：**还没设** —— 先问清他现在在哪个知识点，用 coach_set_cursor 设上')
      if (studying.length) {
        lines.push(`- 在学（开了头、没达标）：${studying.map(nameOf).join('、')}`)
      }
      if (pending) {
        const n = Array.isArray(pending.problems) ? pending.problems.length : 0
        lines.push(`- ⚠️ 押着一张卷：${nameOf(pending.node)}（${pending.date} 开，${n} 道）` +
          ' → 他做完走 coach_grade；他不做了走 coach_cancel。**别编成绩。**')
      }
      lines.push('</coach_state>')

      // 动态 import，不走顶上的静态依赖 —— 和这个文件里 `node:sqlite` 一个套路：
      // 包挪了位置 / 换了版本，注入就静默跳过，工具和对话照常用。
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
      const msg = createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: `plugin:${name}` },
      })
      return { ...decision, messages: [...decision.messages, msg] }
    } catch {
      return decision   // 注入失败绝不能影响对话本身
    }
  })
}

// ── OI Wiki 本地知识库 ────────────────────────────────────────────
//
// 讲任何知识点之前**先查这里**，别凭记忆讲。这是纪律不是洁癖：
// 记忆里的算法细节会漂（复杂度的常数、边界、退化情况），而喂错一个知识点，
// 对方要花很久才能发现。
//
// 三条路径，按精度递减：
//   ① node   地图节点 → 页面。**精确表**，不是搜出来的 ——
//            地图节点的名字就是从 OI Wiki 导航标题来的，所以这张表是查的，不是猜的。
//   ② search 自由文本。先撞节点名，再线性扫 chunk 正文。
//   ③ page   拿 ① 或 ② 给的路径读全文。
//
// 不起倒排索引：全文才 3MB / 2177 块，线性扫几毫秒就够了。
// 等它真的慢了再说（YC：先让它跑，别先让它快）。
const WIKI_DIR = process.env.COACH_WIKI_DIR
  || join(import.meta.dirname, 'assets', 'oiwiki')

// 教练规则文件。它进 **system prompt**，不是消息流 —— 见 apply() 里的注入。
const RULES_DIR = process.env.COACH_RULES_DIR
  || join(import.meta.dirname, 'assets', 'rules')

let _wiki = null
function loadWiki() {
  if (_wiki) return _wiki
  const chunks = [], bySrc = new Map()
  let pages = {}
  try {
    for (const line of readFileSync(join(WIKI_DIR, 'chunks.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const c = JSON.parse(line)
      chunks.push(c)
      if (!bySrc.has(c.src)) bySrc.set(c.src, [])
      bySrc.get(c.src).push(c)
    }
    pages = JSON.parse(readFileSync(join(WIKI_DIR, 'node-pages.json'), 'utf8'))
    for (const [src, list] of bySrc) {
      list.sort((a, b) => a.i - b.i)          // 块序 = 原文顺序，page 要按它拼
    }
  } catch { /* 没装知识库就退化成空，工具会如实说 */ }
  _wiki = { chunks, bySrc, pages, nodeNames: Object.keys(pages) }
  return _wiki
}

/** 从 chunk 正文里抠出标题：第一个 markdown 标题；没有就用文件名。 */
function wikiTitle(src, text) {
  const h = /^#{1,3}\s+(.+)$/m.exec(text ?? '')
  return h ? h[1].trim() : src.replace(/\.md$/, '')
}

/** 查询切词。分两档 —— 这一分层是**查不到时不许硬凑**的关键。
 *
 *   strong：整串 + 空白/标点分开的词。**必须命中其中一个**，否则这条不算数。
 *   weak  ：中文二元组。**只参与打分，不参与召回**。
 *
 * 为什么二元组不能当召回：中文没分词器，二元组是常用的兜底，但它太松 ——
 * 「不存在的知识点」能切出「知识」「存在」，而 OI Wiki 里这两个词满地都是，
 * 于是随便输点什么都能返回 5 条**看着像结果**的东西。
 * 那比返回空更坏：空结果会让人去换个词，假结果会让人直接开讲。
 */
function wikiTerms(q) {
  const s = String(q ?? '').trim()
  if (!s) return { strong: [], weak: [] }
  const strong = new Set([s])
  for (const w of s.split(/[\s,，、/]+/)) if (w.length > 1) strong.add(w)
  const weak = new Set()
  const han = s.replace(/[^一-龥]/g, '')
  for (let i = 0; i + 2 <= han.length; i++) weak.add(han.slice(i, i + 2))
  for (const t of strong) weak.delete(t)
  return { strong: [...strong], weak: [...weak] }
}

function wikiScore(chunk, terms) {
  let s = 0
  for (const t of terms.strong) {
    if (chunk.src.includes(t)) s += 160
    const n = chunk.text.split(t).length - 1
    if (n) s += Math.min(n, 4) * 40
  }
  for (const t of terms.weak) {
    if (chunk.src.includes(t)) s += 8
    const n = chunk.text.split(t).length - 1
    if (n) s += Math.min(n, 4) * 1
  }
  return s
}

/** strong 里一个都没命中 → 这条不算数。见 wikiTerms 的注释。 */
function wikiMatches(chunk, terms) {
  return terms.strong.some((t) => chunk.src.includes(t) || chunk.text.includes(t))
}

function wikiSearch(query, topK) {
  const { chunks, nodeNames, pages } = loadWiki()
  const q = String(query ?? '').trim()
  if (!q) return { results: [], note: '查询是空的' }

  // ① 先撞节点名 —— 命中就是精确表，顺带把"这是哪个知识点"说清楚
  // ⚠️ 必须**精确优先、短的优先**。不排的话「线段树」会先撞上「线段树与离线询问」
  //    （filter 保留原顺序，而那个名字在 JSON 里排前面），「复杂度」会撞上
  //    「并查集复杂度」—— 名词越短的越一般，越该先给。
  const hitNodes = nodeNames
    .filter((n) => n === q || n.includes(q) || q.includes(n))
    .sort((a, b) => {
      if ((a === q) !== (b === q)) return a === q ? -1 : 1
      return a.length - b.length
    })
  const nodeHits = []
  for (const n of hitNodes.slice(0, 4)) {
    for (const src of pages[n] ?? []) {
      if (!nodeHits.some((h) => h.src === src)) nodeHits.push({ src, node: n })
    }
  }

  // ② 再扫正文。**strong 必须先命中一个** —— 二元组只排不分（见 wikiTerms）
  const terms = wikiTerms(q)
  const scored = chunks
    .filter((c) => wikiMatches(c, terms))
    .map((c) => ({ c, s: wikiScore(c, terms) }))
    .sort((a, b) => b.s - a.s)

  const out = [], seen = new Set()
  for (const h of nodeHits) {
    if (seen.has(h.src)) continue
    seen.add(h.src)
    const cs = chunks.filter((c) => c.src === h.src)
    out.push({ src: h.src, title: wikiTitle(h.src, cs[0]?.text), via: `节点「${h.node}」`, excerpt: cs[0]?.text.slice(0, 700) ?? '' })
  }
  for (const { c } of scored) {
    if (out.length >= topK) break
    if (seen.has(c.src)) continue
    seen.add(c.src)
    // ⚠️ 别把内部打分带出去：schema 是 additionalProperties:false，
    //    多一个键 dsh 会**整个返回值判失败**（工具想说的话会被盖成"工具坏了"）。
    //    分数也不需要给模型看 —— 结果已经排好序了。
    out.push({ src: c.src, title: wikiTitle(c.src, c.text), via: '正文匹配', excerpt: c.text.slice(0, 700) })
  }
  return {
    results: out.slice(0, topK),
    note: out.length ? '' : `没找到和「${q}」相关的页面。照实说"这个我不确定"，别硬编。`,
  }
}

/** 读整页：同一 src 的块按序拼回去。 */
function wikiPage(src) {
  const { bySrc } = loadWiki()
  const list = bySrc.get(String(src ?? '').trim())
  if (!list) return { ok: false, text: '', note: '没有这个页面，路径要么写错了，要么是节点名 —— 先用 node/search 拿到路径。' }
  const text = list.map((c) => c.text).join('\n\n')
  return { ok: true, text: text.slice(0, 12000), truncated: text.length > 12000, chars: text.length }
}

function apply(ctx) {
  // ── 规则层：进 system prompt ──────────────────────────────────────
  //
  // 为什么走 `systemPrompt.section` 而不是把规则塞进消息流：
  // 规则是**行为约束**，每轮都得在场。消息流会被长对话把尾巴挤掉，
  // 而且那本来就不是它该待的层。人设走的就是这条路
  // （`deployment:persona-prefix` / `-suffix`），教练规则和人设同级。
  //
  // order 取 400：人设是 0、通用策略（PLAN_POLICY/TEAM_POLICY）是 500/600、
  // 工具段 1000+。教练规则是**领域策略**，排在人设之后、通用策略之前。
  //
  // ⚠️ 规则文本必须**静态**：这个 section 每轮都参与组装，
  //    现算内容会打穿 prompt cache（那正是现有代码刻意不碰 system prompt
  //    前缀的原因）。所以只在 apply 时读一次 —— 改了规则文件要重启 dsh。
  //
  // ⚠️ 拿不到 systemPrompt 服务（比如 headless）就**静默跳过**，别拦插件加载：
  //    工具能不能用和"规则进不进得去"是两件事。
  try {
    const sp = ctx.get?.('systemPrompt')
    if (sp && typeof sp.section === 'function') {
      sp.section({ name: 'coach:rules', order: 400, text: readFileSync(join(RULES_DIR, 'coach-rules.md'), 'utf8') })
    }
  } catch { /* 没这服务 / 没这文件 → 不注，照常加载 */ }

  ctx.tools.register(defineTool(curriculumTool(curriculum)))

  // ── 目标驱动策略层：比赛目标 / VP 证据 / 复盘 / 当前重点 ─────────
  // 课程图回答“有哪些知识点”，策略层回答“为什么现在学这个”。两者分开，
  // 避免把 rating 或游标误当成区域赛目标。
  const strategyText = (v) => [{ type: 'text', text: v.ok ? v.text : `❌ ${v.reject}` }]
  ctx.tools.register(defineTool({
    name: 'coach_target',
    description: '设置或读取比赛目标。目标先于知识点：contest/date/result/teamMode/weeklyHours/priorities 都确定后，教练才有依据选训练重点。',
    parameters: {
      action: { type: 'string', required: true, enum: ['read', 'set', 'clear'] },
      expectedRevision: { type: 'integer', description: 'read 返回的 revision；首次 set 用 0。' },
      contest: { type: 'string', description: '比赛名称，例如西安区域赛' },
      date: { type: 'string', description: '比赛日期 YYYY-MM-DD' },
      result: { type: 'string', description: '目标结果，例如区域赛金牌' },
      teamMode: { type: 'string', description: 'solo 或 team' },
      weeklyHours: { type: 'number', description: '每周可用训练小时' },
      constraints: { type: 'object', additionalProperties: true, description: '可选时间约束，例如 weekday/saturday/sunday' },
      priorities: { type: 'array', description: '能力优先级 [{id, weight, reason}]，weight 越大越优先', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, weight: { type: 'number', required: true }, reason: { type: 'string' },
      } } },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true }, reject: { type: 'string', required: true }, revision: { type: 'integer', required: true },
      contest: { type: 'string', required: true }, date: { type: 'string', required: true }, result: { type: 'string', required: true },
      teamMode: { type: 'string', required: true }, weeklyHours: { type: 'number', required: true }, priorities: { type: 'array', required: true },
      updated: { type: 'string', required: true }, version: { type: 'integer', required: true },
      constraints: { type: 'object', required: true, additionalProperties: true }, text: { type: 'string', required: true },
    } }, render: (_a, v) => strategyText(v) },
    execute: (args) => {
      const v = strategy.target(args?.action || 'read', args ?? {})
      return { ...v, text: v.ok
        ? `【比赛目标 · revision ${v.revision}】${v.contest} / ${v.date}\n目标：${v.result}\n模式：${v.teamMode}；每周 ${v.weeklyHours} 小时\n能力重点：${v.priorities.map((p) => `${p.id}(${p.weight})`).join('、')}`
        : '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_vp_import',
    description: '导入 VP 或模拟赛记录。它保存比赛过程证据，让教练根据读题、耗时、提交和题目选择复盘，不再只看 CF rating。重复 eventId 会更新，不会重复堆积。',
    parameters: {
      events: { type: 'array', required: true, items: { type: 'object', additionalProperties: true,
        description: '每场含 eventId/contest/date/problems；problem 含 problemId/status/readMinutes/solveMinutes/attempts/competencies' } },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true }, reject: { type: 'string', required: true }, imported: { type: 'integer', required: true },
      total: { type: 'integer', required: true }, revision: { type: 'integer', required: true }, text: { type: 'string', required: true },
      } }, render: (_a, v) => strategyText(v) },
    execute: (args) => {
      const v = strategy.vpImport(Array.isArray(args?.events) ? args.events : [])
      return { ok: v.ok, reject: v.reject, imported: v.imported, total: v.total, revision: v.revision,
        text: v.ok ? `✓ VP 记录已保存：本次 ${v.imported} 场，累计 ${v.total} 场，revision ${v.revision}` : '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_postmortem',
    description: '记录一场 VP 的赛后复盘。至少写能力问题、根因或下一步动作之一；复盘会影响 coach_focus 的优先级。',
    parameters: {
      eventId: { type: 'string', required: true }, competencies: { type: 'array', items: { type: 'string' } },
      missedReads: { type: 'array', items: { type: 'string' } }, decisionErrors: { type: 'array', items: { type: 'string' } },
      teamIssues: { type: 'array', items: { type: 'string' } }, rootCauses: { type: 'array', items: { type: 'string' } },
      nextActions: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, date: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true }, reject: { type: 'string', required: true }, eventId: { type: 'string', required: true },
      revision: { type: 'integer', required: true }, postmortems: { type: 'array', required: true }, text: { type: 'string', required: true },
    } }, render: (_a, v) => strategyText(v) },
    execute: (args) => {
      const v = strategy.postmortem(args ?? {})
      return { ...v, text: v.ok ? `✓ 已记录 ${v.eventId} 的复盘；当前共 ${v.postmortems.length} 条复盘，revision ${v.revision}` : '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_focus',
    description: '根据比赛目标权重和 VP 复盘证据生成当前训练重点。它输出能力、比赛价值、为什么现在学、关联知识点和暂缓项；没有目标时拒绝猜方向。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true }, reject: { type: 'string', required: true }, contest: { type: 'string', required: true },
      deadline: { type: 'string', required: true }, focus: { type: 'array', required: true }, postponed: { type: 'array', required: true },
      evidenceEvents: { type: 'integer', required: true }, postmortems: { type: 'integer', required: true }, text: { type: 'string', required: true },
    } }, render: (_a, v) => strategyText(v) },
    execute: () => {
      const v = strategy.focus()
      return { ...v, text: v.ok ? [`【当前训练重点】${v.contest} · 截止 ${v.deadline}`,
        ...v.focus.map((f, i) => `${i + 1}. ${f.title}（${f.id}）\n   比赛价值：${f.contestUse}\n   为什么现在：${f.whyNow}\n   关联知识点：${f.nodes.join('、') || '需先定义'}\n   证据次数：${f.evidenceCount}`),
        v.postponed.length ? `暂缓：${v.postponed.join('、')}` : '没有暂缓项。',
      ].join('\n') : '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_scope',
    description: '查看一个比赛能力或知识点的适用范围、延伸、反例、常见错误、迁移题和退出条件。没有范围卡片时明确拒绝编造。',
    parameters: { id: { type: 'string', required: true, description: '能力 id 或地图节点 id' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean', required: true }, reject: { type: 'string', required: true }, found: { type: 'boolean', required: true },
      id: { type: 'string', required: true }, title: { type: 'string', required: true }, contestUse: { type: 'string', required: true },
      nodes: { type: 'array', required: true }, appliesTo: { type: 'array', required: true }, extensions: { type: 'array', required: true }, notFor: { type: 'array', required: true },
      commonFailures: { type: 'array', required: true }, transferProblems: { type: 'array', required: true }, exitEvidence: { type: 'array', required: true },
      text: { type: 'string', required: true },
    } }, render: (_a, v) => strategyText(v) },
    execute: (args) => {
      const v = strategy.scope(args?.id)
      return { ...v, text: v.ok ? [`【范围卡片】${v.title}（${v.id}）`, `比赛价值：${v.contestUse}`,
        `适用：${v.appliesTo.join('、')}`, `延伸：${v.extensions.join('、')}`, `不要用于：${v.notFor.join('、')}`,
        `常见错误：${v.commonFailures.join('、')}`, `迁移：${v.transferProblems.join('、')}`, `退出条件：${v.exitEvidence.join('、')}`,
      ].join('\n') : '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_setup',
    description:
      '教练环境的搭建与体检。三个动作：' +
      '`status`（体检：数据目录、地图、训练库、OI Wiki 各就位没有 —— ' +
      '**用户第一次用、或工具报"查不到数据"时先跑它**）；' +
      '`init`（建数据目录 + 铺地图 + 建训练库。幂等，不覆盖已有文件）；' +
      '`sync`（从 Codeforces 公开接口拉他的提交和题库 —— **不需要登录、不需要 key**，' +
      '但要先问他要 CF handle）。' +
      '⚠️ 同步只搬运**事实**（过了哪些题、什么难度），**不推断他会不会** —— ' +
      '那是检测的活。同步给的"接触证据"只用来缩小起点范围。',
    parameters: {
      action: {
        type: 'string', required: true, enum: ['status', 'init', 'sync'],
        description: 'status = 体检；init = 建目录建库；sync = 从 CF 拉数据',
      },
      handle: { type: 'string', description: 'action=sync 时必填：Codeforces handle' },
      problemset: { type: 'boolean', description: 'action=sync 时可选：是否连全题库一起拉（默认 true，出卷要靠它）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          note: { type: 'string', required: true },
          dataDir: { type: 'string', required: true },
          items: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          handle: { type: 'string', required: true },
          rating: { type: 'number', required: true },
          submissions: { type: 'number', required: true },
          problems: { type: 'number', required: true },
          library: { type: 'number', required: true },
          evidence: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                tag: { type: 'string', required: true },
                ac: { type: 'number', required: true },
                tried: { type: 'number', required: true },
                minRating: { type: 'number', required: true },
                maxRating: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        const head = v.action === 'sync'
          ? `已同步 ${v.handle || '(未指定)'}：提交 ${v.submissions} 条 / 题目 ${v.problems} 道 / 题库 ${v.library} 道`
          : '环境体检'
        const lines = [head, `数据根：${v.dataDir}`, '']
        lines.push(...v.items.map((i) => `  ${i.status === 'ok' ? 'OK  ' : '⚠ '} ${i.name}  ${i.detail}`))
        if (v.evidence.length) {
          lines.push('', '── 接触证据（**不是掌握度**，只用来缩小起点）──')
          lines.push(...v.evidence.slice(0, 12).map((e) =>
            `  ${e.tag}：AC ${e.ac} 题 / 提交过 ${e.tried} 次` +
            (e.maxRating ? `（难度 ${e.minRating}~${e.maxRating}）` : '')))
        }
        if (v.note) lines.push('', v.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const { DatabaseSync } = await import('node:sqlite')
      const dbPath = DB_PATH()
      const base = {
        ok: true, action: args.action, note: '', dataDir: DATA_DIR, items: [],
        handle: '', rating: 0, submissions: 0, problems: 0, library: 0, evidence: [],
      }
      const exists = (p) => { try { statSync(p); return true } catch { return false } }

      if (args.action === 'init') {
        // assetsDir 是**assets 目录本身** —— initDataDir 会在它下面找 knowledge/
        const made = initDataDir({ dataDir: DATA_DIR, dbPath, assetsDir: join(import.meta.dirname, 'assets'), DatabaseSync })
        // 顺手灌题池：没有它 `coach_pool` 挑不出「他没做过」的题。
        // 幂等，重复 init 不会翻倍。
        let pool = { imported: 0, note: '' }
        try {
          pool = importPool({ dbPath, poolPath: join(import.meta.dirname, 'assets', 'pool', 'problems.jsonl.gz'), DatabaseSync })
        } catch (e) { pool = { imported: 0, note: `题库灌库失败：${e.message}` } }

        base.note = `建了 ${made.knowledge.length} 个地图文件${made.db ? '，训练库是新建的' : '，训练库本来就在'}；` +
          `题库 ${pool.imported} 道${pool.note ? `（${pool.note}）` : ''}`
        base.items = [
          { name: '数据目录', status: 'ok', detail: DATA_DIR },
          { name: '地图', status: made.knowledge.length ? 'ok' : '已有', detail: made.knowledge.join(',') || '没动（已存在）' },
          { name: '训练库', status: 'ok', detail: dbPath },
          { name: '题库', status: pool.imported ? 'ok' : '缺', detail: pool.imported ? `${pool.imported} 道（CF/洛谷/牛客）` : pool.note },
        ]
        return base
      }

      if (args.action === 'sync') {
        const h = String(args.handle ?? '').trim()
        if (!h) {
          return { ...base, ok: false, note: '同步要先给 CF handle —— 问他一句「你的 Codeforces handle 是？」' }
        }
        try {
          const r = await syncCodeforces({
            dbPath, handle: h,
            problemset: args.problemset !== false,
            DatabaseSync,
          })
          const db = new DatabaseSync(dbPath, { readOnly: true })
          const ev = contactEvidence(db, r.user.id)
          db.close()
          return {
            ...base, handle: r.user.handle, rating: r.user.rating,
            submissions: r.submissions, problems: r.problems, library: r.library,
            evidence: ev.slice(0, 40),
            items: [
              { name: 'CF 账号', status: 'ok', detail: `${r.user.handle}  rating ${r.user.rating}` },
              { name: '提交记录', status: r.submissions ? 'ok' : '空', detail: `${r.submissions} 条` },
              { name: '题库', status: r.library ? 'ok' : '空', detail: `${r.library} 道` },
            ],
            note: '下一步：**别急着布置**。挑几个有接触证据的节点，先出一次卷确认位置 —— ' +
              '数据只说"他碰过"，说不出"他会"。（`coach_pool` → `coach_test` → `coach_grade`）',
          }
        } catch (e) {
          return { ...base, ok: false, handle: h, note: `同步失败：${e.message}。网络不通或 handle 拼错时都是这个错，别硬编一个结果。` }
        }
      }

      // status：只体检，不动任何东西
      const dbOk = exists(dbPath)
      let subs = 0, lib = 0, rating = 0
      if (dbOk) {
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true })
          subs = db.prepare('SELECT COUNT(*) c FROM unified_submissions').get().c
          lib = db.prepare('SELECT COUNT(*) c FROM unified_problems').get().c
          // ⚠️ 复用 ratingOf / trainerId，**别再抄一遍那条 SQL** ——
          // 同一个查询写两遍就是两份真相，而它们读的是"他的水平"这种要紧的东西。
          // （verify.mjs 有一关专门数这个；注意它数的是**原始字符串**，
          //   连注释里的也算 —— 所以这里连表名都别写出整句。）
          rating = ratingOf(db, trainerId(db))
          db.close()
        } catch { /* 库坏了：下面如实报 */ }
      }
      const wiki = loadWiki()
      base.rating = rating
      base.submissions = subs
      base.library = lib
      base.items = [
        { name: '数据目录', status: exists(DATA_DIR) ? 'ok' : '缺', detail: DATA_DIR },
        { name: '地图', status: exists(MAP_PATH()) ? 'ok' : '缺', detail: MAP_PATH() },
        { name: '训练库', status: dbOk ? (subs ? 'ok' : '空') : '缺', detail: dbOk ? `${subs} 条提交 / ${lib} 道题，rating ${rating}` : dbPath },
        { name: 'OI Wiki', status: wiki.chunks.length ? 'ok' : '缺', detail: `${wiki.chunks.length} 块` },
      ]
      base.ok = ['数据目录', '地图'].every((n) => base.items.find((i) => i.name === n)?.status === 'ok')
      base.note = !dbOk ? '还没有训练库 —— 跑 action=init 建一个，再 action=sync 拉数据。'
        : !subs ? '训练库是空的 —— 跑 action=sync（要先有 CF handle）。'
          : !wiki.chunks.length ? 'OI Wiki 知识库没装，讲知识点之前查不了 —— 别凭记忆讲。'
            : '都就位了。'
      return base
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_import',
    description:
      '导入提交记录。**洛谷和牛客的记录只能这么进来** —— 这两个平台没有公开的提交接口，' +
      '正路是浏览器扩展导出文件（见 assets/extension/）或者你自己写的脚本，' +
      '然后把这个文件交给它。CF 不用走这里（`coach_setup sync` 能直接拉）。' +
      '格式：JSON 数组或 JSONL，每条至少要有 `platform` / `problem_id` / `verdict`。' +
      '**按题去重**：同一道题的多次提交只留一条 —— 一份「全部提交记录」倒进来不会把 AC 集合淹掉。',
    parameters: {
      path: {
        type: 'string',
        description: '记录文件路径（.json 数组 或 .jsonl 每行一条）。与 records 二选一',
      },
      records: {
        type: 'array',
        description: '也可以直接给记录数组（几条的话）',
        items: {
          type: 'object', additionalProperties: true,
          properties: {
            platform: { type: 'string', description: 'codeforces / luogu / nowcoder' },
            problem_id: { type: 'string', description: '题号，如 P1001 / 1015D / NC12345' },
            verdict: { type: 'string', description: 'AC 或其它' },
            submitted_at: { type: 'string', description: 'ISO 时间，缺省用当前时间' },
          },
        },
      },
      platform: {
        type: 'string',
        description: '记录里没写 platform 时用这个补（比如整份文件都是洛谷的）',
      },
      handle: { type: 'string', description: '记到谁名下，缺省 trainer' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
          inserted: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          byPlatform: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                count: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: !v.ok ? `导入失败：${v.note}`
          : `导入 ${v.inserted} 条${v.skipped ? `（跳过 ${v.skipped} 条认不出的）` : ''}\n` +
            v.byPlatform.map((p) => `  ${p.platform}：${p.count} 条`).join('\n') +
            (v.note ? `\n${v.note}` : ''),
      }],
    },
    async execute(args) {
      const { DatabaseSync } = await import('node:sqlite')
      const out = { ok: false, note: '', inserted: 0, skipped: 0, byPlatform: [] }

      let records = Array.isArray(args.records) ? args.records : null
      if (!records && args.path) {
        try {
          const txt = readFileSync(String(args.path), 'utf8')
          const t = txt.trim()
          if (t.startsWith('[')) records = JSON.parse(t)
          else records = t.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        } catch (e) {
          return { ...out, note: `读不了这个文件：${e.message}（路径对不对？文件是 JSON 数组或 JSONL 吗？）` }
        }
      }
      if (!records) return { ...out, note: '没给记录 —— 要么给 path（文件），要么给 records（数组）' }

      // 整份文件同属一个平台时，用 platform 参数补上
      if (args.platform) {
        const p = String(args.platform).toLowerCase().trim()
        records = records.map((r) => (r && r.platform ? r : { ...r, platform: p }))
      }

      try {
        const r = importRecords({ dbPath: DB_PATH(), records, handle: args.handle, DatabaseSync })
        return {
          ok: r.inserted > 0 || r.skipped === 0,
          note: r.note ?? '',
          inserted: r.inserted,
          skipped: r.skipped,
          byPlatform: Object.entries(r.byPlatform ?? {}).map(([platform, count]) => ({ platform, count })),
        }
      } catch (e) {
        return { ...out, note: e.message }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_wiki',
    description:
      '查本地 OI Wiki 知识库 —— **讲任何知识点、算法、概念之前必须先查它**，不要凭记忆讲。' +
      '三个动作：' +
      '`node`（给地图节点 id，拿它的 OI Wiki 页面 —— 精确表，优先用它）；' +
      '`search`（自由文本，先撞节点名再扫正文）；' +
      '`page`（给路径读全文，路径来自前两个动作）。' +
      '查不到就照实说「这个我不确定」，**绝不硬编**。',
    parameters: {
      action: {
        type: 'string', required: true, enum: ['node', 'search', 'page'],
        description: 'node = 按知识点查；search = 按文本查；page = 读整页',
      },
      node: { type: 'string', description: 'action=node 时必填：地图节点 id' },
      query: { type: 'string', description: 'action=search 时必填：要查的内容' },
      src: { type: 'string', description: 'action=page 时必填：页面路径（如 ds/seg.md）' },
      topK: { type: 'number', description: 'action=search 时可选：最多返回几个页面，默认 5' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
          pages: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                src: { type: 'string', required: true },
                title: { type: 'string', required: true },
                via: { type: 'string', required: true },
                excerpt: { type: 'string', required: true },
              },
            },
          },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          available: { type: 'boolean', required: true },
        },
      },
      render: (_a, v) => {
        if (!v.available) {
          return [{ type: 'text', text: 'OI Wiki 知识库没装（缺 assets/oiwiki/）。照实说「我查不到，别当标准答案」。' }]
        }
        if (v.text) {
          return [{ type: 'text', text: `── ${v.note}${v.truncated ? '（已截断）' : ''}\n${v.text}` }]
        }
        if (!v.pages.length) {
          return [{ type: 'text', text: `查不到。${v.note}` }]
        }
        return [{
          type: 'text',
          text: v.pages.map((p) => `· ${p.title}\n  路径 ${p.src}（${p.via}）\n  ${p.excerpt.slice(0, 300)}…`).join('\n\n'),
        }]
      },
    },
    async execute(args) {
      const { chunks } = loadWiki()
      const available = chunks.length > 0
      const empty = { ok: false, note: '', pages: [], text: '', truncated: false, available }
      if (!available) return { ...empty, note: '知识库目录是空的' }

      if (args.action === 'page') {
        const r = wikiPage(args.src)
        return { ...empty, ok: r.ok, note: r.ok ? args.src : r.note, text: r.text, truncated: !!r.truncated }
      }

      const q = args.action === 'node' ? args.node : args.query
      if (!q) return { ...empty, note: `action=${args.action} 还差 ${args.action === 'node' ? 'node' : 'query'} 参数` }
      const { results, note } = wikiSearch(q, Math.min(Math.max(Number(args.topK) || 5, 1), 10))
      // 查到了就报查询词；**查不到必须把「照实说」那句带出去** ——
      // 早先这里写死 note=''，把 wikiSearch 给的提示吞了，等于白写。
      return { ...empty, ok: results.length > 0, pages: results, note: results.length ? `「${q}」` : note, available }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_ping',
    description:
      '教练插件存活探针。只在你需要确认「教练插件是否加载、数据目录是否可达」时调用；' +
      '平时回答训练问题**不要**调它。返回插件版本、当前施工阶段、数据目录，以及四个关键数据文件的存在状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          version: { type: 'string', required: true },
          dataDir: { type: 'string', required: true },
          dataDirReachable: { type: 'boolean', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                status: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          node: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: [
          `教练插件 ${v.name} v${v.version} — ${v.ok ? '活着' : '装上了但数据不通'}`,
          `数据根：${v.dataDir}${v.dataDirReachable ? '' : '（不可达）'}`,
          ...v.files.map((f) => `  ${f.status === 'ok' ? 'OK  ' : 'MISS'} ${f.file}  ${f.detail}`),
          `运行时：node ${v.node}`,
        ].join('\n'),
      }],
    },
    async execute() {
      const files = PROBE_FILES.map(probe)
      return {
        ok: files.every((f) => f.status === 'ok'),
        name,
        version: VERSION,
        dataDir: DATA_DIR,
        dataDirReachable: files.some((f) => f.status === 'ok'),
        files,
        node: process.version,
      }
    },
  }))

  // ── coach_next：给游标，出下一层候选 ──────────────────────────
  ctx.tools.register(defineTool({
    name: 'coach_next',
    description:
      '给一个**当前知识点**（游标），列出它的直接后继（技能树的下一层），并标出每个后继的前置满足情况。' +
      '用于回答「下一步学什么」「这个学完能开哪些」。' +
      '返回里 ready=true 的是现在就能开的；ready=false 的会给出 missing（还差哪些前置）。' +
      '注意：本工具只给候选集，**排序和挑哪一个是你的事** —— 程序不替你判断轻重缓急。' +
      '有长期课程时先看 coach_curriculum 当前主线；技能图用于核查前置，不要据此每轮换方向。',
    parameters: {
      cursor: {
        type: 'string',
        description: '当前知识点 id。**不填就用 PROGRESS.yaml 里的游标**（这是常态，别每次手传）。',
      },
      learned: {
        type: 'array',
        items: { type: 'string' },
        description:
          '额外认定已掌握的知识点 id（可选）。游标的前置闭包会**自动**算作已学，' +
          '这个参数用来补那些闭包覆盖不到、但你确定他已经会的点（如「位运算」）。',
      },
      limit: { type: 'number', description: '最多返回几个候选，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notFound: { type: 'boolean', required: true },
          suggestions: { type: 'array', required: true, items: { type: 'string' } },
          cursor: { type: 'string', required: true },
          cursorName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          assumedLearned: { type: 'array', required: true, items: { type: 'string' } },
          mapStamp: { type: 'string', required: true },
          readyCount: { type: 'integer', required: true },
          blockedCount: { type: 'integer', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                ready: { type: 'boolean', required: true },
                missing: { type: 'array', required: true, items: { type: 'string' } },
                unlocks: { type: 'integer', required: true },
                status: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                entry: { type: 'integer', required: true },
                // （需求 #4）：entry 有没有数据。没有的话 entry 是 0，
                // 而 0 和「真的算出来是 0」在渲染里长得一样 —— 必须分开。
                hasEntry: { type: 'boolean', required: true },
                reachable: { type: 'boolean', required: true },
                // 什么时候变成这个状态的（YYYY-MM-DD，没记过就是空串）。
                // 渲染时算成「N 天前」—— 数据在这儿，怎么用是小鲸的判断。
                at: { type: 'string', required: true },
              },
            },
          },
          fallbackUsed: { type: 'boolean', required: true },
          trainerRating: { type: 'integer', required: true },
          frontier: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                entry: { type: 'integer', required: true },
                hasEntry: { type: 'boolean', required: true },
                unlocks: { type: 'integer', required: true },
                status: { type: 'string', required: true },
                //兜底那半返回 at 但 schema 漏声明，而这里是
                // additionalProperties: false —— 于是整个工具**报错**而不是降级。
                // 214/349 个节点是末端，全都走这条路（小鲸的 schema 扫描抓到的）。
                at: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        if (v.notFound) {
          // 「游标没设」和「游标打错」是两回事，提示不该混
          if (!v.cursor) {
            return [{
              type: 'text',
              text: '还没设游标 —— PROGRESS.yaml 里的 cursor 是空的。\n' +
                '先问训练员现在在哪个知识点，再用 coach_set_cursor 设上。',
            }]
          }
          return [{
            type: 'text',
            text: `地图里没有「${v.cursor}」这个知识点。` +
              (v.suggestions.length ? `\n相近的有：${v.suggestions.join(' / ')}` : '\n也没找到相近的，确认一下写法。'),
          }]
        }
        const TIER_TAG = { core: '★核心', normal: '常见', rare: '少见', skip: '不考' }
        // （需求 #4）：**每个节点都要出 entry**。
        // 原来是 `c.entry ? ' ≈'+c.entry : ''` —— 于是「没数据」和「够不着」
        // 在输出里长得一模一样（都是不显示），很容易把"没数据"读成
        // "没问题、可以学"。而 reachableOf 对没 entry 的**一律放行**，
        // 意思是这些点上面永远不会出现 ⚠️够不着。
        const entryOf = (c) => (c.hasEntry ? `≈${c.entry}` : '**entry 无数据**')
        // 与他的 rating 差多少 —— AGENTS.md 那条「高出 300 以上不推」原来要靠心算，
        // 候选一多必漏。差值直接摆出来。
        const gapOf = (c) => {
          if (!v.trainerRating || !c.hasEntry) return ''
          const d = c.entry - v.trainerRating
          return `　差 ${d >= 0 ? '+' : ''}${d}`
        }
        const line = (c) => {
          const tail = c.ready
            ? (c.unlocks ? `解锁 ${c.unlocks} 个` : '末端')
            : `缺 ${c.missing.join('、')}`
          const hard = c.ready && !c.reachable ? '  ⚠️够不着' : ''
          // 状态后面缀上「多久没碰了」。**这不是排序，是事实** ——
          // 「接着昨天的 > 开新的」该由小鲸来判断（原则 2：判断归 LLM），
          // 但判断的前提是**看得见数据**。之前它只看得见「▶在学」，
          // 分不出那是昨天开的还是三周前开的。
          const ago = daysSinceDate(c.at)
          const statusMark = !STATUS_MARK[c.status]
            ? ''
            : `${STATUS_MARK[c.status]}` +
              (ago === null ? '' : ago <= 0 ? '（今天）' : `（${ago} 天前）`)
          return `  ${c.ready ? '可开' : '待补'}  ${c.id}  [${c.domain}]  ${tail}` +
            `  ${c.tier ? TIER_TAG[c.tier] ?? c.tier : ''}  ${entryOf(c)}${gapOf(c)}` +
            `${statusMark}${hard}`
        }
        const ready = v.candidates.filter((c) => c.ready)
        const blocked = v.candidates.filter((c) => !c.ready)
        const course = curriculum.execute({ action: 'read' })
        // 缺 entry 的候选：只要有一个，就必须说出来 + 给出下一步动作。
        // 不说的话「有的行有 ≈ 有的行没有」又变回静默差异 —— 这正是这条需求治的病。
        const noData = v.candidates.filter((c) => !c.hasEntry)
        const head = [
          `${v.cursorName}（${v.domain}）的直接后继 ${v.candidates.length} 个，` +
            `其中可开 ${v.readyCount}、待补 ${v.blockedCount}`,
          `假定已学（游标闭包 + 显式标记，${v.assumedLearned.length}）：${v.assumedLearned.join(' / ')}`,
          // rating 拿不到时**必须说出来**。原先这行是
          // `v.trainerRating ? ... : ''` —— 查不到就整行消失，读起来和
          // "这行本来就不该有"一模一样。而 rating=0 会**关掉整个难度护栏**
          // （reachableOf 对 rating 0 一律放行），于是训练库一挂、或者
          // 他还没打过 CF 没记录，教练就会拿着一张**标不出「够不着」**的
          // 候选表去挑 —— 1200 分的人面前摆着树链剖分，而表上看不出异常。
          // coach_pool 遇到同一情况会打一句「护栏没生效」，这边漏了。
          // 降级可以有，静默降级不行。
          v.trainerRating
            ? `他当前 rating ${v.trainerRating}（够不着 = 入门段位高出 ${REACH_BUFFER} 以上）`
            : '⚠️ **没查到他的 rating**（训练库打不开，或库里没有 CF 记录）—— ' +
              '这次的难度护栏**没生效**：够不着的候选不会被标出来，' +
              '挑的时候自己看一眼 entry 再决定。',
          // 缺 entry 的候选（需求 #4）：说清楚"没数据"≠"够得着"，并给出下一步。
          noData.length
            ? `⚠️ ${noData.length}/${v.candidates.length} 个候选**没有 entry 数据**` +
              '（地图里本来就没这一栏 —— entry 和 pool 是同一批算出来的，349 个点里 110 个有）。' +
              '**别把"没数据"读成"够得着"**：够不着的判据缺输入，这些点上面永远不会出现 ⚠️够不着。' +
              '要推之前先 coach_pool 看它有没有题，或者直接问训练员。'
            : '',
          '',
          ...(ready.length ? ['可开：', ...ready.map(line), ''] : []),
          ...(blocked.length ? ['待补前置：', ...blocked.map(line), ''] : []),
        ]
        // 兜底：直接后继全都用不上，往前沿退。
        // **必须明说是兜底** —— 否则 LLM 会以为"这是技能树的下一层"，
        // 把跨分支的候选讲成"你这节的下一步"。
        const foot = v.fallbackUsed
          ? [
            `⚠️ 这条线**走不下去了**：${v.candidates.length ? '后继要么缺前置、要么全都够不着' : '它是末端节点，没有下一层'}。`,
            '下面是**全图前沿**（前置已满足、够得着、去掉了标 skip 的），按权重排 ——',
            '这是**跨分支**的候选，讲的时候说清「这不是你这节的下一步，是另一条线」。',
            // 需求 #9：光说"这是跨分支"不够 —— 教练很自然会挑一个
            // 去布置，而 coach_assign 只认「游标的下一层」或游标自己，**当场被拒**。
            // 两个工具的口径对不上，不能靠"你自己意识到"：这里直接给可执行的动作。
            course.exists
              ? '有长期课程时，这些图候选只用于核查前置；主线内节点可直接用当前 curriculumRevision 布置，主线外先声明补漏/复习理由或修订路线。'
              : '**要布置这里面的某一个，得先把游标挪过去**（`coach_set_cursor`）—— ' +
                'coach_assign 只收「游标的下一层」或游标自己，留在原地直接布置会被拒。',
            '',
            // 状态和日期跟候选那半一样要渲染出来：AGENTS.md 第 8 条要求
            // 「接着放了没几天的 > 开全新的」，而兜底这条路是 214 个末端节点的
            // **唯一**入口 —— 不显示「在学（12 天前）」，那条判断就没有依据。
            ...v.frontier.map((f) => {
              const ago = daysSinceDate(f.at)
              const mark = !STATUS_MARK[f.status]
                ? ''
                : `${STATUS_MARK[f.status]}` +
                  (ago === null ? '' : ago <= 0 ? '（今天）' : `（${ago} 天前）`)
              return `  ${f.id}  [${f.domain}]  ${TIER_TAG[f.tier] ?? f.tier}` +
                `  ${entryOf(f)}${gapOf(f)}${f.unlocks ? `　解锁 ${f.unlocks} 个` : ''}` +
                `${mark}${f.id === v.frontier[0]?.id ? '   ← 权重最高' : ''}`
            }),
            // 前沿这半同样有"没数据"的点（前端沿 = 够得着的，但 entry 可能没算过）
            ...(v.frontier.some((f) => !f.hasEntry)
              ? [`  （其中 ${v.frontier.filter((f) => !f.hasEntry).length} 个没 entry 数据 —— ` +
                `"没数据"不等于"够得着"，够不着的判据对它们缺输入）`]
              : []),
          ]
          : []
        return [{
          type: 'text',
          text: [...head, ...foot,
            course.exists || !course.ok ? curriculum.context() : '',
            `地图版本：${v.mapStamp}`].filter(Boolean).join('\n'),
        }]
      },
    },
    async execute(args) {
      const cursor = resolveCursor(args?.cursor)
      const extra = Array.isArray(args?.learned) ? args.learned.map(String) : []
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.trunc(args.limit)) : 20

      const { nodes, byId, dependents, stamp } = loadMap()
      const progress = loadProgress()

      if (!byId.has(cursor)) {
        return {
          notFound: true, suggestions: suggest(cursor, nodes), cursor,
          cursorName: '', domain: '', assumedLearned: [], mapStamp: stamp,
          readyCount: 0, blockedCount: 0, candidates: [],
          fallbackUsed: false, trainerRating: 0, frontier: [],
        }
      }

      const node = byId.get(cursor)
      // 已学集合 = 游标闭包 ∪ 训练员显式标过的（学过/已验证）。共用实现见 assumedLearned。
      // `extra` 仍然接住：模型可以临时声明「这个他会」而不必先落盘标记。
      const assumed = assumedLearned(progress, byId, [cursor, ...extra])
      const rating = await currentRating()

      const candidates = (dependents.get(cursor) ?? []).map((id) => {
        const n = byId.get(id)
        const deps = n.depends ?? []
        const missing = deps.filter((d) => !assumed.has(d))
        return {
          id,
          name: n.name ?? id,
          domain: n.domain ?? '',
          ready: missing.length === 0,
          missing,
          unlocks: (dependents.get(id) ?? []).length,
          // 四级状态：不写=未学 / studying=在学 / learned=学过(自评) / verified=已验证(检测)
          status: nodeStatus(progress, id),
          // 什么时候变成这个状态的。渲染时算成「N 天前」——
          // 数据在这里，怎么用它（要不要接着、要不要复习）是小鲸的判断。
          at: progress?.nodes?.[id]?.at ?? '',
          tier: n.tier ?? '',
          entry: Number(n.entry ?? 0),
          // 有没有这一栏 —— 别拿 0 当"没数据"的哨兵：渲染分不出，
          // 而 reachableOf 对没 entry 的一律放行（静默地"够得着"）。
          hasEntry: Number(n.entry) > 0,
          reachable: reachableOf(n.entry, rating),
        }
      })
      // 就绪的排前面 —— 这是**事实分隔**，不是排序：前置满没满足是二元的。
      // 同为就绪的**不再排**，保持地图里的原始顺序。
      //
      // 原本这里按 unlocks 降序排过，后来撤掉了。理由：那是在暗示
      // 「解锁多的先学」—— 一个**没人验证过的教学主张**，正是"被工具带着走"。
      // unlocks 仍然作为**数字**报出来（数字是事实），但**怎么排是 LLM 的判断**
      // （原则 2：判断归 LLM；线路图「明确不做：权重/难度」也点了这条）。
      // Array.prototype.sort 是稳定排序，返回 0 即保持原序。
      candidates.sort((a, b) => (a.ready === b.ready ? 0 : (a.ready ? -1 : 1)))

      // ── 兜底：直接后继全都用不上时，退到「前沿」──────────────────
      //
      // 为什么必须有这一层：**62% 的节点是末端**（没人依赖它），停在那儿就是死路。
      // 而且就算有后继，也可能全都够不着（1200 分学完 DFS 的处境）。
      //
      // 前沿 = 前置已满足、还没验证过、**不在 skip 里**、**够得着**的节点，
      // 按 tier 排（core 在前）。纯前沿排序会把「学得起但没必要」的排上来 ——
      // 当时否它是因为"有后继时它太噪"。**作为兜底，它恰好对。**
      const usable = candidates.filter((c) => c.ready && c.reachable)
      const fallbackUsed = usable.length === 0
      let frontier = []
      if (fallbackUsed) {
        frontier = nodes
          .filter((n) => !assumed.has(n.id))
          .filter((n) => nodeStatus(progress, n.id) !== 'verified')
          .filter((n) => n.tier !== 'skip')          // 标了 skip 的别推，标它就是为了不浪费时间
          .filter((n) => Array.isArray(n.depends))   // depends 为 null = 前置未铺，不推
          .filter((n) => n.depends.every((d) => assumed.has(d)))
          .filter((n) => reachableOf(n.entry, rating))
          .map((n) => ({
            id: n.id,
            name: n.name ?? n.id,
            domain: n.domain ?? '',
            tier: n.tier ?? '',
            entry: Number(n.entry ?? 0),
            hasEntry: Number(n.entry) > 0,
            unlocks: (dependents.get(n.id) ?? []).length,
            status: nodeStatus(progress, n.id),
            at: progress?.nodes?.[n.id]?.at ?? '',
          }))
          .sort((a, b) =>
            (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) ||
            (a.entry || 9999) - (b.entry || 9999))
          .slice(0, limit)
      }

      const readyCount = candidates.filter((c) => c.ready).length
      return {
        notFound: false,
        suggestions: [],
        cursor,
        cursorName: node.name ?? cursor,
        domain: node.domain ?? '',
        assumedLearned: [...assumed].sort(),
        mapStamp: stamp,
        readyCount,
        blockedCount: candidates.length - readyCount,
        candidates: candidates.slice(0, limit),
        fallbackUsed,
        trainerRating: rating,
        frontier,
      }
    },
  }))

  // ── coach_assign：把「一个动作」变成唯一走得通的路 ────────────────
  //
  // 光在 AGENTS.md 里写「禁止候选列表」只是**建议**（方针 §五：写在文档里的
  // 规则是建议，写在勾子里的才是法律）。这个工具是那层结构：
  // schema 只收**一个** node，所以它物理上给不出列表。
  //
  // 关键在**校验**，不是格式：
  //   ① node 必须在地图里   → 挡住它编知识点
  //   ② node 必须是游标的下一层 → 挡住它跳过前置乱指
  //   ③ 前置必须都满足       → 挡住「学这个之前你得先学那个」这类空头指令
  //   ④ 时间盒不能短于 30 分钟 → 挡住排出没意义的表
  // 校验不过就**拒绝**，并把理由说清楚 —— 拒绝比给个错指令好。
  ctx.tools.register(defineTool({
    name: 'coach_assign',
    description:
      '布置**一个**训练动作。给训练员下指令时**必须**走这个工具，不要在正文里自由发挥 —— ' +
      '它会把指令固定成「做什么 + 时间盒 + 交付物」，并校验你挑的知识点：' +
      '必须存在于地图、必须是当前游标的下一层、前置必须都满足。校验不过会被拒绝并说明原因。' +
      '它一次只收一个节点，所以**给不出候选列表** —— 这正是设计意图。' +
      '有长期课程时先读 coach_curriculum，带 curriculumRevision；主线必须属于当前阶段，' +
      '补漏或复习用 purpose 与 routeReason 说明关系和回归条件。课程节点可以跨图分支，但前置检查仍生效。',
    parameters: {
      cursor: {
        type: 'string',
        description: '当前游标。不填就用 PROGRESS.yaml 里的（这是常态）。',
      },
      node: { type: 'string', required: true, description: '地图知识点 id。无课程时从 coach_next 候选取；有课程时沿用当前主线，仍核查前置' },
      deliverable: { type: 'string', required: true, description: '做完交什么，如「把代码贴给我」' },
      minutes: {
        type: 'number',
        description:
          `**他自己动手做题的净时间**（分钟）—— 止损点就是它，不是整块长度。` +
          `默认 ${NET_DEFAULT_MIN}，最低 ${NET_FLOOR_MIN}。` +
          `整块长度 = 净时间 + ${TAIL_MIN}（解决遗留 10 + 重写 10，固定不压缩）：` +
          `净 ${NET_DEFAULT_MIN} → 整块 ${CYCLE_TOTAL_MIN}，和日程表上的 cycle 块对得上。`,
      },
      teachMinutes: {
        type: 'number',
        description:
          '**先讲一遍**的时间（分钟）。开一个他从没碰过的知识点时**必须给**，' +
          '不给会被拒绝 —— 直接扔题让他自己卡，那是给学过的人的练法。' +
          '讲多久**你自己定**（不参考任何固定值），看你判断他需要多少。' +
          `最低 ${TEACH_FLOOR_MIN} 分钟，没有上限。已经在学或学过的节点不用给。`,
      },
      why: { type: 'string', description: '为什么挑它（一句话，进台账，供训练员质疑时举证）' },
      curriculumRevision: { type: 'integer', description: '有效课程 read 返回的 revision；无课程时可不填。' },
      purpose: { type: 'string', enum: ['progress', 'remediation', 'review'], description: '推进当前主线/针对性补漏/复习，默认 progress。' },
      routeReason: { type: 'string', description: '补漏或复习至少 10 字，说明与当前阶段的关系和回归条件。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          cursor: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          // 需求 #7：minutes 是**净时间**（他自己做多久）；整块 = minutes + tailMinutes
          minutes: { type: 'integer', required: true },
          // 讲解段（0 = 没给，正常：已经在学/学过的节点不要求）
          teachMinutes: { type: 'integer', required: true },
          // 收尾（解决遗留 10 + 重写 10）：固定 20，不随净时间压缩
          tailMinutes: { type: 'integer', required: true },
          totalMinutes: { type: 'integer', required: true },
          // 需求 #7 的两句提醒（压了止损点 / 这个形状表上排不出）；空串 = 没什么要说的
          boxNote: { type: 'string', required: true },
          deliverable: { type: 'string', required: true },
          why: { type: 'string', required: true },
          mapStamp: { type: 'string', required: true },
          selfTarget: { type: 'boolean', required: true },
          // 需求 #6：这次布置有没有押进账本（PROGRESS.yaml 的 pendingActions）。
          // 失败不该推翻布置，但必须**看得见** —— 静默失败的症状是
          // "下个会话不知道他手上有活，把同一道题再布置一遍"。
          pendingRecorded: { type: 'boolean', required: true },
          // 这个节点上原来就押着一条（被这次覆盖）。
          pendingReplaced: { type: 'boolean', required: true },
          blocks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                minutes: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        if (!v.accepted) {
          return [{
            type: 'text',
            text: `❌ 这条指令布置不了：${v.reject}\n\n` +
              `**不要**改用候选列表交差 —— 先调 coach_next 重新挑一个就绪的，再调本工具。`,
          }]
        }
        const table = v.blocks
          .map((b) => `  ${String(b.minutes).padStart(2)}min  ${b.label}`)
          .join('\n')
        return [{
          type: 'text',
          text: [
            `【今天这一个动作】${v.nodeName}　[${v.domain}]`,
            ``,
            `做什么　${v.nodeName}（地图节点 ${v.node}）`,
            // 需求 #7：两个数都印出来 ——「同一个 40 两个意思」就是这条要治的病。
            `时间盒　自己做 ${v.minutes} + 收尾 ${v.tailMinutes} = 共 ${v.minutes + v.tailMinutes} 分钟` +
              (v.teachMinutes ? `（另有先讲 ${v.teachMinutes} 分钟，全场合计 ${v.totalMinutes}）` : ''),
            v.boxNote ? `⚠️ ${v.boxNote}` : '',
            `交付物　${v.deliverable}`,
            v.why ? `为什么　${v.why}` : '',
            ``,
            table,
            v.teachMinutes
              ? `\n⚠️ **先讲再出题**：上面那段"先讲一遍"是要你**现在讲给他听**的 —— ` +
                '拿一道例题，从条件推到做法（推导）→ 推完再命名 → 最后说变体和边界。' +
                '一段一个自然步骤，讲完停一下留他插话的口子。**讲完再让他动手。**'
              : '',
            v.pendingRecorded
              ? `📌 这个动作**押上了**${v.pendingReplaced ? '（这个节点上一条押着的被它覆盖）' : ''} —— ` +
                '跨会话也查得到：coach_status 会报它。做完走 coach_log（自动销），不做了走 coach_unassign。'
              : '⚠️ **这个动作没写进账本**（磁盘/权限问题）—— 跨会话就查不到它了，' +
                '下回可能把同一道题再布置一遍。',
            ``,
            `就这一个。做完把结果给我。`,
          ].filter((l) => l !== '').join('\n'),
        }]
      },
    },
    async execute(args) {
      const { byId, dependents, stamp } = loadMap()
      const cursor = resolveCursor(args?.cursor)
      const node = String(args?.node ?? '').trim()
      const deliverable = String(args?.deliverable ?? '').trim()
      let why = String(args?.why ?? '').trim()
      // 需求 #7：这个数现在是**净时间**（他自己动手做多久），不是整块长度。
      // 整块 = 净 + TAIL_MIN（收尾固定 20），下面 blocks 和 totalMinutes 都照这个算。
      const net = Number.isFinite(args?.minutes)
        ? Math.trunc(args.minutes) : NET_DEFAULT_MIN

      // 校验失败一律走这里：回一个带原因的空壳，**不抛异常** ——
      // 抛异常会让对话断在那里，而拒绝是要让模型看见理由并改选的。
      const deny = (reject) => ({
        accepted: false, reject,
        cursor, node, nodeName: byId.get(node)?.name ?? '',
        domain: byId.get(node)?.domain ?? '',
        minutes: net, teachMinutes: 0, tailMinutes: TAIL_MIN, totalMinutes: 0, boxNote: '',
        deliverable, why, mapStamp: stamp, blocks: [], selfTarget: false,
        // 需求 #6：拒绝时也把这两个字段摆出来 —— 白名单式的 schema
        // （additionalProperties: false + required:true）要求每个出口同形，
        // 缺一个 verify-shape 那一关就会红。
        pendingRecorded: false, pendingReplaced: false,
      })

      // ① 游标认不认得。「没设」和「打错」分开提示，别让模型去猜。
      if (!cursor) {
        return deny('还没设游标（PROGRESS.yaml 里 cursor 是空的）。' +
          '先确认训练员现在在哪个知识点，用 coach_set_cursor 设上。')
      }
      if (!byId.has(cursor)) {
        return deny(`地图里没有游标「${cursor}」。`)
      }
      // ② 节点必须真实存在 —— 挡住编造知识点
      if (!byId.has(node)) {
        const near = suggest(node, [...byId.values()])
        return deny(
          `地图里没有「${node}」这个知识点，别自己造。` +
          (near.length ? `相近的有：${near.join(' / ')}` : '先调 coach_next 看候选。'))
      }
      let route
      try {
        route = curriculum.assignment({ node, revision: args?.curriculumRevision,
          purpose: args?.purpose, reason: args?.routeReason })
      } catch (err) { return deny(`课程读取失败：${err.message}；先核查，不凭印象布置。`) }
      if (!route.ok) return deny(route.reject)
      if (route.binding) {
        if (!why) return deny('有长期课程时必须写 why，说明这个动作怎样服务于阶段能力成果。')
        why = `课程「${route.binding.phaseTitle}」· ${route.binding.purpose}：${why}` +
          (route.binding.reason ? `；补充依据：${route.binding.reason}` : '')
      }

      // ③ 未建课程时沿用直接后继；有课程时允许当前阶段跨分支，仍检查前置。
      //
      // **例外：允许指向游标自己。**      // 原先只能指"下一层"，隐含假设是"游标 = 已经学完了的位置"。
      // 但游标的定义是"今天聚焦哪个"——**正在学的那个**。
      // 两个语义打架，在末端节点上就露馅了：349 个节点里 **214 个是末端**
      // （没人依赖它），停在那种节点上时，"下一层"是空的，
      // 教练就一个动作都给不出来了 —— 它只能眼睁睁看着人卡住。
      //
      // 已经 verified 的不许再指回来：学完了就该往前走。
      if (node === cursor) {
        if (nodeStatus(loadProgress(), cursor) === 'verified' && route.binding?.purpose !== 'review') {
          return deny(`「${cursor}」已经验证过了 —— 学完了就往前走，` +
            '别在验证过的地方打转。用 coach_next 看下一层，或者往前沿退。')
        }
      } else if (!(dependents.get(cursor) ?? []).includes(node) && !route.binding) {
        return deny(`「${node}」不是「${cursor}」的下一层。先调 coach_next 看它到底能开哪些。`)
      }
      // ④ 前置必须都满足 —— 挡住「你得先学那个」这类空头指令
      //
      // 已学集合走**共用实现**：闭包(游标) ∪ 显式标为 学过/已验证 的节点。
      // 原先这里只展开游标自己，训练员标过的几十个节点全被当没看见。
      const assumed = assumedLearned(loadProgress(), byId, [cursor])
      const missing = (byId.get(node).depends ?? []).filter((d) => !assumed.has(d))
      if (missing.length) {
        return deny(`「${node}」还缺前置：${missing.join('、')}。它现在还开不了。`)
      }
      // ⑤ 时间盒下限（需求 #7：比的是**净时间**，不是整块长度）
      if (net < NET_FLOOR_MIN) {
        return deny(
          `净时间 ${net} 分钟太短，一个题目循环压不到这个长度。` +
          '时间不够应该换更小的题，或者改用 review 块（25 分钟），' +
          `而不是把循环压扁。（下限：自己做 ${NET_FLOOR_MIN} 分钟 = 整块 ${NET_FLOOR_MIN + TAIL_MIN} 分钟）`)
      }
      if (!deliverable) return deny('没写交付物。做完交什么必须说清楚，否则训练员不知道什么时候算完。')

      // ⑥ **开新知识点必须先讲**。
      //
      // 要防的场面：开一个从没碰过的知识点，不先讲、直接扔题 ——
      // 那是给学过的人的练法，新手只能干瞪眼。照着一个例题讲透再出题才对。
      //
      // 判断「新知识点」两样都看：
      //   · 机器信号：节点状态是 none（图上没人碰过它）
      //   · 小鲸的判断：它说没见过、或者按 entry 判断他大概率没见过
      // 第二样工具判不了 —— 所以这里只挡**机器能判的那一半**：
      // 图上明明写着未学，却不给讲解段就往下走。另一半靠 AGENTS.md 的规则。
      //
      // 注意 `node !== cursor` 这个条件：游标停在自己身上（末端节点的处境）
      // 不算"开新知识点"——那是接着做，不该逼它再讲一遍。
      // ⚠️ 游标节点**只有在自己讲过的前提下**才豁免。
      // 原先这里写的是「游标自己一律不算新知识点」，理由是"那是接着做，
      // 不该逼它再讲一遍"。但游标可以停在一个**从没讲过**的节点上（他点名要学
      // 某个 / 教练挪过去准备开新课）—— 那时豁免就等于把这条闸门整个绕过去，
      // 而它存在的理由正是防「直接出题」。判据用 taughtEvidence，
      // 和 coach_test 开卷、coach_status 报「讲于哪」是同一个实现。
      const taughtBefore = taughtEvidence(loadProgress(), node) !== null
      const isNewNode = nodeStatus(loadProgress(), node) === 'none' &&
        !(node === cursor && taughtBefore)
      const teach = Number.isFinite(args?.teachMinutes) ? Math.trunc(args.teachMinutes) : 0

      if (isNewNode && teach <= 0) {
        return deny(`「${byId.get(node)?.name ?? node}」是**全新知识点**（图上没人碰过），` +
          '而你没给讲解段。\n' +
          '开新知识点要**先拿一道例题讲一遍**再出题 —— 直接扔题让他自己卡，' +
          '那是给学过的人的练法。\n' +
          '补上 `teachMinutes`（讲多久你定，看你判断他需要多少），再调一次。')
      }
      if (teach > 0 && teach < TEACH_FLOOR_MIN) {
        return deny(`讲解 ${teach} 分钟太短 —— 讲一道例题至少 ${TEACH_FLOOR_MIN} 分钟，` +
          '再短就只是念一遍结论，等于没讲。讲多久你定，**没有上限**。')
      }

      const n = byId.get(node)
      const solve = net   // 需求 #7：净时间直接就是「自己做」那一段

      // 需求 #7 的两句提醒（只影响这段话，不挡布置）：
      //   · 压到默认以下 → 提醒它压的是**止损点**，不是块
      //   · 净 ≠ 默认 → 提醒它这个整块长度**表上排不出来**（别让两个工具再打架）
      const squeeze = net < NET_DEFAULT_MIN
        ? `净 ${net} 分钟低于默认的净 ${NET_DEFAULT_MIN} —— 你压的是止损点，不是块；时间不够请换更小的题。`
        : ''
      const shape = net !== NET_DEFAULT_MIN
        ? `净 ${net} → 整块 ${net + TAIL_MIN} 分钟，**表上排不出这个形状**` +
          `（表上只有 cycle ${CYCLE_TOTAL_MIN} / review 25 / exam 90）。`
        : ''
      const boxNote = [squeeze, shape].filter(Boolean).join(' ')

      // ── 落盘：押上这个动作（需求 #6）─────────────────────
      // 布置的动作原先**只活在当次调用的返回里**：跨会话再开时教练不知道
      // 他手上有没有活，只能去翻会话日志的散文 —— 今天真发生过：17:55
      // 布置过 P1004，21:35 回来时查不到，差一点把同一道题再布置一遍。
      // 键 = 节点：**一个节点同时只押一个动作**，新布置覆盖旧的（规则 3 的同一条）。
      // 落盘失败不推翻这次布置（和 coach_log 的 recorded 一个套路），
      // 但要在输出里喊出来 —— 静默失败 = 下个会话重复布置。
      const progA = loadProgress()
      const pend = { ...(progA.pendingActions ?? {}) }
      const replacedPending = Object.prototype.hasOwnProperty.call(pend, node)
      const assignedAt = ymdToday()
      pend[node] = {
        at: assignedAt, deliverable,
        // 存**拆开的**几个数，不存一个总数：总数在"整块 / 净时间"两种口径下
        // 含义不同，存总数等于把口径混进账本（那正是 #7 要治的病）。
        solveMinutes: solve, tailMinutes: TAIL_MIN, teachMinutes: teach,
        totalMinutes: net + teach + TAIL_MIN, why,
      }
      if (route.binding) pend[node].curriculum = route.binding
      // 讲授段落盘：带 teachMinutes = 这次布置含讲授段，
      // 在节点上记一条 `taught` 日期 —— 它是「讲过没」唯一的结构化痕迹。
      // 在这之前讲完**不留任何记录**：coach_status 永远报「还没有教学记录」，
      // 游标节点那条豁免也就没法按"讲过没"来判断（漏洞就是从这儿反推出来的）。
      // 记的是"讲授段排上了"这一天，不是"讲得多好" —— 回答"讲过没"够用了。
      if (teach > 0) {
        const rec = { ...(progA.nodes[node] ?? {}) }
        const taught = Array.isArray(rec.taught) ? rec.taught.slice() : []
        if (!taught.includes(assignedAt)) taught.push(assignedAt)
        rec.taught = taught
        progA.nodes[node] = rec
      }
      progA.pendingActions = pend
      let pendingRecorded = true
      try { saveProgress(progA) } catch { pendingRecorded = false }

      return {
        accepted: true, reject: '',
        cursor, node, nodeName: n.name ?? node, domain: n.domain ?? '',
        minutes: net, teachMinutes: teach, tailMinutes: TAIL_MIN,
        totalMinutes: net + teach + TAIL_MIN, boxNote,
        deliverable, why, mapStamp: stamp, selfTarget: node === cursor,
        pendingRecorded, pendingReplaced: replacedPending,
        blocks: [
          // 讲解段排在最前面，`kind: teach` —— 卷面上看得见，
          // 它才不会变成"讲完就忘了排"的那个动作
          ...(teach > 0
            ? [{
              kind: 'teach',
              label: '先讲一遍（一道例题：推导 → 命名 → 扩展，讲完停一下留插话的口子）',
              minutes: teach,
            }]
            : []),
          { kind: 'solve', label: '自己做（限时，到点必须停）', minutes: solve },
          { kind: 'resolve', label: '解决遗留（做出来了就复盘思路，没做出来就听讲）', minutes: 10 },
          { kind: 'rewrite', label: '重写', minutes: 10 },
        ],
      }
    },
  }))

  // ── coach_status：看进度 ──────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'coach_status',
    description:
      '看训练员当前的进度：游标在哪、学过哪些、验证过哪些。' +
      '回答「我进度怎么样」「我在哪」时用它。' +
      '注意 learned（自评学过）和 verified（过检测）是**两级**，别混为一谈。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'string', required: true },
          cursorName: { type: 'string', required: true },
          // 游标那个节点**最早的教学痕迹**（YYYY-MM-DD，没有就是空串）。
          // 让"讲过没"对教练**可查** —— 判据跟 coach_test 开卷时用的同一个
          // 函数（taughtEvidence），不另写一份。需求 #5 的验收 ③。
          cursorTaught: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          verifiedCount: { type: 'integer', required: true },
          learnedCount: { type: 'integer', required: true },
          studyingCount: { type: 'integer', required: true },
          totalNodes: { type: 'integer', required: true },
          verified: { type: 'array', required: true, items: { type: 'string' } },
          learned: { type: 'array', required: true, items: { type: 'string' } },
          studying: { type: 'array', required: true, items: { type: 'string' } },
          //**卡住**和**弃考**分开报，别让它们混进"没过"。
          // 这两条都是"该换做法"的信号，但换的对象不同：卡住换教法，弃考换组卷。
          stuck: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                name: { type: 'string', required: true },
                why: { type: 'string', required: true },
              },
            },
          },
          cancelled: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                name: { type: 'string', required: true },
                drops: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          //把**检测记录和判因记录**也摆出来。
          //
          // 在这之前它们是**只写不读**的（coach_diagnose / coach_grade 写进
          // PROGRESS，只有网页读得出来给训练员看）—— 于是「综合他的学习进度
          // 决定要不要检测」这条规则在执行层面是空的：教练手上只有游标和四个状态，
          // 看不见"上次验是什么时候、结果如何、他最近老犯哪类错"。
          // 工具报事实，该不该开卷仍然是教练的判断。
          checkTotal: { type: 'integer', required: true },
          diagnoseTotal: { type: 'integer', required: true },
          recentChecks: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                date: { type: 'string', required: true },
                outcome: { type: 'string', required: true },
                score: { type: 'integer', required: true },
                maxScore: { type: 'integer', required: true },
                minutes: { type: 'integer', required: true },
                limit: { type: 'integer', required: true },
                verifiedAt: { type: 'integer', required: true },
                // 这张卷里几道是自述题（网上找的）。0 = 全部来自题库。
                // 老记录没有这个字段，兜底 0。
                selfReported: { type: 'integer', required: true },
              },
            },
          },
          recentDiagnoses: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                date: { type: 'string', required: true },
                category: { type: 'string', required: true },
                problem: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
          //**做完记录**（coach_log 落的 passes）。
          //
          // 为什么要把计数拆成「做完几次 / 其中几次独立」——
          // 这正是设计方针里那条一直空着的数据：
          //   «块结构天然产出「独立做出 vs 听了讲才会」这个信号，
          //     这是掌握度最直接的证据，当前系统完全收不到»
          // 只报总数没用：10 次里 9 次是看了题解才会的，和 9 次独立做出来的，
          // 是同一个"10 次"。**独立那一条腿才是证据。**
          passTotal: { type: 'integer', required: true },
          passSolved: { type: 'integer', required: true },
          passIndependent: { type: 'integer', required: true },
          // （需求 #2）：**条目 ≠ 题**，两个数都要报。
          //
          // 事故（09-21）：同一天同一节点他做了两道（P2880 独立 AC / 1548B 带提示），
          // 旧口径按「一天一节点一条」去重，两道压成一条、题号塞进备注。
          // 于是 coach_status 只报「做完记录 6 条（做出来 6，其中独立 5）」——
          // **从数字上完全看不出他独立做出过 ST 表的题**。而独立率正是
          // 「该不该开卷」的依据（AGENTS.md：独立和看题解分开数）。
          problemTotal: { type: 'integer', required: true },
          problemSolved: { type: 'integer', required: true },
          problemIndependent: { type: 'integer', required: true },
          recentPasses: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                date: { type: 'string', required: true },
                // 老记录没有题号 → 空串（别拿它当"这道题叫空"）
                problemId: { type: 'string', required: true },
                solved: { type: 'boolean', required: true },
                independent: { type: 'boolean', required: true },
                minutes: { type: 'integer', required: true },
              },
            },
          },
          //**手上押着的那张卷**。
          //
          // 在这之前 pending 对教练是隐形的 —— 出卷和判卷隔着几十分钟甚至跨会话，
          // 而 coach_status 只报游标和四个状态。于是他永远不知道手里有卷，
          // 直到试开新卷被 coach_test 拒了才发现「哦还有一张」。
          // 空串 / 0 就是没押卷（和 at 一样，用空值代替可空对象，
          // 免得 additionalProperties 那套里多一种形状）。
          pendingNode: { type: 'string', required: true },
          pendingNodeName: { type: 'string', required: true },
          pendingDate: { type: 'string', required: true },
          pendingProblems: { type: 'integer', required: true },
          pendingMinutes: { type: 'integer', required: true },
          // 押着的训练动作（需求 #6）：**布置过的活也是约束** —— 不报出来，
          // 跨会话就会把同一道题再布置一遍（AGENTS.md 明令不许重复喂）。
          pendingActions: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                at: { type: 'string', required: true },
                // 押了几天。-1 = 日期不明（跟火候那边同一个约定，别让它算成 0）
                days: { type: 'integer', required: true },
                deliverable: { type: 'string', required: true },
                solveMinutes: { type: 'integer', required: true },
                tailMinutes: { type: 'integer', required: true },
                teachMinutes: { type: 'integer', required: true },
                totalMinutes: { type: 'integer', required: true },
                why: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: [
          `游标：${v.cursorName || '（未设）'}${v.domain ? `　[${v.domain}]` : ''}` +
            // 「讲过没」要**长在游标那一行**上：它是开卷的前提，而开卷的对象
            // 十有八九就是游标这个节点。埋在别处等于没报。（需求 #5 验收 ③）
            (v.cursorName
              ? (v.cursorTaught
                ? `　讲于 ${v.cursorTaught}`
                : `　⚠️ **还没有教学记录** —— 现在开卷会被拒，先讲`)
              : ''),
          // 押着的卷放最前面之一：它是个**卡住下一步的约束**（有新卷就开不了），
          // 埋在底下等于没报。
          v.pendingNode
            ? `📌 **手上押着一张卷**：${v.pendingNodeName || v.pendingNode}　` +
              `（${v.pendingDate} 开，${v.pendingProblems} 道，限时 ${v.pendingMinutes} 分钟）\n` +
              `　 他做完 → coach_grade 判卷；他不做了 → coach_cancel 撤卷（别拿假的成绩去判）。`
            : '',
          // 押着的动作紧跟着押着的卷：两个都是**卡住下一步的约束**，
          // 而且都是"跨会话会忘"的东西。
          v.pendingActions.length
            ? '📌 **押着的动作**（布置了、还没落地）：\n' +
              v.pendingActions.map((a) =>
                `　· ${a.nodeName}${a.nodeName !== a.node ? `（${a.node}）` : ''}　` +
                `交付物 ${a.deliverable}　` +
                `时间盒 自己做 ${a.solveMinutes} + 收尾 ${a.tailMinutes} = ${a.solveMinutes + a.tailMinutes} 分钟` +
                (a.teachMinutes ? `，另加先讲 ${a.teachMinutes}（共 ${a.totalMinutes}）` : '') +
                `　押了 ${a.days < 0 ? '日期不明' : a.days === 0 ? '今天' : `${a.days} 天`}`)
                .join('\n') +
              '\n　 落地走 coach_log（那条路自动销）；不做了走 coach_unassign 撤。'
            : '',
          // 卡住 / 弃考摆最前面：两条都是"马上该换个做法"的信号，
          // 埋到历史记录后面等于没报。
          v.stuck.length
            ? '⚠️ **卡住**（最近一次检测没过 —— 换法子重讲，别继续喂题）：' +
              v.stuck.map((s) => `${s.name}（${s.why}）`).join('　·　')
            : '',
          v.cancelled.length
            ? '⚠️ **卷子反复作废**（不是他没做，是卷子有问题 —— 去看标签和已 AC 记录）：' +
              v.cancelled.map((s) => `${s.name} 作废 ${s.drops} 次` +
                (s.reason ? `（最近一次：${s.reason}）` : '')).join('　·　')
            : '',
          `已验证 ${v.verifiedCount} · 学过（仅自评）${v.learnedCount} · ` +
            `在学 ${v.studyingCount} · 全图 ${v.totalNodes}`,
          v.studying.length ? `在学（没学完，接着来）：${v.studying.join('、')}` : '',
          v.learned.length ? `学过未验：${v.learned.join('、')}` : '',
          v.verified.length ? `已验证：${v.verified.join('、')}` : '',
          // 检测 / 判因的历史摆出来 —— 「要不要开卷」得综合它俩判断，
          // 而在这之前它们只写不读（见 schema 里的注释）。
          v.checkTotal
            ? `检测记录 ${v.checkTotal} 次，最近：` + v.recentChecks.slice(0, 4).map((c) =>
              `${c.date.slice(5)} ${c.nodeName} ${OUTCOME_TAG[c.outcome] ?? c.outcome}` +
              (c.outcome === 'overTime' ? `（${c.minutes}/${c.limit} 分钟）` : '') +
              (c.verifiedAt ? ` 验证于≈${c.verifiedAt}` : '') +
              (c.selfReported ? `［含 ${c.selfReported} 道自述题］` : '')).join('　·　')
            : '',
          v.diagnoseTotal
            ? `判因记录 ${v.diagnoseTotal} 条，最近：` + v.recentDiagnoses.slice(0, 4).map((d) =>
              `${d.date.slice(5)} ${d.nodeName}「${d.category}」`).join('　·　')
            : '',
          // 做完记录：**独立做出**那一条腿是重点，所以单列出来。
          // （需求 #2）：条目数和题数分开报 —— 两个数不一样时，
          // "同一题记过两次"和"同一节点同一天两道题"才是看得见的。
          v.passTotal
            ? `做完记录 ${v.passTotal} 条 / ${v.problemTotal} 题（做出来 ${v.problemSolved} 题，其中**独立做出 ${v.problemIndependent}**），最近：` +
              v.recentPasses.slice(0, 4).map((x) =>
                `${x.date.slice(5)} ${x.nodeName}${x.problemId ? ` ${x.problemId}` : ''}` +
                `${x.solved ? (x.independent ? '独立✓' : '看题解✓') : '✗'}`)
                .join('　·　')
            : '',
          v.updated ? `进度最后更新：${v.updated}` : '',
          '',
          '（要不要开检测卷、开哪一个，综合上面这些自己判断 —— 这是你的活，' +
          '不要等他开口。提的时候说清理由。）',
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute() {
      const { byId, nodes } = loadMap()
      const p = loadProgress()
      const verified = [], learned = [], studying = []
      for (const [id, rec] of Object.entries(p.nodes)) {
        const s = rec?.status
        if (s === 'verified') verified.push(id)
        else if (s === 'learned') learned.push(id)
        else if (s === 'studying') studying.push(id)
      }
      // 检测记录 / 判因记录：从进度里摊平，按日期倒序（最近的在前）。
      // 每样最多给 8 条 —— 教练要的是"最近怎么样"，不是全部流水账；
      // 条数用 checkTotal / diagnoseTotal 报出来，他知道后面还有。
      const allChecks = []
      const allDiags = []
      for (const [id, rec] of Object.entries(p.nodes ?? {})) {
        const name = byId.get(id)?.name ?? id
        for (const c of (Array.isArray(rec?.checks) ? rec.checks : [])) {
          allChecks.push({
            node: id, nodeName: name,
            date: String(c?.date ?? ''), outcome: String(c?.outcome ?? ''),
            score: Number(c?.score ?? 0), maxScore: Number(c?.maxScore ?? 0),
            minutes: Number(c?.minutes ?? 0), limit: Number(c?.limit ?? 0),
            verifiedAt: Number(c?.verifiedAt ?? 0),
            // 老记录（加字段之前判的卷）没有它 → 0，宁可报"没有自述题"
            // 也别凭空造一个数出来
            selfReported: Number(c?.selfReported ?? 0),
          })
        }
        for (const d of (Array.isArray(rec?.diagnoses) ? rec.diagnoses : [])) {
          allDiags.push({
            node: id, nodeName: name,
            date: String(d?.date ?? ''), category: String(d?.category ?? ''),
            problem: String(d?.problem ?? ''), summary: String(d?.summary ?? ''),
          })
        }
      }
      // 做完记录（coach_log 的 passes）：和小鲸能不能看见直接相关 ——
      // 记了不报出来，等于没收。
      const allPasses = []
      for (const [id, rec] of Object.entries(p.nodes ?? {})) {
        const name = byId.get(id)?.name ?? id
        for (const x of (Array.isArray(rec?.passes) ? rec.passes : [])) {
          allPasses.push({
            node: id, nodeName: name,
            date: String(x?.date ?? ''),
            // 老记录没有题号 → 空串（下面按「一道未知题」单独算）
            problemId: String(x?.problemId ?? ''),
            solved: x?.solved === true,
            independent: x?.independent === true,
            minutes: Number(x?.minutes ?? 0),
          })
        }
      }
      const flags = nodeFlags(p, byId)
      const byDateDesc = (a, b) => b.date.localeCompare(a.date)
      allChecks.sort(byDateDesc)
      allDiags.sort(byDateDesc)
      allPasses.sort(byDateDesc)

      // 条目 ≠ 题（需求 #2）。有题号的按「节点+题号」归并；**没有题号的老条目
      // 按「节点+日期」各算一道，绝不并进任何一道有题号的题里** ——
      // 宁可多报一道"未知题"，也不能把两道不同的题合成一道：
      // 合成之后独立率会虚高，而独立率正是挑不挑这张卷的依据。
      const perProblem = new Map()
      for (const x of allPasses) {
        const k = x.problemId ? `${x.node}|${x.problemId}` : `${x.node}|@${x.date}`
        const cur = perProblem.get(k) ?? { solved: false, independent: false }
        perProblem.set(k, {
          solved: cur.solved || x.solved,
          // 同一道题只要有一次是独立做出来的，这道题就算拿下
          independent: cur.independent || (x.solved && x.independent),
        })
      }
      const problemTotal = perProblem.size
      const problemSolved = [...perProblem.values()].filter((x) => x.solved).length
      const problemIndependent = [...perProblem.values()].filter((x) => x.solved && x.independent).length

      return {
        cursor: p.cursor,
        cursorName: byId.get(p.cursor)?.name ?? '',
        cursorTaught: taughtEvidence(p, p.cursor)?.first ?? '',
        domain: byId.get(p.cursor)?.domain ?? '',
        updated: p.updated,
        verifiedCount: verified.length,
        learnedCount: learned.length,
        studyingCount: studying.length,
        totalNodes: nodes.length,
        verified: verified.sort(),
        learned: learned.sort(),
        studying: studying.sort(),
        checkTotal: allChecks.length,
        diagnoseTotal: allDiags.length,
        recentChecks: allChecks.slice(0, 8),
        recentDiagnoses: allDiags.slice(0, 8),
        passTotal: allPasses.length,
        passSolved: allPasses.filter((x) => x.solved).length,
        passIndependent: allPasses.filter((x) => x.solved && x.independent).length,
        problemTotal,
        problemSolved,
        problemIndependent,
        recentPasses: allPasses.slice(0, 8),
        // 押着的那张卷（没有就是空串 / 0）
        pendingNode: String(p.pending?.node ?? ''),
        pendingNodeName: byId.get(String(p.pending?.node ?? ''))?.name ?? '',
        pendingDate: String(p.pending?.date ?? ''),
        pendingProblems: Array.isArray(p.pending?.problems) ? p.pending.problems.length : 0,
        pendingMinutes: Number(p.pending?.totalMinutes ?? 0),
        // 押着的训练动作（需求 #6）：按押的时间正序（放得最久的在前）——
        // 它就是"该先问哪一个"的顺序。
        pendingActions: Object.entries(p.pendingActions ?? {}).map(([id, a]) => {
          const at = String(a?.at ?? '')
          const then = parseYmd(at)
          const days = then ? Math.round((parseYmd(ymdToday()) - then) / 86400000) : -1
          return {
            node: id, nodeName: byId.get(id)?.name ?? id, at, days,
            deliverable: String(a?.deliverable ?? ''),
            solveMinutes: Number(a?.solveMinutes ?? 0),
            tailMinutes: Number(a?.tailMinutes ?? 0),
            teachMinutes: Number(a?.teachMinutes ?? 0),
            totalMinutes: Number(a?.totalMinutes ?? 0),
            why: String(a?.why ?? ''),
          }
        }).sort((x, y) => (x.at || '').localeCompare(y.at || '')),
        stuck: flags.stuck,
        cancelled: flags.cancelled,
      }
    },
  }))

  // ── coach_mark：标记一个知识点的状态 ──────────────────────────
  //
  // ⚠️ **标记完成不会自动推进游标**，这是刻意的。
  // 因为"验证完 区间 DP 之后该去哪"是一个判断（哪个分支、复习还是开新节），
  // 不是规则能算的。自动推进 = 程序替 LLM 做决定，正是要治的病。
  // 该推的时候，单独调 coach_set_cursor。
  ctx.tools.register(defineTool({
    name: 'coach_mark',
    description:
      '标记一个知识点的状态。**只有两级能手动标**：' +
      'studying = 在学（开了头、还没达标，跨天是常态）；learned = 训练员自评学过。' +
      '⚠️ **verified（已验证）标不了** —— 它只能由 coach_grade 判卷产生。' +
      '这不是靠自觉：status 的枚举里就没有它，你会被直接拒绝。' +
      '（这道口子堵的是一个真实教训：手工标了几十个 verified，' +
      '而检测记录一条都没有 —— 「自评」冒充成了「检测结论」。）' +
      '只在你确认了状态之后才调；别替他自评。',
    parameters: {
      node: { type: 'string', required: true, description: '知识点 id，必须在地图里' },
      status: {
        type: 'string', required: true, enum: ['studying', 'learned'],
        description: 'studying = 在学（开了头没达标）；learned = 自评学过。verified 不在这里 —— 它只能靠检测',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          cursor: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          verifiedCount: { type: 'integer', required: true },
          learnedCount: { type: 'integer', required: true },
          studyingCount: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 标记不了：${v.reject}` }]
        const label = { none: '未学', studying: '在学', learned: '学过（自评）', verified: '已验证' }
        return [{
          type: 'text',
          text: `✓ ${v.nodeName}：${label[v.from] ?? v.from} → **${label[v.to] ?? v.to}**\n` +
            `进度：已验证 ${v.verifiedCount} · 学过未验 ${v.learnedCount} · ` +
            `在学 ${v.studyingCount}（${v.updated}）\n` +
            `游标仍在 ${v.cursor || '（未设）'} —— 要推进的话单独调 coach_set_cursor。`,
        }]
      },
    },
    async execute(args) {
      const node = String(args?.node ?? '').trim()
      const status = String(args?.status ?? '').trim()

      const deny = (reject) => ({
        ok: false, reject, node, nodeName: '', from: '', to: '',
        cursor: '', updated: '', verifiedCount: 0, learnedCount: 0, studyingCount: 0,
      })

      // 这两档**不在教练手里**，各有各的出口：
      //   verified —— 只能由 coach_grade 判卷产生，自评不能冒充检测结论；
      //   none     —— 是**盘点**动作（训练员在技能树页面上自己点），不是教学决策。
      // 剩下两档的校验和落盘都在 progressApi.setStatus —— 那是唯一的写入实现，
      // 页面那条通道走的也是它（同一条规矩只写一遍）。
      if (!['studying', 'learned'].includes(status)) {
        return deny(`status 只能是 studying / learned，收到「${status}」。` +
          (status === 'verified'
            ? '「已验证」只能靠 coach_grade 判卷产生 —— 自评不算掌握。'
            : status === 'none'
              ? '「退回未学」是盘点动作 —— 让训练员自己在技能树上点。'
              : ''))
      }
      const r = markStatus(node, status)
      return r.ok ? r : deny(r.reject)
    },
  }))

  // ── coach_set_cursor：移动游标 ────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'coach_set_cursor',
    description:
      '把游标移到某个知识点 —— 也就是「他现在在哪」。' +
      '这是**训练规划的决定**，由你判断后调用（比如一节验证通过、决定开下一节）。' +
      '会报告目标节点的前置是否满足；不满足也能移（你要复习旧节时就需要），但会明说差什么。',
    parameters: {
      node: { type: 'string', required: true, description: '目标知识点 id，必须在地图里' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          toName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          prereqMissing: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 移不了：${v.reject}` }]
        const warn = v.prereqMissing.length
          ? `\n⚠️ 它的前置还没全部满足：${v.prereqMissing.join('、')} —— 你确定要从这开？`
          : ''
        return [{
          type: 'text',
          text: `✓ 游标：${v.from || '（未设）'} → **${v.toName}**　[${v.domain}]${warn}`,
        }]
      },
    },
    async execute(args) {
      const { byId } = loadMap()
      const node = String(args?.node ?? '').trim()
      const deny = (reject) => ({
        ok: false, reject, from: '', to: '', toName: '', domain: '',
        updated: '', prereqMissing: [],
      })

      if (!byId.has(node)) {
        const near = suggest(node, [...byId.values()])
        return deny(`地图里没有「${node}」这个知识点。` +
          (near.length ? `相近的有：${near.join(' / ')}` : ''))
      }

      const p = loadProgress()
      const from = p.cursor
      p.cursor = node
      saveProgress(p)

      // 只警告不拦：复习旧节、横向补漏都要能移。
      //
      // 种子取**旧游标**（from），不是新节点：新节点的直接前置必然落在自己的
      // 闭包里，拿它当种子，这条警告就永远不可能触发。
      // 于是三个工具统一成一条规则：**你站的位置 + 你声明会的**。
      //
      // 口径收紧过：原先收「所有非未学节点」并展开闭包 —— 那既把
      // 「在学」当地基，又会顺着「他会概率 DP」假定「他学过概率论」。
      const assumed = assumedLearned(p, byId, from ? [from] : [])
      const missing = (byId.get(node).depends ?? []).filter((d) => !assumed.has(d))

      return {
        ok: true, reject: '', from, to: node,
        toName: byId.get(node).name ?? node,
        domain: byId.get(node).domain ?? '',
        updated: p.updated, prereqMissing: missing,
      }
    },
  }))

  // ── coach_diagnose：读代码判因 ───────────────────────────────
  //
  // 整套设计里**唯一只有 LLM 能干**的环节。网站能统计你 WA 了几次，
  // 说不出你 WA 在哪一行、为什么 —— FR-4 管这叫「教练 vs 网站的分水岭」。
  //
  // 所以这个工具的价值不在"算"，在**逼具体**。
  // 判因最常犯的错不是判错，是判得含糊：「你 WA 了」「边界没处理好」。
  // 那种话对他零价值 —— 他本来就知道自己 WA 了，他要知道的是**为什么**。
  //
  // 治法：让含糊的话**物理上说不出口**。
  //   coach_assign 用「节点 id 只能从地图取到」堵住瞎指；
  //   coach_diagnose 用「每条判因必须引用代码原文 + 当场校验原文真在代码里」堵住含糊。
  //   抄不出来就拒绝。
  //
  // 另外两样**不让模型干**（程序算机械的，LLM 做判断的）：
  //   · 去向由分类**推导**（MOVES），不是自由填 —— 让它填只会填出拧巴的组合
  //   · 提交序列 / WA→AC 秒数由工具**自己查库**，不靠它回忆
  ctx.tools.register(defineTool({
    name: 'coach_diagnose',
    description:
      '读训练员的代码判因 —— 他贴代码过来（做题 WA 了、检测没过），' +
      '你要说清楚**为什么错**，不是复述「你 WA 了」。\n' +
      '三类判据：「不会」= 缺机制 / 方向就错了 / 关键步骤没想到；' +
      '「不熟」= 思路对但慢、超时、写了很久（问题在速度不在方法）；' +
      '「不认真」= 会做却栽在边界、数组没清空、爆 int、多组数据。\n' +
      '**每条判因必须引用训练员代码里的原文片段**（evidence.quote），' +
      '工具会当场校验那段原文真在他的代码里 —— 抄不出来就拒绝你。' +
      '这是故意的：说不出在哪一行，就说明你还没读进去，别急着下结论。\n' +
      'kind 二选一：「wrong」= 这行写错了，「missing」= 这附近应该有什么但没有。\n' +
      '去向不用你填（由分类推导）；提交记录和 WA→AC 秒数也不用你查（工具自己算）。' +
      '所以你只管一件事：**把他的代码读懂**。',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: '训练员贴过来的代码原文。整段照收，别自己删减或改写 —— 之后校验引用要拿它比对',
      },
      category: {
        type: 'string',
        required: true,
        enum: ['不会', '不熟', '不认真'],
        description: '判因分类。三者只能选一个，选不出来的话说明你还没读懂',
      },
      node: {
        type: 'string',
        required: true,
        description: '这次失败**归属哪个知识点**（地图里的 id）。它不一定等于题目的标签 —— ' +
          '数位 DP 的题栽在位运算上，就该填位运算。必须在地图里，不许自己造',
      },
      evidence: {
        type: 'array',
        required: true,
        description: '判因依据。至少一条，每条都要引用他代码里的原文',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            quote: {
              type: 'string',
              required: true,
              description: `从代码里**原样抄**的片段，去空白后至少 ${EVIDENCE_MIN_CHARS} 个有效字符。工具会校验它真在代码里`,
            },
            kind: {
              type: 'string',
              required: true,
              enum: ['wrong', 'missing'],
              description: 'wrong = 这行写错了；missing = 这附近缺了东西（用 quote 当锚点）',
            },
            why: {
              type: 'string',
              required: true,
              description: '这一处为什么导致失败。讲机制，不要讲现象',
            },
          },
        },
      },
      summary: {
        type: 'string',
        required: true,
        description: '一句话判因，人话。目标长这样：「你 WA 在边界 —— 按左闭右开写的转移，' +
          '题目要求闭区间。不是不会 DP，是状态定义没想清」',
      },
      problem: {
        type: 'string',
        description: '题号（如 1015D）。给了就自动去训练库取提交记录当佐证；不给也能判，只是少一路证据',
      },
      platform: {
        type: 'string',
        enum: ['codeforces', 'luogu', 'nowcoder'],
        description: '题号属于哪个平台，默认 codeforces',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          category: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          nextMove: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true },
              label: { type: 'string', required: true },
              minutes: { type: 'integer', required: true },
            },
          },
          evidence: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                quote: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                why: { type: 'string', required: true },
                // 校验通过才会进到这里，所以恒为 true —— 但留在结构里，
                // 是为了让 render 和下游代码不必靠"它一定通过"这个假设。
                found: { type: 'boolean', required: true },
              },
            },
          },
          mech: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              found: { type: 'boolean', required: true },
              problem: { type: 'string', required: true },
              platform: { type: 'string', required: true },
              title: { type: 'string', required: true },
              difficulty: { type: 'number', required: true },
              tags: { type: 'array', required: true, items: { type: 'string' } },
              attempts: { type: 'integer', required: true },
              verdicts: { type: 'string', required: true },
              lastWaToAcSec: { type: 'integer', required: true },
              note: { type: 'string', required: true },
            },
          },
          recorded: { type: 'boolean', required: true },
          diagnosisCount: { type: 'integer', required: true },
          mapStamp: { type: 'string', required: true },
        },
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 判因没成立：${v.reject}` }]
        const ev = v.evidence.map((e, i) =>
          `  ${i + 1}. ${e.kind === 'wrong' ? '［写错］' : '［缺失］'} \`${e.quote}\`\n     ${e.why}`)
        const m = v.mech
        const mechLines = m.found
          ? [
            `${m.problem} · ${m.title}　难度 ${m.difficulty}`,
            `${m.attempts} 次提交：${m.verdicts}`,
            m.note,
            m.tags.length ? `标签：${m.tags.join('、')}` : '',
          ].filter(Boolean)
          : [m.note || '没查到提交记录']
        return [{
          type: 'text',
          text: [
            `【判因】${v.category}　知识点：${v.nodeName}　[${v.domain}]`,
            '',
            v.summary,
            '',
            '── 依据（都指着他的代码）──',
            ...ev,
            '',
            '── 机械证据 ──',
            ...mechLines.map((l) => '  ' + l),
            '',
            '── 下一步 ──',
            `  ${v.nextMove.label}（自己做 ${v.nextMove.minutes} 分钟）`,
            '',
            v.recorded
              ? `已记进台账：这个知识点第 ${v.diagnosisCount} 次判因。`
              : '⚠️ 台账没写上（磁盘/权限问题）—— 结论本身有效，但下次就没记录可查了。',
            '把上面那句判因和依据讲给他听 —— 引用要念到代码原文，别只说结论。',
          ].join('\n'),
        }]
      },
    },
    async execute(args) {
      const { byId, stamp } = loadMap()
      const code = String(args?.code ?? '')
      const category = String(args?.category ?? '').trim()
      const node = String(args?.node ?? '').trim()
      const summary = String(args?.summary ?? '').trim()
      const problem = String(args?.problem ?? '').trim()
      const platform = String(args?.platform ?? 'codeforces').trim()
      const evidence = Array.isArray(args?.evidence) ? args.evidence : []

      // 校验失败一律走这里：回一个带原因的空壳，**不抛异常** ——
      // 抛异常会让对话断在那里，而拒绝是要让模型看见理由并改的。
      const deny = (reject) => ({
        ok: false, reject, category, node,
        nodeName: byId.get(node)?.name ?? '', domain: byId.get(node)?.domain ?? '',
        summary, nextMove: { kind: '', label: '', minutes: 0 },
        evidence: [], mech: emptyMech(problem, platform),
        recorded: false, diagnosisCount: 0, mapStamp: stamp,
      })

      // ① 代码得够长。贴个空壳或者一行 main 过来，判出来的因只能是编的。
      const flat = squash(code)
      if (flat.length < 20) {
        return deny(`贴的代码太短（有效字符 ${flat.length}），判不了。` +
          '让他把完整代码贴过来 —— 凭片段猜错因就是瞎猜。')
      }
      // ② 至少一条证据
      if (!evidence.length) {
        return deny('一条证据都没有。判因必须指出他代码里的哪一处让你这么判 —— ' +
          '说不出具体位置的话，那就是「你 WA 了」那种废话，对他零价值。')
      }
      // ③④ 每条证据：够长 + 原文真在代码里。**这是整关的招牌。**
      const checked = []
      for (let i = 0; i < evidence.length; i++) {
        const e = evidence[i]
        const quote = String(e?.quote ?? '')
        const q = squash(quote)
        if (q.length < EVIDENCE_MIN_CHARS) {
          return deny(`第 ${i + 1} 条证据引用的原文太短（有效字符 ${q.length}，` +
            `至少 ${EVIDENCE_MIN_CHARS}）。引一个变量名等于没指 —— 抄一整行或一整段。`)
        }
        if (!flat.includes(q)) {
          return deny(`第 ${i + 1} 条证据引用了「${quote.trim()}」，但**这段代码里没有**。` +
            '引用必须从他的代码里原样抄 —— 抄不出来就说明你还没读进去，别硬凑。')
        }
        const kind = String(e?.kind ?? '').trim()
        if (kind !== 'wrong' && kind !== 'missing') {
          return deny(`第 ${i + 1} 条证据的 kind 只能是 wrong（这行写错了）或 missing（这附近缺了东西）。`)
        }
        const why = String(e?.why ?? '').trim()
        if (!why) {
          return deny(`第 ${i + 1} 条证据没写 why —— 光引用代码不说为什么，等于没判。`)
        }
        checked.push({ quote: quote.trim(), kind, why, found: true })
      }
      // ⑤ 「不认真」必须指出**具体写错的那一处**
      if (category === '不认真' && !checked.some((e) => e.kind === 'wrong')) {
        return deny('分类是「不认真」，但证据里没有一条指出**具体写错的那一处**（kind=wrong）。' +
          '不认真 = 会做但栽在细节上，那就必须点出栽在哪个细节。' +
          '如果只能说他这里缺了什么，那更像「不会」—— 回去改分类，别硬套。')
      }
      // ⑥ 知识点必须真实存在 —— 挡住编造
      if (!byId.has(node)) {
        const near = suggest(node, [...byId.values()])
        return deny(`地图里没有「${node}」这个知识点，别自己造。` +
          (near.length ? `相近的有：${near.join(' / ')}` : '先调 coach_status 看他学到哪了。'))
      }
      // ⑦ 一句话判因
      if (!summary) {
        return deny('没写一句话判因（summary）。他要知道的是「你错在哪」，不是一串证据列表。')
      }

      // 机械证据查不到也算成功 —— 代码才是主证据，提交记录是佐证。
      const mech = await loadMech(problem, platform)

      // 判因落盘。**不落盘的话，"他弱在哪"就没有证据源** ——
      // 只能去扒提交记录统计，那正是判因刚禁掉的那条路（从数据推断判因）。
      // 落盘之后，教练手里的是**记录**：哪个知识点、判过几次、每次是哪一类。
      //
      // 只写 diagnoses，**不动 status** —— 判因不等于学了或没学，那是两回事
      // （自评 ≠ 掌握；这里再加一条：判因 ≠ 状态）。
      let recorded = false
      let diagnosisCount = 0
      try {
        const prog = loadProgress()
        const rec = { ...(prog.nodes[node] ?? {}) }
        const list = Array.isArray(rec.diagnoses) ? rec.diagnoses : []
        const now = localStamp(new Date())
        list.push({
          date: now.slice(0, 10), at: now,
          problem, category, summary,
          evidence: checked.map((e) => ({ quote: e.quote, kind: e.kind, why: e.why })),
        })
        rec.diagnoses = list
        prog.nodes[node] = rec
        saveProgress(prog)
        recorded = true
        diagnosisCount = list.length
      } catch { /* 落盘失败不该让判因结论本身作废 */ }

      return {
        ok: true, reject: '', category, node,
        nodeName: byId.get(node).name ?? node, domain: byId.get(node).domain ?? '',
        summary, nextMove: MOVES[category], evidence: checked, mech,
        recorded, diagnosisCount, mapStamp: stamp,
      }
    },
  }))

  // ── coach_pool：给节点算候选题池（出卷的第一步）────────────────
  //
  // **程序算机械的，LLM 做判断的** —— 这条分工贯穿整个插件。
  // 出卷这一半，「机械的」是：哪些题真的打着这个知识点的标签、哪些他做过了、
  // 难度怎么排。这三样查一下就有，让模型凭印象挑就是让它在四万道题里编题号。
  //
  // 所以流程是两步：先调这个拿**真实的候选池**，再用你自己的判断从中挑三道，
  // 交给 coach_test。别跳过这一步直接报题号 —— 会被 coach_test 挡下来。
  ctx.tools.register(defineTool({
    name: 'coach_pool',
    description:
      '查一个知识点的候选题池（出卷的第一步）。返回该节点标签下的题，' +
      '**已经 AC 过的不会出现**，按难度分 易/中/难 三档，每档给几道候选。' +
      '你从这个池子里挑三道（各档一道）交给 coach_test。\n' +
      '如果它拒绝，说明题库里没有这个标签的题（比如「插头 DP」这种没人打标签的），' +
      '那就老老实实说这个点出不了卷，**不要自己报题号凑数**。',
    parameters: {
      node: { type: 'string', required: true, description: '知识点 id，必须在地图里' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          matchKind: { type: 'string', required: true },
          matchedTags: { type: 'array', required: true, items: { type: 'string' } },
          poolSize: { type: 'integer', required: true },
          solvedExcluded: { type: 'integer', required: true },
          trainerRating: { type: 'integer', required: true },
          bands: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                band: { type: 'string', required: true },
                anchorRating: { type: 'integer', required: true },
                candidates: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      platform: { type: 'string', required: true },
                      problemId: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      difficulty: { type: 'number', required: true },
                      cfRating: { type: 'integer', required: true },
                      url: { type: 'string', required: true },
                      // （需求 #1）：这道题是不是已经在核实台账里
                      verified: { type: 'boolean', required: true },
                      verifiedAt: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          mapStamp: { type: 'string', required: true },
        },
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 出不了卷：${v.reject}` }]
        const lines = [
          `【题池】${v.nodeName}　[${v.domain}]`,
          `标签匹配：${v.matchKind === 'exact' ? '精确' : '子串'}（${v.matchedTags.join(' / ')}）`,
          `池子里 ${v.poolSize} 道，其中他做过的 ${v.solvedExcluded} 道已剔除` +
          (v.trainerRating ? `　他当前 rating ${v.trainerRating}` : ''),
        ]
        if (v.warnings.length) lines.push('⚠️ ' + v.warnings.join('\n⚠️ '))
        for (const b of v.bands) {
          lines.push('', `── ${b.band}（锚点 ${b.anchorRating}）──`)
          for (const c of b.candidates) {
            // 需求 #1：**题面链接必须印出来**。数据里一直有这一栏，只是没渲染 ——
            // 于是小鲸只能靠标签挑题，挑完才发现「这题其实考的是矩阵加速」。
            // 打开看一眼题面，是唯一能在开卷前核实解法的通道。
            lines.push(`  ${c.problemId}　${c.title}　${c.platform === 'codeforces' ? '' : '难度'}${c.difficulty}${c.platform === 'codeforces' ? '' : `（≈${c.cfRating}）`}　${c.platform}` +
              (c.verified ? `　✓已核实${c.verifiedAt ? ` ${c.verifiedAt}` : ''}` : '') +
              (c.url ? `\n　　　　${c.url}` : '\n　　　　（这题推不出题面链接 —— 开卷前先自己搜一下题号）'))
          }
        }
        // 难度带：只报一个 rating 数字没用 —— 教练要的是"该看哪档"。
        // 依据：能独立解出 30~40% 的题 ≈ 当前 rating +100~200
        // （Dolinsky 2026, Olympiads in Informatics 20 的训练协议）。
        if (v.trainerRating) {
          const lo = v.trainerRating + 100
          const hi = v.trainerRating + 200
          const mid = (lo + hi) / 2
          const inBand = v.bands.filter((b) => b.anchorRating >= lo && b.anchorRating <= hi)
          const nearest = v.bands.reduce((best, b) =>
            Math.abs(b.anchorRating - mid) < Math.abs(best.anchorRating - mid) ? b : best,
          v.bands[0])
          lines.push('', `🎯 难度带：他 rating ${v.trainerRating}，目标 ${lo}~${hi}` +
            '（能独立解出 30~40% 的区间）。' +
            (inBand.length
              ? `落在区间里的是 **${inBand.map((b) => b.band).join('、')}档**。`
              : `没有档正好落进去 —— 最接近的是 **${nearest.band}档（锚点 ${nearest.anchorRating}）**。`) +
            '三档各挑一道，但心里得有数哪档是主力。')
        }
        lines.push('', '从每档挑一道交 coach_test，三档各一道。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const { byId, stamp } = loadMap()
      const node = String(args?.node ?? '').trim()
      const deny = (reject) => ({
        ok: false, reject, node, nodeName: byId.get(node)?.name ?? '',
        domain: byId.get(node)?.domain ?? '', matchKind: '', matchedTags: [],
        poolSize: 0, solvedExcluded: 0, trainerRating: 0, bands: [], warnings: [],
        mapStamp: stamp,
      })

      if (!byId.has(node)) {
        const near = suggest(node, [...byId.values()])
        return deny(`地图里没有「${node}」这个知识点，别自己造。` +
          (near.length ? `相近的有：${near.join(' / ')}` : '先用 coach_status 看他在哪。'))
      }

      let db
      try {
        db = await openDb()
      } catch (err) {
        return deny(`训练库打不开（${err.code || err.message}）—— 出不了卷。`)
      }

      try {
        const uid = trainerId(db)
        if (uid == null) return deny(`训练库里找不到训练员账号（${TRAINER}）。`)

        const m = matchTags(db, node)
        if (m.kind === 'none') {
          return deny(`题库里没有任何题打着「${node}」这个标签 —— 这个点出不了卷。` +
            '别自己报题号凑数：没有标签就没有可信的难度排序，挑出来的卷子测不出东西。' +
            '如实告诉他这个知识点暂时做不了检测。')
        }

        const { hits } = nodePool(db, node)
        // 已核实的题（需求 #1）：**在候选行上标出来** —— 不然教练没法知道
        // 哪几道核实过了，只能靠"试着开卷看放行还是被拒"去反推。
        const ledger = loadProgress().verified_problems ?? {}
        const toRating = ratingFn(db)

        // ⚠️ 走 acSet()，**不要在这里再抄一遍 SQL**。
        // 「他 AC 过哪些题」是挑题的判据，两份实现分家的后果是
        // 同一个知识点在 coach_pool 和别处得到不同的"做过的题"集合。
        const ac = acSet(db, uid)
        const notSolved = hits.filter((r) => !ac.has(`${r.platform}|${normId(r.platform, r.problem_id)}`))

        // 题库表自己也有双命名空间：`NC15121` 和 `15121` 是**同一道题的两行**。
        // 不去重的话池子里会列两遍 —— 而且看起来像两道不同的题，很能骗人。
        // 保留带前缀的那个（题库里的规范写法）。
        const seen = new Map()
        for (const r of notSolved) {
          const k = `${r.platform}|${normId(r.platform, r.problem_id)}`
          const prev = seen.get(k)
          if (!prev || String(r.problem_id).length > String(prev.problem_id).length) seen.set(k, r)
        }
        const fresh = [...seen.values()]
        // 两个数分开算 —— 之前用 `hits - fresh` 会把他做过的题和重复行混成一个数，
        // 报出去就成了"12 道他做过的"，其实只有 9 道。数字撒谎比没有数字更坏。
        const solvedExcluded = hits.length - notSolved.length
        const dupRemoved = notSolved.length - fresh.length

        // 同一份 rating 查询收在 ratingOf 里 —— 这里原来内联了一份一模一样的 SQL
        const trainerRating = ratingOf(db, uid)

        const warnings = []
        if (solvedExcluded) warnings.push(`${solvedExcluded} 道他做过的题已剔除`)
        if (dupRemoved) warnings.push(`${dupRemoved} 行是重复题号（牛客 NC 前缀那套），已并掉`)
        const usable = fresh
          .map((r) => ({ ...r, cfRating: toRating(r.platform, r.difficulty) }))
          .sort((a, b) => a.cfRating - b.cfRating ||
            String(a.problem_id).localeCompare(String(b.problem_id)))
        const noDiff = usable.filter((p) => p.cfRating <= 0).length
        if (noDiff) warnings.push(`${noDiff} 道题没有难度数据，排不了档，跳过了`)
        const ranked = usable.filter((p) => p.cfRating > 0)

        if (ranked.length < BANDS.length) {
          return deny(`「${node}」的池子里只剩 ${ranked.length} 道可用的未做题，` +
            '凑不出 易/中/难 三档 —— 出不了卷。题池太浅的知识点得先攒题，别硬出。')
        }
        if (m.kind === 'substring') {
          warnings.push(`标签是**子串**匹配到的（${m.tags.join(' / ')}），` +
            '不是逐字相同 —— 池子可能比你以为的胖，挑题时看标题别只看难度')
        }

        const pct = (q) => ranked[Math.min(ranked.length - 1,
          Math.floor(q * (ranked.length - 1)))].cfRating
        const raw = [pct(0.25), pct(0.50), pct(0.75)]
        let anchors = raw.slice()
        if (trainerRating > 0) {
          // rating 护栏：易档不该比他还难，难档不该比他还浅。
          // 目的不是"迁就他"，是防止题池整体偏斜时三档压成一档。
          const guarded = [
            Math.min(raw[0], trainerRating + 100),
            raw[1],
            Math.max(raw[2], trainerRating - 100),
          ]
          guarded.forEach((g, i) => {
            if (g !== anchors[i]) warnings.push(`${BANDS[i]}档锚点被 rating 护栏从 ${anchors[i]} 挪到 ${g}`)
          })
          anchors = guarded
        } else {
          warnings.push('训练库里没查到他的 rating，护栏没生效 —— 三档纯按题池分位')
        }
        anchors[1] = Math.max(anchors[1], anchors[0])
        anchors[2] = Math.max(anchors[2], anchors[1])

        // 先把排序好的池子**切成三段**，每段内部再取离锚点最近的几道。
        // 不这么做的话（直接在整池里取最近），题池小的时候第一档会把池子吃光，
        // 后两档空着 —— 而"三档齐全"正是这张卷子的前提。
        const n = ranked.length
        const bands = BANDS.map((band, i) => {
          const lo = Math.floor((i * n) / BANDS.length)
          const hi = Math.floor(((i + 1) * n) / BANDS.length)
          const anchor = anchors[i]
          const cands = ranked.slice(lo, hi)
            .sort((a, b) => Math.abs(a.cfRating - anchor) - Math.abs(b.cfRating - anchor) ||
              String(a.problem_id).localeCompare(String(b.problem_id)))
            .slice(0, POOL_PER_BAND)
          return {
            band, anchorRating: anchor,
            candidates: cands.map((p) => {
              const led = ledger[`${p.platform}|${normId(p.platform, p.problem_id)}`]
              return {
                platform: p.platform, problemId: String(p.problem_id),
                title: String(p.title ?? ''), difficulty: Number(p.difficulty ?? 0),
                cfRating: p.cfRating,
                // 需求 #1：每道题都要有能点开的题面链接（库里 29% 是空的，现推）
                url: problemUrl(p.platform, p.problem_id, p.url),
                // 已经在核实台账里的，标出来 —— 挑的时候就知道不用重核
                verified: Boolean(led?.gist),
                verifiedAt: String(led?.at ?? ''),
              }
            }),
          }
        })

        return {
          ok: true, reject: '', node, nodeName: byId.get(node).name ?? node,
          domain: byId.get(node).domain ?? '', matchKind: m.kind, matchedTags: m.tags,
          poolSize: hits.length, solvedExcluded, trainerRating, bands, warnings,
          mapStamp: stamp,
        }
      } catch (err) {
        return deny(`查题库出错（${err.message}）—— 出不了卷。`)
      } finally {
        try { db.close() } catch { /* 关不掉不影响结果 */ }
      }
    },
  }))

  // ── coach_test：校验 AI 挑的题，开一张卷 ──────────────────────
  //
  // 挡的是**幻觉题号**。正确姿势是先调 coach_pool 拿真实候选再挑，
  // 但"正确姿势"不能靠自觉 —— 得让错的路走不通。
  //
  // 手法跟判因一模一样：那边要求「引用的代码原文必须真在代码里」，
  // 这里要求「题号必须真在题库里，而且他没做过」。查不到就拒绝。
  //
  // 开完卷落盘（PROGRESS.yaml 的 pending）。出卷到判卷中间隔着几十分钟、
  // 甚至跨会话，靠对话上下文记不住 —— 那不是记性问题，是结构问题。
  ctx.tools.register(defineTool({
    name: 'coach_test',
    description:
      '开一张章节检测卷。你**先调 coach_pool** 拿候选池，再从中挑三道：易/中/难 各一道，' +
      '然后把题号交到这里。\n' +
      '工具会核：题号真在题库里吗（挡编造）、他 AC 过没有（不重复喂已经会的题）、' +
      '三档齐不齐。任何一条不过都会被拒绝。\n' +
      '**题池不是只能从 coach_pool 里挑**：你要是上网找到了更贴' +
      '这个知识点的好题，也可以拿来组卷 —— 但每道都得标 `source: "web"`，并写清 `verified`：' +
      '**你看过这题，确认它的实际解法真的用了这个算法**（在哪儿看到的、正解长什么样）。' +
      '题库里的标签是别人打的，会对不上；你自己看过的才算数。\n' +
      '⚠️ **题库里的题（source=pool）同样要 verified**：' +
      '题库标签满足 ≠ 这题只考这个（09-21 给「快速幂」开卷，三题里两道其实是矩阵加速递推，' +
      '而一道都没打开看过）。题面链接在 coach_pool 的输出里，每道题下面那行。' +
      '核实过一次就进台账，同一道题下次再挑到不用重写。\n' +
      '卷子会落盘——他做完回来调 coach_grade 录结果，一次只开一张。',
    parameters: {
      node: { type: 'string', required: true, description: '考哪个知识点，必须在地图里' },
      problems: {
        type: 'array',
        required: true,
        description: '三道题，易/中/难 各一道',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            platform: {
              type: 'string', required: true,
              // 故意不锁 enum：题库里的题由查库挡着（查不到就是查不到），
              // 而网上找的题可能来自任何地方（atcoder / 牛客 / 某个题单……），
              // 锁死三个平台等于把"自己找题"这条路掐掉一半。
              description: '出处：codeforces / luogu / nowcoder / atcoder …（题库里的题必须是前三者）',
            },
            problemId: { type: 'string', required: true, description: '题号，如 P1040 / 1015D / NC15121' },
            band: { type: 'string', required: true, enum: ['易', '中', '难'] },
            // ── 以下四个字段：题库里来的题（默认）不用给 ──
            source: {
              type: 'string', enum: ['pool', 'web'],
              description: '题从哪来。pool=题库（默认，不写就是这个）；web=你上网找的',
            },
            verified: {
              type: 'string',
              description: '**必填**（题库里的题和网上找的题都要）：你核实过的依据 —— ' +
                '这题的实际解法确实用了这个算法，你是在哪儿看到的（题面 / 题解链接 / ' +
                'OI Wiki / 别人的 AC 代码）。写不出依据就别拿它组卷。' +
                '同一道题核实过一次进台账，下次再挑到不用重写。',
            },
            title: { type: 'string', description: 'source=web 时必填：题目标题' },
            url: { type: 'string', description: 'source=web 时必填：题目链接（http 开头）' },
            rating: {
              type: 'number',
              description: 'source=web 时可选：你估的 cf 难度分（分档和权重不看它，' +
                '只写进卷面给你自己复核）',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          totalMinutes: { type: 'integer', required: true },
          passScore: { type: 'integer', required: true },
          maxScore: { type: 'integer', required: true },
          problems: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                problemId: { type: 'string', required: true },
                band: { type: 'string', required: true },
                title: { type: 'string', required: true },
                difficulty: { type: 'number', required: true },
                cfRating: { type: 'integer', required: true },
                url: { type: 'string', required: true },
                weight: { type: 'integer', required: true },
                minutes: { type: 'integer', required: true },
                // 题目来源 + 网上题的核实依据。卷面上要看得见是哪儿来的。
                source: { type: 'string', required: true },
                verified: { type: 'string', required: true },
                // （需求 #1）：核实是不是沿用台账里的旧记录 + 那次的日期
                verifiedReused: { type: 'boolean', required: true },
                verifiedAt: { type: 'string', required: true },
              },
            },
          },
          mapStamp: { type: 'string', required: true },
        },
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 开不了卷：${v.reject}` }]
        const lines = [
          `【检测卷】${v.nodeName}　[${v.domain}]`,
          `限时 ${v.totalMinutes} 分钟 · 通过线 ${v.passScore}/${v.maxScore} 分` +
          `　**独立完成，不看题解、不求助**`,
          '',
        ]
        for (const p of v.problems) {
          // 网上找的题和题库里的题**要一眼分得出来**：前者没有洛谷难度分，
          // cfRating 是小鲸自己估的；后者是库里查出来的真值。
          const hardness = p.source === 'web'
            ? `自报≈${p.cfRating || '没给'}`
            : `难度${p.difficulty}（≈${p.cfRating}）`
          lines.push(`  ${p.band}　${p.problemId}　${p.title}　` +
            `${hardness}　限 ${p.minutes} 分钟　权重 ${p.weight}`)
          lines.push(`　　　　${p.url}`)
          // 需求 #1：**题库里的题也要显示核实** —— 核实是这张卷子的入场券，
          // 卷面上看不见它，就没人知道自己为什么被挡住、也没法复核。
          if (p.source === 'web') lines.push(`　　　　（网上找的 · 核实：${p.verified}）`)
          else if (String(p.verified ?? '').trim().length >= 12) {
            lines.push(`　　　　（已核实${p.verifiedAt ? ` ${p.verifiedAt}` : ''}` +
              `${p.verifiedReused ? '，沿用台账记录' : ''}：${p.verified}）`)
          }
        }
        lines.push('', '做完回来调 coach_grade 录结果（每题 AC 与否 + 花了几分钟）。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const { byId, stamp } = loadMap()
      const node = String(args?.node ?? '').trim()
      const given = Array.isArray(args?.problems) ? args.problems : []
      const deny = (reject) => ({
        ok: false, reject, node, nodeName: byId.get(node)?.name ?? '',
        domain: byId.get(node)?.domain ?? '', totalMinutes: 0,
        passScore: PASS_SCORE, maxScore: 0, problems: [], mapStamp: stamp,
      })

      if (!byId.has(node)) {
        const near = suggest(node, [...byId.values()])
        return deny(`地图里没有「${node}」这个知识点，别自己造。` +
          (near.length ? `相近的有：${near.join(' / ')}` : '先用 coach_status 看他在哪。'))
      }
      if (given.length !== 3) {
        return deny(`卷子是三道题：易 / 中 / 难 各一道。你给了 ${given.length} 道。`)
      }
      const givenBands = given.map((p) => String(p?.band ?? '').trim())
      const missingBand = BANDS.filter((b) => !givenBands.includes(b))
      if (missingBand.length) {
        return deny(`三档必须各一道，缺：${missingBand.join('、')}。` +
          `你现在给的是 ${givenBands.join(' / ')}。`)
      }
      const keys = given.map((p) =>
        `${String(p?.platform ?? '').trim()}|${normId(String(p?.platform ?? '').trim(), String(p?.problemId ?? '').trim())}`)
      if (new Set(keys).size !== keys.length) {
        return deny('同一道题报了不止一遍 —— 三道题得是三道不同的。')
      }

      let db
      try {
        db = await openDb()
      } catch (err) {
        return deny(`训练库打不开（${err.code || err.message}）—— 开不了卷。`)
      }

      try {
        const uid = trainerId(db)
        if (uid == null) return deny(`训练库里找不到训练员账号（${TRAINER}）。`)
        const ac = acSet(db, uid)
        const toRating = ratingFn(db)

        // 进度文件在**挑题之前**就要读：核实台账长在它里面（需求 #1）。
        const prog = loadProgress()

        // 核实的入场券 + 台账（需求 #1）。
        //
        // 「标签满足 ≠ 这题只考这个」—— 09-21 撤卷那次，三题里两道其实考的是
        // 矩阵加速递推，而小鲸一道都没打开看过。原来只有 source=web 要 verified，
        // 题库来的题一路放行：同一个风险两套门槛。现在两条路一个标准。
        //
        // 台账（PROGRESS.yaml 顶层 verified_problems）：**同一道题第二次被挑中
        // 不用重写** —— 核实过的结论还在，别让人做重复劳动。
        const verifyOf = (platform, problemId, writtenRaw) => {
          const written = String(writtenRaw ?? '').trim()
          const key = `${platform}|${normId(platform, problemId)}`
          const prev = prog.verified_problems?.[key]
          if (written.length >= 12) {
            return {
              ok: true, verified: written, key, verifiedReused: false,
              verifiedAt: localStamp(new Date()).slice(0, 10),
            }
          }
          if (prev?.gist) {
            return {
              ok: true, verified: String(prev.gist), key, verifiedReused: true,
              verifiedAt: String(prev.at ?? ''),
            }
          }
          return { ok: false, verified: '', key, verifiedReused: false, verifiedAt: '' }
        }

        const picked = []
        for (const p of given) {
          const platform = String(p?.platform ?? '').trim()
          const asked = String(p?.problemId ?? '').trim()
          const band = String(p.band).trim()

          // ── 网上找的题：题库查不了它，核实的责任在人这边 ────────────
          //
          // 这道闸挡的**不是格式错**，是「标签写着像这个算法、实际解法不是」——
          // 要求：网上找的题必须自己看过、确认正解真的用了
          // 这个算法，才准拿来组卷。所以 verified 不是可选注释，是入场券。
          if (String(p?.source ?? 'pool').trim() === 'web') {
            const vv = verifyOf(platform, asked, p?.verified)
            const title = String(p?.title ?? '').trim()
            const url = String(p?.url ?? '').trim()
            if (!vv.ok) {
              return deny(`「${asked}」标了网上找的，但 verified 写不清（现在 ${String(p?.verified ?? '').trim().length} 字）。` +
                '要写「你在哪儿看到的 + 它的正解用的是什么」—— 标签像不算数，得你真看过。')
            }
            if (!title) return deny(`「${asked}」是网上找的，得带上题目 title —— 卷面上不能只有一个题号。`)
            if (!/^https?:\/\//i.test(url)) {
              return deny(`「${asked}」的 url 得是能打开的链接（http/https 开头），现在是「${url}」。` +
                '他做完要照着它去交题的。')
            }
            const est = Number(p?.rating)
            picked.push({
              platform, problemId: asked, band, title, url,
              // 题库外没有洛谷难度分，也不该由工具猜一个：difficulty 记 0，
              // cfRating 用他自己报的估值（没报就是 0），卷面上按「自报」渲染。
              difficulty: 0,
              cfRating: Number.isFinite(est) ? Math.round(est) : 0,
              source: 'web', verified: vv.verified,
              verifiedReused: vv.verifiedReused, verifiedAt: vv.verifiedAt,
              weight: BAND_WEIGHT[band], minutes: BAND_MINUTES[band],
            })
            continue
          }

          const hit = fetchProblem(db, platform, asked, ac)
          if (!hit.found) {
            return deny(`题库里没有 ${platform} 的「${asked}」这道题 —— 题号是编的？` +
              '先用 coach_pool 拿真实候选再挑，别凭印象报号。')
          }
          if (hit.solved) {
            return deny(`「${hit.problemId}」他已经 AC 过了 —— 挑题前先查 AC 记录，` +
              '不重复喂已经会的题。换一道。')
          }
          // ── 需求 #1：**题库里的题也要 verified** ───────────
          //
          // 这道闸挡的正是 09-21 那次撤卷：标签写着「快速幂」，实际考的是
          // 矩阵加速递推 —— 三题里两道如此，而它们**一道都没被打开看过**。
          // 题面链接现在印在 coach_pool 的输出里，打开看一眼是唯一能在开卷前
          // 核实解法的通道。核实过的题号进台账，下次不用重写。
          const vv = verifyOf(platform, hit.problemId, p?.verified)
          if (!vv.ok) {
            return deny(`「${hit.problemId}」没写 verified —— 题库里的题**同样**要你先打开看过。` +
              '题面链接在 coach_pool 的候选里（每道题下面那行）。' +
              '写清「这题的实际解法确实用了这个算法」的依据（题面/题解里哪句）。' +
              '**标签满足 ≠ 这题只考这个** —— 09-21 那三题就是这么废的。' +
              '（同一道题核实过一次就进台账，下次再挑到不用重写。）')
          }
          picked.push({
            platform, problemId: hit.problemId, band,
            title: hit.title, difficulty: hit.difficulty,
            cfRating: toRating(platform, hit.difficulty), url: hit.url,
            source: 'pool', verified: vv.verified,
            verifiedReused: vv.verifiedReused, verifiedAt: vv.verifiedAt,
            weight: BAND_WEIGHT[band], minutes: BAND_MINUTES[band],
          })
        }
        picked.sort((a, b) => BANDS.indexOf(a.band) - BANDS.indexOf(b.band))

        // ── 前置闸：**这块他学过没有**（需求 #5）──────────────
        //
        // 09-21 撤卷的根因：17:35 刚讲完「矩阵加速递推」→ 18:00 就能给它开卷，
        // 因为这里原来只挡「他 AC 过没有」，不挡「这块他还没被讲过」。
        //
        // ⚠️ **必须排在题的那些校验后面。** 第一版我放在最前面（跟"地图里没
        // 这个节点"并列），结果"题号是编的""他已经 AC 过""三档不齐"这些**更具体、
        // 更好改**的错全被它一句话盖住 —— 26 条反向测试当场翻红。
        // 这个文件自己的规矩就是「题本身有问题的话先说题的问题（那更好改）」，
        // 节点级的前提不该抢在它前面。放这儿 = 题都对、卷子本来能成，才轮到问
        // "这节点学过吗"。
        if (!taughtEvidence(prog, node)) {
          return deny(`该节点尚无教学记录，先讲再开卷 —— 「${byId.get(node)?.name ?? node}」` +
            '在进度文件里一条痕迹都没有（没标过在学、没打过卡、没判过卷）。' +
            '检测是**验**学过的东西，不是**筛**没学过的。' +
            '先讲过（coach_mark 标在学）再回来开卷。')
        }

        // 一次只开一张。同时押两张，判卷时就不知道该判哪张。
        // 放最后检查：题本身有问题的话，先说题的问题（那更好改）。
        if (prog.pending) {
          return deny(`上一张卷还没判（${prog.pending.node} · ${prog.pending.date}）—— ` +
            '先调 coach_grade 把它判了。一次只开一张。')
        }

        const totalMinutes = picked.reduce((s, p) => s + p.minutes, 0)
        const maxScore = picked.reduce((s, p) => s + p.weight, 0)
        // 核实台账落盘（需求 #1）。写在 PROGRESS.yaml 顶层 —— 复用它的原子写
        // 和「唯一写入者」，**不新开一个 YAML**：多一个文件就是多一处
        // 会和进度分家的真相。和 pending 一起写，一次原子落盘。
        const led = { ...(prog.verified_problems ?? {}) }
        for (const x of picked) {
          if (String(x.verified ?? '').trim().length < 12) continue
          const k = `${x.platform}|${normId(x.platform, x.problemId)}`
          if (led[k]?.gist === x.verified) continue      // 同样的结论别覆盖掉原日期
          led[k] = { at: localStamp(new Date()).slice(0, 10), gist: x.verified, node }
        }
        if (Object.keys(led).length) prog.verified_problems = led
        prog.pending = {
          node, date: localStamp(new Date()).slice(0, 10), at: localStamp(new Date()),
          totalMinutes, passScore: PASS_SCORE, maxScore,
          // 存**整份**题目信息，不只是题号。这样判卷时不必再连数据库 ——
          // 判卷只该依赖卷子本身，库搬了、锁了都不该让判卷失败。
          problems: picked,
        }
        saveProgress(prog)

        return {
          ok: true, reject: '', node, nodeName: byId.get(node).name ?? node,
          domain: byId.get(node).domain ?? '', totalMinutes,
          passScore: PASS_SCORE, maxScore, problems: picked, mapStamp: stamp,
        }
      } catch (err) {
        return deny(`开卷出错（${err.message}）。`)
      } finally {
        try { db.close() } catch { /* 关不掉不影响结果 */ }
      }
    },
  }))

  // ── coach_verify：把「这道我核实过了」写进台账 ──────────────────
  //
  // 这条通道是后加的。台账原先只有两条进去的路：
  // ① 开卷时在卷面写 verified；② 沿用已有记录。于是**核实过一道题、还没开卷**
  // 的时候它手上没有写入口 —— 只能为了记一条核实去开一张卷。
  // 「写台账」和「开卷」被绑在一起了，而这是两件事。
  // （真实处境：09-21 逐个核过的 P9032 / P2216 / P4085，卷面有据，台账里没有。）
  //
  // 手法和别处一样：**核实的证据要能被工具看见**，不能自己说了算。
  //   · 抓得到页面标题 + 和题库标题对得上 → how='auto'，落账
  //   · 抓得到页面标题但**对不上** → 拒绝。照着一条错的链接"核实"等于
  //     给错题打勾，比没有链接更坏（没有链接它还会去别的路查）
  //   · **抓不到**（站点挡 IP / 要 cookie / 超时）→ 不拒。那是"这条路我走不通"，
  //     不是"这题没核实过"。允许附自己的 gist 落账，但记 how='manual'
  //     —— 自报与自动核对**分开存**，以后读账的人知道每条可信到什么程度。
  ctx.tools.register(defineTool({
    name: 'coach_verify',
    description:
      '把「这道题我核实过正解」写进核实台账 —— **不用开卷**就能记。\n' +
      '默认会抓一次题面页、把页面标题和题库标题对一遍（对不上说明链接指的不是这道题，' +
      '会拒）。要是站点抓不到（挡 IP / 要 cookie / 超时），**不拒** —— ' +
      '你附上自己的核实 gist 就落账，只是台账里会记成「自报」。\n' +
      'gist 要写清**你在哪儿看到的、正解用的是什么**（≥12 字）。写过的题进台账，' +
      '以后 coach_test 再挑到它不用重写依据。',
    parameters: {
      problems: {
        type: 'array', required: true,
        description: '核实哪几道（可以一次多道）',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            platform: { type: 'string', required: true, description: 'codeforces / luogu / nowcoder / atcoder …' },
            problemId: { type: 'string', required: true, description: '题号，如 P2880 / 14607 / 1548B' },
            gist: {
              type: 'string', required: true,
              description: '核实依据：你在哪儿看到的、这题的正解用的是什么（≥12 字）',
            },
            node: { type: 'string', description: '这题是为哪个知识点核实的（可选，默认用当前游标）' },
          },
        },
      },
      check: {
        type: 'boolean',
        description: '默认 true = 抓页面标题核对一遍。false = 不起网络、直接按自报落账' +
          '（你已知这个站点抓不到时用）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          recorded: { type: 'integer', required: true },
          autoChecked: { type: 'integer', required: true },
          manualRecorded: { type: 'integer', required: true },
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                problemId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                how: { type: 'string', required: true },     // auto | manual
                warn: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
          },
          ledgerTotal: { type: 'integer', required: true },
          mapStamp: { type: 'string', required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 记不上：${v.reject}` }]
        const lines = [
          `✓ 核实台账记下 ${v.recorded} 道` +
          `（自动核对 ${v.autoChecked} / 自报 ${v.manualRecorded}）。`,
        ]
        for (const e of v.entries) {
          lines.push(`  ${e.how === 'auto' ? '✓ 已核对' : '· 自报'}  ${e.platform} ${e.problemId}` +
            `${e.title ? `　${e.title}` : ''}`)
          if (e.warn) lines.push(`　　　⚠️ ${e.warn}`)
        }
        lines.push('', `台账里现在 ${v.ledgerTotal} 道题。以后 coach_test 挑到它们不用再写依据。`)
        if (v.manualRecorded) {
          lines.push('⚠️ 「自报」那几条**没被抓到的页面标题印证过** —— ' +
            '是你自己的判断，不是工具核的。下次页面能抓到时会自动升成「已核对」。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const { byId, stamp } = loadMap()
      const given = Array.isArray(args?.problems) ? args.problems : []
      const doCheck = args?.check !== false
      const deny = (reject) => ({
        ok: false, reject, recorded: 0, autoChecked: 0, manualRecorded: 0,
        entries: [], ledgerTotal: 0, mapStamp: stamp,
      })
      if (!given.length) return deny('problems 是空的 —— 要核实哪几道？')

      let db = null
      try { db = await openDb() } catch { /* 题库打不开：还能落账，只是没标题可比 */ }

      try {
        const prog = loadProgress()
        const led = { ...(prog.verified_problems ?? {}) }
        const cursor = String(prog.cursor ?? '')
        const entries = []

        for (const p of given) {
          const platform = String(p?.platform ?? '').trim()
          const asked = String(p?.problemId ?? '').trim()
          const gist = String(p?.gist ?? '').trim()
          const nodeWanted = String(p?.node ?? '').trim() || cursor
          if (!platform || !asked) return deny('每道题都要给 platform 和 problemId。')
          if (gist.length < 12) {
            return deny(`「${asked}」的 gist 写不清（现在 ${gist.length} 字）—— ` +
              '要写「你在哪儿看到的 + 正解用的是什么」。写不出依据就别记进来，' +
              '台账里躺一条空依据比没有更坏。')
          }
          // 题号必须真在题库里（挡编造）—— 和 coach_test 同一套查法，
          // 牛客的双命名空间也在这里归一。
          const hit = db ? fetchProblem(db, platform, asked, new Set()) : { found: false }
          if (db && !hit.found) {
            return deny(`题库里没有 ${platform} 的「${asked}」—— 题号是编的？` +
              '先 coach_pool 拿真实候选，或核对一下写法。')
          }
          const canonical = hit.found ? hit.problemId : asked
          const key = `${platform}|${normId(platform, canonical)}`
          const url = hit.found ? hit.url : problemUrl(platform, canonical, '')
          const title = hit.found ? hit.title : ''

          let how = 'manual'
          let warn = ''
          if (doCheck && url) {
            const pg = await pageTitle(url)
            if (!pg.ok) {
              // 抓不到**不是**拒绝的理由 —— 那只是这条路走不通
              warn = `没抓成页面标题（${pg.why}）—— 链接是推的，这条按你的自报记。`
            } else {
              const m = titleMatches(title, pg.title)
              if (m === false) {
                return deny(`「${canonical}」的链接对不上：数据库里叫「${title}」，` +
                  `打开是「${pg.title}」。**这链接指的不是这道题**，照着它核实等于给错题打勾。` +
                  `别改台账，先去核一遍题号。（链接：${url}）`)
              }
              if (m === true) how = 'auto'
              else warn = `页面标题「${pg.title}」和题库标题「${title}」都太短，判不了对错。`
            }
          } else if (doCheck && !url) {
            warn = '这题推不出题面链接（题库里也没存），没法自动核对 —— 按你的自报记。'
          } else if (!doCheck) {
            warn = '这次没起网络核对（check=false），按你的自报记。'
          }

          const prev = led[key]
          // 一样的结论别覆盖掉原日期：那条记录是"什么时候核的"，值钱。
          // 但**自报升成已核对**要覆盖 —— 那是信息变多了。
          const upgraded = prev?.how === 'manual' && how === 'auto'
          if (prev?.gist === gist && !upgraded) {
            entries.push({ key, platform, problemId: canonical, title,
              how: prev.how ?? how, warn: '（台账里已经有这条，没动）', at: String(prev.at ?? '') })
            continue
          }
          const at = localStamp(new Date()).slice(0, 10)
          led[key] = { at, gist, node: nodeWanted, how, ...(title ? { title } : {}) }
          entries.push({ key, platform, problemId: canonical, title, how, warn, at })
        }

        prog.verified_problems = led
        saveProgress(prog)
        return {
          ok: true, reject: '', recorded: entries.length,
          autoChecked: entries.filter((e) => e.how === 'auto').length,
          manualRecorded: entries.filter((e) => e.how === 'manual').length,
          entries, ledgerTotal: Object.keys(led).length, mapStamp: stamp,
        }
      } catch (err) {
        return deny(`记台账出错（${err.message}）。`)
      } finally {
        try { db?.close() } catch { /* 关不掉不影响结果 */ }
      }
    },
  }))

  // ── coach_grade：判卷 ────────────────────────────────────────
  //
  // 检测闭环的收口。**「掌握」由检测决定，不由数据推断** —— 所以过了要写进
  // verified：那是 verified 这一级的定义，不是顺手加的装饰。
  //
  // 三种结局**不能合并**：
  //   passed   分够 + 没超时 → 真过了，标 verified，可以推进
  //   overTime 分够 + 超时   → **不算过**。这是「不熟」的机械形态：
  //                            方法他有，就是慢。去向是加练，不是推进。
  //   failed   分不够         → 不过，交 coach_diagnose 判因
  //
  // 只依赖卷子本身（pending 里存了整份题目信息），不连数据库 ——
  // 判卷不该因为库被搬走或者锁了就失败。
  ctx.tools.register(defineTool({
    name: 'coach_grade',
    description:
      '给正押着的那张检测卷判卷。他做完回来了，你收三样：每题 AC 没有、花了几分钟。\n' +
      '判定：难易加权（易1/中2/难3，满分 6），**通过线 4 分且总用时不超过限时**。\n' +
      '分够但超时 → 判「不熟」不算过（方法有，就是慢）；分不够 → 不过。\n' +
      '过了会自动把知识点标成「已验证」—— 那是 verified 的定义。\n' +
      '判完给出下一步：过了就推进，不过就调 coach_diagnose 判因。',
    parameters: {
      results: {
        type: 'array',
        required: true,
        description: '卷子上每道题一条，一道都不能少',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            problemId: { type: 'string', required: true, description: '卷子里的题号，原样抄' },
            solved: { type: 'boolean', required: true, description: '这题最后 AC 了吗' },
            minutes: { type: 'number', required: true, description: '这题花了多少分钟（没做出来就填实际耗掉的）' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          score: { type: 'integer', required: true },
          maxScore: { type: 'integer', required: true },
          passScore: { type: 'integer', required: true },
          minutes: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          status: { type: 'string', required: true },
          verifiedAt: { type: 'integer', required: true },
          // 这张卷里有几道是「网上找的」（自述题）。>0 时这条 verified 的
          // 成色就要打折 —— 卷面上看得见，记录里也留痕。
          selfReported: { type: 'integer', required: true },
          problems: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                problemId: { type: 'string', required: true },
                band: { type: 'string', required: true },
                title: { type: 'string', required: true },
                weight: { type: 'integer', required: true },
                cfRating: { type: 'integer', required: true },
                solved: { type: 'boolean', required: true },
                minutes: { type: 'integer', required: true },
                // 网上找的题的 cfRating 是自报估值 —— 不计入 verifiedAt（见上面的
                // solvedRatings 过滤）。来源得跟着结果走，不然判卷记录里分不出
                // 这道题是库里查的还是他自己找的。**schema 得声明它** ——
                // 加字段忘声明就是 additionalProperties 拒收（这行是扫描器抓出来的）。
                source: { type: 'string', required: true },
              },
            },
          },
          checks: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 判不了：${v.reject}` }]
        const head = v.outcome === 'passed'
          ? `✅ 过了　${v.nodeName}`
          : v.outcome === 'overTime'
            ? `⏱ 分数够，但超时了 —— 这不算过　${v.nodeName}`
            : `❌ 没过　${v.nodeName}`
        const lines = [
          head,
          `得分 ${v.score}/${v.maxScore}（通过线 ${v.passScore}）· ` +
          `用时 ${v.minutes}/${v.limit} 分钟 · 累计检测 ${v.checks} 次`,
          // 自述题要说在**结论旁边**，不能只躺在记录里：这张卷的证据强度
          // 直接影响这条 verified 值不值钱，而"过了"这两个字会盖过一切。
          ...(v.selfReported
            ? [`⚠️ 其中 ${v.selfReported} 道是**网上找的**：题号没进过题库、难度是估的、` +
               '「做出来了」也只有他这句话。它不算进验证段位 —— 这条 verified 的成色比真题卷低，' +
               '想坐实这个知识点，下次用题库里的题再测一次。']
            : []),
          '',
        ]
        for (const p of v.problems) {
          lines.push(`  ${p.solved ? '✓' : '✗'} ${p.band}　${p.problemId}　${p.title}　` +
            `${p.minutes} 分钟（权重 ${p.weight}）`)
        }
        lines.push('', '── 下一步 ──')
        if (v.outcome === 'passed') {
          lines.push(`  这一节标成「已验证」了 —— 验证于 ≈${v.verifiedAt} 段位。` +
            '（等他 rating 涨上去，这个段位的题也会变难，到时候该复检）')
          const course = curriculum.execute({ action: 'read' })
          lines.push(course.exists || !course.ok
            ? '  先读 coach_curriculum 检查当前阶段验收；单点过卷不会自动推进阶段。继续当前主线，整体成果达标后再 advance。'
            : '  用 coach_assign 布置下一节 —— **推进，别回头**。')
        } else if (v.outcome === 'overTime') {
          lines.push('  他不是不会，是慢。别推进，也别当「不会」去补课 —— ' +
            '换个同难度的题限时加练，把速度压进限时里。')
        } else {
          lines.push('  让他把没做出来的那题代码贴过来，调 coach_diagnose 判因 —— ' +
            '分清是「不会」还是「不认真」，再决定补课还是重写。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const { byId } = loadMap()
      const given = Array.isArray(args?.results) ? args.results : []
      const deny = (reject) => ({
        ok: false, reject, node: '', nodeName: '', domain: '',
        outcome: '', score: 0, maxScore: 0, passScore: PASS_SCORE,
        minutes: 0, limit: 0, status: '', verifiedAt: 0, problems: [], checks: 0,
      })

      const prog = loadProgress()
      if (!prog.pending) {
        return deny('手里没押着卷子 —— 没卷子可判。要检测就先调 coach_test 开一张。')
      }
      const p = prog.pending
      const paper = Array.isArray(p.problems) ? p.problems : []
      if (given.length !== paper.length) {
        return deny(`卷子是 ${paper.length} 道题，你给了 ${given.length} 条结果 —— ` +
          '一道都不能少（没做出来的也要报，solved 填 false）。')
      }

      // 判卷比对题号：**一律按 nowcoder 归一**，也就是剥掉 NC 前缀。
      //
      // 为什么平台在这条路上传不进来：卷子里 platform 是逐题字段，而结果数组
      // 只有 problemId —— 没地方放平台。原来传的是空串（等于不归一），于是
      // 卷子存的是题库的规范写法 `NC15121`，小鲸报裸号 `15121` 就撞不上，
      // 判成「卷子里没有这条结果」。**判卷是闭环最后一步，错在这整张卷的记录就没了。**
      // 一律剥是安全的：其它平台没有 NC 开头的题号（CF 是数字+字母，洛谷是字母+数字）。
      const keyOf = (id) => normId('nowcoder', String(id ?? '').trim())
      const byIdGiven = new Map()
      for (const r of given) {
        const key = keyOf(r?.problemId)
        if (byIdGiven.has(key)) return deny(`题号 ${r.problemId} 报了两遍。`)
        byIdGiven.set(key, r)
      }

      let score = 0
      let minutes = 0
      const graded = []
      for (const q of paper) {
        const key = keyOf(q.problemId)
        const r = byIdGiven.get(key)
        if (!r) {
          return deny(`卷子里没有「${q.problemId}」这条结果 —— ` +
            `卷子上的题是：${paper.map((x) => x.problemId).join('、')}。`)
        }
        const solved = r.solved === true
        const spent = Math.max(0, Math.round(Number(r.minutes) || 0))
        if (solved) score += Number(q.weight) || 0
        minutes += spent
        graded.push({
          problemId: String(q.problemId), band: String(q.band),
          title: String(q.title ?? ''), weight: Number(q.weight) || 0,
          // 来源要跟着结果走：verifiedAt 只认真库里的难度（见下面 solvedRatings）。
          source: String(q.source ?? 'pool'),
          // cfRating 必须带上：**不留它，"在什么段位验证过"就算不出来**。
          // 老卷子可能没有（那批 pending 是在加这个字段之前开的），兜底 0。
          cfRating: Math.round(Number(q.cfRating) || 0),
          solved, minutes: spent,
        })
      }

      const limit = Number(p.totalMinutes) || 0
      const passScore = Number(p.passScore) || PASS_SCORE
      const maxScore = Number(p.maxScore) || graded.reduce((s, x) => s + x.weight, 0)
      // 超时和分数不够是**两种病**：前者是不熟，后者是不会。
      const outcome = score < passScore ? 'failed'
        : (limit > 0 && minutes > limit) ? 'overTime' : 'passed'

      const node = String(p.node ?? '')
      const status = outcome === 'passed' ? 'verified'
        : nodeStatus(prog, node) === 'none' ? 'studying' : nodeStatus(prog, node)

      // 「验证于哪个段位」= 他拿下的题里 cfRating 最高的那个。
      // 含义是"他证明过的上限"。没过就是 0 —— 没证明过任何段位。
      //
      // 为什么非要有这个数：「1600 分时验证过」不等于「2000 分还掌握」。
      // 同一道区间 DP，低分段考入门转移，高分段考四边形不等式优化 ——
      // 知识点没变，考法随分段变。有了这个数，他 rating 涨上去之后
      // 教练才能自己看出"这条 verified 该复检了"，不用人来提醒。
      // 网上找的题**不进这个数**：它的 cfRating 是小鲸自己估的，不是库里的真值，
      // 混进来等于让估值冒充"他证明过的段位"（加 web 题通道时定的）。
      const solvedRatings = graded
        .filter((g) => g.solved && g.source !== 'web')
        .map((g) => g.cfRating).filter((r) => r > 0)
      const verifiedAt = outcome === 'passed' && solvedRatings.length
        ? Math.max(...solvedRatings) : 0

      // 自述题计数。
      //
      // source=web 的题**没有题库背书**：题号查不到、难度是小鲸自己估的、
      // 「他做出来了」也只有这句话本身。它进卷子就等于这张卷有一部分的证据
      // 来自自述 —— 这事本身不是错（这是刻意开的一条路），
      // 错的是**记录里看不出来**：过两个月翻 checks，一张全自述的卷和一张
      // 全是真题的卷长得一模一样，而只有后者能当"他证明过这个水平"。
      // 标出来，事后才分得出该信多少。
      const selfReported = graded.filter((g) => g.source === 'web').length

      const nodeRec = { ...(prog.nodes[node] ?? {}) }
      const checks = Array.isArray(nodeRec.checks) ? nodeRec.checks : []
      checks.push({
        date: localStamp(new Date()).slice(0, 10),
        outcome, score, maxScore, passScore,
        minutes, limit, verifiedAt, selfReported, problems: graded,
      })
      nodeRec.checks = checks
      // 过 → verified（这是那一级的定义）。不过**不降级**已有的 learned/verified，
      // 但若本来就没学过，标成「在学」—— 他显然正在这上面花时间。
      const prevStatus = nodeStatus(prog, node)
      nodeRec.status = status
      // ⚠️ 修过：这条路**以前没写 `at`**。
      // `at` 的语义是「什么时候变成这个状态的」，而 verified 恰恰是**最该有日期的那一跳** ——
      // 没有它就答不出「他多久没验过这个了」，而那正是"要不要复检"的唯一依据。
      // 真实数据里就躺着证据：`排序` 是 verified，但整条记录没有 at。
      // 老记录补不回来，读的时候退到「最后一次判过的日期」（见 statusSince）。
      // 和 markStatus 同一条规矩：**只在状态真的变了时才更新**，重复判不刷新日期。
      if (prevStatus !== status || !nodeRec.at) {
        nodeRec.at = localStamp(new Date()).slice(0, 10)
      }
      prog.nodes[node] = nodeRec
      prog.pending = null
      saveProgress(prog)

      return {
        ok: true, reject: '', node, nodeName: byId.get(node)?.name ?? node,
        domain: byId.get(node)?.domain ?? '', outcome, score, maxScore, passScore,
        minutes, limit, status, verifiedAt, selfReported,
        problems: graded, checks: checks.length,
      }
    },
  }))

  // ── coach_cancel：撤卷（他开了卷，但没做）─────────────────────
  //
  // 后补的。在这之前 pending **没有出口**：清掉它的代码全项目只有一处，
  // 在 coach_grade 判完卷那里；而 coach_test 只要看到 pending 非空就拒绝开新卷。
  //
  // 于是「他开了卷、然后说今天不做了」这条路上，小鲸唯一的出路是**编三条成绩
  // 喂给判卷** —— 而那条路会把一条假的 verified 写进真相源。
  // 这不是"卡住"这么温和，它是把模型往造证据那条路上推。
  //
  // 两个设计决定：
  //   ① **独立工具，不塞进 coach_grade 的参数**。判卷 = 他做了、报结果；
  //      撤卷 = 他没做。一个入口两件事的话，小鲸迟早会拿"撤卷"躲开一次
  //      难看的判卷结果 —— 而那次判卷恰恰是最该留下的一条数据。
  //   ② **撤不是删**：往 checks 里落一条 outcome=abandoned。
  //      「开了卷没做」本身就是信号（卷子出难了？那天没时间？），
  //      抹掉它等于把一条证据洗掉，而且洗得无声无息。
  ctx.tools.register(defineTool({
    name: 'coach_cancel',
    description:
      '撤掉手上正押着的那张检测卷 —— **只有他说「不做了 / 今天没时间 / 换个时间」时才用**。\n' +
      '⚠️ 他做了、但考得不好，**一律走 coach_grade**（哪怕三题全错也要判）。' +
      '撤卷会把"他没做"记进台账，判卷会把"他没过"记进台账 —— 把没过说成没做，' +
      '等于把一条真数据换成一条假数据。\n' +
      '撤完知识点状态**不动**（不升也不降）：没做检测不代表没学，也不代表学了。',
    parameters: {
      reason: {
        type: 'string', required: true,
        description: '为什么撤（一句话，进台账）。不知道原因就先问他 —— ' +
          '「开了卷没做」这件事的原因本身有价值（是没时间？还是卷子出难了？）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          domain: { type: 'string', required: true },
          date: { type: 'string', required: true },
          problems: { type: 'integer', required: true },
          reason: { type: 'string', required: true },
          checks: { type: 'integer', required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 撤不了：${v.reject}` }]
        return [{
          type: 'text',
          text: `🗑 卷子撤了：${v.nodeName}（${v.date} 开的那张，${v.problems} 道）\n` +
            `原因记下了：${v.reason}\n` +
            `这个知识点的状态**没动** —— 没做检测不等于没学。累计检测记录 ${v.checks} 条。\n` +
            `\n` +
            `现在可以用 coach_test 开新卷了。**撤完先别急着开** —— ` +
            `如果他是"没时间"，先去 coach_schedule 看看哪天有空；` +
            `如果他是"不想做"，那得先聊清楚，别硬塞一张新的。`,
        }]
      },
    },
    async execute(args) {
      const { byId } = loadMap()
      const reason = String(args?.reason ?? '').trim()
      const deny = (reject) => ({
        ok: false, reject, node: '', nodeName: '', domain: '',
        date: '', problems: 0, reason: '', checks: 0,
      })

      // 撤卷要写理由。没理由的撤 = 随手把一张卷抹掉，
      // 而"为什么没做"正是这件事里唯一有价值的部分。
      if (!reason) {
        return deny('没说为什么撤。先问他一句 —— 「开了卷没做」的原因本身有价值' +
          '（是没时间、还是卷子出难了），记下来下次排的时候有用。')
      }

      const prog = loadProgress()
      if (!prog.pending) {
        return deny('手里没押着卷子，没什么可撤的。要开卷就 coach_test。')
      }
      const p = prog.pending
      const node = String(p.node ?? '')
      const paper = Array.isArray(p.problems) ? p.problems : []
      const name = byId.get(node)?.name ?? node

      const nodeRec = { ...(prog.nodes[node] ?? {}) }
      const checks = Array.isArray(nodeRec.checks) ? nodeRec.checks : []
      const now = localStamp(new Date())
      checks.push({
        date: now.slice(0, 10),
        outcome: 'abandoned',
        score: 0,
        maxScore: Number(p.maxScore ?? 0),
        passScore: Number(p.passScore ?? 0),
        minutes: 0,
        limit: Number(p.totalMinutes ?? 0),
        verifiedAt: 0,
        // 自述题数照旧算：撤卷的台账也得和判卷的长一个形状，
        // 否则读历史的人要多记一套规则
        selfReported: paper.filter((x) => String(x?.source ?? 'pool') === 'web').length,
        reason,
        // 题目原样带过来：撤卷之后卷面就没了，只留一行"某天撤了一张卷"
        // 的话，事后想看他当时被安排的是哪几道题就没处查了。
        problems: paper.map((x) => ({
          problemId: String(x?.problemId ?? ''), band: String(x?.band ?? ''),
          title: String(x?.title ?? ''), weight: Number(x?.weight) || 0,
          cfRating: Math.round(Number(x?.cfRating) || 0),
          solved: false, minutes: 0, source: String(x?.source ?? 'pool'),
        })),
      })
      nodeRec.checks = checks
      // ⚠️ **不碰 status**。撤卷不改变"他学到哪了"这个判断。
      prog.nodes[node] = nodeRec
      prog.pending = null
      saveProgress(prog)

      return {
        ok: true, reject: '', node, nodeName: name,
        domain: byId.get(node)?.domain ?? '',
        date: String(p.date ?? ''), problems: paper.length,
        reason, checks: checks.length,
      }
    },
  }))

  // ── coach_unassign：撤掉押着的训练动作（需求 #6 的出口）─────────────
  //
  // 为什么单开一个工具、不并进 coach_cancel：撤卷 = "他开了卷没做"，
  // 撤动作 = "布置了他没动"，是两件事。coach_cancel 自己的设计注释写着
  // 「一个入口两件事，迟早会拿一个去躲另一个」—— 同一条理由在这儿也成立。
  //
  // ⚠️ **不碰知识点状态**：撤动作不等于没学，也不等于学了（自评 ≠ 掌握）。
  // ⚠️ 也别拿它躲一次难看的落地：他做了就该走 coach_log —— 那条路会记下
  //    「独立没独立」，是这套系统里最硬的一条掌握证据。
  ctx.tools.register(defineTool({
    name: 'coach_unassign',
    description:
      '撤掉**押着的训练动作**（coach_assign 布置的、他还没做的）。' +
      '只有他说「这个先不做了 / 换个方向」时才用。\n' +
      '⚠️ 他**做了** → 走 coach_log（那条路会自动把押着的销掉），' +
      '不要为了销一条动作去编一条做完记录。',
    parameters: {
      node: {
        type: 'string',
        description: '撤哪个节点的动作。不填 = 手上只有一条时撤那条；有多条会被拒绝并列出来。',
      },
      reason: { type: 'string', description: '为什么撤（一句话，回显用）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          at: { type: 'string', required: true },
          deliverable: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          remaining: { type: 'integer', required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 撤不了：${v.reject}` }]
        return [{
          type: 'text',
          text: `🗑 动作撤了：${v.nodeName}（${v.at} 押的，交付物「${v.deliverable}」）\n` +
            (v.reason ? `原因记下了：${v.reason}\n` : '') +
            `这个知识点的状态**没动** —— 撤动作不等于没学。` +
            (v.remaining ? `手上还剩 ${v.remaining} 个押着的动作。` : '手上没有别的押着的动作了。'),
        }]
      },
    },
    async execute(args) {
      const { byId } = loadMap()
      const reason = String(args?.reason ?? '').trim()
      const deny = (reject) => ({
        ok: false, reject, node: '', nodeName: '', at: '', deliverable: '',
        reason: '', remaining: 0,
      })

      const prog = loadProgress()
      const pend = { ...(prog.pendingActions ?? {}) }
      let node = String(args?.node ?? '').trim()
      if (!node) {
        const keys = Object.keys(pend)
        if (!keys.length) {
          return deny('手上没有押着的动作，没什么可撤的。要布置走 coach_assign。')
        }
        if (keys.length > 1) {
          return deny(`手上有 ${keys.length} 个押着的动作，得说清撤哪个：` +
            keys.map((k) => `${byId.get(k)?.name ?? k}（${String(pend[k]?.at ?? '')}）`).join(' / '))
        }
        node = keys[0]
      }
      if (!Object.prototype.hasOwnProperty.call(pend, node)) {
        return deny(`「${byId.get(node)?.name ?? node}」上没有押着的动作 —— ` +
          '可能已经落地（coach_log 销的），或者被撤过了。')
      }
      const a = pend[node]
      delete pend[node]
      prog.pendingActions = pend
      try {
        saveProgress(prog)
      } catch (err) {
        return deny(`写盘失败：${err.message} —— 动作还押着，别当它撤了。`)
      }
      return {
        ok: true, reject: '', node, nodeName: byId.get(node)?.name ?? node,
        at: String(a?.at ?? ''), deliverable: String(a?.deliverable ?? ''),
        reason, remaining: Object.keys(pend).length,
      }
    },
  }))

  // ── 日程 ────────────────────────────────────────────────────────
  //
  // 排块是**教练的活**。页面上只给他标 busy 的口子（他标「我什么时候有事」），
  // planned 只能从 coach_plan 进来 —— 这两个工具就是教练的手。
  // 缺了它，教练看得到知识点却看不到时间，排程就只能靠人代劳，
  // 而人代劳的那一刻，这套东西就不再是"教练"了。
  ctx.tools.register(defineTool({
    name: 'coach_schedule',
    description:
      '看他这几天**到底有多少时间能用来训练**。给的是**整张表**：' +
      '一天一天，把他标的忙事和已经排好的块按时间列成一条轴。\n' +
      '**不给「还剩多少小时」这种汇总数** —— 排多少是你的判断，' +
      '工具只把事实摆开：你照着这条轴自己看哪段能塞、哪两件事之间只有 30 分钟放不下块。\n' +
      '排块之前先调这个，不要凭印象说「你今晚有两小时」，他的时间每天都在变。',
    parameters: {
      days: { type: 'integer', description: `看几天，默认 ${SCHED_WINDOW}（今天-3 ~ 今天+6）` },
      from: { type: 'string', description: '从哪天开始，YYYY-MM-DD，默认今天-3（回顾期开头）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          today: { type: 'string', required: true },
          windowFrom: { type: 'string', required: true },
          windowTo: { type: 'string', required: true },
          planTo: { type: 'string', required: true },
          blockKinds: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                minutes: { type: 'integer', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          days: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                weekday: { type: 'string', required: true },
                state: { type: 'string', required: true },
                plannable: { type: 'boolean', required: true },
                busy: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      from: { type: 'string', required: true },
                      to: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                    },
                  },
                },
                // 只给整张表（忙事 + 已排的块），不给「还剩多少时间」的汇总。
                planned: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      from: { type: 'string', required: true },
                      to: { type: 'string', required: true },
                      minutes: { type: 'integer', required: true },
                      kind: { type: 'string', required: true },
                      kindName: { type: 'string', required: true },
                      node: { type: 'string', required: true },
                      nodeName: { type: 'string', required: true },
                    },
                  },
                },
                planMin: { type: 'integer', required: true },
                actual: {
                  type: 'array', required: true,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      node: { type: 'string', required: true },
                      plannedMin: { type: 'integer', required: true },
                      actualMin: { type: 'integer', required: true },
                      solved: { type: 'boolean', required: true },
                      independent: { type: 'boolean', required: true },
                      // 可选（coach_log 带 note 时才写）。不写 required —— 可选键
                      // 在 dsh 那套里就是"不写 required"，写 required:false 会抛。
                      note: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          // 火候：**排课时一定看得见**，不依赖"它记得去查 coach_status"。
          // 见 readinessOf 的注释 —— 只报事实，不报裁决，也不写阈值。
          readiness: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                status: { type: 'string', required: true },
                since: { type: 'string', required: true },
                days: { type: 'integer', required: true },
                passTotal: { type: 'integer', required: true },
                passSolved: { type: 'integer', required: true },
                passIndependent: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 读不到日程：${v.reject}` }]
        const L = [
          `【日程】${v.windowFrom} ~ ${v.windowTo}　今天 ${v.today}，能排到 ${v.planTo}`,
          '块型：' + v.blockKinds.map((b) => `${b.kind} ${b.minutes}min（${b.name}）`).join('／'),
        ]
        for (const d of v.days) {
          L.push('', `── ${d.weekday} ${d.date.slice(5)}` +
            (d.state === 'today' ? '（今天）' : d.state === 'past' ? '（已过去，只读）' : '') + ' ──')
          // 忙事和已排的块排成**一条时间轴**，逐个列出来。
          // 刻意不写成「忙 3 小时、闲 5 小时」那种汇总 —— 训练员要的是
          // "看得见哪几段被占了"。汇总数说不出「这 50 分钟夹在哪两件事之间」，
          // 而块能不能放下、要不要跨过饭点，全由那个位置决定。
          //
          // 需求 #8：★ 计划块后面**接回当天的实际**。
          // 数据早就在（SCHEDULE.yaml 的 actual + 这个工具的返回值里），
          // 只是以前一行都不印 —— 于是"排多少他吃得下"永远只能拍脑袋。
          // AGENTS.md 那句「排满了他做不完，下次 coach_schedule 里计划 vs 实际
          // 自己会说话」，到这一版才算真说了话。
          // ⚠️ 措辞一律是**陈述**：「无实际记录」不是「计划了没做」——事实 ≠ 判决
          // （09-17 那条实际记的其实是检测卷的战果、跟那两个块不是一回事，
          //   写成判决就会冤枉他）。
          const actualByNode = new Map()
          for (const a of d.actual) {
            const k = String(a.node)
            if (!actualByNode.has(k)) actualByNode.set(k, [])
            actualByNode.get(k).push(a)
          }
          const plannedCount = new Map()
          for (const b of d.planned) {
            const k = String(b.node)
            plannedCount.set(k, (plannedCount.get(k) ?? 0) + 1)
          }
          const backfill = (node) => {
            const rows = actualByNode.get(String(node)) ?? []
            const planned = plannedCount.get(String(node)) ?? 0
            if (planned === 0) return []              // 没排过块：不印（空壳段只是噪音）
            if (!rows.length) {
              return ['　　↳ 无实际记录' + (planned > 1 ? `（这天这个节点排了 ${planned} 块）` : '')]
            }
            // 三样都要：实际分钟 / 做出来没有 / 独立没有 —— 少第三样等于废一半
            const body = rows.map((r) =>
              `实际 ${r.actualMin} 分钟，` +
              `${r.solved ? (r.independent ? '独立做出' : '看题解做出') : '没做出来'}`).join('　·　')
            // 条数对不上要明说：同节点排了 2 块只记到 1 条，就是"没吃完"的形状
            const mismatch = planned !== rows.length
              ? `（这天这个节点排了 ${planned} 块，记到 ${rows.length} 条）`
              : ''
            // 计划那半**现算**（同节点当天所有块之和），不读文件里的快照
            return [`　　↳ 排 ${Number(rows[0].plannedMin ?? 0)} 分钟 / ${body}${mismatch}`]
          }
          const firstOfNode = new Set()
          const axis = [
            ...d.busy.map((b) => ({ a: b.from, z: b.to, t: b.label || '（没写事由）', mark: '· ', back: [] })),
            ...d.planned.map((b) => {
              const k = String(b.node)
              const first = !firstOfNode.has(k)
              firstOfNode.add(k)
              return {
                a: b.from, z: b.to, t: `${b.kindName}　${b.nodeName}`, mark: '★ ',
                back: first ? backfill(b.node) : [],
              }
            }),
          ].sort((x, y) => x.a.localeCompare(y.a))
          for (const it of axis) {
            L.push(`  ${it.mark}${it.a}–${it.z}　${it.t}`)
            for (const line of it.back) L.push(line)
          }
        }
        // ── 火候 ──
        // 排在日程后面、排课指令前面：**这是排课时要看的最后一样东西**。
        // 只报事实（放了多少天、做过几题、独立几次），不写"该复习了"——
        // 那是小鲸的判断（AGENTS.md 规则 7：「是数字，不是开关」）。
        if (v.readiness.length) {
          L.push('', '── 火候（按放得最久的排；**该不该动是你判**，这里只摆事实）──')
          for (const r of v.readiness) {
            const tag = r.status === 'verified' ? '✓已验证' : '▶在学'
            const ago = r.days < 0 ? '日期不明' : `${r.days} 天`
            const rec = r.passTotal
              ? `　做过 ${r.passTotal} 题（独立 ${r.passIndependent}）`
              : ''
            L.push(`  ${r.nodeName}　${tag} ${ago}${rec}`)
          }
          L.push('',
            '⚠️ **复习别把新知识挤没了。** 这套系统的价值在"往前推"，不在"原地保温" —— ' +
            '一个月的表里全是复习，等于这个月没往前走。他自己会想先复习（复习舒服、' +
            '做新题难受），**所以那个平衡得你来把**：复习块按上面的火候排，' +
            '剩下的时间留给推进。')
        }
        L.push('', '要排就用 coach_plan，**一次只排他说的那一天**。')
        return [{ type: 'text', text: L.join('\n') }]
      },
    },
    async execute(args) {
      try {
        const r = scheduleOverview(args?.days, args?.from)
        return { ok: true, reject: '', ...r }
      } catch (err) {
        // 读不出来就说读不出来 —— 返回一份空日程比报错更坏，
        // 教练会拿它当"这几天都没事"去排块。
        return {
          ok: false, reject: `${err.message}`, today: '', windowFrom: '', windowTo: '',
          planTo: '', blockKinds: [], days: [],
        }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'coach_plan',
    description:
      '把计划**写进日程表**。排块只有这一个入口 —— 他自己在页面上只能标「有事」，' +
      '计划只能从这里进来。\n' +
      '**范围只认他说的那一天**：他说「排今天」就只排今天，说「排周三」就只排周三，' +
      '不要顺手把明天后天一起铺了 —— 那是替他做决定，而且是没问过他的决定。\n' +
      '三种块：cycle = 题目循环 60min（40 自己做 + 10 解决遗留 + 10 重写）、' +
      'review = 复习一题 25min、exam = 章节检测 90min。**时长不能改** —— ' +
      '40 分钟那个止损点全靠它守着。\n' +
      '工具只拦**物理上做不到的**：压着他标的忙事 / 块叠在一起 / 知识点不在图上 / ' +
      '日子在窗口外。**排多排少是你的判断，工具不给容量上限**，排太满的后果' +
      '让表里的' +
      '「计划 vs 实际」事后说话。被拒就照它说的改，**不要换个说法硬试**。\n' +
      '一天排一次就**固化**了（方针 §4.1）：再问直接读 coach_schedule 报给他，不要重排。' +
      '真要改，把 replace 说成 true。',
    parameters: {
      date: { type: 'string', required: true, description: '哪天，YYYY-MM-DD，得在今天 ~ 今天+6 之间' },
      blocks: {
        type: 'array', required: true,
        description: '要排的块，按时间先后给。结束时间由 kind 决定，不用你算',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            from: { type: 'string', required: true, description: '开始时间 "HH:MM"，要对齐 5 分钟' },
            kind: { type: 'string', required: true, enum: ['cycle', 'review', 'exam'] },
            node: { type: 'string', required: true, description: '知识点 id，必须在地图里' },
          },
        },
      },
      replace: { type: 'boolean', description: '这天已经排过了，要不要覆盖重排。默认不覆盖' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          date: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          planned: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                minutes: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                kindName: { type: 'string', required: true },
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
                domain: { type: 'string', required: true },
              },
            },
          },
          // 排完回一张整表，不给容量/余量汇总。
          planMin: { type: 'integer', required: true },
          replaced: { type: 'integer', required: true },
          updated: { type: 'string', required: true },
          // 排进去了、但事后会出问题的地方。**只提醒不拦** ——
          // 排块是他的判断，工具不该替他把 exam 块撤了。
          notes: { type: 'array', required: true, items: { type: 'string' } },
          busy: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 排不进去：\n${v.reject}` }]
        const L = [`【排好了】${v.date}` +
          (v.replaced ? `（覆盖掉原来那 ${v.replaced} 个块）` : '')]
        for (const b of v.planned) {
          L.push(`  ★ ${b.from}–${b.to}　${b.kindName}　${b.nodeName}` +
            (b.kind === 'cycle' ? '　（40 自己做 → 10 解决遗留 → 10 重写）' : ''))
        }
        // 回一条**完整时间轴**，而不是「还剩多少分钟」。
        // 排完他得能一眼看出这块夹在哪两件事之间 —— 那个位置才决定来不来得及。
        L.push('', '这天现在长这样：')
        const axis = [
          ...v.busy.map((b) => ({ a: b.from, z: b.to, t: b.label || '（没写事由）', mark: '· ' })),
          ...v.planned.map((b) => ({ a: b.from, z: b.to, t: `${b.kindName}　${b.nodeName}`, mark: '★ ' })),
        ].sort((x, y) => x.a.localeCompare(y.a))
        for (const it of axis) L.push(`  ${it.mark}${it.a}–${it.z}　${it.t}`)
        // `?? []`：render 可能被喂 planDay 的**裸返回值**（schedApi 那条路，
        // 它不知道卷子的事，也就没有 notes）。和这个文件里其它地方一个口径 ——
        // render 不该假设自己只被工具喂。
        for (const n of v.notes ?? []) L.push('', `⚠️ ${n}`)
        L.push('', '跟他说清楚**几点到几点做什么、到点就停**。计划已经进表了，' +
          '别再把整张日程念一遍。')
        return [{ type: 'text', text: L.join('\n') }]
      },
    },
    async execute(args) {
      const blocks = (Array.isArray(args?.blocks) ? args.blocks : []).map((b) => ({
        from: String(b?.from ?? ''), kind: String(b?.kind ?? ''), node: String(b?.node ?? ''),
      }))
      const r = planDay(args?.date, blocks, { replace: args?.replace === true })

      // 排进去之后要看一眼的事。
      //
      // exam 块 = 做一张三题的检测卷。排块当时工具只检查"物理上排不排得下"，
      // 不检查"手里有没有卷子" —— 于是能排出 14:00–15:30 的检测块，
      // 而那时候还没开卷。到点他坐下来不知道做哪三道。
      // 不拦（排块是教练的判断），但必须说，因为这事儿**到点才暴露**。
      const notes = []
      if (r.ok) {
        const exams = (r.planned ?? []).filter((b) => b.kind === 'exam')
        if (exams.length && !loadProgress().pending) {
          notes.push(`这天排了 ${exams.length} 个章节检测块，但手上**还没有卷子** —— ` +
            '先用 coach_test 配一张（三题、易中难各一），或者把这块换成 cycle。')
        }
      }
      // schema 里字段都是 required，被拒时也得凑齐形状 ——
      // 少字段在 dsh 那边是校验错，不是"空值"，报错会把真正的拒绝理由盖掉。
      return {
        ok: r.ok === true, reject: String(r.reject ?? ''),
        date: String(r.date ?? args?.date ?? ''),
        count: Number(r.count ?? 0),
        planned: r.planned ?? [],
        planMin: Number(r.planMin ?? 0),
        replaced: Number(r.replaced ?? 0), updated: String(r.updated ?? ''),
        notes,
        busy: r.busy ?? [],
      }
    },
  }))

  // 撤块。**和排块分开是对的**：合成一个参数的话，教练迟早会在该撤的时候
  // 顺手重排 —— 而重排会把他没意见的块也一起换掉，那正是"计划固化"想防的事。
  ctx.tools.register(defineTool({
    name: 'coach_unplan',
    description:
      '**撤掉**已经排好的块。他说「这个时间不合理」「那天临时有事」时用它。\n' +
      '撤的**只有计划**：他标的「有事」（busy）动不了 —— 那是事实不是计划，' +
      '要改得他自己在页面上改。\n' +
      '给 from（那个块的**开始时间**）撤那一个；给 all=true 撤掉整天。' +
      '两个都不给会被拒，并把这天的候选列给你挑。\n' +
      '⚠️ **撤完不要立刻重排。** 先问清他为什么撤（太早？那天想歇？' +
      '还是这个点根本坐不住？），把撤完的样子报给他。' +
      '马上塞一个新的进去，很可能又塞在他不想要的位置上。',
    parameters: {
      date: { type: 'string', required: true, description: '哪天，YYYY-MM-DD' },
      // ⚠️ 可选参数**不写 required** —— dsh 的 defineTool 只认 `required: true`
      // 或干脆不写，写 `required: false` 会当场抛 UNSUPPORTED_SCHEMA。
      from: { type: 'string', description: '撤哪个块 —— 它的开始时间 "HH:MM"' },
      all: { type: 'boolean', description: '撤掉这天全部。和 from 二选一' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          date: { type: 'string', required: true },
          removedCount: { type: 'integer', required: true },
          leftCount: { type: 'integer', required: true },
          removed: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                kindName: { type: 'string', required: true },
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
              },
            },
          },
          left: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                kindName: { type: 'string', required: true },
                node: { type: 'string', required: true },
                nodeName: { type: 'string', required: true },
              },
            },
          },
          // 撤完回一张整表。
          updated: { type: 'string', required: true },
          busy: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 撤不了：\n${v.reject}` }]
        const L = [`【撤了】${v.date}　拿掉 ${v.removedCount} 个`]
        for (const b of v.removed) L.push(`  ✗ ${b.from}–${b.to}　${b.kindName}　${b.nodeName}`)
        if (v.leftCount) {
          L.push('', '这天还剩：')
          for (const b of v.left) L.push(`  ★ ${b.from}–${b.to}　${b.kindName}　${b.nodeName}`)
        } else {
          L.push('', '这天没有别的块了。')
        }
        L.push('', '这天现在长这样：')
        const axis = [
          ...v.busy.map((b) => ({ a: b.from, z: b.to, t: b.label || '（没写事由）', mark: '· ' })),
          ...v.left.map((b) => ({ a: b.from, z: b.to, t: `${b.kindName}　${b.nodeName}`, mark: '★ ' })),
        ].sort((x, y) => x.a.localeCompare(y.a))
        for (const it of axis) L.push(`  ${it.mark}${it.a}–${it.z}　${it.t}`)
        L.push('', '**别顺手重排。** 先问清他为什么撤 —— 知道原因比补一个块重要。')
        return [{ type: 'text', text: L.join('\n') }]
      },
    },
    async execute(args) {
      const r = unplanDay(args?.date, { from: args?.from, all: args?.all === true })
      return {
        ok: r.ok === true, reject: String(r.reject ?? ''),
        date: String(r.date ?? args?.date ?? ''),
        removed: r.removed ?? [], removedCount: Number(r.removedCount ?? 0),
        left: r.left ?? [], leftCount: Number(r.leftCount ?? 0),
        updated: String(r.updated ?? ''),
        busy: r.busy ?? [],
      }
    },
  }))

  // ── coach_log：记一道题**实际**用了多久 ─────────────────────────
  //
  // 后补的。`actual` 这个字段从设计第一天就躺在 SCHEDULE.yaml 的
  // 结构说明里，注释管它叫「校准真实速度的唯一来源」—— 但全项目
  // **没有一个写入者**：页面只发 busy（skilltree.html 里连 actualMin /
  // independent 这两个词都没有），工具里也没有任何地方写它。
  // 设计方针 §4.1.2 那条「计划时长 vs 实际时长 → 几周后系统知道他的真实速度」
  // 两头都断着：没入口，也没消费者。
  //
  // 它同时是路线图第 1 条「排课的实际验收」真正的卡点 ——
  // 那条写的是"得真排几天才知道块是不是排太密"，但真排一个月也收不到一条数据，
  // 因为**根本没有记录入口**。所以先有入口，再谈验收。
  //
  // plannedMin **不让调用方填**：那天表上排了多久是事实，工具自己算。
  // 让他填就等于同一个数有两个来源，而"计划 60 实际 95"这个差值的全部意义
  // 就在于这两个数是各自独立得到的。
  ctx.tools.register(defineTool({
    name: 'coach_log',
    description:
      '记一条**实际用时**：他做完一个块之后，报「做了多久、是不是独立做出来的」。\n' +
      '**每次他报告完成情况就调一次**（不管是做出来了还是没做出来、超时了还是提前），' +
      '这是系统学会"他真实速度是多少"的唯一来源 —— 不记，排程永远只能靠猜。\n' +
      '计划时长不用你填：那天表上排了多久，工具自己从 SCHEDULE.yaml 里算。\n' +
      'independent = **有没有看题解 / 问人**。这一栏比时长还重要 —— ' +
      '「30 分钟独立做出来」和「30 分钟看了题解才做出来」在掌握度上是两回事。\n' +
      '**同一天同一个知识点做了两道题，就调两次、各带自己的 problemId** —— ' +
      '别合成一条（合成之后「哪道独立做出来的」就没了，而那正是开不开检测卷的依据）。',
    parameters: {
      node: { type: 'string', required: true, description: '知识点 id，必须在地图里' },
      // （需求 #2）：题号。**可选** —— 不填就是老行为（一天一节点一条）。
      problemId: {
        type: 'string',
        description: '做的哪道题，如 "P2880" / "CF1548B"（可选）。' +
          '填了它，同一天同一知识点才能分开记两道题；不填就按老规矩「一天一节点一条」。',
      },
      actualMin: { type: 'number', required: true, description: '实际花了多少分钟' },
      solved: {
        type: 'boolean', required: true,
        description: '**做出来没有**。没做出来就填 false —— 「我想了 40 分钟没做出来」' +
          '正是最该记的一条，别只记成功的',
      },
      independent: {
        type: 'boolean', required: true,
        description: '是不是**独立**做出来的（没看题解、没问人）。这一栏比时长还重要 —— ' +
          '「30 分钟独立做出来」和「30 分钟看了题解才会」在掌握度上是两回事。' +
          '没做出来时填 false',
      },
      date: { type: 'string', description: '哪天，YYYY-MM-DD。不填就是今天' },
      note: { type: 'string', description: '一句话备注（可选），如「卡在边界上想了很久」' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          date: { type: 'string', required: true },
          node: { type: 'string', required: true },
          nodeName: { type: 'string', required: true },
          plannedMin: { type: 'integer', required: true },
          actualMin: { type: 'integer', required: true },
          deviation: { type: 'integer', required: true },
          solved: { type: 'boolean', required: true },
          independent: { type: 'boolean', required: true },
          replaced: { type: 'boolean', required: true },
          // （需求 #2）：回显题号，并报「这天这个点一共记了几条」
          problemId: { type: 'string', required: true },
          sameDayEntries: { type: 'integer', required: true },
          totalLogged: { type: 'integer', required: true },
          // 掌握证据有没有落进 PROGRESS（失败时不影响上面那半已经写好的时间记录）
          recorded: { type: 'boolean', required: true },
          // 需求 #6：这条记录是不是把该节点**押着的动作**销掉了（落地即销）。
          actionCleared: { type: 'boolean', required: true },
          passCount: { type: 'integer', required: true },
          updated: { type: 'string', required: true },
        },
      },
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: `❌ 记不上：${v.reject}` }]
        // 需求 #8：**偏差那句话收掉了**。
        // 原来这里印「比排的多花了 X 分钟（计划 Y / 实际 Z）」—— 那个数对他
        // 没有可执行动作（拿到"超了 27 分钟"他能干嘛？加速？那是表现目标），
        // 但对教练有用（排课密度的输入）。所以偏差挪到教练侧（coach_schedule
        // 的计划块回填里现算），他这边只留中性回显：
        // **事实给他，判断留给教练。**
        const echo = `记住了：${v.actualMin} 分钟`
        // ⚠️ **做对了要夸，别接着挑毛病**。
        //   判因工具的出口只有 不会/不熟/不认真 三档 —— 拿它去判一份对的代码，
        //   它也只能挑出错处来。出口里没有"对了"这个选项。
        // 这个渲染是小鲸最容易照抄的模板，把它写成正向的，它就不会
        // 自己再往判因那边滑。做对了**不调 coach_diagnose** —— 见 AGENTS.md 规则 6。
        const how = !v.solved ? '\n  ✗ 没做出来 —— 这很正常，接下来该做的是看看卡在哪，不是重新抄一遍'
          : v.independent ? '\n  ✓ **独立做出来的**（没看题解、没问人）—— 这是最硬的那种掌握证据'
            : '\n  ✓ 做出来了，但是**看了题解/问了人才会的** —— 记下了，这两件事在掌握度上不一样'
        return [{
          type: 'text',
          text: `✓ 记下了：${v.date}　${v.nodeName}${v.problemId ? `　${v.problemId}` : ''}\n` +
            `  ${echo}${how}` +
            (v.replaced
              ? `\n  （这天这个点${v.problemId ? '这道题' : ''}原来记过一条，覆盖了）`
              : '') +
            (v.recorded
              ? `\n  台账：这个知识点第 ${v.passCount} 次做完记录。`
              : '\n  ⚠️ 掌握证据那条没写上（磁盘/权限问题）—— 时间记录是好的。') +
            (v.actionCleared
              ? '\n  📌 这个节点上押着的动作**销了** —— 这条记录就是它的落地。'
              : '') +
            `\n  这天这个点 ${v.sameDayEntries} 条，这天总共 ${v.totalLogged} 条。` +
            (v.solved
              ? '\n\n**做对了就先好好夸一句，然后往下走。** 不要接着挑边界、挑写法 —— ' +
                '「对了」已经拿到手了，剩下的是教练下次讲的时候顺带提的事，不是现在的作业。'
              : ''),
        }]
      },
    },
    async execute(args) {
      const { byId } = loadMap()
      const node = String(args?.node ?? '').trim()
      const d = String(args?.date ?? '').trim() || ymdToday()
      const actualMin = Math.round(Number(args?.actualMin))
      const solved = args?.solved === true
      const independent = args?.independent === true
      const note = String(args?.note ?? '').trim()
      // （需求 #2）：题号。空串 = 没给 = 老行为。
      const problemId = String(args?.problemId ?? '').trim()
      const deny = (reject) => ({
        ok: false, reject, date: d, node, nodeName: byId.get(node)?.name ?? '',
        plannedMin: 0, actualMin: 0, deviation: 0, solved: false, independent: false,
        replaced: false, problemId, sameDayEntries: 0, totalLogged: 0, recorded: false,
        passCount: 0, updated: '', actionCleared: false,
      })

      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return deny(`日期要 YYYY-MM-DD 格式，收到「${d}」。`)
      }
      if (!byId.has(node)) {
        const near = suggest(node, [...byId.values()])
        return deny(`地图里没有「${node}」这个知识点，别自己造。` +
          (near.length ? `相近的有：${near.join(' / ')}` : '先调 coach_status 看他在哪。'))
      }
      if (!Number.isFinite(actualMin) || actualMin <= 0) {
        return deny(`实际用时要给个正数（分钟），收到「${args?.actualMin ?? ''}」。` +
          '没做出来也要填实际耗掉的时间 —— 「我想了 40 分钟没做出来」正是要记的东西。')
      }
      // 天数上限：记今天和过去，但别往未来记（未来的"实际用时"是编的）
      if (d > ymdToday()) {
        return deny(`「${d}」还没到呢 —— 实际用时只能记今天或过去。`)
      }

      const s = loadSchedule()
      const day = { ...(s.days?.[d] ?? {}) }
      const list = (Array.isArray(day.actual) ? day.actual : []).slice()

      // 计划时长从那天排好的块里**现算**，不让调用方填。
      // 需求 #8：它现在**只用在这条调用的输出里**（教练侧看），
      // 不再落盘 —— 快照会过期（09-21 的 ST 表那条存 120、按现在的表算是 60），
      // 真相源是 SCHEDULE.yaml 的 `planned`，要显示就现算。
      const blockMin = (b) => {
        const a = hmMin(b?.from), z = hmMin(b?.to)
        return a === null || z === null ? 0 : Math.max(0, z - a)
      }
      const plannedMin = (Array.isArray(day.planned) ? day.planned : [])
        .filter((b) => String(b?.node ?? '') === node)
        .reduce((t, b) => t + blockMin(b), 0)

      // 同一天同一个点：**没给题号时**只留一条 —— 这张表没有开始时间，
      // 两条同时段记录事后分不出是"重做了一遍"还是"记岔了"，覆盖并明说覆盖了。
      // **给了题号就按题号分开存**（需求 #2）：同一天同一节点做两道题是常态
      // （09-21 的 ST 表：P2880 独立 AC、1548B 带提示 AC），压成一条等于
      // 把"他独立做出过这个点的题"从台账里抹掉。
      const idx = list.findIndex((r) =>
        String(r?.node ?? '') === node && String(r?.problemId ?? '') === problemId)
      // 需求 #8：`plannedMin` 不再写进这条记录（见上面那段注释）
      const entry = { node, actualMin, solved, independent }
      if (problemId) entry.problemId = problemId
      if (note) entry.note = note
      const replaced = idx >= 0
      if (replaced) list[idx] = entry
      else list.push(entry)
      const sameDayEntries = list.filter((r) => String(r?.node ?? '') === node).length

      const w = setScheduleField(d, 'actual', list)
      if (!w.ok) return deny(w.reject)

      // ── 掌握证据落进 PROGRESS──────────────────────
      //
      // 「他独立做出来了」这件事原先**没有落盘的地方** —— coach_diagnose 只记失败
      // （category 里没有"对"这一档），coach_grade 只记检测卷，coach_mark 只有
      // 在学/学过两档且都是自评。于是设计方针里那条
      //   «块结构天然产出「独立做出 vs 听了讲才会」这个信号 ——
      //     这是掌握度最直接的证据，当前系统完全收不到»
      // 一直空着。这里就是那个入口。
      //
      // ⚠️ **不动 status**。做对一道题 ≠ 这个知识点学完了 ——
      // 那是检测（coach_grade）的活。这里只记事实，判断留给教练。
      let recorded = false
      let actionCleared = false
      let passCount = 0
      try {
        const prog = loadProgress()
        const rec = { ...(prog.nodes[node] ?? {}) }
        const passes = Array.isArray(rec.passes) ? rec.passes.slice() : []
        const e = { date: d, solved, independent, minutes: actualMin }
        if (problemId) e.problemId = problemId
        if (note) e.note = note
        // 去重键和 SCHEDULE 那边**必须一致**（日期 + 节点 + 题号）：
        // 两边口径分家的话，`coach_status` 的条目数和 `coach_next` 的计划
        // 会对不上同一件事 —— 这个项目反复在治的就是这个病。
        const pi = passes.findIndex((p) => String(p?.date ?? '') === d &&
          String(p?.problemId ?? '') === problemId)
        if (pi >= 0) passes[pi] = e
        else passes.push(e)
        rec.passes = passes
        prog.nodes[node] = rec
        // 押着的动作**落地即销**（需求 #6）：这个节点上布置过、他这会儿记了
        // 一条做完记录 = 就是做了。撤销是 coach_unassign 的活（那条路不写 passes）——
        // 两个出口分开，是为了不让"做完了"和"不做了"在账上长成一个样。
        if (prog.pendingActions && Object.prototype.hasOwnProperty.call(prog.pendingActions, node)) {
          delete prog.pendingActions[node]
          actionCleared = true
        }
        saveProgress(prog)
        recorded = true
        passCount = passes.length
      } catch { /* 落盘失败不影响时间那条已经写进去的记录 */ }

      return {
        ok: true, reject: '', date: d, node,
        nodeName: byId.get(node)?.name ?? node,
        plannedMin, actualMin, deviation: actualMin - plannedMin, solved, independent,
        replaced, problemId, sameDayEntries,
        totalLogged: list.length, recorded, actionCleared, passCount, updated: w.updated,
      }
    },
  }))

  // 强制力那一层（方针 §五 第四层）：每个 turn 注入当前位置
  registerStateHook(ctx)

  // 技能树页面（可选注入 —— 没有 webServer 的环境跳过，工具照常工作）
  ctx.inject(['webServer'], (sctx) => { registerPages(sctx) })
}

export { apply, inject, name, VERSION }

// ── 夹具写接口的闸门 ──────────────────────────────────────────────
//
// 起因：一条测试用**默认数据目录**（＝真账本）跑「布置成功」，把一条幻影任务
// 写进了真 PROGRESS.yaml（重启后教练会去追一个不存在的活）。
// 「跑完比对 sha256」是事后报警；这一道是**事前阻止** —— 让"试跑写不脏真账本"
// 变成结构性质，而不是靠每个写脚本的人自觉。
//
// 只拦**夹具接口**（`schedApi`：README 写着它是"给 verify.mjs 留的口子"，
// 全仓库只有 verify.mjs 在用）。`progressApi` **不能拦** —— 它就是生产路径的
// 写实现（页面 / host 路由 / progress-cli 都走它），拦了等于把正常的打勾、
// 标状态、排块一起掐掉。
//
// ⚠️ 判据是「数据目录**是不是显式指定的**」（`DATA_DIR_EXPLICIT`），
// 不是比对某个写死的路径。早先拿 DATA_DIR 去比一个硬编码的真账本路径，
// 有两个毛病：
//   ① 它只护得住那一个目录 —— 换个人用，闸门形同虚设，界面上看不出区别；
//   ② 那两个常量是同一件事的两份真相，改了一处忘了另一处就**静默失效**
//      —— 正是这个闸门当初要治的那类 bug，兜底自己踩在坑上。
// 现在判据和 DATA_DIR 同源、同一时刻捕获，没有第二个地方可以忘记改。
function assertNotRealLedger(what) {
  if (DATA_DIR_EXPLICIT) return
  throw new Error(
    `${what} 是**夹具写接口**，不许写你的真账本（${DATA_DIR}）。` +
    '试跑 / 造样本请先 mkdtempSync 拷一份，再把 COACH_DATA_DIR 指过去；' +
    '生产路径走工具调用（coach_plan / coach_assign / coach_log / coach_unplan），不受这条限制。')
}

// ── 两个写操作的**唯一实现** ────────────────────────────────────────
//
// 收拢过一处。改之前，「标记」的校验散在三个地方：
//   coach_mark 工具里一套、progress-cli.mjs 里一套、页面服务再触发其中一套。
// 三套判得一样不代表以后还一样 —— 而它们写的是**真相源**，
// 分家的代价是静默写进坏数据（正是 08 月那批 bug 的形状：多处真相）。
//
// 现在只有这里动 YAML。工具、CLI、页面路由三边都只是调用方。
// 返回形状统一成一套，调用方不用各自拼字段。
//
// 为什么 status 收 `none` 而 coach_mark 不收：见那边 execute 里的注释 ——
// 「退回未学」是盘点动作不是教学决策，属于工具层的策略，不属数据层。

/** 标记一个节点的状态。status ∈ studying / learned / none（none = 退回未学）。 */
function markStatus(node, status) {
  const { byId } = loadMap()
  const id = String(node ?? '').trim()
  const s = String(status ?? '').trim()

  if (!byId.has(id)) {
    const near = suggest(id, [...byId.values()])
    return {
      ok: false,
      reject: `地图里没有「${id}」这个知识点。` +
        (near.length ? `相近的有：${near.join(' / ')}` : ''),
    }
  }
  if (!['studying', 'learned', 'none'].includes(s)) {
    return {
      ok: false,
      reject: `status 只能是 studying / learned / none，收到「${s}」。` +
        (s === 'verified'
          ? '「已验证」只能靠 coach_grade 判卷产生 —— 自评不算掌握。'
          : ''),
    }
  }

  const p = loadProgress()
  const from = nodeStatus(p, id)
  if (s === 'none') {
    // 「退回未学」只清**状态**，不删整条记录。
    // `checks`（检测记录）和 `diagnoses`（判因台账）挂在同一条记录上 ——
    // delete 会把它们一起抹掉，而那是**历史证据**：他哪天考了多少分、
    // 判过几次「不认真」，不该因为点了一下状态按钮就消失。
    // 只剩空壳（没别的东西可留）才真删，不留 `{}` 这种残渣。
    const rec = { ...(p.nodes[id] ?? {}) }
    delete rec.status
    delete rec.at
    if (Object.keys(rec).length) p.nodes[id] = rec
    else delete p.nodes[id]
  } else {
    const rec = { ...(p.nodes[id] ?? {}), status: s }
    // `at` = **什么时候变成这个状态的**，不是「最后一次点它」。
    //
    // 语义差别很要命：把它当"最后操作时间"，重复点同一个状态就会把日期刷成今天，
    // 于是「这个在学放了 12 天，今天接着它」永远算不出来 —— 每次点它都变"刚学的"。
    // 所以只在**状态真的变了**时才更新。
    //
    // 补历史：早先标的那批没有这个字段（当时没记）。重复标同一状态
    // 不会更新 at，但**没 at 的时候要补上** —— 否则老数据永远显示"无日期"。
    const today = localStamp(new Date()).slice(0, 10)
    if (from !== s || !rec.at) rec.at = today
    p.nodes[id] = rec
  }
  saveProgress(p)

  const c = { verified: 0, learned: 0, studying: 0 }
  for (const rec of Object.values(p.nodes)) {
    if (rec?.status === 'verified') c.verified++
    else if (rec?.status === 'learned') c.learned++
    else if (rec?.status === 'studying') c.studying++
  }
  return {
    ok: true, reject: '', node: id,
    nodeName: byId.get(id).name ?? id,
    from, to: s,
    cursor: p.cursor, updated: p.updated,
    verifiedCount: c.verified, learnedCount: c.learned, studyingCount: c.studying,
  }
}

/** 移动游标。**只前进不倒退**是纪律，不是这里拦的 —— 复习旧节要能移回去。 */
function moveCursor(node) {
  const { byId } = loadMap()
  const id = String(node ?? '').trim()
  if (!byId.has(id)) return { ok: false, reject: `地图里没有「${id}」这个知识点` }
  const p = loadProgress()
  p.cursor = id
  saveProgress(p)
  return { ok: true, reject: '', cursor: id, updated: p.updated, nodeName: byId.get(id).name ?? id }
}

// 给非 JS 调用方（技能树页面的服务端）留的口子。
//
// 为什么要开这个口：PROGRESS.yaml **只能有一个写入实现**。
// 让 Python 那边用 PyYAML 自己读写，就会有第二个写者、第二套 YAML 实现、
// 第二种输出风格，而且 PyYAML 不吃注释 —— 文件头那段三级状态说明第一次写就没了。
// 今天一整天在治的就是「同一件事两份真相」。
//
// 所以服务端不自己动 YAML，走下面这套（之前是 shell 出去跑
// progress-cli.mjs；现在 dsh 自己 serve 页面，直接调函数，连子进程都省了）。
export const progressApi = {
  path: PROGRESS_PATH,
  load: loadProgress,
  save: saveProgress,
  status: nodeStatus,
  hasNode: (id) => loadMap().byId.has(id),
  nameOf: (id) => loadMap().byId.get(id)?.name ?? id,
  setStatus: markStatus,
  moveCursor,
  // 日程。和进度同一套道理：**只有一个写实现**，
  // 页面、CLI、host 路由都调这几个，谁也别自己动 SCHEDULE.yaml。
  loadSchedule,
  saveSchedule,
  setSchedule: setScheduleField,
}

// 给 verify.mjs 留的口子 —— **排块规则只有从这里验得了**。
// 走工具调用验不到边界（外面还包着 schema 校验和 render），而排块错了的代价是
// 他会照着一张排错的表做一整天。网格常量也必须从这里取去和页面模板对账：
// 对不上的后果是「排了个 7:30 的块，页面根本画不出来」。
export const schedApi = {
  FROM_H: SCHED_FROM_H,
  TO_H: SCHED_TO_H,
  SNAP: SCHED_SNAP_MIN,
  FILL: SCHED_FILL,
  AHEAD: SCHED_AHEAD,
  BACK: SCHED_BACK,
  WINDOW: SCHED_WINDOW,
  kinds: SCHED_KINDS,
  freeSlots,
  openSlots,
  freeMinutes,
  openMinutes,
  capacityMin,
  // 需求 #10：**写方法过闸**（读方法不拦 —— 看一眼日程不会写脏东西）。
  // 生产路径不走这里（coach_plan / coach_unplan 工具直接调内部实现），
  // 所以这道闸只挡夹具脚本。
  planDay: (...a) => { assertNotRealLedger('schedApi.planDay'); return planDay(...a) },
  unplanDay: (...a) => { assertNotRealLedger('schedApi.unplanDay'); return unplanDay(...a) },
  scheduleOverview,
}

// 给 build-node-meta.mjs 留的口子 —— 算每个节点的「入门段位」要用题池。
// **必须复用这里的实现**，不能在脚本里另写一套 SQL：
// 两套匹配口径 = 同一个知识点在两处得到不同的题池 = 又一份"两份真相"。
export const coachApi = {
  nodePool,
  matchTags,
  ratingFn,
  acSet,
  normId,
  openDb,
  loadMap,
  DATA_DIR,
}

// build-node-meta.mjs —— 算每个知识点的「入门段位」，落成 NODE_ENTRY.yaml
//
// ── 为什么需要这个数 ──────────────────────────────────────────────
// 地图只说了「谁是谁的前置」——**允许**学什么；
// 没说「什么水平学得起」——**合适**学什么。
//
// 1200 分的人学完 DFS，后继里有树链剖分、支配树、可持久化线段树。
// 前置全满足，一个都学不了。缺的就是这条轴。
//
// ── 为什么是 p25 而不是中位数 ────────────────────────────────────
// 中位数回答不了这个问题。模拟是**贯穿型技能**：800 到 3000 都有题，
// 它的中位数只会告诉你"这个技能跨度很大"，说不出"什么时候开始学"。
// 而 `可持久化线段树` 是**里程碑型技巧**，题池窄，中位数和入门线差不多。
//
// p25 才是"这个知识点开始有意义的那个水平"—— 对两种类型都成立。
//
// ── 为什么必须复用 coachApi.nodePool ─────────────────────────────
// 不能在这里另写一套标签匹配的 SQL。两套口径会让同一个知识点在
// 两个地方得到**不同的题池** —— 那正是这个项目反复在治的病。
//
// 跑法（**必须从已安装副本跑**，源码目录解析不到 yaml 依赖）：
//   node ~/.dsh/profiles/web/node_modules/acmer-coach/build-node-meta.mjs
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { coachApi } from './index.js'

const OUT = join(coachApi.DATA_DIR, 'NODE_ENTRY.yaml')
const MIN_POOL = 8    // 题池小于这个数，p25 没有统计意义，宁可不给
const P25 = 0.25

const HEADER = `# ══════════════════════════════════════════════════════════════
# NODE_ENTRY.yaml — 每个知识点的「入门段位」· **本文件由机器生成**
#
# ⚠️ 不要手改 —— 手改会在下次跑 build-node-meta.mjs 时被冲掉。
#    要改标注意见，改 NODE_META.yaml（那个是人维护的）。
#
# 生成方式：
#   node ~/.dsh/profiles/web/node_modules/acmer-coach/build-node-meta.mjs
#
# 字段：
#   entry   入门段位 = 该节点题池难度的 **p25**（不是中位数！）
#   pool    题池大小（打这个标签的题有多少道）
#   median  中位数，仅作对比参考 —— 它回答不了"什么时候学得起"
#
# 为什么是 p25：模拟这类贯穿型技能 800~3000 都有题，中位数只会说
# "跨度很大"；而可持久化线段树这类里程碑型技巧题池很窄。p25 对两种
# 类型都给出"开始有意义的那个水平"。
#
# 只有 pool >= ${MIN_POOL} 的节点才给 entry —— 样本太小算出来的数会骗人，
# 宁可不给，让教练知道"这个点没有可信的难度数据"。
# ══════════════════════════════════════════════════════════════
`

function main() {
  const { nodes } = coachApi.loadMap()
  return coachApi.openDb().then((db) => {
    const toRating = coachApi.ratingFn(db)
    const out = {}
    let withPool = 0
    let noPool = 0
    let tooThin = 0

    for (const n of nodes) {
      const { kind, hits } = coachApi.nodePool(db, n.name)
      if (kind === 'none') { noPool++; continue }
      const rs = hits
        .map((r) => toRating(r.platform, r.difficulty))
        .filter((x) => x > 0)
        .sort((a, b) => a - b)
      if (rs.length < MIN_POOL) { tooThin++; continue }
      out[n.name] = {
        entry: rs[Math.floor(rs.length * P25)],
        pool: rs.length,
        median: rs[Math.floor(rs.length * 0.5)],
      }
      withPool++
    }
    db.close()

    const doc = { meta: { source: 'training.db', nodes: nodes.length }, nodes: out }
    const tmp = `${OUT}.tmp`
    writeFileSync(tmp, HEADER + stringify(doc, { lineWidth: 0 }), 'utf8')
    renameSync(tmp, OUT)     // 原子写：半路崩了不会留下半个文件

    console.log(`生成完成 → ${OUT}`)
    console.log(`  节点总数 ${nodes.length}`)
    console.log(`  有题池且够厚，算出 entry：${withPool}`)
    console.log(`  题库里没这个标签（出不了卷）：${noPool}`)
    console.log(`  有标签但题池太薄（<${MIN_POOL} 道）：${tooThin}`)
    return 0
  })
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('❌ 算不出来：', e.message)
  process.exit(1)
})

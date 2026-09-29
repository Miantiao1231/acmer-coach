// 进度读写 CLI —— 给非 JS 的调用方用（现在只剩技能树的离线预览 serve_map.py）。
//
// ── 为什么要有这个中间层 ─────────────────────────────────────────
// PROGRESS.yaml **只能有一个写入实现**。
// 让 Python 那边用 PyYAML 自己读写，立刻就是两个写者、两套 YAML 实现、
// 两种输出风格；而且 PyYAML 不吃注释，文件头那段状态说明第一次写就没了。
//
// 所以本文件**不自己实现任何规则** —— 它只把 argv 翻译成 progressApi 调用。
// 校验（节点是否存在、status 合不合法）和落盘（原子写、文件头重贴）
// 全在 index.js 里，和教练工具、和 /coach 页面路由共用同一份代码。
//
// ── 必须从「已安装副本」运行 ─────────────────────────────────────
//   node <profiles/web>/node_modules/acmer-coach/progress-cli.mjs get
// 因为 index.js 要 import `yaml` 和 `@deepseek-ai/dsh-tools`，
// 只有装在 node_modules 下才解析得到（源码目录里跑会 ERR_MODULE_NOT_FOUND）。
//
// ── 契约 ─────────────────────────────────────────────────────────
//   入参：argv[2] = get | mark | cursor
//   出参：stdout 一行 JSON。**永远以 JSON 说话**，错误也走 JSON，
//         这样调用方不用去解析 stderr 的人话。
//   退出码：0 = 成功；1 = 被拒或出错（调用方看 ok 字段）
import { progressApi } from './index.js'

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n') }
const die = (err) => { out({ ok: false, reject: String(err) }); process.exit(1) }

const [, , cmd, a, b, c] = process.argv

try {
  if (cmd === 'get') {
    const p = progressApi.load()
    out({ ok: true, cursor: p.cursor, updated: p.updated, nodes: p.nodes })
  } else if (cmd === 'mark') {
    // a = 节点 id, b = studying | learned | none（none = 退回未学）
    // ⚠️ verified 会被 progressApi.setStatus 拒掉 —— 自评不能冒充检测结论。
    const r = progressApi.setStatus(a, b)
    if (!r.ok) die(r.reject)
    out({
      ok: true, node: r.node, status: r.to, cursor: r.cursor,
      verified: r.verifiedCount, learned: r.learnedCount, studying: r.studyingCount,
    })
  } else if (cmd === 'cursor') {
    const r = progressApi.moveCursor(a)
    if (!r.ok) die(r.reject)
    out({ ok: true, cursor: r.cursor })
  } else if (cmd === 'sched-get') {
    const s = progressApi.loadSchedule()
    out({ ok: true, updated: s.updated, days: s.days })
  } else if (cmd === 'sched-set') {
    // a = date, b = field, c = JSON 数组
    let value
    try {
      value = JSON.parse(c ?? '[]')
    } catch {
      die(`值要是 JSON 数组，收到「${c ?? ''}」`)
    }
    const r = progressApi.setSchedule(a, b, value)
    if (!r.ok) die(r.reject)
    out({ ok: true, date: r.date, field: r.field, count: r.count, updated: r.updated })
  } else {
    die(`未知命令「${cmd}」，只有 get / mark / cursor`)
  }
} catch (err) {
  // 解析失败、磁盘写失败之类一律走这里。
  // **绝不吞掉** —— 上层要靠这个区分「真的没进度」和「文件坏了」。
  die(err?.message ?? err)
}

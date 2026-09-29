// 环境搭建 + Codeforces 数据同步。
//
// 单独一个文件而不是塞进 index.js：这块和教练逻辑**不共享状态** ——
// 它只往磁盘上放数据，不知道什么叫"节点""游标""检测"。混在一起会让
// index.js 变成什么都管。
//
// ⚠️ 关于「拉数据算掌握度」——**没有这回事**，别在这里加。
//    试过，证伪了：一个人某题提交 11 次，数据能说"花了很久"，
//    说不出"卡在哪"。所以这里只做**事实搬运**：把 CF 上的公开记录搬进本地库，
//    至于"他会不会"，那是检测的事（见 index.js 的 coach_pool/test/grade）。
//    同步完给的「接触证据」只是**缩小搜索范围**用的，不是结论。
import { mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── 表结构 ────────────────────────────────────────────────────────
// 逐列对齐既有训练库：插件里的查询是按这些列名写的，改列名等于改查询。
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    handle          TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    cf_handle       TEXT,
    luogu_uid       TEXT,
    nowcoder_handle TEXT
);
CREATE TABLE IF NOT EXISTS unified_submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    platform    TEXT NOT NULL CHECK(platform IN ('codeforces','luogu','nowcoder')),
    problem_id  TEXT NOT NULL,
    verdict     TEXT NOT NULL DEFAULT 'Other',
    score       INTEGER DEFAULT 0,
    time_ms     INTEGER DEFAULT 0,
    memory_kb   INTEGER DEFAULT 0,
    language    TEXT DEFAULT '',
    submitted_at TEXT,
    cf_sub_id   INTEGER,
    lg_sub_id   INTEGER,
    nc_sub_id   INTEGER
);
CREATE TABLE IF NOT EXISTS unified_problems (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform    TEXT NOT NULL CHECK(platform IN ('codeforces','luogu','nowcoder')),
    problem_id  TEXT NOT NULL,
    title       TEXT DEFAULT '',
    difficulty  REAL DEFAULT 0,
    tags        TEXT DEFAULT '',
    status      TEXT DEFAULT '',
    solved_date TEXT,
    url         TEXT DEFAULT '',
    is_library  INTEGER DEFAULT 0,
    UNIQUE(platform, problem_id)
);
CREATE TABLE IF NOT EXISTS rating_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    rating      INTEGER DEFAULT 0,
    rank        TEXT DEFAULT '',
    max_rating  INTEGER DEFAULT 0,
    recorded_at TEXT NOT NULL,
    platform    TEXT NOT NULL DEFAULT 'codeforces'
);
CREATE TABLE IF NOT EXISTS diff_rating_map (
    platform TEXT NOT NULL, diff INTEGER NOT NULL, cf_rating INTEGER NOT NULL,
    PRIMARY KEY (platform, diff)
);
CREATE INDEX IF NOT EXISTS idx_sub_user_plat ON unified_submissions(user_id, platform, problem_id);
CREATE INDEX IF NOT EXISTS idx_prob_lookup   ON unified_problems(platform, problem_id);
`

// 跨平台难度归一化：各家的难度档 → 大致等价的 CF rating。
// 13 行，是人类共识不是精确换算 —— 但它让"牛客 3 档"和"CF 1600"能比。
export const DIFF_RATING_MAP = [
  ['luogu', 1, 1000], ['luogu', 2, 1300], ['luogu', 3, 1500], ['luogu', 4, 1700],
  ['luogu', 5, 2000], ['luogu', 6, 2300], ['luogu', 7, 2600], ['luogu', 8, 3000],
  ['nowcoder', 1, 800], ['nowcoder', 2, 1200], ['nowcoder', 3, 1600],
  ['nowcoder', 4, 2000], ['nowcoder', 5, 2400],
]

// CF 的 verdict → 本库统一用词。插件判 AC 认的是 `'AC'`，**不是** CF 的 `'OK'** ——
// 不映射的话 AC 集合永远是空的，而症状是"已 AC 的题还在被推"。
const CF_VERDICT = {
  OK: 'AC',
  WRONG_ANSWER: 'WA',
  TIME_LIMIT_EXCEEDED: 'TLE',
  MEMORY_LIMIT_EXCEEDED: 'MLE',
  RUNTIME_ERROR: 'RE',
  COMPILATION_ERROR: 'CE',
  IDLENESS_LIMIT_EXCEEDED: 'ILE',
  PRESENTATION_ERROR: 'PE',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  SECURITY_VIOLATED: 'SECURITY',
  CRASHED: 'CRASHED',
  REJECTED: 'REJECTED',
}

const CF_API = 'https://codeforces.com/api'

async function cfGet(path) {
  const res = await fetch(`${CF_API}/${path}`, {
    headers: { 'User-Agent': 'acmer-coach/1.0 (training coach plugin)' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`CF API HTTP ${res.status}`)
  const body = await res.json()
  if (body.status !== 'OK') throw new Error(`CF API：${body.comment ?? '未知错误'}`)
  return body.result
}

/** 建表 + 灌难度映射表。幂等，可以反复跑。 */
export function ensureSchema(db) {
  db.exec(SCHEMA)
  const ins = db.prepare(
    'INSERT OR REPLACE INTO diff_rating_map (platform, diff, cf_rating) VALUES (?,?,?)')
  for (const [p, d, r] of DIFF_RATING_MAP) ins.run(p, d, r)
}

/**
 * 搭一个能用的数据目录：建目录、把地图拷过去、建库。
 * 已存在的东西**不覆盖** —— 用户的进度比我们的默认值重要。
 */
export function initDataDir({ dataDir, dbPath, assetsDir, DatabaseSync }) {
  const made = { dir: false, knowledge: [], db: false }
  if (!existsSync(dataDir)) { mkdirSync(dataDir, { recursive: true }); made.dir = true }

  const src = join(assetsDir, 'knowledge')
  if (existsSync(src)) {
    for (const f of readdirSync(src)) {
      if (!/\.(yaml|yml|html)$/.test(f)) continue          // 别把 LICENSE 拷进数据目录
      const dst = join(dataDir, f)
      if (existsSync(dst)) continue                        // 不覆盖已有的
      copyFileSync(join(src, f), dst)
      made.knowledge.push(f)
    }
  }

  const fresh = !existsSync(dbPath)
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try { ensureSchema(db) } finally { db.close() }
  made.db = fresh
  return made
}

/**
 * 从 CF 拉公开数据灌进本地库。**不需要登录、不需要 API key** ——
 * 用的都是 CF 的公开端点。
 *
 * @param opts.dbPath    训练库路径
 * @param opts.handle    CF handle
 * @param opts.limit     最多拉多少条提交（默认全拉）
 * @param opts.problemset 是否同时拉全题库（coach_pool 的候选池靠它）
 * @param opts.onStep    进度回调
 */
export async function syncCodeforces({ dbPath, handle, limit = 0, problemset = true, onStep = () => {}, DatabaseSync }) {
  const h = String(handle ?? '').trim()
  if (!h) throw new Error('没给 CF handle')

  const db = new DatabaseSync(dbPath)
  const stat = { user: null, submissions: 0, problems: 0, library: 0, rating: 0, note: '' }
  try {
    ensureSchema(db)

    // ── 1. 账号 + 当前 rating ─────────────────────────────────────
    onStep('拉账号信息…')
    const [info] = await cfGet(`user.info?handles=${encodeURIComponent(h)}`)
    if (!info) throw new Error(`CF 上查不到 handle「${h}」`)
    db.prepare(
      `INSERT INTO users (handle, display_name, cf_handle) VALUES (?,?,?)
       ON CONFLICT(handle) DO UPDATE SET cf_handle = excluded.cf_handle`).run(h, h, h)
    const uid = db.prepare('SELECT id FROM users WHERE handle = ?').get(h).id
    stat.user = { id: uid, handle: h, rating: info.rating ?? 0, maxRating: info.maxRating ?? 0, rank: info.rank ?? '' }

    if (info.rating) {
      db.prepare(
        `INSERT INTO rating_history (user_id, rating, rank, max_rating, recorded_at, platform)
         VALUES (?,?,?,?,?, 'codeforces')`)
        .run(uid, info.rating, info.rank ?? '', info.maxRating ?? 0, new Date().toISOString())
      stat.rating = 1
    }

    // ── 2. 提交记录 ───────────────────────────────────────────────
    // CF 的 user.status 分页给，一次最多 10000 条。倒着拉（新的在前）。
    const insSub = db.prepare(
      `INSERT OR IGNORE INTO unified_submissions
       (user_id, platform, problem_id, verdict, time_ms, memory_kb, language, submitted_at, cf_sub_id)
       VALUES (?,?,?,?,?,?,?,?,?)`)
    const insProb = db.prepare(
      `INSERT INTO unified_problems (platform, problem_id, title, difficulty, tags, url, is_library)
       VALUES ('codeforces', ?, ?, ?, ?, ?, 0)
       ON CONFLICT(platform, problem_id) DO UPDATE SET
         title = excluded.title, difficulty = excluded.difficulty,
         tags = excluded.tags, url = excluded.url`)

    const PAGE = 5000
    let from = 1, done = false
    const seenProblems = new Map()
    while (!done) {
      onStep(`拉提交记录 ${from}…`)
      const batch = await cfGet(`user.status?handle=${encodeURIComponent(h)}&from=${from}&count=${PAGE}`)
      if (!batch.length) break
      db.exec('BEGIN')
      try {
        for (const s of batch) {
          const p = s.problem ?? {}
          if (p.contestId === undefined || !p.index) continue    // 非标准题（有些 gym 题没有）
          const pid = `${p.contestId}${p.index}`
          const at = new Date((s.creationTimeSeconds ?? 0) * 1000).toISOString()
          insSub.run(
            uid, 'codeforces', pid, CF_VERDICT[s.verdict] ?? s.verdict ?? 'Other',
            s.timeConsumedMillis ?? 0, Math.round((s.memoryConsumedBytes ?? 0) / 1024),
            s.programmingLanguage ?? '', at, s.id ?? null)
          stat.submissions++
          if (!seenProblems.has(pid)) seenProblems.set(pid, p)
        }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }

      if (batch.length < PAGE) done = true
      from += PAGE
      if (limit && stat.submissions >= limit) done = true
    }

    // 提交里带出来的题目元信息（CF 会一并返回 tags / rating）
    db.exec('BEGIN')
    try {
      for (const [pid, p] of seenProblems) {
        insProb.run(pid, p.name ?? '', p.rating ?? 0, (p.tags ?? []).join(','),
          `https://codeforces.com/contest/${p.contestId}/problem/${p.index}`)
        stat.problems++
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }

    // ── 3. 全题库 → coach_pool 的候选池 ───────────────────────────
    // 只拉一次，11k 道。**这是"出卷有题可挑"的前提** ——
    // 没有它，教练只能从你做过的那几道里挑，"没做过"这个条件永远满足不了。
    if (problemset) {
      onStep('拉全题库（约 11k 道，一次性）…')
      const { problems } = await cfGet('problemset.problems')
      db.exec('BEGIN')
      try {
        for (const p of problems) {
          if (p.contestId === undefined || !p.index) continue
          const pid = `${p.contestId}${p.index}`
          db.prepare(
            `INSERT INTO unified_problems (platform, problem_id, title, difficulty, tags, url, is_library)
             VALUES ('codeforces', ?, ?, ?, ?, ?, 1)
             ON CONFLICT(platform, problem_id) DO UPDATE SET
               title = excluded.title, difficulty = excluded.difficulty,
               tags = excluded.tags, url = excluded.url, is_library = 1`)
            .run(pid, p.name ?? '', p.rating ?? 0, (p.tags ?? []).join(','),
              `https://codeforces.com/contest/${p.contestId}/problem/${p.index}`)
          stat.library++
        }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    }

    return { ...stat, dbPath }
  } finally {
    db.close()
  }
}

/**
 * 接触证据：**不是掌握度**，是"他碰过没有"。
 *
 * 用途只有一个 —— 冷启动时缩小搜索范围，好让第一次检测落在不太离谱的地方。
 * 不要拿它下结论：AC 过 20 道 dp 题说明"他见过 dp"，
 * 不说明"他会区间 DP" —— 后者只能靠检测。
 *
 * @returns [{tag, ac, tried, maxRating, minRating}] 按 AC 数降序
 */
export function contactEvidence(db, uid) {
  const rows = db.prepare(
    `SELECT p.tags AS tags, s.verdict AS verdict, p.difficulty AS difficulty
     FROM unified_submissions s
     JOIN unified_problems p
       ON p.platform = s.platform AND p.problem_id = s.problem_id
     WHERE s.user_id = ?`).all(uid)
  const byTag = new Map()
  for (const r of rows) {
    for (const t of String(r.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const e = byTag.get(t) ?? { tag: t, ac: 0, tried: 0, maxRating: 0, minRating: 0 }
      e.tried++
      if (r.verdict === 'AC') {
        e.ac++
        const d = r.difficulty ?? 0
        if (d) {
          if (!e.minRating || d < e.minRating) e.minRating = d
          if (d > e.maxRating) e.maxRating = d
        }
      }
      byTag.set(t, e)
    }
  }
  return [...byTag.values()].sort((a, b) => b.ac - a.ac || b.tried - a.tried)
}

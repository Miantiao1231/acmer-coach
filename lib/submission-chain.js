import { DatabaseSync } from 'node:sqlite'

const ID_COLUMN = {
  codeforces: 'cf_sub_id',
  luogu: 'lg_sub_id',
  nowcoder: 'nc_sub_id',
}
const ACCEPTED = new Set(['AC', 'OK', 'ACCEPTED', 'SOLVED'])
const FAILED = new Set(['WA', 'TLE', 'MLE', 'RE', 'CE', 'ILE', 'PE',
  'FAILED', 'SECURITY', 'CRASHED', 'REJECTED'])
const ANCHOR_TOLERANCE_MS = 90_000
const PRECISE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const unknown = (reason) => ({
  status: 'unknown', reason, submissions: [], attempts: null, failed: null,
  accepted: null, unresolved: null,
})

// 旧记录没有起止时间，只能提示同一天唯一的 AC；不能据此推断之前交了几发。
export function suggestAcAnchor({ dbPath, trainerHandle, platform, problemId, date } = {}) {
  if (!dbPath || !trainerHandle || !ID_COLUMN[platform] || !problemId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return { status: 'none' }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const users = db.prepare('SELECT id FROM users WHERE handle = ? OR cf_handle = ?').all(trainerHandle, trainerHandle)
    if (users.length !== 1) return { status: 'none' }
    const rows = db.prepare(`SELECT ${ID_COLUMN[platform]} AS source_id, submitted_at FROM unified_submissions
      WHERE user_id = ? AND platform = ? AND problem_id = ? AND substr(submitted_at, 1, 10) = ?
      AND upper(verdict) IN ('AC', 'OK', 'ACCEPTED', 'SOLVED')`).all(users[0].id, platform, problemId, date)
    const unique = [...new Map(rows.filter(row => row.source_id != null).map(row => [String(row.source_id), row])).values()]
    if (unique.length !== 1) return { status: unique.length ? 'ambiguous' : 'none' }
    return { status: 'candidate', submissionId: String(unique[0].source_id), submittedAt: String(unique[0].submitted_at) }
  } catch { return { status: 'none' } }
  finally { try { db?.close() } catch { /* read-only lookup */ } }
}

// 只接受能界定一次练习的时间窗。旧完成记录若只有日期，不能把同题历史提交拼进去。
export function readSubmissionChain({ dbPath, trainerHandle, platform, problemId,
  startedAt, completedAt, anchorSubmissionId } = {}) {
  if (!dbPath || !trainerHandle || !ID_COLUMN[platform] || !problemId) return unknown('missing-identity')
  if (!PRECISE_TIME.test(startedAt) || !PRECISE_TIME.test(completedAt)) return unknown('missing-time-window')
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return unknown('missing-time-window')

  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const users = db.prepare('SELECT id FROM users WHERE handle = ? OR cf_handle = ?')
      .all(trainerHandle, trainerHandle)
    if (users.length !== 1) return unknown(users.length ? 'ambiguous-user' : 'user-not-found')

    // 平台列名只来自上面的常量；题号、账号一律参数化且精确匹配。
    const rows = db.prepare(`SELECT id, verdict, submitted_at, ${ID_COLUMN[platform]} AS source_id
      FROM unified_submissions
      WHERE user_id = ? AND platform = ? AND problem_id = ?
      ORDER BY submitted_at, id`).all(users[0].id, platform, problemId)

    const bounded = rows.filter((row) => {
      const at = Date.parse(row.submitted_at)
      return Number.isFinite(at) && at >= start && at <= end + ANCHOR_TOLERANCE_MS
    })
    // 本地训练库目前没有平台提交 ID 唯一索引；同步重跑可能产生重复行。
    const unique = new Map()
    for (const row of bounded) {
      const key = row.source_id == null ? `local:${row.id}` : `source:${row.source_id}`
      unique.set(key, row)
    }
    const submissions = [...unique.values()].sort((a, b) =>
      Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id)
    const ac = submissions.filter((row) => ACCEPTED.has(String(row.verdict).toUpperCase()))
    const anchors = anchorSubmissionId == null
      ? ac.filter((row) => Math.abs(Date.parse(row.submitted_at) - end) <= ANCHOR_TOLERANCE_MS)
      : ac.filter((row) => row.source_id != null && String(row.source_id) === String(anchorSubmissionId))
    if (anchors.length !== 1) return unknown(anchors.length ? 'ambiguous-anchor' : 'anchor-not-synced')

    const anchor = anchors[0]
    const anchorAt = Date.parse(anchor.submitted_at)
    const chain = submissions.filter((row) =>
      Date.parse(row.submitted_at) < anchorAt ||
      (Date.parse(row.submitted_at) === anchorAt && row.id <= anchor.id))
    return {
      status: 'linked', reason: '',
      submissions: chain.map((row) => ({
        submissionId: row.source_id == null ? null : row.source_id,
        verdict: row.verdict,
        submittedAt: row.submitted_at,
      })),
      attempts: chain.length,
      failed: chain.filter((row) => FAILED.has(String(row.verdict).toUpperCase())).length,
      accepted: chain.filter((row) => ACCEPTED.has(String(row.verdict).toUpperCase())).length,
      unresolved: chain.filter((row) => !ACCEPTED.has(String(row.verdict).toUpperCase()) &&
        !FAILED.has(String(row.verdict).toUpperCase())).length,
    }
  } catch {
    return unknown('database-unavailable')
  } finally {
    try { db?.close() } catch { /* 关闭失败不覆盖查询结果 */ }
  }
}

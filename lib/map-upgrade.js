// 随包地图升级。
//
// 问题：coach_setup init 把 MAP.yaml 拷到用户目录后就不再管它。之后插件修了
// 前置边、改了段位、补了题池，老用户永远拿不到 —— 而 MAP 是运行时的真相源。
//
// 办法：记下「我们上一次发出去的是哪一版」（.map-shipped.json 里的哈希）。
//   · 用户没动过 → 直接换新，旧图留一份 .prev 可回退
//   · 用户改过 → 一个字都不动，写一份差异报告等他合并
//   · 来源不明（这个功能上线前装的老用户）→ 只认已知的随包哈希，其余按改过处理
// 识别不了的宁可不动 —— 覆盖用户手改的图比拿到旧版更糟。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

export const MAP_SHIPPED_FILE = '.map-shipped.json'
export const MAP_REPORT_FILE = 'MAP-upgrade-report.json'
export const MAP_BACKUP_FILE = 'MAP.yaml.prev'

const DIFF_FIELDS = ['name', 'domain', 'depends', 'tier', 'entry', 'pool', 'parent']
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function nodesOf(text) {
  try {
    const doc = parse(text)
    return new Map((Array.isArray(doc?.nodes) ? doc.nodes : []).filter((n) => n && n.id).map((n) => [String(n.id), n]))
  } catch { return new Map() }
}

export function diffMaps(beforeText, afterText) {
  const before = nodesOf(beforeText), after = nodesOf(afterText)
  const added = [...after.keys()].filter((id) => !before.has(id)).sort()
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort()
  const changed = []
  for (const id of [...before.keys()].filter((key) => after.has(key)).sort()) {
    const fields = {}
    for (const field of DIFF_FIELDS) {
      const a = JSON.stringify(before.get(id)[field] ?? null)
      const b = JSON.stringify(after.get(id)[field] ?? null)
      if (a !== b) fields[field] = { before: before.get(id)[field] ?? null, after: after.get(id)[field] ?? null }
    }
    if (Object.keys(fields).length) changed.push({ id, fields })
  }
  return { addedNodes: added, removedNodes: removed, changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length } }
}

export function syncPackagedMap({ dataDir, packagedPath, legacyHashes = [], pluginVersion = '', now = () => new Date() }) {
  const destination = join(dataDir, 'MAP.yaml')
  const shippedPath = join(dataDir, MAP_SHIPPED_FILE)
  const reportPath = join(dataDir, MAP_REPORT_FILE)
  const packagedBytes = readFileSync(packagedPath)
  const packagedHash = sha256(packagedBytes)
  const at = now().toISOString()
  const recordShipped = (hash) => writeFileSync(shippedPath,
    JSON.stringify({ version: 1, file: 'MAP.yaml', shippedHash: hash, pluginVersion, at }, null, 2) + '\n', 'utf8')
  const dropReport = () => { try { rmSync(reportPath, { force: true }) } catch { /* 报告删不掉不影响升级 */ } }

  if (!existsSync(destination)) {
    copyFileSync(packagedPath, destination)
    recordShipped(packagedHash)
    dropReport()
    return { action: 'installed' }
  }

  const currentText = readFileSync(destination, 'utf8')
  const currentHash = sha256(currentText)
  if (currentHash === packagedHash) {
    recordShipped(packagedHash)
    dropReport()
    return { action: 'current' }
  }

  const shipped = readJson(shippedPath)
  const knownShipped = shipped && shipped.file === 'MAP.yaml' && typeof shipped.shippedHash === 'string'
    ? shipped.shippedHash : null
  // GitHub Actions publishes LF, while a Windows checkout may have CRLF.
  const untouched = knownShipped ? currentHash === knownShipped
    : legacyHashes.includes(currentHash) || legacyHashes.includes(sha256(currentText.replace(/\r?\n/g, '\r\n')))

  if (untouched) {
    copyFileSync(destination, join(dataDir, MAP_BACKUP_FILE))
    copyFileSync(packagedPath, destination)
    recordShipped(packagedHash)
    dropReport()
    return { action: 'upgraded', backup: MAP_BACKUP_FILE }
  }

  const diff = diffMaps(currentText, packagedBytes.toString('utf8'))
  const fingerprint = sha256(JSON.stringify(diff))
  const previous = readJson(reportPath)
  if (previous?.fingerprint !== fingerprint) {
    writeFileSync(reportPath, JSON.stringify({
      version: 1, file: 'MAP.yaml', at, pluginVersion, fingerprint,
      // 差异方向：左=你的图，右=随包地图。addedNodes 是新包里多出来的；
      // removedNodes 是「你图里有、新包没有」（可能是包删的，也可能是你自己加的）。
      reason: '本地地图被改过（或来源不明），本次未覆盖；下面按「你的图 → 随包地图」列出差异，需要手工合并。',
      from: { shippedHash: knownShipped || '', currentHash },
      to: { packagedHash },
      ...diff,
    }, null, 2) + '\n', 'utf8')
  }
  return { action: 'conflict', report: { ...diff, fingerprint } }
}

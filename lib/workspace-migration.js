import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PERSONAL_FILES = ['PROGRESS.yaml', 'CURRICULUM.yaml', 'SCHEDULE.yaml', 'TARGET.yaml']

function copyMissing(from, to) {
  try { copyFileSync(from, to, constants.COPYFILE_EXCL); return true }
  catch (err) { if (err.code === 'EEXIST') return false; throw err }
}

export function migratePersonalWorkspace(dataDir, accountId) {
  if (!accountId) return []
  const id = String(accountId)
  if (!/^[1-9]\d*$/.test(id)) throw new Error('个人文件迁移需要合法的正整数 VP 账号 id。')
  const sourceDir = join(dataDir, 'vp-accounts', id)
  const marker = join(sourceDir, 'PERSONAL_MIGRATION.json')
  if (!existsSync(sourceDir) || existsSync(marker)) return []
  const migrated = [], files = {}
  for (const file of PERSONAL_FILES) {
    const from = join(sourceDir, file), to = join(dataDir, file)
    if (!existsSync(from)) { files[file] = 'source-missing'; continue }
    if (copyMissing(from, to)) {
      files[file] = 'filled-missing'
      migrated.push(file)
    } else if (readFileSync(from).equals(readFileSync(to))) {
      files[file] = 'identical'
    } else {
      // File modification times cannot tell which version the learner intended to keep.
      const backup = `${to}.from-vp-account-${id}`
      if (copyMissing(from, backup)) migrated.push(`${file}（账号冲突副本已备份，主账本保留）`)
      files[file] = 'conflict-preserved'
    }
  }
  try {
    writeFileSync(marker, JSON.stringify({ version: 1, accountId: id, completedAt: new Date().toISOString(), files }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  } catch (err) { if (err.code !== 'EEXIST') throw err }
  return migrated
}

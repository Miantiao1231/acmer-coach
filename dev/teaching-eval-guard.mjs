import fs from 'node:fs'
import { isAbsolute, resolve, relative, dirname, join, sep } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sqlite from 'node:sqlite'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { AsyncLocalStorage } from 'node:async_hooks'

export function nativePermissionArgs(root) {
  if (!root || !isAbsolute(root)) throw new Error('验收目录必须是绝对路径。')
  // Node permissions prevent trusted runtime misuse; this is not an OS sandbox.
  // dsh's host loader requires its installed native module-loader addon.
  // This is trusted-runtime misuse protection, not a malicious-code sandbox.
  return ['--permission', '--allow-addons', '--allow-fs-read=*', `--allow-fs-write=${resolve(root)}`, '--import', pathToFileURL(import.meta.filename).href]
}

const within = (root, path) => {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}
function canonical(value) {
  let path = resolve(value instanceof URL ? fileURLToPath(value) : String(value)), suffix = []
  while (!fs.existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('无法确认路径边界。')
    suffix.unshift(path.slice(parent.length).replace(/^[/\\]/, '')); path = parent
  }
  return join(fs.realpathSync(path), ...suffix)
}
export function evaluationPolicy(config) {
  const root = canonical(config.root)
  for (const path of [config.home, config.data, config.db]) {
    if (!path || !isAbsolute(path) || !within(root, canonical(path))) throw new Error('DSH_HOME/COACH_DATA_DIR/COACH_DB 必须在专用验收目录中。')
  }
  if (!/^coach-eval-[a-f0-9-]{36}$/.test(config.bank) || config.bank === config.formalBank) throw new Error('需要唯一的验收 bank，不能使用正式 bank。')
  const memory = new URL(config.memoryURL), model = new URL(config.modelURL)
  for (const url of [memory, model]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('endpoint 必须是不含凭据的 HTTP(S) URL。')
  }
  if (memory.origin === model.origin) throw new Error('模型与记忆服务必须使用不同 origin。')
  const memoryPath = `/v1/default/banks/${config.bank}`
  return {
    root,
    assertWrite(path) {
      if (typeof path === 'number' || !within(root, canonical(path))) throw Object.assign(new Error('验收禁止向专用目录外写入。'), { code: 'ERR_ACCESS_DENIED' })
    },
    assertURL(value) {
      const url = new URL(value)
      const inBank = url.origin === memory.origin && (url.pathname === memoryPath || url.pathname.startsWith(memoryPath + '/'))
      if (!inBank && url.origin !== model.origin) throw new Error('验收 endpoint 或 Hindsight bank 越界。')
      if (url.username || url.password) throw new Error('endpoint 不可携带 URL 凭据。')
      return url
    },
  }
}

export function installEvaluationGuard(config) {
  const policy = evaluationPolicy(config), append = fs.appendFileSync
  const audit = text => append(join(policy.root, 'isolation-audit.log'), `${new Date().toISOString()} ${text}\n`)
  const write = path => {
    try { policy.assertWrite(path) } catch (error) { audit('BLOCKED filesystem'); throw error }
  }
  // Node permissions do not cover SQLite, and lexical paths can cross existing junctions.
  for (const name of ['writeFile', 'appendFile', 'truncate', 'unlink', 'mkdir', 'rmdir', 'rm', 'chmod', 'chown', 'utimes', 'lutimes', 'mkdtemp']) {
    for (const key of [name, name + 'Sync']) if (typeof fs[key] === 'function') {
      const original = fs[key]; fs[key] = function (path, ...args) { write(path); return original.call(this, path, ...args) }
    }
    if (typeof fs.promises[name] === 'function') {
      const original = fs.promises[name]; fs.promises[name] = async function (path, ...args) { write(path); return original.call(this, path, ...args) }
    }
  }
  for (const name of ['rename', 'copyFile', 'cp']) {
    for (const owner of [fs, fs.promises]) for (const key of owner === fs ? [name, name + 'Sync'] : [name]) {
      const original = owner[key]
      if (original) owner[key] = function (from, to, ...args) {
        // Runtime has no need to recursively copy trees; nested destination links defeat a top-level path check.
        if (name === 'cp' && args[0]?.recursive === true) { audit('BLOCKED recursive copy'); throw Object.assign(new Error('验收运行不执行递归复制。'), { code: 'ERR_ACCESS_DENIED' }) }
        if (name === 'rename') write(from); write(to); return original.call(this, from, to, ...args)
      }
    }
  }
  for (const owner of [fs, fs.promises]) for (const key of owner === fs ? ['link', 'linkSync', 'symlink', 'symlinkSync'] : ['link', 'symlink']) {
    owner[key] = () => { audit('BLOCKED filesystem link'); throw Object.assign(new Error('验收运行不创建链接。'), { code: 'ERR_ACCESS_DENIED' }) }
  }
  for (const owner of [fs, fs.promises]) for (const key of owner === fs ? ['open', 'openSync'] : ['open']) {
    const original = owner[key]
    owner[key] = function (path, flags, ...args) {
      if (typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags || 'r')) write(path)
      return original.call(this, path, flags, ...args)
    }
  }
  const stream = fs.createWriteStream
  fs.createWriteStream = function (path, options) { write(path); return stream.call(this, path, options) }
  const DatabaseSync = sqlite.DatabaseSync
  if (typeof DatabaseSync.prototype.setAuthorizer !== 'function') throw new Error('手动验收需要支持 SQLite setAuthorizer 的 Node（本机验证为24.18）；不降级放开数据库权限。')
  sqlite.DatabaseSync = class extends DatabaseSync {
    constructor(path, options = {}) {
      if (path !== ':memory:') write(path)
      super(path, options)
      super.setAuthorizer((action, name, value) => action === sqlite.constants.SQLITE_ATTACH
        || (action === sqlite.constants.SQLITE_PRAGMA && value != null && ['temp_store_directory', 'data_store_directory'].includes(String(name).toLowerCase()))
        ? sqlite.constants.SQLITE_DENY : sqlite.constants.SQLITE_OK)
    }
    setAuthorizer() { throw new Error('验收实例不能替换数据库安全门禁。') }
  }
  const network = new AsyncLocalStorage()
  for (const [owner, names] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']]]) {
    for (const name of names) {
      const original = owner[name]
      owner[name] = function (...args) {
        if (!network.getStore()) { audit('BLOCKED direct network'); throw new Error('验收网络只允许通过受限 fetch。') }
        return original.apply(this, args)
      }
    }
  }
  const fetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    let url
    try { url = policy.assertURL(typeof input === 'string' || input instanceof URL ? input : input.url) }
    catch (error) { audit('BLOCKED network'); throw error }
    audit(`network ${url.origin === new URL(config.memoryURL).origin ? 'memory ' + url.pathname : 'model'}`)
    // Never follow an allowed endpoint's redirect into another origin or bank.
    return network.run(true, () => fetch(input, { ...init, redirect: 'error' }))
  }
  syncBuiltinESMExports()
  return policy
}

if (process.env.COACH_EVAL_GUARD === '1') installEvaluationGuard({
  root: process.env.COACH_EVAL_ROOT, home: process.env.DSH_HOME, data: process.env.COACH_DATA_DIR, db: process.env.COACH_DB,
  bank: process.env.HINDSIGHT_BANK, formalBank: process.env.COACH_EVAL_FORMAL_BANK,
  memoryURL: process.env.HINDSIGHT_URL, modelURL: process.env.COACH_EVAL_MODEL_URL,
})

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import YAML from 'yaml'
import { evaluationPolicy, nativePermissionArgs } from './teaching-eval-guard.mjs'

export const CASES = ['continuity', 'repair', 'replan', 'contest']
export function parseArgs(args) {
  const options = { mode: 'help' }
  if (args.includes('--help')) return options
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--prepare' || flag === '--run') {
      if (options.mode !== 'help') throw new Error('只选择 --prepare 或 --run 一种模式。')
      options.mode = flag.slice(2)
      if (flag === '--run') {
        options.directory = args[++i]
        if (!options.directory || options.directory.startsWith('--')) throw new Error('--run 需要已准备的目录。')
      }
    } else if (flag === '--case' || flag === '--out') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个值。`)
      options[flag === '--case' ? 'caseId' : 'out'] = value
    } else throw new Error(`未知参数：${flag}`)
  }
  if (options.caseId && !CASES.includes(options.caseId)) throw new Error(`--case 只能是 ${CASES.join('、')}。`)
  if (options.caseId && options.mode !== 'run') throw new Error('--case 需要 --run。')
  if (options.out && options.mode !== 'prepare') throw new Error('--out 仅用于 --prepare。')
  return options
}

export function sanitizeEvidence(value, secrets = []) {
  if (typeof value === 'string') {
    let text = value
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]')
    return text.replace(/([?&]token=)[^\s"'&]+/gi, '$1[redacted]')
      .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
      .replace(/((?:cookie|api[_-]?key|authorization)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
  }
  if (Array.isArray(value)) return value.filter(item => item?.type !== 'reasoning').map(item => sanitizeEvidence(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/reasoning|replayState|stream|cookie|api[_-]?key|authorization|credential|^token$/i.test(key))
    .map(([key, item]) => [key, sanitizeEvidence(item, secrets)]))
  return value
}

export function inspectTurn(page, afterSeq = -1, secrets = []) {
  const events = (page?.records || []).filter(record => record.type === 'event').map(record => record.event)
    .filter(event => Number.isInteger(event?.seq) && event.seq > afterSeq)
  const lastEnd = events.filter(event => event.type === 'turn/end').at(-1)
  const replies = events.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
    .filter(message => !message?.content?.some(block => block.type === 'tool-call'))
    .map(message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')).filter(Boolean)
  return sanitizeEvidence({ mechanical: { completed: lastEnd?.data?.reason?.kind === 'completed',
    hasReply: replies.length > 0, studentInputs: events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user').length },
  reply: replies.at(-1) || '', events }, secrets)
}

const sourceRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) }
const digest = (root, files) => createHash('sha256').update(files.map(path => {
  const absolute = resolve(root, path)
  if (!inside(root, absolute) || !inside(root, realpathSync(absolute))) throw new Error('公开包文件越界。')
  return `${path}\0${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`
}).join('\n')).digest('hex')
const save = (path, value, secrets = []) => writeFileSync(path, JSON.stringify(sanitizeEvidence(value, secrets), null, 2) + '\n')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const snapshotLedger = data => Object.fromEntries(['PROGRESS.yaml', 'CURRICULUM.yaml', 'SCHEDULE.yaml', 'TARGET.yaml'].map(name => {
  const path = join(data, name)
  return [name, existsSync(path) ? { exists: true, text: readFileSync(path, 'utf8') } : { exists: false }]
}))
const teachingText = turn => (turn.events || []).filter(event => event.type === 'assistant/message')
  .map(event => (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n'))
  .filter(Boolean).join('\n\n---\n\n') || turn.reply

function runtimePaths() {
  const require = createRequire(join(sourceRoot, 'package.json'))
  let cli = process.env.DSH_EVAL_CLI
  if (!cli) try { cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js') } catch {}
  if (!cli || !existsSync(cli)) throw new Error('请设置 DSH_EVAL_CLI 为已安装 dsh 的原生 lib/bin.js。')
  cli = realpathSync(resolve(cli))
  const cliRequire = createRequire(cli)
  const modules = realpathSync(resolve(process.env.DSH_APP_NODE_MODULES || dirname(dirname(dirname(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))))))
  if (!existsSync(join(modules, '@deepseek-ai', 'dsh-base', 'package.json'))) throw new Error('DSH_APP_NODE_MODULES 缺少原生 dsh 依赖。')
  for (const name of ['dsh-base', 'dsh-tools']) {
    if (realpathSync(cliRequire.resolve(`@deepseek-ai/${name}/package.json`)) !== realpathSync(join(modules, '@deepseek-ai', name, 'package.json')))
      throw new Error('dsh CLI 与依赖必须来自同一套安装，不能混用 desktop 和全局 npm SDK。')
  }
  return { cli, modules, yaml: dirname(require.resolve('yaml/package.json')) }
}

export async function prepareEvaluation(parent = tmpdir()) {
  const paths = runtimePaths(), destination = resolve(parent)
  mkdirSync(destination, { recursive: true })
  const root = mkdtempSync(join(realpathSync(destination), 'coach-teaching-eval-'))
  const npmCLI = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => typeof path === 'string' && path.endsWith('.js') && existsSync(path))
  if (!npmCLI) throw new Error('请通过 npm run eval:teaching 启动 prepare，以定位 npm CLI。')
  const pack = spawnSync(process.execPath, [npmCLI, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: sourceRoot, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
  })
  if (pack.status !== 0) throw new Error('无法取得 npm 公开包文件清单。')
  const files = JSON.parse(pack.stdout)[0].files.map(file => file.path).sort()
  const fingerprint = digest(sourceRoot, files), packageInfo = read(join(sourceRoot, 'package.json'))
  const model = { provider: 'deepseek-official', model: process.env.COACH_EVAL_MODEL || 'deepseek-flash', reasoningEffort: process.env.COACH_EVAL_REASONING || 'max' }
  const modelURL = process.env.COACH_EVAL_MODEL_URL || 'https://api.deepseek.com/anthropic'
  const memoryURL = process.env.HINDSIGHT_URL || 'http://127.0.0.1:18888'
  const cases = []
  for (const id of CASES) {
    const caseRoot = join(root, id), home = join(caseRoot, 'home'), data = join(home, 'knowledge'), db = join(caseRoot, 'training.db')
    const modules = join(home, 'profiles', 'web', 'node_modules'), runtime = join(modules, 'acmer-coach'), bank = `coach-eval-${randomUUID()}`
    evaluationPolicy({ root: caseRoot, home, data, db, bank, memoryURL, modelURL })
    for (const path of files) { const target = join(runtime, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(sourceRoot, path))) }
    if (digest(runtime, files) !== fingerprint) throw new Error('公开包副本指纹不一致。')
    symlinkSync(join(paths.modules, '@deepseek-ai'), join(modules, '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(paths.yaml, join(modules, 'yaml'), process.platform === 'win32' ? 'junction' : 'dir')
    const profile = dirname(modules)
    save(join(profile, 'package.json'), { name: 'coach-teaching-eval', version: '0.0.0', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'acmer-coach'] } } })
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'evaluation-tools.mjs'), `export const inject=['tools']; export function apply(ctx){ctx.tools.guard(exec => /^(bash|pwsh|subagent.*|.*workflow.*|run_code|ralph)$/.test(exec.name) ? '教学验收禁用进程、委派和工作流工具。' : undefined)}\n`)
    writeFileSync(join(profile, 'cordis.patch.yml'), YAML.stringify([
      { id: 'agent-default-model', config: model }, { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: modelURL } },
      { id: 'llm-deepseek-account', disabled: true }, { id: 'session-title-llm', disabled: true }, { id: 'llm-retry', disabled: true },
      { insert: [{ id: 'evaluation-tools', name: './evaluation-tools.mjs' }] },
    ]))
    const { initDataDir, importPool } = await import(pathToFileURL(join(runtime, 'lib', 'setup.js')).href)
    initDataDir({ dataDir: data, dbPath: db, assetsDir: join(runtime, 'assets'), DatabaseSync })
    importPool({ dbPath: db, poolPath: join(runtime, 'assets', 'pool', 'problems.jsonl.gz'), DatabaseSync })
    const map = YAML.parse(readFileSync(join(data, 'MAP.yaml'), 'utf8'))
    const node = map.nodes.find(node => node.name === '背包 DP')
    if (!node) throw new Error('随包地图缺少背包 DP，不能替换成无关知识点。')
    const fixtureTime = new Date(Date.now() - 86400000).toISOString()
    writeFileSync(join(data, 'PROGRESS.yaml'), YAML.stringify({ version: 1, cursor: node.id, updated: fixtureTime.slice(0, 10), nodes: { [node.id]: {
      status: 'studying', lessonNotes: [{ at: fixtureTime, summary: '[人工夹具，非真实跨日教学] 昨日谈到状态是否保存选择顺序；尚未核对理解。', nextStep: '先用一个物品的最小例子核对更新方向。', studentEvidence: null }],
    } } }))
    cases.push({ id, root: caseRoot, home, data, db, runtime, bank, fixture: { node: node.id, at: fixtureTime, synthetic: true } })
  }
  const manifest = { version: 1, preparedAt: new Date().toISOString(), source: sourceRoot, coachVersion: packageInfo.version,
    fingerprint, files, paths, model, modelURL, memoryURL, preset: 'acmer-coach-xiaojing', cases }
  save(join(root, 'runtime-manifest.json'), manifest)
  writeFileSync(join(root, '.gitignore'), '*\n')
  save(join(root, 'report.json'), { mechanical: { prepared: true, sourceMatchesRuntime: true, cases: cases.map(item => ({ id: item.id, bank: item.bank, run: 'not-run' })) },
    teaching: { status: 'not-scored', method: '人工阅读真实对话；机械检查不代表教学效果通过。' } })
  return root
}

const prompts = {
  continuity: [
    '这是隔离教学验收：账本里的“昨日笔记”是人工夹具，不是真实跨日教学。我今天有25分钟，喜欢先最小反例再推理。请接着笔记教我0/1背包的更新方向，先让我解释，不给完整代码，不把笔记当掌握证据。不要调用终端、委派或工作流。',
    '这是一个新会话，请接着上次留下的续课笔记。我的解释是：正序时，当前物品更新的新状态又被本轮读取，所以一个物品可能用多次。我还分不清容量为0和恰好装满的初始化。请根据这句原话继续检查，结束时留下尚未核对的点和下次接法。',
  ],
  repair: [
    '我写0/1背包时用 for(j=w;j<=W;j++) dp[j]=max(dp[j],dp[j-w]+v)，结果一个物品可能被算两遍。请先用最小例子让我找到根因，再让我说不变量；不要直接给整段答案。不要调用终端、委派或工作流。',
    '我试着解释：倒序保证dp[j-w]还是上一轮的值，j<w不转移。可是“至多容量”和“必须恰好装满”好像初始化不同，我还没懂。请核对我已说出的部分，不要因此宣称我已经掌握。',
  ],
  replan: [
    '原计划今天训练60分钟，但我现在只剩15分钟。背包更新方向仍说不清，也没独立写代码。请根据实际表现缩小今天目标，解释保留什么、推迟什么，不把未完成的旧计划算作进展。不要调用终端、委派或工作流。',
    '刚做了口头复测：一个物品重2、价值3，容量4。正序会得到6，因为用了本轮刚更新的状态；倒序得到3。但我还不会恰好装满的初始化，也没实写代码。这不是独立AC或编译判卷。请根据这次复测和剩余5分钟重新安排收尾，记录仍未核对的点，不替我判通过。',
  ],
  contest: [
    '我们是区域赛铜牌水平，五小时 13 题做出 4 题。剩下 9 题我没逐题看，后半场有一段没有提交。请判断这场 VP 暴露了什么训练问题；你只有这些信息。不要调用终端、委派或工作流。',
    '补充：最后 35 分钟队里有 B 和 C 两个可选题；B 已写出主体，在调边界，C 还没形成做法。请评价当时继续调 B 的决策，也说明还缺什么事实才能下结论。',
  ],
}

async function runCase(manifest, item) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('付费 --run 需要环境变量 DEEPSEEK_API_KEY；不会读取个人 credentials 文件。')
  const root = realpathSync(item.root)
  if (root !== item.root || digest(item.runtime, manifest.files) !== manifest.fingerprint) throw new Error('验收路径或运行副本与准备清单不一致。')
  evaluationPolicy({ ...item, root, memoryURL: manifest.memoryURL, modelURL: manifest.modelURL })
  writeFileSync(join(root, 'run-once.lock'), new Date().toISOString(), { flag: 'wx' })
  const secrets = [process.env.DEEPSEEK_API_KEY, process.env.HINDSIGHT_API_KEY].filter(Boolean)
  let child, cookie = '', turns = [], port
  // The controller runs outside the restricted native child and contacts only its loopback RPC.
  const { createServer } = await import('node:net')
  const listener = createServer(); await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done) })
  port = listener.address().port; await new Promise(done => listener.close(done))
  const temp = join(root, 'tmp'); mkdirSync(temp, { recursive: true })
  const env = { ...process.env, DSH_HOME: item.home, COACH_DATA_DIR: item.data, COACH_DB: item.db, TEMP: temp, TMP: temp, TMPDIR: temp,
    COACH_HINDSIGHT: '1', HINDSIGHT_BANK: item.bank, HINDSIGHT_URL: manifest.memoryURL,
    COACH_EVAL_GUARD: '1', COACH_EVAL_ROOT: root, COACH_EVAL_MODEL_URL: manifest.modelURL, DSH_TELEMETRY_DISABLED: '1' }
  delete env.NODE_OPTIONS; delete env.DSH_SYSTEM_PROMPT; delete env.DEEPSEEK_BASE_URL
  try {
    child = spawn(process.execPath, [...nativePermissionArgs(root), manifest.paths.cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const startURL = await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('原生RPC启动超过60秒，不重试。')), 60000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`原生RPC提前退出：${code}`)) })
      for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
        for (const candidate of line.match(/https?:\/\/[^\s\u001b]+/g) || []) try {
          const url = new URL(candidate)
          if (url.hostname === '127.0.0.1' && url.port === String(port) && url.searchParams.has('token')) {
            secrets.push(url.searchParams.get('token')); clearTimeout(timer); ready(url.href)
          }
        } catch {}
        appendFileSync(join(root, 'server.log'), sanitizeEvidence(line, secrets) + '\n')
      })
    })
    const auth = await fetch(startURL, { headers: { connection: 'close' }, redirect: 'manual', signal: AbortSignal.timeout(10000) })
    cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (!cookie) throw new Error('原生RPC没有返回本地认证cookie。')
    secrets.push(cookie, ...cookie.split('; ').map(value => value.slice(value.indexOf('=') + 1)))
    const rpc = async (method, request) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, connection: 'close' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { [method === 'session/list' ? '_request' : 'request']: request } } }), signal: AbortSignal.timeout(20000) })
      const data = await response.json()
      if (!response.ok || !data.result?.ok) throw new Error(`原生RPC拒绝 ${method}（HTTP ${response.status}），不重试。`)
      return data.result.value
    }
    const created = await rpc('session/create', { cwd: root, agentPreset: manifest.preset })
    let sessionId = created.sessionId || created.id || created.session?.id
    if (!sessionId) throw new Error('原生RPC未返回session身份。')
    for (const input of prompts[item.id].slice(0, 3)) {
      if (item.id === 'continuity' && turns.length === 1) {
        const next = await rpc('session/create', { cwd: root, agentPreset: manifest.preset })
        const nextId = next.sessionId || next.id || next.session?.id
        if (!nextId || nextId === sessionId) throw new Error('续课验收必须创建独立的新会话。')
        sessionId = nextId
      }
      const find = list => list.items.find(value => value.id === sessionId || value.sessionId === sessionId)
      const before = find(await rpc('session/list', {})), oldSeq = before?.projections?.asOfSeq ?? -1
      const ledgerBefore = snapshotLedger(item.data)
      await rpc('session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: input }], clientTimeZone: 'Asia/Shanghai' })
      const started = Date.now(); let state
      do {
        await new Promise(done => setTimeout(done, 1000))
        state = find(await rpc('session/list', {}))
        const queued = Object.values(state?.projections?.values?.inbox || {}).some(queue => Array.isArray(queue) && queue.length)
        if (state && !state.running && !queued && state.projections?.asOfSeq > oldSeq) break
      } while (Date.now() - started < 240000)
      if (!state || state.running || state.projections?.asOfSeq <= oldSeq) throw new Error('本轮4分钟内未完成；停止场次，不重试。')
      const page = await rpc('session/page', { address: { kind: 'session', sessionId }, throughSeq: state.projections.asOfSeq, maxMessages: 100, turnWindow: { minMessages: 1, minTurns: 1 } })
      const evidence = inspectTurn(page, oldSeq, secrets)
      const turn = { sessionId, input, elapsedSeconds: Math.round((Date.now() - started) / 1000), ...evidence,
        ledger: { before: ledgerBefore, after: snapshotLedger(item.data) } }
      turns.push(turn); save(join(root, `turn-${turns.length}.json`), turn, secrets)
      if (!evidence.mechanical.completed || !evidence.mechanical.hasReply) throw new Error('Native轮次未完成或无最终答复，停止场次。')
    }
    const memoryLog = join(item.home, 'data', 'acmer-coach', 'hindsight.log')
    let accepted = 0, failed = 0
    if (existsSync(memoryLog)) for (let poll = 0; poll < 15; poll++) {
      const log = readFileSync(memoryLog, 'utf8')
      accepted = (log.match(/retain-accepted\b/g) || []).length
      failed = (log.match(/retain-fail\b/g) || []).length
      if (accepted + failed >= turns.length) break
      await new Promise(done => setTimeout(done, 200))
    }
    save(join(root, 'result.json'), { case: item.id, bank: item.bank, runtimeFingerprint: manifest.fingerprint,
      mechanical: { finished: true, studentInputs: turns.length, withinInputLimit: turns.length <= 3 },
      memory: { accepted, failed, pending: Math.max(0, turns.length - accepted - failed),
        note: 'accepted仅证明后端接收，未确认时保持未知；不等于提炼已完成。' },
      teaching: { status: 'not-scored', rubric: ['核对学生原话与错误根因', '用最小例子推进推理', '根据实际回应调整计划', '保留未完成处且不虚报掌握'] }, turns }, secrets)
  } catch (error) {
    save(join(root, 'result.json'), { case: item.id, mechanical: { finished: false, studentInputs: turns.length }, teaching: { status: 'not-scored' }, error: error.message, turns }, secrets)
    throw new Error(sanitizeEvidence(error.message, secrets))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(done => {
      const timer = setTimeout(done, 5000)
      child.once('exit', () => { clearTimeout(timer); done() })
      child.kill()
    })
  }
}

export async function runEvaluation(directory, caseId) {
  const root = realpathSync(resolve(directory)), manifest = read(join(root, 'runtime-manifest.json'))
  if (manifest.version !== 1 || manifest.source !== sourceRoot || digest(sourceRoot, manifest.files) !== manifest.fingerprint) throw new Error('准备清单与当前源码不一致，请重新 --prepare。')
  const selected = manifest.cases.filter(item => !caseId || item.id === caseId)
  if (!selected.length || selected.some(item => !CASES.includes(item.id) || !inside(root, realpathSync(item.root)))) throw new Error('场次清单越界。')
  try { for (const item of selected) await runCase(manifest, item) }
  finally {
  const results = manifest.cases.map(item => existsSync(join(item.root, 'result.json')) ? read(join(item.root, 'result.json')) : { case: item.id, turns: [], mechanical: { run: 'not-run' } })
  save(join(root, 'report.json'), { source: manifest.source, runtimeFingerprint: manifest.fingerprint,
    mechanical: results.map(result => ({ case: result.case, ...result.mechanical })),
    teaching: { status: 'not-scored', method: '请按文档人工阅读turn证据，不用机械字段代替教学评分。' } })
  writeFileSync(join(root, 'report.md'), '# 真实教学验收证据\n\n机械完成与教学效果分别判定；下列教学结果均未自动评分。昨日时间为人工夹具，本轮不证明真实跨日学习。\n\n'
    + '| 场景 | 机械完成 | 学生输入 | 教学判定 |\n|---|---|---|---|\n'
    + results.map(result => `| ${result.case} | ${result.mechanical.finished ? '完成' : '未完成／未运行'} | ${result.mechanical.studentInputs ?? 0} | 待人工核对 |`).join('\n')
    + results.map(result => `\n\n## ${result.case}\n\n`
      + result.turns.map((turn, index) => `### 第 ${index + 1} 轮 · session ${turn.sessionId}\n\n学生：${turn.input}\n\n${teachingText(turn)}\n`).join('\n')
      + '\n- [ ] 原话与学习结论相符\n- [ ] 反例与推理正确且回应新误解\n- [ ] 时间与下一步随表现调整\n- [ ] 账本未虚报独立性或掌握\n').join(''))
  }
  return root
}

const HELP = `手动教学验收（默认不调用模型）\n  node dev/teaching-eval.mjs --prepare [--out <父目录>]\n  node dev/teaching-eval.mjs --run <准备目录> [--case continuity|repair|replan|contest]\n--prepare只复制公开包并生成独立夹具；--run使用模型和专用Hindsight bank，可能付费。\n每场串行运行一次，固定2次学生输入（上限3），不自动重试。DEEPSEEK_API_KEY只从环境读取。\n配置：DSH_EVAL_CLI、DSH_APP_NODE_MODULES、COACH_EVAL_MODEL、COACH_EVAL_REASONING、COACH_EVAL_MODEL_URL。\n`
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.mode === 'help') console.log(HELP)
    else console.log(await (options.mode === 'prepare' ? prepareEvaluation(options.out) : runEvaluation(options.directory, options.caseId)))
  } catch (error) { console.error(sanitizeEvidence(error.message, [process.env.DEEPSEEK_API_KEY, process.env.HINDSIGHT_API_KEY])); process.exitCode = 1 }
}

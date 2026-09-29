// W1 行为验收：四个硬编码常量解绑后，还认不认路。
//
// 为什么单独一个文件而不是塞进 verify.mjs：
// verify.mjs 跑的是**已安装副本**（profiles/web/node_modules/acmer-coach），
// 而这一关要在**开发目录**里验，且要反复换 COACH_DATA_DIR 重载模块
// —— 两者用的解析根不同，混在一起每跑一次都得先装一遍。
//
// 跑法：node dev/w1-check.mjs
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'

const HERE = new URL('..', import.meta.url).pathname.replace(/^\//, '')
let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

// ── 造一份最小数据目录 ────────────────────────────────────────────────
function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'w1-'))
  writeFileSync(join(dir, 'MAP.yaml'), `meta:
  version: 3
  node_count: 2
nodes:
  - id: A
    name: A
    domain: 测试
    depends: []
    tier: normal
  - id: B
    name: B
    domain: 测试
    depends: [A]
    tier: normal
`)
  writeFileSync(join(dir, 'DEPENDS.yaml'), `meta:
  version: 1
requires:
  A: []
  B: [A]
`)
  writeFileSync(join(dir, 'skilltree.html'), '<html><body>stub</body></html>')
  return dir
}

const mockCtx = (registered, sections = []) => ({
  tools: { register: (t) => registered.push(t) },
  inject: () => {},
  on: () => {},
  // systemPrompt 服务：插件通过它把教练规则注进 system prompt
  get: (name) => (name === 'systemPrompt'
    ? { section: (s) => sections.push(s) }
    : undefined),
})

/** 用指定的 env 重新加载一份模块实例（ESM 按 URL 缓存，靠 query 破缓存）。 */
async function loadWith(env, tag) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const mod = await import(`../index.js?w1=${tag}`)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const registered = [], sections = []
  mod.apply(mockCtx(registered, sections))
  return { mod, byName: new Map(registered.map((t) => [t.name, t])), sections }
}

// ══════════════════════════════════════════════════════════════════
console.log('── 1. 默认路径从家目录派生（不再写死） ──')
{
  const { byName } = await loadWith({ COACH_DATA_DIR: undefined, COACH_TRAINER: undefined }, 'default')
  const ping = byName.get('coach_ping')
  check('coach_ping 注册了', Boolean(ping))
  const v = await ping.execute({}, undefined)
  // 默认目录 = ~/.dsh/knowledge。本机能跑说明家目录派生没问题。
  check('默认数据目录可达（~/.dsh/knowledge）', typeof v?.dataDir === 'string' && v.dataDir.includes('.dsh'),
    `dataDir=${v?.dataDir}`)
  // 断言的是**推导逻辑**，不是"不含某几个字面量" ——
  // 后者会把名字写进测试文件本身，等于把要清的东西留在了仓库里。
  const want = join(homedir(), '.dsh', 'knowledge')
  check('默认路径 = 家目录派生（不是写死的）',
    String(v?.dataDir).replace(/\\/g, '/') === want.replace(/\\/g, '/'), `dataDir=${v?.dataDir}`)
}

console.log('── 2. COACH_DATA_DIR 覆盖生效 ──')
const ledger = makeLedger()
{
  const { byName } = await loadWith({ COACH_DATA_DIR: ledger, COACH_TRAINER: undefined }, 'tmp')
  const v = await byName.get('coach_ping').execute({}, undefined)
  check('指向了临时目录', String(v?.dataDir).replace(/\\/g, '/') === ledger.replace(/\\/g, '/'),
    `dataDir=${v?.dataDir}`)
  check('三个数据文件都探到', v?.ok === true, v?.files?.filter((f) => f.status !== 'ok').map((f) => f.file).join(','))
  check('探针仍是 3 个', v?.files?.length === 3)
}

console.log('── 3. 夹具闸门：没有显式临时目录 → 拦住 ──')
{
  const { mod } = await loadWith({ COACH_DATA_DIR: undefined }, 'gate-off')
  let err = null
  try {
    await mod.schedApi.planDay('2026-01-01', [{ from: '09:00', kind: 'review', node: 'A' }])
  } catch (e) { err = e }
  check('抛错', err instanceof Error, err?.message?.slice(0, 60))
  check('理由含「夹具」', Boolean(err?.message?.includes('夹具')))
  check('理由含「真账本」', Boolean(err?.message?.includes('真账本')))
  check('理由点明怎么绕过（COACH_DATA_DIR）', Boolean(err?.message?.includes('COACH_DATA_DIR')))
}

console.log('── 4. 夹具闸门：显式指定了 → 放行 ──')
{
  const { mod } = await loadWith({ COACH_DATA_DIR: ledger }, 'gate-on')
  let err = null
  try {
    await mod.schedApi.planDay('2026-01-01', [{ from: '09:00', kind: 'review', node: 'A' }])
  } catch (e) { err = e }
  check('闸门不再拦（其它错可以）', !err?.message?.includes('夹具写接口'), err?.message?.slice(0, 80) ?? '(无错)')
}

console.log('── 5. TRAINER 不再写死：没给 handle 就不该出现人名 ──')
{
  const { byName } = await loadWith({ COACH_DATA_DIR: ledger, COACH_TRAINER: undefined }, 'trainer')
  // coach_next 会读地图；DB 打不开时的报错文案里不该出现硬编码 handle
  // 看**源码形状**而不是返回值：没给 COACH_TRAINER 时 TRAINER 必须退成 null，
  // 后续由 trainerId() 取库里第一条用户。写死一个 handle 就会在这里露馅。
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  check('TRAINER 没有写死的默认值',
    /const TRAINER = process\.env\.COACH_TRAINER \|\| null/.test(src))
  check('trainerId 有"取第一条用户"的兜底',
    /SELECT id FROM users ORDER BY id LIMIT 1/.test(src))
}

rmSync(ledger, { recursive: true, force: true })

console.log('── 6. 规则进 system prompt（不是消息流）──')
{
  const { sections } = await loadWith({ COACH_DATA_DIR: undefined }, 'rules')
  const s = sections.find((x) => x.name === 'coach:rules')
  check('注册了 coach:rules 段', Boolean(s))
  check('order 是有限的数', Number.isFinite(s?.order), String(s?.order))
  check('排在人设之后、通用策略之前（0 < order < 500）',
    s?.order > 0 && s?.order < 500, String(s?.order))
  check('规则正文非空且含九条硬规则', (s?.text?.length ?? 0) > 2000 && s.text.includes('coach_next'),
    `${s?.text?.length ?? 0} 字符`)
  // 同样断言**结构性性质**：规则里不该出现绝对路径，也不该出现本机用户名
  // （用户名从 homedir() 现取 —— 源码里不写任何一个具体的名字）。
  const uname = basename(homedir())
  check('规则里没有绝对路径', !/[A-Za-z]:\\|\/Users\/|\/home\//.test(s?.text ?? ''))
  check('规则里没有本机用户名', !(s?.text ?? '').includes(uname))
}
{
  // 没有 systemPrompt 服务时要能静默跳过，别把插件加载拦死（headless）
  const registered = []
  const mod2 = await import('../index.js?w1=nosp')
  let threw = null
  try { mod2.apply({ tools: { register: (t) => registered.push(t) }, inject: () => {}, on: () => {} , get: () => undefined }) }
  catch (e) { threw = e }
  check('没有 systemPrompt 服务 → 不抛，工具照常注册', !threw && registered.length > 0,
    threw ? threw.message : `${registered.length} 个工具`)
}

console.log(`\n${fail === 0 ? '✓ 全绿' : '✗ 有失败'} — ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

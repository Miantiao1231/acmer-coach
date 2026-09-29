// W2 验收：冷启动（搭建 + 同步）。
//
// 分两段：
//   · 离线段**每次都跑** —— status / init 的行为、幂等性、不覆盖已有文件
//   · 联网段要显式开（COACH_TEST_NET=1）—— 真打 CF 公开接口，
//     走完整条链：拉账号 → 拉提交 → 拉题库 → 算接触证据
//
// 跑法：node dev/setup-check.mjs            只用临时目录验离线
//       COACH_TEST_NET=1 node dev/setup-check.mjs [handle]
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const home = mkdtempSync(join(tmpdir(), 'setup-'))
process.env.COACH_DATA_DIR = join(home, 'knowledge')
process.env.COACH_DB = join(home, 'data', 'training.db')

const load = async (tag) => {
  const mod = await import(`../index.js?setup=${tag}`)
  const reg = []
  mod.apply({ tools: { register: (t) => reg.push(t) }, inject: () => {}, on: () => {}, get: () => undefined })
  return reg.find((t) => t.name === 'coach_setup')
}
const tool = await load('a')
const call = (a) => tool.execute(a, undefined)

console.log('── 1. 空环境体检：要如实说「缺」，不能假装没事 ──')
{
  const r = await call({ action: 'status' })
  check('注册了 coach_setup', Boolean(tool))
  check('ok=false（还没搭）', r.ok === false, `ok=${r.ok}`)
  const st = Object.fromEntries(r.items.map((i) => [i.name, i.status]))
  check('数据目录报「缺」', st['数据目录'] === '缺', st['数据目录'])
  check('训练库报「缺」', st['训练库'] === '缺', st['训练库'])
  check('给出了下一步', r.note.includes('init'), r.note.slice(0, 50))
}

console.log('\n── 2. init：建目录、铺地图、建库 ──')
{
  const r = await call({ action: 'init' })
  check('ok', r.ok === true, r.note)
  check('数据目录真的建了', existsSync(process.env.COACH_DATA_DIR))
  check('地图铺过去了', existsSync(join(process.env.COACH_DATA_DIR, 'MAP.yaml')))
  check('训练库真的建了', existsSync(process.env.COACH_DB))
  check('**没把 LICENSE 当数据拷进去**',
    !existsSync(join(process.env.COACH_DATA_DIR, 'LICENSE')))

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(process.env.COACH_DB, { readOnly: true })
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  for (const t of ['users', 'unified_submissions', 'unified_problems', 'rating_history', 'diff_rating_map']) {
    check(`建了表 ${t}`, tables.includes(t))
  }
  check('难度映射灌进去了（13 行）',
    db.prepare('SELECT COUNT(*) c FROM diff_rating_map').get().c === 13)
  db.close()
}

console.log('\n── 3. init 幂等：不许覆盖用户已有的东西 ──')
{
  const prog = join(process.env.COACH_DATA_DIR, 'PROGRESS.yaml')
  writeFileSync(prog, 'version: 1\ncursor: 我自己写的\n')
  const mapBefore = readFileSync(join(process.env.COACH_DATA_DIR, 'MAP.yaml'), 'utf8')
  await call({ action: 'init' })
  check('用户的 PROGRESS.yaml 没被动', readFileSync(prog, 'utf8').includes('我自己写的'))
  check('已有的 MAP.yaml 没被覆盖', readFileSync(join(process.env.COACH_DATA_DIR, 'MAP.yaml'), 'utf8') === mapBefore)
}

console.log('\n── 4. 体检：库空 / 有数据两种状态要分得开 ──')
{
  const r = await call({ action: 'status' })
  check('地图那项是 ok', r.items.find((i) => i.name === '地图').status === 'ok')
  check('训练库认得出来（空库）', r.items.find((i) => i.name === '训练库').detail.includes('0 条提交'),
    r.items.find((i) => i.name === '训练库').detail)
  check('提示下一步去 sync', r.note.includes('sync'), r.note.slice(0, 60))
}

console.log('\n── 5. sync 不给 handle → 要问，不要瞎猜一个 ──')
{
  const r = await call({ action: 'sync' })
  check('ok=false', r.ok === false)
  check('明确说「问他」', r.note.includes('handle'), r.note.slice(0, 60))
}

if (process.env.COACH_TEST_NET === '1') {
  const handle = process.argv[2] || 'tourist'
  console.log(`\n── 6. 联网：真打 CF 接口拉「${handle}」 ──`)
  const t0 = Date.now()
  const r = await call({ action: 'sync', handle, problemset: false })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  check('同步成功', r.ok === true, `${secs}s  ${r.note.slice(0, 80)}`)
  if (r.ok) {
    check('拿到了 rating', r.rating > 0, String(r.rating))
    check('拿到了提交记录', r.submissions > 0, `${r.submissions} 条`)
    check('拿到了接触证据', r.evidence.length > 0, `${r.evidence.length} 个标签`)
    console.log('     证据前 5：', r.evidence.slice(0, 5)
      .map((e) => `${e.tag}(AC ${e.ac})`).join('  '))
    check('证据是**事实**不是结论（有 ac 和 tried 两个数）',
      r.evidence.every((e) => typeof e.ac === 'number' && typeof e.tried === 'number'))
  } else {
    console.log('     ', r.note)
  }
} else {
  console.log('\n（联网段跳过：设 COACH_TEST_NET=1 打开）')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✓ 全绿' : '✗ 有失败'} — ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

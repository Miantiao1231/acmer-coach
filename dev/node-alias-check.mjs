import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSchema } from '../lib/setup.js'

// 地图是中文细粒度节点名，题库标签是另一套词汇（广度优先搜索(BFS) 之类）。
// 没有别名层时，这些节点在库里有几百道题也算「零题池」。
const dir = mkdtempSync(join(tmpdir(), 'coach-node-alias-'))
mkdirSync(join(dir, 'knowledge'), { recursive: true })
process.env.COACH_DATA_DIR = join(dir, 'knowledge')
process.env.COACH_DB = join(dir, 'training.db')

const db = new DatabaseSync(process.env.COACH_DB)
ensureSchema(db)
const insert = db.prepare(`INSERT INTO unified_problems (platform, problem_id, title, difficulty, tags, url, is_library)
  VALUES ('codeforces', ?, ?, ?, ?, '', 1)`)
insert.run('1001', '图上的最短路', 1400, '广度优先搜索(BFS)')
insert.run('1002', '另一道 BFS', 1500, '广度优先搜索(BFS)')
insert.run('1003', 'DFS 遍历', 1400, '深度优先搜索(DFS)')
insert.run('1004', '生成树计数', 1800, '生成树')
insert.run('1005', '字符串匹配', 1600, 'KMP 算法')
insert.run('1006', '搜索题', 1300, '搜索')
db.close()

const { coachApi } = await import(`../index.js?node-alias=${dir.replace(/\\/g, '/')}`)
const open = new DatabaseSync(process.env.COACH_DB, { readOnly: true })

test('a node whose Chinese name has no matching tag reports none without aliases', () => {
  const pool = coachApi.nodePool(open, 'BFS（图论）')
  assert.equal(pool.kind, 'none')
  assert.equal(pool.hits.length, 0)
})

test('an alias maps the node to the tag vocabulary the database actually uses', () => {
  const pool = coachApi.nodePool(open, 'BFS（图论）', ['广度优先搜索(BFS)'])
  assert.equal(pool.kind, 'alias')
  assert.deepEqual(pool.tags, ['广度优先搜索(BFS)'])
  assert.deepEqual(pool.hits.map((row) => row.problem_id).sort(), ['1001', '1002'])
})

test('an exact tag for the node name wins over aliases', () => {
  const pool = coachApi.nodePool(open, '搜索', ['广度优先搜索(BFS)'])
  assert.equal(pool.kind, 'exact')
  assert.deepEqual(pool.hits.map((row) => row.problem_id), ['1006'])
})

test('aliases only match whole tags, never substrings', () => {
  const pool = coachApi.nodePool(open, 'BFS（图论）', ['BFS'])
  assert.equal(pool.kind, 'none', '别名退化成子串匹配会把别的知识点也捞进来')
})

test('substring matching still works for names that appear inside a tag', () => {
  const pool = coachApi.nodePool(open, '广度优先')
  assert.equal(pool.kind, 'substring')
  assert.equal(pool.hits.length, 2)
})

after(() => {
  open.close()   // Windows 上句柄没关，临时目录删不掉（EPERM）
  rmSync(dir, { recursive: true, force: true })
})

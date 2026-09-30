// whale-notes — 你的 Obsidian 笔记库 × 教练地图 的桥。
//
// 为什么要有这个插件（而不是让教练自己去 grep）：
//
//   讲一道题要的上下文散在**三个文件**里：
//     · MAP.yaml      —— 这个知识点的前置、后继（依赖图）
//     · PROGRESS.yaml —— 你学到哪了（唯一真相源）
//     · 笔记 .md       —— 你自己怎么写的、代码长什么样
//   让 AI 每次自己拼 = 三次读取 + 一次自己的目录遍历，而且**每次拼法可能不一样**。
//   这个插件的活就是把这三次收成一次，且拼法只有一份。
//
// 分工（对应 acmer-coach 的设计方针「判断归 LLM，记录归程序」）：
//   · LLM 判断「这篇笔记讲的是图上的哪些节点」—— 语义活，只有它能干
//   · 本插件负责把那个判断**落盘、校验、查回来** —— 记账活，程序干才不出错
//
// ⚠️ 本插件**只读你的笔记，从不写**。唯一会写的文件是 NOTE_MAP.yaml（映射表），
//    那是插件自己的账本，不是你的东西。你的原文一个字都不动。
//
// 配置（环境变量，两个都支持在启动 dsh 前设置）：
//   OBSIDIAN_VAULT   你的 Obsidian 库根目录。**必需** —— 没设时工具会明确报错，
//                    不会猜测一个路径（猜错 = 拿空数据回答"没有这篇笔记"）。
//   COACH_DATA_DIR   教练数据目录。默认 ~/.dsh/knowledge，跟 acmer-coach 一致。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { homedir } from 'node:os'
import { parse, stringify } from 'yaml'

const name = 'whale-notes'
const inject = ['tools']

// ── 路径 ──────────────────────────────────────────────────────────
const KNOWLEDGE_DIR =
  process.env.COACH_DATA_DIR || process.env.DSH_KNOWLEDGE_DIR || join(homedir(), '.dsh', 'knowledge')
const MAP_PATH = join(KNOWLEDGE_DIR, 'MAP.yaml')
const PROGRESS_PATH = join(KNOWLEDGE_DIR, 'PROGRESS.yaml')
const NOTE_MAP_PATH = join(KNOWLEDGE_DIR, 'NOTE_MAP.yaml')

// 库路径逐次读（不是模块级常量）：没配置时工具各自报错，而不是模块加载时炸掉 dsh。
function vaultDir() {
  const v = process.env.OBSIDIAN_VAULT
  return v ? v : null
}
const VAULT_MISSING =
  '还没配置 Obsidian 库路径。设置 OBSIDIAN_VAULT 环境变量指向你的库根目录（如 D:\\Notes），' +
  '然后重启 dsh。'

// 单篇笔记返回的上限。超过就截断并置 truncated —— 大笔记全塞进去会把上下文冲掉。
// 要看全文就自己开 Obsidian，或者传 full=true。
const MAX_CONTENT = 20000

// ── 归一化：让「笔记名」和「图上节点名」能撞上 ──────────────────────
//
// 两边的人工命名习惯不一样，直接比对永远对不上：
//   笔记 "5.区间dp.md"            → 区间dp
//   笔记 "6 矩阵快速幂.md"          → 矩阵快速幂     （序号后是空格不是点）
//   笔记 "1.1.set.md"             → set           （两级序号）
//   节点 "区间 DP"                 → 区间dp        （节点里有空格）
//   节点 "字典树 (Trie)"            → 字典树         （节点带英文补充）
//
// ⚠️ 序号只在**跟着分隔符**时才剥。否则 `2-SAT` 会被剥成 `-SAT` ——
//    图上有这个节点，剥错了它就永远匹配不上，而且**静默**。
function normalize(s) {
  return String(s)
    .replace(/^(\d+(\.\d+)*\s*[.、]\s*|\d+\s+)/, '')  // 剥序号前缀
    .replace(/\.md$/i, '')
    .replace(/[\s\u3000]+/g, '')                       // 去所有空白
    .replace(/[（(][^）)]*[）)]/g, '')                  // 去括号补充
    .toLowerCase()
}

// ── 读 YAML：坏了要炸，不能静默返回空 ──────────────────────────────
//
// 唯一真相源（MAP / PROGRESS）读失败时**必须抛**。
// 返回空对象看着更"稳"，实际是拿空数据回答"这个知识点不存在"——
// 那正是「系统以为自己在工作，实际没有」的形状。
function loadYaml(path, label) {
  if (!existsSync(path)) return null
  try {
    return parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${label} 解析失败（${path}）：${e.message}`)
  }
}

// ── 全库笔记索引：归一化名 → 相对路径 ──────────────────────────────
//
// 每次现走一遍（几毫秒）。不做缓存 = 没有失效 bug。
function walkNotes(dir, out = []) {
  for (const e of readdirSync(dir)) {
    // 跳过所有隐藏目录（.obsidian / .trash …）和常见的附件目录
    if (e.startsWith('.') || e === '图片' || e === 'attachments' || e === 'assets') continue
    const p = join(dir, e)
    statSync(p).isDirectory() ? walkNotes(p, out) : (e.endsWith('.md') && out.push(p))
  }
  return out
}
function noteIndex() {
  const vault = vaultDir()
  const byNorm = new Map()
  for (const p of walkNotes(vault)) {
    const rel = relative(vault, p).replace(/\\/g, '/')
    const key = normalize(basename(p, '.md'))
    if (!byNorm.has(key)) byNorm.set(key, [])
    byNorm.get(key).push(rel)
  }
  return byNorm
}

// ── 映射表 NOTE_MAP.yaml ───────────────────────────────────────────
// 形如：{ '五、DP/5.区间dp.md': ['区间 DP'] }   多对多，两边都可以多。
function loadNoteMap() {
  const d = loadYaml(NOTE_MAP_PATH, 'NOTE_MAP.yaml')
  return d?.map && typeof d.map === 'object' ? d.map : {}
}
// 原子写：先写 .tmp 再 rename，半路崩了不会把账本撕成半个文件。
function saveNoteMap(map) {
  const out = { version: 1, updated: new Date().toISOString().slice(0, 10), map }
  const tmp = `${NOTE_MAP_PATH}.tmp`
  writeFileSync(tmp, stringify(out, { lineWidth: 0 }), 'utf8')
  renameSync(tmp, NOTE_MAP_PATH)
  return out
}

// ── 图查询：节点 → 前置 / 后继 ─────────────────────────────────────
function graphIndex() {
  const map = loadYaml(MAP_PATH, 'MAP.yaml')
  if (!map?.nodes)
    throw new Error(
      `MAP.yaml 里没有 nodes 字段（${MAP_PATH}）—— 教练数据初始化了吗（coach_setup init）？`
    )
  const byId = new Map(map.nodes.map((n) => [n.id, n]))
  const byNorm = new Map(map.nodes.map((n) => [normalize(n.id), n.id]))
  const dependents = new Map()          // 节点 → 谁依赖它（反查）
  for (const n of map.nodes) {
    for (const dep of n.depends ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep).push(n.id)
    }
  }
  return { nodes: map.nodes, byId, byNorm, dependents }
}

function statusOf(nodeId) {
  const p = loadYaml(PROGRESS_PATH, 'PROGRESS.yaml')
  return p?.nodes?.[nodeId]?.status ?? null      // null = 未学（PROGRESS 里不写就是没碰过）
}

// ── 插件本体 ───────────────────────────────────────────────────────
function apply(ctx) {
  const tools = ctx.tools

  // ── 1. note_context：给一个知识点名或笔记名，把上下文一次给全 ──────
  tools.register(defineTool({
    name: 'note_context',
    description:
      '查你的 Obsidian 笔记 + 教练地图上的位置 + 进度，一次给全。' +
      '输入可以是图上节点名（如「区间 DP」「最短路」），也可以是笔记名/路径（如「区间dp」「五、DP/5.区间dp.md」）。' +
      '返回：那篇笔记的正文、图上直接前置（requires）、谁依赖它、学习状态。' +
      '讲某个知识点之前、判因时想知道「以前自己是怎么写的」时用它。',
    parameters: {
      query: { type: 'string', required: true, description: '节点名 或 笔记名/相对路径' },
      full: { type: 'boolean', description: 'true = 不截断笔记正文（默认截断在 2 万字符）' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          reason: { type: 'string' },
          nodes: { type: 'array', required: true, items: { type: 'string' } },   // 命中的图节点
          notePaths: { type: 'array', required: true, items: { type: 'string' } }, // 命中的笔记（可能多篇）
          content: { type: 'string' },         // 只有恰好一篇时才给正文
          truncated: { type: 'boolean' },
          noteExists: { type: 'boolean', required: true },
          requires: { type: 'array', required: true, items: { type: 'string' } },
          dependents: { type: 'array', required: true, items: { type: 'string' } },
          progress: { type: 'string' },        // 未学 / studying / learned / verified
          mapped: { type: 'boolean', required: true }   // 是否已在 NOTE_MAP 里登记
        }
      },
      render: (_args, v) => {
        if (!v.found) return [{ type: 'text', text: v.reason ?? '没找到。' }]
        const L = []
        L.push(`图节点：${v.nodes.join(' / ')}`)
        L.push(`学习状态：${v.progress ?? '未学（PROGRESS.yaml 里没有这条 = 没碰过）'}`)
        if (v.requires.length) L.push(`前置（学它之前必须先会）：${v.requires.join('、')}`)
        if (v.dependents.length) L.push(`依赖它的：${v.dependents.join('、')}`)
        if (!v.noteExists) {
          L.push('', '📭 这个知识点还没有笔记。')
        } else if (v.notePaths.length > 1) {
          // 多篇时不倒正文 —— 三篇 × 2 万字符会把上下文冲掉。
          // 给路径让 AI 自己挑一篇按路径查，比替它挑一篇好。
          L.push('', `📄 关于这个知识点有 ${v.notePaths.length} 篇笔记：`)
          for (const p of v.notePaths) L.push(`     ${p}`)
          L.push('', '（要看哪篇就传那篇的路径再来一次）')
        } else {
          L.push('', `📄 ${v.notePaths[0]}${v.mapped ? '' : '  ⚠️ 未登记（这条是靠名字猜的，去 note_map_set 登记一下）'}`)
          L.push('', v.content + (v.truncated ? '\n\n…（已截断，要全文传 full=true）' : ''))
        }
        return [{ type: 'text', text: L.join('\n') }]
      }
    },
    async execute(args) {
      const vault = vaultDir()
      if (!vault)
        return {
          found: false, reason: VAULT_MISSING,
          nodes: [], notePaths: [], requires: [], dependents: [], noteExists: false, mapped: false
        }
      const g = graphIndex()
      const q = String(args.query ?? '').trim()
      const qNorm = normalize(q)
      const notes = noteIndex()
      const noteMap = loadNoteMap()

      // 输入先当**笔记**认：带 / 的当路径，否则当笔记名
      let notePaths = []
      const explicitPath = q.includes('/')
      if (explicitPath) {
        const rel = q.replace(/\\/g, '/')
        if (existsSync(join(vault, rel))) notePaths = [rel]
      } else {
        // ① 精确：查「Dijkstra  单源最短路」这种完整笔记名
        notePaths = [...(notes.get(qNorm) ?? [])]
        // ② 子串扫文件名 —— 用户打的是关键词，不是完整文件名。
        //
        // 为什么必须有这一步：查「Dinic」拿不到东西，因为笔记叫
        //   「Dinic 网络流-最大流.md」，只撞完整文件名就永远撞不上。
        //   而「Dinic」「Tarjan」「SPFA」正是人嘴里会蹦出来的词 ——
        //   搜不到 = 工具在最常用的问法上哑火。
        //
        // ponytail: 关键词 ≥2 字符才扫（单字会命中一大片），命中多篇时不设上限 ——
        //   render 的多篇分支只列路径不倒正文，列 9 条路径是信息不是噪音。
        if (!notePaths.length && qNorm.length >= 2) {
          for (const [k, v] of notes) if (k.includes(qNorm)) notePaths.push(...v)
        }
      }

      // 输入再当**节点**认：登记表优先，其次靠归一化猜
      let nodes = []
      for (const p of notePaths) for (const id of noteMap[p] ?? []) nodes.push(id)
      let mapped = nodes.length > 0
      if (!nodes.length) {
        const byNode = g.byNorm.get(qNorm)
        if (byNode) nodes = [byNode]
      }
      // 给了笔记但还没节点 → 反查登记表，看这篇登记成谁了
      if (!nodes.length && notePaths.length) {
        for (const [np, ids] of Object.entries(noteMap)) {
          if (notePaths.includes(np)) nodes.push(...ids)
        }
      }
      nodes = [...new Set(nodes)]

      // ── 反向：节点 → 笔记（**并集**，不是二选一）──────────────────
      // 多对多：图上「最短路」可能被写在 Dijkstra / Floyd / Bellman 三篇里。
      //
      // ⚠️ 两个都是**答案不全**的坑，而且都看不出漏了：
      //   · 漏掉反向查：问「讲讲最短路」，工具回「你还没写过笔记」——**空答案冒充结论**
      //   · 只在没找到笔记时才反向查：「并查集」既是笔记名又是节点名，
      //     正向命中一篇之后就不查了 → 漏掉 Kruskal 那篇（它也讲了并查集）
      // 所以这里是**并集**。唯一例外：指名道姓给了一篇路径，那就只要那一篇。
      if (!explicitPath && nodes.length) {
        for (const [np, ids] of Object.entries(noteMap)) {
          if (ids.some((id) => nodes.includes(id)) && existsSync(join(vault, np))) {
            notePaths.push(np)
            mapped = true
          }
        }
        // 登记表里也没有 → 把节点名当笔记名再试一次（"区间 DP" → "五、DP/5.区间dp.md"）
        for (const id of nodes) {
          const hit = notes.get(normalize(id))
          if (hit?.length) notePaths.push(...hit)
        }
      }
      notePaths = [...new Set(notePaths)]

      if (!nodes.length && !notePaths.length) {
        // ⚠️ 这段文案是踩坑换来的。曾经指向 note_map_set —— **那是条死路**：
        //    拿「Dinic」查不到，照提示去登记映射，登记完**照样查不到**，
        //    因为问题出在「搜不到笔记」，不在「笔记挂没挂上图节点」。指错路比不说更坏。
        return {
          found: false,
          reason: `「${q}」没匹配到任何笔记，也不是教练地图上的节点。\n` +
            `· 换个更具体的词（关键词会扫文件名，「Dinic」能命中「Dinic 网络流-最大流.md」）\n` +
            `· 或直接给相对路径，如「四、图论/17. Dinic 网络流-最大流.md」\n` +
            `· 想看全部笔记和登记情况 → note_map_status\n` +
            `· 若是「笔记名和图节点名对不上」（笔记叫 Dijkstra，图上只有最短路），那是映射问题 → note_map_set`,
          nodes: [], notePaths: [], requires: [], dependents: [], noteExists: false, mapped: false
        }
      }

      // 图上查：前置 + 后继（多个节点就并起来）
      const requires = new Set(), dependents = new Set(), statuses = []
      for (const id of nodes) {
        const n = g.byId.get(id)
        for (const d of n?.depends ?? []) requires.add(d)
        for (const d of g.dependents.get(id) ?? []) dependents.add(d)
        const s = statusOf(id)
        if (s) statuses.push(`${id}=${s}`)
      }

      // 笔记正文：只在**恰好一篇**时给 —— 多篇全倒会把上下文冲掉
      let content = null, truncated = false
      if (notePaths.length === 1) {
        content = readFileSync(join(vault, notePaths[0]), 'utf8')
        if (!args.full && content.length > MAX_CONTENT) {
          content = content.slice(0, MAX_CONTENT)
          truncated = true
        }
      }

      return {
        found: true,
        nodes,
        notePaths,
        ...(content !== null ? { content, truncated } : {}),
        noteExists: notePaths.length > 0,
        requires: [...requires],
        dependents: [...dependents],
        ...(statuses.length ? { progress: statuses.join('，') } : {}),
        mapped
      }
    }
  }))

  // ── 2. note_map_status：映射表全貌 + 缺口 ─────────────────────────
  tools.register(defineTool({
    name: 'note_map_status',
    description:
      '看笔记 ↔ 教练地图 的映射登记到什么程度了：哪些笔记挂上了、哪些还没挂、' +
      '图上哪些节点还没有笔记。想知道「还差多少」「该去补哪几篇」时用它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mappedNotes: { type: 'integer', required: true },
          // **「登记」和「挂上节点」是两件事，必须分开报。**
          // 空映射（登记入册、节点写成 []）永远不会被 note_context 命中 ——
          // 合成一个「N/N 已挂上图」的话，那些口子在输出里**看不见**。
          attachedNotes: { type: 'integer', required: true },
          blankNotes: { type: 'integer', required: true },
          blankExamples: { type: 'array', required: true, items: { type: 'string' } },
          totalNotes: { type: 'integer', required: true },
          unmapped: { type: 'array', required: true, items: { type: 'string' } },
          nodesWithoutNote: { type: 'integer', required: true },
          examples: { type: 'array', required: true, items: { type: 'string' } }
        }
      },
      render: (_a, v) => [{
        type: 'text',
        text: `映射登记：${v.mappedNotes} 篇（**挂上 ${v.attachedNotes} / 留空 ${v.blankNotes}**）。\n` +
          `图上还有 ${v.nodesWithoutNote} 个节点没有对应笔记（正常 —— 笔记总是落后于学习进度）。\n` +
          (v.blankNotes
            ? `\n⚠️ 留空的 ${v.blankNotes} 篇**不会被 note_context 命中**（前 5 条）：\n` +
              v.blankExamples.map((f) => `  ${f}`).join('\n') +
              '\n  要挂的话：读一篇 → 判断它是图上哪个/哪些节点 → note_map_set 登记。' +
              '「图上没有对应节点」的那些不必硬挂 —— 那是地图的颗粒度和你的笔记不一样，' +
              '把节点名当笔记名再查一次（note_context 有这条兜底）。\n'
            : '\n') +
          (v.unmapped.length
            ? `\n还没登记的笔记（前 30 条）：\n${v.unmapped.slice(0, 30).map((f) => `  ${f}`).join('\n')}\n\n` +
              `要挂的话：读一篇 → 判断它是图上哪个/哪些节点 → note_map_set 登记。`
            : `没登记的：一篇都没有（${v.totalNotes} 篇全在账本里）。`)
      }]
    },
    async execute() {
      const vault = vaultDir()
      if (!vault) throw new Error(VAULT_MISSING)
      const g = graphIndex()
      const notes = noteIndex()
      const noteMap = loadNoteMap()
      const allNotes = [...notes.values()].flat()
      // 登记 = 账本里有它，且那篇笔记真在库里（账本里留着已删笔记的路径不算）
      const registered = Object.keys(noteMap).filter((p) => existsSync(join(vault, p)))
      // 挂上 = 登记**且**节点不是空的。空映射（[]）单独数出来 ——
      // 它们是「登记过，但图上一个节点都没挂」的那批。
      const attached = registered.filter((p) => (noteMap[p] ?? []).length > 0)
      const blank = registered.filter((p) => (noteMap[p] ?? []).length === 0)
      const unmapped = allNotes.filter((p) => !noteMap[p])
      const why = (p) => {
        const id = g.byNorm.get(normalize(basename(p, '.md')))
        return id
          ? `名字能对上节点「${id}」，note_context 还能靠名字兜底命中 —— 想挂就登记上去`
          : '图上没有对应节点'
      }

      // 图上「有笔记覆盖」的节点数：登记过的 + 靠名字直接对上的
      const covered = new Set(Object.values(noteMap).flat())
      for (const k of notes.keys()) {
        const id = g.byNorm.get(k)
        if (id) covered.add(id)
      }
      return {
        mappedNotes: registered.length,
        attachedNotes: attached.length,
        blankNotes: blank.length,
        blankExamples: blank.slice(0, 5).map((p) => `${p} —— ${why(p)}`),
        totalNotes: allNotes.length,
        unmapped,
        nodesWithoutNote: g.nodes.length - covered.size,
        examples: g.nodes.filter((n) => (n.depends ?? []).length === 0).slice(0, 5).map((n) => n.id)
      }
    }
  }))

  // ── 3. note_map_set：把「这篇讲的是图上哪些节点」落盘 ──────────────
  //
  // ⚠️ 写的是 NOTE_MAP.yaml（插件账本），**不碰你的笔记**。
  //    校验两边都存在才写 —— 登记一个不存在的节点 = 账本里长出一条假边，
  //    而假边不会报错，会在下一次查询时冒充真答案。
  tools.register(defineTool({
    name: 'note_map_set',
    description:
      '登记「这篇笔记讲的是教练地图上的哪个/哪些节点」。多对多：一篇可以覆盖多个节点。' +
      '节点名必须和 MAP.yaml 里的 id 逐字一致，写错会被拒（拒绝理由会告诉你有哪几个相近的）。' +
      '只写映射表，不动你的笔记。',
    parameters: {
      note: { type: 'string', required: true, description: '相对 vault 的笔记路径，如「五、DP/5.区间dp.md」' },
      nodes: { type: 'array', required: true, items: { type: 'string' }, description: '图节点 id 列表，如 ["区间 DP"]' },
      replace: { type: 'boolean', description: 'true = 覆盖原有登记；默认是合并追加' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          note: { type: 'string', required: true },
          nodes: { type: 'array', required: true, items: { type: 'string' } }
        }
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? `✅ 登记：${v.note}  →  ${v.nodes.join('、')}`
          : `❌ 没写成：${v.error}`
      }]
    },
    async execute(args) {
      const vault = vaultDir()
      if (!vault) return { ok: false, error: VAULT_MISSING, note: String(args.note ?? ''), nodes: [] }
      const rel = String(args.note ?? '').replace(/\\/g, '/')
      const g = graphIndex()

      if (!existsSync(join(vault, rel))) {
        const guess = normalize(basename(rel, '.md'))
        const near = [...noteIndex().entries()].filter(([k]) => k.includes(guess) || guess.includes(k)).map(([, v]) => v[0])
        return { ok: false, error: `vault 里没有「${rel}」。${near.length ? `相近的有：${near.slice(0, 5).join(' / ')}` : ''}`, note: rel, nodes: [] }
      }

      const wanted = (args.nodes ?? []).map(String)
      const bad = wanted.filter((n) => !g.byId.has(n))
      if (bad.length) {
        const near = bad.map((b) => {
          const bn = normalize(b)
          return g.nodes.map((n) => n.id).filter((id) => normalize(id).includes(bn) || bn.includes(normalize(id))).slice(0, 5)
        })
        return {
          ok: false,
          error: `这些节点名在 MAP.yaml 里不存在：${bad.join('、')}。\n` +
            `相近的：${near.map((a, i) => `${bad[i]} → ${a.length ? a.join(' / ') : '（没有相近的）'}`).join('；')}\n` +
            `⚠️ 节点 id 必须逐字一致。—— 也可能你的笔记颗粒度和图不一样（一篇讲了好几个节点，或者自创了图上没有的分法），那就登记它**覆盖到**的那几个。`,
          note: rel, nodes: []
        }
      }
      if (!wanted.length) return { ok: false, error: 'nodes 是空的，没东西可登记。', note: rel, nodes: [] }

      const map = loadNoteMap()
      const merged = args.replace ? [...new Set(wanted)] : [...new Set([...(map[rel] ?? []), ...wanted])]
      map[rel] = merged
      saveNoteMap(map)
      return { ok: true, note: rel, nodes: merged }
    }
  }))
}

export { apply, inject, name }

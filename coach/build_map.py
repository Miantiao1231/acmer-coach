#!/usr/bin/env python3
"""
build_map.py — 用 OI-wiki 全量条目 + DEPENDS.yaml，生成 MAP.yaml

设计（第三版）：
  前两版都错在同一处：**把 OI-wiki 的 parent 当成了前置。**

  parent 是「分类归属」（树链剖分和树分治放在"树上问题"下面一起讲），
  requires 是「前置」（不会 DFS 就学不了树链剖分）。这两个关系在 OI-wiki
  的目录里长得一模一样，但完全不是一回事：
    - 「树上问题」是抽屉，不是知识点 —— 你不可能"掌握树上问题"
    - 「李超线段树」和「线段树」在目录里同级，但后者是前者的前置

  第二版因为「同域内的树形关系不写」，把同域内的真实前置全丢了
  （素数→筛法→莫比乌斯反演 这些边从来没被记过），
  351 个点里 230 个没有前置，拓扑深度只有 3 层。

  这一版：
    - 前置关系全部来自 knowledge/DEPENDS.yaml（数据，不是代码）
    - **每个节点显式写全部直接前置**，不靠 parent 顶替
    - parent 降级为纯分组字段，只用于显示，不参与任何依赖计算

  每个节点留 `tier` 字段（core/normal/rare/skip）—— 本版**先留空**，
  等第 2 遍叠权重/难度时一起标。先求全，再求挑。

用法: python build_map.py   → 覆写 ~/.dsh/knowledge/MAP.yaml
"""
import json
import os
import sys
from collections import Counter

import yaml

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "oiwiki_tree.json")
DEPS = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "DEPENDS.yaml")
META = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "NODE_META.yaml")
ENTRY = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "NODE_ENTRY.yaml")
OUT = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "MAP.yaml")

# 平行分支（不是依赖，是「选一条走即可」）
PARALLEL_HINTS = [
    {"a": "树状数组", "b": "线段树", "note": "区间维护的两条独立路线，走通一条即可"},
    {"a": "块状数据结构", "b": "线段树", "note": "分块是线段树的朴素退路，学不动时可先走分块"},
    {"a": "Treap", "b": "Splay 树", "note": "平衡树任选一种写熟即可，另一种按需补"},
    {"a": "后缀数组 (SA)", "b": "后缀自动机 (SAM)", "note": "字符串难题的两条路线，先走通一条"},
    {"a": "单调队列/单调栈优化", "b": "线段树", "note": "都是优化 DP 转移的手段"},
]


def slug(name):
    """id 直接用中文全名 —— 自解释、可读、不必维护映射表。"""
    return name


def load_requires():
    """读 DEPENDS.yaml → ({节点名: [直接前置]}, 文档头)。

    返回的字典里**没有**的节点 = 前置还没铺（不是"根节点"）。
    这个区别很重要：没铺是"不知道"，空列表是"确认不需要前置"。
    """
    if not os.path.exists(DEPS):
        print(f"❌ 找不到 {DEPS}")
        return None, None
    doc = yaml.safe_load(open(DEPS, encoding="utf-8")) or {}
    return (doc.get("requires") or {}), (doc.get("meta") or {})


def load_meta():
    """读两份**标注**（都不是地图结构，是"这知识点重不重要 / 什么水平学得起"）。

    NODE_META.yaml   人维护 —— tier（core/normal/rare/skip）+ 偏离默认时的依据
    NODE_ENTRY.yaml  机器算 —— entry（题池的 p25）+ pool/median，见 build-node-meta.mjs

    两份分开是有意的：机器那份可以**全权重写**，人那份**谁都不许动**。
    混在一个文件里，"脚本重跑"和"人改标注"就会互相冲掉 ——
    跟 PROGRESS.yaml 的 yaml 库吃注释是同一个坑。
    """
    tiers, entries = {}, {}
    if os.path.exists(META):
        doc = yaml.safe_load(open(META, encoding="utf-8")) or {}
        tiers = doc.get("nodes") or {}
    if os.path.exists(ENTRY):
        doc = yaml.safe_load(open(ENTRY, encoding="utf-8")) or {}
        entries = doc.get("nodes") or {}
    return tiers, entries


def main():
    items = json.load(open(SRC, encoding="utf-8"))
    req, dep_meta = load_requires()
    if req is None:
        return 1
    tiers, entries = load_meta()

    # 同一 domain 内重名 → 用 path 前缀消歧
    seen = Counter((i["domain"], i["name"]) for i in items)
    dupes = {k for k, v in seen.items() if v > 1}

    nodes = []
    skipped = []
    for it in items:
        name = it["name"]
        path = it["path"]
        # OI-wiki 里有些页面既是分组名、又是分组里的条目（并查集 / 二叉搜索树 & 平衡树），
        # 抽出来会变成 X 和 X/X 两个节点、指向同一个知识点 —— 丢掉自嵌套的那个，
        # 否则图上会出现两个一模一样的点。
        if len(path) == 2 and path[0] == path[1] == name:
            skipped.append(name)
            continue
        parent = path[0] if len(path) > 1 else None
        nid = name
        if (it["domain"], name) in dupes:
            nid = "/".join(path)
        nodes.append({
            "id": nid,
            "name": name,
            "domain": it["domain"],
            "parent": parent,                          # 仅用于分组显示
            "depends": req.get(name) if name in req else None,   # None = 前置未铺
            "tier": (tiers.get(name) or {}).get("tier"),          # NODE_META.yaml
            "entry": (entries.get(name) or {}).get("entry"),      # NODE_ENTRY.yaml
            "pool": (entries.get(name) or {}).get("pool"),
        })

    ids = {n["id"] for n in nodes}
    names = {n["name"] for n in nodes}

    # 校验：DEPENDS.yaml 里引用的前置必须真实存在
    bad = []
    for n in nodes:
        for d in n["depends"] or []:
            if d not in names and d not in ids:
                bad.append(f"{n['name']} → {d}（不存在）")

    covered = sum(1 for n in nodes if n["depends"] is not None)
    edge_count = sum(len(n["depends"] or []) for n in nodes)

    # ── 输出 YAML（手写序列化，保证可读 + 稳定顺序）──
    L = []
    L.append("# ══════════════════════════════════════════════════════════════")
    L.append("# MAP.yaml — 教练地图 v3（前置 = depends，分类 = parent）")
    L.append("#")
    L.append("# 生成方式：coach/build_map.py（OI-wiki 导航 351 条 + knowledge/DEPENDS.yaml）")
    L.append("#   ⚠️ 不要手改本文件 —— 改 DEPENDS.yaml 再重跑 build_map.py。")
    L.append("#")
    L.append("# 结构约定：")
    L.append("#   depends  前置。学这个之前必须先掌握的直接前置。空列表 = 确认的根节点，")
    L.append("#            null = 还没铺（**不是根，是不知道**，别把它排到最前面）。")
    L.append("#   parent   分类归属，**只用于分组显示，不是前置**。")
    L.append("#            「树上问题」是抽屉不是知识点 —— 它不参与任何依赖计算。")
    L.append("#   tier     这个知识点重不重要：core/normal/rare/skip。")
    L.append("#            来自 knowledge/NODE_META.yaml（人手维护），本文件只做合并。")
    L.append("#   entry    题池的 p25，≈「什么水平开始学得起」。**只有有题池的节点才有**。")
    L.append("#            来自 knowledge/NODE_ENTRY.yaml（机器算，跑 build-node-meta.mjs）。")
    L.append("# ══════════════════════════════════════════════════════════════")
    L.append("")
    L.append("meta:")
    L.append("  version: 3")
    L.append("  source: OI-wiki 导航（mkdocs.yml）")
    L.append(f"  node_count: {len(nodes)}")
    L.append(f"  edge_count: {edge_count}")
    L.append(f"  depends_covered: {covered}/{len(nodes)}")
    L.append("")
    L.append("nodes:")

    cur_domain = None
    for n in sorted(nodes, key=lambda x: (x["domain"], x["parent"] or "", x["name"])):
        if n["domain"] != cur_domain:
            cur_domain = n["domain"]
            L.append(f"  # ── {cur_domain} ──")
        L.append(f"  - id: {n['id']}")
        L.append(f"    name: {n['name']}")
        L.append(f"    domain: {n['domain']}")
        if n["parent"]:
            L.append(f"    parent: {n['parent']}")
        if n["depends"] is not None:
            L.append(f"    depends: [{', '.join(n['depends'])}]")
        # tier / entry 是**标注**，不是地图结构 —— 来自 NODE_META.yaml 和
        # NODE_ENTRY.yaml，本文件只负责合并。缺了就不写这一行（缺 = 没标 / 没数据）。
        if n["tier"]:
            L.append(f"    tier: {n['tier']}")
        if n["entry"]:
            L.append(f"    entry: {n['entry']}      # 题池 p25（≈入门段位），机器算")
        if n["pool"]:
            L.append(f"    pool: {n['pool']}        # entry 是拿这么多道题算出来的")
        L.append("")

    L.append("parallel_branches:")
    for p in PARALLEL_HINTS:
        L.append(f"  - a: {p['a']}")
        L.append(f"    b: {p['b']}")
        L.append(f"    note: {p['note']}")
    L.append("")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    by_domain = Counter(n["domain"] for n in nodes)
    print(f"生成完成 → {OUT}")
    print(f"  节点 {len(nodes)}   前置边 {edge_count}   已铺前置 {covered}/{len(nodes)}")
    # 标注覆盖率要报出来。静默漏标 = 教练拿到一个没有 tier 的节点、
    # 悄悄按"没标注"处理，而人以为标全了 —— 又一种"盘上少了一块没人知道"。
    no_tier = [n["name"] for n in nodes if not n["tier"]]
    no_entry = [n["name"] for n in nodes if not n["entry"]]
    print(f"  已标 tier {len(nodes) - len(no_tier)}/{len(nodes)}"
          f"   有入门段位 {len(nodes) - len(no_entry)}/{len(nodes)}")
    if no_tier:
        head = " / ".join(no_tier[:8])
        print(f"  ⚠️ 没标 tier 的 {len(no_tier)} 个：{head}{' …' if len(no_tier) > 8 else ''}")
    if skipped:
        print(f"  丢弃自嵌套重复节点 {len(skipped)} 个：{' / '.join(skipped)}")
    for k, v in by_domain.most_common():
        print(f"    {k:8s} {v:4d}")
    if bad:
        print(f"\n❌ {len(bad)} 个引用问题：")
        for b in bad[:15]:
            print(f"   - {b}")
        return 1
    print("\n✅ 引用完整（DEPENDS.yaml 里的前置都能对上）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

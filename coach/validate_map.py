#!/usr/bin/env python3
"""
validate_map.py — MAP.yaml 结构校验（自动跑，不靠人眼）

检查四件事：
  1. 环 —— A 依赖 B、B 又依赖 A（拓扑序必须存在）
  2. 孤儿边 —— depends 引用了一个不存在的 id
  3. 自环 / 重复 id
  4. 统计：入度 0 的入口节点、拓扑序（第 1 遍的产出）

用法: python validate_map.py [MAP.yaml 路径]
      默认 ~/.dsh/knowledge/MAP.yaml
退出码: 0 通过 / 1 有错
"""
import os
import sys

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DEFAULT = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "MAP.yaml")


def load(path):
    """读 YAML。优先用 pyyaml；没有则用极简解析（只认本文件格式）。"""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    try:
        import yaml
        return yaml.safe_load(text)
    except ImportError:
        pass
    # 极简 fallback：逐行扫 nodes 段的 id / depends
    nodes, cur = [], None
    in_nodes = False
    for line in text.splitlines():
        if line.startswith("nodes:"):
            in_nodes = True
            continue
        if in_nodes and line and not line[0].isspace():
            break                                    # 离开 nodes 段
        s = line.strip()
        if s.startswith("- id:"):
            cur = {"id": s.split(":", 1)[1].strip(), "depends": []}
            nodes.append(cur)
        elif s.startswith("depends:") and cur is not None:
            raw = s.split(":", 1)[1].strip()
            cur["depends"] = [x.strip() for x in raw.strip("[]").split(",") if x.strip()]
    return {"nodes": nodes}


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.exists(path):
        print(f"[ERR] 找不到 {path}")
        return 1

    doc = load(path)
    nodes = doc.get("nodes") or []
    if not nodes:
        print("[ERR] 没解析出任何节点")
        return 1

    ids = [n["id"] for n in nodes]
    errors = []

    # 1. 重复 id
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        errors.append(f"重复 id: {sorted(dup)}")

    idset = set(ids)

    # 2. 孤儿边 + 自环
    #    ⚠️ 只看 depends，**绝不要把 parent 算进来**。
    #    parent 是「分类归属」——「树上问题」底下挂着 12 个并列的结构，
    #    「数论」底下挂着 32 个，它们不是前置。旧版把两者合并校验，
    #    于是报出「依赖边 315 条、入口 104 个」，看着像个漂亮的 DAG，
    #    其实那 315 里有 177 条是分类关系，图被撑起来了而已。
    def deps_of(n):
        return list(n.get("depends") or [])

    for n in nodes:
        for d in deps_of(n):
            if d == n["id"]:
                errors.append(f"自环: {n['id']} 依赖自己")
            elif d not in idset:
                errors.append(f"孤儿边: {n['id']} 依赖不存在的 '{d}'")

    # 3. 环检测（DFS 三色标记）
    graph = {n["id"]: [d for d in deps_of(n) if d in idset] for n in nodes}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {i: WHITE for i in ids}
    cycle = []

    def dfs(u, stack):
        color[u] = GRAY
        stack.append(u)
        for v in graph[u]:
            if color[v] == GRAY:
                i = stack.index(v)
                cycle.append(" → ".join(stack[i:] + [v]))
                return True
            if color[v] == WHITE and dfs(v, stack):
                return True
        stack.pop()
        color[u] = BLACK
        return False

    for i in ids:
        if color[i] == WHITE and dfs(i, []):
            break

    if cycle:
        errors.append(f"存在环: {cycle[0]}")

    # ── 报告 ──
    print("=" * 60)
    print(f"MAP 校验: {path}")
    print("=" * 60)
    print(f"节点总数       {len(nodes)}")

    domains = {}
    for n in nodes:
        domains.setdefault(n.get("domain", "?"), []).append(n["id"])
    print(f"学科数         {len(domains)}")
    for d, ns in sorted(domains.items(), key=lambda kv: -len(kv[1])):
        print(f"    {d:8s} {len(ns):3d} 节")

    unpaved = [n["id"] for n in nodes if n.get("depends") is None]
    print(f"前置边总数     {sum(len(v) for v in graph.values())}")
    print(f"已铺前置       {len(ids) - len(unpaved)} / {len(ids)}"
          + (f"   ⚠️ {len(unpaved)} 个还没铺（它们的入度 0 是「不知道」，不是「根」）"
             if unpaved else ""))

    entries = [i for i in ids if not graph[i]]
    print(f"入口节点(入度0) {len(entries)}"
          + (f"  ← 含 {len(unpaved)} 个未铺，别当成根" if unpaved else ""))
    for e in entries[:40]:
        print(f"    {e}")
    if len(entries) > 40:
        print(f"    …（还有 {len(entries) - 40} 个）")

    # 拓扑序（第 1 遍的产出 —— 学习顺序的候选）
    # 注意边方向：graph[u] = u 的**依赖**（u 指向它的前置）。
    # 学习顺序要求「前置先出」，所以入度 = 该节点**未满足的依赖数** = len(graph[u])，
    # 出队时递减的是「依赖 u 的那些节点」的入度。
    # （第一版写反了：按「有多少人依赖我」计入度，结果把最难的节点排在了最前面。）
    dependents = {i: [] for i in ids}
    for u, vs in graph.items():
        for v in vs:
            dependents[v].append(u)
    indeg = {i: len(graph[i]) for i in ids}
    ready = sorted([i for i in ids if indeg[i] == 0])
    topo = []
    while ready:
        u = ready.pop(0)
        topo.append(u)
        for w in dependents[u]:
            indeg[w] -= 1
            if indeg[w] == 0:
                ready.append(w)
        ready.sort()
    print(f"拓扑序长度     {len(topo)} / {len(ids)}"
          + ("" if len(topo) == len(ids) else "   ⚠️ 少于节点数 = 有环"))

    print()
    if errors:
        print(f"❌ 发现 {len(errors)} 个问题:")
        for e in errors:
            print(f"   - {e}")
        return 1

    print("✅ 结构合法：无环、无孤儿边、无重复 id")
    print()
    print("拓扑序（前 20，仅作参考 —— 真正的学习顺序还要叠权重和缺口）：")
    for i, nid in enumerate(topo[:20], 1):
        print(f"   {i:2d}. {nid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
analyze_map.py — 看地图的拓扑形状：环 / 深度 / 最长链 / 未铺进度

跟 validate_map.py 的分工：
  validate_map.py  管「结构合不合法」（环、孤儿边、重复 id、引用）
  analyze_map.py   管「形状对不对」（深度分布、最长链、铺了多少）

用法: python analyze_map.py
"""
import os
import sys
from collections import Counter, defaultdict

import yaml

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

MAP = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "MAP.yaml")


def main():
    doc = yaml.safe_load(open(MAP, encoding="utf-8"))
    nodes = doc["nodes"]
    name_of = {n["id"]: n["name"] for n in nodes}
    dom = {n["id"]: n["domain"] for n in nodes}

    # 只认已铺的边：depends 为 None = 还没铺
    dep = {}
    for n in nodes:
        if n.get("depends") is None:
            dep[n["id"]] = None                      # 未铺
        else:
            dep[n["id"]] = [d for d in n["depends"] if d in name_of]

    covered = [k for k, v in dep.items() if v is not None]
    pending = [k for k, v in dep.items() if v is None]

    print("=" * 62)
    print(f"节点 {len(nodes)}   已铺前置 {len(covered)}   未铺 {len(pending)}")
    print("=" * 62)

    # ── 环检测（未铺的节点不参与）──
    WHITE, GREY, BLACK = 0, 1, 2
    color = defaultdict(int)
    cycles = []

    def dfs(u, path):
        color[u] = GREY
        for v in dep.get(u) or []:
            if dep.get(v) is None:
                continue
            if color[v] == GREY:
                i = path.index(v)
                cycles.append(path[i:] + [v])
            elif color[v] == WHITE:
                dfs(v, path + [v])
        color[u] = BLACK

    for u in covered:
        if color[u] == WHITE and dep.get(u) is not None:
            dfs(u, [u])

    if cycles:
        print(f"❌ 发现 {len(cycles)} 个环：")
        for c in cycles[:5]:
            print("   " + " → ".join(name_of.get(x, x) for x in c))
        return 1
    print("✅ 无环\n")

    # ── 最长路分层 ──
    # 关键：祖先链上只要还有一个「未铺」的节点，这个节点的深度就是**未知**，
    # 不是 0。把"不知道"当成"根"会让整张图看起来比实际浅得多 —— 前面吃过这个亏。
    memo = {}
    _stack = set()

    def depth(u):
        """层深；祖先链上有未铺节点 → None（未知）。"""
        if u in memo:
            return memo[u]
        if u in _stack:                 # 防御：理论上无环，已在上游校验
            return 0
        ps = dep.get(u) or []
        if any(dep.get(p) is None for p in ps):
            memo[u] = None
            return None
        _stack.add(u)
        ds = [depth(p) for p in ps]
        _stack.discard(u)
        if any(d is None for d in ds):
            memo[u] = None
        else:
            memo[u] = 0 if not ds else max(ds) + 1
        return memo[u]

    for u in covered:
        depth(u)

    known = {u: depth(u) for u in covered if depth(u) is not None}
    unknown = sorted(set(covered) - set(known))
    lv = Counter(known.values())
    print("=== 拓扑深度（只统计祖先链全部已铺的节点）===")
    mx = max(lv) if lv else 0
    for k in range(mx + 1):
        n = lv.get(k, 0)
        print(f"  L{k:<2} {n:>3} 个  {'█' * min(n, 55)}")
    print(f"\n  最大深度 {mx} 层（目标 8-12）")
    print(f"  深度可算的 {len(known)} 个；深度**未知**（祖先链上有未铺）{len(unknown)} 个")

    # ── 最深的三条链 ──
    def chain(u):
        ps = dep.get(u) or []
        if not ps:
            return [u]
        return chain(max(ps, key=lambda p: known.get(p, -1))) + [u]

    print("\n=== 最深的三条链 ===")
    for u in sorted(known, key=known.get, reverse=True)[:3]:
        ch = chain(u)
        print(f"  ({len(ch) - 1} 层) " + " → ".join(name_of.get(x, x) for x in ch))

    # ── 未铺进度 ──
    if pending:
        print(f"\n=== 未铺前置的 {len(pending)} 个（按学科）===")
        for d, c in Counter(dom[k] for k in pending).most_common():
            print(f"  {d:<8} {c:>3}")

    # ── 根节点（确认不需要前置的）──
    roots = [k for k in covered if not dep[k]]
    print(f"\n=== 确认的根节点 {len(roots)} 个 ===")
    print("  " + " / ".join(sorted(name_of.get(r, r) for r in roots)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

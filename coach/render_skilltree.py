#!/usr/bin/env python3
"""
render_skilltree.py — 把 MAP.yaml + DEPENDS.yaml 渲染成技能树（单文件 HTML）

它是个**视图**：只读两份 YAML，不存任何数据。改地图请改 DEPENDS.yaml。

布局不用 dagre（省一个 CDN 依赖，也方便把间距调成中文标签舒服的值）：
  1. 层 = 最长路深度（跟 analyze_map.py 同一套算法）
  2. 层内顺序 = 重心法（barycenter）迭代 6 轮，减少连线交叉
  3. 每层居中排布，节点宽度随标签长度自适应

用法: python render_skilltree.py [地图.yaml] [输出.html]
  不给参数就用 COACH_DATA_DIR（默认 ~/.dsh/knowledge）下的 MAP.yaml → skilltree.html
  改完地图记得重跑一次，否则页面还是旧的。
"""
import json
import os
import sys
from collections import defaultdict

import yaml

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

_here = os.path.dirname(os.path.abspath(__file__))
# 默认数据目录：和插件同一套规矩（COACH_DATA_DIR 优先，否则 ~/.dsh/knowledge）
_DATA = os.environ.get("COACH_DATA_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "knowledge")
MAP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(_DATA, "MAP.yaml")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(_DATA, "skilltree.html")

# 学科配色。VP 的规矩：这些颜色只用于描边/淡底（非文字 UI 组件，够 3:1 即可），
# 正文一律用 --text-1，所以不需要为它们压深。
DOMAIN_COLOR = {
    "算法基础": ("#2b7fe0", "#4aa3f7"),
    "数据结构": ("#0e9aa7", "#2dd4bf"),
    "图论":     ("#6d4aca", "#a78bfa"),
    "动态规划": ("#d97706", "#ffa726"),
    "字符串":   ("#16a24a", "#3fd968"),
    "数学":     ("#c026d3", "#e879f9"),
    "搜索":     ("#0891b2", "#22d3ee"),
    "计算几何": ("#e11d48", "#fb7185"),
    "杂项":     ("#7a8fa6", "#94a3b8"),
    "专题":     ("#b45309", "#fbbf24"),
}

NODE_H = 44          # 节点高
NODE_GAP = 12        # 同层水平间隙
ROW_GAP = 26         # 折行之间的间隙
LAYER_GAP = 64       # 层间垂直间隙
PAD = 48
W_MAX = 2240         # 单行最大宽度，超过就折行
# 为什么必须折行：第 2 层有 122 个节点，一字排开是 14696×1004 的一条带子
# （14.7:1），缩到屏幕里每个字只有 5px，等于看不见。折行后接近 4:3。


def text_units(s):
    """粗估标签宽度：CJK/全角算 1，其余算 0.55。"""
    return sum(1.0 if ord(c) > 0x2E80 else 0.55 for c in s)


def build():
    doc = yaml.safe_load(open(MAP, encoding="utf-8"))
    nodes = doc["nodes"]
    name_of = {n["id"]: n["name"] for n in nodes}
    dom_of = {n["id"]: n["domain"] for n in nodes}
    # tier / entry 是**标注**，来自 NODE_META.yaml 和 NODE_ENTRY.yaml，
    # 由 build_map.py 合并进 MAP.yaml。缺了就是没标 / 没数据，**别拿 0 冒充**。
    tier_of = {n["id"]: (n.get("tier") or "") for n in nodes}
    entry_of = {n["id"]: int(n.get("entry") or 0) for n in nodes}
    pool_of = {n["id"]: int(n.get("pool") or 0) for n in nodes}
    ids = [n["id"] for n in nodes]

    dep = {}
    for n in nodes:
        dep[n["id"]] = [d for d in (n.get("depends") or []) if d in name_of]

    succ = defaultdict(list)
    for u, ps in dep.items():
        for p in ps:
            succ[p].append(u)

    # ── 1. 分层：最长路 ──
    memo = {}

    def depth(u, stack=frozenset()):
        if u in memo:
            return memo[u]
        ps = dep.get(u) or []
        if u in stack or not ps:
            memo[u] = 0
            return 0
        memo[u] = max(depth(p, stack | {u}) for p in ps) + 1
        return memo[u]

    for i in ids:
        depth(i)

    layers = defaultdict(list)
    for i in ids:
        layers[memo[i]].append(i)
    max_depth = max(layers)

    # ── 2. 层内排序：重心法 ──
    for l in sorted(layers):
        layers[l].sort(key=lambda u: (dom_of[u], name_of[u]))

    # 宽度：左侧圆点(15) + 点后间距(12) + 文字 + 右侧留白(12)
    w = {u: max(104, min(226, 39 + text_units(name_of[u]) * 13.2)) for u in ids}

    for _ in range(6):
        cx = {}
        for l in sorted(layers):
            cur = 0.0
            for u in layers[l]:
                cx[u] = cur + w[u] / 2
                cur += w[u] + NODE_GAP
        for l in sorted(layers)[1:]:
            def bary(u):
                ps = [p for p in dep[u] if p in cx]
                return sum(cx[p] for p in ps) / len(ps) if ps else cx[u]
            layers[l].sort(key=bary)

    # ── 3. 落坐标：每层按 W_MAX 折行 ──
    pos, bands = {}, []
    y_cursor = PAD
    layout = []                      # (层, 行列表, 行高)
    widest = 0.0
    for l in sorted(layers):
        ns = layers[l]
        rows, cur = [[]], 0.0
        for u in ns:
            if cur > 0 and cur + w[u] > W_MAX:
                rows.append([])
                cur = 0.0
            rows[-1].append(u)
            cur += w[u] + NODE_GAP
        h = len(rows) * NODE_H + (len(rows) - 1) * ROW_GAP
        layout.append((l, rows, h))
        for row in rows:
            widest = max(widest, sum(w[u] for u in row) + NODE_GAP * (len(row) - 1))

    # 画布宽度按**实际最宽的那一行**算，不是按 W_MAX 上限 ——
    # 否则右边会留一大片死白（W_MAX 是折行阈值，不是真实宽度）。
    canvas_w = widest + PAD * 2
    for l, rows, h in layout:
        bands.append({"depth": l, "count": len(layers[l]), "y": y_cursor - LAYER_GAP / 2,
                      "h": h + LAYER_GAP, "rows": len(rows)})
        for ri, row in enumerate(rows):
            total = sum(w[u] for u in row) + NODE_GAP * (len(row) - 1)
            x = PAD + (widest - total) / 2
            y = y_cursor + ri * (NODE_H + ROW_GAP)
            for u in row:
                pos[u] = [round(x, 1), y, w[u], NODE_H]
                x += w[u] + NODE_GAP
        y_cursor += h + LAYER_GAP

    edges = [[p, u] for u, ps in dep.items() for p in ps]

    data = {
        "nodes": [
            {
                "id": i, "name": name_of[i], "domain": dom_of[i],
                "depth": memo[i], "x": pos[i][0], "y": pos[i][1],
                "w": pos[i][2], "h": pos[i][3],
                "pre": dep[i], "suc": sorted(succ[i]),
                "tier": tier_of[i], "entry": entry_of[i], "pool": pool_of[i],
            }
            for i in ids
        ],
        "edges": edges,
        "bands": bands,
        "size": [round(canvas_w, 1), round(y_cursor - LAYER_GAP + PAD, 1)],
        "domainColors": DOMAIN_COLOR,
    }
    return data


def main():
    data = build()
    tpl = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skilltree_template.html")
    html = open(tpl, encoding="utf-8").read()
    html = html.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False))
    open(OUT, "w", encoding="utf-8").write(html)

    print(f"生成完成 → {OUT}")
    print(f"  节点 {len(data['nodes'])}   连线 {len(data['edges'])}")
    print(f"  画布 {data['size'][0]} × {data['size'][1]} px")
    print(f"  层数 {len(data['bands'])}   每层节点 " +
          " / ".join(str(b["count"]) for b in data["bands"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

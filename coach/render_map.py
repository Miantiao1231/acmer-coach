#!/usr/bin/env python3
"""
render_map.py v2 — 竖向可折叠树 + 依赖高亮

v1 的问题：
  「线 和线重叠完了 啥也看不清楚 …… 你可以做成竖着的一棵树一样的
    每一个"学科"你可以做一个可以点击就让他不显示的功能」

所以 v2 改成：不做图形化的 DAG（那必然线乱），改成**竖向的折叠树**
  - 学科可折叠（点标题开合）
  - 二级分组（OI-wiki 的分组）也可折叠
  - 每个节点的前置用小字列在旁边（不用连线）
  - 点节点 → 高亮它的完整依赖链（向上追溯），依赖它的节点也会亮

为什么不做连线：OI-wiki 的分组树里，节点多数只跨 1-3 条依赖边，
用文字列出比画线可靠得多 —— 画线在 351 个节点上必然糊成一团。

用法: python render_map.py [输出路径]   默认 ~/Desktop/教练地图.html
"""
import os
import sys
from collections import defaultdict

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

MAP = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge", "MAP.yaml")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "教练地图.html")

DOMAIN_ORDER = ["算法基础", "基本算法", "搜索", "动态规划", "字符串", "数学",
                "数据结构", "数据结构进阶", "图论", "计算几何", "杂项", "专题"]
DOMAIN_COLOR = {
    "算法基础": "#58a6ff", "基本算法": "#58a6ff", "搜索": "#d29922",
    "动态规划": "#f778ba", "字符串": "#3fb950", "数学": "#bc8cff",
    "数据结构": "#39c5cf", "数据结构进阶": "#39c5cf",
    "图论": "#ff7b72", "计算几何": "#e3b341", "杂项": "#8b949e", "专题": "#8b949e",
}


def main():
    import yaml
    with open(MAP, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    nodes = doc["nodes"]
    parallels = doc.get("parallel_branches") or []

    by_id = {n["id"]: n for n in nodes}
    name_of = {n["id"]: n["name"] for n in nodes}

    # 依赖（只算显式 depends —— parent 是分类不是前置，见文件头注释）
    deps = {n["id"]: [d for d in (n.get("depends") or []) if d in by_id] for n in nodes}
    rev = defaultdict(list)
    for i, ds in deps.items():
        for d in ds:
            rev[d].append(i)

    # 分组：学科 → parent 分组 → 节点
    grouped = defaultdict(lambda: defaultdict(list))
    for n in nodes:
        grouped[n["domain"]][n.get("parent") or ""].append(n)

    order = {d: i for i, d in enumerate(DOMAIN_ORDER)}
    domains = sorted(grouped.keys(), key=lambda d: (order.get(d, 99), d))

    # ── 生成 HTML ──
    parts = []
    for dom in domains:
        color = DOMAIN_COLOR.get(dom, "#8b949e")
        total = sum(len(v) for v in grouped[dom].values())
        parts.append(f'<section class="dom" data-dom="{dom}">')
        parts.append(
            f'<h2 style="--c:{color}"><span class="caret">▾</span>{dom}'
            f'<em>{total}</em></h2><div class="body">')
        for grp in sorted(grouped[dom]):
            items = sorted(grouped[dom][grp], key=lambda n: n["name"])
            if grp:
                parts.append(f'<div class="grp"><h3><span class="caret">▾</span>'
                             f'{grp}<em>{len(items)}</em></h3><div class="body">')
            for n in items:
                ds = deps[n["id"]]
                revs = rev[n["id"]]
                dep_html = ""
                if ds:
                    dep_html = ('<span class="dep">← ' +
                                "、".join(f'<b data-id="{d}">{name_of[d]}</b>' for d in ds) +
                                '</span>')
                rev_html = f'<span class="cnt">{len(revs)}</span>' if revs else ""
                parts.append(
                    f'<div class="node" data-id="{n["id"]}" data-deps="{",".join(ds)}" '
                    f'data-rev="{",".join(revs)}">'
                    f'<span class="nm">{n["name"]}</span>{dep_html}{rev_html}</div>')
            if grp:
                parts.append('</div></div>')
        parts.append('</div></section>')

    body = "\n".join(parts)
    n_dep = sum(len(v) for v in deps.values())
    n_entry = sum(1 for v in deps.values() if not v)
    par_html = "".join(
        f'<li><b>{p["a"]}</b> ∥ <b>{p["b"]}</b> —— {p["note"]}</li>' for p in parallels)

    html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>教练地图 v2</title><style>
:root {{ --bg:#0d1117; --fg:#e6edf3; --dim:#8b949e; --line:#21262d; --panel:#161b22; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; }}
header {{ padding:20px 28px; border-bottom:1px solid var(--line);
  position:sticky; top:0; background:var(--bg); z-index:10; }}
h1 {{ margin:0 0 8px; font-size:18px; font-weight:600; }}
.stat {{ color:var(--dim); font-size:13px; }}
.stat b {{ color:var(--fg); }}
.toolbar {{ margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }}
.toolbar button {{ background:var(--panel); color:var(--fg); border:1px solid var(--line);
  padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12.5px; }}
.toolbar button:hover {{ border-color:#58a6ff; }}
main {{ padding:12px 28px 60px; max-width:1100px; }}
section.dom {{ margin:14px 0; }}
h2 {{ margin:0; padding:9px 12px; border-radius:8px 8px 0 0; cursor:pointer;
  font-size:15px; font-weight:600; background:var(--panel);
  border-left:3px solid var(--c); user-select:none; }}
h2 em, h3 em {{ font-style:normal; color:var(--dim); font-size:12px;
  margin-left:8px; font-weight:400; }}
h2 .caret, h3 .caret {{ display:inline-block; width:16px; transition:transform .15s;
  color:var(--dim); }}
.collapsed > .body {{ display:none; }}
.collapsed .caret {{ transform:rotate(-90deg); }}
h3 {{ margin:6px 0 0; padding:6px 12px 6px 26px; font-size:13.5px; font-weight:500;
  color:var(--dim); cursor:pointer; user-select:none; }}
h3:hover {{ color:var(--fg); }}
.body {{ padding-left:14px; }}
section.dom > .body > .grp > .body {{ border-left:1px dashed var(--line); margin-left:12px; }}
.node {{ padding:4px 12px 4px 26px; border-radius:5px; cursor:pointer;
  display:flex; align-items:baseline; gap:10px; }}
.node:hover {{ background:#1c2128; }}
.nm {{ min-width:200px; }}
.dep {{ color:var(--dim); font-size:12px; }}
.dep b {{ color:#58a6ff; font-weight:400; cursor:pointer; }}
.dep b:hover {{ text-decoration:underline; }}
.cnt {{ color:#484f58; font-size:11px; }}
.node.hl {{ background:#1f6feb22; box-shadow:inset 2px 0 0 #1f6feb; }}
.node.dep-hl {{ background:#3fb95022; box-shadow:inset 2px 0 0 #3fb950; }}
.node.rev-hl {{ background:#d2992222; box-shadow:inset 2px 0 0 #d29922; }}
.legend {{ display:flex; gap:16px; font-size:12px; color:var(--dim); margin-top:8px; }}
.legend i {{ font-style:normal; padding:1px 7px; border-radius:4px; }}
.par {{ margin-top:26px; padding:16px 18px; background:var(--panel);
  border-radius:8px; font-size:13px; color:var(--dim); }}
.par b {{ color:var(--fg); font-weight:500; }}
.par ul {{ margin:8px 0 0; padding-left:18px; }}
.par li {{ line-height:1.9; }}
</style></head><body>
<header>
  <h1>教练地图 v2 —— 完整知识树</h1>
  <div class="stat">
    <b>{len(nodes)}</b> 个节点 · <b>{n_dep}</b> 条依赖边 ·
    其中 <b>{n_entry}</b> 个未标注前置 · 来源 OI-wiki 导航全量
  </div>
  <div class="toolbar">
    <button onclick="allOpen()">全部展开</button>
    <button onclick="allClose()">全部折叠</button>
    <button onclick="onlyDomains()">只留学科</button>
    <button onclick="clearHL()">清除高亮</button>
  </div>
  <div class="legend">
    <span><i style="background:#1f6feb22;box-shadow:inset 2px 0 0 #1f6feb">&nbsp;&nbsp;</i> 你点的</span>
    <span><i style="background:#3fb95022;box-shadow:inset 2px 0 0 #3fb950">&nbsp;&nbsp;</i> 它的前置</span>
    <span><i style="background:#d2992222;box-shadow:inset 2px 0 0 #d29922">&nbsp;&nbsp;</i> 依赖它的</span>
  </div>
</header>
<main>
{body}
<div class="par">
  <b>平行分支</b>（不是依赖，是「选一条走即可」）
  <ul>{par_html}</ul>
</div>
</main>
<script>
document.querySelectorAll('h2,h3').forEach(h => h.onclick = e => {{
  if (e.target.tagName === 'B') return;
  h.parentElement.classList.toggle('collapsed');
}});
function allOpen()  {{ document.querySelectorAll('.dom,.grp').forEach(e => e.classList.remove('collapsed')); }}
function allClose() {{ document.querySelectorAll('.dom,.grp').forEach(e => e.classList.add('collapsed')); }}
function onlyDomains() {{ allClose(); document.querySelectorAll('.dom').forEach(e => e.classList.remove('collapsed')); }}
function clearHL() {{ document.querySelectorAll('.node').forEach(e =>
  e.classList.remove('hl','dep-hl','rev-hl')); }}
function mark(id, cls) {{
  const el = document.querySelector(`.node[data-id="${{CSS.escape(id)}}"]`);
  if (el) {{ el.classList.add(cls); return el; }}
  return null;
}}
document.querySelectorAll('.node').forEach(el => el.onclick = ev => {{
  if (ev.target.tagName === 'B') {{                       // 点前置名 → 跳到它
    const id = ev.target.dataset.id;
    const dst = mark(id, 'hl');
    if (dst) {{ dst.scrollIntoView({{block:'center', behavior:'smooth'}}); }}
    return;
  }}
  clearHL();
  el.classList.add('hl');
  // 向上追溯全部前置（传递闭包）
  const seen = new Set(), stack = [...(el.dataset.deps || '').split(',').filter(Boolean)];
  while (stack.length) {{
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = document.querySelector(`.node[data-id="${{CSS.escape(id)}}"]`);
    if (n) {{ n.classList.add('dep-hl'); stack.push(...(n.dataset.deps||'').split(',').filter(Boolean)); }}
  }}
  // 直接依赖它的（一层，多了会糊）
  (el.dataset.rev || '').split(',').filter(Boolean).forEach(id => mark(id, 'rev-hl'));
}});
</script></body></html>"""

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"渲染完成 → {OUT}")
    print(f"  节点 {len(nodes)} · 依赖边 {n_dep} · 未标注前置 {n_entry}")
    print(f"  学科 {len(domains)} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())

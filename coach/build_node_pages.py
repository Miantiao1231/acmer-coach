#!/usr/bin/env python3
"""把「地图节点 → OI Wiki 页面」这张表建出来。

**为什么要它**：地图节点的名字就是从 OI Wiki 导航标题来的，所以
`节点名 → 文件路径` 是一张**精确表**，不是猜的。有了它，查资料就不用靠
模糊搜索去撞 —— 搜"线段树"可能撞出一堆相关页，查表只有一页，而且是对的。

**分类节点怎么办**：导航里有一层是纯分类（「网络流」底下挂着最大流 / 费用流…），
它自己没有页面。这类节点的内容就散在整棵子树里，所以映射到**后代的全部文件**。

⚠️ 两个踩过的坑，决定了这里必须**递归遍历原始树**，不能复用 flatten 的结果：
  ① 只走三层会漏 —— 「莫队算法」的 8 个子页面在**第四层**，一层都收不到；
  ② flatten 会按 SKIP_SUFFIX 滤掉「XX 简介」—— 那个过滤是给**地图节点**用的
     （不该把"线段树简介"当成一个知识点），但**章节页面**不能滤：
     「后缀数组 (SA)」的两个页面里有一个就叫「后缀数组简介」，滤掉就少收一页。

用法:
  python build_node_pages.py <map.yaml> <mkdocs.yml> <输出 node-pages.json>

⚠️ 第二个参数要**原始的 mkdocs.yml**，不是 extract_oiwiki.py 拍平后的
   `oiwiki_tree.json` —— 拍平那份没有 kids，拿它建子树并集会是空的。
   解析器直接复用 extract_oiwiki.parse_nav，一份实现。

产物: {"节点名": ["相对路径.md", ...]}  —— 路径相对 OI Wiki 的 docs/
"""
import json
import os
import sys

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_oiwiki import parse_nav   # noqa: E402  （同目录的解析器，别抄第二份）


def descendants(node, acc):
    """收集一棵子树的全部文件（任意深度，不过滤）。"""
    for k in node.get("kids", []):
        if k.get("file"):
            acc.append(k["file"])
        descendants(k, acc)
    return acc


def walk(tree):
    """遍历原始导航树 → {name: [files]}。"""
    by_name, by_section = {}, {}

    def visit(node):
        name = node.get("name")
        if node.get("file"):
            by_name.setdefault(name, node["file"])
        sub = descendants(node, [])
        if sub:
            by_section.setdefault(name, sub)
        for k in node.get("kids", []):
            visit(k)

    for d in tree:
        visit(d)
    return by_name, by_section


def dedup(xs):
    seen, acc = set(), []
    for x in xs:
        if x not in seen:
            seen.add(x)
            acc.append(x)
    return acc


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    map_path, nav_path, out_path = sys.argv[1:4]

    tree = parse_nav(nav_path)
    nodes = [n["id"] for n in yaml.safe_load(open(map_path, encoding="utf-8"))["nodes"]]

    by_name, by_section = walk(tree)

    out, missing = {}, []
    for n in nodes:
        if n in by_name:
            out[n] = [by_name[n]]              # 有自己页面的，精确到那一页
        elif n in by_section:
            out[n] = dedup(by_section[n])      # 分类节点，落到整棵子树的页面
        else:
            missing.append(n)

    json.dump(out, open(out_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    multi = sum(1 for v in out.values() if len(v) > 1)
    print(f"· 映射 {len(out)}/{len(nodes)} 个节点（{multi} 个走子树并集）")
    if missing:
        print(f"  ⚠️ 没有页面的 {len(missing)} 个: {missing[:12]}")
    print(f"  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

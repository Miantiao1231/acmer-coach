#!/usr/bin/env python3
"""
extract_oiwiki.py — 从 OI-wiki 的 mkdocs.yml 导航提取完整算法树

为什么要它有：地图的「完整性」不能靠我一个人想 —— OI-wiki 是社区维护的
全量索引，拿它当兜底，我漏掉的东西（插头DP / 李超线段树 / Dancing Links …）
就漏不掉。

输出：JSON，结构 = [ {domain, path[], name, file} ]，path 是从学科到该条目的层级，
file 是该条目对应的 markdown 文件（相对 docs/，导航里没挂文件的为 null）。

⚠️ **file 是重点**：地图节点名和 OI-wiki 的导航标题是同一套词，所以
`name → file` 就是一张**精确的「知识点 → 页面」表** —— 查资料不用靠模糊搜索去猜，
直接查这张表。丢了它就只能对着一堆英文文件名（`seg.md`）猜哪个是线段树。

只取算法相关的学科，跳过「简介/工具软件/语言基础/比赛相关」。

用法: python extract_oiwiki.py [输出 json] [mkdocs.yml 路径]
  不给路径就用 $OI_WIKI_DIR/OI-wiki/mkdocs.yml（默认 ~/.dsh/skills/oi-wiki）
"""
import json
import os
import sys

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

_DEFAULT_WIKI_DIR = os.environ.get("OI_WIKI_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "skills", "oi-wiki")
WIKI = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    _DEFAULT_WIKI_DIR, "OI-wiki", "mkdocs.yml")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "oiwiki_tree.json")

# 取这些学科（算法相关）；其余是工具/语言/赛事，不进地图
ALGO = ["算法基础", "搜索", "动态规划", "字符串", "数学",
        "数据结构", "图论", "计算几何", "杂项", "专题"]
# 章节导言页不是知识点
SKIP_SUFFIX = ("部分简介", "简介")
# 这些不是"知识点"而是写法/元信息
SKIP_EXACT = {"学习路线", "学习资源", "常见错误", "常见技巧", "读入、输出优化",
              "分段打表", "题型概述", "交互题", "出题", "技巧"}


def parse_nav(path):
    lines = open(path, encoding="utf-8").read().splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("nav:"))
    end = start + 1
    while end < len(lines) and (lines[end].startswith(" ") or not lines[end].strip()):
        end += 1
    tree, stack = [], []
    for l in lines[start + 1:end]:
        if not l.strip():
            continue
        ind = len(l) - len(l.lstrip())
        s = l.strip()
        if not s.startswith("- "):
            continue
        s = s[2:]
        # 格式是 `- 标题: 路径.md`；只有标题的是分类节点（没有自己的页面）。
        # **路径要留着** —— 它就是「知识点 → 文件」的映射，见文件头。
        name, _, file = s.partition(":")
        name = name.strip()
        file = file.strip() or None
        while stack and stack[-1][0] >= ind:
            stack.pop()
        node = {"name": name, "file": file, "kids": []}
        (stack[-1][1]["kids"] if stack else tree).append(node)
        stack.append((ind, node))
    return tree


def flatten(tree):
    out = []
    for domain in tree:
        if domain["name"] not in ALGO:
            continue
        for l2 in domain["kids"]:
            n2 = l2["name"]
            if n2 not in SKIP_EXACT and not n2.endswith(SKIP_SUFFIX):
                out.append({"domain": domain["name"], "path": [n2],
                            "name": n2, "file": l2.get("file")})
            for l3 in l2["kids"]:
                n3 = l3["name"]
                if n3 in SKIP_EXACT or n3.endswith(SKIP_SUFFIX):
                    continue
                out.append({"domain": domain["name"], "path": [n2, n3],
                            "name": n3, "file": l3.get("file")})
    return out


def main():
    tree = parse_nav(WIKI)
    items = flatten(tree)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)

    from collections import Counter
    by_domain = Counter(i["domain"] for i in items)
    by_depth = Counter(len(i["path"]) for i in items)
    print(f"提取完成 → {OUT}")
    print(f"  条目总数 {len(items)}")
    print(f"  按学科: " + "  ".join(f"{k}={v}" for k, v in by_domain.most_common()))
    print(f"  按层级: " + "  ".join(f"{k}级={v}" for k, v in sorted(by_depth.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())

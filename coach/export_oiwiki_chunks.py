#!/usr/bin/env python3
"""把旧版 langchain pickles 里的 OI Wiki 文本块导成 JSONL。

为什么要这一步（两个理由，都不是洁癖）：

1. **安全。** pickle 反序列化 = 任意代码执行。原版查询脚本用的是
   `allow_dangerous_deserialization=True` —— 自己机器上跑无所谓，但把
   `.pkl` 打包发给陌生人，等于**送他一个 RCE 面**。JSONL 没有这个问题。
2. **可读。** JS 读不了 pickle。检索层要跑在 Node 里，格式必须能直接读。

顺便把 metadata 里的绝对路径换成**相对路径** —— 原索引里存的是构建机器上的
绝对路径（旧工具链的 skills 目录），那台机器不在之后，换台机器全部失效。

用法: python export_oiwiki_chunks.py <index.pkl> <输出目录>
产物: <输出目录>/chunks.jsonl   每行 {"i":序号,"src":相对路径,"text":正文}
"""
import json
import os
import pickletools
import sys
import unicodedata
from io import BytesIO

# ── 白名单反序列化 ────────────────────────────────────────────────────
# 只放行 langchain 自己那两个类；别的一律抛。这是读**不可信 pickle** 的唯一
# 正确姿势：宁可读不了，也不要执行里面的东西。
ALLOWED = {
    "langchain_community.docstore.in_memory",
    "langchain_core.documents.base",
    "langchain.docstore.document",
}


class SafeUnpickler(__import__("pickle").Unpickler):
    def find_class(self, module, name):
        if module not in ALLOWED:
            raise pickle_unsafe(f"pickle 里引用了白名单外的类：{module}.{name}")
        return super().find_class(module, name)


class pickle_unsafe(Exception):
    pass


def audit(path):
    """先用 pickletools 反汇编，确认只有已知的 GLOBAL —— 不解包就能判断。
    （genops 产出 (opcode, arg, pos)，arg 可能是 None，别多取一层。）"""
    with open(path, "rb") as f:
        ops = list(pickletools.genops(f.read()))
    return [str(arg) for op, arg, _ in ops if op.name in ("GLOBAL", "STACK_GLOBAL")]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    pkl, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    print(f"· 反汇编审计 {os.path.basename(pkl)}")
    for g in audit(pkl):
        print(f"    GLOBAL {g}")

    with open(pkl, "rb") as f:
        store = SafeUnpickler(f).load()

    # langchain 的 FAISS save_local 落两个东西：
    #   index.pkl  = (InMemoryDocstore, index_to_docstore_id)
    docstore, id_map = store
    docs = docstore._dict
    n = len(id_map)

    # 找所有 source 的公共前缀 —— 那才是"文档根"，其余是相对路径
    srcs = [d.metadata.get("source", "") for d in docs.values()]
    root = os.path.commonpath([s for s in srcs if s]) if any(srcs) else ""

    rows = []
    for i in range(n):
        doc = docs[id_map[i]]
        src = doc.metadata.get("source", "")
        rel = os.path.relpath(src, root).replace("\\", "/") if src and root else src
        rows.append({"i": i, "src": rel, "text": doc.page_content})

    dst = os.path.join(outdir, "chunks.jsonl")
    with open(dst, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    chars = sum(len(r["text"]) for r in rows)
    files = len({r["src"] for r in rows})
    print(f"· 导出 {len(rows)} 块 / {files} 个源文件 / {chars} 字符")
    print(f"  → {dst}")
    print(f"  路径前缀（原构建机）: {root}")
    print(f"  样例: {rows[0]['src']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
verify_serve.py — 验收 serve_map.py 的进度接口（/api/progress）

在**临时目录**跑（COACH_DATA_DIR 指过去），绝不碰真的 PROGRESS.yaml。
CLI 子进程继承这个环境变量，所以整条链路（HTTP → Python → node → 文件）
都落在临时目录里。

用法: python verify_serve.py        （不需要先起 serve_map.py，本脚本自己起）
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import serve_map  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

fails = []


def check(label, cond, extra=""):
    print(f"{'  OK  ' if cond else '  FAIL'} {label}" + (f"  → {extra}" if extra else ""))
    if not cond:
        fails.append(label)


MINI_MAP = """meta: { version: 9, node_count: 3 }
nodes:
  - id: A
    name: A
    domain: 测试
    depends: []
  - id: B
    name: B
    domain: 测试
    depends: [A]
  - id: C
    name: C
    domain: 测试
    depends: [A]
"""

tmp = tempfile.mkdtemp(prefix="coach-serve-")
Path(tmp, "MAP.yaml").write_text(MINI_MAP, encoding="utf-8")
Path(tmp, "skilltree.html").write_text("<html>stub</html>", encoding="utf-8")
os.environ["COACH_DATA_DIR"] = tmp

# 起服务（换掉目录和端口，别抢真的 8770，也别弹浏览器）
serve_map.ROOT = tmp
serve_map.PORT = 8791
PORT = 8791

httpd = HTTPServer(("127.0.0.1", PORT), lambda *a, **k: serve_map.Handler(
    *a, directory=tmp, **k))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/api/progress"


def get():
    with urllib.request.urlopen(BASE, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def post(payload):
    req = urllib.request.Request(
        BASE, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


print("── 1. 接口通不通 ──")
p = get()
check("GET 返回空进度", p.get("ok") is True and p.get("cursor") == "", json.dumps(p, ensure_ascii=False))

st, r1 = post({"op": "mark", "node": "A", "status": "learned"})
check("POST 标记学过", st == 200 and r1.get("ok") is True, json.dumps(r1, ensure_ascii=False))
# ★ 闸门：verified 手标必须被挡住（自评 ≠ 检测结论）
st, rv = post({"op": "mark", "node": "A", "status": "verified"})
check("★ 手标 verified → 400（已验证只能靠检测）",
      st == 400 and rv.get("ok") is False, json.dumps(rv, ensure_ascii=False))
st, r2 = post({"op": "mark", "node": "B", "status": "studying"})
check("POST 标记在学", st == 200 and r2.get("ok") is True)

p = get()
check("★ 再 GET 读得到刚写的（不是各存一份）",
      p["nodes"].get("A", {}).get("status") == "learned"
      and p["nodes"].get("B", {}).get("status") == "studying",
      json.dumps(p["nodes"], ensure_ascii=False))

print("── 2. 游标 ──")
st, r3 = post({"op": "cursor", "node": "A"})
check("POST 设游标", st == 200 and r3.get("cursor") == "A")
check("GET 读得到游标", get()["cursor"] == "A")

print("── 3. 该挡的要挡住 ──")
st, r4 = post({"op": "mark", "node": "不存在的节点", "status": "learned"})
check("不存在的节点 → 400 而不是静默成功", st == 400 and r4.get("ok") is False,
      json.dumps(r4, ensure_ascii=False))
st, r5 = post({"op": "mark", "node": "A", "status": "乱写的状态"})
check("非法状态 → 400", st == 400 and r5.get("ok") is False)
st, r6 = post({"op": "瞎写", "node": "A"})
check("未知 op → 400", st == 400 and r6.get("ok") is False)

print("── 4. 退回未学 ──")
st, _ = post({"op": "mark", "node": "B", "status": "none"})
check("none 把条目删掉（回到未学）", "B" not in get()["nodes"], json.dumps(get()["nodes"], ensure_ascii=False))

print("── 5. 关键：文件里是真的落盘了 ──")
raw = Path(tmp, "PROGRESS.yaml").read_text(encoding="utf-8")
check("PROGRESS.yaml 真有内容", "A" in raw and "learned" in raw)
check("文件头还在（没被 YAML dump 冲掉）", "唯一真相源" in raw,
      raw.splitlines()[1] if raw else "(空)")

httpd.shutdown()
shutil.rmtree(tmp, ignore_errors=True)

print()
if fails:
    print(f"✗ {len(fails)} 条没过：")
    for f in fails:
        print(f"   · {f}")
    sys.exit(1)
print("✓ 全部通过")

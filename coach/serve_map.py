#!/usr/bin/env python3
"""
serve_map.py — 起个本地端口看技能树，并让页面能标进度

skilltree.html 是**视图**：节点/边从 MAP.yaml 来，进度从 PROGRESS.yaml 来，
自己一份数据都不存（原则 4：单一真相源）。

── 为什么不在这里读写 YAML ────────────────────────────────────
看着更省事，但会让 PROGRESS.yaml 有**两个写入实现**（这边 Python 一个、
插件 JS 一个），两套 YAML 库、两种输出风格；而且 PyYAML 不吃注释，
文件头那段状态说明第一次写就没了。

所以本文件**不 import yaml**，所有进度读写都 shell 出去跑
`progress-cli.mjs` —— 那是插件自己的代码（原子写、损坏时抛错、
文件头重贴，全复用）。这里只做一件事：把 HTTP 翻译成一次 CLI 调用。

页面一度把标记存在浏览器 localStorage —— 那是**第二份真相**。
这个项目在别处刚花一整轮治同一个病，不能自己家再长一个。

用法: python serve_map.py     → 自动开浏览器，Ctrl+C 停
"""
import functools
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import webbrowser

for _s in (sys.stdout, sys.stderr):
    if _s and hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

PORT = 8770
ROOT = os.path.join(os.path.expanduser("~"), ".dsh", "knowledge")

# 跑「已安装副本」里的 CLI，不是插件源码目录 ——
# 源码目录下 import 不到 yaml 和 @deepseek-ai/dsh-tools（实测 ERR_MODULE_NOT_FOUND）
CLI = os.path.join(
    os.path.expanduser("~"), ".dsh", "profiles", "web", "node_modules",
    "acmer-coach", "progress-cli.mjs",
)


def run_cli(*args):
    """跑一次进度 CLI，返回它那行 JSON。

    失败**必须抛**：调用方要靠它区分「真的没进度」和「读写出错了」。
    吞掉异常返回空对象 = 界面显示一切正常，实际什么都没动。
    """
    node = shutil.which("node")
    if not node:
        raise RuntimeError("找不到 node")
    p = subprocess.run(
        [node, CLI, *args],
        capture_output=True, text=True, encoding="utf-8", timeout=20,
    )
    lines = [l for l in (p.stdout or "").splitlines() if l.strip()]
    if not lines:
        raise RuntimeError((p.stderr or "").strip() or "progress-cli 没有输出")
    return json.loads(lines[-1])


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass                      # 别刷屏

    def end_headers(self):
        # 免得改了 YAML 重新生成 html 后浏览器还拿旧的
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/progress":
            try:
                self._json(200, run_cli("get"))
            except Exception as e:      # 全兜住报给前端 —— 别让页面以为"没数据"
                self._json(500, {"ok": False, "reject": str(e)})
            return
        if path == "/api/schedule":
            try:
                self._json(200, run_cli("sched-get"))
            except Exception as e:
                self._json(500, {"ok": False, "reject": str(e)})
            return
        # 访问根路径不该给**目录列表** ——
        # 那长得像文件系统，不像技能树，还得手敲 /skilltree.html。
        # 重定向过去，地址栏也跟着对。
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/skilltree.html")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/schedule":
            # 日程写入。**本文件不碰 YAML** —— 理由和上面一样（单一写实现），
            # 所以还是 shell 出去跑 CLI，只是换个命令。
            try:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(n) or b"{}")
                res = run_cli(
                    "sched-set",
                    str(req.get("date") or ""),
                    str(req.get("field") or ""),
                    json.dumps(req.get("value") or [], ensure_ascii=False),
                )
                self._json(200 if res.get("ok") else 400, res)
            except Exception as e:      # noqa: BLE001
                self._json(500, {"ok": False, "reject": str(e)})
            return
        if path != "/api/progress":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            op = req.get("op")
            node = str(req.get("node") or "")
            if op == "mark":
                res = run_cli("mark", node, str(req.get("status") or ""))
            elif op == "cursor":
                res = run_cli("cursor", node)
            else:
                self._json(400, {"ok": False, "reject": f"未知 op「{op}」，只有 mark / cursor"})
                return
            self._json(200 if res.get("ok") else 400, res)
        except Exception as e:          # noqa: BLE001
            self._json(500, {"ok": False, "reject": str(e)})


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    if not os.path.exists(os.path.join(ROOT, "skilltree.html")):
        print("❌ 还没有 skilltree.html —— 先跑 python render_skilltree.py")
        return 1
    if not os.path.exists(CLI):
        print(f"❌ 找不到进度 CLI：{CLI}")
        print("   先跑 bash ~/.dsh/plugins/acmer-coach/dev.sh 把插件装进 profile")
        return 1
    # 启动先探一次：读不通就别假装能用，直接说清楚
    try:
        p = run_cli("get")
        print(f"🐋 进度读得到：游标 {p.get('cursor') or '（未设）'}，"
              f"{len(p.get('nodes') or {})} 个节点有状态")
    except Exception as e:              # noqa: BLE001
        print(f"❌ 读 PROGRESS.yaml 失败：{e}")
        return 1

    url = f"http://127.0.0.1:{PORT}/skilltree.html"
    with Server(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)) as httpd:
        print(f"🐋 技能树  →  {url}")
        print("   Ctrl+C 停")
        # --no-open：自动化验页面时用，免得抢人屏幕
        if "--no-open" not in sys.argv:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n停了")
    return 0


if __name__ == "__main__":
    sys.exit(main())

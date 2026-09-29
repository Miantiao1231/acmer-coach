#!/usr/bin/env python3
"""把题池导出成随包发的 JSONL.gz。

**为什么要随包发**：`coach_pool` 挑候选时要满足「他没做过」这个条件。
没有题池的话，候选只能从他做过的那几道里挑 —— 那个条件永远满足不了，
教练就废了一半。

**为什么是 gzip**：41k 道题的标签/标题是高度重复的文本，gzip 压到 1/5。
不压的话包里多 4.8MB 纯文本。

⚠️ **数据来源与风险**（见 assets/pool/LICENSE）：
   · codeforces —— 官方公开 API（`problemset.problems`），可随时重新拉
   · nowcoder   —— `ac.nowcoder.com/acm/problem/list/json`，公开接口但**非官方承诺**
   · luogu      —— **爬取的**。洛谷的 ToS 不允许抓取，且已有账号因此被封的先例。
                   这一部分的再分发**有风险**，用不用由使用者自己判断。

用法:
  python export_problem_pool.py <training.db> <输出目录>
产物: <输出目录>/problems.jsonl.gz
"""
import gzip
import json
import os
import sqlite3
import sys


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    db_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute(
        """SELECT platform, problem_id, title, difficulty, tags, url
           FROM unified_problems
           WHERE is_library = 1 AND problem_id IS NOT NULL AND problem_id != ''
           ORDER BY platform, problem_id""").fetchall()
    con.close()

    dst = os.path.join(outdir, "problems.jsonl.gz")
    n = 0
    with gzip.open(dst, "wt", encoding="utf-8", compresslevel=9) as f:
        for platform, pid, title, diff, tags, url in rows:
            f.write(json.dumps({
                "p": platform, "i": pid, "t": title or "",
                "d": float(diff or 0), "g": tags or "", "u": url or "",
            }, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1

    size = os.path.getsize(dst) / 1024 / 1024
    by = {}
    for r in rows:
        by[r[0]] = by.get(r[0], 0) + 1
    print(f"· 导出 {n} 道 → {dst}  ({size:.2f} MB)")
    for k, v in sorted(by.items()):
        print(f"    {k:12} {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

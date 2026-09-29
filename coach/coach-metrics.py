#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""coach-metrics — 只报「真的能说明问题」的三个数（给小鲸用）

为什么只有这三个：教育研究里能证伪「当堂会了」的只有**延迟复测**和**没练过的新题**。
刷题数、在线时长那类叫 vanity metric —— 好看，但和水平只有弱相关，报它等于骗人。

1. 保持率   —— 同一节点，相邻两次检测间隔 >= 7 天时，后一次的通过率
2. 首通率   —— 按标签：第一次提交就 AC 的比例（他没练过的题才算数）
3. 卡住标记 —— 检测连续没过、或「在学」放太久还没验的节点

用法:
    python ~/.dsh/scripts/coach-metrics.py             # 人读
    python ~/.dsh/scripts/coach-metrics.py --json      # 机读
    python ~/.dsh/scripts/coach-metrics.py --selftest  # 自检

环境变量 COACH_DB / COACH_PROGRESS 可覆盖路径（与 acmer-coach 插件同一套约定）。
"""
import json
import os
import sqlite3
import sys
from datetime import date, datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOME = os.path.expanduser("~")
DB_PATH = os.environ.get("COACH_DB") or os.path.join(HOME, ".dsh", "data", "training.db")
PROGRESS_PATH = os.environ.get("COACH_PROGRESS") or os.path.join(
    HOME, ".dsh", "knowledge", "PROGRESS.yaml")

# 训练库里的账号 handle。COACH_TRAINER 没给就去 users 里取第一条
# —— 单用户是常态，没有理由写死某个 handle。
TRAINER_HANDLES = tuple(
    h for h in (os.environ.get("COACH_TRAINER"),) if h
)
RETENTION_GAP_DAYS = 7      # 「隔了 ≥7 天还做得出」才算保持
STUCK_CHECK_FAILS = 2       # 检测连续没过几次就标记
STUCK_IDLE_DAYS = 14        # 「在学」放多久还没验就标记
MIN_TAG_SAMPLE = 5          # 标签题量不足这个数就不报（小样本会骗人）


# ── 数据读取 ──────────────────────────────────────────────────────────

def load_progress(path=PROGRESS_PATH):
    import yaml
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _as_date(v):
    """PROGRESS 里的日期可能是 date，也可能是字符串（老数据/手改）。"""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except Exception:
        return None


def trainer_id(db):
    q = "SELECT id FROM users WHERE cf_handle = ? OR handle = ? LIMIT 1"
    for h in TRAINER_HANDLES:
        row = db.execute(q, (h, h)).fetchone()
        if row:
            return row[0]
    row = db.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
    return row[0] if row else None


# ── 指标 ─────────────────────────────────────────────────────────────

def retention(progress):
    """保持率：同节点相邻两次检测间隔 >=7 天，取后一次的通过情况。

    样本不足时**如实说不足** —— 不要用 0 对样本算出一个看着像样的百分比。
    """
    pairs = []
    for node, rec in (progress.get("nodes") or {}).items():
        # 只拿**真做过**的检测配对。弃考（abandoned）不是一次测量 ——
        # 把它算进分母，等于把"卷子作废"读成"他忘了"，那是两种完全不同的信号。
        checks = sorted(
            (c for c in (rec or {}).get("checks") or []
             if _as_date(c.get("date")) and c.get("outcome") in ("passed", "failed")),
            key=lambda c: _as_date(c["date"]))
        for prev, cur in zip(checks, checks[1:]):
            gap = (_as_date(cur["date"]) - _as_date(prev["date"])).days
            if gap >= RETENTION_GAP_DAYS:
                pairs.append({"node": node, "gapDays": gap,
                              "from": str(_as_date(prev["date"])),
                              "on": str(_as_date(cur["date"])),
                              "outcome": cur.get("outcome")})
    passed = sum(1 for p in pairs if p["outcome"] == "passed")
    return {
        "pairs": len(pairs),
        "passed": passed,
        "rate": (passed / len(pairs)) if pairs else None,
        "detail": pairs[-5:],
    }


def first_attempt_by_tag(db, uid):
    """首通率（按标签）：每题**最早一次提交**的结果，AC 才算通。"""
    rows = db.execute(
        """
        SELECT s.platform, s.problem_id, s.verdict,
               (SELECT verdict FROM unified_submissions x
                 WHERE x.user_id = s.user_id AND x.platform = s.platform
                   AND x.problem_id = s.problem_id
                 ORDER BY x.submitted_at ASC LIMIT 1) AS first_verdict,
               p.tags
          FROM unified_submissions s
          LEFT JOIN unified_problems p
                 ON p.platform = s.platform AND p.problem_id = s.problem_id
         WHERE s.user_id = ?
        """, (uid,)).fetchall()

    seen, per_tag = set(), {}
    for platform, pid, _verdict, first_verdict, tags in rows:
        key = (platform, pid)
        if key in seen or first_verdict is None:
            continue
        seen.add(key)
        for tag in (tags or "").split(","):
            tag = tag.strip()
            if not tag:
                continue
            bucket = per_tag.setdefault(tag, {"n": 0, "ac": 0})
            bucket["n"] += 1
            if first_verdict == "AC":
                bucket["ac"] += 1

    # 计数留着原样，别从取整后的比例反推 —— round 会吃掉一两道题
    ranked = [{"tag": t, "n": v["n"], "ac": v["ac"], "cfa": v["ac"] / v["n"]}
              for t, v in per_tag.items() if v["n"] >= MIN_TAG_SAMPLE]
    ranked.sort(key=lambda r: (r["cfa"], -r["n"]))
    total_n = sum(r["n"] for r in ranked)
    total_ac = sum(r["ac"] for r in ranked)
    return {
        "problems": len(seen),
        "overall": {"n": total_n, "cfa": (total_ac / total_n) if total_n else None},
        "weakest": ranked[:5],
        "strongest": ranked[-5:][::-1],
    }


def stuck(progress, today=None):
    """卡住标记：**最近一次真做过的检测没过**，或「在学」放太久还没验。

    ⚠️ 三条别踩的坑（前两条是真踩过的）：
      1. **弃考（abandoned）不算没过** —— 那是卷子作废，信号在组卷那边，不在人身上。
      2. **他后来过了就不算卡住** —— 二分那个节点就是：2 次没过 + 2 次作废，
         但最后一次 4 分通过、状态已是 verified。只看"没过几次"会冤枉他。
      3. 卡住是"最近一次没过"，不是"历史上错过"。
    """
    today = today or date.today()
    out, cancelled = [], []
    for node, rec in (progress.get("nodes") or {}).items():
        rec = rec or {}
        checks = rec.get("checks") or []
        valid = [c for c in checks
                 if c.get("outcome") in ("passed", "failed") and _as_date(c.get("date"))]
        valid.sort(key=lambda c: _as_date(c["date"]))
        fails = [c for c in valid if c.get("outcome") == "failed"]
        drops = [c for c in checks if c.get("outcome") == "abandoned"]
        status = rec.get("status")
        at = _as_date(rec.get("at"))
        idle = (today - at).days if at else None

        why = []
        last = valid[-1] if valid else None
        if last is not None and last.get("outcome") == "failed" and len(fails) >= STUCK_CHECK_FAILS:
            why.append(f"最近一次检测没过（累计没过 {len(fails)} 次）")
        if status == "studying" and idle is not None and idle >= STUCK_IDLE_DAYS:
            why.append(f"在学放了 {idle} 天还没验")
        if why:
            out.append({"node": node, "status": status, "idleDays": idle,
                        "fails": len(fails), "why": "；".join(why),
                        "lastFail": str(_as_date(fails[-1]["date"])) if fails else None})

        # 弃考是**组卷质量的信号**：卷子作废多了，该看题库/标签，不是看人。
        if len(drops) >= STUCK_CHECK_FAILS:
            cancelled.append({
                "node": node, "drops": len(drops),
                "reasons": [str(d.get("reason") or "").strip()[:60] for d in drops][-2:],
                "last": str(_as_date(drops[-1]["date"])) if _as_date(drops[-1].get("date")) else None,
            })

    out.sort(key=lambda r: (-r["fails"], -(r["idleDays"] or 0)))
    cancelled.sort(key=lambda r: -r["drops"])
    return {"stuck": out, "cancelled": cancelled}


def survey(progress):
    counts = {}
    for rec in (progress.get("nodes") or {}).values():
        s = (rec or {}).get("status") or "未学"
        counts[s] = counts.get(s, 0) + 1
    return counts


# ── 输出 ─────────────────────────────────────────────────────────────

def collect():
    progress = load_progress()
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        uid = trainer_id(db)
        if uid is None:
            return {"error": "训练库里 users 表是空的，找不到账号"}
        return {
            "userId": uid,
            "survey": survey(progress),
            "retention": retention(progress),
            "cfa": first_attempt_by_tag(db, uid),
            "stuck": stuck(progress),
        }
    finally:
        db.close()


def render(d):
    if "error" in d:
        return f"读取失败：{d['error']}"
    L = []
    s = d["survey"]
    L.append("── 进度总览 " + " / ".join(f"{k} {v}" for k, v in sorted(s.items())))
    r = d["retention"]
    if r["rate"] is None:
        L.append(f"── 保持率（隔 ≥{RETENTION_GAP_DAYS} 天还做得出）：**样本不足**"
                 f"（现有 {r['pairs']} 对复测，不足 3 对就别下结论）")
    else:
        L.append(f"── 保持率（隔 ≥{RETENTION_GAP_DAYS} 天还做得出）："
                 f"{r['passed']}/{r['pairs']} = {r['rate']:.0%}")
    c = d["cfa"]
    if c["overall"]["cfa"] is not None:
        L.append(f"── 首通率（他第一次提交就 AC）：{c['overall']['cfa']:.0%}"
                 f"（覆盖 {c['overall']['n']} 题·标签对）")
    if c["weakest"]:
        L.append("   最弱标签：" + "、".join(
            f"{x['tag']} {x['cfa']:.0%}(n={x['n']})" for x in c["weakest"]))
        L.append("   最强标签：" + "、".join(
            f"{x['tag']} {x['cfa']:.0%}(n={x['n']})" for x in c["strongest"]))
    if d["stuck"]["stuck"]:
        L.append("── ⚠️ 卡住标记（换法子，别继续喂题）：")
        for x in d["stuck"]["stuck"][:8]:
            L.append(f"   · {x['node']} —— {x['why']}（最近失败 {x['lastFail']}）")
    else:
        L.append("── 卡住标记：无")
    if d["stuck"]["cancelled"]:
        L.append("── ⚠️ 卷子反复作废（**别算在他头上**，去看组卷）：")
        for x in d["stuck"]["cancelled"][:5]:
            r = "；".join(s for s in x["reasons"] if s)
            L.append(f"   · {x['node']} —— 作废 {x['drops']} 次（最近 {x['last']}）"
                     + (f"；原因：{r}" if r else ""))
    return "\n".join(L)


def selftest():
    """最小自检：两个指标各喂一个手算得出的夹具，对不上就报错。"""
    prog = {"nodes": {
        "A": {"status": "verified", "checks": [
            {"date": "2026-01-01", "outcome": "passed"},
            {"date": "2026-01-12", "outcome": "passed"},
            {"date": "2026-01-13", "outcome": "failed"},   # 间隔 1 天，不计入
        ]},
        "B": {"status": "studying", "at": date(2026, 1, 1), "checks": [
            {"date": "2026-02-01", "outcome": "failed"},
            {"date": "2026-02-02", "outcome": "failed"},
        ]},
        # C 是踩过的真形状：两次没过 + 两次作废，但**最后过了**。
        # 只看"没过几次"会把这种判成卡住 —— 冤枉人。
        "C": {"status": "verified", "checks": [
            {"date": "2026-02-01", "outcome": "abandoned", "reason": "难度结构失衡"},
            {"date": "2026-02-02", "outcome": "failed"},
            {"date": "2026-02-03", "outcome": "failed"},
            {"date": "2026-02-04", "outcome": "abandoned", "reason": "题已被 AC 过"},
            {"date": "2026-02-05", "outcome": "passed"},
        ]},
    }}
    r = retention(prog)
    assert r["pairs"] == 1 and r["passed"] == 1, f"保持率算错: {r}"
    st = stuck(prog, today=date(2026, 3, 1))
    assert {x["node"] for x in st["stuck"]} == {"B"}, f"卡住标记算错: {st['stuck']}"
    assert [x["node"] for x in st["cancelled"]] == ["C"], f"作废标记算错: {st['cancelled']}"
    # 首通：同一题提交两次，只看最早那次
    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE unified_submissions (user_id,platform,problem_id,verdict,submitted_at);
        CREATE TABLE unified_problems (platform,problem_id,tags);
        INSERT INTO unified_problems VALUES ('cf','1A','math'),('cf','1B','math'),
            ('cf','1C','math'),('cf','1D','math'),('cf','1E','math');
        INSERT INTO unified_submissions VALUES
            (1,'cf','1A','WA','2026-01-01'), (1,'cf','1A','AC','2026-01-02'),
            (1,'cf','1B','AC','2026-01-01'), (1,'cf','1C','AC','2026-01-01'),
            (1,'cf','1D','WA','2026-01-01'), (1,'cf','1E','AC','2026-01-01');
    """)
    c = first_attempt_by_tag(db, 1)
    assert c["problems"] == 5, c
    # 1A / 1D 的首交是 WA —— 后面补交的 AC 不算数，所以是 3/5 不是 4/5
    assert abs(c["overall"]["cfa"] - 3 / 5) < 1e-9, c
    print("selftest ok（保持率 / 卡住标记 / 首通率 三项都对得上）")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif "--json" in sys.argv:
        print(json.dumps(collect(), ensure_ascii=False, indent=2, default=str))
    else:
        print(render(collect()))

#!/usr/bin/env bash
# acmer-coach 开发回路：同步 + 验收，一条命令。改完就跑它。
#
# 前提：插件以 `file:` 依赖装进了某个 profile。
#   默认 profile 是 web；要换就设 COACH_PROFILES（空格分隔，可多个）。
#   要换 dsh 家目录就设 DSH_HOME。
#
# 一个坑，两道保险：
#   `file:` 依赖装出来的是**硬链接**。原地写两边同变，但改名式写入（Edit 工具、
#   VS Code 原子保存、vim backupcopy=no）会**断开链接** —— 断开后两边分家，
#   而同步认不出分家、**不报错**。于是"改完 → 测试绿"可以一路绿到底却验的是
#   老代码，而且这个坑是静默的。
#   第一道：下面逐个文件比 inode / 内容，不一致就 cp 过去。
#   第二道：verify.mjs 第 0 关自己比源码和副本，不一致直接 exit 1。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BITSH="${SRC_DIR//\\//}"                  # Windows 上给 python/node 用的正斜杠形式
SRC_BASH="$BITSH"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_HOME_BASH="${DSH_HOME//\\//}"

# ⚠️ 一份也不能漏。半同步的插件会让每一次「代码到底变没变」的判断都不可靠 ——
# 你会花整晚排查一个"明明改了却不生效"的问题，而它只是副本没跟上。
# 所以这里列**全部**要同步的 profile。
read -r -a PROFILES <<< "${COACH_PROFILES:-web}"
DSTS=()
for p in "${PROFILES[@]}"; do
  DSTS+=("$DSH_HOME_BASH/profiles/$p/node_modules/acmer-coach")
done

# 要比**全部**文件，不只是 index.js —— 副本里任何一份落后的文件都会让
# "验的是这一份、跑的是那一份"这种分家看不见。
# ⚠️ dev.sh 自己也在列表里。它一度不在，于是副本里留着一份**旧版 dev.sh**：
# 从副本目录跑 `bash dev.sh` 走的是另一条路（`dsh plugin remove/add`，而那条
# 路不可靠），和这份的行为不一样。换句话说，**同一个命令，从哪个目录按回车
# 决定跑哪份脚本** —— 两份 dev.sh 就是两份真相，正是这份文件在防的那种坑。
SYNC_FILES='index.js package.json verify.mjs verify-shape.mjs progress-cli.mjs build-node-meta.mjs cordis.patch.yml README.md lib/client.js lib/setup.js lib/curriculum.js lib/curriculum-evidence.js lib/curriculum-planning.js lib/strategy.js assets/knowledge/COMPETENCIES.yaml assets/rules/coach-rules.md dev/curriculum-check.mjs dev/curriculum-evidence-check.mjs dev/strategy-check.mjs docs/长期课程机制.md dev.sh'
STALE=''
for f in $SYNC_FILES; do
  for d in "${DSTS[@]}"; do
    [ -d "$d" ] || continue
    diff -q "$SRC_BASH/$f" "$d/$f" >/dev/null 2>&1 || STALE="$STALE $f"
  done
done

if [ -z "$STALE" ]; then
  echo '· 副本已是最新，跳过同步'
else
  # 直接 cp，**不走 `dsh plugin remove/add`** —— 那条路不可靠：pnpm 对
  # `file:` 依赖可能只做复制，而且复制的是它 store 里的**缓存版本**，于是
  # add 打印成功、副本却仍是旧的。更阴的是 9 个文件里只有被改名式写入动过的
  # 那个会断链，其余仍是硬链接 —— "有的同步了有的没有"，最难查的那种症状。
  # dsh 读的就是这个路径下的文件，cp 过去立刻生效，也不依赖 pnpm 心情。
  echo "· 副本落后（$STALE ），同步中…"
  for f in $SYNC_FILES; do
    for d in "${DSTS[@]}"; do
      [ -d "$d" ] || continue
      # 硬链接还活着的（两边是**同一个 inode**）直接跳过：那种情况本来就
      # "改一边两边同变"，再 cp 一次是多余的，而且 `cp` 发现自己跟目标是同一
      # 文件会**报错** —— `set -e` 之下这一下就把整个脚本打断了。
      [ "$SRC_BASH/$f" -ef "$d/$f" ] && continue
      mkdir -p "$d/$(dirname "$f")"
      cp "$SRC_BASH/$f" "$d/$f"
    done
  done
fi

# 同步完**自动比一次哈希**：几份必须逐字节一致，不一致就报错退出。
# 某个副本静默落后过一次，而"以为同步了"正是那次排查卡住的地方 ——
# 别让它有第二次。不一致就别往下测，测的会是另一份代码。
FAIL_SYNC=''
for f in $SYNC_FILES; do
  a=$(sha256sum "$SRC_BASH/$f" | cut -d' ' -f1)
  for d in "${DSTS[@]}"; do
    [ -d "$d" ] || continue
    # `|| true`：副本缺文件时别让 set -e 把整个脚本掐在一条看不懂的错上
    b=$(sha256sum "$d/$f" 2>/dev/null | cut -d' ' -f1 || true)
    [ "$a" = "$b" ] || FAIL_SYNC="$FAIL_SYNC ${f}@$(basename "$(dirname "$(dirname "$d")")")"
  done
done
if [ -n "$FAIL_SYNC" ]; then
  echo "✗ 同步后哈希仍不一致：$FAIL_SYNC"
  echo '  别往下测 —— 测的会是另一份代码。'
  exit 1
fi
echo '· 全部副本哈希一致'

# ── 自检的账本闸门 ────────────────────────────────────────────────
# 起因：verify.mjs 前面几节一度用的是**默认数据目录**（＝真账本）。
# coach_assign 一开始落盘，一条"正常布置"就把幻影任务写进了真 PROGRESS.yaml
# —— 重启后教练会去追一个根本不存在的活，当场毁信任。
# 病因已修（那几节改跑临时副本），这条是**兜底闸门**：自检跑完比一次指纹，
# 一变就报错退出。这种事不靠自觉，靠闸门。
LEDGER_DIR="$DSH_HOME_BASH/knowledge"
LEDGERS='PROGRESS.yaml SCHEDULE.yaml CURRICULUM.yaml'
ledger_fp() { (cd "$LEDGER_DIR" 2>/dev/null && sha256sum $LEDGERS 2>/dev/null || true); }
LEDGER_BEFORE=$(ledger_fp)

echo
# `|| RC=$?` 而不是裸跑：set -e 会在第一条命令失败时就掐掉整个脚本，
# 后面那段提醒就永远不打印 —— 而失败的时候恰恰最需要它。
node "$SRC_BASH/verify.mjs" || VERIFY_RC=$?
VERIFY_RC=${VERIFY_RC:-0}

echo
echo '── 全工具形状扫描（每个工具真跑一遍，返回值递归对 schema）──'
node "$SRC_BASH/verify-shape.mjs" || SHAPE_RC=$?
SHAPE_RC=${SHAPE_RC:-0}

echo
echo '── 长期课程验收（隔离数据、真实工具与会话状态）──'
node --test "$SRC_BASH/dev/curriculum-check.mjs" || CURRICULUM_RC=$?
CURRICULUM_RC=${CURRICULUM_RC:-0}

echo
echo '── 编排证据验收（目录、引用、事件身份与重复记录）──'
node --test "$SRC_BASH/dev/curriculum-evidence-check.mjs" || EVIDENCE_RC=$?
EVIDENCE_RC=${EVIDENCE_RC:-0}

LEDGER_AFTER=$(ledger_fp)
if [ "$LEDGER_BEFORE" != "$LEDGER_AFTER" ]; then
  echo
  echo '✗ **自检把真账本改了** —— 自检必须跑在临时副本上（COACH_DATA_DIR 指 mkdtemp）：'
  printf '%s\n' "$LEDGER_BEFORE" | sed 's/^/  之前 /'
  printf '%s\n' "$LEDGER_AFTER"  | sed 's/^/  之后 /'
  exit 1
fi
echo '· 真账本一字未动'

# 提醒"活进程还挂着旧模块"。
# cordis 的 HMR 只重载配置，不重新 import 模块本体 —— ESM 模块在进程里只求值
# 一次，之后永远命中缓存。所以磁盘更新了，跑着的 dsh web 还是老版本，
# **不报错、不报警**。上面 verify.mjs 走的是全新 import，验不到这一层。
# 不自动重启：重启会打断正在用的会话，得用户自己点头。
#
# 探两个端口。3080 是 dsh 的默认值，但 Windows 的**保留端口区**会把它吃掉 ——
# 报的是 EACCES 不是 EADDRINUSE，因为压根不是"被占用"，是系统不让绑。
# 撞上时得靠 `--port` 换一个，所以这里多探一个 8181：只探 3080 的话，
# 换端口之后这条提醒会**静默失效**，而它失效的后果是
# "改完代码以为生效了，其实跑的还是旧模块"。
DSH_LIVE=''
for p in 3080 8181; do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then DSH_LIVE="$p"; break; fi
done
if [ -n "$DSH_LIVE" ]; then
  echo
  echo "⚠ dsh web 正在跑（$DSH_LIVE 有响应），它加载的仍是**旧模块**。"
  echo '  要验「工具挂进教练的清单里」，得先重启 dsh。'
fi

exit $(( VERIFY_RC + SHAPE_RC + CURRICULUM_RC + EVIDENCE_RC ))

#!/usr/bin/env bash
# 一条命令跑全套验收。
#
# 六套：
#   verify / verify-shape   主验收（509 条断言 + 19 个工具的形状扫描）
#   w1-check                解绑、夹具闸门、规则注入
#   wiki-check              OI Wiki 检索
#   setup-check             冷启动（离线）
#   parity-check            和线上那份的保真度对比
#
# 主验收跑的是**已安装副本**（不是源码）—— 那才是运行时真正加载的东西。
# 所以这里先搭一个隔离的"已安装"目录，不碰任何真实 profile。
#
# 跑法：bash dev/run-all.sh
#   加 COACH_TEST_NET=1 连联网段一起跑
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
SRC="$(pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INST="$TMP/profiles/web/node_modules/acmer-coach"
mkdir -p "$INST" "$TMP/knowledge"
tar cf - --exclude=node_modules --exclude=dev --exclude=.git . | (cd "$INST" && tar xf -)

# 隔离目录也得能解析依赖（yaml、@deepseek-ai/*）。
# 真实安装时这两样由 pnpm 装好；这里用 junction 接到 dsh 自带的那份。
# 用 node 建而不是 cmd：Windows 路径带空格，走 shell 的引号很容易被吃掉。
APP_NM="${DSH_APP_NODE_MODULES:-C:/Aplication/dsh desktop/resources/app/node_modules}"
if [ -d "$APP_NM" ]; then
  node -e "
    const fs=require('fs');
    try { fs.symlinkSync(process.argv[1], process.argv[2], 'junction') } catch(e) { if(e.code!=='EEXIST') throw e }
  " "$APP_NM" "$INST/node_modules" || echo "⚠ junction 建失败，主验收会缺依赖"
fi

RC=0
run() {  # run <名字> <命令...>
  local name="$1"; shift
  printf '%-16s ' "$name"
  if out=$("$@" 2>&1); then
    echo "✓ $(echo "$out" | tail -1)"
  else
    echo "✗"
    echo "$out" | tail -25 | sed 's/^/    /'
    RC=1
  fi
}

export DSH_HOME="$TMP"
export COACH_VERIFY_PROFILE=web
export COACH_DEFAULT_KNOWLEDGE="$TMP/knowledge"

cd "$TMP/profiles/web/node_modules/acmer-coach"
run "verify"        node verify.mjs
run "verify-shape"  node verify-shape.mjs
cd "$SRC"
run "w1-check"      node dev/w1-check.mjs
run "wiki-check"    node dev/wiki-check.mjs
run "setup-check"   node dev/setup-check.mjs
run "parity-check"  node dev/parity-check.mjs

echo
if [ "${COACH_TEST_NET:-0}" = "1" ]; then
  echo "（联网段）"
  COACH_TEST_NET=1 node dev/setup-check.mjs "${1:-tourist}" 2>&1 | tail -8 | sed 's/^/    /'
fi

[ $RC -eq 0 ] && echo "✓ 全套通过" || echo "✗ 有失败"
exit $RC

#!/usr/bin/env bash
# 开源前反证：扫全仓库，证明没留私人痕迹。
#
# 为什么要有这个：这类泄漏**单点看不出** —— 一段注释里的私人路径、
# 一句带着个人称谓的引语，单看都像人话。得拿一张关键词表把你自己的过去 grep 一遍。
#
# 扫「已跟踪 + 未跟踪（非 ignore）」的全部文件 —— 提交前跑，新文件也在内。
# 模式表随踩随加：每发现一种新泄漏就在下面补一行，并写清为什么。
#
# 排除：assets/pool、assets/oiwiki（第三方内容，不是我们的痕迹）、
#       本脚本自身（模式表里含敏感词，扫自己必中）。
#
# 用法：bash dev/trace-scan.sh
#   命中任何一条 → exit 1。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

FILES=$(git ls-files --cached --others --exclude-standard | grep -v -E '^(assets/(pool|oiwiki)/|dev/trace-scan\.sh$)' || true)
N=$(echo "$FILES" | wc -l)

HITS=0
scan() {  # scan <标签> <正则>
  local label="$1" pat="$2" out
  out=$(echo "$FILES" | xargs -d '\n' -r grep -nE "$pat" 2>/dev/null | head -20)
  if [ -n "$out" ]; then
    HITS=$((HITS + 1))
    echo "✗ $label"
    echo "$out" | sed 's/^/    /'
  else
    echo "✓ $label"
  fi
}

echo "── 私人痕迹扫描（$N 个文件，排除第三方内容与本脚本）──"

# 数字 ID 拼接写 —— 否则这条模式会自己命中自己所在的这行。
scan "本机数字 ID / Windows 用户目录" '3'"8689"'|/c/Users/|C:\\Users\\'
scan "个人代号（Mianiii 之类）" 'Mianii'
scan "私有服务与旧项目名" 'xiaojing|101\.200\.232|shrimp|vp_platform|openclaw'
scan "私人项目 / 私人路径" '咱仨|whale-dashboard|Documents.Note|\.dsh\\'

echo
[ $HITS -eq 0 ] && echo "✓ 全过（$N 个文件零命中）" || echo "✗ 有 $HITS 类命中，逐条核对上面"
exit $HITS

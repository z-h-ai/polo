#!/usr/bin/env bash
# lint:ipc-sends — Electron IPC 边界卫生检查（根 package.json 的 lint 链第一步）。
#
# 目的：渲染层（apps/electron/src/renderer）禁止绕过 preload 白名单直接触碰
# ipcRenderer（send/invoke/sendSync/sendToHost/…）。所有特权 IPC 必须经
# apps/electron/src/preload 下经 contextBridge 暴露的白名单 API。
#
# 考古结论（2026-10，FIX 卡）：根 package.json 自 v0.7.0（commit 24ab7850，
# github-actions 机器人 squash 导入）起就引用本脚本，但
#   git log --all -- scripts/check-raw-sends.sh          -> 无任何提交
#   git log --all -S "check-raw-sends" + 逐提交树检查    -> 脚本本体从未入库
# 原实现不可恢复，本脚本是按上述目的新写的等价检查（grep 实现）。
#
# 规则：
#   1. renderer 下不得出现 ipcRenderer 引用（任何 API 形态，含字符串注释之外
#      的真实代码；html 内联脚本同样检查）。
#   2. renderer 下不得 import/require 'electron'（渲染层唯一合法入口是
#      preload 桥挂到 window 上的 API）。
#   3. preload 白名单目录必须存在。
#
# 通过时静默输出一行 OK，违规时逐行列出 file:line 并以 1 退出。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENDERER="$ROOT/apps/electron/src/renderer"
PRELOAD="$ROOT/apps/electron/src/preload"

fail=0

if [ ! -d "$RENDERER" ]; then
  echo "lint:ipc-sends: renderer directory missing: $RENDERER" >&2
  exit 1
fi

if [ ! -d "$PRELOAD" ]; then
  echo "lint:ipc-sends: preload whitelist directory missing: $PRELOAD" >&2
  fail=1
fi

# grep -R 命中为空时以 1 退出，属预期路径（用 || true 吃掉，不触发 set -e）。
report() {
  local label="$1"
  shift
  local hits
  hits="$(grep -RInE "$@" "$RENDERER" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "lint:ipc-sends: renderer must not $label — go through the preload whitelist (apps/electron/src/preload):" >&2
    printf '%s\n' "$hits" >&2
    fail=1
  fi
}

# 规则 1：任何形态的 ipcRenderer 引用（send/invoke/sendSync/sendToHost/on/…）。
report 'reference ipcRenderer directly' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.html' \
  -e 'ipcRenderer'

# 规则 2：renderer 侧 import/require electron 主进程模块。
report "import the electron module" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  -e "(^|[^[:alnum:]_])(from[[:space:]]+[\"']electron([\"']|/)|require\([\"']electron[\"']\))"

if [ "$fail" -eq 0 ]; then
  echo 'lint:ipc-sends: OK — renderer has no raw ipc sends, preload whitelist intact'
fi
exit "$fail"

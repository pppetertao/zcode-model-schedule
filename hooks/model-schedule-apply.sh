#!/usr/bin/env bash
# SessionStart hook：执行 apply.mjs --if-due；退出码不阻断 session 启动
# 超时由 ZCode hook 条目的 timeout 字段负责（macOS 无 timeout 命令，本脚本不依赖它）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH_FILE="$SCRIPT_DIR/node-path"
if [[ -f "$NODE_PATH_FILE" ]]; then
  NODE_BIN="$(cat "$NODE_PATH_FILE")"
else
  NODE_BIN="${NODE:-node}"
fi
mkdir -p "$SCRIPT_DIR/logs"
"$NODE_BIN" "$SCRIPT_DIR/apply.mjs" --if-due --trigger hook >>"$SCRIPT_DIR/logs/hook.out.log" 2>>"$SCRIPT_DIR/logs/hook.err.log" || true
# 失败只记日志（hook.err.log），不阻断 session 启动

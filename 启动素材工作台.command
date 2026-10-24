#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${SCRIPT_ORGANIZER_PORT:-8765}"
# 默认只监听本机；需要局域网直连时显式设置 SCRIPT_ORGANIZER_HOST=0.0.0.0
# （Team Web 的局域网协作请走 gateway 配对，不要直接开放单工作区 serve）
HOST="${SCRIPT_ORGANIZER_HOST:-127.0.0.1}"
LOG_DIR="$ROOT/.workspace/logs"
LOG_FILE="$LOG_DIR/platform-$PORT.log"
PID_FILE="$ROOT/.workspace/platform-$PORT.pid"

cd "$ROOT"
mkdir -p "$LOG_DIR"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT/"
  exit 0
fi

nohup "$ROOT/script-organizer" serve "$ROOT/workspace.toml" --host "$HOST" --port "$PORT" \
  >"$LOG_FILE" 2>&1 < /dev/null &
echo "$!" > "$PID_FILE"

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/workspace" >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT/"
    exit 0
  fi
  sleep 1
done

open "$LOG_FILE"
exit 1

#!/usr/bin/env bash
# Ovolve MVP — Demo 脚本
# 一键起服务 + 预置一个会触发 5-Agent fan-out 的示例任务
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Ovolve MVP Demo ==="

# 1. 启动后端
echo "[1/3] Starting Python backend..."
cd "$REPO_ROOT"
export PYTHONPATH="$REPO_ROOT/app/backend"
export PYTHONUNBUFFERED=1
python app/main.py --server &
BACKEND_PID=$!

# 等待后端就绪
echo "Waiting for backend..."
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8765/api/health > /dev/null 2>&1; then
    echo "  Backend ready."
    break
  fi
  sleep 1
done

# 2. 启动前端
echo "[2/3] Starting Vite frontend..."
cd "$REPO_ROOT/app/ui"
npm run dev &
FRONTEND_PID=$!

echo "Waiting for frontend..."
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:5173/ > /dev/null 2>&1; then
    echo "  Frontend ready."
    break
  fi
  sleep 1
done

echo ""
echo "=== Ovolve MVP is running ==="
echo "  Frontend:  http://127.0.0.1:5173"
echo "  Backend:   http://127.0.0.1:8765"
echo ""
echo "  Open http://127.0.0.1:5173 in your browser."
echo "  Send a message like:"
echo '  "给 example.py 加一个日志功能，然后审查并测试"'
echo "  to trigger a 5-Agent fan-out (planner -> coder -> reviewer -> validator -> diagnostician)."
echo ""
echo "  Press Ctrl+C to stop."

# 3. 等待中断
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait

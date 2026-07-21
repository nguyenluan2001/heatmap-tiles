#!/usr/bin/env bash
# Convenience launcher: build pyramid (if needed), then start backend + frontend.
set -e

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# 1. Build the zarr pyramid if it doesn't exist.
if [ ! -f "$ROOT/data/heatmap.zarr/meta.json" ]; then
  echo ">> Building zarr pyramid..."
  (cd "$ROOT" && uv run python -m backend.build_pyramid)
fi

# 2. Start the FastAPI backend.
echo ">> Starting backend on :8000..."
(cd "$ROOT" && uv run uvicorn backend.server:app --host 0.0.0.0 --port 8000) &
BACKEND_PID=$!

# 3. Start the Vite frontend (proxies /api to the backend).
echo ">> Starting frontend on :5173..."
(cd "$ROOT/client" && bun dev) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM

echo ""
echo "  Backend  : http://127.0.0.1:8000/api/meta"
echo "  Frontend : http://127.0.0.1:5173"
echo ""
echo "Press Ctrl-C to stop both servers."

wait

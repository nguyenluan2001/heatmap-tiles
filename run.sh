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

# 1b. Pre-render static grayscale PNG tiles (Rule #1: no dynamic rendering).
if [ ! -f "$ROOT/data/tiles/default/manifest.json" ]; then
  echo ">> Pre-rendering static grayscale tiles..."
  (cd "$ROOT" && uv run python -m backend.generate_pyramid)
fi

# 2. Start the FastAPI backend (static tile server + zarr fallback).
#    Uses port 8001 by default; override with HEATMAP_PORT env var.
HEATMAP_PORT="${HEATMAP_PORT:-8001}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

# Kill any process already bound to the backend/frontend ports so re-running
# this script never fails with "address already in use". `lsof` is the most
# portable way to find PIDs by port; fall back to `fuser` if unavailable.
kill_port() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port"/tcp 2>/dev/null | tr -d ' ' || true)"
  fi
  if [ -n "$pids" ]; then
    echo ">> Port $port in use by PID(s) $pids — killing..."
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}
kill_port "$HEATMAP_PORT"
kill_port "$FRONTEND_PORT"

echo ">> Starting backend on :$HEATMAP_PORT..."
(cd "$ROOT" && uv run uvicorn backend.server:app --host 0.0.0.0 --port "$HEATMAP_PORT") &
BACKEND_PID=$!

# 3. Start the Vite frontend (proxies /api + /tiles to the backend).
echo ">> Starting frontend on :$FRONTEND_PORT..."
(cd "$ROOT/client" && bun dev --port "$FRONTEND_PORT") &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM

echo ""
echo "  Backend  : http://127.0.0.1:$HEATMAP_PORT/api/meta"
echo "  Static tiles : http://127.0.0.1:$HEATMAP_PORT/tiles/0/0_0.png"
echo "  Frontend : http://127.0.0.1:$FRONTEND_PORT"
echo ""
echo "Press Ctrl-C to stop both servers."

wait

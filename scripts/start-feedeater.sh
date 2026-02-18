#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env if present
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

echo "[start-feedeater] building packages..."
npm run build --prefix "$REPO_ROOT/packages/core"
npm run build --prefix "$REPO_ROOT/packages/db"
npm run build --prefix "$REPO_ROOT/packages/module-sdk"

echo "[start-feedeater] building apps..."
npm run build --prefix "$REPO_ROOT/apps/api"
npm run build --prefix "$REPO_ROOT/apps/worker"

echo "[start-feedeater] starting api (log: /tmp/feedeater-api.log)..."
node "$REPO_ROOT/apps/api/dist/index.js" > /tmp/feedeater-api.log 2>&1 &
API_PID=$!
echo "[start-feedeater] api started (pid=$API_PID)"

echo "[start-feedeater] starting worker (log: /tmp/feedeater-worker.log)..."
node "$REPO_ROOT/apps/worker/dist/index.js" > /tmp/feedeater-worker.log 2>&1 &
WORKER_PID=$!
echo "[start-feedeater] worker started (pid=$WORKER_PID)"

echo "[start-feedeater] done — api=$API_PID worker=$WORKER_PID"
echo "  tail -f /tmp/feedeater-api.log"
echo "  tail -f /tmp/feedeater-worker.log"

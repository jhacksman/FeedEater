#!/bin/sh
set -e

API_URL="${FEEDEATER_API_URL:-http://api:4000}"
MAX_RETRIES=30
RETRY_DELAY=2

echo "[init-modules] waiting for API at ${API_URL}..."

attempt=0
while [ "$attempt" -lt "$MAX_RETRIES" ]; do
  if wget -q -O /dev/null "${API_URL}/api/health" 2>/dev/null; then
    echo "[init-modules] API healthy"
    break
  fi
  attempt=$((attempt + 1))
  echo "[init-modules] attempt ${attempt}/${MAX_RETRIES} — retrying in ${RETRY_DELAY}s"
  sleep "$RETRY_DELAY"
done

if [ "$attempt" -ge "$MAX_RETRIES" ]; then
  echo "[init-modules] ERROR: API not reachable after ${MAX_RETRIES} attempts"
  exit 1
fi

enable_module() {
  module="$1"
  key="$2"
  value="$3"
  is_secret="${4:-false}"

  echo "[init-modules] ${module}: setting ${key}"
  wget -q -O /dev/null --post-data="{\"value\":\"${value}\",\"isSecret\":${is_secret}}" \
    --header="Content-Type: application/json" \
    "${API_URL}/api/settings/${module}/${key}" 2>/dev/null || \
    echo "[init-modules] WARN: failed to set ${module}.${key}"
}

echo "[init-modules] enabling kalshi module..."
enable_module kalshi enabled true
if [ -n "$KALSHI_API_KEY" ]; then
  enable_module kalshi apiKey "$KALSHI_API_KEY" true
fi
if [ -n "$KALSHI_API_SECRET" ]; then
  enable_module kalshi apiSecret "$KALSHI_API_SECRET" true
fi

echo "[init-modules] enabling polymarket module..."
enable_module polymarket enabled true
enable_module polymarket collectAllTrades true

echo "[init-modules] done — kalshi and polymarket enabled"

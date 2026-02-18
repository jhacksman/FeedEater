#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env if present
if [ -f "${root_dir}/.env" ]; then
  set -a
  source "${root_dir}/.env"
  set +a
fi

build_pkg() {
  local pkg_dir="$1"
  echo "==> Building ${pkg_dir}"
  (cd "${root_dir}/${pkg_dir}" && npm install --silent && npm run build)
}

build_app() {
  local app_dir="$1"
  echo "==> Building ${app_dir}"
  (cd "${root_dir}/${app_dir}" && npm install --silent && npm run build)
}

start_app() {
  local app_dir="$1"
  echo "==> Starting ${app_dir}"
  (cd "${root_dir}/${app_dir}" && node dist/index.js)
}

# Build packages first (dependencies for apps)
build_pkg "packages/core"
build_pkg "packages/db"

# Build apps
build_app "apps/worker"
build_app "apps/api"

# Start both in parallel
start_app "apps/api" &
start_app "apps/worker" &

wait

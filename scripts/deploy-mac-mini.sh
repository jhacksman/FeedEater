#!/usr/bin/env bash
# FeedEater Mac Mini Deployment Script
#
# Deploys FeedEater to the Mac mini by pulling latest code,
# updating Docker images, and verifying module health.
#
# Usage:
#   ./scripts/deploy-mac-mini.sh
#
# Exit codes:
#   0 - deployment succeeded, all modules healthy
#   1 - deployment failed or modules unhealthy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "[INFO]  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
die()   { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }

cd "$REPO_ROOT"

echo "=============================================="
echo "  FeedEater Mac Mini Deploy"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=============================================="
echo ""

info "Step 1/5: git pull origin main"
git pull origin main || die "git pull failed"
ok "Code updated"
echo ""

info "Step 2/5: docker-compose pull"
docker compose pull || docker-compose pull || die "docker-compose pull failed"
ok "Images pulled"
echo ""

info "Step 3/5: docker-compose up -d --remove-orphans"
docker compose up -d --remove-orphans || docker-compose up -d --remove-orphans || die "docker-compose up failed"
ok "Containers started"
echo ""

info "Step 4/5: Waiting 10s for startup..."
sleep 10
ok "Startup wait complete"
echo ""

info "Step 5/5: Running module health check"
if [[ -x "$SCRIPT_DIR/check-modules.sh" ]]; then
  if "$SCRIPT_DIR/check-modules.sh" --live; then
    ok "All modules healthy"
  else
    die "Module health check failed — one or more modules unhealthy"
  fi
else
  die "check-modules.sh not found or not executable"
fi

echo ""
echo "=============================================="
echo "  Deployment complete"
echo "=============================================="
exit 0

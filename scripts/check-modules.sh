#!/usr/bin/env bash
# FeedEater Module Deployment Checker
#
# Verifies that expected modules are configured in the deployment files
# and optionally checks running containers.
#
# Usage:
#   ./scripts/check-modules.sh              # config checks only
#   ./scripts/check-modules.sh --live       # also check running containers
#
# Exit codes:
#   0 - all checks passed
#   1 - one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LIVE_CHECK=false
if [[ "${1:-}" == "--live" ]]; then
  LIVE_CHECK=true
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0
WARNED=0

pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; WARNED=$((WARNED + 1)); }

EXPECTED_MODULES="kalshi polymarket uniswap-base aerodrome-base"

echo "=============================================="
echo "  FeedEater Module Deployment Checker"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=============================================="
echo ""

echo "--- docker-compose.yml ---"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
  fail "docker-compose.yml not found"
else
  if grep -q "UNISWAP_BASE_RPC_URL" "$COMPOSE_FILE"; then
    pass "docker-compose.yml contains UNISWAP_BASE_RPC_URL"
  else
    fail "docker-compose.yml missing UNISWAP_BASE_RPC_URL"
  fi

  if grep -q "AERODROME_BASE_RPC_URL" "$COMPOSE_FILE"; then
    pass "docker-compose.yml contains AERODROME_BASE_RPC_URL"
  else
    fail "docker-compose.yml missing AERODROME_BASE_RPC_URL"
  fi

  if grep -q "ws://localhost:8646" "$COMPOSE_FILE"; then
    pass "docker-compose.yml has Base RPC default (ws://localhost:8646)"
  else
    warn "docker-compose.yml does not reference ws://localhost:8646 default"
  fi
fi
echo ""

echo "--- init-modules.sh ---"
INIT_FILE="$REPO_ROOT/docker/init-modules.sh"
if [[ ! -f "$INIT_FILE" ]]; then
  fail "docker/init-modules.sh not found"
else
  for mod in $EXPECTED_MODULES; do
    if grep -q "enable_module ${mod} enabled true" "$INIT_FILE" || \
       grep -q "enable_module $mod enabled true" "$INIT_FILE"; then
      pass "init-modules.sh enables $mod"
    else
      fail "init-modules.sh does not enable $mod"
    fi
  done

  if grep -q "UNISWAP_BASE_RPC_URL" "$INIT_FILE"; then
    pass "init-modules.sh passes UNISWAP_BASE_RPC_URL to uniswap-base"
  else
    fail "init-modules.sh missing UNISWAP_BASE_RPC_URL passthrough"
  fi

  if grep -q "AERODROME_BASE_RPC_URL" "$INIT_FILE"; then
    pass "init-modules.sh passes AERODROME_BASE_RPC_URL to aerodrome-base"
  else
    fail "init-modules.sh missing AERODROME_BASE_RPC_URL passthrough"
  fi
fi
echo ""

echo "--- .env.example ---"
ENV_FILE="$REPO_ROOT/.env.example"
if [[ ! -f "$ENV_FILE" ]]; then
  fail ".env.example not found"
else
  if grep -q "UNISWAP_BASE_RPC_URL" "$ENV_FILE"; then
    pass ".env.example documents UNISWAP_BASE_RPC_URL"
  else
    fail ".env.example missing UNISWAP_BASE_RPC_URL"
  fi

  if grep -q "AERODROME_BASE_RPC_URL" "$ENV_FILE"; then
    pass ".env.example documents AERODROME_BASE_RPC_URL"
  else
    fail ".env.example missing AERODROME_BASE_RPC_URL"
  fi

  if grep -q "192.168.0.134:8646" "$ENV_FILE"; then
    pass ".env.example has Mac mini Base node address (192.168.0.134:8646)"
  else
    warn ".env.example does not reference 192.168.0.134:8646"
  fi
fi
echo ""

echo "--- module directories ---"
for mod in $EXPECTED_MODULES; do
  MOD_DIR="$REPO_ROOT/modules/$mod"
  if [[ -d "$MOD_DIR" ]]; then
    if [[ -f "$MOD_DIR/module.json" ]]; then
      pass "modules/$mod/module.json exists"
    else
      fail "modules/$mod/ exists but missing module.json"
    fi
  else
    fail "modules/$mod/ directory not found"
  fi
done
echo ""

if [[ "$LIVE_CHECK" == true ]]; then
  echo "--- live container check ---"
  COMPOSE="${COMPOSE:-docker compose}"

  if ! command -v docker &>/dev/null; then
    warn "docker not available — skipping live checks"
  else
    for svc in postgres nats api worker; do
      if $COMPOSE ps 2>/dev/null | grep -q "$svc.*healthy"; then
        pass "$svc container is healthy"
      elif $COMPOSE ps 2>/dev/null | grep -q "$svc"; then
        warn "$svc container exists but not healthy"
      else
        fail "$svc container not found"
      fi
    done

    if $COMPOSE ps 2>/dev/null | grep -q "module-init"; then
      pass "module-init container ran"
    else
      warn "module-init container not found (may have exited after init)"
    fi
  fi
  echo ""
fi

echo "=============================================="
echo "  Results: ${PASSED} passed, ${FAILED} failed, ${WARNED} warnings"
echo "=============================================="

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
exit 0

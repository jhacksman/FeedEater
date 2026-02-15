#!/bin/bash
#
# FeedEater Smoke Test
#
# Verifies that data flows through the system:
# 1. Starts docker compose
# 2. Waits for services to be healthy
# 3. Enables coinbase + polymarket modules
# 4. Waits for data collection
# 5. Checks Postgres for rows
# 6. Checks NATS for messages
# 7. Reports pass/fail
#
# Usage: ./scripts/smoke_test.sh [--skip-start] [--wait-time 60]

set -e

# Configuration
COMPOSE="${COMPOSE:-docker compose}"
WAIT_TIME="${WAIT_TIME:-60}"
SKIP_START=false
API_URL="http://localhost:4000"
INTERNAL_TOKEN="${FEED_INTERNAL_TOKEN:-dev-internal-token}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-start)
            SKIP_START=true
            shift
            ;;
        --wait-time)
            WAIT_TIME="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

check_result() {
    local name="$1"
    local result="$2"
    if [ "$result" -eq 0 ]; then
        log_success "$name"
        ((TESTS_PASSED++))
    else
        log_error "$name"
        ((TESTS_FAILED++))
    fi
}

echo "=============================================="
echo "       FeedEater Smoke Test"
echo "=============================================="
echo ""

# Step 1: Start docker compose (unless skipped)
if [ "$SKIP_START" = false ]; then
    log_info "Starting docker compose..."
    $COMPOSE up -d --build
    echo ""
fi

# Step 2: Wait for services to be healthy
log_info "Waiting for services to be healthy..."

wait_for_healthy() {
    local service="$1"
    local max_attempts=60
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        status=$($COMPOSE ps --format "{{.Name}}\t{{.Status}}" | grep "$service" | grep -c "healthy" || true)
        if [ "$status" -ge 1 ]; then
            return 0
        fi
        sleep 2
        ((attempt++))
    done
    return 1
}

# Wait for core services
for service in postgres nats api worker; do
    log_info "Waiting for $service..."
    if wait_for_healthy "$service"; then
        log_success "$service is healthy"
    else
        log_error "$service failed to become healthy"
        log_info "Service status:"
        $COMPOSE ps
        exit 1
    fi
done

echo ""

# Step 3: Enable modules via API
log_info "Enabling coinbase module..."
COINBASE_RESPONSE=$(curl -s -X POST "$API_URL/api/modules/coinbase/enable" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    -d '{}' || echo '{"error": "request failed"}')
echo "Coinbase response: $COINBASE_RESPONSE"

log_info "Enabling polymarket module..."
POLYMARKET_RESPONSE=$(curl -s -X POST "$API_URL/api/modules/polymarket/enable" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $INTERNAL_TOKEN" \
    -d '{}' || echo '{"error": "request failed"}')
echo "Polymarket response: $POLYMARKET_RESPONSE"

echo ""

# Step 4: Wait for data collection
log_info "Waiting ${WAIT_TIME}s for data collection..."
sleep "$WAIT_TIME"

echo ""

# Step 5: Check Postgres for rows
log_info "Checking Postgres for data..."

# Get row counts from messages table
POSTGRES_QUERY="SELECT COUNT(*) FROM \"Message\";"
MESSAGE_COUNT=$($COMPOSE exec -T postgres psql -U feedeater -d feedeater -t -c "$POSTGRES_QUERY" 2>/dev/null | tr -d ' \n' || echo "0")

log_info "Messages in database: $MESSAGE_COUNT"

if [ "$MESSAGE_COUNT" -gt 0 ]; then
    check_result "Postgres has messages" 0
else
    check_result "Postgres has messages" 1
fi

# Check for module-specific data
COINBASE_QUERY="SELECT COUNT(*) FROM \"Message\" WHERE source = 'coinbase';"
COINBASE_COUNT=$($COMPOSE exec -T postgres psql -U feedeater -d feedeater -t -c "$COINBASE_QUERY" 2>/dev/null | tr -d ' \n' || echo "0")
log_info "Coinbase messages: $COINBASE_COUNT"

POLYMARKET_QUERY="SELECT COUNT(*) FROM \"Message\" WHERE source = 'polymarket';"
POLYMARKET_COUNT=$($COMPOSE exec -T postgres psql -U feedeater -d feedeater -t -c "$POLYMARKET_QUERY" 2>/dev/null | tr -d ' \n' || echo "0")
log_info "Polymarket messages: $POLYMARKET_COUNT"

echo ""

# Step 6: Check NATS for messages
log_info "Checking NATS for stream data..."

# Check NATS monitoring endpoint for stream info
NATS_STREAMS=$(curl -s "http://localhost:8222/jsz" 2>/dev/null || echo '{}')
STREAM_COUNT=$(echo "$NATS_STREAMS" | grep -o '"streams":[0-9]*' | grep -o '[0-9]*' || echo "0")
MESSAGE_TOTAL=$(echo "$NATS_STREAMS" | grep -o '"messages":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "0")

log_info "NATS streams: $STREAM_COUNT"
log_info "NATS total messages: $MESSAGE_TOTAL"

if [ "$MESSAGE_TOTAL" -gt 0 ]; then
    check_result "NATS has messages" 0
else
    # NATS might not have JetStream enabled or messages might be transient
    log_warn "NATS message count is 0 (may be using core NATS without JetStream persistence)"
    check_result "NATS has messages" 1
fi

echo ""

# Step 7: Check API health and module status
log_info "Checking API health..."
API_HEALTH=$(curl -s "$API_URL/health" 2>/dev/null || echo '{"status": "error"}')
if echo "$API_HEALTH" | grep -q "ok\|healthy"; then
    check_result "API is healthy" 0
else
    check_result "API is healthy" 1
fi

log_info "Checking module status..."
MODULE_STATUS=$(curl -s "$API_URL/api/modules" \
    -H "Authorization: Bearer $INTERNAL_TOKEN" 2>/dev/null || echo '[]')
ENABLED_MODULES=$(echo "$MODULE_STATUS" | grep -o '"enabled":true' | wc -l || echo "0")
log_info "Enabled modules: $ENABLED_MODULES"

if [ "$ENABLED_MODULES" -gt 0 ]; then
    check_result "Modules are enabled" 0
else
    check_result "Modules are enabled" 1
fi

echo ""

# Summary
echo "=============================================="
echo "              Test Summary"
echo "=============================================="
echo ""
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    echo ""
    log_info "Debug info:"
    echo "  - Check logs: make logs"
    echo "  - Check status: make status"
    echo "  - Tail events: make tail-events"
    exit 1
fi

#!/usr/bin/env bash
# FeedEater Data Health Report
# Queries Postgres for trade counts, recency, gaps, and collection rates.
# Designed to run via cron and output a human-readable summary.
#
# Usage:
#   ./scripts/health_report.sh                    # default: docker exec
#   PGHOST=localhost PGPORT=5432 ./scripts/health_report.sh  # direct connection
#
# Environment:
#   DOCKER_CONTAINER  - postgres container name (default: feedeater-postgres-1)
#   PGHOST/PGPORT     - if set, uses psql directly instead of docker exec
#   ALERT_STALE_MIN   - minutes before a venue is flagged stale (default: 30)

set -euo pipefail

CONTAINER="${DOCKER_CONTAINER:-feedeater-postgres-1}"
ALERT_STALE_MIN="${ALERT_STALE_MIN:-30}"
DB_USER="feedeater"
DB_NAME="feedeater"

# Route psql through docker or direct
run_psql() {
  if [[ -n "${PGHOST:-}" ]]; then
    psql -U "$DB_USER" -d "$DB_NAME" -t -A -F'|' -c "$1"
  else
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F'|' -c "$1"
  fi
}

echo "═══════════════════════════════════════════════"
echo "  FeedEater Data Health Report"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "═══════════════════════════════════════════════"
echo ""

# --- Trade counts and recency per venue ---
echo "📊 Trade Collection Summary"
echo "───────────────────────────────────────────────"
printf "%-14s %8s %8s %8s %s\n" "VENUE" "TOTAL" "1H" "24H" "LATEST (UTC)"

VENUES="binance coinbase kraken kalshi polymarket"
ALERTS=""

for v in $VENUES; do
  schema="mod_${v}"
  result=$(run_psql "
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_1h,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
      COALESCE(to_char(max(created_at) AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), 'never') AS latest,
      EXTRACT(EPOCH FROM (now() - COALESCE(max(created_at), '1970-01-01'::timestamptz))) / 60 AS stale_min
    FROM ${schema}.trades;
  " 2>/dev/null || echo "0|0|0|error|-1")

  IFS='|' read -r total last_1h last_24h latest stale_min <<< "$result"
  # Trim whitespace
  total="${total// /}" last_1h="${last_1h// /}" last_24h="${last_24h// /}"
  latest="${latest// /}" stale_min="${stale_min// /}"

  printf "%-14s %8s %8s %8s %s\n" "$v" "$total" "$last_1h" "$last_24h" "$latest"

  # Stale check
  stale_int="${stale_min%%.*}"
  if [[ "$stale_int" -gt "$ALERT_STALE_MIN" ]] 2>/dev/null; then
    ALERTS="${ALERTS}⚠️  ${v}: no trades in ${stale_int} min (threshold: ${ALERT_STALE_MIN}m)\n"
  fi
  if [[ "$last_1h" == "0" ]]; then
    ALERTS="${ALERTS}⚠️  ${v}: zero trades in last hour\n"
  fi
done

echo ""

# --- Market discovery counts ---
echo "🔍 Market Discovery"
echo "───────────────────────────────────────────────"
for v in kalshi polymarket; do
  schema="mod_${v}"
  count=$(run_psql "SELECT count(*) FROM ${schema}.markets;" 2>/dev/null || echo "?")
  count="${count// /}"
  echo "  ${v}: ${count} markets"
done
echo ""

# --- Orderbook snapshots ---
echo "📖 Orderbook Snapshots (24h)"
echo "───────────────────────────────────────────────"
for v in $VENUES; do
  schema="mod_${v}"
  count=$(run_psql "SELECT count(*) FROM ${schema}.orderbook_snapshots WHERE created_at > now() - interval '24 hours';" 2>/dev/null || echo "0")
  count="${count// /}"
  if [[ "$count" != "0" ]]; then
    echo "  ${v}: ${count}"
  fi
done
echo ""

# --- Candle data ---
echo "🕯️  Candle Data (24h)"
echo "───────────────────────────────────────────────"
for v in binance coinbase kraken kalshi; do
  schema="mod_${v}"
  count=$(run_psql "SELECT count(*) FROM ${schema}.candles WHERE created_at > now() - interval '24 hours';" 2>/dev/null || echo "0")
  count="${count// /}"
  if [[ "$count" != "0" ]]; then
    echo "  ${v}: ${count}"
  fi
done
echo ""

# --- Database size ---
echo "💾 Database Size"
echo "───────────────────────────────────────────────"
db_size=$(run_psql "SELECT pg_size_pretty(pg_database_size('feedeater'));" 2>/dev/null || echo "?")
echo "  Total: ${db_size// /}"

for v in $VENUES; do
  schema="mod_${v}"
  sz=$(run_psql "SELECT pg_size_pretty(sum(pg_total_relation_size(schemaname||'.'||tablename))) FROM pg_tables WHERE schemaname='${schema}';" 2>/dev/null || echo "?")
  echo "  ${v}: ${sz// /}"
done
echo ""

# --- Alerts ---
if [[ -n "$ALERTS" ]]; then
  echo "🚨 ALERTS"
  echo "───────────────────────────────────────────────"
  echo -e "$ALERTS"
else
  echo "✅ All venues healthy — no alerts."
fi

echo ""
echo "═══════════════════════════════════════════════"

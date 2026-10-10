#!/usr/bin/env bash
# One scratch measurement run of #173 (5206f90) on one host. Run by Codex only; A5 never ran it.
#   run-native.sh r1|r2|r3
# Required env: BASE_COLLECTOR_WS_URL, BASE_COLLECTOR_HTTP_URL (set separately; never derived), and a
# declared input (see plan-inputs.mjs): FE173_INPUT=checkpoint + FE173_CHECKPOINT, or
# FE173_INPUT=discovery + FE173_DISCOVERY_BLOCKS (<= 1800).
# Optional env: FE (checkout, default ../..), FE173_ROOT (default on macOS:
# /Volumes/T7SHIELD/PROJECT_AROMER/aromer-scratch/fe173-measure; required elsewhere, e.g. Thor's
# existing authorized staging dir), FE173_DEPS=docker|external (external needs
# BASE_COLLECTOR_NATS_URL + BASE_COLLECTOR_DATABASE_URL), FE173_NATS_PORT 14222, FE173_PG_PORT 15432,
# FE173_WARMUP_S 120, FE173_WINDOW_S 1800, FE173_TEARDOWN_S 120, FE173_RECONCILE_DEADLINE_S 300,
# FE173_MEASURE_GRACE_S 180, FE173_OUTAGE_S 60, FE173_R3_DOWN_S 30, FE173_VERIFY_DEADLINE_S 300.
# Exit: 0 checker NO_REJECT_FOUND, 1 checker REJECT, 2 usage/env, 3 input refused, 5 node not fresh,
# 6 dependencies not ready, 7 reconcile deadline, 8 measure failed/deadline, 9 verify-persist failed.
set -euo pipefail
MODE=${1:-}
case "$MODE" in r1 | r2 | r3) ;; *) echo "usage: run-native.sh r1|r2|r3" >&2; exit 2 ;; esac
H=$(cd "$(dirname "$0")" && pwd)
FE=${FE:-$(cd "$H/../.." && pwd)}
export FE
MAIN=$FE/modules/base-collector/dist/main.js
[ -f "$MAIN" ] || { echo "build first: npm run -w @feedeater/module-base-collector build" >&2; exit 2; }
: "${BASE_COLLECTOR_WS_URL:?set BASE_COLLECTOR_WS_URL}" "${BASE_COLLECTOR_HTTP_URL:?set BASE_COLLECTOR_HTTP_URL}"
if [ -z "${FE173_ROOT:-}" ]; then
  [ "$(uname -s)" = Darwin ] || { echo "FE173_ROOT must be set explicitly on this host (Thor: the existing authorized staging dir)" >&2; exit 2; }
  FE173_ROOT=/Volumes/T7SHIELD/PROJECT_AROMER/aromer-scratch/fe173-measure
fi
[ -d "$(dirname "$FE173_ROOT")" ] || { echo "$(dirname "$FE173_ROOT") does not exist; not creating it" >&2; exit 2; }
W=${FE173_WARMUP_S:-120} X=${FE173_WINDOW_S:-1800} T=${FE173_TEARDOWN_S:-120}
if [ "$MODE" != r1 ] && [ "$X" -lt 600 ]; then echo "r2/r3 need FE173_WINDOW_S >= 600" >&2; exit 2; fi
RUNID=fe173-$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$
RUN=$FE173_ROOT/$RUNID
mkdir -p "$RUN/tmp" "$RUN/state"
export TMPDIR=$RUN/tmp npm_config_cache=$RUN/tmp/npm-cache
# shellcheck source=lib-run.sh
. "$H/lib-run.sh"
trap fe_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec 2> >(tee -a "$RUN/run.log" >&2)
fe_log "run $RUNID mode $MODE in $RUN (commit $(git -C "$FE" rev-parse HEAD 2>/dev/null || echo unknown))"

DEPS=${FE173_DEPS:-docker}
if [ "$DEPS" = docker ]; then
  export BASE_COLLECTOR_NATS_URL=nats://127.0.0.1:${FE173_NATS_PORT:-14222}
  export BASE_COLLECTOR_DATABASE_URL=postgres://postgres:scratch@127.0.0.1:${FE173_PG_PORT:-15432}/fe173
elif [ "$DEPS" = external ]; then
  : "${BASE_COLLECTOR_NATS_URL:?FE173_DEPS=external needs BASE_COLLECTOR_NATS_URL}" "${BASE_COLLECTOR_DATABASE_URL:?FE173_DEPS=external needs BASE_COLLECTOR_DATABASE_URL}"
else
  echo "FE173_DEPS must be docker or external" >&2; exit 2
fi
export BASE_COLLECTOR_STATE_DIR=$RUN/state

# 1. Freshness preflight (2 HTTP calls, 1 WS subscription) and the declared, bounded input.
node "$H/preflight.mjs" "$RUN/preflight.json" || { fe_log "node not fresh; stop"; exit 5; }
node "$H/plan-inputs.mjs" --preflight "$RUN/preflight.json" --out-env "$RUN/inputs.env" --out-budget "$RUN/budget.json" || exit 3
{
  for k in WS_URL HTTP_URL NATS_URL DATABASE_URL STATE_DIR; do v=BASE_COLLECTOR_$k; echo "$v=${!v}"; done
  cat "$RUN/inputs.env"
} >"$RUN/base-collector.env"
set -a; . "$RUN/base-collector.env"; set +a
[ "${FE173_INPUT}" = checkpoint ] && cp "$FE173_CHECKPOINT" "$RUN/state/checkpoint.json"

# 2. Loopback scratch dependencies owned by this run.
if [ "$DEPS" = docker ]; then
  fe_start_container "$RUNID-nats" -p "127.0.0.1:${FE173_NATS_PORT:-14222}:4222" nats:2.10 || exit 6
  fe_start_container "$RUNID-pg" -p "127.0.0.1:${FE173_PG_PORT:-15432}:5432" -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=fe173 postgres:16 || exit 6
  deps_ready() { docker exec "$RUNID-pg" pg_isready -U postgres -d fe173 >/dev/null 2>&1 || return 1
    node -e "require('net').connect(${FE173_NATS_PORT:-14222},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" || return 1; }
  fe_wait_until 90 2 "scratch NATS/Postgres ready" deps_ready || exit 6
fi

# 3. Captures first (they must bracket measure), then persister and collector.
fe_start capnats "$RUN/capnats.out" node "$H/capture-nats.mjs" "$RUN/nats.jsonl"
fe_start capdirect "$RUN/capdirect.out" node "$H/capture-direct.mjs" "$RUN/direct.jsonl"
fe_start persist "$RUN/persist.out" node "$MAIN" persist
fe_start collect "$RUN/collect.out" node "$MAIN" collect
reconciled() {
  for p in capnats capdirect persist collect; do fe_owned "$(fe_pid $p)" || return 3; done
  grep -q '\\"reconciled\\":true' "$RUN/nats.jsonl" 2>/dev/null && [ -s "$RUN/state/checkpoint.json" ]
}
fe_wait_until "${FE173_RECONCILE_DEADLINE_S:-300}" 5 "collector reconciled + checkpoint" reconciled || exit 7

# 4. Measure (fixed phases) with a deadline; R2/R3 disturbance at window +300 s.
fe_start measure "$RUN/measure.summary.json" node "$MAIN" measure --warmup-s "$W" --window-s "$X" --teardown-s "$T" \
  --pools-from-checkpoint "$RUN/state/checkpoint.json" --out "$RUN/measure.json"
if [ "$MODE" != r1 ]; then
  sleep $((W + 300))
  fe_owned "$(fe_pid measure)" || { fe_log "measure exited early"; exit 8; }
  if [ "$MODE" = r2 ]; then
    fe_log "r2: persister outage ${FE173_OUTAGE_S:-60} s"
    fe_stop_pid "$(fe_pid persist)"; sleep "${FE173_OUTAGE_S:-60}"
    fe_start persist "$RUN/persist.out" node "$MAIN" persist
  else
    fe_log "r3: collector restart after ${FE173_R3_DOWN_S:-30} s"
    fe_stop_pid "$(fe_pid collect)"; sleep "${FE173_R3_DOWN_S:-30}"
    fe_start collect "$RUN/collect.out" node "$MAIN" collect
  fi
fi
rc=0; fe_wait_pid "$(fe_pid measure)" $((W + X + T + ${FE173_MEASURE_GRACE_S:-180})) measure || rc=$?
[ "$rc" = 0 ] && [ -s "$RUN/measure.json" ] || { fe_log "measure failed ($rc)"; exit 8; }

# 5. R2 persistence audit over the scored window (bounded: 2 calls per 500 blocks).
if [ "$MODE" = r2 ]; then
  read -r FROM TO < <(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1])).window;console.log(w.fromBlock,w.toBlock)' "$RUN/measure.json")
  sleep 30
  fe_start verify "$RUN/verify-persist.json" node "$MAIN" verify-persist --from-block "$FROM" --to-block "$TO"
  rc=0; fe_wait_pid "$(fe_pid verify)" "${FE173_VERIFY_DEADLINE_S:-300}" verify-persist || rc=$?
  [ "$rc" = 0 ] || { fe_log "verify-persist failed ($rc)"; exit 9; }
fi

# 6. Stop owned processes (captures last so they bracket teardown_end), check, hash.
for p in collect persist capdirect capnats; do fe_stop_pid "$(fe_pid $p)"; done
crc=0
node "$H/check-report.mjs" "$RUN/measure.json" --nats-capture "$RUN/nats.jsonl" --direct-capture "$RUN/direct.jsonl" \
  --env "$RUN/base-collector.env" >"$RUN/check.json" || crc=$?
(cd "$FE/modules/base-collector" && find dist -type f | LC_ALL=C sort | while read -r f; do fe_sha "$f"; done) >"$RUN/dist.sha256"
(cd "$RUN" && fe_sha ./*.json ./*.jsonl ./*.log ./*.env 2>/dev/null) >"$RUN/artifacts.sha256" || true
fe_log "done: $RUN check exit $crc ($(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).verdict' "$RUN/check.json"))"
exit "$crc"

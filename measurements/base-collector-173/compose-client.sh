#!/usr/bin/env bash
# Owned toy client for compose-drill.sh, run as the CMD of the assembled guard-run.sh (fake loopback only).
#   compose-client.sh BASE MODE
#   env: ASM CC_WS_UPSTREAM CC_WS_CAPS CC_FILTERS CC_TOY CC_TOY_ARGS [CC_DECOY] FE173_GUARD_URL (from guard-run)
# Registry BASE/cc-$$/registry via the assembled lib-run.sh. Starts the assembled ws-guard.mjs, then
# toy-client.mjs (HTTP via FE173_GUARD_URL, WS via ws-guard), both registered. CC_DECOY appends a
# reused-PID registry line (wrong start time) that must never be signalled.
# Exit 21 when ws-guard exits, 22 ws-guard not ready, 23 toy not started, else the toy's exit code;
# TERM -> 143 through lib-run.sh fe_cleanup (reverse registration order: toy, then ws-guard).
set -u
RUNID=cc-$$ RUN=$1/cc-$$ MODE=$2
. "$ASM/lib-run.sh"
trap fe_cleanup EXIT
trap 'exit 143' TERM
mkdir -p "$RUN/wsg"
# shellcheck disable=SC2086
fe_start wsguard "$RUN/wsguard.out" node "$ASM/ws-guard.mjs" --run-dir "$RUN/wsg" --upstream "$CC_WS_UPSTREAM" \
  --filters "$CC_FILTERS" --allow-new-heads $CC_WS_CAPS || exit 22
WP=$(fe_pid wsguard)
for _ in $(seq 1 50); do
  [ -s "$RUN/wsg/ws-guard.ready.json" ] && break
  fe_owned "$WP" || exit 22
  sleep 0.1
done
[ -s "$RUN/wsg/ws-guard.ready.json" ] || exit 22
WSURL=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).url' "$RUN/wsg/ws-guard.ready.json")
[ -n "${CC_DECOY:-}" ] && printf '%s\treused\tMon Jan  1 00:00:00 2001\n' "$CC_DECOY" >>"$FE173_REG/pids"
# shellcheck disable=SC2086
fe_start toy "$RUN/toy.out" node "$CC_TOY" "$FE173_GUARD_URL" "$WSURL" "$MODE" "$RUN/toy.jsonl" "$CC_FILTERS" $CC_TOY_ARGS || exit 23
TP=$(fe_pid toy)
while :; do
  fe_owned "$WP" || exit 21
  if ! fe_owned "$TP"; then
    wait "$TP"
    exit $?
  fi
  sleep 0.1
done

#!/usr/bin/env bash
# Owned run controller for rpc-guard.mjs (preparation only; not wired into run-native.sh).
# Starts the guard and one client command, both registered in RUN_DIR via lib-run.sh, and signals
# only those two. The client gets FE173_GUARD_URL and BASE_COLLECTOR_HTTP_URL set to the guard.
#   guard-run.sh RUN_DIR UPSTREAM CAP MIN_INTERVAL_MS TIMEOUT_MS MAX_LOG_SPAN DEADLINE_S -- CMD...
# RUN_DIR must be an existing absolute directory without guard.jsonl.
# Exit: client's exit code (no STOP); 10 guard.STOP written; 11 deadline; 12 guard not ready or died;
#       2 usage. Writes RUN_DIR/guard-run.json with the outcome.
set -u
H=$(cd "$(dirname "$0")" && pwd)
usage() {
  echo "usage: guard-run.sh RUN_DIR UPSTREAM CAP MIN_INTERVAL_MS TIMEOUT_MS MAX_LOG_SPAN DEADLINE_S -- CMD..." >&2
  exit 2
}
[ $# -ge 9 ] && [ "$8" = "--" ] || usage
RUN=$1 UP=$2 CAP=$3 GAP=$4 TMO=$5 SPAN=$6 DL=$7
shift 8
case "$RUN" in /*) ;; *) usage ;; esac
[ -d "$RUN" ] && [ ! -e "$RUN/guard.jsonl" ] || usage
case "$DL" in '' | *[!0-9]* | 0) usage ;; esac
RUNID=$(basename "$RUN")
. "$H/lib-run.sh"
trap fe_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

outcome() { # rc reason
  printf '{"rc":%s,"reason":"%s"}\n' "$1" "$2" >"$RUN/guard-run.json"
  fe_stop_pid "$CPID"
  fe_stop_pid "$GPID"
  wait "$GPID" 2>/dev/null
  exit "$1"
}
CPID="" GPID=""
fe_start guard "$RUN/guard.out" node "$H/rpc-guard.mjs" --run-dir "$RUN" --upstream "$UP" --cap "$CAP" \
  --min-interval-ms "$GAP" --timeout-ms "$TMO" --max-log-span "$SPAN" || exit 12
GPID=$(fe_pid guard)
ready() {
  [ -s "$RUN/guard.ready.json" ] && return 0
  fe_owned "$GPID" && return 1 || return 3
}
fe_wait_until 10 0.1 "guard ready" ready || outcome 12 guard_not_ready
URL=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).url' "$RUN/guard.ready.json")
fe_start client "$RUN/client.out" env FE173_GUARD_URL="$URL" BASE_COLLECTOR_HTTP_URL="$URL" "$@" || outcome 12 client_not_started
CPID=$(fe_pid client)
END=$((SECONDS + DL))
while :; do
  [ -e "$RUN/guard.STOP" ] && outcome 10 guard_stop
  if ! fe_owned "$CPID"; then
    wait "$CPID" 2>/dev/null
    crc=$?
    [ -e "$RUN/guard.STOP" ] && outcome 10 guard_stop
    outcome "$crc" client_exit
  fi
  fe_owned "$GPID" || outcome 12 guard_died
  [ "$SECONDS" -lt "$END" ] || outcome 11 deadline
  sleep 0.1
done

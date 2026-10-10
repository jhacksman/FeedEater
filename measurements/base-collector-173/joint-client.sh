#!/usr/bin/env bash
# Owned toy client wrapper for verify-joint.sh, run as the CMD of joint-run.sh (fake loopback only).
#   joint-client.sh BASE MODE [toy args...]    env: FE173_GUARD_URL FE173_WS_URL (from joint-run) JC_FILTERS [JC_DECOY]
# Registry BASE/jc-$$/registry via lib-run.sh; starts joint-toy.mjs registered. JC_DECOY appends a reused-PID
# registry line (wrong start time) that must never be signalled. Exit: the toy's exit code, 23 toy not
# started; TERM -> 143 through fe_cleanup.
set -u
H=$(cd "$(dirname "$0")" && pwd)
RUNID=jc-$$ RUN=$1/jc-$$ MODE=$2
shift 2
mkdir -p "$RUN"
. "$H/lib-run.sh"
trap fe_cleanup EXIT
trap 'exit 143' TERM
fe_start toy "$RUN/toy.out" node "$H/joint-toy.mjs" "$FE173_GUARD_URL" "$FE173_WS_URL" "$MODE" "$RUN/toy.jsonl" "$JC_FILTERS" "$@" || exit 23
TP=$(fe_pid toy)
[ -n "${JC_DECOY:-}" ] && printf '%s\treused\tMon Jan  1 00:00:00 2001\n' "$JC_DECOY" >>"$FE173_REG/pids"
while fe_owned "$TP"; do sleep 0.1; done
wait "$TP"
exit $?

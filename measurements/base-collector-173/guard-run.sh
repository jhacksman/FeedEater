#!/usr/bin/env bash
# Owned run controller for rpc-guard.mjs (preparation only; not wired into run-native.sh).
#   guard-run.sh RUN_DIR UPSTREAM CAP MIN_INTERVAL_MS TIMEOUT_MS MAX_LOG_SPAN DEADLINE_S GRACE_S CLIENT_REGISTRY -- CMD...
# Starts the guard and one client (FE173_GUARD_URL and BASE_COLLECTOR_HTTP_URL set to the guard), both
# registered in RUN_DIR/registry via lib-run.sh. On guard.STOP, the deadline or client exit it:
#   1. stops the guard first (no new admission; queued requests dropped, summary written);
#   2. sends TERM to the client and waits up to GRACE_S (1..900) for it to exit, then KILLs it;
#   3. verifies the client's own registry: CLIENT_REGISTRY is an absolute glob containing {pid}
#      (replaced by the client PID) that must match exactly one directory with lib-run.sh `pids` and
#      `containers` files; RUNID = name of its parent directory. A registered PID whose `ps lstart`
#      still equals the recorded one, or a listed container whose fe173.run label equals that RUNID,
#      is an owned survivor: it is stopped (TERM, 10 s, KILL / docker rm -f) and reported.
#      Unregistered processes, reused PIDs (different lstart) and foreign containers are never touched.
#      CLIENT_REGISTRY=none skips step 3; refused (exit 2) when CMD mentions run-native.sh.
# External TERM/INT to guard-run runs the same steps 1-3 (reason external_TERM/INT) and exits 143/130.
# Exit: 14 client ownership not verifiable; 13 owned survivors found (both override every other code);
#       else 143/130 external signal; 10 guard.STOP; 11 deadline; 12 guard not ready or died; the
#       client's exit code; 2 usage. Outcome in RUN_DIR/guard-run.json. A second signal is not escalated.
# Wall time <= DEADLINE_S + 10 (guard stop) + GRACE_S + 10 (survivor stop) + a few seconds.
set -u
H=$(cd "$(dirname "$0")" && pwd)
usage() {
  echo "usage: guard-run.sh RUN_DIR UPSTREAM CAP MIN_INTERVAL_MS TIMEOUT_MS MAX_LOG_SPAN DEADLINE_S GRACE_S CLIENT_REGISTRY -- CMD... ($1)" >&2
  exit 2
}
[ $# -ge 11 ] && [ "${10}" = "--" ] || usage arguments
RUN=$1 UP=$2 CAP=$3 GAP=$4 TMO=$5 SPAN=$6 DL=$7 GRACE=$8 CREG=$9
shift 10
case "$RUN" in /*) ;; *) usage "RUN_DIR not absolute" ;; esac
[ -d "$RUN" ] && [ ! -e "$RUN/guard.jsonl" ] || usage "RUN_DIR missing or used"
case "$DL" in '' | *[!0-9]* | 0) usage DEADLINE_S ;; esac
case "$GRACE" in '' | *[!0-9]* | 0) usage GRACE_S ;; esac
[ "$GRACE" -le 900 ] || usage GRACE_S
if [ "$CREG" = none ]; then
  case " $* " in *run-native.sh*) usage "run-native.sh needs CLIENT_REGISTRY" ;; esac
else
  case "$CREG" in /*) ;; *) usage "CLIENT_REGISTRY not absolute" ;; esac
  case "$CREG" in *'{pid}'*) ;; *) usage "CLIENT_REGISTRY lacks {pid}" ;; esac
  case "$CREG" in *[[:space:]]*) usage "CLIENT_REGISTRY has whitespace" ;; esac
fi
RUNID=$(basename "$RUN")
. "$H/lib-run.sh"
trap fe_cleanup EXIT
# External TERM/INT only set a flag; the loop then runs the same guard-first outcome path (fix2).
SIG=""
trap 'SIG=INT' INT
trap 'SIG=TERM' TERM
now() { node -p 'Date.now()'; }
T0=$(now)
CPID="" GPID="" CRC=""

stop_client() { # TERM, up to GRACE_S, then KILL; sets C_TERM_MS C_EXIT_MS C_KILLED
  local end
  C_TERM_MS=$(($(now) - T0)) C_KILLED=false
  fe_owned "$CPID" && kill -TERM "$CPID" 2>/dev/null
  end=$((SECONDS + GRACE))
  while fe_owned "$CPID" && [ "$SECONDS" -lt "$end" ]; do sleep 0.2; done
  if fe_owned "$CPID"; then kill -KILL "$CPID" 2>/dev/null; C_KILLED=true; fi
  wait "$CPID" 2>/dev/null
  [ -n "$CRC" ] || CRC=$?
  C_EXIT_MS=$(($(now) - T0))
}
alive_owned() { # pid lstart: 0 if running (not zombie) with that start time
  local stat
  stat=$(ps -o stat= -p "$1" 2>/dev/null | sed 's/^ *//')
  case "$stat" in "" | Z*) return 1 ;; esac
  [ "$(fe_lstart "$1")" = "$2" ]
}
verify_client() { # sets OWN SURV; returns 0 verified clean, 13 survivors, 14 unverifiable
  OWN=none SURV=""
  [ "$CREG" = none ] && return 0
  local pat=${CREG//'{pid}'/$CPID} m n=0 reg="" crun pid lbl st id name out irc i left
  for m in $pat; do [ -d "$m" ] && { n=$((n + 1)); reg=$m; }; done
  if [ "$n" != 1 ]; then OWN="unverifiable:registry_matches=$n"; return 14; fi
  [ -r "$reg/pids" ] && [ -r "$reg/containers" ] || { OWN="unverifiable:registry_files"; return 14; }
  crun=$(basename "$(dirname "$reg")")
  OWN="verified:$reg"
  while IFS="$(printf '\t')" read -r pid lbl st; do
    [ -n "$pid" ] || continue
    if alive_owned "$pid" "$st"; then SURV="$SURV pid:$pid:$lbl"; kill -TERM "$pid" 2>/dev/null; fi
  done <"$reg/pids"
  while IFS="$(printf '\t')" read -r id name; do
    [ -n "$id" ] || continue
    command -v docker >/dev/null 2>&1 || { OWN="unverifiable:no_docker_for_listed_containers"; return 14; }
    out=$(docker inspect -f '{{index .Config.Labels "fe173.run"}}' "$id" 2>&1)
    irc=$?
    if [ "$irc" = 0 ]; then
      [ "$out" = "$crun" ] && { SURV="$SURV container:$name"; docker rm -f "$id" >/dev/null 2>&1; }
    else
      case "$out" in *"No such"*) ;; *) OWN="unverifiable:docker_inspect($id)"; return 14 ;; esac
    fi
  done <"$reg/containers"
  [ -n "$SURV" ] || return 0
  for i in $(seq 1 50); do
    left=0
    while IFS="$(printf '\t')" read -r pid lbl st; do [ -n "$pid" ] && alive_owned "$pid" "$st" && left=1; done <"$reg/pids"
    [ "$left" = 0 ] && break
    sleep 0.2
  done
  while IFS="$(printf '\t')" read -r pid lbl st; do
    [ -n "$pid" ] && alive_owned "$pid" "$st" && kill -KILL "$pid" 2>/dev/null
  done <"$reg/pids"
  return 13
}
outcome() { # rc reason
  local rc=$1 vrc g_ms s
  fe_stop_pid "$GPID"
  wait "$GPID" 2>/dev/null
  g_ms=$(($(now) - T0))
  C_TERM_MS=null C_EXIT_MS=null C_KILLED=false
  [ -n "$CPID" ] && stop_client
  [ "$2" = client_exit ] && rc=$CRC
  verify_client
  vrc=$?
  [ "$vrc" = 0 ] || rc=$vrc
  s=$(printf '%s' "$SURV" | sed 's/^ //; s/ /","/g')
  [ -n "$s" ] && s="\"$s\""
  printf '{"rc":%s,"reason":"%s","externalSignal":"%s","clientExit":%s,"guardStoppedMs":%s,"clientTermMs":%s,"clientExitMs":%s,"clientKilled":%s,"graceS":%s,"ownership":"%s","survivors":[%s]}\n' \
    "$rc" "$2" "${SIG:-none}" "${CRC:-null}" "$g_ms" "$C_TERM_MS" "$C_EXIT_MS" "$C_KILLED" "$GRACE" "$OWN" "$s" >"$RUN/guard-run.json"
  exit "$rc"
}
external() { outcome "$([ "$SIG" = INT ] && echo 130 || echo 143)" "external_$SIG"; }
fe_start guard "$RUN/guard.out" node "$H/rpc-guard.mjs" --run-dir "$RUN" --upstream "$UP" --cap "$CAP" \
  --min-interval-ms "$GAP" --timeout-ms "$TMO" --max-log-span "$SPAN" || exit 12
GPID=$(fe_pid guard)
ready() {
  [ -n "$SIG" ] && return 3
  [ -s "$RUN/guard.ready.json" ] && return 0
  fe_owned "$GPID" && return 1 || return 3
}
fe_wait_until 10 0.1 "guard ready" ready || { [ -n "$SIG" ] && external; outcome 12 guard_not_ready; }
[ -n "$SIG" ] && external
URL=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).url' "$RUN/guard.ready.json")
fe_start client "$RUN/client.out" env FE173_GUARD_URL="$URL" BASE_COLLECTOR_HTTP_URL="$URL" "$@" || outcome 12 client_not_started
CPID=$(fe_pid client)
END=$((SECONDS + DL))
while :; do
  [ -n "$SIG" ] && external
  [ -e "$RUN/guard.STOP" ] && outcome 10 guard_stop
  if ! fe_owned "$CPID"; then
    wait "$CPID" 2>/dev/null
    CRC=$?
    [ -e "$RUN/guard.STOP" ] && outcome 10 guard_stop
    outcome "$CRC" client_exit
  fi
  fe_owned "$GPID" || outcome 12 guard_died
  [ "$SECONDS" -lt "$END" ] || outcome 11 deadline
  sleep 0.1
done

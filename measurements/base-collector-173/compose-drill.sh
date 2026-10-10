#!/usr/bin/env bash
# Evidence-only composition drill (preparation; fake loopback only; no real node, Docker, NATS, Postgres).
# Assembles the reviewed HTTP guard + final controller (4df26b2) and WS proxy (f694290) byte-exactly
# from git objects (compose-assemble.sh) and runs the assembled guard-run.sh with an owned toy client
# (compose-client.sh) that starts the assembled ws-guard.mjs and uses both transports.
#   FE173_TEST_ROOT=<absolute existing dir> ./compose-drill.sh
# PASS/FAIL: each component's own contract inside the composition. GAP: where the composition does not
# meet the drill requirement (expected vs actual); recorded, not repaired. Exit 0 if no FAIL.
set -u
cd "$(dirname "$0")" || exit 2
D=$(pwd)
REPO=$(git rev-parse --show-toplevel) || exit 2
: "${FE173_TEST_ROOT:?set FE173_TEST_ROOT to an absolute existing directory}"
case "$FE173_TEST_ROOT" in /*) ;; *) echo "FE173_TEST_ROOT must be absolute" >&2; exit 2 ;; esac
T=$(mktemp -d "${FE173_TEST_ROOT%/}/fe173-compose.XXXXXX") || exit 2
PIDS=""
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT
F=0 G=0 N=0
ok() { N=$((N + 1)); echo "PASS $1"; }
bad() { N=$((N + 1)); F=$((F + 1)); echo "FAIL $1"; }
expect() { [ "$1" = "$2" ] && ok "$3 ($1)" || bad "$3 (got $1, want $2)"; }
gap() { G=$((G + 1)); echo "GAP $1"; }
jget() { node -pe "const j=JSON.parse(require('fs').readFileSync(process.argv[1]));$2" "$1"; }
P=measurements/base-collector-173
A=$D/compose-assemble.sh
echo "compose-drill: node $(node -v), $(uname -sr), drill head $(git rev-parse HEAD)"

# 1. Assembly: refusals on scratch clones (the real repository is only read), then the real assembly.
CL=$T/clone
git clone -q --no-hardlinks "$REPO" "$CL" || exit 2
rf() { # want-reason cmd...: expect exit 3 and that REFUSED reason
  local want=$1 out rc
  shift
  out=$("$@" 2>&1 >/dev/null)
  rc=$?
  expect "$rc/$(printf '%s' "$out" | sed -n 's/^compose-assemble: REFUSED \([a-z_]*\).*/\1/p' | head -1)" "3/$want" "assembly refused: $want"
}
echo x >>"$CL/$P/rpc-guard.mjs"
rf dirty_inputs "$A" "$CL" "$T/a1"
git -C "$CL" checkout -q -- "$P/rpc-guard.mjs"
echo x >"$CL/$P/ws-guard.mjs"
rf dirty_inputs "$A" "$CL" "$T/a2"
rm -f "$CL/$P/ws-guard.mjs"
rf ws_head_not_pinned env FE173_WS_HEAD=c899530c43e15d1fc6d334ddba12f59dd6c0eac1 "$A" "$CL" "$T/a3"
rf http_head_not_pinned env FE173_HTTP_HEAD=b1edbfd752d9243621f53fc4d3ecdd6f4085fa5d "$A" "$CL" "$T/a4"
mkdir -p "$T/a5" && : >"$T/a5/x"
rf dest_not_empty "$A" "$CL" "$T/a5"
git clone -q --no-local --single-branch --branch "$(git -C "$REPO" branch --show-current)" "$REPO" "$T/thin" || exit 2
rf ws_head_missing "$A" "$T/thin" "$T/a6"
ASM=$T/asm
"$A" "$REPO" "$ASM" >"$T/assemble.out" 2>&1
expect "$?" 0 "assembly from the repository object store"
echo "PROVENANCE $(node -pe 'JSON.stringify(require(process.argv[1]))' "$ASM/provenance.json")"
echo "ASSEMBLED"
sed 's/^/  /' "$ASM/ASSEMBLED.sha256"
"$A" --verify "$ASM" >/dev/null 2>&1
expect "$?" 0 "assembled bytes verify"
cp -R "$ASM" "$T/asm-t" && printf ' ' >>"$T/asm-t/ws-guard.mjs"
rf assembled_bytes_changed "$A" --verify "$T/asm-t"

# 2. One finite run of six cases against fresh fake loopback upstreams per case.
NP=$(jget "$ASM/provenance.json" j.ws.nodePath)
node -pe 'JSON.stringify(require(process.argv[1]).filters)' "$ASM/ws-contract-2026-10-10.json" >"$T/filters.json"
sleep 300 &
DECOY=$!
PIDS="$PIDS $DECOY"
DECOY_ST=$(ps -o lstart= -p "$DECOY")
left() { # registry dir: registered PIDs still running with the recorded lstart
  local n=0 pid l st
  [ -r "$1/pids" ] || { echo unreadable; return; }
  while IFS="$(printf '\t')" read -r pid l st; do [ "$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$st" ] && n=$((n + 1)); done <"$1/pids"
  echo "$n"
}
port() {
  for _ in $(seq 1 50); do [ -s "$1" ] && break; sleep 0.1; done
  jget "$1" j.port
}
WSCAPS="--max-concurrent 2 --max-connections 2 --max-messages 100000 --max-bytes 100000000 --max-frame-bytes 65536 --max-duration-s 60"
TOY="--http-interval-ms 30"
run_case() { # name mode grace deadline toyargs wscaps want_rc [term_after_s]
  C=$T/c-$1
  mkdir -p "$C/g" "$C/c"
  node "$ASM/fake-upstream.mjs" "$C/http.up.jsonl" ok >"$C/http.port" &
  local hu=$! wu hp wp gp
  NODE_PATH=$NP node "$ASM/fake-ws-upstream.mjs" "$C/ws.up.jsonl" --notify 100000 --interval-ms 20 >"$C/ws.port" &
  wu=$!
  PIDS="$PIDS $hu $wu"
  hp=$(port "$C/http.port")
  wp=$(port "$C/ws.port")
  ASM=$ASM NODE_PATH=$NP CC_WS_UPSTREAM=ws://127.0.0.1:$wp CC_WS_CAPS="$6" CC_FILTERS=$T/filters.json CC_TOY=$D/toy-client.mjs \
    CC_TOY_ARGS="$5" CC_DECOY=$DECOY perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV or exit 127' \
    "$ASM/guard-run.sh" "$C/g" "http://127.0.0.1:$hp" 1000 50 2000 500 "$4" "$3" "$C/c/cc-{pid}/registry" \
    -- bash "$D/compose-client.sh" "$C/c" "$2" 2>"$C/ctl.err" &
  gp=$!
  if [ -n "${8:-}" ]; then
    sleep "$8"
    kill -TERM "$gp"
  fi
  wait "$gp"
  RC=$?
  kill "$hu" "$wu" 2>/dev/null
  wait "$hu" "$wu" 2>/dev/null
  AJ=$C/analysis.json
  node "$D/compose-analyze.mjs" "$C" >"$AJ"
  echo "RESULT $(cat "$AJ")"
  expect "$RC/$(jget "$AJ" 'j.guardRun?.rc')/$(jget "$AJ" j.clientRegistries)" "$7/$7/1" "$1: guard-run exit = guard-run.json rc, one client registry"
  expect "$(jget "$AJ" '[j.http?.reconciled, j.http?.forwarded===j.http?.upstreamReceived].join("/")')" true/true "$1: HTTP summary reconciled, forwarded = fake HTTP upstream received"
  expect "$(jget "$AJ" '[j.ws?.reconciled, j.ws?.forwardedUp===j.ws?.upstreamRecv].join("/")')" true/true "$1: WS summary reconciled, forwarded up = fake WS upstream received"
  expect "$(left "$C/g/registry")/$(left "$(echo "$C"/c/cc-*/registry)")" 0/0 "$1: registered processes still running (controller/client registries)"
  local first n gms
  first=$(jget "$AJ" j.firstStop)
  gms=$(jget "$AJ" 'Math.abs(j.stopGapMs).toFixed(1)')
  if [ "$first" = http ]; then
    n=$(jget "$AJ" j.wsForwardedAfterHttpStop)
    [ "$n" = 0 ] && ok "$1: no WS frames forwarded after the HTTP guard stopped (0)" ||
      gap "$1: first stop HTTP; expected 0 WS frames forwarded after it; actual $n over ${gms} ms until ws-guard stopped ($(jget "$AJ" j.ws.stopReason))"
  else
    n=$(jget "$AJ" j.httpAdmittedAfterWsStop)
    [ "$n" = 0 ] && ok "$1: no HTTP requests admitted after the WS guard stopped (0)" ||
      gap "$1: first stop WS ($(jget "$AJ" j.ws.stopReason)); expected 0 HTTP admissions after it; actual $n over ${gms} ms until rpc-guard stopped"
    gap "$1: guard-run.json reports reason $(jget "$AJ" j.guardRun.reason) rc $(jget "$AJ" j.guardRun.rc); it has no field for the WS guard's STOP ($(jget "$AJ" j.ws.stopReason)), only the client wrapper's exit code"
  fi
}
run_case http_stop prompt 20 30 "$TOY --bad-after 5" "$WSCAPS" 10
expect "$(jget "$AJ" '[j.guardRun.reason, j.http.stopFile, j.ws.stopReason, j.ws.exitCode].join("/")')" guard_stop/true/signal_TERM/0 "http_stop: reason/HTTP STOP file/ws-guard stop/ws-guard exit"
run_case ws_message_cap prompt 20 30 "$TOY" "$WSCAPS --max-messages 60" 21
expect "$(jget "$AJ" '[j.guardRun.reason, /message/.test(j.ws.stopReason), j.ws.exitCode, j.ws.admitted<=60].join("/")')" client_exit/true/10/true "ws_message_cap: reason/ws stop/ws exit/admitted<=cap"
run_case ws_duration_cap prompt 20 30 "$TOY" "$WSCAPS --max-duration-s 2" 21
expect "$(jget "$AJ" '[j.guardRun.reason, j.ws.stopReason, j.ws.exitCode].join("/")')" client_exit/duration_cap/10 "ws_duration_cap: reason/ws stop/ws exit"
run_case ext_term_prompt prompt 20 60 "$TOY" "$WSCAPS" 143 3
expect "$(jget "$AJ" '[j.guardRun.reason, j.guardRun.externalSignal, j.guardRun.survivors.length, j.guardRun.ownership.split(":")[0], j.guardRun.guardStoppedMs<=j.guardRun.clientTermMs].join("/")')" external_TERM/TERM/0/verified/true "ext_term_prompt: reason/signal/survivors/ownership/guard stopped before client TERM"
run_case ext_term_delayed delay:3000 20 60 "$TOY" "$WSCAPS" 143 3
expect "$(jget "$AJ" '[j.guardRun.reason, j.guardRun.survivors.length, j.guardRun.clientKilled, j.ws.stopReason].join("/")')" external_TERM/0/false/signal_TERM "ext_term_delayed: reason/survivors/clientKilled/ws stop"
run_case ext_term_ignore ignore 5 60 "$TOY" "$WSCAPS" 13 3
expect "$(jget "$AJ" '[j.guardRun.reason, j.guardRun.clientKilled, j.guardRun.survivors.map((s)=>s.replace(/pid:[0-9]+:/,"")).sort().join(" ")].join("/")')" "external_TERM/true/toy wsguard" "ext_term_ignore: reason/clientKilled/owned survivors listed (exit 13, not 143)"
expect "$([ "$(ps -o lstart= -p "$DECOY")" = "$DECOY_ST" ] && echo untouched || echo SIGNALLED)" untouched "foreign decoy (unregistered, and planted as a reused-PID registry line in every client registry) untouched"
"$A" --verify "$ASM" >/dev/null 2>&1
expect "$?" 0 "assembled bytes unchanged after the run"
kill "$DECOY" 2>/dev/null
echo "compose-drill: $N checks, $F failed, $G composition gaps"
[ "$F" = 0 ]

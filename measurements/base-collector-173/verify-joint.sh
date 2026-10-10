#!/usr/bin/env bash
# Fake-loopback acceptance cases J1-J13 for joint-guard.mjs + joint-run.sh (preparation only; no real node,
# Docker, NATS, Postgres or network). Fake upstreams are assembled byte-exactly from 4df26b2/f694290 by
# compose-assemble.sh. Each case's raw evidence (.json/.jsonl/stdout) is copied to OUT.
#   FE173_TEST_ROOT=<absolute existing dir> ./verify-joint.sh OUT      (OUT must not exist)
# Exit 0 if every check passes.
set -u
cd "$(dirname "$0")" || exit 2
D=$(pwd)
REPO=$(git rev-parse --show-toplevel) || exit 2
OUT=${1:?usage: verify-joint.sh OUT}
case "$OUT" in /*) ;; *) OUT=$D/$OUT ;; esac
[ ! -e "$OUT" ] || { echo "OUT exists: $OUT" >&2; exit 2; }
: "${FE173_TEST_ROOT:?set FE173_TEST_ROOT to an absolute existing directory}"
case "$FE173_TEST_ROOT" in /*) ;; *) echo "FE173_TEST_ROOT must be absolute" >&2; exit 2 ;; esac
T=$(mktemp -d "${FE173_TEST_ROOT%/}/fe173-joint.XXXXXX") || exit 2
PIDS=""
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT
mkdir -p "$OUT"
F=0 N=0
ok() { N=$((N + 1)); echo "PASS $1"; }
bad() { N=$((N + 1)); F=$((F + 1)); echo "FAIL $1"; }
expect() { [ "$1" = "$2" ] && ok "$3 ($1)" || bad "$3 (got $1, want $2)"; }
jget() { node -pe "const j=JSON.parse(require('fs').readFileSync(process.argv[1]));$2" "$1"; }
echo "verify-joint: node $(node -v), $(uname -sr), head $(git rev-parse HEAD)"
ASM=$T/asm
"$D/compose-assemble.sh" "$REPO" "$ASM" >"$T/assemble.out" 2>&1 || { cat "$T/assemble.out"; echo "FAIL assembly"; exit 1; }
NP=$(jget "$ASM/provenance.json" j.ws.nodePath)
node -pe 'JSON.stringify(require(process.argv[1]).filters)' "$ASM/ws-contract-2026-10-10.json" >"$T/filters.json"
sleep 600 &
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
WSDEF="--max-concurrent 3 --max-connections 3 --max-messages 100000 --max-bytes 100000000 --max-frame-bytes 65536 --max-duration-s 60 --max-preopen-frames 8"
ws() { # k v ...: WSDEF with overrides
  local s=$WSDEF
  while [ $# -ge 2 ]; do s=$(printf '%s' "$s" | sed "s/--$1 [0-9]*/--$1 $2/"); shift 2; done
  printf '%s' "$s"
}
STREAM="--notify 100000 --interval-ms 5"
# run NAME MODE GRACE CAP "TOY ARGS" "WS CAPS" "FAKE WS ARGS" WANT_RC WANT_LATCH [SIG AFTER_S]
run() {
  local C=$T/$1 hu wu hp wp gp rc a
  mkdir -p "$C/g" "$C/c"
  node "$ASM/fake-upstream.mjs" "$C/http.up.jsonl" ok >"$C/http.port" 2>&1 &
  hu=$!
  # shellcheck disable=SC2086
  NODE_PATH=$NP node "$ASM/fake-ws-upstream.mjs" "$C/ws.up.jsonl" $7 >"$C/ws.port" 2>&1 &
  wu=$!
  PIDS="$PIDS $hu $wu"
  hp=$(port "$C/http.port") wp=$(port "$C/ws.port")
  # shellcheck disable=SC2086
  JOINT_WS_ARGS="--ws-upstream ws://127.0.0.1:$wp --filters $T/filters.json --allow-new-heads $6" JC_FILTERS=$T/filters.json JC_DECOY=$DECOY \
    perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV or exit 127' "$D/joint-run.sh" "$C/g" "http://127.0.0.1:$hp" "$4" 50 2000 500 30 "$3" \
    "$C/c/jc-{pid}/registry" -- bash "$D/joint-client.sh" "$C/c" "$2" $5 >"$C/joint-run.stdout" 2>"$C/joint-run.stderr" &
  gp=$!
  if [ -n "${10:-}" ]; then sleep "${11}"; kill -"${10}" "$gp"; fi
  wait "$gp"
  rc=$?
  kill "$hu" "$wu" 2>/dev/null
  wait "$hu" "$wu" 2>/dev/null
  node "$D/joint-analyze.mjs" "$C" >"$C/analysis.json"
  a=$C/analysis.json
  echo "RESULT $1 $(cat "$a")"
  expect "$rc/$(jget "$a" j.rc)" "$8/$8" "$1 joint-run exit = joint-run.json rc"
  expect "$(jget "$a" 'j.latch.transport+"/"+j.latch.reason')" "$9" "$1 first latch transport/reason"
  expect "$(jget "$a" '[j.latchCount,j.seqContiguous,j.stopFileMatchesLog].join("/")')" "1/true/true" "$1 one latch, contiguous seq, JOINT.STOP = log latch"
  expect "$(jget "$a" 'Object.values(j.decisionsAfterLatch).join("/")')" "0/0/0/0" "$1 decisions after latch seq httpAdmit/httpForward/wsUp/wsDown"
  expect "$(jget "$a" 'j.guardCounters.afterLatch+"/"+j.allReconciled')" "0/true" "$1 guard afterLatch counter, both censuses reconciled"
  expect "$(jget "$a" 'j.fakeHttpReceived===j.http.forwarded')" true "$1 fake HTTP upstream received = http forwarded"
  expect "$(jget "$a" 'j.preLatchUndelivered.wsUp>=0&&j.preLatchUndelivered.wsDown>=0')" true "$1 far ends saw no WS frame beyond pre-latch decisions"
  expect "$(jget "$a" 'j.toySignalAfterLatchNs===null||BigInt(j.toySignalAfterLatchNs)>0n')" true "$1 client signalled only after the latch"
  expect "$(jget "$a" 'j.guardStoppedBeforeClientTerm')" true "$1 guard stopped before client TERM/grace"
  expect "$(jget "$a" 'j.clientRegistries+"/"+j.ownership.startsWith("verified:")')" "1/true" "$1 one client registry, ownership verified"
  expect "$(left "$C/g/registry")/$(left "$(ls -d "$C"/c/jc-*/registry)")" "0/0" "$1 registered PIDs still running (controller/client)"
  cp -R "$C" "$OUT/$1"
}
run J1 prompt 20 100000 "--bad-after 5" "$(ws)" "$STREAM" 10 http/method_not_allowed
run J2 prompt 20 20 "" "$(ws)" "$STREAM" 10 http/cap_exceeded
expect "$(jget "$T/J2/analysis.json" 'j.http.admitted+"/"+j.http.refusedReasons.cap_exceeded')" "20/1" "J2 exactly cap admitted, request N+1 refused"
run J3 prompt 20 100000 "" "$(ws max-messages 60)" "$STREAM" 10 ws/messages_cap
expect "$(jget "$T/J3/analysis.json" 'j.ws.admitted')" 60 "J3 exactly message cap admitted"
run J4 prompt 20 100000 "" "$(ws max-duration-s 2)" "$STREAM" 10 ws/duration_cap
run J5 prompt 20 100000 "" "$(ws max-frame-bytes 1024)" "$STREAM --frame-bytes 2048" 10 ws/frame_too_large
expect "$(jget "$T/J5/analysis.json" 'j.toyWsMessages<=2')" true "J5 no oversize frame delivered (only subscribe replies)"
run J6 prompt 20 100000 "" "$(ws)" "$STREAM --close-after-ms 1500" 10 ws/upstream_closed
expect "$(jget "$T/J6/analysis.json" 'j.fakeWsConnections')" 1 "J6 no upstream reconnect"
run J7 prompt 20 100000 "--http-burst 20 --ws-conns 3 --ws-subs 5" "$(ws max-preopen-frames 4)" "$STREAM --accept-delay-ms 2000" 10 ws/preopen_cap
expect "$(jget "$T/J7/analysis.json" '[j.ws.accepted,j.http.dropped>0,j.ws.dropped>0,j.fakeWsReceived].join("/")')" "3/true/true/0" "J7 3 WS conns; queued HTTP and pre-open WS frames dropped; nothing reached WS upstream"
run J8 prompt 20 100000 "" "$(ws)" "$STREAM" 143 signal/signal_TERM TERM 3
run J9 delay:3000 20 100000 "" "$(ws)" "$STREAM" 143 signal/signal_TERM TERM 3
expect "$(jget "$T/J9/analysis.json" 'j.clientKilled')" false "J9 delayed client exits within grace"
run J10 ignore 5 100000 "" "$(ws)" "$STREAM" 13 signal/signal_TERM TERM 3
expect "$(jget "$T/J10/analysis.json" 'j.survivors.some((s)=>s.endsWith(":toy"))')" true "J10 TERM-ignoring owned toy reported as survivor"
run J11 prompt 20 100000 "" "$(ws)" "$STREAM" 130 signal/signal_INT INT 3
for c in J8 J9 J10 J11; do
  expect "$(jget "$T/$c/analysis.json" 'j.trapToLatchNs!==null&&BigInt(j.trapToLatchNs)>0n')" true "$c trapToLatchNs reported ($(jget "$T/$c/analysis.json" j.trapToLatchNs) ns)"
done
# J12: decoys
expect "$(ps -o lstart= -p "$DECOY")" "$DECOY_ST" "J12 unregistered decoy and reused-PID registry lines untouched"
expect "$(cat "$T"/J*/c/jc-*/registry/pids | awk -F'\t' -v p="$DECOY" '$1 == p' | wc -l | tr -d ' ')" 11 "J12 reused-PID line planted in every client registry"
# J13: provenance
node "$D/joint-rules-check.mjs" "$OUT/joint-rules.diff" >"$OUT/joint-rules-check.json"
expect "$?" 0 "J13 verbatim rule blocks sha256 + joint-run.sh declared diff"
"$D/compose-assemble.sh" --verify "$ASM" >/dev/null 2>&1
expect "$?" 0 "J13 assembled 4df26b2/f694290 bytes match their MANIFESTs"
P=measurements/base-collector-173
git -C "$REPO" diff --quiet 4df26b2bc2f90efd25e7dd3fb8f50ea4b3fa62a6 -- $P/rpc-guard.mjs $P/guard-run.sh $P/lib-run.sh $P/fake-upstream.mjs $P/verify-guard.sh
expect "$?" 0 "J13 working-tree rpc-guard/guard-run/lib-run/fakes byte-equal to 4df26b2"
git -C "$REPO" diff --quiet af53a874abf0d9798f8f1b7dc5ecf45d7e39f899 -- $P/compose-drill.sh $P/compose-assemble.sh $P/compose-client.sh $P/toy-client.mjs $P/compose-analyze.mjs
expect "$?" 0 "J13 composition drill files byte-equal to af53a874"
git -C "$REPO" diff --quiet 5206f9035ad1c057d78990b294941221e936f895 -- modules
expect "$?" 0 "J13 modules/ byte-equal to #173 5206f90"
cp "$ASM/provenance.json" "$OUT/assembly-provenance.json"
echo "verify-joint: $((N - F))/$N PASS, $F FAIL"
[ "$F" = 0 ]

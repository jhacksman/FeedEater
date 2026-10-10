#!/usr/bin/env bash
# Offline checks of ws-guard.mjs against fake-ws-upstream.mjs on 127.0.0.1 (no real node, Docker or
# NATS). Usage: FE173_TEST_ROOT=<absolute existing dir> ./verify-ws-guard.sh
set -u
cd "$(dirname "$0")" || exit 2
H=$(pwd)
: "${FE173_TEST_ROOT:?set FE173_TEST_ROOT to an absolute existing directory}"
case "$FE173_TEST_ROOT" in /*) ;; *) echo "FE173_TEST_ROOT must be absolute" >&2; exit 2 ;; esac
T=$(mktemp -d "${FE173_TEST_ROOT%/}/fe173-wsguard.XXXXXX") || exit 2
PIDS=""
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT
F=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; F=1; }
expect() { [ "$1" = "$2" ] && ok "$3 ($1)" || bad "$3 (got $1, want $2)"; }
jget() { node -pe "const j=JSON.parse(require('fs').readFileSync(process.argv[1]));$2" "$1"; }
node -pe 'JSON.stringify(require("./ws-contract-2026-10-10.json").filters)' >"$T/filters.json"
PM_CS=0x498581fF718922c3f8e6A244956aF099B2652b2b
F1=$(node -pe "const f=require('$T/filters.json')[0];JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_subscribe',params:['logs',{address:['$PM_CS'],topics:f.topics}]})")
F2=$(node -pe "JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['logs',require('$T/filters.json')[1]]})")
NH='{"jsonrpc":"2.0","id":3,"method":"eth_subscribe","params":["newHeads"]}'
cat >"$T/client.mjs" <<'JS'
// node client.mjs URL WAIT_MS FRAME... : sends frames on open ("BIN:" prefix = binary), prints shas.
import crypto from "node:crypto";
import { createRequire } from "node:module";
const WS = createRequire(process.env.H + "/ws-guard.mjs")("ws");
const [url, wait, ...frames] = process.argv.slice(2);
const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
const r = { sent: [], recv: [], code: null };
const w = new WS.WebSocket(url);
const done = () => (process.stdout.write(JSON.stringify(r)), process.exit(0));
w.on("open", () => {
  for (const f of frames) {
    const bin = f.startsWith("BIN:");
    const d = bin ? Buffer.from(f.slice(4)) : f;
    w.send(d, { binary: bin });
    r.sent.push(sha(d));
  }
});
w.on("message", (d) => r.recv.push(sha(d)));
w.on("close", (code) => ((r.code = code), done()));
w.on("error", () => {});
setTimeout(done, Number(wait));
JS
export H
ustart() { # name [fake args]: sets ULOG UPORT UP
  local n=$1
  shift
  ULOG=$T/$n.up.jsonl
  node fake-ws-upstream.mjs "$ULOG" "$@" >"$T/$n.up.port" &
  UP=$!
  PIDS="$PIDS $UP"
  for _ in $(seq 1 50); do [ -s "$T/$n.up.port" ] && break; sleep 0.1; done
  UPORT=$(jget "$T/$n.up.port" j.port)
}
ustop() { kill "$UP" 2>/dev/null; wait "$UP" 2>/dev/null; }
gstart() { # name [guard args...] (defaults overridable by later flags): sets GR GP GURL
  GR=$T/$1
  shift
  mkdir -p "$GR"
  node ws-guard.mjs --run-dir "$GR" --upstream "ws://127.0.0.1:$UPORT" --filters "$T/filters.json" \
    --max-concurrent 4 --max-connections 8 --max-messages 1000 --max-bytes 1000000 --max-frame-bytes 65536 --max-duration-s 60 "$@" 2>"$GR/err" &
  GP=$!
  PIDS="$PIDS $GP"
  for _ in $(seq 1 50); do [ -s "$GR/ws-guard.ready.json" ] && break; sleep 0.1; done
  GURL=$(jget "$GR/ws-guard.ready.json" j.url)
}
gstop() { kill -"${1:-TERM}" "$GP" 2>/dev/null; wait "$GP" 2>/dev/null; }
client() { node "$T/client.mjs" "$GURL" "$@"; }
upc() { grep -c "\"ev\":\"$1\"" "$ULOG"; }
sumq() { jget "$GR/ws-guard.summary.json" "$1"; }
REC='[j.stopReason,j.reconciled].join("/")'

# 1. Configuration refusals: exit 2, nothing listens.
mkdir -p "$T/cfg"
base=(--run-dir "$T/cfg" --upstream ws://127.0.0.1:9 --filters "$T/filters.json" --max-concurrent 1 --max-connections 1 --max-messages 1 --max-bytes 1 --max-frame-bytes 1 --max-duration-s 1)
cfg() { node ws-guard.mjs "$@" >/dev/null 2>&1; expect "$?" 2 "config: $CASE"; }
CASE="missing caps" cfg --run-dir "$T/cfg" --upstream ws://127.0.0.1:9 --filters "$T/filters.json"
CASE="cap 0" cfg "${base[@]}" --max-messages 0
CASE="cap not integer" cfg "${base[@]}" --max-bytes 1e3
CASE="wss upstream" cfg "${base[@]}" --upstream wss://127.0.0.1:9
CASE="credentials" cfg "${base[@]}" --upstream ws://u:p@127.0.0.1:9
CASE="query" cfg "${base[@]}" --upstream "ws://127.0.0.1:9/?k=v"
CASE="relative run dir" cfg "${base[@]}" --run-dir rel
CASE="bad filters" cfg "${base[@]}" --filters /dev/null
expect "$(ls "$T/cfg" | wc -l | tr -d ' ')" 0 "config: no evidence files written"

# 2. Identical forwarding (checksummed address accepted; bytes unchanged both ways).
ustart fwd --notify 3
gstart fwd --allow-new-heads
o=$(client 1500 "$F1" "$F2" "$NH")
gstop
expect "$(node -pe 'JSON.parse(process.argv[1]).recv.length' "$o")" 12 "forward: client received 3 acks + 9 notifications"
expect "$(node -e '
const fs=require("fs");const o=JSON.parse(process.argv[1]);const L=fs.readFileSync(process.argv[2],"utf8").trim().split("\n").map(JSON.parse);
const s=(a)=>JSON.stringify([...a].sort());
console.log(s(o.sent)===s(L.filter(x=>x.ev==="recv").map(x=>x.sha))&&s(o.recv)===s(L.filter(x=>x.ev==="sent").map(x=>x.sha))?"identical":"DIFFER")' "$o" "$ULOG")" identical "forward: sha256 of every frame equal both directions"
expect "$(sumq '[j.received,j.admitted,j.forwarded,j.dropped,j.refused].join("/")')/$(sumq "$REC")" "15/15/15/0/0/signal_TERM/true" "forward: received/admitted/forwarded/dropped/refused, stop, reconciled"
expect "$(grep -c '"ev":"subscribe"' "$GR/ws-guard.jsonl")/$(grep -o '"filter":[0-9a-z]*' "$GR/ws-guard.jsonl" | tr '\n' ' ')" '3/"filter":0 "filter":1 "filter":null ' "forward: subscribes recorded with filter index"
expect "$(grep -c "$PM_CS\|0x498581ff\|eth_subscription\|pad" "$GR/ws-guard.jsonl" "$GR/ws-guard.summary.json" | awk -F: '{s+=$2} END {print s}')" 0 "forward: no payload content in diagnostics"
ustop

# 3. Simultaneous connections within the cap.
ustart sim --notify 3
gstart sim --max-concurrent 3
CPS=""
for i in 1 2 3; do client 1500 "$F2" >"$T/sim.$i" & CPS="$CPS $!"; done
wait $CPS; sleep 0.2
gstop
expect "$(cat "$T"/sim.? | node -e 'let n=0;require("fs").readFileSync(0,"utf8").split("}{").forEach(()=>n++);console.log(n)')/$(upc connection)" 3/3 "simultaneous: 3 clients, 3 upstream connections"
expect "$(sumq '[j.connectionsAccepted,j.admitted,j.forwarded].join("/")')/$(sumq "$REC")" "3/15/15/signal_TERM/true" "simultaneous: accepted/admitted/forwarded, reconciled"
ustop
ustart sim2 --notify 50 --interval-ms 50
gstart sim2 --max-concurrent 2
CPS=""
for i in 1 2 3; do client 1500 "$F2" >"$T/sim2.$i" & CPS="$CPS $!"; done
wait $CPS
gstop
expect "$(sumq "$REC")/$(sumq 'j.connectionsAccepted+"/"+j.connectionsRefused+"/"+(j.upstreamOpened<=2)')/$([ "$(upc connection)" -le 2 ] && echo le2)" "concurrent_cap/true/2/1/true/le2" "concurrent cap 2, 3 clients: STOP, accepted/refused, upstream connections <= 2"
ustop

# 4. Frame, message, byte and duration caps.
ustart big --notify 1 --frame-bytes 2000
gstart big --max-frame-bytes 1000
o=$(client 1500 "$F2")
gstop
expect "$(sumq "$REC")/$(node -pe 'JSON.parse(process.argv[1]).recv.length' "$o")" "frame_too_large/true/1" "frame 2000 > 1000: STOP, client got only the ack"
ustop
ustart msg --notify 10
gstart msg --max-messages 5
o=$(client 1500 "$F2")
wait "$GP"; grc=$?
expect "$grc/$(sumq '[j.stopReason,j.admitted,j.forwarded,j.reconciled].join("/")')/$(node -pe 'JSON.parse(process.argv[1]).recv.length' "$o")" "10/messages_cap/5/5/true/4" "messages cap 5: guard exit 10, admitted/forwarded, client received"
ustop
ustart byt --notify 10
gstart byt --max-bytes 400
client 1500 "$F2" >/dev/null
gstop
expect "$(sumq '[j.stopReason,j.bytesAdmitted<=400,j.reconciled].join("/")')" "bytes_cap/true/true" "bytes cap 400"
ustop
ustart dur --notify 1000 --interval-ms 20
gstart dur --max-duration-s 1
client 2500 "$F2" >/dev/null
gstop
expect "$(sumq "$REC")/$(node -e 'const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);const d=Number(BigInt(L.find(x=>x.ev==="stop").hrNs)-BigInt(L.find(x=>x.ev==="ready").hrNs))/1e9;console.log(d>=1&&d<1.5?"1s":d)' "$GR/ws-guard.jsonl")" "duration_cap/true/1s" "duration cap 1 s"
ustop

# 5. Total connections (reconnect budget): 2 allowed, third refused; no extra upstream connection.
ustart rc --notify 1
gstart rc --max-connections 2
for i in 1 2 3; do client 300 "$F2" >/dev/null; done
gstop
expect "$(sumq "$REC")/$(upc connection)" "connections_cap/true/2" "connections cap 2: STOP on third, upstream connections"
ustop

# 6. Malformed and disallowed client frames: refused, STOP, nothing reaches the upstream.
ustart ref
for c in "malformed_json|{x" "batch_refused|[$F2]" "method_not_allowed|{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[\"0x00\"]}" \
  "filter_not_allowed|{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_subscribe\",\"params\":[\"logs\",{\"address\":[\"0x0000000000000000000000000000000000000001\"]}]}" \
  "subscription_not_allowed|{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_subscribe\",\"params\":[\"logs\",{\"address\":[\"0x01\"],\"fromBlock\":\"0x1\"}]}" \
  "newheads_not_allowed|$NH" "binary_frame|BIN:$F2" "extra_field|{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_subscribe\",\"params\":[\"newHeads\"],\"x\":1}" \
  "bad_params|{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_unsubscribe\",\"params\":[1]}"; do
  want=${c%%|*}
  gstart "ref-$want"
  o=$(client 1000 "${c#*|}")
  gstop
  expect "$(sumq '[j.stopReason,j.refused,j.admitted,j.reconciled].join("/")')/$(node -pe 'JSON.parse(process.argv[1]).code' "$o")" "$want/1/0/true/1008" "refuse $want: STOP, client closed 1008"
done
expect "$(upc recv)" 0 "refusals: upstream received 0 frames"
ustop

# 7. Frames admitted while the upstream is still connecting, then TERM: dropped explicitly.
ustart pre --accept-delay-ms 800
gstart pre --allow-new-heads
client 1500 "$F1" "$F2" "$NH" >/dev/null &
CP=$!
sleep 0.3
gstop
wait "$CP"
sleep 0.8
expect "$(sumq '[j.received,j.dropped,j.forwarded,j.stopReason,j.reconciled].join("/")')/$(upc recv)" "3/3/0/signal_TERM/true/0" "pre-admitted at STOP: received/dropped/forwarded, upstream received"
ustop

# 8. Upstream close: STOP, client closed, no automatic upstream reconnect.
ustart ucl --notify 1000 --interval-ms 50 --close-after-ms 300
gstart ucl
o=$(client 1500 "$F2")
sleep 1
wait "$GP"; grc=$?
expect "$grc/$(upc connection)/$(node -pe 'JSON.parse(process.argv[1]).code' "$o")/$(sumq "$REC")" "10/1/1008/upstream_closed/true" "upstream close: guard exit 10, 1 upstream connection after 1 s, client closed, reconciled"
ustop

# 9. SIGINT: finite shutdown.
ustart int --notify 1000 --interval-ms 20
gstart int
client 3000 "$F2" >/dev/null &
CP=$!
sleep 0.5
t0=$(date +%s%N)
gstop INT
grc=$?
expect "$([ $(( ($(date +%s%N) - t0) / 1000000 )) -le 2500 ] && echo yes || echo no)/$grc/$(sumq "$REC")" "yes/0/signal_INT/true" "SIGINT: exit within 2.5 s, reconciled"
wait "$CP"
ustop

# 10. Owned cleanup via lib-run.sh; unregistered decoy untouched.
sleep 300 &
DECOY=$!
PIDS="$PIDS $DECOY"
DST=$(ps -o lstart= -p "$DECOY")
(
  RUNID=wsg-cleanup RUN=$T/cl
  mkdir -p "$RUN"
  . "$H/lib-run.sh"
  ustart cl --notify 1000 --interval-ms 50
  fe_register_pid "$UP" fake
  mkdir -p "$T/clg"
  fe_start wsguard "$T/clg.out" node ws-guard.mjs --run-dir "$T/clg" --upstream "ws://127.0.0.1:$UPORT" --filters "$T/filters.json" \
    --max-concurrent 1 --max-connections 1 --max-messages 1000 --max-bytes 1000000 --max-frame-bytes 65536 --max-duration-s 60
  sleep 0.5
  fe_cleanup
  for p in $(cut -f1 "$FE173_REG/pids"); do ps -p "$p" >/dev/null 2>&1 && echo "left $p"; done
) >"$T/cl.out" 2>&1
expect "$(grep -c '^left' "$T/cl.out")/$([ -s "$T/clg/ws-guard.summary.json" ] && echo summary)" "0/summary" "cleanup: owned guard and fake stopped, summary written"
expect "$([ "$(ps -o lstart= -p "$DECOY")" = "$DST" ] && echo untouched || echo SIGNALLED)" untouched "cleanup: unregistered decoy untouched"
kill "$DECOY"

[ "$F" = 0 ] && echo "verify-ws-guard: all checks passed" || echo "verify-ws-guard: FAILURES"
exit "$F"

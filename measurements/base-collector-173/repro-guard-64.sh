#!/usr/bin/env bash
# Evidence-only repro for review of 64db8f6 (no fix): (A) nested cleanup under guard-run.sh's 10 s
# outer TERM->KILL, (B) rpc-guard getLogs span check with block numbers above 2^53.
# Offline: fake-upstream.mjs on 127.0.0.1 only; no node, Docker, NATS or Postgres.
#   FE173_TEST_ROOT=/abs/existing/dir ./repro-guard-64.sh
# Only processes this script starts are signalled (PID + ps lstart from the registries it writes).
set -u
cd "$(dirname "$0")"
H=$PWD
export H
: "${FE173_TEST_ROOT:?set FE173_TEST_ROOT to an absolute existing directory}"
case "$FE173_TEST_ROOT" in /*) ;; *) echo "FE173_TEST_ROOT must be absolute" >&2; exit 2 ;; esac
T=$(mktemp -d "${FE173_TEST_ROOT%/}/fe173-repro64.XXXXXX") || exit 2
echo "scratch $T"
ms() { node -p 'Date.now()'; }
UPID=""
trap '[ -n "$UPID" ] && kill "$UPID" 2>/dev/null; rm -rf "$T"' EXIT

node fake-upstream.mjs "$T/up.jsonl" ok >"$T/up.out" &
UPID=$!
for _ in $(seq 1 50); do [ -s "$T/up.out" ] && break; sleep 0.1; done
UPORT=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).port' "$T/up.out")

# ---- A. nested cleanup ----
cat >"$T/child.mjs" <<'JS'
// child MODE LOG NAME: prompt = exit on TERM; delay:MS = exit MS after TERM; ignore = keep running
import fs from "node:fs";
const [mode, log, name] = process.argv.slice(2);
const w = (s) => fs.appendFileSync(log, `${Date.now()} ${name} pid=${process.pid} ${s}\n`);
w("start");
process.on("SIGTERM", () => {
  w("got TERM");
  if (mode === "prompt") process.exit(0);
  if (mode.startsWith("delay:")) setTimeout(() => { w("exit after delay"); process.exit(0); }, Number(mode.slice(6)));
});
setInterval(() => {}, 1e6);
JS
cat >"$T/inner.sh" <<'SH'
#!/usr/bin/env bash
# synthetic client: own registry under RUN, N registered children, run-native-style 5 s sleeps
RUN=$1 RUNID=inner-$$ MODE=$2 N=$3
. "$H/lib-run.sh"
L="$RUN/t.log"
trap 'echo "$(node -p "Date.now()") inner TERM handled" >>"$L"; exit 143' TERM
trap 'echo "$(node -p "Date.now()") inner cleanup start" >>"$L"; fe_cleanup; echo "$(node -p "Date.now()") inner cleanup end" >>"$L"' EXIT
for i in $(seq 1 "$N"); do fe_start "child$i" "$RUN/child$i.out" node "$RUN/../child.mjs" "$MODE" "$L" "child$i"; done
echo "$(node -p "Date.now()") inner ready pid=$$" >>"$L"
while :; do sleep 5; done
SH
sleep 300 &
DECOY=$!
DECOY_ST=$(ps -o lstart= -p "$DECOY")
scenario() { # name mode n
  local I="$T/A-$1" G="$T/A-$1-guard" t0 rc
  mkdir -p "$I" "$G"
  t0=$(ms)
  ./guard-run.sh "$G" "http://127.0.0.1:$UPORT" 0 0 1000 500 2 -- bash "$T/inner.sh" "$I" "$2" "$3" 2>"$G/ctl.err"
  rc=$?
  local t1
  t1=$(ms)
  echo "== A.$1: children=$3 mode=$2; guard-run exit $rc $(cat "$G/guard-run.json"); guard-run took $((t1 - t0)) ms"
  local ipid
  ipid=$(cat "$G/client.pid")
  echo "inner client pid $ipid: $(kill -0 "$ipid" 2>/dev/null && echo alive || echo gone) at guard-run return"
  awk -v t0="$t0" '{ printf "  +%6d ms %s\n", $1 - t0, substr($0, index($0, " ") + 1) }' "$I/t.log"
  local n=0 pid lbl st
  while IFS="$(printf '\t')" read -r pid lbl st; do
    if [ "$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$st" ]; then
      echo "  SURVIVOR $lbl pid=$pid (registered lstart matches, parent $(ps -o ppid= -p "$pid" | tr -d ' '))"
      n=$((n + 1))
    fi
  done <"$I/registry/pids"
  echo "  survivors at guard-run return: $n of $3"
  # Clean only this scenario's registered survivors (lib-run ownership check against the inner registry).
  (RUN=$I RUNID=x; . "$H/lib-run.sh"; while IFS="$(printf '\t')" read -r pid _ _; do fe_owned "$pid" && kill -KILL "$pid"; done <"$I/registry/pids")
  sleep 0.3
  n=0
  while IFS="$(printf '\t')" read -r pid lbl st; do
    [ "$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$st" ] && n=$((n + 1))
  done <"$I/registry/pids"
  echo "  survivors after repro cleanup: $n"
}
scenario prompt prompt 3
scenario delay3s delay:3000 3
scenario ignore ignore 3
echo "decoy pid $DECOY (not registered anywhere): $([ "$(ps -o lstart= -p "$DECOY")" = "$DECOY_ST" ] && echo untouched || echo SIGNALLED)"
kill "$DECOY"

# ---- B. getLogs span above 2^53 (one fresh guard per case: the first refusal STOPs a guard) ----
bcase() { # name fromBlock toBlock
  local D="$T/B-$(printf '%s' "$1" | tr -c 'a-z0-9' '_')" before after
  mkdir -p "$D"
  node rpc-guard.mjs --run-dir "$D" --upstream "http://127.0.0.1:$UPORT" --cap 10 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500 2>"$D/err" &
  local GP=$!
  for _ in $(seq 1 50); do [ -s "$D/guard.ready.json" ] && break; sleep 0.1; done
  before=$(wc -l <"$T/up.jsonl" | tr -d ' ')
  URL=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).url' "$D/guard.ready.json") F=$2 TO=$3 node --input-type=module -e '
const f = BigInt(process.env.F), t = BigInt(process.env.TO);
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: "0x498581ff718922c3f8e6a244956af099b2652b2b", fromBlock: process.env.F, toBlock: process.env.TO }] });
const r = await fetch(process.env.URL, { method: "POST", body });
const j = await r.json();
const g = Number(t) - Number(f) + 1;
process.stdout.write(`true span ${t - f + 1n}, hex length ${process.env.TO.length}, guard span ${g}, HTTP ${r.status} ${j.error ? j.error.message : "FORWARDED"}`);' >"$D/res"
  after=$(wc -l <"$T/up.jsonl" | tr -d ' ')
  kill -TERM "$GP"
  wait "$GP"
  echo "B. $1: $(cat "$D/res"); fake upstream received $((after - before))"
}
h() { node -pe 'process.argv[1].startsWith("-")?"":"0x"+BigInt(process.argv[1]).toString(16)' "$1"; }
P62=$((1 << 62))
bcase "control 1..501" 0x1 0x1f5
bcase "2^53..2^53+500" "$(h 9007199254740992)" "$(h 9007199254741492)"
bcase "2^62..2^62+511" "$(h $P62)" "$(h $((P62 + 511)))"
bcase "reversed 2^62+511..2^62" "$(h $((P62 + 511)))" "$(h $P62)"
BIG=$(node -pe '"0x"+(1n<<1100n).toString(16)')
BIGE=$(node -pe '"0x"+((1n<<1100n)+1000n).toString(16)')
bcase "2^1100..2^1100+1000 (Number=Infinity)" "$BIG" "$BIGE"
echo "B. total forwarded to fake upstream: $(wc -l <"$T/up.jsonl" | tr -d ' ') (part A sent none)"

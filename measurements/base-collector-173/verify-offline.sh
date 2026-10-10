#!/usr/bin/env bash
# Offline checks of the preparation scripts. No node, NATS or Postgres: a local fake node on
# 127.0.0.1 and a docker shim. Needs node >= 20 and the checkout's npm ci + module build.
#   ./verify-offline.sh [--regen]
set -u
cd "$(dirname "$0")"
H=$PWD
FE=${FE:-$(cd ../.. && pwd)}
export FE
T=$(mktemp -d)
FAKE=""
trap '[ -n "$FAKE" ] && kill $FAKE 2>/dev/null; rm -rf "$T"' EXIT
fail=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
expect() { [ "$1" = "$2" ] && ok "$3 (exit $1)" || bad "$3 (exit $1, want $2)"; }

for f in *.mjs; do node --check "$f" || bad "syntax $f"; done
bash -n lib-run.sh && bash -n run-native.sh && bash -n verify-synthetic.sh && ok "syntax"
./verify-synthetic.sh ${1:-} >"$T/syn.out" && ok "verify-synthetic ${1:-}" || { cat "$T/syn.out"; bad verify-synthetic; }

fake() { # scenario -> sets FAKE, HP, WP
  node fake-node.mjs "$1" >"$T/fake.$1" &
  FAKE=$!
  for _ in $(seq 1 50); do [ -s "$T/fake.$1" ] && break; sleep 0.1; done
  HP=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).http' "$T/fake.$1")
  WP=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).ws' "$T/fake.$1")
}
unfake() { kill "$FAKE" 2>/dev/null; wait "$FAKE" 2>/dev/null; FAKE=""; }
export FE173_HEADS_DEADLINE_S=3 FE173_HTTP_GAP_MS=500 BASE_COLLECTOR_NATS_URL=nats://127.0.0.1:1

# Preflight: ACK alone, non-advancing heads and a stale timestamp must all fail.
for sc in fresh:0 stale:1 http-stuck:1 ack-only:1 ws-stuck:1; do
  n=${sc%%:*}
  fake "$n"
  BASE_COLLECTOR_HTTP_URL=http://127.0.0.1:$HP BASE_COLLECTOR_WS_URL=ws://127.0.0.1:$WP node preflight.mjs "$T/pf.$n.json" >"$T/pf.$n.out"
  r=$?
  unfake
  expect "$r" "${sc##*:}" "preflight $n $(cat "$T/pf.$n.out")"
done

# Input planning: refuse unless exactly one bounded input is declared.
export BASE_COLLECTOR_WS_URL=ws://127.0.0.1:2 BASE_COLLECTOR_HTTP_URL=http://127.0.0.1:3
PF=$T/pf.fresh.json
HEAD=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).head' "$PF")
DIGEST=$(node --input-type=module -e "const m=await import('$FE/modules/base-collector/dist/index.js');console.log(m.filterDigest(m.loadSettings(process.env)))")
cp_file() { node -e 'const [f,d,v,ts]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({version:1,filterDigest:d,epoch:1,verifiedBlock:Number(v),trackedSinceBlock:Number(ts),pools:[]}))' "$@"; }
cp_file "$T/cp.good" "$DIGEST" $((HEAD - 100)) $((HEAD - 1000))
cp_file "$T/cp.digest" "0000" $((HEAD - 100)) $((HEAD - 1000))
cp_file "$T/cp.old" "$DIGEST" $((HEAD - 5000)) $((HEAD - 9000))
cp_file "$T/cp.future" "$DIGEST" $((HEAD + 10)) $((HEAD - 1000))
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f));p.http.at(-1).atMs-=600000;require("fs").writeFileSync(process.argv[2],JSON.stringify(p))' "$PF" "$T/pf.old.json"
plan() { # want label pf env...
  local want=$1 label=$2 pf=$3
  shift 3
  env -u FE173_INPUT -u FE173_CHECKPOINT -u FE173_DISCOVERY_BLOCKS "$@" node plan-inputs.mjs --preflight "$pf" --out-env "$T/in.env" --out-budget "$T/budget.json" >"$T/plan.out" 2>&1
  expect "$?" "$want" "plan $label: $(tail -1 "$T/plan.out")"
}
plan 3 "no input declared" "$PF"
plan 0 "discovery 1800" "$PF" FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=1800
grep -qx "BASE_COLLECTOR_START_BLOCK=$((HEAD - 1799))" "$T/in.env" && grep -qx "BASE_COLLECTOR_MAX_BACKFILL_BLOCKS=1900" "$T/in.env" && grep -qx "BASE_COLLECTOR_RPC_MIN_INTERVAL_MS=250" "$T/in.env" && ok "discovery env: START_BLOCK=head-1799, MAX_BACKFILL_BLOCKS=1900, RPC_MIN_INTERVAL_MS=250, initialReplay calls $(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).httpCalls.initialReplay' "$T/budget.json")" || bad "discovery env"
plan 3 "discovery 1801" "$PF" FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=1801
plan 3 "discovery 0" "$PF" FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=0
plan 3 "both inputs" "$PF" FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=100 FE173_CHECKPOINT="$T/cp.good"
plan 0 "checkpoint good" "$PF" FE173_INPUT=checkpoint FE173_CHECKPOINT="$T/cp.good"
grep -q "^BASE_COLLECTOR_START_BLOCK=" "$T/in.env" && bad "checkpoint mode must not set START_BLOCK" || ok "checkpoint env has no START_BLOCK"
plan 3 "checkpoint digest mismatch" "$PF" FE173_INPUT=checkpoint FE173_CHECKPOINT="$T/cp.digest"
plan 3 "checkpoint replay span too long" "$PF" FE173_INPUT=checkpoint FE173_CHECKPOINT="$T/cp.old"
plan 3 "checkpoint above head" "$PF" FE173_INPUT=checkpoint FE173_CHECKPOINT="$T/cp.future"
plan 3 "checkpoint missing" "$PF" FE173_INPUT=checkpoint FE173_CHECKPOINT="$T/none"
plan 3 "preflight not fresh" "$T/pf.stale.json" FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=100
plan 3 "preflight too old" "$T/pf.old.json" FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=100

# Cleanup: only this run's registered PIDs (same start time) and labelled containers.
mkdir -p "$T/shim"
cat >"$T/shim/docker" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$DOCKER_LOG"
case "$1" in
  run) echo "cid-$RUNID" ;;
  inspect) [ "${*: -1}" = "cid-foreign" ] && echo "other-run" || echo "$RUNID" ;;
esac
SH
chmod +x "$T/shim/docker"
(
  export PATH=$T/shim:$PATH DOCKER_LOG=$T/docker.log RUN=$T/run RUNID=fe173-test
  mkdir -p "$RUN"
  . ./lib-run.sh
  fe_start mine "$RUN/mine.out" sleep 300
  sleep 300 & echo $! >"$T/foreign.pid"
  sleep 300 & reused=$!
  printf '%s\t%s\t%s\n' "$reused" reused "Thu Jan  1 00:00:00 1970" >>"$FE173_REG/pids"
  echo "$reused" >"$T/reused.pid"
  fe_start_container "$RUNID-nats" nats:2.10
  printf 'cid-foreign\tother\n' >>"$FE173_REG/containers"
  echo "$(fe_pid mine)" >"$T/mine.pid"
  fe_cleanup 2>/dev/null
)
alive() { kill -0 "$(cat "$T/$1.pid")" 2>/dev/null; }
alive mine && bad "registered pid survived cleanup" || ok "registered pid stopped"
alive foreign && ok "unregistered pid untouched" || bad "unregistered pid killed"
alive reused && ok "pid with different start time untouched" || bad "reused pid killed"
grep -qx "rm -f cid-fe173-test" "$T/docker.log" && ! grep -q "rm -f cid-foreign" "$T/docker.log" && ok "only this run's labelled container removed" || bad "container cleanup"
kill "$(cat "$T/foreign.pid")" "$(cat "$T/reused.pid")" 2>/dev/null
(
  export RUN=$T/run2 RUNID=fe173-trap
  mkdir -p "$RUN"
  . ./lib-run.sh
  trap fe_cleanup EXIT
  fe_start mine "$RUN/mine.out" sleep 300
  fe_pid mine >"$T/trap.pid"
  exit 7
) 2>/dev/null
expect "$?" 7 "EXIT trap keeps the exit code"
alive trap && bad "EXIT trap left the registered pid" || ok "EXIT trap stopped the registered pid"
(
  export RUN=$T/run3 RUNID=fe173-wait
  mkdir -p "$RUN"
  . ./lib-run.sh
  never() { return 1; }
  s=$SECONDS
  fe_wait_until 2 1 never-ready never 2>/dev/null
  echo "$? $((SECONDS - s))" >"$T/wait.out"
)
read -r wr ws <"$T/wait.out"
[ "$wr" = 1 ] && [ "$ws" -le 4 ] && ok "fe_wait_until returns 1 at its deadline (${ws}s)" || bad "fe_wait_until deadline ($wr, ${ws}s)"

# run-native.sh refusals before any dependency or collector starts.
FE173_ROOT=/nonexistent/fe173 ./run-native.sh r1 >/dev/null 2>&1
expect "$?" 2 "run-native refuses a missing FE173_ROOT parent"
mkdir -p "$T/root"
fake fresh
BASE_COLLECTOR_HTTP_URL=http://127.0.0.1:$HP BASE_COLLECTOR_WS_URL=ws://127.0.0.1:$WP FE173_ROOT=$T/root/fe173 FE173_DEPS=external \
  BASE_COLLECTOR_DATABASE_URL=postgres://x@127.0.0.1:1/x env -u FE173_INPUT ./run-native.sh r1 >"$T/rn.out" 2>&1
r=$?
unfake
expect "$r" 3 "run-native refuses without a declared input (after a fresh preflight)"
ls "$T"/root/fe173/*/preflight.json >/dev/null 2>&1 && ! ls "$T"/root/fe173/*/nats.jsonl >/dev/null 2>&1 && ok "refused run wrote preflight.json only; no captures/collector started" || bad "refused run artifacts"
fake stale
BASE_COLLECTOR_HTTP_URL=http://127.0.0.1:$HP BASE_COLLECTOR_WS_URL=ws://127.0.0.1:$WP FE173_ROOT=$T/root/fe173 FE173_DEPS=external \
  BASE_COLLECTOR_DATABASE_URL=postgres://x@127.0.0.1:1/x FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=100 ./run-native.sh r1 >"$T/rn2.out" 2>&1
r=$?
unfake
expect "$r" 5 "run-native stops on a stale node"
exit $fail

#!/usr/bin/env bash
# Offline checks of rpc-guard.mjs and guard-run.sh against fake-upstream.mjs on 127.0.0.1.
# No node, Docker, NATS or Postgres. Test files go under an explicit mktemp template in
# FE173_TEST_ROOT (default $TMPDIR, else /tmp); macOS mktemp honours an explicit template.
#   FE173_TEST_ROOT=/abs/dir ./verify-guard.sh
set -u
cd "$(dirname "$0")"
H=$PWD
ROOT=${FE173_TEST_ROOT:-${TMPDIR:-/tmp}}
ROOT=${ROOT%/}
case "$ROOT" in /*) ;; *) echo "FE173_TEST_ROOT must be absolute" >&2; exit 2 ;; esac
T=$(mktemp -d "$ROOT/fe173-guard.XXXXXX") || exit 2
PIDS=""
trap 'for p in $PIDS; do kill $p 2>/dev/null; done; rm -rf "$T"' EXIT
fail=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
expect() { [ "$1" = "$2" ] && ok "$3 ($1)" || bad "$3 (got $1, want $2)"; }
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=new Function("j","return "+process.argv[2])(j);console.log(typeof v==="string"?v:JSON.stringify(v))' "$1" "$2"; }

case "$T" in "$ROOT"/fe173-guard.*) ok "test dir under $ROOT" ;; *) bad "test dir $T not under $ROOT" ;; esac
for f in rpc-guard.mjs fake-upstream.mjs; do node --check "$f" || bad "syntax $f"; done
bash -n guard-run.sh && ok "syntax"

cat >"$T/client.mjs" <<'JS'
const url = process.env.FE173_GUARD_URL;
const [mode, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 1);
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const rq = (method, params, id = 1, extra = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params, ...extra });
const logs = (f) => rq("eth_getLogs", [f]);
const post = async (body, method = "POST") => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : body });
    const txt = await r.text();
    let reason = null;
    try { reason = JSON.parse(txt).error?.message?.replace(/^rpc-guard refused: /, "") ?? null; } catch {}
    return { status: r.status, ms: Date.now() - t0, reason };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, reason: String(e) };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = [];
if (mode === "seq" || mode === "seqsleep") for (let i = 1; i <= n; i++) res.push(await post(rq("eth_blockNumber", [], i)));
if (mode === "conc") res.push(...(await Promise.all(Array.from({ length: n }, (_, i) => post(rq("eth_blockNumber", [], i + 1))))));
if (mode === "accept") {
  res.push(await post(rq("eth_blockNumber", [])));
  res.push(await post(rq("eth_getBlockByNumber", ["latest", false])));
  res.push(await post(logs({ address: [PM], topics: [[INIT]], fromBlock: "0x1", toBlock: "0x1f4" })));
}
if (mode === "invalid") {
  const cases = [
    [null, "GET"],
    ["{"],
    [`[${rq("eth_blockNumber", [])}]`],
    ['"x"'],
    [rq("eth_blockNumber", [], 1, { extra: 1 })],
    [rq("eth_blockNumber", [], 1, { jsonrpc: "1.0" })],
    [rq("eth_blockNumber", [], null)],
    [JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [] })],
    [rq("eth_sendRawTransaction", ["0x00"])],
    [rq("eth_call", [{ to: PM, data: "0x" }, "latest"])],
    [rq("debug_traceTransaction", ["0x00"])],
    [rq("eth_subscribe", ["logs", {}])],
    [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: {} })],
    [rq("eth_blockNumber", [1])],
    [rq("eth_getBlockByNumber", ["latest", true])],
    [logs({ fromBlock: "0x1", toBlock: "0x2" })],
    [logs({ address: PM, fromBlock: "0x1", toBlock: "latest" })],
    [logs({ address: PM, fromBlock: "0x1", toBlock: "0x1f5" })],
    [logs({ address: PM, fromBlock: "0x2", toBlock: "0x1" })],
    [logs({ address: PM, blockHash: `0x${"0".repeat(64)}` })],
    [logs({ address: PM, topics: ["0x12"], fromBlock: "0x1", toBlock: "0x2" })],
    ["x".repeat(70000)],
    [""],
    [rq("eth_blockNumber", [])],
  ];
  for (const [body, method] of cases) res.push(await post(body, method));
}
if (mode === "seqsleep" || mode === "sleep") await sleep(60000);
const envOk = process.env.BASE_COLLECTOR_HTTP_URL === url && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url ?? "");
process.stdout.write(`${JSON.stringify({ envOk, res })}\n`);
JS

# Evidence check: guard.jsonl monotonic and consistent with its summary and the fake upstream's own log.
cat >"$T/evcheck.mjs" <<'JS'
import fs from "node:fs";
const [gl, sum, ul] = process.argv.slice(2);
const L = fs.readFileSync(gl, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const S = JSON.parse(fs.readFileSync(sum, "utf8"));
const U = fs.readFileSync(ul, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fails = [];
for (let i = 1; i < L.length; i++) if (BigInt(L[i].hrNs) < BigInt(L[i - 1].hrNs)) fails.push(`hrNs decreases at line ${i + 1}`);
const recv = L.filter((x) => x.ev === "recv").map((x) => x.seq);
if (recv.some((s, i) => s !== i + 1)) fails.push("recv seq not 1..k");
const idx = (ev, seq) => L.findIndex((x) => x.ev === ev && x.seq === seq);
const fw = L.filter((x) => x.ev === "forward");
const ad = L.filter((x) => x.ev === "admit");
for (const f of fw) if (!(idx("recv", f.seq) < idx("admit", f.seq) && idx("admit", f.seq) < L.indexOf(f))) fails.push(`forward seq ${f.seq} not after recv+admit`);
if (fw.length !== S.forwarded) fails.push(`forward lines ${fw.length} != summary ${S.forwarded}`);
if (ad.length !== S.admitted || S.admitted > S.cap) fails.push(`admitted ${ad.length}/${S.admitted} cap ${S.cap}`);
if (recv.length !== S.received) fails.push(`recv ${recv.length} != summary ${S.received}`);
if (U.length !== S.forwarded) fails.push(`upstream received ${U.length} != forwarded ${S.forwarded}`);
let minGapMs = null;
for (let i = 1; i < fw.length; i++) {
  const g = Number(BigInt(fw[i].hrNs) - BigInt(fw[i - 1].hrNs)) / 1e6;
  minGapMs = minGapMs === null ? g : Math.min(minGapMs, g);
}
if (minGapMs !== null && minGapMs < S.minIntervalMs) fails.push(`forward gap ${minGapMs} ms < ${S.minIntervalMs}`);
const maxInflight = Math.max(0, ...U.map((u) => u.inflight));
if (maxInflight > 1) fails.push(`upstream saw ${maxInflight} concurrent requests`);
console.log(JSON.stringify({ ok: fails.length === 0, fails, forwarded: S.forwarded, upstream: U.length, maxInflight, minGapMs }));
process.exit(fails.length === 0 ? 0 : 1);
JS

ustart() { # name mode -> UPID UPORT ULOG
  ULOG="$T/up.$1.jsonl"
  node fake-upstream.mjs "$ULOG" "$2" >"$T/up.$1.out" &
  UPID=$!
  PIDS="$PIDS $UPID"
  for _ in $(seq 1 50); do [ -s "$T/up.$1.out" ] && break; sleep 0.1; done
  UPORT=$(jget "$T/up.$1.out" j.port)
}
ustop() { kill "$UPID" 2>/dev/null; wait "$UPID" 2>/dev/null; }
upn() { wc -l <"$ULOG" | tr -d ' '; }
gstart() { # name cap min_interval_ms timeout_ms -> GP GURL GR
  GR="$T/g.$1"
  mkdir -p "$GR"
  node rpc-guard.mjs --run-dir "$GR" --upstream "http://127.0.0.1:$UPORT" --cap "$2" --min-interval-ms "$3" \
    --timeout-ms "$4" --max-log-span 500 2>"$GR/err" &
  GP=$!
  PIDS="$PIDS $GP"
  for _ in $(seq 1 50); do [ -s "$GR/guard.ready.json" ] && break; sleep 0.1; done
  GURL=$(jget "$GR/guard.ready.json" j.url)
}
gstop() { kill -TERM "$GP" 2>/dev/null; wait "$GP" 2>/dev/null; }
client() { FE173_GUARD_URL=$GURL BASE_COLLECTOR_HTTP_URL=$GURL node "$T/client.mjs" "$@"; }
statuses() { node -pe 'JSON.parse(process.argv[1]).res.map((r)=>r.status).join(",")' "$1"; }
reasons() { node -pe 'JSON.parse(process.argv[1]).res.map((r)=>r.reason).join(",")' "$1"; }
evc() { node "$T/evcheck.mjs" "$1/guard.jsonl" "$1/guard.summary.json" "$ULOG" >"$1/ev.out" && ok "$2 evidence $(cat "$1/ev.out")" || bad "$2 evidence $(cat "$1/ev.out")"; }
runx() { # cmd...: exit code, or 99 if still running after 3 s (then killed)
  "$@" >/dev/null 2>&1 &
  local p=$! i
  for i in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$p" 2>/dev/null; then kill "$p"; wait "$p" 2>/dev/null; echo 99; else wait "$p"; echo $?; fi
}

# 1. Invalid configuration: exit 2, nothing listens, nothing reaches the upstream.
ustart cfg ok
U="http://127.0.0.1:$UPORT"
n=0
cfg() { # desc args... (run dir added unless the case sets it)
  local d=$1
  shift
  n=$((n + 1))
  mkdir -p "$T/cfg$n"
  expect "$(runx node rpc-guard.mjs --run-dir "$T/cfg$n" "$@")" 2 "config refuses $d"
}
cfg "missing --cap" --upstream "$U" --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "--cap -1" --upstream "$U" --cap -1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "--cap 1.5" --upstream "$U" --cap 1.5 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "--cap x" --upstream "$U" --cap x --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "--cap 100001" --upstream "$U" --cap 100001 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "missing --min-interval-ms" --upstream "$U" --cap 1 --timeout-ms 1000 --max-log-span 500
cfg "--timeout-ms 0" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 0 --max-log-span 500
cfg "--timeout-ms 60001" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 60001 --max-log-span 500
cfg "missing --timeout-ms" --upstream "$U" --cap 1 --min-interval-ms 0 --max-log-span 500
cfg "--max-log-span 0" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 0
cfg "https upstream" --upstream "https://127.0.0.1:$UPORT" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "ftp upstream" --upstream "ftp://127.0.0.1:$UPORT" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "upstream credentials" --upstream "http://u:p@127.0.0.1:$UPORT" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "upstream not a URL" --upstream "127.0.0.1:$UPORT" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "missing --upstream" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500
cfg "write method in --methods" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500 --methods eth_blockNumber,eth_sendRawTransaction
cfg "unknown flag" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500 --listen 0.0.0.0
expect "$(runx node rpc-guard.mjs --run-dir rel/dir --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500)" 2 "config refuses relative --run-dir"
expect "$(runx node rpc-guard.mjs --run-dir "$T/absent" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500)" 2 "config refuses missing --run-dir"
mkdir -p "$T/cfgx" && : >"$T/cfgx/guard.jsonl"
expect "$(runx node rpc-guard.mjs --run-dir "$T/cfgx" --upstream "$U" --cap 1 --min-interval-ms 0 --timeout-ms 1000 --max-log-span 500)" 2 "config refuses existing guard.jsonl"
expect "$(upn)" 0 "config refusals: upstream requests"
ustop

# 2. Allowlisted read-only requests are forwarded unchanged in count.
ustart acc ok
gstart acc 3 0 1000
o=$(client accept)
expect "$(statuses "$o")" "200,200,200" "accept: getBlockNumber/getBlockByNumber(false)/getLogs(address, 500 blocks)"
expect "$([ -e "$GR/guard.STOP" ] && echo yes || echo no)" no "accept: no STOP"
gstop
expect "$(upn)" 3 "accept: upstream requests"
evc "$GR" accept
ustop

# 3. cap 0: the first request is refused and never reaches the upstream.
ustart c0 ok
gstart c0 0 0 1000
o=$(client seq 1)
expect "$(statuses "$o")/$(reasons "$o")" "429/cap_exceeded" "cap0: response"
expect "$(jget "$GR/guard.STOP" j.reason)" cap_exceeded "cap0: STOP reason"
gstop
expect "$(upn)" 0 "cap0: upstream requests"
evc "$GR" cap0
ustop

# 4. cap N: requests N+1.. are refused locally.
ustart cn ok
gstart cn 3 0 1000
o=$(client seq 5)
expect "$(statuses "$o")" "200,200,200,429,429" "cap3 of 5 sequential: statuses"
expect "$(reasons "$o")" ",,,cap_exceeded,stopped" "cap3 of 5 sequential: reasons"
gstop
expect "$(upn)" 3 "cap3: upstream requests"
expect "$(jget "$GR/guard.summary.json" '[j.received,j.admitted,j.forwarded,j.completed].join("/")')" "5/3/3/3" "cap3: received/admitted/forwarded/completed"
evc "$GR" cap3
ustop

# 5. Concurrency: 20 simultaneous requests, cap 5, paced 50 ms, one in flight at a time.
ustart cc ok
gstart cc 5 50 1000
o=$(client conc 20)
expect "$(node -pe 'const r=JSON.parse(process.argv[1]).res;[r.filter(x=>x.status===200).length,r.filter(x=>x.status===429).length].join("/")' "$o")" "5/15" "concurrent 20 cap5: 200/429 counts"
gstop
expect "$(upn)" 5 "concurrent: upstream requests"
evc "$GR" concurrent
ustop

# 6. Finite upstream timeout.
ustart to slow:3000
gstart to 2 0 300
o=$(client seq 1)
expect "$(statuses "$o")" 504 "timeout 300 ms vs 3000 ms upstream: status"
expect "$(node -pe 'JSON.parse(process.argv[1]).res[0].ms < 1500' "$o")" true "timeout: client answered < 1500 ms"
gstop
expect "$(jget "$GR/guard.summary.json" 'j.upstreamErrors.timeout')" 1 "timeout: summary"
expect "$(upn)" 1 "timeout: upstream requests"
evc "$GR" timeout
ustop

# 7. Invalid, disallowed, batch, oversize and malformed requests never reach the upstream.
ustart inv ok
gstart inv 10 0 1000
o=$(client invalid)
expect "$(reasons "$o")" "http_method,malformed_json,batch,not_object,extra_field,jsonrpc_version,bad_id,bad_id,method_not_allowed,method_not_allowed,method_not_allowed,method_not_allowed,bad_params,bad_params,bad_params,logs_address_required,logs_range_not_hex,logs_span_exceeded,logs_range_reversed,logs_bad_field,logs_bad_topics,body_too_large,malformed_json,stopped" "invalid inputs: reasons"
expect "$(statuses "$o" | tr ',' '\n' | sort | uniq -c | tr -s ' ' | tr '\n' ';')" " 23 400; 1 429;" "invalid inputs: statuses"
expect "$(jget "$GR/guard.STOP" j.reason)" http_method "invalid inputs: STOP on first refusal"
gstop
expect "$(upn)" 0 "invalid inputs: upstream requests"
evc "$GR" invalid
ustop

# 8. Shutdown with one request in flight and two queued: finite, queued ones never sent.
ustart sd slow:5000
gstart sd 5 0 20000
client conc 3 >"$T/sd.client" &
CP=$!
for _ in $(seq 1 50); do
  [ "$(grep -c '"ev":"admit"' "$GR/guard.jsonl")" = 3 ] && grep -q '"ev":"forward"' "$GR/guard.jsonl" && break
  sleep 0.1
done
t0=$SECONDS
gstop
dt=$((SECONDS - t0))
expect "$([ "$dt" -le 3 ] && echo yes || echo "no(${dt}s)")" yes "shutdown: guard exited within 3 s"
wait "$CP"
expect "$(statuses "$(cat "$T/sd.client")" | tr ',' '\n' | sort | tr '\n' ' ')" "502 503 503 " "shutdown: client answers (aborted, 2 dropped)"
expect "$(jget "$GR/guard.summary.json" '[j.forwarded,j.dropped,j.upstreamErrors.aborted_shutdown].join("/")')" "1/2/1" "shutdown: forwarded/dropped/aborted"
expect "$(upn)" 1 "shutdown: upstream requests"
evc "$GR" shutdown
ustop

# 9. Controller: signals only what it started; STOP, deadline and normal exit.
ustart ctl ok
UC="http://127.0.0.1:$UPORT"
sleep 300 &
DECOY=$!
PIDS="$PIDS $DECOY"
R="$T/ctl-ok" && mkdir -p "$R"
./guard-run.sh "$R" "$UC" 5 0 1000 500 20 -- node "$T/client.mjs" seq 2 2>"$R/ctl.err"
expect "$?/$(jget "$R/guard-run.json" j.reason)" 0/client_exit "controller: normal client exit"
expect "$(jget "$R/client.out" j.envOk)" true "controller: client env points at the guard on 127.0.0.1"
expect "$(kill -0 "$(cat "$R/guard.pid")" 2>/dev/null && echo alive || echo stopped)" stopped "controller: guard stopped"
expect "$(upn)" 2 "controller normal: upstream requests"
evc "$R" "controller normal"
ustop
ustart ctl2 ok
UC="http://127.0.0.1:$UPORT"
R="$T/ctl-stop" && mkdir -p "$R"
t0=$SECONDS
./guard-run.sh "$R" "$UC" 1 0 1000 500 30 -- node "$T/client.mjs" seqsleep 2 2>"$R/ctl.err"
expect "$?/$(jget "$R/guard-run.json" j.reason)" 10/guard_stop "controller: STOP at cap 1"
expect "$([ $((SECONDS - t0)) -le 15 ] && echo yes || echo no)" yes "controller STOP: finished within 15 s"
expect "$(kill -0 "$(cat "$R/client.pid")" 2>/dev/null && echo alive || echo stopped)" stopped "controller STOP: client stopped"
expect "$(upn)" 1 "controller STOP: upstream requests"
evc "$R" "controller STOP"
ustop
ustart ctl3 ok
UC="http://127.0.0.1:$UPORT"
R="$T/ctl-dl" && mkdir -p "$R"
./guard-run.sh "$R" "$UC" 5 0 1000 500 2 -- node "$T/client.mjs" sleep 2>"$R/ctl.err"
expect "$?/$(jget "$R/guard-run.json" j.reason)" 11/deadline "controller: deadline"
expect "$(kill -0 "$(cat "$R/client.pid")" 2>/dev/null && echo alive || echo stopped)" stopped "controller deadline: client stopped"
expect "$(upn)" 0 "controller deadline: upstream requests"
expect "$(kill -0 "$DECOY" 2>/dev/null && echo alive || echo killed)" alive "controller: unregistered decoy process untouched"
mkdir -p "$T/ctl-u" && : >"$T/ctl-u/guard.jsonl"
expect "$(runx ./guard-run.sh rel/dir "$UC" 1 0 1000 500 5 -- true)" 2 "controller usage: relative run dir"
expect "$(runx ./guard-run.sh "$T/ctl-u" "$UC" 1 0 1000 500 5 -- true)" 2 "controller usage: existing guard.jsonl"
expect "$(runx ./guard-run.sh "$T" "$UC" 1 0 1000 500 0 -- true)" 2 "controller usage: deadline 0"
expect "$(runx ./guard-run.sh "$T" "$UC" 1 0 1000 500 5 true)" 2 "controller usage: missing --"
ustop
kill "$DECOY" 2>/dev/null

[ "$fail" = 0 ] && echo "verify-guard: all checks passed" || echo "verify-guard: FAILURES"
exit "$fail"

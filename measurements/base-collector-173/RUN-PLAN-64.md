# Native run integration plan at 64db8f6 (read-only plan; nothing here has run against a real node)

Scope: one finite #173 measurement run (r1, r2 or r3) with every HTTP JSON-RPC call bound to
`rpc-guard.mjs`. No file outside this document changes. Codex decides whether and when to execute.

## 1. Metadata Codex must supply (not inferred here)

| Field | Use |
| --- | --- |
| checkout head (`64db8f6` or a reviewed child) and `npm ci` + module build from it | `FE`, `dist/main.js` |
| node version, host name, boot id | recorded with the run (same-host clock limit) |
| real HTTP URL | guard `UPSTREAM` only; never exported to the run |
| real WS URL | `BASE_COLLECTOR_WS_URL` (direct, unguarded) |
| `FE173_ROOT` (Thor: existing authorized staging dir; Mac default T7 path) and a separate absolute guard dir `G` | run and guard evidence |
| input: `FE173_INPUT=checkpoint` + `FE173_CHECKPOINT`, or `FE173_INPUT=discovery` + `FE173_DISCOVERY_BLOCKS` (1–1800) | `plan-inputs.mjs` |
| mode r1/r2/r3, `FE173_WARMUP_S`/`WINDOW_S`/`TEARDOWN_S` (defaults 120/1800/120) | measurement window |
| `FE173_DEPS` docker or external (+ `BASE_COLLECTOR_NATS_URL`/`DATABASE_URL`, ports) | scratch dependencies |
| guard `CAP`, `MIN_INTERVAL_MS`, `TIMEOUT_MS`, `MAX_LOG_SPAN`, `DEADLINE_S` | section 3 |
| the authorization record for this run | — |

## 2. Command (no edits to run-native.sh)

```sh
mkdir "$G"   # absolute, empty, outside $FE173_ROOT/<RUNID>
BASE_COLLECTOR_WS_URL=<ws url> FE173_ROOT=<root> FE173_INPUT=... \
  ./guard-run.sh "$G" <http url> <CAP> 250 14000 500 <DEADLINE_S> -- ./run-native.sh <r1|r2|r3>
```

`guard-run.sh` exports `BASE_COLLECTOR_HTTP_URL=http://127.0.0.1:<guard port>` to `run-native.sh`, which
writes it into `$RUN/base-collector.env` (line 58) and sources it, so preflight, `collect` (both starts
in r2/r3) and `verify-persist` all use the guard. The real HTTP URL appears only in
`$G/guard.ready.json` and `$G/guard.jsonl`.

## 3. Declared budget (guard enforces; values for Codex to confirm)

Pinned: pacing 250 ms (= collector), guard timeout 14000 ms (< collector `rpcTimeoutMs` 15000),
`MAX_LOG_SPAN` 500 (= `backfillChunkBlocks`; `verify-persist` also uses 500-block chunks).

| Mode | Nominal calls | Suggested CAP | Suggested DEADLINE_S |
| --- | --- | --- | --- |
| r1 | preflight 2 + initial replay ≤ 9 + persister `start` recover 2 = ≤ 13 | 20 | 3000 |
| r2 | r1 + restart `start` recover 2 + ≤ 4 gap recovers × 2 + `verify-persist` 4 = ≤ 27 | 40 | 3300 |
| r3 | r1 + one reconnect replay ≤ 9 (≈ 3 for a 30 s outage) = ≤ 22 | 30 | 3300 |

Deadline = preflight + deps 90 + reconcile 300 + warmup+window+teardown + 180 (+ verify 300) + margin.

## 4. Same filters, one clock

- `collect`, `measure` (direct WS) and `capture-direct.mjs` build filters with the same dist
  `buildFilters(cfg)` from the same `$RUN/base-collector.env`: PoolManager
  `0x498581ff…2b2b` topics `[[Initialize, Swap]]` and the six factory addresses (no topics). Default
  digest `8b5e28aa…46ca`. `check-report.mjs --env` rebuilds them and rejects any lowercased mismatch.
- T0/T1 = `measure` marks `window_start`/`window_end` (`process.hrtime.bigint`); captures and
  `guard.jsonl` use the same host clock, so guard calls can be placed on the measurement timeline.
  Limit: same-host binding is procedural (self-reported hostnames; `measure.json` has no host).

## 5. Coverage and exclusions (unchanged from #173)

Published: every PoolManager `Initialize`; `Swap` only for tracked pools; every log from the six
factories (decoded to `topic0`); `removed.<kind>`; live vs `.backfill` subjects. Excluded or degraded:
Swaps of untracked pools (`untrackedSwaps` only), other PoolManager events (not subscribed), pre-reconcile
Swap buffer overflow (> 20000), stale live logs (`.backfill` `stale`). Factory and reorg removals will
usually be `not_observed`. A7 G1 and malformed-status limits of #173 remain.

## 6. Calls that bypass the guard

| Call | Process | Bound |
| --- | --- | --- |
| WS `eth_subscribe newHeads` | preflight | 1 connection, deadline |
| WS 2× logs + `newHeads` | `collect` | reconnects unlimited (backoff resets before reconcile) |
| WS 2× logs + `newHeads` | `measure` | 1 connection, no reconnect |
| WS 2× logs | `capture-direct.mjs` | 1 connection, no reconnect |
| NATS / Postgres | all | loopback scratch only |
| Docker image pull | `docker run` | only if `nats:2.10`/`postgres:16` absent; pre-pull or use external |
| anything started outside `guard-run.sh` | — | not covered |

WS stop rule (not enforced by the guard): Codex stops the run if `collect.log` shows more than the
mode's planned `websocket disconnected` count (r1/r2 0, r3 1) or any `connect/reconcile failed`.

## 7. Proof before executing (no node)

1. `sha256sum -c MANIFEST.sha256`; `FE173_TEST_ROOT=<abs> ./verify-guard.sh`; `./verify-offline.sh --regen`.
2. Static: in the built dist the only HTTP clients are `new PacedHttpRpc(cfg.httpUrl, …)` (`collect`,
   `verify-persist`); in this directory `preflight.mjs` is the only `fetch` (to `BASE_COLLECTOR_HTTP_URL`).
   `grep -rn "PacedHttpRpc(\|fetch(" ../../modules/base-collector/dist *.mjs`.
3. Offline binding drill against `fake-node.mjs fresh` (done here, Linux, 64db8f6, evidence below):
   - `guard-run.sh G-ok <fake http> 4 250 14000 500 60 -- ./run-native.sh r1` with no input declared:
     preflight fresh through the guard (2 `forward` lines, both `eth_getBlockByNumber`), then
     `plan-inputs` refuses; guard-run exit 3 (`client_exit`), guard summary received 2 / forwarded 2.
   - Same with `CAP=1`: second preflight call refused locally (`cap_exceeded`), preflight not fresh
     (run-native 5), guard-run exit 10 (`guard_stop`), forwarded 1. No processes or containers started.
4. During the real run, before reconcile: `$RUN/base-collector.env` must show
   `BASE_COLLECTOR_HTTP_URL=http://127.0.0.1:` and `$G/guard.jsonl` must show the 2 preflight forwards.

## 8. Anticipated exit statuses

guard-run: 10 `guard.STOP` (takes precedence over the client's code), 11 deadline, 12 guard not ready
or died, 2 usage; otherwise run-native's code: 0 checker NO_REJECT_FOUND, 1 checker REJECT, 2 usage,
3 input refused, 5 not fresh, 6 dependencies, 7 reconcile deadline, 8 measure failed, 9
verify-persist failed. External TERM/INT to guard-run (fix2): guard stopped first, client TERM + GRACE_S,
registry verified, `guard-run.json` written, exit 143/130 — or 13/14 when owned survivors are found or
ownership is unverifiable.

## 9. Stop and cleanup evidence

- On STOP/deadline guard-run TERMs `run-native.sh`; its EXIT trap stops only PIDs in
  `$RUN/registry/pids` (lstart-checked) and containers labelled `fe173.run=<RUNID>`, then guard-run
  stops the guard (summary written).
- Limit: `fe_stop_pid` KILLs `run-native.sh` 10 s after TERM. If run-native's own cleanup is slower
  (it waits up to 10 s per child, and handles TERM only after its current `sleep` ≤ 5 s), registered
  children can survive. Afterwards Codex checks every `$RUN/registry/pids` entry with `ps -o lstart=`
  and `docker ps --filter label=fe173.run=<RUNID>`; any survivor is stopped by PID+lstart/label only.
- Keep, unedited: `$G/{guard.jsonl,guard.ready.json,guard.STOP,guard.summary.json,guard-run.json,registry}`
  and all of `$RUN` (`preflight.json`, `budget.json`, `base-collector.env`, `nats.jsonl` including
  `.backfill`/recover/`ctl` subjects, `direct.jsonl`, `measure.json`, `check.json`, `*.log`,
  `verify-persist.json`, `dist.sha256`, `artifacts.sha256`), then hash `$G` likewise.

No latency, admission or T7-containment claim (bare `mktemp` in the older verify scripts and Docker
storage stay outside T7).

## Correction (first guard round, supersedes sections 2 and 9 where they differ)

Command: `./guard-run.sh "$G" <http url> <CAP> 250 14000 500 <DEADLINE_S> 120 "$FE173_ROOT/fe173-*-<mode>-{pid}/registry" -- ./run-native.sh <mode>`.
`FE173_ROOT` must be set explicitly. Order: the guard stops first, then the client gets 120 s of grace,
then its registry is checked (owned survivors → exit 13, ownership not established → exit 14). The
10 s outer KILL limit from section 9 no longer applies. Controller wall time is at most
`DEADLINE_S + 10 + 120 + 10` s plus a few seconds. See HANDOFF "First guard correction round".

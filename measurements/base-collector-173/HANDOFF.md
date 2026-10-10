# FeedEater #173 measurement preparation (A5 → Codex; reject-only)

Reviewer: A7. A4 has no role in this handoff.

- Candidate under test: PR #173, head `5206f9035ad1c057d78990b294941221e936f895` (frozen). This branch's
  parent is that head. It only adds `measurements/base-collector-173/`, so the collector code is
  byte-identical (`git diff --stat 5206f90 HEAD` lists only this directory).
- Nothing here was run against a node, NATS or Postgres. There is no collector repair, deployment
  file, service, source admission or certification claim.
- `check-report.mjs` is reject-only preparation, not an admission contract. `NO_REJECT_FOUND` means
  none of its checks fired; it never means DAT-SRC-011 passed.

## Files

| file | role |
| --- | --- |
| `check-report.mjs` | reject checklist over `measure.json` + raw NATS capture + raw direct capture, bound to the run's `base-collector.env` (exit 1 = REJECT, 0 = NO_REJECT_FOUND, 2 = usage or unbindable settings) |
| `capture-nats.mjs` | raw capture of `feedeater.base_collector.>` (subject, raw payload, `hrNs`) |
| `capture-direct.mjs` | raw direct node capture with the collector's exact filters/digest (from the same dist + env) |
| `make-synthetic.mjs` | rebuilds `synthetic/` by driving the 5206f90 dist `Measurement` the way `main measure` does |
| `preflight.mjs` | bounded freshness preflight (2 HTTP calls, 1 WS subscription) |
| `plan-inputs.mjs` | refuses unless one bounded input (checkpoint or ≤ 1800-block discovery) is declared; writes the env pins and the call budget |
| `run-native.sh`, `lib-run.sh` | one scratch run (r1/r2/r3) with deadlines and an owned-only cleanup trap |
| `fake-node.mjs`, `verify-offline.sh` | offline tests: fake local node, docker shim, refusals, cleanup ownership, plus `verify-synthetic.sh` |
| `verify-synthetic.sh` | checker output and exit code per synthetic case must equal the committed bytes; `--regen` also rebuilds the fixtures and requires identical bytes |
| `synthetic/<case>/` | `measure.json`, `nats.jsonl`, `direct.jsonl`, `base-collector.env`, `expected-check.json`, `expected-exit` |
| `MANIFEST.sha256` | sha256 of every other file in this directory |

## One comparable clock; matching filters

- `measure` stamps the direct and NATS sides and the phase marks with `process.hrtime.bigint()`.
  Both capture scripts stamp every line (`hrNs`) with the same call. Node takes it from libuv's host
  monotonic clock (`CLOCK_MONOTONIC` on Linux, `mach_absolute_time` on macOS), so the values are
  comparable across processes on one host.
- On Linux, A5 checked that `hrtime/1e9` matches `/proc/uptime` in separate processes. It wasn't
  checked on macOS here, so the checker enforces it at run time instead. Each capture's start/stop
  meta `hrNs` must bracket `warmup_start`..`teardown_end`, and both captures must report the same
  host. If not, the run is rejected and `clock.comparable` is false.
- Limits of that host binding (also printed as `clock.limits`):
  - capture hosts are the self-reported `os.hostname()` in each capture's meta line, and are not
    verified independently;
  - `measure.json` records no host, so measure being on the capture host is procedural
    (`run-native.sh` runs everything on one host) and is not checked;
  - `hrtime` is only comparable within one boot of one host.
- Run all three processes on one host: native Mac, or all on Thor.
- Filters: `collect`, `measure` and `capture-direct` all call `buildFilters(cfg)` from the same dist
  and environment file. The checker rebuilds the filters and digest from `--env` with the same dist.
  It rejects any of these:
  - a report digest that differs from the env's;
  - direct-capture filters that differ from the env's (addresses and topics compared lowercased);
  - a direct-capture `filterDigest` that differs from the report's;
  - any in-window status, raw or reported, with a different digest.
- Default digest (no `EXTRA_HOOKS`/`EXTRA_POOL_IDS`/`SUITES_JSON`/`POOL_MANAGER`):
  `8b5e28aa1ca300ea4b70d2f338c79a0800196823bc0dcac224a36ab7a36146ca`.
- The filters are PoolManager `0x498581ff…2b2b` Initialize/Swap, plus the six o1 factories, all
  topics (`src/constants.ts`; A3 #336 pending). There is no all-address filter.
- Volume and limits (defaults): `MAX_TRACKED_POOLS` 100000, `POOL_IDLE_BLOCKS` 0, `MAX_PENDING_SWAPS` 20000,
  `MAX_BACKFILL_BLOCKS` 43200, `BACKFILL_CHUNK_BLOCKS` 500, `MAX_RECOVER_BLOCKS` 2000,
  `RPC_MIN_INTERVAL_MS` 100, `RATE_ALERT_PER_SEC` 2000 (alert only), `PERSIST_MAX_QUEUE` 200000,
  `STATUS_INTERVAL_MS` 5000, `PERSIST_HEARTBEAT_MS` 5000, `PERSISTER_TIMEOUT_MS` 15000.
- Node→collector traffic is every v4 Initialize/Swap on Base. Codex's earlier 30 s probe saw 12.93 events/s.
- `run-native.sh` overrides some of these defaults for the scratch run (see Input prerequisite).

## Offline verification (no node, no NATS)

```sh
git clone https://github.com/jhacksman/FeedEater.git fe && cd fe
git checkout --detach <this commit>
git diff --stat 5206f9035ad1c057d78990b294941221e936f895 HEAD     # only measurements/base-collector-173/
cd measurements/base-collector-173
sha256sum -c MANIFEST.sha256              # macOS: shasum -a 256 -c MANIFEST.sha256
./verify-synthetic.sh                     # node >= 20 only
cd ../.. && npm ci --ignore-scripts --no-audit --no-fund && npm run -w @feedeater/module-base-collector build
measurements/base-collector-173/verify-offline.sh --regen     # synthetic regen + preflight/plan/cleanup/refusal tests (no node)
```

Synthetic cases (semantic probes only, not latency evidence). The #173 report gives
`sourceValidationWindow: true` and `dat011.pass: true` in every case.

| case | content | checker |
| --- | --- | --- |
| `control` | dense 5 s status/heartbeat; Initialize, tracked Swap A→R, factory log, one untracked Swap | `NO_REJECT_FOUND` (exit 0) |
| `checksummed-filter` | control with EIP-55 checksummed PoolManager in the capture filters and logs | `NO_REJECT_FOUND` (exit 0): addresses are normalized |
| `g1` | A7 G1 pattern over a 5 min window: good statuses at 0 s and 10 s, one heartbeat at 10 s | `REJECT`: `report_/raw_status_stale_or_silent(maxGapMs=290000)`, `report_/raw_heartbeat_stale_or_silent` |
| `malformed-status` | control plus one `connected:false` status without `persistence`. `recordBus` throws, so `main` drops it and the report omits it | `REJECT`: `raw_status_malformed_in_window(n=1)` |
| `ws-loss` | direct socket closes 150 s into the window; `measure` only marks it and its head stops | `REJECT`: `measure_direct_ws_lost_before_teardown_end`, `measure_direct_heads_stale`, `direct_capture_ws_closed_or_error_before_stop` |
| `factory-reorg-not-observed` | clean dense window with no factory log and no removal | `REJECT`: `not_observed:factory`, `not_observed:reorg_removal` |
| `extra-direct-initialize` | control plus one in-window direct Initialize that `measure` never saw (A7 at 3026725: NO_REJECT_FOUND) | `REJECT`: `identity_direct_not_on_live:initialize(n=1)`, `report_vs_direct_transitions:initialize(direct=2,report=1)` |
| `direct-ws-closed-before-warmup` | direct capture closes 1 ns after its start, before warmup, with no ACKs and no logs (A7 at 3026725: NO_REJECT_FOUND) | `REJECT`: `direct_capture_ws_closed_or_error_before_stop`, `direct_capture_filter_ack_missing(id=1,2)`, identity/transition mismatches |
| `direct-filter-ack-missing` | only the PoolManager subscription is acknowledged | `REJECT`: `direct_capture_filter_ack_missing(id=2)` |

Interval binding (`verify-synthetic.sh`, on `g1`). Each of these exits 2, with no verdict:
- `--env` missing or unreadable;
- `--status-interval-ms x --heartbeat-ms x`;
- a flag given with no value;
- a claimed `1000000` against the recorded `5000`, which at 3026725 turned `g1` into `NO_REJECT_FOUND`;
- an invalid interval in the env file itself.

## Native/Thor run (Codex, once fresh read-only node connectivity exists)

Native Mac: every checkout, output and temp file lives under
`/Volumes/T7SHIELD/PROJECT_AROMER/aromer-scratch/`. `run-native.sh` defaults `FE173_ROOT` there,
sets `TMPDIR` and the npm cache inside the run directory, and refuses if the parent directory is
missing. It never creates the T7 root.

Thor: the same commands run on Thor itself, with `FE173_ROOT` set explicitly to the existing
authorized CI/capture staging directory, which Codex names. The script refuses a missing
`FE173_ROOT` off macOS. Results are copied back explicitly; nothing is inferred about Thor paths.

```sh
S=/Volumes/T7SHIELD/PROJECT_AROMER/aromer-scratch            # Thor: S=<existing authorized staging dir>
git clone https://github.com/jhacksman/FeedEater.git "$S/fe173-src" && cd "$S/fe173-src"
git checkout --detach <this commit>
TMPDIR="$S/tmp" npm_config_cache="$S/tmp/npm-cache" npm ci --ignore-scripts --no-audit --no-fund
npm run -w @feedeater/module-base-collector build
cd measurements/base-collector-173 && sha256sum -c MANIFEST.sha256 && ./verify-offline.sh --regen
export BASE_COLLECTOR_WS_URL=ws://10.9.11.68:8546 BASE_COLLECTOR_HTTP_URL=http://10.9.11.68:8545
# Declare exactly one input (prerequisite; see below), e.g.
export FE173_INPUT=checkpoint FE173_CHECKPOINT=<Codex-provided checkpoint.json>
./run-native.sh r1          # then r2, r3; each makes a fresh $FE173_ROOT/fe173-<utc>-<mode>-<pid>/
# Thor: FE173_ROOT=<staging dir>/fe173-measure ./run-native.sh r1
```

### Input prerequisite (must be declared before the run; no default)

`plan-inputs.mjs` refuses (exit 3) unless exactly one of these is set. It makes no node calls; the
head comes from the preflight.

- `FE173_INPUT=checkpoint`, `FE173_CHECKPOINT=<file>`: a Codex-provided collector checkpoint.
  - It must have `version` 1, `filterDigest` equal to this run's digest, and `verifiedBlock` ≤ head.
  - The replay span `head − max(verifiedBlock+1−64, trackedSinceBlock) + 1` must be ≤ 1800 blocks.
  - Its `pools` become the tracked o1 set. This is the only way to cover pools launched before
    the run.
- `FE173_INPUT=discovery`, `FE173_DISCOVERY_BLOCKS=N` with 1 ≤ N ≤ 1800 (about 1 h):
  - `START_BLOCK = head − N + 1`. Only o1 pools whose Initialize falls in those N blocks are tracked.
  - Older pools stay untracked, so expect `no_target_swaps`/`no_tracked_pools` rejections unless a
    launch happens in range.
  - Wider discovery, such as the earlier `HEAD-43200`, about 174 calls, is not prepared and needs a
    new reviewed commit.

Both modes pin these settings:

| setting | value |
| --- | --- |
| `RPC_MIN_INTERVAL_MS` | 250 |
| `BACKFILL_CHUNK_BLOCKS` | 500 |
| `MAX_BACKFILL_BLOCKS` | 1900: the 1800 cap plus 100 for head drift. It also caps every reconnect replay; truncation is reported as incomplete coverage. |
| `MAX_RECOVER_BLOCKS` | 500 |
| `PERSIST_START_BLOCK` | head |

HTTP call budget (`budget.json` per run; two filters per chunk):

| step | calls |
| --- | --- |
| preflight | 2 |
| initial replay | 1 + 2·⌈span/500⌉, at most 9 |
| each collector reconnect | at most 9 |
| each persister recover request | at most 2 |
| per-head `publish_retry` | at most 2 |
| R2 `verify-persist` over a 30 min window | about 8 |

Stop the run if `collect.log` shows repeated reconnects, repeated `publish_retry` or `reconnect backfill truncated`.

### What `run-native.sh` does (exit codes in its header)

1. *Freshness preflight* (`preflight.mjs`: 2 HTTP calls, 1 WS subscription). The run stops with
   exit 5 unless all of these hold:
   - HTTP `eth_getBlockByNumber("latest")` advances between two calls about 4 s apart;
   - the latest block timestamp is within 30 s of the host clock (NTP required);
   - after the subscription ACK, two WS `newHeads` arrive with strictly increasing number and
     timestamp within 20 s.

   An ACK or `eth_blockNumber` alone fails.
2. *Input plan* (`plan-inputs.mjs`). The preflight must be ≤ 120 s old; otherwise exit 3.
3. *Scratch dependencies* (`FE173_DEPS=docker`): `nats:2.10` and `postgres:16`.
   - They are bound to `127.0.0.1:14222/15432` and named `<RUNID>-nats/-pg`.
   - They are labelled `fe173.run=<RUNID>`, have a 90 s ready deadline, and are removed only by
     this run. Exit 6 if not ready.
   - `FE173_DEPS=external` uses the given NATS and Postgres URLs and starts no containers.
4. *Processes:* the captures start first, then `persist` and `collect`. The script waits for a
   `reconciled:true` status plus a non-empty `state/checkpoint.json`.
   - The deadline is `FE173_RECONCILE_DEADLINE_S`, 300 s.
   - The wait aborts at once if any owned process exits. Exit 7.
5. *Measure:* `--warmup-s 120 --window-s 1800 --teardown-s 120 --pools-from-checkpoint`.
   - The deadline is warmup+window+teardown+180 s. Exit 8.
   - R2 stops the persister at window +300 s for 60 s, then runs `verify-persist` over the scored
     window, with a 300 s deadline. Exit 9.
   - R3 restarts the collector at window +300 s, after 30 s down.
6. *Teardown:* stops the collector, persister and captures, in that order, so the captures bracket
   `teardown_end`. Then it runs `check-report.mjs` and writes `dist.sha256` and `artifacts.sha256`.
   The exit code is the checker's.
7. *Cleanup trap* (EXIT/INT/TERM, `lib-run.sh`):
   - It signals only PIDs this run registered, and only while their `ps lstart` still matches.
   - It removes only containers whose `fe173.run` label is this RUNID.
   - Unrelated processes, reused PIDs and other containers are never touched.

Artifacts in each run directory:
- `preflight.json`, `budget.json`, `inputs.env`, `base-collector.env`;
- `nats.jsonl`, `direct.jsonl`, `measure.json`, `measure.summary.json`, `check.json`;
- `verify-persist.json` (R2 only);
- `*.log`, `registry/`, `dist.sha256`, `artifacts.sha256`.

R1 is the only live-acceptance candidate. R2 is non-validating by design (`persistence_missing`).
R3 must show `backfillOnLiveSubjects` and `lateLiveAfterBackfill` at 0.

## What the checker rejects

- *Phases and clock:* phase marks missing or out of order; report window ≠ marks; capture not
  bracketing `measure`'s clock; captures from different hosts.
- *Settings:* `--env` is required.
  - Status and heartbeat intervals come from it, using the collector defaults 5000/5000 for keys it
    doesn't set.
  - Missing or invalid values, or `--status-interval-ms`/`--heartbeat-ms` claims that differ from
    them, exit 2.
  - The filters and digest are rebuilt from it (see above).
- *Direct socket:*
  - `measure` `direct_ws_closed` before `teardown_end`;
  - direct head not observed or stale (< 90% of window_s / 2 blocks);
  - a direct-capture `direct_ws_closed` or `ws_error` at any time before its stop line, or an
    `rpc_error`;
  - a missing subscription ACK for any filter at or before `window_start` (`capture-direct.mjs`
    now records ACKs).
- *Identities, per kind, in the scored block range:* each `blockHash:logIndex` has an ordered
  active/removed sequence, with same-state repeats collapsed.
  - Initialize/factory: direct and live raw sequences must match exactly, and report
    `byKind.<kind>.expected` must equal the direct transition count.
  - Swap: every live identity must be on direct with the same sequence, and report swap `expected`
    must be ≥ the live count. Direct swaps on untracked pools aren't required on live, so tracked-pool
    selection is not checked independently.
  - Rejected too: a direct log outside both filters, and a malformed live record.
- *Status and heartbeat:*
  - an in-window gap above 2 × interval, window edges included, in the report or the raw capture (G1);
  - an in-window status, reported or raw, that is malformed, not `ok`, disconnected, has incomplete
    coverage, or carries a different digest;
  - status or heartbeat counts that differ between raw and report inside [window +1 s, end −1 s].
- *Report:* `scope.sourceValidationWindow` false; `dat011.pass` false; negative latency, or latency
  n ≠ delivered; extra, late or contaminated live records.
- *Kinds:* `not_observed:<initialize|swap_tracked_o1|factory|reorg_removal>`, also listed under
  `notObserved`. Factory logs and reorg removals are rare in a 30 min window, so expect them to be
  marked not observed.

## Known invalid claims at 5206f90 (printed as `notCertifiableAt5206f90`)

- A7 G1: there is no status cadence in the report's scope.
- A malformed status is dropped silently by `measure`.
- Direct WS loss is not in the report's scope.
- Factory and reorg coverage are not in the report's scope.

The checker only rejects on these. It does not repair them. The owner decision on a further
collector/harness repair remains escalated.

## HTTP request guard (preparation only; not wired into `run-native.sh`)

The collector's own HTTP calls are not fully observable (no call counter in status or logs; a
successful `publish_retry` logs nothing; a failed reconcile does not say how many calls it made), so
any budget computed from collector artifacts is advisory. `rpc-guard.mjs` makes a request budget
deterministic by sitting between the clients and the node:

- Listens on `127.0.0.1` only. Upstream is one plain `http://` URL (no credentials, query, fragment).
- Allowlist, read-only: `eth_blockNumber` (no params), `eth_getBlockByNumber(<latest|hex>, false)`,
  `eth_getLogs` with one filter that has an explicit non-empty `address`, valid `topics`, hex
  `fromBlock`/`toBlock`, `toBlock >= fromBlock` and span <= `--max-log-span`. `--methods` may only
  narrow this list.
- Refused locally, never forwarded: non-POST, body > 64 KiB, malformed or empty JSON, batch arrays,
  non-objects, extra fields, `jsonrpc != "2.0"`, null/missing id, any other method, bad params, and
  every request after `--cap` admissions.
- Every request is numbered and logged (`recv`) on arrival; admission (`admit`) is decided
  synchronously before anything is sent, so `admitted <= cap` holds under any concurrency.
- Admitted requests are sent one at a time, at least `--min-interval-ms` apart, each aborted after
  `--timeout-ms` (<= 60000) with a 504.
- The first refusal writes `guard.STOP` (reason, seq). From then on nothing new is admitted.
- SIGTERM/SIGINT: aborts the in-flight request, drops queued ones unsent, writes
  `guard.summary.json`, exits 0 within 2 s.
- Evidence under the explicit `--run-dir` (absolute, existing; `guard.jsonl` created exclusively):
  `guard.jsonl` (monotonic `process.hrtime` lines: start, recv, admit, forward, response,
  upstream_error, refuse, stop, drop, shutdown, summary), `guard.ready.json`, `guard.STOP`,
  `guard.summary.json` (received, admitted, forwarded, completed, dropped, refused by reason,
  upstream errors by reason).

`guard-run.sh RUN_DIR UPSTREAM CAP MIN_INTERVAL_MS TIMEOUT_MS MAX_LOG_SPAN DEADLINE_S -- CMD...`
starts the guard and one client (with `FE173_GUARD_URL` and `BASE_COLLECTOR_HTTP_URL` set to the
guard), registers both in `RUN_DIR/registry` through `lib-run.sh`, and signals only those two. Exit:
client's code, 10 on `guard.STOP`, 11 at the deadline, 12 if the guard is not ready or dies, 2 on
usage. Outcome in `RUN_DIR/guard-run.json`.

What it does not do: it counts HTTP only (WS connections/subscriptions are not covered); it does not
stop the collector's fast reconcile retry, which keeps failing locally until the controller stops it;
it is not wired into `run-native.sh` (one guard per run with `collect` as the client would need a
controller that also owns `persist`/`measure`/captures; that is Codex's decision).

Offline proof: `FE173_TEST_ROOT=<absolute dir> ./verify-guard.sh` against `fake-upstream.mjs` on
127.0.0.1 (no node, Docker, NATS or Postgres). It uses an explicit `mktemp` template under
`FE173_TEST_ROOT`, which macOS honours. The fake upstream's own log is the forwarded count:
config refusals 0, cap 0 → 0, cap 3 of 5 sequential → 3, 20 concurrent at cap 5 → 5 (one in flight,
gaps >= 50 ms), timeout → 1 (504 in < 1.5 s), 23 invalid inputs → 0, shutdown with 1 in flight and
2 queued → 1 (exit <= 3 s), controller STOP/deadline/normal → 1/0/2, unregistered decoy untouched.
`verify-offline.sh` and `verify-synthetic.sh` still use bare `mktemp -d` (macOS: `/var/folders`).

### First guard correction round (child of 247e9f6)

- Pacing: send starts are spaced on the ns `hrtime` clock (`forward.startNs`), re-checked after every
  timer, so no gap is below `--min-interval-ms`. `verify-guard.sh` checks the gaps in ns.
- Dispatch is a cancellable queue. The first refusal (`guard.STOP`) and SIGTERM both drop every queued
  admitted request at once, with an explicit 503 and a `drop` line. Pacing waits are cancelled, so no
  upstream call happens after STOP except one already in flight. The summary adds
  `reconciled = (admitted == forwarded + dropped && forwarded == completed + upstream errors)` and
  `inflightAtExit`. Consequence: when more requests arrive than the cap, the first over-cap refusal
  also drops the requests already admitted and queued.
- Block quantities: hex ≤ 16 characters and ≤ 2^53−1, compared as BigInt (`quantity_out_of_range`,
  `logs_range_reversed`, `logs_span_exceeded`); this also applies to the `eth_getBlockByNumber` argument.
- `guard-run.sh RUN_DIR UPSTREAM CAP MIN_INTERVAL_MS TIMEOUT_MS MAX_LOG_SPAN DEADLINE_S GRACE_S CLIENT_REGISTRY -- CMD...`
  - Stops the guard first, then sends TERM to the client and waits up to `GRACE_S` (≤ 900), then KILLs it.
  - Then it checks the client's own registry (`CLIENT_REGISTRY`: an absolute glob with `{pid}`, which
    must match exactly one directory). Registered PIDs still running with the recorded `ps lstart`, and
    listed containers whose `fe173.run` label equals that registry's RUNID, are owned survivors. They are
    stopped and the run exits 13, listing them in `guard-run.json`.
  - Exit 14 when ownership can't be established: no match or several, unreadable files, a container
    listed but no docker, or an inspect error other than "No such object".
  - `CLIENT_REGISTRY=none` is refused for `run-native.sh`. Nothing that isn't registered is touched.
- For `run-native.sh`, use `CLIENT_REGISTRY="$FE173_ROOT/fe173-*-<mode>-{pid}/registry"` (RUNID ends in
  `$$` = client PID) with `FE173_ROOT` set explicitly, and `GRACE_S` ≥ 120. Worst-case inner cleanup is
  about 5 s trap latency + 8 × 10.5 s + 2 container removals.

Remaining limits:
- WS traffic is still unguarded.
- Grandchildren a registered child starts without registering them are not covered.
- `ps lstart` has 1 s resolution, so a PID reused within the same second is indistinguishable.
- The guard forces its exit 2 s after SIGTERM (`inflightAtExit` records an unfinished request).
- Checked on Linux only.

## Second (final) guard correction (preparation, parent b1edbfd)

A7's review of the whole b1edbfd head (d99e493) found that an external TERM/INT to `guard-run.sh` exited
143/130 straight through the EXIT trap (`fe_cleanup`). That path skipped the guard-first stop, the
declared grace, `verify_client` and `guard-run.json`.

Changes:
- TERM/INT now only set a flag. The control loop then runs the normal outcome path:
  1. stop the guard (no new admissions; queued requests dropped; summary written);
  2. TERM the client, wait up to GRACE_S, then KILL;
  3. verify the client's registry (PID + `ps lstart`, labelled containers);
  4. write `guard-run.json` (`reason: external_TERM|external_INT`, `externalSignal`);
  5. exit 143/130, or 13 for owned survivors, or 14 when ownership is unverifiable.
- A second signal during cleanup is recorded but does not escalate.
- The nested fixture's `wc -l` comparison is whitespace-normalized, because BSD `wc` pads its output.

Checks: `verify-guard.sh` adds external TERM 3 s after start for prompt, delayed (3 s) and
TERM-ignoring children (grace 5 s, exit 13), plus an INT case, a reused-PID decoy and a foreign
container. The suite was run on Linux; macOS bash 3.2 was not run here.

Limits that still apply:
- WS traffic is outside rpc-guard.
- Unregistered grandchildren are not covered.
- `ps lstart` has 1 s resolution.
- A SIGKILL to guard-run itself cannot be handled.

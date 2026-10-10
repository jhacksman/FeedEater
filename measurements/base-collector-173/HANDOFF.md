# FeedEater #173 measurement preparation (A5 → Codex; reject-only)

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
| `check-report.mjs` | reject checklist over `measure.json` + raw NATS capture + raw direct capture (exit 1 = REJECT, 0 = NO_REJECT_FOUND, 2 = usage) |
| `capture-nats.mjs` | raw capture of `feedeater.base_collector.>` (subject, raw payload, `hrNs`) |
| `capture-direct.mjs` | raw direct node capture with the collector's exact filters/digest (from the same dist + env) |
| `make-synthetic.mjs` | rebuilds `synthetic/` by driving the 5206f90 dist `Measurement` the way `main measure` does |
| `preflight.mjs` | bounded freshness preflight (2 HTTP calls, 1 WS subscription) |
| `plan-inputs.mjs` | refuses unless one bounded input (checkpoint or ≤ 1800-block discovery) is declared; writes the env pins and the call budget |
| `run-native.sh`, `lib-run.sh` | one scratch run (r1/r2/r3) with deadlines and an owned-only cleanup trap |
| `fake-node.mjs`, `verify-offline.sh` | offline tests: fake local node, docker shim, refusals, cleanup ownership, plus `verify-synthetic.sh` |
| `verify-synthetic.sh` | checker output and exit code per synthetic case must equal the committed bytes; `--regen` also rebuilds the fixtures and requires identical bytes |
| `synthetic/<case>/` | `measure.json`, `nats.jsonl`, `direct.jsonl`, `expected-check.json`, `expected-exit` |
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
- Run all three processes on one host: native Mac, or all on Thor.
- Filters: `collect`, `measure` and `capture-direct` all call `buildFilters(cfg)` from the same dist
  and environment file. The checker rejects a direct-capture `filterDigest` that differs from the
  report's, and any in-window status, raw or reported, with a different digest.
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
| `g1` | A7 G1 pattern over a 5 min window: good statuses at 0 s and 10 s, one heartbeat at 10 s | `REJECT`: `report_/raw_status_stale_or_silent(maxGapMs=290000)`, `report_/raw_heartbeat_stale_or_silent` |
| `malformed-status` | control plus one `connected:false` status without `persistence`. `recordBus` throws, so `main` drops it and the report omits it | `REJECT`: `raw_status_malformed_in_window(n=1)` |
| `ws-loss` | direct socket closes 150 s into the window; `measure` only marks it and its head stops | `REJECT`: `measure_direct_ws_lost_before_teardown_end`, `measure_direct_heads_stale`, `direct_capture_ws_closed_before_teardown_end` |
| `factory-reorg-not-observed` | clean dense window with no factory log and no removal | `REJECT`: `not_observed:factory`, `not_observed:reorg_removal` |

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
- *Direct socket:* `measure` `direct_ws_closed` before `teardown_end`; direct head not observed or
  stale (< 90% of window_s / 2 blocks); a direct-capture `direct_ws_closed` or `rpc_error`.
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

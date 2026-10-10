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

## Offline verification (no node, no NATS)

```sh
git clone https://github.com/jhacksman/FeedEater.git fe && cd fe
git checkout --detach <this commit>
git diff --stat 5206f9035ad1c057d78990b294941221e936f895 HEAD     # only measurements/base-collector-173/
cd measurements/base-collector-173
sha256sum -c MANIFEST.sha256              # macOS: shasum -a 256 -c MANIFEST.sha256
./verify-synthetic.sh                     # node >= 20 only
cd ../.. && npm ci --ignore-scripts --no-audit --no-fund && npm run -w @feedeater/module-base-collector build
measurements/base-collector-173/verify-synthetic.sh --regen   # fixtures rebuilt from the 5206f90 dist, byte-identical
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

```sh
export RUN=$HOME/scratch/fe173-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$RUN" && cd "$RUN"
git clone https://github.com/jhacksman/FeedEater.git fe && git -C fe checkout --detach <this commit>
export FE=$RUN/fe H=$FE/measurements/base-collector-173
(cd "$FE" && npm ci --ignore-scripts --no-audit --no-fund && npm run -w @feedeater/module-base-collector build)
(cd "$H" && sha256sum -c MANIFEST.sha256 && ./verify-synthetic.sh)
docker run -d --rm --name fe173-nats -p 127.0.0.1:14222:4222 nats:2.10
docker run -d --rm --name fe173-pg -p 127.0.0.1:15432:5432 -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=fe173 postgres:16
HEAD_HEX=$(curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://10.9.11.68:8545 | node -pe 'JSON.parse(require("fs").readFileSync(0)).result')
HEAD=$((HEAD_HEX))
cat > base-collector.env <<ENV
BASE_COLLECTOR_WS_URL=ws://10.9.11.68:8546
BASE_COLLECTOR_HTTP_URL=http://10.9.11.68:8545
BASE_COLLECTOR_NATS_URL=nats://127.0.0.1:14222
BASE_COLLECTOR_DATABASE_URL=postgres://postgres:scratch@127.0.0.1:15432/fe173
BASE_COLLECTOR_STATE_DIR=$RUN/state
BASE_COLLECTOR_START_BLOCK=$((HEAD - 43200))
BASE_COLLECTOR_PERSIST_START_BLOCK=$HEAD
ENV
set -a; . ./base-collector.env; set +a
node "$H/capture-nats.mjs"   nats.jsonl   & echo $! > capnats.pid
node "$H/capture-direct.mjs" direct.jsonl & echo $! > capdirect.pid
node "$FE/modules/base-collector/dist/main.js" persist 2> persist.log & echo $! > persist.pid
node "$FE/modules/base-collector/dist/main.js" collect 2> collect.log & echo $! > collect.pid
until grep -q '\\"reconciled\\":true' nats.jsonl && [ -s state/checkpoint.json ]; do sleep 5; done
node "$FE/modules/base-collector/dist/main.js" measure --warmup-s 120 --window-s 1800 --teardown-s 120 \
  --pools-from-checkpoint state/checkpoint.json --out measure.json 2> measure.log | tee measure.summary.json
for p in collect persist capdirect capnats; do kill -TERM $(cat $p.pid); done
node "$H/check-report.mjs" measure.json --nats-capture nats.jsonl --direct-capture direct.jsonl > check.json; echo "check exit $?"
docker stop fe173-nats fe173-pg
```
- If `eth_blockNumber` or the WS open fails or times out, stop.
- `START_BLOCK` tracks o1 pools launched in the last ~24 h (43200 blocks; about 174 paced
  `eth_getLogs` calls). Older o1 pools need `EXTRA_POOL_IDS`, which changes the digest.
- Runs use a fresh `$RUN` each:
  - R1 clean: the only live-acceptance candidate.
  - R2 persister outage: `kill -TERM $(cat persist.pid)` at window +300 s and restart after
    ≥ 60 s. Then run `main.js verify-persist --from-block <window.fromBlock> --to-block <window.toBlock>`;
    `missing: 0` is expected. By design `persistence_missing` makes R2 non-validating.
  - R3 collector restart at window +300 s: `backfillOnLiveSubjects` and `lateLiveAfterBackfill`
    must be 0, with misses recovered only on backfill.
- Artifacts to keep: `measure.json`, `measure.summary.json`, `nats.jsonl`, `direct.jsonl`,
  `check.json`, the logs, `base-collector.env`, `MANIFEST.sha256` output, plus `verify-persist`
  JSON for R2.

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

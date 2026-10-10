# base-collector

Persistent raw-first Base collector for Uniswap v4 pools launched by the o1 launchpads. It runs as
its own processes (`collect`, `persist`), not as worker jobs, and does not replace or modify
`modules/uniswap-base`.

Status: prototype for code review. Nothing here has been measured against a node. Fixture tests
prove semantics only; they make no latency, coverage or DAT-SRC-011 claim.

## Processes

| command | role |
| --- | --- |
| `node dist/main.js collect` | one persistent WebSocket; publishes raw + decoded logs to NATS |
| `node dist/main.js persist` | batched Postgres writes from NATS; owns the persistence acknowledgement |
| `node dist/main.js measure --out FILE ...` | direct node subscription vs collector NATS output, one process, one clock |
| `node dist/main.js verify-persist --from-block N --to-block N` | stored state vs canonical `eth_getLogs` |

## Filters and volume

Node-side filters (identical for live subscription, backfill, and `measure`; `filterDigest` names them):

1. `address = PoolManager 0x498581fF718922c3f8e6A244956aF099B2652b2b`, `topic0 ∈ {Initialize, Swap}`.
2. `address ∈` the six o1 factories (all topics).

No all-address subscription. Node→collector traffic is every v4 Initialize and Swap on Base plus
the factory logs. The collector publishes every PoolManager Initialize (`suite` is null unless the
hook is an o1 hook or in `extraHooks`), tracks pools with o1/extra hooks plus `extraPoolIds`, and
drops Swaps of untracked pools locally (`coverage.untrackedSwaps`). Actual traffic is
unmeasured. `rateAlertPerSec` logs when publications exceed the threshold; nothing is dropped for rate.

The six suites (factory, hook) come from DefiLlama `fees/o1-launchpad/config.ts`; they are settings
(`BASE_COLLECTOR_SUITES_JSON`) pending A3 review.

## Records and subjects

`LogRecord.id = blockHash:logIndex`. Every record carries the raw log fields (`blockNumber`,
`blockHash`, `txHash`, `txIndex`, `logIndex`, `address`, `topics`, `data`, `removed`), `decoded`,
`suite`, `receivedAtMs`, and `(epoch, seq)` which orders all observations of one collector lineage.

| subject | content |
| --- | --- |
| `feedeater.base_collector.{initialize,swap,factory}` | live, `realtime: true`, `recovery: null` |
| `feedeater.base_collector.removed.<kind>` | live `removed: true` observation |
| `feedeater.base_collector.backfill.<kind>` / `.backfill.removed.<kind>` | recovery, `realtime: false`, `recovery` = `reconnect`, `pending_swap`, `persister` or `stale` |
| `feedeater.base_collector.seal` / `.backfill.seal` | per-block count + digest of active identities |
| `feedeater.base_collector.ctl.status` | collector status (coverage, counters, persistence state) |
| `feedeater.base_collector.ctl.recover` | persister → collector republish request |
| `feedeater.base_collector.ctl.persister` | persister heartbeat (contiguous block, gaps, queue, errors) |

Live publication happens synchronously inside the WebSocket message handler: classify, decode,
identity transition, `nats.publish`. No block/transaction RPC and no database work precede it.

Identity state: one identity is `active` or `removed`. A repeat of the current state is a duplicate
and is not published; `active → removed` and `removed → active` are transitions and are published.
State is kept for `retainBlocks` below the verified block. A live log older than that window is
published on `.backfill` with `recovery: "stale"`, never as live.

Ordering: within one WebSocket the node delivers logs in order, so an Initialize registers its pool
before a later Swap of the same block is classified. Backfill sorts by `(blockNumber, logIndex)`.

## Recovery contract

Core NATS has no durability; neither process assumes the other is online.

Collector (realtime recovery, `recovery: "reconnect"`):

- `verifiedBlock` is the highest block sealed contiguously while subscribed and reconciled. It is
  never the max block observed. It is checkpointed atomically to `$BASE_COLLECTOR_STATE_DIR/checkpoint.json`
  together with the filter digest, tracked pools and `epoch`.
- On every (re)connect: subscribe first, then read head `H0`, then `eth_getLogs` over
  `[verifiedBlock + 1 - overlapBlocks, H0]` in `backfillChunkBlocks` chunks onto `.backfill`.
  Identities already published are skipped by state; previously active identities the node no
  longer returns (below `H0 - confirmBlocks`) are published as removals. Live swaps for pools not yet
  known during this phase are buffered (`maxPendingSwaps`) and released as `.backfill` `pending_swap`.
- If the range exceeds `maxBackfillBlocks`, only the newest part is replayed and
  `coverage.backfillTruncatedBlocks` records the hole.
- A checkpoint written with a different filter digest is refused at start.
- Identity state is committed only after `nats.publish` returns. A publish that throws leaves the
  identity uncommitted (a later redelivery is published, not dropped as a duplicate), adds its block
  to `coverage.undeliveredBlocks` (`complete: false`), and holds seals/`verifiedBlock` below that
  block. On each new head the collector re-reads at most `maxRecoverBlocks` from the lowest
  undelivered block onto `.backfill` (`recovery: "publish_retry"`); the blocks clear only if that
  pass had no publish error. A restart replays from the held `verifiedBlock`.

Persister (persistence recovery, `recovery: "persister"`):

- Rows are keyed by `id`; a row's state changes only to a strictly newer `(epoch, seq)`, so both
  `removed → re-added` and `re-added → removed` apply and stale replays do not regress state. Every
  observation is also appended to `log_transitions`. There is no `ON CONFLICT DO NOTHING` on state.
- A block is acknowledged when a seal for it matches the stored active identities (count and
  digest). Stored rows on a different block hash than the seal are marked removed.
  `contiguousBlock` advances only through consecutive acknowledged blocks.
- Start boundary (fresh store, `persist_state` empty): nothing is acknowledged, and a seal never
  sets `contiguousBlock`. The boundary `B` is `persistStartBlock` if set, else the first collector
  status `trackedSinceBlock`. `B - 1` is written to `persist_state` before any acknowledgement, then
  `ctl.recover` (`start`) is published. Blocks `B..` without a matching seal stay `gapBlocks` and are
  recovered on `.backfill`; pre-first-seal blocks never become complete silently. An existing
  `persist_state` is the boundary on restart.
- On start and every `persistRecoverIntervalMs` while gaps exist, it publishes `ctl.recover` from
  `firstGap - persistRecoverOverlapBlocks`. The collector replays at most `maxRecoverBlocks` per
  request, with `.backfill.seal` per block.
- Missing persistence is exposed in collector status: `persistence.state` is `missing` when no
  heartbeat arrived within `persisterTimeoutMs`. Heartbeats report queue depth, overflow drops,
  last error and gap blocks. A failed batch stays queued and is retried.

## Pool tracking on a fresh forward collector

A Swap is published only for a tracked pool. A pool becomes tracked from:

1. a PoolManager `Initialize` (live or `.backfill`) whose `hooks` is one of the six suite hooks or
   `extraHooks`; Swaps later in the same block are processed after it (block, logIndex order);
2. `extraPoolIds`;
3. pools restored from the checkpoint (same filter digest);
4. `BASE_COLLECTOR_START_BLOCK`: the first reconcile replays `[startBlock, H0]` (bounded by
   `maxBackfillBlocks`) onto `.backfill`, so Initializes in that range are tracked.

Without a start block, a fresh collector starts at the head (`trackedSinceBlock = H0`) with zero
tracked pools. Swaps of pools initialized before `trackedSinceBlock` (including o1 launches older
than the collector) and not in `extraPoolIds` or the checkpoint are excluded: the Initialize that
would identify their hook was never seen, so they cannot be told apart from non-o1 v4 pools. They
are counted in `coverage.untrackedSwaps` (all non-tracked PoolManager Swaps, o1 or not) and are not
in measurement `expected`. Covering them needs a bounded start block back to the suite's first
block or a supplied pool list; neither is fetched here.

## Coverage bounds

`maxTrackedPools` (LRU) and `poolIdleBlocks` (0 = off) bound tracked pools. Evictions are recorded:
`coverage.droppedPools`, `recentDropped` (pool, reason, block), and `swapsForDroppedPools`.
`coverage.complete` is false once anything was dropped, buffered swaps overflowed, or backfill was
truncated. The collector does not claim every launch under those conditions.

## Settings

Environment variables are `BASE_COLLECTOR_` + the settings key in upper snake case (see
`settings.ts`). Required:

| variable | example |
| --- | --- |
| `BASE_COLLECTOR_WS_URL` | `ws://10.9.11.68:8546` |
| `BASE_COLLECTOR_HTTP_URL` | `http://10.9.11.68:8545` (configured separately; never derived from the WS URL) |
| `BASE_COLLECTOR_NATS_URL` | NATS server |
| `BASE_COLLECTOR_STATE_DIR` | `collect` only |
| `BASE_COLLECTOR_DATABASE_URL` | `persist`, `verify-persist` only |

Optional: `START_BLOCK` (first run only; default = head), `CONFIRM_BLOCKS`, `OVERLAP_BLOCKS`,
`BACKFILL_CHUNK_BLOCKS`, `MAX_BACKFILL_BLOCKS`, `MAX_RECOVER_BLOCKS`, `RETAIN_BLOCKS`,
`MAX_TRACKED_POOLS`, `POOL_IDLE_BLOCKS`, `RPC_MIN_INTERVAL_MS`, `EXTRA_HOOKS`, `EXTRA_POOL_IDS`,
`SUITES_JSON`, and the `PERSIST_*` settings.

## Measurement (owner/Codex, natively or on Thor)

Build: `npm ci && npm run -w @feedeater/module-base-collector build`. Use one environment file for
all three processes so the filters are identical; `measure` reports `filterDigestVerified` only when
the collector's status digest equals its own.

```sh
set -a; . ./base-collector.env; set +a      # the variables above
node modules/base-collector/dist/main.js persist &
node modules/base-collector/dist/main.js collect &
node modules/base-collector/dist/main.js measure \
  --warmup-s 120 --window-s 1800 --teardown-s 120 \
  --pools-from-checkpoint "$BASE_COLLECTOR_STATE_DIR/checkpoint.json" \
  --out base-collector-measure.json
```

`measure` holds a direct node subscription with the same filters plus a NATS subscription on
`feedeater.base_collector.>` in one process timed by `process.hrtime.bigint()`. Warmup is not scored;
the window is scored by block range; teardown keeps collecting late deliveries for window blocks.
Scoring unit: per identity, each side is an ordered list of state transitions (active/removed);
`expected` counts direct transitions in the window (A→R→A is 3). The k-th is delivered only if the
k-th live transition has the same state. A same-state repeat on live is a duplicate; on the direct
side it is `directRepeats`. Live transitions without a direct counterpart are `extraLive` and fail
`liveDelivery100`.

Report fields: `expected`, `deliveredLive`, `liveDeliveryPct`, `missedLiveRecoveredOnBackfill`,
`missedEntirely`, `duplicateLivePublishes`, `backfillOnLiveSubjects`, `lateLiveAfterBackfill`,
`addedLatencyMs` (p50/p95/p99/max), persistence samples, and `dat011` booleans
(100% live, zero duplicate live, zero backfill contamination, p99 added ≤ 10 ms).

Beside the latency, every report carries:

- `byKind.{initialize,swap,factory}`: `expected`, `delivered`, `recoveredOnBackfill`,
  `missedEntirely`, `latencyN` (latency samples of that type) and `p99`.
- `scope`: `targetSwapsExpected`, `trackedPoolsMeasured`, the collector's last `trackedPools`,
  `untrackedSwaps` and `coverage.complete`, `persistence` (`ok_every_sample` | `missing_observed` |
  `unknown_observed` | `not_observed`), `statusSamples`, `persistenceStates`, `heartbeatSamples`,
  `disconnectObserved`, `reconnectObserved` (epoch change or `connects` increase against the previous
  sample, or `connected: false`), `filterDigestMismatchObserved`, and `notCovered`.
- Scope samples are selected by the declared observation window on the harness clock
  (`process.hrtime.bigint()`, the `window_start`..`window_end` marks passed to `report`), not by
  block: every collector status and persister heartbeat received inside it counts whatever its
  `headBlock`; warmup and teardown samples never count. Event rows are still scored by block range
  `[fromBlock, toBlock]` (late teardown deliveries for window blocks are kept for latency).
  `ok_every_sample` requires every in-window status to be explicitly `ok` and at least one in-window
  heartbeat; `unknown` is never upgraded by heartbeat presence. Any in-window incomplete coverage,
  disconnect, reconnect or filter-digest mismatch stays in `notCovered`
  (`collector_coverage_incomplete`, `collector_disconnected`, `collector_reconnected`,
  `filter_digest_mismatch`) even if a later status is good; `filterDigestVerified` (and `dat011.pass`)
  needs every in-window status to carry the harness digest. Other entries: `persistence_unknown`,
  `collector_status_not_observed`. `window.startNs/endNs` and `observations` (raw `atNs` and
  `inWindow` of every status and heartbeat) are in the report next to `marks`.
- `scope.sourceValidationWindow` is true only when `notCovered` is empty. It is false for
  `no_target_swaps`, `no_tracked_pools`, `persistence_missing` / `persistence_not_observed`,
  `collector_coverage_incomplete` or `filter_digest_unverified`. A `dat011.pass` window
  with `sourceValidationWindow: false` (e.g. Initialize-only, no persister) is a smoke sample, not
  source validation. `dat011` thresholds are unchanged.

Run separately, each with its own `measure` report:

1. Clean window (no interruptions).
2. Persister outage: during the window stop `persist` for ≥ 60 s, then restart it. Live delivery
   should be unaffected; afterwards run `verify-persist --from-block <window from> --to-block <window to>`
   and expect `missing: 0` and status `persistence.state` back to `ok`.
3. Collector reconnect: during the window restart `collect` (or drop its connection). Logs missed
   while down must appear only on `.backfill` (`missedLiveRecoveredOnBackfill`), never on live
   subjects; `backfillOnLiveSubjects` and `lateLiveAfterBackfill` must be 0. This window is not a
   live-delivery acceptance window.

`pools-from-checkpoint` seeds the measured pool set with pools tracked before the window, so swaps
of those pools count as expected.

Not done here: any run against a node, NATS or Postgres. Admission and deployment are owner-gated.

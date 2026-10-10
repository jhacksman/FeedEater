# Two-arm WS subscription and resource contract (2026-10-10, preparation only)

Pinned: collector source #173 `5206f90` (`modules/` at the prep heads is identical to it) and prep head
`b1edbfd`. Machine-readable form: `ws-contract-2026-10-10.json`. This is a contract and source trace,
not DAT-SRC-011 admission, and makes no latency claim. Nothing here was run against a real node, WS or
Docker. Line numbers refer to `modules/base-collector/src/` unless prefixed.

## 1. Filters (identical on every arm)

`subjects.ts:34 buildFilters` is the only filter source. The collector (`collector.ts:228`), measure
(`main.ts:159-162`) and capture-direct (`capture-direct.mjs:12,18`) all call it.
1. PoolManager `0x498581ff718922c3f8e6a244956af099b2652b2b`, topic0 in {Initialize `0xdd466e67…6438`,
   Swap `0x40e9cecb…112f`}.
2. All logs of the six factories (sorted): `0x1176…63dc`, `0x1de5…7dc57`, `0xa52a…bb9f`, `0xb9e5…9c35`,
   `0xe3ab…ea64`, `0xff70…f1f4`. The suites, hooks and first blocks are in the JSON.

The digest is `8b5e28aa…46ca` (`subjects.ts:48`). Checked offline: the JSON filters and digest equal
`buildFilters`/`filterDigest` of the frozen dist with default settings.

How filter equality is enforced:
- `check-report.mjs` rejects when the report digest differs from the run env.
- It also rejects when the capture filters, compared lowercased, differ from the run filters, or when a
  capture ACK is missing by `window_start` (`check-report.mjs:216-225`).

Swaps on untracked pools are delivered on every arm, but the native arm only publishes tracked pools
(`collector.ts:340-345`). The checker compares Swaps only as live ⊆ direct.

## 2. Arms

| Arm | Process | Subscriptions | Reconnect |
| --- | --- | --- | --- |
| native | collect, `collector.ts:206-245` | filter 1, filter 2, newHeads | yes, unbounded |
| direct (measure) | `main.ts:135-165` | filter 1, filter 2, newHeads | none |
| direct (capture) | `capture-direct.mjs:17-31` | filter 1, filter 2 | none |
| preflight | `preflight.mjs:51-76` | newHeads | none; 20 s deadline |

## 3. One clock, barriers, classification

- *Clock:* `process.hrtime.bigint()` in the measure process.
- *Marks:* `warmup_start` T0, `window_start` W0, `window_end` W1, `teardown_end` T1 (`main.ts:173-181`).
- *Barriers:*
  - observation start is W0, with `fromBlock` = measure's direct head at W0 + 1;
  - observation end is W1, with `toBlock` = the head at W1 (`main.ts:176-178`).
- *Classification:*
  - startup: T0..W0 and blocks < `fromBlock` are not scored;
  - window: events with `fromBlock` ≤ block ≤ `toBlock`;
  - tail: W1..T1 collects late deliveries for window blocks, but its status samples are outside the
    window scope (`main.ts:105-108`, `measure.ts:172-177,236`).
- *Captures:* they must start before T0 and stop after T1, or the report is rejected
  (`check-report.mjs:158`).
- *Limits:* same host and boot only. The host is self-reported by hostname and `measure.json` records
  no host.

## 4. Limits: enforced, planned, absent

| Limit | Value | State | Source |
| --- | --- | --- | --- |
| WS message count (any arm) | — | absent | none. Live-observable only for capture (`direct.jsonl` lines); measure keeps messages in memory until exit; the collector logs no per-message count |
| WS bytes per message | 100 MiB | library default only (`ws` 8.19.0 `maxPayload`); total bytes absent | `new WebSocket(url)` with no options in main.ts, capture-direct, preflight |
| measure duration | W+X+T = 120+1800+120 s | enforced | `main.ts:173-182`; `run-native.sh:100` (+180 s, exit 8) |
| collector/capture duration | — | enforced externally only | run-native owned stop; `guard-run.sh` DEADLINE_S + GRACE_S |
| preflight heads | 20 s | enforced | `preflight.mjs:26` |
| native reconnects | — | **absent**: unbounded, backoff 500 ms·2^n up to 30 s, reset to 0 before reconcile | `collector.ts:236,247-260` |
| direct reconnects | 0 | no reconnect code; a closure before stop is rejected afterwards | `check-report.mjs:97,221` |
| reconnect backfill | 1900 blocks per reconnect | enforced as truncation plus a warning, not as a stop; total across reconnects absent | `collector.ts:550-554`; `plan-inputs.mjs:20,57` |
| recover per request | 500 blocks | enforced; request count absent (every 30 s while gaps remain) | `collector.ts:664`; `settings.ts:61` |
| HTTP requests | r1/r2/r3 20/40/30 | enforced only under `guard-run.sh` (b1edbfd); WS not covered | `rpc-guard.mjs` |
| pending swaps | 20000 | enforced; overflow dropped and counted, which makes coverage incomplete | `collector.ts:420-426` |
| stale live | 4096 blocks | enforced; moved to `.backfill` as stale | `collector.ts:351-356` |
| publish rate | 2000/s | alert only | `collector.ts:408-416` |

## 5. Stop and refusal

- *Enforced:*
  - run-native exits 3/5/6/7/8/9;
  - guard-run exits 10–14;
  - `check-report` REJECT, after the run.
- *Planned, not implemented, for Codex's external watcher.* No source enforces any of these today:
  - stop on any unplanned collector `websocket disconnected` (r1/r2 allow 0, r3 allows 1) or any
    `connect/reconcile failed`;
  - stop on `reconnect backfill truncated`;
  - stop on a capture `ws_error`/`direct_ws_closed` before stop;
  - stop when `direct.jsonl` lines or bytes exceed a Codex-declared cap. No value is given here: no
    measured log rate exists for these filters.
- *Gaps a watcher cannot close from existing artifacts:* collector and measure WS message/byte totals.
  Closing them needs an owned WS counting proxy, which would be a future preparation item, not part of
  this document.

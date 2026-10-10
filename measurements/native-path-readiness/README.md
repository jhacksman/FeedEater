# native-path-readiness (read-only trace, docs only)

Readiness of the actual native measurement path for DAT-SRC-011, traced from source at frozen #173
`5206f9035ad1c057d78990b294941221e936f895` (`modules/base-collector/`, paths below relative to it) and fork `main`
`56fde238e85ac34268d958578bed291802ed99f7`, with the accepted preparation kit `e2a4cd9` mapped separately. Nothing here
was executed; no node, NATS, database, process, T7 or production state was observed or inferred. The machine-readable
form is `readiness.json` (inert data).

## Bottom line

- **`main` has no native path.** `56fde238` contains no `modules/base-collector/` (and no other collector, raw
  publisher or measurement observer for Base logs). Every IMPLEMENTED row exists only in the held, unmerged #170→#173
  chain; on `main` all rows are ABSENT. A real native run is BLOCKED on the owner decision on #170–173.
- **Kit filters are not wired to the native stream.** The collector and harness build their node filters from settings
  (`src/subjects.ts:34-39 buildFilters`), not from any manifest; nothing in `modules/base-collector` reads the kit,
  `manifest.json`, `plan.json` or `contract.json`. The kit governs only the offline, root-operated capture C1 backfill.
- **Same sets, different bytes.** Native PoolManager filter is `topics: [[INITIALIZE, SWAP]]`; the kit manifest pins
  `[[SWAP, INITIALIZE]]` (`0x40e9…` then `0xdd46…`). The OR set is identical, but `d568aee` compares canonical bytes, so the
  native filter supplied verbatim as `comparison.direct/native.poolmanager` would be `FILTER_MISMATCH`
  (`topics_encoding_differs`). The factory filter `{address:[six, sorted]}` (no `topics`) is byte-equal to the
  manifest's `filtersets[1].filter` when `settings.suites` keeps its defaults (`settings.ts:30`); a root override of
  `suites` changes it.
- **Native publication is not raw-all-Swaps.** Node-side Swap delivery is unfiltered by pool, but the collector publishes
  a Swap only for a tracked (o1-hook) pool (`src/collector.ts:340-347`); untracked Swaps are counted, not published. The
  kit contract describes node filters, not this publication rule.

## Trace

| # | Stage / item | Source (file:line, call) | #173 | `main` |
|---|---|---|---|---|
| 1 | Launcher | `src/main.ts:238-244` `collect \| persist \| measure` | IMPLEMENTED (CLI only; no process/service config traced) | ABSENT |
| 2 | PoolManager Initialize/Swap filter | `src/subjects.ts:36` `{address:[poolManager], topics:[[TOPIC_INITIALIZE, TOPIC_SWAP]]}`; `src/constants.ts:4,7,9`; subscribed `src/collector.ts:227-228` `eth_subscribe("logs", f)` | IMPLEMENTED; topic order ≠ kit | ABSENT |
| 3 | Six-factory ALL-topics filter | `src/subjects.ts:37` `{address: suites.map(factory).sort()}` (no `topics`); addresses `src/constants.ts:26-56` = kit's six; classify any topic0 of a known factory → `factory` `src/decode.ts:83` | IMPLEMENTED | ABSENT |
| 4 | Raw publication | `src/collector.ts:322-326` `classify` (out-of-filter counted); `:340-347` Swap gated on `tracker.has(poolId)`; `:387` `publish(logSubject(...))` before `:391` `ledger.transition` | IMPLEMENTED; Swap publication hook-gated | ABSENT |
| 5 | blockHash/logIndex dedup, removal, re-add | id `${blockHash}:${logIndex}` `src/collector.ts:357-358`; `removed` `:331`; `src/ledger.ts:8-9,33-45` transitions (removed↔active both apply); persister seal reconciliation `src/persister.ts:17-25,170-172`; `src/pgStore.ts:83-84` `log_transitions` | IMPLEMENTED | ABSENT |
| 6 | Live / backfill subjects | `src/subjects.ts:7-27` live `feedeater.base_collector.{initialize,swap,factory,removed.*}`, backfill `….backfill.*`; stale live → backfill `src/collector.ts:350-355` | IMPLEMENTED; kit `subjects.{backfill,live}` are caller labels with no mapping to these names | ABSENT |
| 7 | Durable checkpoint | `src/checkpoint.ts:7-41` `FileCheckpointStore(stateDir)/checkpoint.json` v1 `{verifiedBlock, pools}`; save `src/collector.ts:183,201,521` (`checkpointIntervalMs`) | IMPLEMENTED; write atomicity/fsync not traced; `stateDir` default `null` (`settings.ts:23`) | ABSENT |
| 8 | Reconnect / backfill | backoff `src/collector.ts:257-260`; replay `:538-575` `eth_blockNumber`, then `eth_getLogs` from `verifiedBlock+1-overlapBlocks` (64) in `backfillChunkBlocks` (500) chunks (`settings.ts:36-37`) | IMPLEMENTED; does not use the kit plan | ABSENT |
| 9 | Volume / coverage caps | `maxTrackedPools` 100000 (`settings.ts:44`), LRU eviction counted `src/tracker.ts:10-11,54-57`; `maxPendingSwaps` `src/collector.ts:421` | PARTIAL: pool/queue caps only; no byte (`maxBytes`) or raw-event (`maxRawEvents`) cap → kit caps ABSENT natively | ABSENT |
| 10 | Clock / window identity | one process `process.hrtime.bigint()` `src/measure.ts:21,74`; marks `src/main.ts:166-175`; events scored by block range, samples by marks `src/measure.ts:175-176` | IMPLEMENTED (one process clock, arbitrary origin); no `clockId`, no UTC window → kit `observationClock{clockId, fromUtc, toUtc}` ABSENT natively | ABSENT |
| 11 | Direct comparator | direct WS with the same `buildFilters` `src/main.ts:159-163`; canonical set via `eth_getLogs` `:205-215`; `Measurement` `src/measure.ts:84`; `filterDigest` `src/subjects.ts:48-55` = sha256 of `{filters, hooks, extraPoolIds}` | IMPLEMENTED; digest ≠ kit `filterSha256` (different preimage) | ABSENT |
| 12 | Kit → native wiring | no manifest/plan/contract reader in `modules/base-collector` | ABSENT | ABSENT |

## Kit `e2a4cd9` mapping

| Kit artifact | Native counterpart | Status |
|---|---|---|
| manifest PoolManager lane | row 2 | same OR set, byte order differs |
| manifest six-factory ALL-topics lane | row 3 | byte-equal with default `suites` |
| plan `[max(0,C−L+1), H]` calls | row 8 replay range | unrelated; native range from its own checkpoint |
| capture C1 receipts + `83aec5d` verify | none (offline, root-operated only) | separate path |
| contract caps | row 9 | ABSENT natively |
| contract `observationClock` | row 10 | ABSENT natively |
| contract `subjects` | row 6 | labels only, unmapped |
| contract `comparison.direct/native` | row 11 filters | must be supplied by root from an actual run |

## Root-supplied inputs still required

- **Native run (#173):** `wsUrl`, `httpUrl`, `natsUrl`, `databaseUrl`, `stateDir`, `startBlock`/`persistStartBlock`
  (`settings.ts:18-25,64`); `measure --out`, `--warmup-s`, `--window-s`, `--teardown-s`, optional
  `--pools-from-checkpoint` (`src/main.ts:111-115`).
- **Kit/offline capture:** genuine C/H with hashes and times, `sourceId`, hash/removed evidence, L, caps, window,
  direct/native filters, clock id and UTC window, subjects, `ROOT_SPEC`, `ROOT_COMPOSE_OUT`, `ROOT_ENDPOINT`,
  `ROOT_CAPTURE_OUT`.

## Withheld decisions and what they block

| Decision (withheld) | Blocks |
|---|---|
| Owner acceptance/merge of #170–173 (frozen) | any native DAT-SRC-011 run from `main`; rows 1-11 exist only there |
| Whether native filters must be byte-aligned with the kit manifest (row 2 order) or compared as sets | a `CONTRACT_CONSISTENT` `d568aee` result with native filters supplied verbatim |
| Mapping of kit `observationClock`/`subjects` to native hrtime marks/subject names | one-clock and subject-separation claims across the two paths |
| Q1/Q2 (UNADOPTED) | not restated here; no row depends on adopting them |
| Source admission (NOT_ESTABLISHED) | any admission, completeness or latency claim from either path |

## Limits

Static read of source at two commits only; line numbers are for `5206f90`. Runtime behaviour, process supervision,
deployment, T7 and node configuration are not observed. Checkpoint durability was not traced; filter byte comparisons are against the `42185f2`
`evidence/manifest.synthetic.json` filter objects. The exhausted source lane stays frozen.

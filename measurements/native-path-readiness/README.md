# native-path-readiness (read-only trace, docs only)

Requirement status of the native measurement path for DAT-SRC-011, traced from source at frozen #173
`5206f9035ad1c057d78990b294941221e936f895` (`modules/base-collector/`; paths below relative to it, line numbers at
`5206f90`) and fork `main` `56fde238e85ac34268d958578bed291802ed99f7`, with the accepted preparation kit `e2a4cd9`
mapped separately. Nothing was executed; no node, NATS, database, process, T7 or production state was observed or
inferred. Machine-readable form: `readiness.json` (inert data).

## Two different paths

- **`main`-native path: unavailable.** `56fde238` has no `modules/base-collector/`; every row below is ABSENT on `main`.
  Owner merge of #170–173 is what would make it available.
- **Isolated preparation measurement of immutable candidates: available to root.** The frozen #173 head can be run by
  root, in isolation, as an already-authorized read-only diagnostic measurement. Owner merge and D8 source admission do
  not prohibit that run or reporting its actual result, including FAIL and observed latency, with provenance (head, tree,
  settings, marks, report file). Admission, deployment and acceptance remain blocked; a raw observed measurement is
  reported as observed, never as success or admission. Root owns the node and the run; current T7 state is never
  inferred here.

## Requirement status

Status: SATISFIED (requirement met by the traced code), PARTIAL (some of it met, rest stated), UNKNOWN (not provable from
source), ABSENT. "Implemented" means the code is present; it does not by itself satisfy the requirement.

| # | Requirement | Implemented (source) | Status | Gap / UNKNOWN |
|---|---|---|---|---|
| 1 | Runnable native launcher from the candidate | `src/main.ts:238-244` `collect \| persist \| measure` | SATISFIED (CLI) | process supervision, host, T7: UNKNOWN (root-owned) |
| 2 | PoolManager Initialize/Swap OR filter, same on collector and direct | `src/subjects.ts:36` `{address:[poolManager], topics:[[TOPIC_INITIALIZE, TOPIC_SWAP]]}`; `src/constants.ts:4,7,9`; collector `src/collector.ts:227-228` `eth_subscribe("logs", f)`; direct `src/main.ts:159-163` same `buildFilters` | SATISFIED as a set | bytes ≠ kit manifest (`[[SWAP, INITIALIZE]]`): `d568aee` verbatim compare → `FILTER_MISMATCH` (`topics_encoding_differs`) |
| 3 | Six-factory ALL-topics filter | `src/subjects.ts:37` `{address: suites.map(factory).sort()}`, no `topics`; any topic0 of a known factory → `factory` `src/decode.ts:83` | SATISFIED | byte-equal to manifest `filtersets[1].filter` only with default `suites` (`settings.ts:30`) |
| 4 | 100% delivery of the identical node filter | direct records every filtered log `src/measure.ts:110-128`; denominator skips Swaps of pools outside the measurement pool set `src/measure.ts:188`; that set = direct hook Initializes `:116` + `--pools-from-checkpoint`/`extraPoolIds` `:107` + pools of collector-published Swaps `:164`; collector publishes a Swap only for a tracked pool `src/collector.ts:340-347` | PARTIAL | see below: hook-tracked subset, not raw-all PoolManager; subset equality between collector and observer UNKNOWN |
| 5 | blockHash/logIndex dedup, removal, re-add | id `src/collector.ts:357-358`; `removed` `:331`; `src/ledger.ts:8-45` (removed↔active both transitions); persister seals `src/persister.ts:17-25,170-172`; `src/pgStore.ts:83-84` `log_transitions` | SATISFIED (code) | runtime behaviour UNKNOWN |
| 6 | Separate live / backfill subjects | `src/subjects.ts:7-27`; stale live → backfill `src/collector.ts:350-355`; live contamination counted `src/measure.ts:149-150` | SATISFIED (code) | kit `subjects.{backfill,live}` are caller labels, unmapped to these names |
| 7 | Durable, crash-safe checkpoint | see checkpoint trace | PARTIAL | atomic replace only; no fsync → crash durability UNKNOWN |
| 8 | Reconnect + gap backfill | backoff `src/collector.ts:257-260`; `:538-575` `eth_blockNumber`, `eth_getLogs` from `verifiedBlock+1-overlapBlocks` (64) in 500-block chunks (`settings.ts:36-37`) | SATISFIED (code) | does not use the kit plan; no byte cap |
| 9 | Volume / coverage caps | `maxTrackedPools` 100000 `settings.ts:44`, LRU eviction counted `src/tracker.ts:10-11,54-57`; `maxPendingSwaps` `src/collector.ts:421` | PARTIAL | no `maxBytes`/`maxRawEvents` natively |
| 10 | Identical observation window, one clock | see window trace | PARTIAL; retained clock-window blocker | hrtime presence ≠ identical window |
| 11 | Event and latency denominators | see window trace | SATISFIED as defined | defined over the row-4 subset |
| 12 | Comparable filter identity | `filterDigest` `src/subjects.ts:48-55` = sha256 of `JSON.stringify({filters, hooks, extraPoolIds})` | PARTIAL | preimage ≠ kit `filterSha256`; not comparable |
| 13 | Kit filters wired to the native stream | none: no manifest/plan/contract reader in `modules/base-collector` | ABSENT | kit governs only the offline capture C1 path |

### Row 4: hook-gated publication

The direct observer subscribes to the full PoolManager Initialize/Swap filter, but the collector publishes Swaps only for
pools it tracks (o1 hooks, configured extra hooks/pool ids), and the observer's denominator keeps a direct Swap only if
its pool is in the observer's own pool set. Delivery % and `liveDelivery100` (`src/measure.ts:256`) therefore measure
delivery of that tracked subset, not of every log the identical node filter returns. They cannot establish 100%
identical-filter delivery unless the tracked subset is declared as the permitted subset, or a raw-all publication path
exists. Because `src/measure.ts:164` adds pools from collector output, and a pool initialized before warmup is known to
the observer only via `--pools-from-checkpoint`, equality of the collector's and observer's subsets is UNKNOWN. No
retrofit, threshold or policy change is proposed here.

### Row 7: checkpoint save (`src/checkpoint.ts`)

| Step | Line | Behaviour |
|---|---|---|
| directory | 46 | `fs.mkdir(dirname, {recursive:true})` |
| temp file | 47 | `${file}.${process.pid}.tmp` |
| write | 48 | `fs.writeFile(tmp, JSON.stringify(cp))`; no file fsync |
| replace | 49 | `fs.rename(tmp, file)`; atomic replace on one POSIX filesystem; no directory fsync |
| failure cleanup | – | none; a failed write/rename can leave the temp file |
| load | 33-43 | `ENOENT` → `null`; otherwise `JSON.parse` + `version === 1` only, no shape validation |
| start / stop saves | `src/collector.ts:183,201` | awaited; an exception propagates to the caller |
| interval saves | `src/collector.ts:519-531` | caught: `checkpointErrors += 1`, logged, run continues with the previous on-disk checkpoint |

A reader sees either the old or the new complete file (rename), but survival of the new file across power loss or
crash is not guaranteed by the code: UNKNOWN.

### Rows 10-11: observation window and denominators

| Step | Source | Behaviour |
|---|---|---|
| clock | `src/main.ts:166-172` `mark()` | `process.hrtime.bigint()`, one process, arbitrary origin |
| warmup | `src/main.ts:173-174` | `warmup_start`, sleep `--warmup-s` (60), not scored |
| window start | `src/main.ts:175-176` | `window_start` mark; `fromBlock = (head ?? 0) + 1` from the last direct `newHeads` |
| window end | `src/main.ts:177-179` | sleep `--window-s` (600); `toBlock = head ?? fromBlock`; `window_end` mark |
| teardown | `src/main.ts:180-181` | sleep `--teardown-s` (30); late deliveries for window blocks still count |
| event selection | `src/measure.ts:177,187,224` | by block range `[fromBlock, toBlock]`, not by receipt time |
| sample selection | `src/measure.ts:176,237` | status/heartbeat samples by `[startNs, endNs]` clock marks |
| expected | `src/measure.ts:188,193` | each direct state transition in range, minus row-4 excluded Swaps |
| delivered / latency | `src/measure.ts:199` | k-th matching live transition; `ms = live tNs − direct tNs` on the same clock; negatives counted |
| verdicts | `src/measure.ts:256-259,272,324,340` | `liveDelivery100` needs `expected > 0`; `p99AddedLe10ms` over delivered only; `no_target_swaps` etc. → `sourceValidationWindow:false` |

Events are scored by a block range taken from head marks while persistence samples use the clock marks, so the two do not
share one declared observation window; `head === null` at `window_start` gives `fromBlock = 1`. The measured latency is
collector→NATS→observer delay relative to direct WebSocket arrival in the same process, not source latency. The retained
clock-window blocker on frozen #173 applies unchanged.

## Six-factory source map

| Factory | Native `src/constants.ts` (name / factory line) | Kit manifest `filtersets[1].rows` | `production-contracts.md` lines |
|---|---|---|---|
| `0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64` | `base-mainnet-block-v1` 25 / 26 | row 1 | 535 |
| `0xa52ad458ce0282a971ecc71c051a32f28946bb9f` | `base-mainnet-timestamp-v2` 31 / 32 | row 2 | 547 |
| `0x1de58a6769526a03a504d9d59b8757cd8097dc57` | `base-mainnet-rwa-timestamp-v3` 37 / 38 | row 3 | 559 |
| `0xff70918ef17a2d74d683a8297813b177bafad1f4` | `base-mainnet-rwa-timestamp-v4` 43 / 44 | row 4 | 323, 389, 571 |
| `0xb9e5910043353717af54d8dd34b6ee57ffe49c35` | `base-mainnet-launchpad-v4-minimal-pre-atomic` 49 / 50 | row 6 | none (`absent_from_production_contracts_md`) |
| `0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc` | `base-mainnet-launchpad-v4-minimal` 55 / 56 | row 5 | 29 |

All six bindings stay `UNKNOWN` in the manifest.

## Kit `e2a4cd9` mapping

| Kit artifact | Native counterpart | Status |
|---|---|---|
| manifest PoolManager lane | row 2 | same set, byte order differs |
| manifest six-factory lane | row 3 | byte-equal with default `suites` |
| plan `[max(0,C−L+1), H]` calls | row 8 | unrelated; native range from its own checkpoint |
| capture C1 receipts + `83aec5d` verify | none | separate offline, root-operated path |
| contract caps | row 9 | ABSENT natively |
| contract `observationClock` | row 10 | ABSENT natively (no `clockId`, no UTC window) |
| contract `subjects` | row 6 | labels only, unmapped |
| contract `comparison.direct/native` | row 2-3 filters | root supplies from an actual run |

## Root-supplied inputs

- **Isolated #173 run:** `wsUrl`, `httpUrl`, `natsUrl`, `databaseUrl`, `stateDir`, `startBlock`/`persistStartBlock`
  (`settings.ts:18-25,64`); `measure --out`, `--warmup-s`, `--window-s`, `--teardown-s`, `--pools-from-checkpoint`
  (`src/main.ts:111-115`).
- **Kit/offline capture:** genuine C/H with hashes and times, `sourceId`, hash/removed evidence, L, caps, window,
  direct/native filters, clock id and UTC window, subjects, `ROOT_SPEC`, `ROOT_COMPOSE_OUT`, `ROOT_ENDPOINT`,
  `ROOT_CAPTURE_OUT`.

## Withheld decisions

| Decision | Blocks | Does not block |
|---|---|---|
| Owner merge of #170–173 | the `main`-native path | isolated root run of frozen `5206f90`, reporting its actual result |
| D8 source admission (NOT_ESTABLISHED) | admission, deployment, acceptance | reporting observed raw measurements (FAIL, latency) with provenance |
| Retained clock-window blocker (#173) | a claim of one identical observation window | reporting the block-range and clock-mark results as observed |
| Row 4 permitted subset (tracked vs raw-all) | a 100% identical-filter delivery claim | reporting delivery of the tracked subset as such |
| Byte alignment vs set comparison (row 2) | `CONTRACT_CONSISTENT` with native filters supplied verbatim | the native run itself |
| Q1/Q2 (UNADOPTED) | not restated; no row depends on them | – |

## Limits

Static read of source at two commits; nothing executed. Runtime, process supervision, deployment, T7 and node
configuration not observed. Filter byte comparisons are against `42185f2` `evidence/manifest.synthetic.json`. The
exhausted source lane stays frozen.

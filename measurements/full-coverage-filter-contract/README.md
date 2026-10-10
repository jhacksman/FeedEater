# full-coverage-filter-contract

This is an offline contract check, with a recipe, for **full-coverage** backfill/direct/native comparison of the two pinned lanes:

- **PoolManager lane** `poolmanager.initialize_swap`: address `0x498581ff…2b2b`, `topics [[Swap 0x40e9…, Initialize 0xdd46…]]` (the topic0 OR).
- **Factory lane** `o1.factories.raw_all_topics`: the six census factories, each exactly once, sorted, with **no `topics` key**. Every log from these addresses is in scope: no pool list and no ABI or unknown-event exclusion.

It reuses the following, unchanged: filter-manifest `42185f2` (`filter-manifest/1`), backfill-plan C1 `a345d48` (`backfill-plan/1`) and receipt verifier `83aec5d` (`backfill-receipt-verification/1`). The narrow census, the six factories with topic0 `Launched` `0x207384e8…` only, is a **distinct recipe** (`9d7d087` `example-narrow-launched`). It is never accepted as the factory lane.

No request, node, T7, explorer, social, clock, environment or network use happens here, and nothing is written. Nothing here is coverage, completeness, latency or source-admission evidence. Q1 and Q2 stay UNADOPTED. Resume-live is never permitted.

## Run (from this directory)

```
node check.mjs --contract fixtures/contract.synthetic.json --manifest fixtures/manifest.synthetic.json --plan fixtures/plan.synthetic.json
node test.mjs     # needs git with 42185f2, a345d48, 83aec5d, 9d7d087; extracts them with git archive into ./work, removed at end
```

- **check.mjs:** exit 0 prints a canonical report `full-coverage-filter-contract-report/1`, whose `verdict` is `CONTRACT_CONSISTENT`, `UNKNOWN` or `FAIL`. Exit 2 prints `{refused, detail}`.
  - Files are opened read-only and no-follow, and only the three named files are read.
  - Lines 15–153 are copied verbatim from `83aec5d` `verify.mjs`: the strict JSON parser, `loadManifest`, `loadPlan`, and the no-follow read.

## Contract `full-coverage-filter-contract-input/1` (every field required, strict)

| field | rule |
|---|---|
| `manifest{fileSha256, manifestSha256}` | pins the manifest; it must be canonical with its self-hash recomputing (as in 83aec5d) |
| `plan{fileSha256, planSha256}` | pins the plan, which must be built from that manifest, with every call bound to its lane filter plus a hex range |
| `window{fromBlock, toBlock}` | **inclusive** block window, `fromBlock <= toBlock`; each lane's planned calls must cover it exactly and contiguously |
| `caps.plan{maxCalls, maxBytes, maxChunkBlocks, maxGapBlocks}` | must equal the plan's `inputs.caps` |
| `caps.comparison{maxBytes, maxRawEvents}` | must equal the manifest's `comparison.caps`; these are stop limits, not a volume estimate |
| `lanes.{poolmanager,factories}.filterSha256` | must equal the manifest lane's `filterSha256` |
| `comparison.{direct,native}.{poolmanager,factories}` | the filter object actually used, without a block range, or `null`, meaning not yet declared |
| `observationClock{clockId, fromUtc, toUtc}` | the one-clock prerequisite: `fromUtc`/`toUtc` must equal the manifest's `comparison.window`; `clockId` is a label or `null` |
| `subjects{backfill, live}` | the historical/backfill subject and the live subject; they must differ; `null` if not declared |

## Checks (22) and statuses

| check | PASS | otherwise |
|---|---|---|
| `manifest.filtersets_exactly_two_lanes` | ids exactly [poolmanager, factories] | FAIL |
| `manifest.poolmanager_filter`, `manifest.factories_filter` | byte-identical to the lane constants | FAIL, with named diffs |
| `manifest.factory_rows_six_each_once` | 6 rows, 6 distinct, the same set | FAIL |
| `manifest.no_fixed_pool_list` | no filterset beyond PoolManager plus the six factories | FAIL |
| `lanes.*_pin` | equal to the manifest's `filterSha256` | FAIL |
| `plan.planned_untruncated` | `PLANNED`, `truncated:false` | UNKNOWN |
| `plan.*_covers_window_exactly` | the first `fromBlock` equals the window start, the last `toBlock` the window end, with no gap | FAIL (`covered`, `firstGap`) |
| `plan.backfill_only_provenance` | the plan and every call `backfill:true, live:false`; `backfillSubject.mustDifferFromLiveSubject`; `resumeLive.allowed:false` | FAIL |
| `caps.plan_equal`, `caps.comparison_equal` | equal | FAIL |
| `comparison.{direct,native}.*` | `FILTER_EQUAL`: canonical bytes and sha equal the lane's | `null` gives UNKNOWN `NOT_DECLARED`; the narrow Launched filter gives FAIL `NARROW_LAUNCHED_CENSUS_NOT_ALL_TOPICS`; anything else gives FAIL `FILTER_MISMATCH` |
| `comparison.direct_native_equal.*` | direct == native == lane | either side null gives UNKNOWN, otherwise FAIL |
| `clock.window_equals_manifest` | equal and from < to | FAIL |
| `clock.one_clock_declared` | `clockId` declared (`UNVERIFIED_CALLER_DECLARED`) | UNKNOWN |
| `subjects.backfill_distinct_from_live` | both declared and different | null gives UNKNOWN; equal gives FAIL |

Filter diffs are named:
- `topic0_missing:<Initialize|Swap>`, `topic0_extra:<h>`, `topics_missing`, `topics_positions_differ`, `topics_encoding_differs`;
- `topics_present_on_all_topics_lane`;
- `address_missing:<a>`, `address_extra:<a>`, `address_duplicate:<a>`, `address_order`;
- `range_key_in_filter:<k>`, `key_extra:<k>`.

**Verdict:** FAIL if any check fails, otherwise UNKNOWN if any is unknown, otherwise `CONTRACT_CONSISTENT`. `rootInputsMissing` lists every `null` root field.

## Recipe (root only; this candidate makes no request)

1. Root picks the development-B window and the plan inputs: checkpoint C, head H, the hash and removed evidence, lookback L and caps. Root runs `42185f2` `compile.mjs` and then `a345d48` `plan.mjs`, and proceeds only on `PLANNED`. The window is `[max(0, C−L+1), H]`.
2. Root fills `templates/contract.template.json`. Every `UNRESOLVED_*` value is refused as-is.
3. Run `check.mjs`. Proceed only on `CONTRACT_CONSISTENT`.
4. Capture raw RPC responses per lane under the backfill subject, never the live one. Use capture C1 once it is accepted; it is not changed here. Then verify them with `83aec5d`.
5. Any direct/native comparison uses the same lane filter bytes, the same window and the same caps on both sides. A Launched-only (narrow census) capture is a separate recipe and stays `FILTER_MISMATCH`/`UNKNOWN` against this plan.

### Missing root inputs

- `UNRESOLVED`, root only:
  - the development-B window and the plan inputs: C, H, hashes and timestamps, `sourceId`, evidence, L, caps;
  - the manifest and plan pins of root's own compile and plan;
  - `comparison.direct.*` and `comparison.native.*`, the filters actually used;
  - `observationClock.clockId` and the window's `fromUtc`/`toUtc`;
  - `subjects.backfill` and `subjects.live`.
- Root also owns the endpoint and the capture output directory.

## Limits

- Filters are compared as exact canonical bytes. A semantically equal but differently ordered filter gives FAIL `address_order`/`topics_encoding_differs`, by design.
- The window is checked against the plan's call ranges only. Chain canonicality, reorgs, provider pruning and silent provider truncation are not detectable here.
- `clockId` and the subject names are caller labels. No clock is read or implemented, and one-clock stays NOT_ESTABLISHED.
- The pinned `a345d48` `plan.mjs` refuses a manifest whose factory lane is narrowed to Launched-only (`manifest_filtersets_invalid`), so that variant is tested as a refusal.
- Synthetic fixtures only: the manifest is `42185f2` evidence `3a5431c2…`, the plan is `a345d48` evidence `3299b8fb…` (window [937, 1250], 8 calls), and the contract is synthetic.

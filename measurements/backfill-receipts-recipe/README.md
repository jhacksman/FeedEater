# backfill-receipts-recipe: inert acquisition/receipt recipe (docs-only)

This is how a caller (root) acquires and retains `eth_getLogs` receipts so that the prepared verifier can judge them.

It is docs and synthetic examples only: it makes no requests, uses no node, T7, production data or sealed holdout, and changes no runtime. Root alone chooses and probes the development-B block window. Q1 and Q2 stay UNADOPTED, and none of this is latency, completeness or source-admission evidence.

## Pinned components (all FeedEater, frozen for A7)

| Step | Commit | Path | Entry sha256 |
|---|---|---|---|
| Filter manifest compiler | `42185f2170fb68e5d55b5e8507f480229f58b4df` | `measurements/filter-manifest/compile.mjs` | `a01e632e…` |
| Backfill plan | `a345d48a2f003348d3fe21910518ec1e6e54db35` | `measurements/backfill-plan/plan.mjs` | `c527e180…` |
| Receipt verifier | `83aec5d72f6712711b5f22ef29777858c5b797e0` | `measurements/backfill-receipts/verify.mjs` | `0eb02c03…` |

## Check this recipe

```
cd measurements/backfill-receipts-recipe && node recipe.mjs     # 16 PASS expected; output in recipe.out
```

`recipe.mjs` extracts the three pins with `git archive` into `./work`, deletes `./work` at the end, and writes nothing else. It needs git with all three commits.

## 1. Minimum caller inputs (every `UNRESOLVED_*` in `templates/`)

| Field | Owner | Template |
|---|---|---|
| Development-B window `fromUtc`, `toUtc`, `durationS` | root only | `filter-spec.template.json` |
| `caps.maxRawEvents`, `caps.maxBytes` for the filter manifest | root | `filter-spec.template.json` |
| `sourceId` (the node/provider identity, same in source, checkpoint and head) | root | `plan-spec.template.json` |
| Checkpoint `blockNumber`, `blockHash`, `recordedAtUtc`; head `blockNumber`, `blockHash`, `observedAtUtc` | root, from its own probe | `plan-spec.template.json` |
| `checkpointBlockHashAtHead` (or null) and `removedLogsSeen` (true, false or null) | root | `plan-spec.template.json` |
| `lookbackBlocks`, `maxGapBlocks`, `maxChunkBlocks`, `maxCalls` (≤ 10000), `maxBytes` | root | `plan-spec.template.json` |
| Manifest file and self sha, plan file sha and `planSha256`, receipts index sha | computed in the hash sequence below | `verify-spec.template.json` |
| JSON-RPC `id` for each request (integer or string, unique) | caller | `request.template.json` |

Each template is refused (exit 2) by its tool while any `UNRESOLVED_*` remains; recipe checks 2a–2c show this.

## 2. Hash sequence

1. Fill in `filter-spec`, then run `node compile.mjs --spec F` from `measurements/filter-manifest`. Keep stdout as `manifest.json`. Its file sha256 and `manifestSha256` go into `plan-spec`.
2. Run `node plan.mjs --spec P --manifest manifest.json`. Keep stdout as `plan.json`. Proceed only if `status` is `PLANNED`; anything else yields an `UNKNOWN` verdict.
3. For each `plan.calls[i]`, in index order:
   - **Request:** send `{"jsonrpc":"2.0","id":<id>,"method":"eth_getLogs","params":[plan.calls[i].request.params[0]]}` with params verbatim and no added or removed keys.
     - Keep the exact bytes sent as `call-<i>.request.json` and record their sha256.
   - **Response:** keep the exact bytes received as `call-<i>.response.json`, with no reformatting, decompression or re-serialisation, and record their sha256.
4. Write `receipts.json` (`backfill-receipts/1`): `planSha256` plus one `{callIndex, request{file, sha256}, response{file, sha256}}` per retained call.
   - Files are plain basenames next to the index, and only listed files are read.
   - Record its file sha256 in `verify-spec`.
5. Run `node verify.mjs --spec V --manifest manifest.json --plan plan.json --receipts receipts.json`.

## 3. Strict stopping (executor rules; the verifier re-checks what it can)

- Send no call that isn't in `plan.calls`. Never widen, narrow, split or merge a range, and never change a filter.
- **Calls:** stop after `plan.callCount` calls; there are no retries beyond that budget. A retried call must keep only one receipt per `callIndex`, and the discarded attempt must be stated outside the index.
- **Bytes:** stop when cumulative retained response bytes would exceed the plan's `maxBytes`. The verifier marks any call past the limit `OVER_BUDGET`.
- **Stop with no receipt** (the call stays `MISSING`) on:
  - a transport failure with no response bytes;
  - a timeout;
  - a deliberate stop.
- Never write an empty `result` for a call that failed.

## 4. Outcome distinctions (verifier `83aec5d`)

| What happened | Retain | Verifier status |
|---|---|---|
| Node answered `{"result":[]}` | the response bytes | `VERIFIED_EMPTY`, a valid empty result with no volume claim |
| Node answered logs | the response bytes | `VERIFIED_LOGS` |
| Node answered `{"error":…}`, e.g. a range or result limit | the response bytes | `RPC_ERROR`, giving UNKNOWN |
| No response, or not sent | no receipt | `MISSING`, giving UNKNOWN, listed in `missingCalls` |
| Bytes cut mid-value | the bytes as received | `TRUNCATED_RESPONSE`, giving UNKNOWN |
| Request not exactly the planned one | the bytes as sent | `FILTER_MISMATCH`, giving UNKNOWN |
| Response `id` differs in value or type | the bytes as received | `ID_MISMATCH`, giving UNKNOWN |
| Same `(blockHash, logIndex)` with different content, `removed:true`, or one block with two hashes | the bytes as received | `IDENTITY_CONTENT_CONFLICT`, `REMOVED_READD_OBSERVED` or `BLOCK_HASH_CONFLICT`, giving UNKNOWN |

The optional reth `blockTimestamp` is preserved verbatim, and reported as `ABSENT` when the node omits it.

## 5. Lanes and the same-filter requirement

The manifest has two independent lanes. Each planned range has one call per lane.

| Lane | `filtersetId` | Filter |
|---|---|---|
| PoolManager | `poolmanager.initialize_swap` | address `0x498581ff…2b2b`, `topics: [[Swap, Initialize]]` |
| Launch factories | `o1.factories.raw_all_topics` | the six census rows 1–6, **no `topics` key** (all events, no ABI exclusion, no pool list) |

- **Lanes are judged separately:** a verified PoolManager lane says nothing about factory coverage, and the reverse is also true.
- **Comparisons:** a later direct-vs-native comparison is valid only between receipts or streams with the same `filterSha256` per lane, the same block window and the same caps (the manifest's `comparison` section). That comparison and any measurement clock are out of scope here.

## 6. Census-style narrow receipts cannot stand in (`example-narrow-launched/`)

- **What the example shows:** the existing census requests use the six factories with **only** `topics: ["Launched" 0x207384e8…]` (census `efda199e…` `event_binding.Launched`).
- **Example bytes:** a synthetic set built over the `a345d48` fixture plan.
  - The factory calls 1, 3, 5 and 7 are narrow Launched-only requests; call 3 returns one synthetic Launched log.
  - The PoolManager calls 0, 2, 4 and 6 are byte copies of the `83aec5d` fixture receipts.
- **Integrity:** the original bytes are pinned in `SHA256SUMS.json` and checked before and after the run (3a, 3g).
- **Result (3c–3f):**
  - every factory call is `FILTER_MISMATCH` `request_not_planned_request`, and the Launched log is not credited;
  - the PoolManager lane is `VERIFIED_LOGS`;
  - the verdict is `UNKNOWN`;
  - the report bytes equal `expected.report.json`.

Direct command for the example:

```
W=$(mktemp -d); git archive 83aec5d72f6712711b5f22ef29777858c5b797e0 measurements/backfill-receipts | tar -x -C "$W"
V="$W/measurements/backfill-receipts"
node "$V/verify.mjs" --spec example-narrow-launched/spec.json --manifest "$V/fixtures/manifest.synthetic.json" \
  --plan "$V/fixtures/plan.synthetic.json" --receipts example-narrow-launched/receipts.json
```

## Coverage limitations

- **Receipt integrity:** the receipt shas are caller-made and unkeyed.
  - Consistent bytes don't prove that a node produced them, or that what was sent is what the request file says.
  - A narrow request executed but retained as the planned request can't be detected.
- **Provider truncation:** a node that silently caps or prunes results returns a valid short array, so `ALL_CALLS_RECEIPTED` is not completeness. Range or result limits returned as `error` stay UNKNOWN.
- **Canonicality:** it is not verified, and reorgs deeper than the plan's lookback can't be detected.
- **Example:** the window, block numbers, hashes and logs in it are synthetic; no development-B values are inferred.
- **Out of scope:** Q1/Q2 identity and dedup policy, the measurement clock, #173/native repairs and source admission.

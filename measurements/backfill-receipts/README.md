# backfill-receipts: offline backfill receipt verifier

Checks whether caller-retained RPC receipts cover the calls of a pinned backfill plan. It is synthetic and offline only.

It never executes a call, publishes, uses the network, reads a clock or the environment, scans a directory or writes a file. It is **not** canonicality, completeness, delivery, latency or source-admission evidence, and it never permits live resumption. Q1 and Q2 stay UNADOPTED.

## Pinned contracts

| Input | Contract | Fixture |
|---|---|---|
| Filter manifest | `filter-manifest/1`, FeedEater `42185f2170fb68e5d55b5e8507f480229f58b4df` `measurements/filter-manifest` | `fixtures/manifest.synthetic.json`, sha256 `3a5431c2…`, byte-exact copy of that commit's `evidence/manifest.synthetic.json` |
| Backfill plan | `backfill-plan/1`, FeedEater `a345d48a2f003348d3fe21910518ec1e6e54db35` `measurements/backfill-plan` | `fixtures/plan.synthetic.json`, sha256 `3299b8fb…`, `planSha256` `7e9483a1…`, byte-exact copy of that commit's `evidence/plan.synthetic.json` |

The scope comes from the manifest: PoolManager Initialize/Swap, plus the six launch factories with all topics. There is no fixed pool list.

## Run

```
cd measurements/backfill-receipts
node verify.mjs --spec fixtures/spec.synthetic.json --manifest fixtures/manifest.synthetic.json \
  --plan fixtures/plan.synthetic.json --receipts fixtures/receipts/receipts.json
node test.mjs
```

- `verify.mjs` exits 0 with a report, or exits 2 with `{refused, detail}`.
- `test.mjs` must run from this directory, and needs git with `42185f2` and `a345d48` locally.

## Inputs (every field required; unknown fields, duplicate keys and invalid UTF-8 refused)

- **spec** `backfill-receipt-verify-input/1`:
  - `manifest {fileSha256, manifestSha256}`
  - `plan {fileSha256, planSha256}`
  - `receipts {fileSha256}`
- **manifest:**
  - canonical bytes;
  - the self-hash and every `filterSha256` recompute.
- **plan:**
  - canonical bytes, and `planSha256` recomputes;
  - `inputs.manifest.manifestSha256` equals the manifest's;
  - every call's request equals `eth_getLogs` with its filterset's filter verbatim plus its hex range.
- **receipts index** `backfill-receipts/1`: `{schema, planSha256, receipts: [{callIndex, request: {file, sha256}, response: {file, sha256}}]}`.
  - `callIndex` must be a planned call, with at most one receipt per call.
  - `file` must be a plain basename in the index's directory, opened read-only and no-follow.
  - Only listed files are read; other files in the directory are ignored.
  - The sha256 covers the original bytes.

## Per-call status

| Status | Meaning |
|---|---|
| `VERIFIED_LOGS` / `VERIFIED_EMPTY` | Both shas match. The request is the exact planned `eth_getLogs` and the JSON-RPC `id` matches with the same type. `result` is an array whose logs are strictly valid and fall within the request's address, topic and block range. An empty result is valid, and there is no expected-volume claim. |
| `MISSING` | No receipt for the call. All such calls are listed in `missingCalls`. |
| `HASH_MISMATCH` | The request or response bytes don't match the receipt sha. |
| `FILTER_MISMATCH` | The request differs from the planned request (method, filter or range), or a log falls outside the address, topic0 or range. |
| `ID_MISMATCH` | The response `id` is missing or differs in value or type. |
| `RPC_ERROR` | The response has `error`; its code and up to 200 chars of the message are recorded. |
| `TRUNCATED_RESPONSE` | The bytes end inside an unterminated string or an unclosed object or array. |
| `MALFORMED_RESPONSE` / `MALFORMED_REQUEST` | Other invalid JSON, a duplicate key, or a bad JSON-RPC shape (including result and error both present or both absent). |
| `MALFORMED_LOG` | A log has missing or unknown fields, non-lowercase hex, quantities that aren't minimal, odd-length data, or more than 4 topics. |
| `OVER_BUDGET` | Cumulative response bytes, in call order, exceed the plan's `maxBytes`. |
| `IDENTITY_CONTENT_CONFLICT` | The same `(blockHash, logIndex)` appears with different content (excluding `removed`). |
| `REMOVED_READD_OBSERVED` | `removed:true` was seen for an identity, alone or with a re-add. |
| `BLOCK_HASH_CONFLICT` | One `blockNumber` appears with two block hashes. |

- **Logs:** a log's fields are `address, topics, data, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, removed`, plus an optional reth `blockTimestamp`.
- **`blockTimestamp`:** preserved verbatim when present, and reported as `ABSENT` otherwise.
- **`removed`:** every observation is recorded as `removed`.
- **Log content:** content other than these fields is reported only as `contentSha256` (the canonical log without `removed`).

## Verdict

- `ALL_CALLS_RECEIPTED` requires both:
  - the plan status is `PLANNED` and it isn't truncated;
  - every planned call is `VERIFIED_*`.
- Anything else is `UNKNOWN`: a missing call, an error, an ambiguity, a truncated or UNKNOWN plan.
- **Always set:**
  - `publicationProvenance {backfill:true, live:false}` and `resumeLive.permitted:false`;
  - claims: binding UNKNOWN, canonicality UNVERIFIED, sourceAdmission NOT_ESTABLISHED, completeness NOT_ESTABLISHED, latency NOT_MEASURED;
  - policy: Q1/Q2 UNADOPTED.

## Limitations

- **Receipts:** these are caller-supplied, unkeyed shas. A matching receipt proves byte consistency, not that a provider produced the bytes or that they are canonical.
- **Provider truncation:** a provider that silently caps or prunes results can return a valid but short array. This can't be detected here, so `ALL_CALLS_RECEIPTED` is not completeness.
- **Truncation:** detected only as bytes ending inside an open JSON value. Other cut points are `MALFORMED_RESPONSE`.
- **Identity:** the identity key `(blockHash, logIndex)` is a verification aid, not an adopted Q2 identity. Removed/re-add is only reported, never resolved.
- **Byte budget:** checked against retained response bytes, not wire bytes.
- **Tests:**
  - plan variants are produced by the pinned `a345d48` `plan.mjs`, extracted with git;
  - `gen.mjs` fixtures are synthetic.

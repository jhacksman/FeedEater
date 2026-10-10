# backfill-plan (standalone, offline)

This tool builds an inert durable reconnect/backfill **plan** for a persistent collector. It is a separate thing from the clock-window blocker.
- It reads one caller spec and one pinned filter manifest (`filter-manifest/1`, from `measurements/filter-manifest` at `42185f2`), then prints capped `eth_getLogs` ranges on stdout.
- It never executes a call, publishes anything, uses the network, reads T7, the environment or a clock, or writes files.
- Q1 and Q2 stay unresolved, and no dedup, identity or subject-name policy is chosen.

## CLI

`node plan.mjs --spec <spec.json> --manifest <filter-manifest.json>`

- Exit 0 prints a plan, whatever its status.
- Exit 2 prints `{"refused":<reason>,"detail":…}`.
- Paths resolve against the cwd. Symlinks and non-regular files are refused.

## Input `backfill-plan-input/1`

Every field is required and unknown fields are refused. Duplicate JSON keys, `__proto__` and invalid UTF-8 are also refused. All integers must be safe integers.

```json
{ "schema": "backfill-plan-input/1",
  "manifest":   { "fileSha256": "<sha256 of manifest bytes>", "manifestSha256": "<manifest self-hash>" },
  "source":     { "chainId": 8453, "sourceId": "[a-z0-9][a-z0-9._:-]{0,127}" },
  "checkpoint": { "source": {…}, "manifestSha256": "…", "blockNumber": C, "blockHash": "0x…64", "recordedAtUtc": "…Z" },
  "head":       { "source": {…}, "blockNumber": H, "blockHash": "0x…64", "observedAtUtc": "…Z" },
  "evidence":   { "checkpointBlockHashAtHead": "0x…64" | null, "removedLogsSeen": true | false | null },
  "lookbackBlocks": L,
  "caps": { "maxGapBlocks": ≥1, "maxChunkBlocks": ≥1, "maxCalls": ≥1, "maxBytes": ≥1 } }
```

The checkpoint durable identity is the block number, block hash, `source` and `manifestSha256`.
- The head, its observation time and all of `evidence` are caller-supplied and **unverified**.
- `checkpointBlockHashAtHead` is the hash the fresh source reports at height C.
- `removedLogsSeen` records whether any `removed:true` log was seen since the disconnect.

## Manifest checks (refusal reasons)

- *File hash:* `manifest_file_hash_mismatch`.
- *Canonical bytes:* the file must be canonical JSON plus a newline, otherwise `manifest_noncanonical`.
- *Schema:* `manifest_schema_mismatch`.
- *Hashes:*
  - the self-hash must recompute (`manifest_self_hash_mismatch`);
  - each `filterSha256` must recompute (`manifest_filter_hash_mismatch`);
  - the self-hash must equal the spec's pin (`filter_identity_mismatch`).
- *Filtersets:* ids must be unique, and each filter is `{address[], topics?}` (`manifest_filtersets_invalid`).

## Identity checks (refusal reasons)

- `chain_mismatch`
- `checkpoint_source_mismatch`
- `head_source_mismatch`
- `checkpoint_filter_identity_mismatch`: the checkpoint was recorded under another manifest.
- Plus `value_invalid`, `spec_*`, `json_*` and `usage*`.

## Predeclared rules

| rule | statement |
|---|---|
| overlap | Re-read `[max(0, C−L+1), C]`, where L ≥ 1 and L ≤ maxGapBlocks. The checkpoint block is always re-read. |
| gap | Read `[C+1, H]` when 1 ≤ H−C ≤ maxGapBlocks. H = C plans the overlap only. H−C > maxGapBlocks gives `GAP_EXCEEDS_CAP` with no calls. |
| chunking | Ranges ascend, each at most maxChunkBlocks long, overlap first. Each range has one call per filterset, in manifest order. |
| budget | If the calls exceed maxCalls, only the first maxCalls are emitted (`TRUNCATED_CALL_BUDGET`) and the `uncovered` range is stated. maxBytes is an executor stop limit, with outcome UNKNOWN; it is not a volume estimate. |
| reconciliation | `UNKNOWN_NEEDS_RECONCILIATION` with no calls, and every reason listed, when any of these hold: the checkpoint hash evidence is null or conflicting; `removedLogsSeen` is true or null; H < C; H = C with a different hash; the head was observed before the checkpoint was recorded. |
| history limit | Nothing below `max(0, C−L+1)` is ever requested. Reorgs deeper than L, and provider log retention or pruning, are not detectable here. An executor that can't serve a range must report UNKNOWN, never empty. |
| resume live | `resumeLive.allowed` is always false. `candidateFromBlock` is H+1 only for `PLANNED`. Live may resume only after the executor has completed every call within maxBytes and re-verified canonicality. |

## Output `backfill-plan/1`

The output is canonical JSON. It contains:
- `status` and `reasons`;
- `inputs`: the spec sha and manifest pins, with head and evidence marked `UNVERIFIED_CALLER_SUPPLIED`;
- `rules` and `span`;
- `calls[]`: `{segment, filtersetId, filterSha256, fromBlock, toBlock, request:{method:"eth_getLogs", params:[filter + hex range]}, publicationProvenance:{backfill:true, live:false}}`;
- `truncated` and `uncovered`;
- `backfillSubject`: class `backfill`, name `UNADOPTED`, `mustDifferFromLiveSubject: true`;
- `claims`: binding UNKNOWN, canonicality UNVERIFIED_CALLER_SUPPLIED, sourceAdmission NOT_ESTABLISHED, completeness and latency NOT_MEASURED;
- `planSha256`.

## Tests

`node test.mjs > test.out` runs synthetic acceptance cases. The output is deterministic, with no timing.
- `fixtures/manifest.synthetic.json` holds the exact bytes of filter-manifest `42185f2` `evidence/manifest.synthetic.json`.
- `fixtures/spec.synthetic.json` uses placeholder blocks, hashes and times.
- `evidence/results.json` holds expected vs actual for every case, and `evidence/plan.synthetic.json` is the synthetic plan.

## Limits

- *Unverified inputs:* hash evidence, the head and the timestamps are caller assertions. Nothing is verified against a chain.
- *Head age:* not evaluated, because no clock is read. The only staleness check is head observation against checkpoint record time.
- *Reorgs:* reorg depth beyond L is undetectable. Removed/re-add resolution is deferred to reconciliation, since the Q2 identity is unadopted.
- *Byte caps:* response sizes are unknown in advance, so maxBytes can only be enforced by an executor, which isn't included here.

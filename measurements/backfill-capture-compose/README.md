# backfill-capture-compose

This is an offline composition of the inputs for a root-operated capture of 5 calls or fewer. From one explicit root spec, `compose.mjs` runs the **pinned, hash-checked** reviewed components:

- filter-manifest `42185f2` `compile.mjs`;
- backfill-plan C1 `a345d48` `plan.mjs`;
- capture C1 `56f8f3b` `preflight` only;
- full-coverage contract `d568aee` `check.mjs`.

It emits their exact bytes with shas and the exact commands for capture C1 and verifier `83aec5d`. Nothing is re-implemented: parsing is `plan.mjs` `strictParse`, and every validation is the pinned component's own.

There is no transport, network, node, T7, environment, clock or deploy. Nothing is defaulted or inferred: every null or `UNRESOLVED*` value anywhere in the spec is refused, all listed together, before any output.

## Run

```
node compose.mjs --spec <compose-input.json> --components <dir> --out <new dir>
node test.mjs    # needs git with the 5 commits below; extracts them into ./work, removed at the end
```

`--components` is a root-chosen directory. It holds these exact files, each checked by sha before import, with no symlinks allowed:

| component | file | commit | sha256 |
|---|---|---|---|
| compile | `filter-manifest/compile.mjs` (+ `sources/aromer-5669951/`, which compile pins itself) | 42185f2 | a01e632e… |
| keccak | `filter-manifest/keccak.mjs` | 42185f2 | f2cd3d33… |
| plan | `backfill-plan/plan.mjs` | a345d48 | c527e180… |
| capture | `backfill-receipt-capture/capture.mjs` | 56f8f3b | d2c13953… |
| check | `full-coverage-filter-contract/check.mjs` | d568aee | d1d450d3… |
| verify | `backfill-receipts/verify.mjs` | 83aec5d | 0eb02c03… |

To build it from a clone: `for c in 42185f2:filter-manifest a345d48:backfill-plan 56f8f3b:backfill-receipt-capture d568aee:full-coverage-filter-contract 83aec5d:backfill-receipts; do git archive ${c%%:*} measurements/${c#*:} | tar -x --strip-components=1 -C "$COMPONENTS"; done`

## Input `backfill-capture-compose-input/1` (strict; all root-owned)

| field | goes to |
|---|---|
| `filterSpec` | `filter-spec.json`, then `compile.mjs` (`filter-manifest-input/1`, unchanged) |
| `planInputs{source, checkpoint, head, evidence, lookbackBlocks, caps}` | `plan-spec.json` = `{schema, manifest: <pins of the compiled manifest.json>, ...planInputs}`, then `plan.mjs`; `checkpoint.manifestSha256` must be supplied by root and is checked by plan.mjs |
| `captureLimits{maxCalls, paceMs, timeoutMs, maxResponseBytes, maxTotalBytes}` | `capture-spec.json` with the derived pins, then capture C1 `preflight` (its ceilings, PLANNED/untruncated, `callCount <= maxCalls`, `--out` freshness/containment) |
| `contract{window, caps, comparison, observationClock, subjects}` | `contract.json` with the derived pins and lane shas, then `check.mjs`; anything but `CONTRACT_CONSISTENT` is refused |

The only derived values are the manifest/plan pins and the lane `filterSha256`s, read from the pinned tools' own output. The capture `preflight` is given a fixed, never-contacted placeholder endpoint; that endpoint is not emitted.

## Output (only after every stage passes)

`--out` is created with mode 0700 and must not exist; its parent must exist and must not be a symlink. Every file is created exclusive and no-follow, with mode 0600; writes are looped, fsynced and read back:

`filter-spec.json`, `manifest.json`, `plan-spec.json`, `plan.json`, `capture-spec.json`, `contract.json`, `verify-spec.template.json`, `handoff.json` (written last).

`handoff.json` records:
- the component pins and every file's sha and byte count;
- the plan status, calls and ranges;
- the contract verdict and `reportSha256`;
- the capture limits;
- `transportExecuted:false`, `backfill:true/live:false`, `resumeLive.permitted:false`;
- admission NOT_ESTABLISHED and Q1/Q2 UNADOPTED;
- the commands, run from the output directory with root-set `COMPONENTS`, `ROOT_ENDPOINT` and `ROOT_CAPTURE_OUT`:
  - `rebuildManifest` and `rebuildPlan` (each `| cmp -` against the emitted file);
  - `checkContract`;
  - `capture` (capture C1; root runs it, never compose);
  - `verify` (83aec5d, after root writes `verify-spec.json` from the template with the sha of the captured `receipts.json`).

**Exit codes:** 0 `COMPOSED`; 2 refused (`{refused, detail}`, no output created); 4 internal; 5 `WRITE_FAILED` (`persisted[]`, `writeFailure{file, stage, bytesWritten, code}`, with no `handoff.json`).

## Still root-only after compose

- `COMPONENTS`;
- `ROOT_ENDPOINT`;
- `ROOT_CAPTURE_OUT` (a new directory);
- the receipts sha in `verify-spec.json`.

The real development-B values are also still root's to supply: C/H numbers, hashes and times, `sourceId`, the hash/removed evidence, L, caps, the clock id and window, the subjects, and the direct/native filters.

## Limits

- *Hash-then-import gap:* components are sha-checked and then imported by path, so a file swapped between the check and the import isn't detected. Importing `capture.mjs` loads `node:http`/`https`, but compose calls only `preflight`.
- *Capture readiness:* `preflight` checks the `--out` path's freshness at compose time. The later capture `--out` is a separate root-chosen directory, checked by capture itself.
- *Synthetic fixture only:* the 42185f2 filter spec, the C1 4-call plan inputs (window [1000, 1100]), the C1 limits and the d568aee contract values.
- *Write failures:* a failure after `mkdir` leaves a partial directory with no `handoff.json`.

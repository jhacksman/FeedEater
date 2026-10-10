# native-diagnostic-guard (FIRST)

Loopback-only, read-only JSON-RPC **transport budget guard** for a root-operated isolated diagnostic of frozen #173
`5206f9035ad1c057d78990b294941221e936f895` (`modules/base-collector`). It sits between the native process's
`BASE_COLLECTOR_HTTP_URL` and the root's node HTTP endpoint. It is not a source-latency path and not a collector: it
cannot turn filtered, buffered or missed native publications into live delivery, and it claims no admission,
completeness, latency or acceptance. It never contacts a node on its own; root owns the predeclaration and the run.

## Commands

```
node guard.mjs plan  --spec <ROOT_SPEC>                     # validate, print runplan (no listener, no network)
node guard.mjs serve --spec <ROOT_SPEC> --upstream <ROOT_UPSTREAM_HTTP> --out <new dir under projectAromer>
```

All inputs are explicit arguments; no env, PATH or cwd defaults. `serve` prints one line
`{"listening":"http://127.0.0.1:<port>/","runplanSha256":...}`; root sets `BASE_COLLECTOR_HTTP_URL` to that URL.
Exit: 0 `COMPLETE` (every budgeted call served ok), 3 `STOPPED`, 5 `WRITE_FAILED`, 2 refused (no output), 4 internal.

## Contract

- **Spec** (`native-diagnostic-guard-spec/1`, strict JSON, see `fixtures/spec.synthetic.json`): `source.commit` must be
  `5206f90…`; `projectAromer` (absolute, its own realpath); `native.env` (only native `BASE_COLLECTOR_*` keys from
  `src/config.ts`; `HTTP_URL` refused, it is the guard); `native.measure` (`out` under `projectAromer`, warmup/window/
  teardown seconds, `poolsFromCheckpoint` path or `false`); `rootInputs` (checkpoint `verifiedBlock`/`blockHash`/
  `fileSha256`, head `number`/`hash`, window `clockId`/`startUtc`/`endUtc`, exact native `filters`); `limits`; `allow`.
- **Unresolved inputs:** any `null`/`"UNRESOLVED"` or missing required env key (`WS_URL`, `NATS_URL`, `DATABASE_URL`,
  `STATE_DIR`, `START_BLOCK`, `PERSIST_START_BLOCK`) → `root_inputs_unresolved` with every path. Nothing is defaulted
  or derived; values are shape-checked only, never verified against a node.
- **Allowlist:** each entry is one exact `{method, params}`; only `eth_blockNumber []` and `eth_getLogs [filter +
  hex fromBlock/toBlock]`, filter byte-equal (canonical) to a declared `rootInputs.filters` entry, range
  ≤ `maxRangeBlocks`; no tags, no `blockHash`. Each entry is consumed once; request `id` is not matched.
- **Limits:** `maxCalls` ≤ allowlist ≤ 64; `paceMs` ≥ 1250, `timeoutMs` ≤ 8000, `maxResponseBytes` ≤ 1 MiB (the
  `CEIL` of capture C1); `maxTotalBytes`; `maxDurationMs` ≤ 6 h; `maxRangeBlocks` ≤ 500; request body ≤ 64 KiB.
- **Before upstream:** non-POST/non-`/`, oversize, malformed (strict parser: duplicate keys, batch, extra keys,
  non-integer id), other methods, unlisted or already-consumed calls, and budget overrun are refused (HTTP 403) and
  STOP the guard; the request bytes are kept as `refused-N.request.bin`.
- **Upstream:** one call in flight (FIFO), next send ≥ `paceMs` after the previous completion, whole-call deadline,
  byte cap, original request bytes forwarded unchanged and the exact response bytes returned. First error (timeout,
  transport, HTTP status, oversize, total cap, RPC error, malformed or id-mismatched response, write failure) STOPs:
  no retry, queued calls are not sent. Oversize keeps the received prefix as `call-N.response.partial` with
  `partialSentinel {truncatedAtBytes, complete:false}`.
- **Output** (`--out`, new 0700 dir under `projectAromer`): `runplan.json` first, `call-N.request.json`,
  `call-N.response.json|partial`, `refused-N.request.bin`, `guard-log.json` last. Files are `O_EXCL|O_NOFOLLOW`, 0600,
  looped writes, fsync, readback. A failed write is disclosed (`writeFailures`, possibly a zero-byte or partial file);
  only exit 0 + `COMPLETE` + `log.persisted:true` with matching shas is a complete guard record.
- **Runplan** (`native-diagnostic-guard-runplan/1`, `runplanSha256` over its canonical body): source, build, the
  collect/persist/measure argv, native env (URLs hashed), all env keys, HTTP users at `5206f90`, what is not guarded,
  root inputs, limits, allowlist sha, claims. Synthetic example: `evidence/runplan.synthetic.json`.

## Reuse

`vendor/capture.mjs` is byte-identical to capture C1 `56f8f3b` (blob `b9f0aaa9…`, sha256 `d2c13953…`); the guard
refuses to load if it differs and uses its `strictParse`, `canonical`, `httpTransport`, `Refusal` and `CEIL`. The
exclusive writer is a copy of capture C1's (not exported there).

## Limits (stated, not fixed)

- **Only HTTP is guarded.** At `5206f90` HTTP is used by `collect` (`src/main.ts:70`: `eth_blockNumber`, reconnect
  backfill `eth_getLogs`) and `verify-persist` (`:201`). `measure` uses no HTTP: its direct comparator is the WebSocket
  subscription (`:159-164`). WebSocket `eth_subscribe` load, NATS and PostgreSQL are outside the guard.
- **Exact params vs runtime ranges.** Native backfill ranges come from the checkpoint and the head at connect, in
  `backfillChunkBlocks` chunks; any call root did not predeclare exactly is refused and STOPs the guard, which the
  native process sees as an RPC failure. This is the intended fail-closed behaviour, not a retrofit.
- No clock/window repair: `rootInputs.window` is declared and hashed only; `5206f90` consumes none of the root inputs.
- Directories are not fsynced; readback proves bytes through the same fd.
- Synthetic, loopback-only tests: `node test.mjs` (needs `/usr/bin/git` for the vendor blob check).

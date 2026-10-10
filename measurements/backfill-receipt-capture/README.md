# backfill-receipt-capture: root-operated receipt capture for verifier 83aec5d

`capture.mjs` is root-operated. It sends **only** the calls of a pinned `PLANNED` backfill plan to an endpoint that root supplies, one at a time, and retains the exact request and response bytes together with sha/attempt sidecars that verifier `83aec5d` can read.

It never runs the verifier, retries, re-chunks, prints payload, or grants live/backfill resumption. Q1 and Q2 stay UNADOPTED, and nothing it produces is latency, completeness, canonicality or source-admission evidence.

The tests use only a fake HTTP server on 127.0.0.1. **No real node or public endpoint has been called. Codex reviews before any real call.**

## Pinned inputs

- **Manifest:** `filter-manifest/1` @ `42185f2`.
- **Plan:** `backfill-plan/1` @ `a345d48`.
- **Verifier:** `backfill-receipts/1`, which is the output format; verifier @ `83aec5d` (`verify.mjs` `0eb02c03…`).
- **Shared code:** manifest/plan loading and the strict JSON parser are copied from `83aec5d` `verify.mjs` lines 15–153.

## CLI contract

```
node capture.mjs --spec <spec.json> --manifest <manifest.json> --plan <plan.json> --endpoint <http(s)://...> --out <new-dir>
```

- **Arguments:** all five are required, exactly once each; anything else is refused with `usage`.
- **Root-supplied values:** the endpoint and `--out`. The tool has no default paths and reads no environment.
- **Endpoint:** must be `http:` or `https:` with no userinfo. It is recorded only as `endpointSha256`, never printed. Redirects aren't followed, since a non-200 response stops the run.

### Spec `backfill-receipt-capture-input/1` (strict: no unknown, missing or duplicate keys)

```json
{ "schema": "backfill-receipt-capture-input/1",
  "manifest": { "fileSha256": "<64 hex>", "manifestSha256": "<64 hex>" },
  "plan": { "fileSha256": "<64 hex>", "planSha256": "<64 hex>" },
  "limits": { "maxCalls": 1-5, "paceMs": >=1250, "timeoutMs": 1-8000, "maxResponseBytes": 1-1048576, "maxTotalBytes": 1-plan.caps.maxBytes } }
```

### Preflight (all checks before any transport; exit 2 `{refused, detail}` and no output directory created)

- **Spec:** strict shape, and all limits within the hard ceilings above.
- **Manifest and plan:** canonical bytes, with the file sha and self sha equal to the spec pins. Every plan call must bind to the manifest filter.
- **Plan status:** `status` must be `PLANNED` and `truncated` false; otherwise `plan_not_capturable`, which also covers `UNKNOWN_NEEDS_RECONCILIATION`, `GAP_EXCEEDS_CAP` and `TRUNCATED_CALL_BUDGET`.
- **Call budget:** `callCount` must be between 1 and `limits.maxCalls`. A larger plan is refused (`call_budget_exceeds_limit`), never sliced.
- **Byte budget:** `maxTotalBytes` must be ≤ the plan's `maxBytes`.
- **`--out`:** must not exist. Its parent must exist and be a directory, and no ancestor may be a symlink.

### Transport

- The directory is created with `mkdir` (non-recursive, mode 0700).
- Calls go in plan order, one in flight, with at least `paceMs` between them.
- Each body is `{"jsonrpc":"2.0","id":<index+1>,"method":"eth_getLogs","params":[plan.calls[i].request.params[0]]}`.
- Each call is a single POST under a whole-call deadline of `timeoutMs`. Response bytes are capped at `min(maxResponseBytes, maxTotalBytes − bytes so far)`.

**Before each call**, if `maxTotalBytes − bytes so far` is 0, the run stops with `total_bytes_exhausted` (`sent:false`). No request file is written, no POST is sent, and that call and every later one are listed in `notAttempted`.

**Stop on the first** of the following. There is no retry, and later calls are not attempted:

| Outcome | Meaning |
|---|---|
| `transport_error` | refused or reset connection, or a socket error |
| `timeout` | the deadline passed |
| `http_status` | a non-200 response |
| `response_oversize` | the per-response cap was hit |
| `total_bytes_cap` | the total cap was hit |
| `rpc_error` | the response has an `error` member |
| `response_unparsed` | a 200 response that isn't a JSON object with a `result` array |
| `request_write_failed` | the request file couldn't be fully persisted; nothing is sent (`sent:false`) |
| `response_write_failed` | the response bytes couldn't be fully persisted; the call isn't receipted (`sent:true`) |

### Output (every file created with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, inside `--out` only)

Each file is persisted in four steps, and its sha is recorded only after the readback matches:
1. Short writes are looped by offset until the whole buffer is written. A zero, negative or over-long return gives `write_no_progress`.
2. The file is fsynced.
3. It is read back through the same fd.
4. The readback must be byte-equal to the buffer, otherwise `readback_mismatch`.

A failure at any stage (`open`, `write`, `write_no_progress`, `fsync`, `readback`, `readback_mismatch`) is recorded as `{file, stage, bytesWritten, code}`. Then:
- that file isn't listed in the index;
- the run stops;
- the status becomes `WRITE_FAILED` (exit 5). This includes failures of `receipts.json` or `attempts.json` themselves; the summary then reports `persisted:false` and `sha256:null`.

| File | Content |
|---|---|
| `call-<i>.request.json` | exact bytes sent, written **before** sending |
| `call-<i>.response.json` | exact bytes of a complete HTTP 200 body, including `rpc_error` and `response_unparsed`; listed in `receipts.json` |
| `call-<i>.response.unreceipted` | exact partial or non-200 bytes (timeout, reset, oversize, total cap, HTTP status); **never** in `receipts.json` |
| `receipts.json` | `backfill-receipts/1` index for `83aec5d`; only the complete-200 receipts |
| `attempts.json` | `backfill-receipt-capture-attempts/1`: pins, limits, `endpointSha256`, and per-attempt `{callIndex, request{file, sha256, bytes, persisted}, outcome, transport, httpStatus, error, response{file, sha256 (null unless persisted), receivedSha256, bytes, complete, persisted, write}, receipted}`, plus `stop{callIndex, outcome, sent, write?}`, `writeFailures`, `receiptsIndex{sha256, persisted}`, `notAttempted`, `totalResponseBytes`, `retries: 0`, `backfill:true/live:false`, `resumeLive.permitted:false` |

- **stdout:** a canonical summary only: status, stop, counts, file shas, `verifierRun:false`. It carries no payload and no endpoint.
- **Exit codes:**
  - 0: `CAPTURED_ALL_PLANNED`;
  - 3: `STOPPED`, with partial output kept;
  - 5: `WRITE_FAILED`;
  - 2: refused;
  - 4: internal error.
- **Verifying the result:** for `83aec5d`, write a `backfill-receipt-verify-input/1` spec that pins `receipts.json`'s sha, then run the verifier separately. Any call that wasn't attempted stays `MISSING`, giving UNKNOWN; an empty result is never fabricated.

## Tests

```
cd measurements/backfill-receipt-capture && node test.mjs     # 62 PASS on Linux node v24
```

- **Requirements:** git with `a345d48` and `83aec5d`.
- **Server:** each case runs against a fake server on 127.0.0.1 with port 0.
- **`fixtures/plan.4calls.json`:** regenerated byte-identically by the pinned `plan.mjs` from `fixtures/planspec.4calls.json` (C=1000, H=1100, L=1, giving 4 calls).

Coverage:

- **Complete run:**
  - exact request bytes, the planned params and the ids;
  - response bytes preserved, including CRLF and whitespace;
  - pacing of at least 1250 ms, and at most one call in flight;
  - no payload or endpoint on stdout;
  - the separate verifier run gives `ALL_CALLS_RECEIPTED`.
- **RPC error on call 1:** stops; the error bytes are receipted; calls 2 and 3 are not attempted; the verifier gives `UNKNOWN` with `RPC_ERROR` plus `MISSING [2,3]`.
- **Each stop outcome:** exact preservation of partial bytes, and the attempt accounting.
- **Refusals (24):** each with zero requests reaching the server.
- **B1 (byte budget):**
  - a 36 B cap with a 36 B first body gives exactly 1 POST, `total_bytes_exhausted`, and the verifier reports `MISSING [1,2,3]`;
  - a cap equal to the exact sum gives 4 POSTs and success;
  - a cap of sum − 1 gives `total_bytes_cap` on call 3.
- **B2 (write faults):** test-only `--import` fault injector.
  - These complete exactly: a first write of 16 B, or every write capped at 7 B.
  - These give `WRITE_FAILED` with exact POST counts: a zero return; request EIO; corrupted request bytes; response EIO; a 5 B partial write then EIO; response fsync EIO; `receipts.json` EIO; `attempts.json` partial then EIO.
- **Static checks:**
  - none of: child_process, env, directory scans, non-exclusive writes, deletes, wall clock, hardcoded paths, fetch, retry;
  - exactly one `.request(` call, one `writeSync`, one `fsyncSync`, and a readback.

## Limitations

- **Never called a real node:** behaviour against a real node, TLS, proxies or HTTP compression is untested.
- **Compression and encoding:** the tool requests no compression and stores bytes exactly as delivered by Node's HTTP stack, which handles chunked transfer encoding. It doesn't decode `content-encoding`.
- **Per-attempt cap:** `maxResponseBytes` caps each attempt, and the total cap counts the bytes retained, not wire bytes or headers.
- **Unclassified response shapes:** a 200 body with a `result` that is not an array, or a malformed log, is receipted as received. Classification is left to the verifier.
- **Pacing:** a minimum gap measured from the previous call's completion. It is not a rate-limit guarantee against the provider.
- **Receipt shas:** unkeyed. They don't prove provider origin.
- **Out of scope:** the development-B window, endpoint choice and any real run belong to root, after Codex review.

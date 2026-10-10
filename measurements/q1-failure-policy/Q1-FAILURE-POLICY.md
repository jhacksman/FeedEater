# Q1 failure-policy contract and fault matrix (inert, docs only)

**Status:** every policy here is **UNADOPTED**. This document resolves nothing about Q1 (DAT-PRV-002 every-record `raw_ref` vs DAT-PRV-001 decision path never waiting on the writer) or Q2 (the natural key). Unknown values stay unknown. All timings cited are synthetic, measured on one host for the prototype; none of them is native, live-latency, admission or owner-acceptance evidence.

**Source pin:** the raw prototype correction 1, `1bbabb2ce72bb21c48d885f181a3455462923378` (tree `2244520ee65281b0db6d6955640cbfcd600cc03a`), files `measurements/raw-tier0-prototype/*`. That candidate is held for whole A7/Codex review and is not modified here. Paths below are relative to that directory.

**Spec pins:** SPEC-v1 `main` `68da358` `docs/spec/v1/SPEC-v1.md`:
- DAT-PRV-001 at l.1076;
- DAT-PRV-002 at l.1078-1089;
- DAT-TIM-001 at l.1116-1123.

## 1. Traced paths at the pin
1. **Receive metadata:** the fixture supplies `t_recv_wall_ns`, `t_recv_mono_ns` and `clock_source: "fixture_supplied"` (`fixture.mjs:45-47`), plus `boot_id`, `host_id`, `connection_id`, `subscription_id` and `source_id`. No clock is read anywhere.
2. **Publication:** `decision` (`producer.mjs:144-151`) runs synchronously.
   - It decodes and publishes in memory (`published[i] = tier1Line(f.raw)`, l.147), then calls `offer`. The published value has **no `raw_ref`**.
   - `offer` (l.132-142) either queues the frame or drops it as overflow, recording the drop in `lostRanges` (l.136).
3. **Hand-off:**
   - `pump` (l.116-130) moves a queued frame to `inflight` with the producer's own raw and metadata sha256 (l.122), then writes it to the pipe.
   - `startWriter` (l.88-115) assigns `epoch` = the writer's start number.
4. **Append:**
   - The writer opens the segment `O_NOFOLLOW` (`writer.mjs:25-26`), or creates it `O_EXCL` (l.34), and checks its header identity (l.42-46).
   - On recovery it refuses corruption (l.48-50) and quarantines a proven torn tail before `ftruncate` (l.56-64).
   - It appends at an explicit offset (l.108), queues the ack (l.111), and `flush` fsyncs before emitting the acks (l.76-81).
5. **Ack:** `onMsg` (`producer.mjs:59-86`) accepts an ack only if `segment_id`, `epoch`, `sha256`, `metaSha256` and the offsets match (l.70-76). Otherwise it rejects the record (l.75).
   - It also handles `conflict` (l.78-79), writer `rejected` (l.81) and `gap` (l.82).
   - A writer exit that isn't a crash we induced becomes `writerFailed` (l.113).
6. **Replay:** `readSegment` / `scan` (`tier0.mjs:59-93`) and the `decode` pure function of (raw, registry, decoder) (`tier1.mjs:10-24`). There is **no lookup-by-ref API**; the tests read by `rawOffset`.

## 2. Candidate `raw_ref` state machine (UNADOPTED)
`PUBLISHED_UNREFERENCED` → `QUEUED` → `SENT` → one of:
- `DURABLE_ACKED`: the ref is `{segment_id, ack_epoch, file, offset, length, rawOffset, rawLength, sha256, metaSha256, via}`.
- `LOST_OVERFLOW`: terminal; the seq is in `lostRanges`.
- `REJECTED`: terminal; `ack_mismatch_*`, `writer_conflict` or `writer_out_of_order`.
- `UNKNOWN_WRITER_FAILED`: the writer refused or exited.
- `UNKNOWN_ABORTED`: still in flight when stopped.

`SENT` --crash--> requeued, then re-enters `SENT` (resent; ends as a `recovery` or `dup_identical` ack, or `REJECTED`).

Only `DURABLE_ACKED` has a `raw_ref`. Every other state has `raw_ref: unknown`, never a predicted value; `t_ingest` is `unknown` in all states.

The prototype keeps the equivalent sets (`acked`, `rejected`, `lostRanges`, `inflight`/`queue`), but it never joins the ack back to the published record. That join is the Q1 choice.

## 3. Q1 policy options (all UNADOPTED, no recommendation)
- **P-A, async join:** publish without `raw_ref`, and complete provenance later by joining on `(source_id, run segment_id, seq)`. DAT-PRV-002 is then met only after the join, and records that never join stay `unknown` and are counted.
- **P-B, publish after ack:** this conflicts with DAT-PRV-001 (the decision path never waits on the writer) and with LAT-006's publish-first rule.
- **P-C, scope:** DAT-PRV-002 would apply to accepted Tier-1 records, not to in-memory publication. This is a spec reading only you can make.
- **Excluded by instruction:** a `raw_ref` or `t_ingest` predicted before the append.

## 4. Receive-time provenance (candidate, UNADOPTED)
- **Candidate fields:** `t_recv_wall_ns` and `t_recv_mono_ns` as int64 ns, captured at socket read before decoding, plus `clock_source`, `boot_id`, `host_id`, `connection_id`, `subscription_id` and `source_id`.
- **Not known:** the clock offset and uncertainty (DAT-TIM-001) stay `unknown`. The prototype's values are fixture-supplied, so no clock binding is demonstrated.
- **`t_ingest` candidates:** (a) the writer's wall clock at append, (b) at fsync, (c) when the producer receives the ack. None is chosen.

## 5. Replay lookup semantics (candidate)
To resolve a ref, open `file` `O_NOFOLLOW`, check the header's `segment_id`, and read `length` bytes at `offset`. Then check the magic, the record sha, raw `sha256` = sha(raw at `rawOffset`, `rawLength`) and `metaSha256`.
- If the file is absent, foreign or corrupt, the result is `unresolvable`, never a substitute.
- A quarantined tail is never a resolvable ref: it was never acked.
- *Support:* the format and tests support this. There is no API for it, so implementing one is future work.

## 6. Invariants: supported by the code vs requiring your Q1 choice and future work
The fault matrix is `q1-fault-matrix-2026-10-10.json` (F1-F12). Its `support` field is one of:
- `code+test@pin`: implemented and exercised by `test.mjs` at the pin;
- `code@pin-untested`;
- `requires_owner_Q1`;
- `requires_future_impl`.

**Supported at the pin:**
- an ack only after fsync;
- a binding ack;
- corruption refused with the bytes untouched;
- only a torn tail is quarantined;
- overflow accounted for;
- explicit gaps and out-of-order seqs;
- explicit conflicts;
- refusal ≠ timeout;
- cleanup of owned PIDs only.

**Needs your Q1 choice:** the published record's `raw_ref`/`t_ingest` and DAT-PRV-002 completeness.

**Needs future implementation:**
- reconnect/connection-scoped seq;
- a lock or fencing against concurrent writers;
- a lookup API;
- rotation and disk-full;
- a durable producer-side retention;
- real clock capture;
- parent-directory symlink checks.

## 7. Limits
- Docs and inert JSON only; no executable claims beyond what `test.mjs` at the pin exercises.
- Spec line numbers are as pinned in the earlier audit and proposal; they were not re-fetched.
- The Linux test counts at the pin (52 PASS) are as reported and have not been root-verified by A7.
- Concurrent-writer and reconnect behaviour is reasoned from the code, not run.
- No owner decision is recorded or inferred.

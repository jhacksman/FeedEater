# Q1 failure-policy contract and fault matrix (inert, docs only) — correction 1 of `63abd0c`

**Correction 1 (A7 `84999201`, 1 MED and 2 LOW):** this round records the failures that actually exist at the pin. The source pin is unchanged. A later raw candidate, `94a0ae0`, exists and is frozen under whole review. This document is **not** repinned to it and makes no claim that it is accepted or that it repairs anything.

**Status:** every policy here is **UNADOPTED**. This document resolves nothing about Q1 (DAT-PRV-002 every-record `raw_ref` vs DAT-PRV-001 decision path never waiting on the writer) or Q2 (the natural key). Unknown values stay unknown. All timings cited are synthetic, measured on one host for the prototype; none of them is native, live-latency, admission or owner-acceptance evidence.

**Source pin:** the raw prototype correction 1, `1bbabb2ce72bb21c48d885f181a3455462923378` (tree `2244520ee65281b0db6d6955640cbfcd600cc03a`), files `measurements/raw-tier0-prototype/*`. That candidate is held for whole A7/Codex review and is not modified here. Paths below are relative to that directory.

**Spec pins:** SPEC-v1 `main` `68da358` `docs/spec/v1/SPEC-v1.md`:
- DAT-PRV-001 at l.1076;
- DAT-PRV-002 at l.1078-1089;
- DAT-TIM-001 at l.1116-1123.

## 1. Traced paths at the pin
1. **Clocks:** two kinds, kept separate.
   - **Receive metadata:** fixture-supplied, with no clock read for it. The fixture supplies `t_recv_wall_ns`, `t_recv_mono_ns` and `clock_source: "fixture_supplied"` (`fixture.mjs:45-47`), plus `boot_id`, `host_id`, `connection_id`, `subscription_id` and `source_id`.
   - **Clocks the prototype does read**, which never feed provenance:
     - `process.hrtime.bigint()` (`producer.mjs:15`) times the decision callback (l.146, 149);
     - `monitorEventLoopDelay` (l.50) measures event-loop delay;
     - `Date.now()` (l.178, 180) enforces the drain timeout;
     - the writer's stall uses an `Atomics.wait` timeout (`writer.mjs:103`).
2. **Publication:** `decision` (`producer.mjs:144-151`) runs synchronously.
   - It decodes and publishes in memory (`published[i] = tier1Line(f.raw)`, l.147), then calls `offer`. The published value has **no `raw_ref`**.
   - `offer` (l.132-142) either queues the frame or drops it as overflow, recording the drop in `lostRanges` (l.136).
3. **Hand-off:**
   - `pump` (l.116-130) moves a queued frame to `inflight` with the producer's own raw and metadata sha256 (l.122), then writes it to the pipe.
   - `startWriter` (l.88-115) assigns `epoch` = the writer's start number.
4. **Append:**
   - The writer opens the segment `O_NOFOLLOW` (`writer.mjs:25-26`), or creates it `O_EXCL` (l.34), and checks its header identity (l.42-46).
   - On recovery (l.48-64), `scan` (`tier0.mjs:59-87`) treats any record whose magic matches, whose lengths are in bounds and whose declared length runs past EOF as a recoverable `torn_*` tail. That tail is quarantined, then cut with `ftruncate`.
   - **This is not proof of a torn final write.** A length corrupted mid-file but still within `MAX_META`/`MAX_RAW` produces the same signature. The writer then exits 0, after quarantining and cutting the corrupt record **and every intact later record**. See §8.
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

`DURABLE_ACKED` --recovery cut at the pin (§8)--> `INVALIDATED`. The bytes are preserved in the quarantine file, but the `raw_ref` (file, offset) no longer resolves in the active segment. Keeping the bytes is **not** the same as keeping an accessible `raw_ref`. Nothing at the pin re-points or reports invalidated refs to the producer.

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
- **Contradicted at the pin:** quarantine contents are *not* guaranteed to be never-acked. In the §8 failures, acked records (including intact later seqs) were moved into quarantine. Their refs are `INVALIDATED`: unresolvable in the active file, with the bytes recoverable only from the quarantine file, which has no ref mapping.
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
- overflow accounted for;
- explicit gaps and out-of-order seqs;
- explicit conflicts;
- refusal ≠ timeout;
- cleanup of owned PIDs only.

**Contradicted at the pin (A7 `84999201` / `8cc61d3`, Codex 06:27:31Z):**
- "corruption refused with the segment unmutated": F4, for length corruption within limits;
- "only a proven torn tail is cut": F6;
- "a quarantined tail is never an acked ref": §5.

Refusal does hold at the pin for bad sha, bad magic, an out-of-bounds length, symlinks, foreign files and identity mismatches.

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
- **Verification of the pin, as reported to me:** A7 root-verified Linux 52 PASS / 0 FAIL (`8cc61d3`). Codex on macOS got 52 PASS / 0 FAIL with 17 owned PIDs and 0 survivors. **The HIGH in §8 stays open at the pin.** Passing tests are not acceptance.
- Concurrent-writer and reconnect behaviour is reasoned from the code, not run.
- No owner decision is recorded or inferred.

## 8. Actual failures at the pin `1bbabb2` (recorded, not repaired here)
- **Codex, 06:27:31Z (macOS):** a valid 118 B header plus three 56 B records, with the middle `rawLen` changed from 3 to 1000 (below `MAX_RAW`).
  - `scan` reports `torn_body` with `recoverable: true`, and the writer exits 0.
  - The active file goes from 286 B to 174 B. 112 B are quarantined, including the intact later seq 3.
- **A7 independent 10,000-record probe:** `rawLen` set to 15 MiB at record 5000, and separately at record 9990, gives the same defect. The corrupt record and all later intact records are cut from the active file into quarantine.
- **Effect on the matrix:** F4 and F6 are `contradicted_at_pin` for this class. Every ack for a record at or after the corrupt offset goes from `DURABLE_ACKED` to `INVALIDATED`.
  - Bytes preserved in quarantine: yes.
  - `raw_ref` resolvable: no.
- No invariant here is upgraded on the strength of `94a0ae0`.


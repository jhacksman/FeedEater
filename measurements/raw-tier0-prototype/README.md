# Raw Tier-0 writer prototype (DAT-PRV-001 primitive, standalone) — correction 2 (final) of `1bbabb2`, correction 1 of `320dcfc`

This is a hermetic prototype of the primitive missing from DAT-PRV-001 (audit `b9dd122` P3, proposal `861bb80` S3a).
- It is **not** integrated with #173 (collector, measure or persister), run-native, the joint guard, deploy or production.
- It does not resolve Q1 or Q2.
- It makes no broker, node, network, history, social or holdout calls, installs nothing and starts no services.

## Pieces
- `fixture.mjs`: deterministic synthetic WS frames, 10,000 by default with seed 173.
  - Some frames' bytes differ from what a JSON parse plus re-serialize would produce: odd whitespace, `\u` escapes, mixed-case hex, CRLF. 11 frames are undecodable.
  - Receive metadata is **supplied by the fixture** (`clock_source: "fixture_supplied"`): `t_recv_wall_ns`, `t_recv_mono_ns`, `boot_id`, `host_id`, `connection_id`, `subscription_id` and `source_id`.
- `producer.mjs`: a synchronous decision callback that decodes the frame, publishes it in memory as a Tier-1 line, then makes a bounded `offer` to the writer queue (count and byte caps).
  - It never awaits writer I/O. The pipe is written asynchronously, with drain handling outside the decision path.
  - Overflow increments `lost` and records the lost seq ranges.
  - Unacked frames are retained (bounded) and resent in seq order after a writer restart.
  - It owns the writer PID. On stop it ends stdin, then sends TERM after a grace period, then KILL.
- `writer.mjs`: a separate process. It appends `T0R1 | metaLen | meta | rawLen | raw-as-received | sha256(meta‖raw)` to the segment, fsyncs, and only then acks with the real `file`, `offset`, `length`, `rawOffset`, `rawLength` and `sha256`.
  - On start it scans the segment, truncates a torn or corrupt tail, and re-acks the durable records (`via: "recovery"`).
  - It skips any seq at or below the last durable seq, so a resent frame is not written twice.
- `tier0.mjs` / `tier1.mjs`: the segment format and scan, and the deterministic decode, a pure function of (raw bytes, registry version, decoder version).

## Acceptance (`node test.mjs` → `test.out`, `evidence/`)
- Raw bytes and metadata round-trip for all 10,000 frames, and every ack's offset and sha resolve to the received bytes.
- A deleted Tier-1 partition is re-decoded from Tier-0 byte for byte.
- 3 paired reps of a 10,000-event control against the writer stalled for 2 s, with arm order alternating. Each rep reports decision p99 against `control + max(1 ms, 10%)`.
  - Every rep's durations are kept in `evidence/p99-rep*-*.json`.
  - The test asserts that the stall was observed and that decisions kept completing during it. It does not assert the p99 bound; the bound result is reported as measured.
- SIGKILL crash and restart; torn tail; overflow with the coverage gap accounted for; TERM-to-KILL cleanup of a writer that ignores TERM and is stuck; no owned PID survives.

## Correction 2 (A7 `8cc61d3`, new HIGH): recovery contract
In correction 1, a length beyond EOF was treated as proof of a torn final write. A7 showed that a mid-file length corruption within limits produced the same signature, so an intact later record was quarantined out of the active file. Correction 2 replaces that rule with committed-end evidence.
- **Commit journal `<segment>.commit`:** fixed 48 B entries, `T0C1 | u64 end | u32 lastSeq | sha256(segment_id || first 16 B)`.
  - The journal is created `O_EXCL|O_NOFOLLOW` with the segment, starting with the header end. The directory is fsynced.
  - After each batch the writer fsyncs the segment, then appends and fsyncs one entry, then emits the acks. So every acked record lies below the last committed end C.
- **Recovery contract:** checks run in this order, and every refusal is exit 3 with the segment, journal and quarantine directory untouched and no recovery ack.
  1. **Segment:** it is opened `O_NOFOLLOW` and must be a regular file whose header identity matches. Otherwise it is refused, as in correction 1.
  2. **Journal:** it is opened `O_NOFOLLOW` and must be a regular file. Missing, symlinked, empty, a bad full entry or non-monotonic entries are refused. Only a trailing partial entry (< 48 B, so there is no length field to corrupt) is quarantined and then truncated.
  3. **Committed region:** `[header end, C)` must parse exactly as authenticated records ending at C, with strictly increasing seqs ending at the journal's `lastSeq`. A file shorter than C, or any bad magic, length, sha or meta, or a torn record inside the committed region, is refused. Length corruption anywhere before C is therefore refused, whether in a middle, near-end or final committed record.
  4. **Uncommitted region `[C, EOF)`:** this region was never acked. It is cut only if it parses as zero or more complete authenticated records followed by at most one partial record whose magic matches and whose lengths are within limits.
     - The exact bytes are first written to an `O_EXCL|O_NOFOLLOW` quarantine file, fsynced and sha'd, and the directory is fsynced. Only then is the segment truncated to C.
     - A quarantine create, write or directory-fsync failure (including `EEXIST`) refuses before truncation.
     - Anything else after C is refused.
- **What the contract does not claim:**
  - A length corrupted inside an uncommitted record can still look like a partial record. Such bytes are cut, but they were never acked; they are preserved in quarantine and the producer resends them. That is disclosed and tested.
  - Tornness is never inferred from a length alone below C, and no magic scanning is used.
- **Undetectable:**
  - Loss of whole trailing journal entries through external damage would make acked records look uncommitted. They would then be quarantined, still preserved but no longer at their ack offsets.
  - An adversary who recomputes the unkeyed shas is out of scope: the integrity checks protect against accidental damage only.
- **Ack loss on exit:** the writer no longer calls `process.exit(0)` at end of input. The tests found that this could drop acks still queued for stdout, so it now sets `exitCode` and lets stdout drain.
- **Test-only fault injection** (`writer.mjs --fault`):
  - `crash-mid-append`, `crash-before-commit` and `crash-before-ack`, each exiting 7 at `--fault-at-seq`;
  - `fail-quarantine` and `fail-dir-fsync`.

## Correction 1 (A7 `8af9d42`: 2 HIGH, 1 MED, 2 LOW)
- **Segment identity:**
  - Each segment starts with a `T0H1` header carrying `{format, segment_id}` and a sha.
  - A new segment is created with `O_CREAT|O_EXCL|O_NOFOLLOW`, and the header and directory are fsynced.
  - An existing segment is opened `O_NOFOLLOW`, must pass an fstat regular-file check, and its header `segment_id` must equal `--segment-id`.
  - A symlink, a non-regular file, a foreign file or an identity mismatch is refused (`type: "refused"`, exit 3) with the bytes untouched.
- **Recovery:**
  - Only a proven torn final write is cut: the magic matches (or the partial tail is a prefix of it), the lengths are within `MAX_META`/`MAX_RAW`, and the declared length runs past EOF.
  - The exact cut bytes are first written to an exclusive `<segment>.quarantine-<offset>-e<epoch>` file and fsynced. The ack includes the quarantine file's sha.
  - `bad_sha`, `bad_magic`, `bad_length`, `bad_meta` or non-monotonic seqs anywhere are refused with exit 3. Nothing is truncated, so no valid suffix is deleted.
- **Ack binding:**
  - Writer acks carry `segment_id`, `epoch` (the writer's start number), `seq`, offsets, `sha256` (raw) and `metaSha256`.
  - The producer accepts an ack only if all of these match its own run, the epoch of the writer that sent it, and its own shas of the bytes it sent. Otherwise the record is rejected with an explicit reason and stays unacked, with no `raw_ref`.
  - Resending a durable seq gives `dup_identical`, acked at the durable offset, or `conflict`, which is not written.
  - A seq inside a gap is `rejected: out_of_order`.
  - A seq jump is reported as `gap`; the producer counts any gap seq not in its own lost ranges as `unexplainedGaps`.
  - A writer refusal or failure ends the drain explicitly (`writerFailed`), not as a timeout.
- **Producer I/O accounting:** the synchronous `statSync` in the ack handler is removed.
  - Ack handling and pipe writes, including computing the shas, run on the producer's event loop between decision callbacks. Their total time is reported as `producerIo`, along with `eventLoopDelayNs` (from `monitorEventLoopDelay`).
  - The p99 bound applies to the decision callback duration only. Event-loop delay is reported, not bounded.
- **Falsification tests:**
  - every A7 probe: a corrupt middle record in a small 3-record segment and at record 5000; a foreign file; a symlink to a 13-byte target; a rerun with a new id; seed 999 against seed 173; seqs 1,5,3; a foreign decoy process;
  - plus a bad-magic tail and a bad-length tail.
- **Kept:** the genuine torn tail, crash, overflow, re-decode and cleanup tests.

## Limitations (explicit)
- **Synthetic fixture and host timing only.** The p99 is the time inside one Node process's decision callback, on this host. It is not live latency, a measurement of collector integration, source admission or owner acceptance. The decision callback is a toy decode plus publish.
- **Q1 unresolved.** A published record carries no `raw_ref`; `raw_ref` exists only in the writer ack, after the append and fsync. Published but unacked records (the abort case) have no `raw_ref` and are not claimed as DAT-PRV-002 compliant. DAT-PRV-002's "every record, 0 missing" is not met by the published record, and nothing here chooses how to reconcile the two.
- **`t_ingest` is not produced.** Which clock and which point (append or fsync) it binds to is a spec choice, so it stays unknown.
- **Clock binding.** The receive times are fixture-supplied, not measured; no real clock, `boot_id` or `host_id` binding is demonstrated.
- **Q2 (natural key)** is untouched. Records are keyed only by the producer's `seq`.
- **Durability.** The ack follows the segment fsync, then the commit-journal append and fsync. The directory is fsynced only at creation and after quarantine. Rotation, partitioning, multiple writers and disk-full are not covered.
- After a crash, resending depends on the bounded in-memory retention. A producer crash loses unacked frames, and that case is not tested.
- The p99 bound is for the callback only. The event-loop delay p99 (about 2 ms in both arms, mostly the 1 ms `setTimeout` pacing) and the producer ack/pipe time are reported, not bounded.
- Recovery assumes a single writer. It does not detect or fence concurrent writers to the same segment beyond `O_EXCL` at creation; there is no lock.
- `O_NOFOLLOW` covers only the final path component; parent-directory symlinks are not checked.
- Linux only (node v24.19.0). Not run on macOS.

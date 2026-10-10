# Raw Tier-0 writer prototype (DAT-PRV-001 primitive, standalone)

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

## Limitations (explicit)
- **Synthetic fixture and host timing only.** The p99 is the time inside one Node process's decision callback, on this host. It is not live latency, a measurement of collector integration, source admission or owner acceptance. The decision callback is a toy decode plus publish.
- **Q1 unresolved.** A published record carries no `raw_ref`; `raw_ref` exists only in the writer ack, after the append and fsync. Published but unacked records (the abort case) have no `raw_ref` and are not claimed as DAT-PRV-002 compliant. DAT-PRV-002's "every record, 0 missing" is not met by the published record, and nothing here chooses how to reconcile the two.
- **`t_ingest` is not produced.** Which clock and which point (append or fsync) it binds to is a spec choice, so it stays unknown.
- **Clock binding.** The receive times are fixture-supplied, not measured; no real clock, `boot_id` or `host_id` binding is demonstrated.
- **Q2 (natural key)** is untouched. Records are keyed only by the producer's `seq`.
- **Durability.** The ack follows `fsync` on the segment fd only. Directory fsync, rotation, partitioning, multiple writers and disk-full are not covered.
- After a crash, resending depends on the bounded in-memory retention. A producer crash loses unacked frames, and that case is not tested.
- Linux only (node v24.19.0). Not run on macOS.

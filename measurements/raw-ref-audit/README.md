# raw-ref-audit (standalone, offline, read-only) — correction 1 of `bca7f89`

This tool audits every durable ack written by the **frozen** raw Tier-0 prototype `94a0ae0e2a7e96c8ba21b3d609adbdfb156eb14d` (format `tier0-proto/2` plus the `T0C1` commit journal). It checks each ack against the segment, the commit journal and any quarantine files supplied by an operator. It exists for independent reconciliation before any source measurement. It does not repair, accept or adopt anything.

```
node audit.mjs --segment <seg> --journal <seg>.commit --acks <writer-stdout.jsonl> [--quarantine <seg>.quarantine-<off>-e<epoch> ...] [--full-refs]
```
Exit codes: `0` audit complete (whatever the results), `2` refused (ambiguous or incomplete input), `3` an input changed during the audit.

## Contract
- **Read-only:**
  - Every input is opened `O_RDONLY|O_NOFOLLOW` and must be a regular file.
  - Each input is sha256-hashed before the audit, then reopened and re-hashed afterwards with an inode check. Both hashes are reported.
  - Nothing is written, truncated, renamed, deleted, remapped or rebuilt.
  - The writer's exit code and the test counts are not used as evidence.
- **Refused (exit 2):** a missing argument or input file; a symlink as the final component *or as any parent directory component* (`parent_path_symlink`); a non-regular file; a malformed or truncated ack-journal line; ack fields that are malformed; no acks; mixed `segment_id` or `file` values across acks; a quarantine file not named for the supplied segment; a duplicate argument.
  - A refusal also reports `readOnly.inputsRead`: the before and after sha256 and inode of every input read before the refusal. If any of them changed, the exit is 3.
- **Classification:** per unique seq, in the order given below.
  1. Acks for the same seq that disagree on the identity, offset, length, raw offset/length, raw sha or meta sha → `UNKNOWN conflicting_acks`.
  2. If the header is invalid, or its `format`/`segment_id` doesn't match the ack → `INVALIDATED segment_header_invalid | segment_identity_mismatch`.
     - `segment.headerDetail` gives the cause: `magic_or_short`, `length`, `sha`, `json_unparseable`, `json_not_object` (null, array or scalar), or `fields_not_strings`.
  3. If the record at the ack offset doesn't verify → `INVALIDATED` with one of:
     - `beyond_eof`
     - `offset_inside_header`
     - `framing_mismatch`: the magic, lengths or raw offset don't match the ack
     - `record_sha_mismatch`
     - `ack_raw_sha_mismatch`
     - `ack_meta_sha_mismatch`
     - `record_meta_unparseable`
     - `record_meta_not_object`
     - `seq_mismatch`
     - Every read is bounds-checked against the claimed span, so truncated or malformed frames are classified, never thrown.
  4. If the record verifies, the commit proof is checked.
     - A journal that doesn't authenticate under the ack `segment_id` (bad or non-monotonic entry, or empty) → `UNKNOWN journal_unverifiable:<reason>`.
     - **Binding (correction 1, B1):** an authenticated journal is not by itself proof about *this* segment, so each entry is checked against the segment's verified framing.
       - The verified framing is the records walked from the header end until the first one that fails, plus every record that verifies at an ack offset.
       - An entry is *aligned* when its end is the header end with `lastSeq` 0, or the end of a verified record with the same seq.
       - It is *contradicted* when its end is inside the header or inside a verified record, or at a verified end with a different seq.
       - Otherwise it is *unverifiable*: past EOF, or in an unverified region.
       - The counts and the first contradiction are reported in `journal.binding`.
     - If any entry is contradicted → `UNKNOWN journal_not_bound_to_segment` for every verified ref. It is never upgraded.
     - If the ref end is within the largest aligned end → `RESOLVABLE`.
     - If it is covered only by an unverifiable end → `UNKNOWN commit_end_unverifiable`.
     - Otherwise → `INVALIDATED beyond_committed_end`.
- **Bytes preserved vs ref accessible:** these are reported separately.
  - `refAccessible` means the ref verifies in the active segment at its offset.
  - `bytesPreserved` lists every location where the exact acked record (record sha, raw sha, meta sha and seq) is found. That is the active segment, or a quarantine file at `offset - <off>`, where `<off>` comes from raw94's quarantine filename convention. Otherwise it is `not_found`.
  - A ref is never re-pointed: bytes found in quarantine leave the ref `INVALIDATED`.
  - For conflicting acks, nothing is searched, so the value is `not_searched`.
- **Output:** JSON on stdout.
  - It contains the input hashes, the header and journal state, ack counts (duplicate-identical, conflicting), a summary by status and reason, presence counts, the bytes in non-resolvable refs, and seq ranges.
  - It lists the non-resolvable refs, or every ref with `--full-refs`. Each ref carries only offsets, lengths and shas, never raw payload.
  - No clock is read and no `t_ingest` is produced.

## Tests (`node test.mjs`)
- **Fixture generation:** the real raw94 `writer.mjs`, `tier0.mjs` and `fixture.mjs` are extracted with `git show 94a0ae0:…`, and their sha256 must match the pinned hashes.
  - They write the raw94 seed-173 10,000-frame fixture, one frame per pipe write and each awaited by its ack. Frames 9999 and 10000 then go in one write, so the journal is deterministic: 10,000 entries, the last covering exactly 9999–10000.
  - The B1 seed-999 segment uses batched writes. Its bytes and acks don't depend on batching, and only its own journal (used by the control case) does.
  - The test also runs raw94's own recovery on damaged copies.
- **Requires** git and the commit `94a0ae0` present locally.
- **Results:** `evidence/results.json` holds the fixed expected vs actual for each case, and `test.out` is the run log; both are deterministic. Host timing goes only to `evidence/variable.json`, which is not asserted.
- **Read-only check:** every audit run is checked against the test's own independent before/after hashes of its inputs.

## Limits
- **Format pin:** the format is pinned to raw94. Any other writer or format is out of scope; it would show up as a refusal or as `segment_header_invalid`/`framing_mismatch`.
- **Trust:**
  - The shas are unkeyed. An adversary who can rewrite the segment, journal and ack journal consistently is not detected.
  - The ack journal is trusted as the operator's record of what was acked; acks missing from it cannot be audited.
- **Journal:**
  - The journal is authenticated under the ack journal's `segment_id`.
  - Losing whole trailing journal entries is detected only as `beyond_committed_end` against the remaining entries. The tool cannot tell external journal damage from a ref that was never committed. Either way the ack is not proven.
- **Binding:**
  - It needs verified framing. Refs in a region that can't be verified, with no aligned entry covering them, stay `UNKNOWN`.
  - An aligned entry proves only that its end and seq agree with this segment, not that the journal was written for this exact file. The format has no file-unique nonce beyond `segment_id`.
- **Path checks:** the parent-symlink check is done with `lstat` before opening, so a rename race between the check and the open is not excluded.
- **Quarantine:** matching relies on raw94's quarantine filename offset convention. A renamed quarantine is refused, not searched.
- **Format details:** only one segment per run, no rotation, and quarantines of the journal itself (`.commit.quarantine-*`) are refused as inputs.
- **Scope:** synthetic and offline only. This is not native, source, admission or owner-acceptance evidence. Q1 and Q2 are unresolved, and no `t_ingest`/clock choice is made.

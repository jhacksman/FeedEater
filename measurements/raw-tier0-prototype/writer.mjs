#!/usr/bin/env node
// Separate Tier-0 writer process. Appends exactly-as-received bytes + supplied metadata, fsyncs the segment, appends and
// fsyncs a commit-journal entry (committed end C), then acks with segment_id/epoch/file/offset/length/sha256/metaSha256.
// Produces no t_ingest (clock binding is an unresolved spec choice). Recovery contract: see README "Recovery contract".
import fs from "node:fs";
import path from "node:path";
import { encodeRecord, encodeHeader, encodeCommit, parsePipe, parseHeader, parseJournal, scan, rawSha, FORMAT } from "./tier0.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const seg = arg("segment");
const segId = arg("segment-id");
const epoch = Number(arg("epoch", "NaN"));
const stallAfter = Number(arg("stall-after-seq", "0"));
const stallMs = Number(arg("stall-ms", "0"));
// Test-only fault injection: crash-mid-append | crash-before-commit | crash-before-ack (exit 7 at --fault-at-seq),
// fail-quarantine | fail-dir-fsync (recovery I/O failure).
const fault = arg("fault", "");
const faultAt = Number(arg("fault-at-seq", "0"));
if (arg("ignore-term", "0") === "1") process.on("SIGTERM", () => {});
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
function refuse(reason, extra = {}) { emit({ type: "refused", reason, segment: seg ?? null, ...extra }); process.exit(3); }
if (typeof seg !== "string" || typeof segId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(segId) || !Number.isInteger(epoch) || epoch < 1) refuse("bad_args");

const { O_RDWR, O_RDONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const jpath = `${seg}.commit`;
function fsyncDir() {
  if (fault === "fail-dir-fsync") throw Object.assign(new Error("injected"), { code: "EIO_INJECTED" });
  const d = fs.openSync(path.dirname(seg), O_RDONLY); fs.fsyncSync(d); fs.closeSync(d);
}
function openExisting(p, what) {
  try { return fs.openSync(p, O_RDWR | O_NOFOLLOW); } catch (e) {
    if (e.code === "ELOOP") refuse(`${what}_is_symlink`);
    if (e.code === "ENOENT") return null;
    refuse(`${what}_open_${e.code}`);
  }
}
// Copy exact bytes to an exclusive quarantine file, fsync it and the directory. Any failure refuses before truncation.
function quarantine(p, bytes, offset) {
  const qp = `${p}.quarantine-${offset}-e${epoch}`;
  try {
    if (fault === "fail-quarantine") throw Object.assign(new Error("injected"), { code: "EIO_INJECTED" });
    const qfd = fs.openSync(qp, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    fs.writeSync(qfd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(qfd);
    fs.closeSync(qfd);
    fsyncDir();
  } catch (e) { refuse("quarantine_failed", { code: e.code, file: qp, offset, bytes: bytes.length }); }
  return { file: qp, offset, bytes: bytes.length, sha256: rawSha(bytes) };
}

let fd = openExisting(seg, "segment");
let jfd = null;
let size = 0;
let lastSeq = 0;
const durable = new Map();
const ack = (via, seq, d) => emit({ type: "ack", via, segment_id: segId, epoch, file: seg, seq, ...d });
if (fd === null) {
  if (fs.existsSync(jpath) || (() => { try { fs.lstatSync(jpath); return true; } catch { return false; } })()) refuse("journal_without_segment");
  try { fd = fs.openSync(seg, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644); } catch (e) { refuse(`create_${e.code}`); }
  const h = encodeHeader({ format: FORMAT, segment_id: segId });
  fs.writeSync(fd, h, 0, h.length, 0);
  fs.fsyncSync(fd);
  try { jfd = fs.openSync(jpath, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644); } catch (e) { refuse(`journal_create_${e.code}`); }
  const c = encodeCommit(segId, h.length, 0);
  fs.writeSync(jfd, c, 0, c.length, 0);
  fs.fsyncSync(jfd);
  try { fsyncDir(); } catch (e) { refuse("dir_fsync_failed", { code: e.code }); }
  size = h.length;
  emit({ type: "recovered", created: true, segment_id: segId, epoch, records: 0, lastSeq: 0, committedEnd: size, quarantine: null, journalQuarantine: null });
} else {
  if (!fs.fstatSync(fd).isFile()) refuse("segment_not_regular_file");
  const buf = fs.readFileSync(fd);
  const hd = parseHeader(buf);
  if (!hd.ok) refuse(hd.reason, { bytes: buf.length });
  if (hd.header.format !== FORMAT || hd.header.segment_id !== segId) refuse("segment_identity_mismatch", { found: hd.header.segment_id ?? null, bytes: buf.length });
  jfd = openExisting(jpath, "journal");
  if (jfd === null) refuse("journal_missing", { bytes: buf.length });
  if (!fs.fstatSync(jfd).isFile()) refuse("journal_not_regular_file");
  const jb = fs.readFileSync(jfd);
  const pj = parseJournal(jb, segId);
  if (!pj.ok) refuse(pj.reason, { at: pj.at ?? null, journalBytes: jb.length });
  const C = pj.committedEnd;
  if (C < hd.end || buf.length < C) refuse("committed_data_missing", { committedEnd: C, bytes: buf.length });
  // Committed region [header end, C) must parse exactly as authenticated records ending at C with the journal's last seq.
  const s = scan(buf.subarray(0, C), hd.end);
  if (s.tailBytes > 0) refuse("corrupt_segment", { region: "committed", at: s.validEnd, tailReason: s.tailReason, committedEnd: C, validRecordsBefore: s.records.length, bytes: buf.length });
  for (const r of s.records) {
    if (!Number.isInteger(r.meta.seq) || r.meta.seq <= lastSeq) refuse("non_monotonic_segment", { at: r.offset });
    lastSeq = r.meta.seq;
  }
  if (lastSeq !== pj.lastSeq) refuse("journal_segment_mismatch", { journalLastSeq: pj.lastSeq, segmentLastSeq: lastSeq });
  // Uncommitted region [C, EOF): never acked. Cut only if it is complete records then a proven partial record.
  let q = null;
  let uncommittedComplete = 0;
  if (buf.length > C) {
    const u = scan(buf, C);
    if (u.tailBytes > 0 && !u.recoverable) refuse("corrupt_segment", { region: "uncommitted", at: u.validEnd, tailReason: u.tailReason, committedEnd: C, bytes: buf.length });
    uncommittedComplete = u.records.length;
    q = { ...quarantine(seg, buf.subarray(C), C), tailReason: u.tailReason, uncommittedCompleteRecords: uncommittedComplete };
  }
  let jq = null;
  if (pj.partialTailBytes > 0) jq = quarantine(jpath, jb.subarray(jb.length - pj.partialTailBytes), jb.length - pj.partialTailBytes);
  if (q !== null) { fs.ftruncateSync(fd, C); fs.fsyncSync(fd); }
  if (jq !== null) { fs.ftruncateSync(jfd, jq.offset); fs.fsyncSync(jfd); }
  size = C;
  for (const r of s.records) durable.set(r.meta.seq, { offset: r.offset, length: r.length, rawOffset: r.rawOffset, rawLength: r.rawLength, sha256: rawSha(r.raw), metaSha256: rawSha(r.metaBuf) });
  emit({ type: "recovered", created: false, segment_id: segId, epoch, records: s.records.length, lastSeq, committedEnd: C, quarantine: q, journalQuarantine: jq });
  for (const [seq, d] of durable) ack("recovery", seq, d);
}

let jsize = fs.fstatSync(jfd).size;
let pending = Buffer.alloc(0);
let stalled = false;
const acks = [];
function flush() {
  if (acks.length === 0) return;
  const hit = faultAt > 0 && acks.some(([v, s]) => v === "append" && s === faultAt);
  fs.fsyncSync(fd);
  if (hit && fault === "crash-before-commit") process.exit(7);
  const c = encodeCommit(segId, size, lastSeq);
  fs.writeSync(jfd, c, 0, c.length, jsize);
  jsize += c.length;
  fs.fsyncSync(jfd);
  if (hit && fault === "crash-before-ack") process.exit(7);
  for (const [via, seq, d] of acks) ack(via, seq, d);
  acks.length = 0;
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  const { records, rest } = parsePipe(pending);
  pending = Buffer.from(rest);
  for (const { meta, raw } of records) {
    let seq = null;
    try { seq = JSON.parse(meta.toString("utf8")).seq; } catch { seq = null; }
    if (!Number.isInteger(seq) || seq < 1) { emit({ type: "rejected", reason: "bad_seq", seq }); continue; }
    const rs = rawSha(raw);
    const ms = rawSha(meta);
    if (seq <= lastSeq) {
      const d = durable.get(seq);
      if (d === undefined) emit({ type: "rejected", reason: "out_of_order", seq, lastSeq });
      else if (d.sha256 === rs && d.metaSha256 === ms) acks.push(["dup_identical", seq, d]);
      else emit({ type: "conflict", seq, durableSha256: d.sha256, durableMetaSha256: d.metaSha256, offeredSha256: rs, offeredMetaSha256: ms });
      continue;
    }
    if (seq > lastSeq + 1) emit({ type: "gap", from: lastSeq + 1, to: seq - 1 });
    if (!stalled && stallMs > 0 && seq >= stallAfter) {
      flush();
      emit({ type: "stall", ms: stallMs, atSeq: seq });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
      stalled = true;
      emit({ type: "stall_end", atSeq: seq });
    }
    const rec = encodeRecord(meta, raw);
    if (fault === "crash-mid-append" && seq === faultAt) { fs.writeSync(fd, rec, 0, Math.floor(rec.length / 2), size); process.exit(7); }
    fs.writeSync(fd, rec, 0, rec.length, size);
    const d = { offset: size, length: rec.length, rawOffset: size + 12 + meta.length, rawLength: raw.length, sha256: rs, metaSha256: ms };
    durable.set(seq, d);
    acks.push(["append", seq, d]);
    size += rec.length;
    lastSeq = seq;
  }
  flush();
});
process.stdin.on("end", () => {
  flush();
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.closeSync(jfd);
  emit({ type: "end", lastSeq, size });
  // Let queued stdout (acks) drain before exiting; process.exit() here could drop acks still buffered for the pipe.
  process.exitCode = 0;
  process.stdout.end();
});

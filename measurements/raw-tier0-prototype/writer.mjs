#!/usr/bin/env node
// Separate Tier-0 writer process. Appends exactly-as-received bytes + supplied metadata, fsyncs, then acks with the
// real segment_id/epoch/file/offset/length/sha256/metaSha256. Produces no t_ingest (clock binding is an unresolved spec
// choice). Opens the segment O_NOFOLLOW and verifies its header identity; refuses (exit 3, bytes untouched) a symlink,
// non-regular, foreign or corrupt segment. Only a proven torn final write is quarantined (exact bytes kept) and cut.
import fs from "node:fs";
import path from "node:path";
import { encodeRecord, encodeHeader, parsePipe, parseHeader, scan, rawSha, FORMAT } from "./tier0.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const seg = arg("segment");
const segId = arg("segment-id");
const epoch = Number(arg("epoch", "NaN"));
const stallAfter = Number(arg("stall-after-seq", "0"));
const stallMs = Number(arg("stall-ms", "0"));
if (arg("ignore-term", "0") === "1") process.on("SIGTERM", () => {});
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
function refuse(reason, extra = {}) { emit({ type: "refused", reason, segment: seg ?? null, ...extra }); process.exit(3); }
if (typeof seg !== "string" || typeof segId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(segId) || !Number.isInteger(epoch) || epoch < 1) refuse("bad_args");

const { O_RDWR, O_RDONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const fsyncDir = () => { const d = fs.openSync(path.dirname(seg), O_RDONLY); fs.fsyncSync(d); fs.closeSync(d); };
let fd = null;
try { fd = fs.openSync(seg, O_RDWR | O_NOFOLLOW); } catch (e) {
  if (e.code === "ELOOP") refuse("segment_is_symlink");
  if (e.code !== "ENOENT") refuse(`open_${e.code}`);
}
let size = 0;
let lastSeq = 0;
const durable = new Map();
const ack = (via, seq, d) => emit({ type: "ack", via, segment_id: segId, epoch, file: seg, seq, ...d });
if (fd === null) {
  try { fd = fs.openSync(seg, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644); } catch (e) { refuse(`create_${e.code}`); }
  const h = encodeHeader({ format: FORMAT, segment_id: segId });
  fs.writeSync(fd, h, 0, h.length, 0);
  fs.fsyncSync(fd);
  fsyncDir();
  size = h.length;
  emit({ type: "recovered", created: true, segment_id: segId, epoch, records: 0, lastSeq: 0, quarantine: null });
} else {
  if (!fs.fstatSync(fd).isFile()) refuse("segment_not_regular_file");
  const buf = fs.readFileSync(fd);
  const hd = parseHeader(buf);
  if (!hd.ok) refuse(hd.reason, { bytes: buf.length });
  if (hd.header.format !== FORMAT || hd.header.segment_id !== segId) refuse("segment_identity_mismatch", { found: hd.header.segment_id ?? null, bytes: buf.length });
  const s = scan(buf, hd.end);
  if (s.tailBytes > 0 && !s.recoverable) refuse("corrupt_segment", { at: s.validEnd, tailReason: s.tailReason, validRecordsBefore: s.records.length, bytes: buf.length });
  for (const r of s.records) {
    if (!Number.isInteger(r.meta.seq) || r.meta.seq <= lastSeq) refuse("non_monotonic_segment", { at: r.offset });
    lastSeq = r.meta.seq;
  }
  let q = null;
  if (s.tailBytes > 0) {
    const tail = buf.subarray(s.validEnd);
    const qp = `${seg}.quarantine-${s.validEnd}-e${epoch}`;
    let qfd;
    try { qfd = fs.openSync(qp, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644); } catch (e) { refuse(`quarantine_${e.code}`); }
    fs.writeSync(qfd, tail, 0, tail.length, 0);
    fs.fsyncSync(qfd);
    fs.closeSync(qfd);
    fsyncDir();
    fs.ftruncateSync(fd, s.validEnd);
    fs.fsyncSync(fd);
    q = { file: qp, offset: s.validEnd, bytes: tail.length, sha256: rawSha(tail), tailReason: s.tailReason };
  }
  size = s.validEnd;
  for (const r of s.records) durable.set(r.meta.seq, { offset: r.offset, length: r.length, rawOffset: r.rawOffset, rawLength: r.rawLength, sha256: rawSha(r.raw), metaSha256: rawSha(r.metaBuf) });
  emit({ type: "recovered", created: false, segment_id: segId, epoch, records: s.records.length, lastSeq, quarantine: q });
  for (const [seq, d] of durable) ack("recovery", seq, d);
}

let pending = Buffer.alloc(0);
let stalled = false;
const acks = [];
function flush() {
  if (acks.length === 0) return;
  fs.fsyncSync(fd);
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
  emit({ type: "end", lastSeq, size });
  process.exit(0);
});

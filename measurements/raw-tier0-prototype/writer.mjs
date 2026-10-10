#!/usr/bin/env node
// Separate Tier-0 writer process. Appends exactly-as-received bytes + supplied metadata, fsyncs, then acks
// with the real file/offset/length/sha256. Produces no t_ingest (clock binding is an unresolved spec choice).
import fs from "node:fs";
import { encodeRecord, parsePipe, scan, rawSha } from "./tier0.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const seg = arg("segment");
const stallAfter = Number(arg("stall-after-seq", "0"));
const stallMs = Number(arg("stall-ms", "0"));
if (arg("ignore-term", "0") === "1") process.on("SIGTERM", () => {});
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let size = 0;
let lastSeq = 0;
const ack = (via, a) => emit({ type: "ack", via, file: seg, ...a });
if (fs.existsSync(seg)) {
  const s = scan(fs.readFileSync(seg));
  if (s.tailBytes > 0) fs.truncateSync(seg, s.validEnd);
  size = s.validEnd;
  lastSeq = s.records.length > 0 ? s.records[s.records.length - 1].meta.seq : 0;
  emit({ type: "recovered", records: s.records.length, lastSeq, truncatedTailBytes: s.tailBytes, tailReason: s.tailReason });
  for (const r of s.records) ack("recovery", { seq: r.meta.seq, offset: r.offset, length: r.length, rawOffset: r.rawOffset, rawLength: r.rawLength, sha256: rawSha(r.raw) });
} else emit({ type: "recovered", records: 0, lastSeq: 0, truncatedTailBytes: 0, tailReason: null });
const fd = fs.openSync(seg, "a");

let pending = Buffer.alloc(0);
let stalled = false;
const acks = [];
function flush() {
  if (acks.length === 0) return;
  fs.fsyncSync(fd);
  for (const a of acks) ack("append", a);
  acks.length = 0;
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  const { records, rest } = parsePipe(pending);
  pending = Buffer.from(rest);
  for (const { meta, raw } of records) {
    const seq = JSON.parse(meta.toString("utf8")).seq;
    if (seq <= lastSeq) { emit({ type: "dup", seq }); continue; }
    if (!stalled && stallMs > 0 && seq >= stallAfter) {
      flush();
      emit({ type: "stall", ms: stallMs, atSeq: seq });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
      stalled = true;
      emit({ type: "stall_end", atSeq: seq });
    }
    const rec = encodeRecord(meta, raw);
    fs.writeSync(fd, rec);
    acks.push({ seq, offset: size, length: rec.length, rawOffset: size + 12 + meta.length, rawLength: raw.length, sha256: rawSha(raw) });
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

#!/usr/bin/env node
// Read-only raw_ref audit for Tier-0 segments written by the frozen raw prototype 94a0ae0 (format tier0-proto/2 + T0C1 journal).
// Classifies every durable ack as RESOLVABLE / INVALIDATED / UNKNOWN with an exact reason. Never writes, remaps or deletes;
// never outputs raw payload bytes; reads no clock. Exit 0 = audit complete, 2 = refused (ambiguous input), 3 = inputs changed.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export const FORMAT_PIN = Object.freeze({ commit: "94a0ae0e2a7e96c8ba21b3d609adbdfb156eb14d", format: "tier0-proto/2",
  tier0Sha256: "52978d89a1a4705c4c59e187d9a54a50605f1d7d29c9cd150d2e9e28cff36198", writerSha256: "7ae9bed2191731dc92b645d60ed49b6538262f8a1afc2f135c1967a71d62bc2b" });
const HMAGIC = Buffer.from("T0H1", "latin1");
const RMAGIC = Buffer.from("T0R1", "latin1");
const CMAGIC = Buffer.from("T0C1", "latin1");
const CLEN = 48;
const sha = (...b) => { const h = crypto.createHash("sha256"); for (const x of b) h.update(x); return h.digest(); };
const hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
class Refusal extends Error { constructor(reason, extra) { super(reason); this.reason = reason; this.extra = extra; } }
const refuse = (reason, extra = {}) => { throw new Refusal(reason, extra); };
const HEX64 = /^[0-9a-f]{64}$/;
const isNat = (x) => Number.isSafeInteger(x) && x >= 0;

function readInput(p, role) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { refuse(e.code === "ELOOP" ? "input_is_symlink" : `input_open_${e.code}`, { role, path: p }); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) refuse("input_not_regular_file", { role, path: p });
    const buf = fs.readFileSync(fd);
    return { role, path: p, buf, bytes: buf.length, sha256Before: hex(buf), ino: st.ino, dev: st.dev };
  } finally { fs.closeSync(fd); }
}

function parseHeader(buf) {
  if (buf.length < 8 || !buf.subarray(0, 4).equals(HMAGIC)) return { ok: false, reason: "segment_header_invalid" };
  const l = buf.readUInt32BE(4);
  if (l > 4096 || buf.length < 8 + l + 32) return { ok: false, reason: "segment_header_invalid" };
  const j = buf.subarray(8, 8 + l);
  if (!sha(HMAGIC, j).equals(buf.subarray(8 + l, 40 + l))) return { ok: false, reason: "segment_header_invalid" };
  try { return { ok: true, header: JSON.parse(j.toString("utf8")), end: 40 + l }; } catch { return { ok: false, reason: "segment_header_invalid" }; }
}

function parseJournal(buf, segId) {
  const entries = [];
  const full = Math.floor(buf.length / CLEN) * CLEN;
  for (let o = 0; o < full; o += CLEN) {
    const b = buf.subarray(o, o + 16);
    if (!b.subarray(0, 4).equals(CMAGIC) || !sha(Buffer.from(segId, "utf8"), b).equals(buf.subarray(o + 16, o + CLEN))) return { ok: false, reason: "journal_bad_entry", at: o };
    const e = { end: Number(b.readBigUInt64BE(4)), lastSeq: b.readUInt32BE(12) };
    const p = entries[entries.length - 1];
    if (p !== undefined && (e.end < p.end || e.lastSeq < p.lastSeq)) return { ok: false, reason: "journal_non_monotonic", at: o };
    entries.push(e);
  }
  if (entries.length === 0) return { ok: false, reason: "journal_empty" };
  const last = entries[entries.length - 1];
  return { ok: true, entries: entries.length, committedEnd: last.end, lastSeq: last.lastSeq, partialTailBytes: buf.length - full };
}

// Verify one record at `pos` in `buf` against an ack's length/raw/meta fields. Returns null if it matches, else a reason.
function checkRecord(buf, pos, a, rawPos) {
  if (pos + a.length > buf.length) return "beyond_eof";
  if (!buf.subarray(pos, pos + 4).equals(RMAGIC)) return "framing_mismatch";
  const ml = buf.readUInt32BE(pos + 4);
  if (pos + 12 + ml > buf.length) return "framing_mismatch";
  const rl = buf.readUInt32BE(pos + 8 + ml);
  const len = 12 + ml + rl + 32;
  if (len !== a.length || rawPos !== pos + 12 + ml || rl !== a.rawLength) return "framing_mismatch";
  const meta = buf.subarray(pos + 8, pos + 8 + ml);
  const raw = buf.subarray(pos + 12 + ml, pos + 12 + ml + rl);
  if (!sha(meta, raw).equals(buf.subarray(pos + len - 32, pos + len))) return "record_sha_mismatch";
  if (hex(raw) !== a.sha256) return "ack_raw_sha_mismatch";
  if (hex(meta) !== a.metaSha256) return "ack_meta_sha_mismatch";
  let m;
  try { m = JSON.parse(meta.toString("utf8")); } catch { return "record_meta_unparseable"; }
  if (m.seq !== a.seq) return "seq_mismatch";
  return null;
}

function parseAcks(buf) {
  const text = buf.toString("utf8");
  if (text.length === 0) refuse("ack_journal_empty");
  if (!text.endsWith("\n")) refuse("ack_journal_truncated_final_line");
  const lines = text.slice(0, -1).split("\n");
  const acks = [];
  let other = 0;
  lines.forEach((l, i) => {
    let o;
    try { o = JSON.parse(l); } catch { refuse("ack_journal_malformed_line", { line: i + 1 }); }
    if (o === null || typeof o !== "object") refuse("ack_journal_malformed_line", { line: i + 1 });
    if (o.type !== "ack") { other++; return; }
    if (typeof o.segment_id !== "string" || typeof o.file !== "string" || !Number.isSafeInteger(o.seq) || o.seq < 1 || !Number.isSafeInteger(o.epoch)
      || ![o.offset, o.length, o.rawOffset, o.rawLength].every(isNat) || !HEX64.test(o.sha256 ?? "") || !HEX64.test(o.metaSha256 ?? "")) refuse("ack_malformed_fields", { line: i + 1 });
    acks.push({ line: i + 1, ...o });
  });
  if (acks.length === 0) refuse("ack_journal_has_no_acks");
  return { acks, lines: lines.length, nonAckLines: other };
}

const ranges = (seqs) => { const out = []; for (const s of [...seqs].sort((a, b) => a - b)) { const l = out[out.length - 1]; if (l && l[1] === s - 1) l[1] = s; else out.push([s, s]); } return out; };

export function audit({ segment, journal, acks, quarantine = [], fullRefs = false }) {
  if (!segment || !journal || !acks) refuse("missing_argument", { need: "--segment --journal --acks" });
  const qs = [...quarantine];
  if (new Set(qs.map((q) => path.resolve(q))).size !== qs.length) refuse("duplicate_quarantine_input");
  const inputs = [readInput(segment, "segment"), readInput(journal, "journal"), readInput(acks, "acks"), ...qs.map((q) => readInput(q, "quarantine"))];
  const [seg, jr, ak] = inputs;
  const qIn = inputs.slice(3).map((q) => {
    const m = path.basename(q.path).match(/^(.*)\.quarantine-(\d+)-e(\d+)$/);
    if (m === null || m[1] !== path.basename(segment)) refuse("quarantine_not_for_segment", { path: q.path });
    return { ...q, baseOffset: Number(m[2]) };
  });
  const pa = parseAcks(ak.buf);
  const ids = new Set(pa.acks.map((a) => a.segment_id));
  if (ids.size !== 1) refuse("mixed_segment_ids", { ids: [...ids] });
  const files = new Set(pa.acks.map((a) => a.file));
  if (files.size !== 1) refuse("mixed_file_paths", { files: [...files] });
  const segId = [...ids][0];
  const hd = parseHeader(seg.buf);
  const identity = !hd.ok ? hd.reason : hd.header.format !== FORMAT_PIN.format || hd.header.segment_id !== segId ? "segment_identity_mismatch" : null;
  const pj = parseJournal(jr.buf, segId);
  const bySeq = new Map();
  for (const a of pa.acks) { const l = bySeq.get(a.seq) ?? []; l.push(a); bySeq.set(a.seq, l); }
  const key = (a) => JSON.stringify([a.segment_id, a.offset, a.length, a.rawOffset, a.rawLength, a.sha256, a.metaSha256]);
  let dupIdentical = 0;
  const refs = [];
  for (const [seq, list] of [...bySeq.entries()].sort((x, y) => x[0] - y[0])) {
    const a = list[0];
    const conflicting = new Set(list.map(key)).size > 1;
    if (!conflicting) dupIdentical += list.length - 1;
    let status;
    let reason;
    let accessible = false;
    if (conflicting) { status = "UNKNOWN"; reason = "conflicting_acks"; }
    else if (identity !== null) { status = "INVALIDATED"; reason = identity; }
    else if (a.offset < hd.end) { status = "INVALIDATED"; reason = "offset_inside_header"; }
    else {
      const r = checkRecord(seg.buf, a.offset, a, a.rawOffset);
      if (r !== null) { status = "INVALIDATED"; reason = r; }
      else {
        accessible = true;
        if (!pj.ok) { status = "UNKNOWN"; reason = `journal_unverifiable:${pj.reason}`; }
        else if (a.offset + a.length > pj.committedEnd) { status = "INVALIDATED"; reason = "beyond_committed_end"; }
        else { status = "RESOLVABLE"; reason = null; }
      }
    }
    const preserved = [];
    if (accessible) preserved.push({ in: "active_segment", position: a.offset });
    if (!conflicting) for (const q of qIn) {
      const pos = a.offset - q.baseOffset;
      if (pos >= 0 && checkRecord(q.buf, pos, a, a.rawOffset - q.baseOffset) === null) preserved.push({ in: "quarantine", file: path.basename(q.path), position: pos });
    }
    refs.push({ seq, status, reason, refAccessible: accessible, bytesPreserved: preserved.length > 0 ? preserved : "not_found", ackLines: list.map((x) => x.line), conflicting,
      ack: conflicting ? list.map((x) => ({ offset: x.offset, length: x.length, sha256: x.sha256 })) : { segment_id: a.segment_id, epochs: [...new Set(list.map((x) => x.epoch))], vias: [...new Set(list.map((x) => x.via))], offset: a.offset, length: a.length, rawOffset: a.rawOffset, rawLength: a.rawLength, sha256: a.sha256, metaSha256: a.metaSha256 } });
  }
  // Read-only check: re-open and re-hash every input after the audit.
  const after = inputs.map((x) => { const y = readInput(x.path, x.role); return { path: x.path, role: x.role, bytes: x.bytes, sha256Before: x.sha256Before, sha256After: y.sha256Before, sameInode: y.ino === x.ino && y.dev === x.dev }; });
  const changed = after.filter((x) => x.sha256Before !== x.sha256After || !x.sameInode);
  const summary = { RESOLVABLE: 0, INVALIDATED: {}, UNKNOWN: {} };
  let nonResolvableBytes = 0;
  const pres = { refAccessible: 0, bytesPreservedActive: 0, bytesPreservedQuarantine: 0, bytesNotFound: 0 };
  for (const r of refs) {
    if (r.status === "RESOLVABLE") summary.RESOLVABLE++; else { summary[r.status][r.reason] = (summary[r.status][r.reason] ?? 0) + 1; if (!r.conflicting) nonResolvableBytes += r.ack.length; }
    if (r.refAccessible) pres.refAccessible++;
    if (r.bytesPreserved === "not_found") pres.bytesNotFound++;
    else { if (r.bytesPreserved.some((p) => p.in === "active_segment")) pres.bytesPreservedActive++; if (r.bytesPreserved.some((p) => p.in === "quarantine")) pres.bytesPreservedQuarantine++; }
  }
  const nonRes = refs.filter((r) => r.status !== "RESOLVABLE");
  return {
    exit: changed.length > 0 ? 3 : 0,
    report: {
      tool: "raw-ref-audit/1", formatPin: FORMAT_PIN, readOnly: { inputs: after, changed: changed.length },
      segment: { headerOk: hd.ok, headerSegmentId: hd.ok ? hd.header.segment_id : null, ackSegmentId: segId, identity: identity ?? "match", bytes: seg.bytes, ackFilePath: [...files][0], suppliedPath: segment },
      journal: pj.ok ? { ok: true, entries: pj.entries, committedEnd: pj.committedEnd, lastSeq: pj.lastSeq, partialTailBytes: pj.partialTailBytes, segmentShorterThanCommittedEnd: seg.bytes < pj.committedEnd } : { ok: false, reason: pj.reason, at: pj.at ?? null },
      acks: { lines: pa.lines, ackLines: pa.acks.length, nonAckLines: pa.nonAckLines, uniqueSeqs: refs.length, duplicateIdentical: dupIdentical, conflictingSeqs: refs.filter((r) => r.conflicting).length },
      summary, presence: pres, nonResolvableRefBytes: nonResolvableBytes,
      resolvableSeqRanges: ranges(refs.filter((r) => r.status === "RESOLVABLE").map((r) => r.seq)),
      nonResolvableSeqRanges: ranges(nonRes.map((r) => r.seq)),
      refs: fullRefs ? refs : nonRes,
      notClaimed: "no t_ingest, no clock, no payload interpretation, no remapping; Q1/Q2 unresolved",
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = { quarantine: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--full-refs") { opt.fullRefs = true; continue; }
    const v = argv[i + 1];
    if (!["--segment", "--journal", "--acks", "--quarantine"].includes(k) || v === undefined) { process.stdout.write(`${JSON.stringify({ refused: "bad_argument", arg: k })}\n`); process.exit(2); }
    if (k === "--quarantine") opt.quarantine.push(v);
    else if (opt[k.slice(2)] !== undefined) { process.stdout.write(`${JSON.stringify({ refused: "duplicate_argument", arg: k })}\n`); process.exit(2); }
    else opt[k.slice(2)] = v;
    i++;
  }
  try {
    const { exit, report } = audit(opt);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = exit;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stdout.write(`${JSON.stringify({ refused: e.reason, ...e.extra })}\n`);
    process.exitCode = 2;
  }
}

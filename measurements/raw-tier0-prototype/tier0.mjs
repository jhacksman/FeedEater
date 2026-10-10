// Tier-0 segment format. Segment = header, then records. Record = "T0R1" | u32 metaLen | meta (JSON utf8) | u32 rawLen | raw (as received) | sha256(meta || raw).
import crypto from "node:crypto";

export const MAGIC = Buffer.from("T0R1", "latin1");
const sha = (...b) => { const h = crypto.createHash("sha256"); for (const x of b) h.update(x); return h.digest(); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export function encodeRecord(metaBuf, raw) {
  return Buffer.concat([MAGIC, u32(metaBuf.length), metaBuf, u32(raw.length), raw, sha(metaBuf, raw)]);
}

// Pipe framing producer -> writer: u32 metaLen | meta | u32 rawLen | raw.
export function encodePipe(metaBuf, raw) {
  return Buffer.concat([u32(metaBuf.length), metaBuf, u32(raw.length), raw]);
}

export function parsePipe(buf) {
  const out = [];
  let o = 0;
  for (;;) {
    if (buf.length - o < 4) break;
    const ml = buf.readUInt32BE(o);
    if (buf.length - o < 8 + ml) break;
    const rl = buf.readUInt32BE(o + 4 + ml);
    if (buf.length - o < 8 + ml + rl) break;
    out.push({ meta: buf.subarray(o + 4, o + 4 + ml), raw: buf.subarray(o + 8 + ml, o + 8 + ml + rl) });
    o += 8 + ml + rl;
  }
  return { records: out, rest: buf.subarray(o) };
}

// Segment header (first bytes of every segment): "T0H1" | u32 len | JSON {format, segment_id} | sha256("T0H1" || JSON).
export const HMAGIC = Buffer.from("T0H1", "latin1");
export const FORMAT = "tier0-proto/2";
export const MAX_META = 64 * 1024;
export const MAX_RAW = 16 * 1024 * 1024;
const MAX_HEADER = 4096;

export function encodeHeader(h) {
  const j = Buffer.from(JSON.stringify(h), "utf8");
  return Buffer.concat([HMAGIC, u32(j.length), j, sha(HMAGIC, j)]);
}

export function parseHeader(buf) {
  if (buf.length === 0) return { ok: false, reason: "empty_file" };
  if (!buf.subarray(0, Math.min(4, buf.length)).equals(HMAGIC.subarray(0, Math.min(4, buf.length)))) return { ok: false, reason: "foreign_file" };
  if (buf.length < 8) return { ok: false, reason: "incomplete_header" };
  const l = buf.readUInt32BE(4);
  if (l > MAX_HEADER) return { ok: false, reason: "bad_header_length" };
  if (buf.length < 8 + l + 32) return { ok: false, reason: "incomplete_header" };
  const j = buf.subarray(8, 8 + l);
  if (!sha(HMAGIC, j).equals(buf.subarray(8 + l, 8 + l + 32))) return { ok: false, reason: "bad_header_sha" };
  try { return { ok: true, header: JSON.parse(j.toString("utf8")), end: 8 + l + 32 }; } catch { return { ok: false, reason: "bad_header_json" }; }
}

// Scan records from `start`; stops at the first incomplete or corrupt record. Only an incomplete final record whose
// magic matches, whose lengths are in bounds and whose declared length runs past EOF is a proven torn write
// (recoverable); bad magic, bad length, bad sha or bad metadata anywhere is corruption (not recoverable).
export function scan(buf, start = 0) {
  const records = [];
  let o = start;
  let reason = null;
  let recoverable = true;
  const stop = (r, rec) => { reason = r; recoverable = rec; };
  while (o < buf.length) {
    const rem = buf.length - o;
    if (rem < 4) { if (buf.subarray(o).equals(MAGIC.subarray(0, rem))) stop("torn_header", true); else stop("bad_magic", false); break; }
    if (!buf.subarray(o, o + 4).equals(MAGIC)) { stop("bad_magic", false); break; }
    if (rem < 8) { stop("torn_header", true); break; }
    const ml = buf.readUInt32BE(o + 4);
    if (ml > MAX_META) { stop("bad_length", false); break; }
    if (rem < 12 + ml) { stop("torn_meta", true); break; }
    const rl = buf.readUInt32BE(o + 8 + ml);
    if (rl > MAX_RAW) { stop("bad_length", false); break; }
    const len = 12 + ml + rl + 32;
    if (rem < len) { stop("torn_body", true); break; }
    const meta = buf.subarray(o + 8, o + 8 + ml);
    const rawOffset = o + 12 + ml;
    const raw = buf.subarray(rawOffset, rawOffset + rl);
    if (!sha(meta, raw).equals(buf.subarray(o + len - 32, o + len))) { stop("bad_sha", false); break; }
    let m;
    try { m = JSON.parse(meta.toString("utf8")); } catch { stop("bad_meta", false); break; }
    records.push({ offset: o, length: len, rawOffset, rawLength: rl, meta: m, metaBuf: meta, raw });
    o += len;
  }
  return { records, validEnd: o, tailBytes: buf.length - o, tailReason: reason, recoverable: reason === null || recoverable };
}

export function readSegment(buf) {
  const h = parseHeader(buf);
  if (!h.ok) return { header: null, headerReason: h.reason, records: [], validEnd: 0, tailBytes: buf.length, tailReason: h.reason, recoverable: false };
  return { header: h.header, headerEnd: h.end, ...scan(buf, h.end) };
}

export const rawSha = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

// Commit journal "<segment>.commit": fixed 48-byte entries "T0C1" | u64 end | u32 lastSeq | sha256(segment_id || first 16 bytes).
// Written and fsynced after the segment fsync and before any ack; the last valid entry is the committed end C.
export const CMAGIC = Buffer.from("T0C1", "latin1");
export const CLEN = 48;
export function encodeCommit(segId, end, lastSeq) {
  const b = Buffer.alloc(16);
  CMAGIC.copy(b, 0);
  b.writeBigUInt64BE(BigInt(end), 4);
  b.writeUInt32BE(lastSeq, 12);
  return Buffer.concat([b, sha(Buffer.from(segId, "utf8"), b)]);
}
// Full entries must all authenticate and be monotonic; only a trailing partial entry (< 48 B) is a torn journal write.
export function parseJournal(buf, segId) {
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
  return { ok: true, entries, committedEnd: entries[entries.length - 1].end, lastSeq: entries[entries.length - 1].lastSeq, partialTailBytes: buf.length - full };
}

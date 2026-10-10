// Tier-0 segment format. Record = "T0R1" | u32 metaLen | meta (JSON utf8) | u32 rawLen | raw (as received) | sha256(meta || raw).
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

// Scan a segment; stops at the first incomplete or corrupt record.
export function scan(buf) {
  const records = [];
  let o = 0;
  let reason = null;
  while (o < buf.length) {
    if (buf.length - o < 8) { reason = "torn_header"; break; }
    if (!buf.subarray(o, o + 4).equals(MAGIC)) { reason = "bad_magic"; break; }
    const ml = buf.readUInt32BE(o + 4);
    if (buf.length - o < 12 + ml) { reason = "torn_meta"; break; }
    const rl = buf.readUInt32BE(o + 8 + ml);
    const len = 12 + ml + rl + 32;
    if (buf.length - o < len) { reason = "torn_body"; break; }
    const meta = buf.subarray(o + 8, o + 8 + ml);
    const rawOffset = o + 12 + ml;
    const raw = buf.subarray(rawOffset, rawOffset + rl);
    if (!sha(meta, raw).equals(buf.subarray(o + len - 32, o + len))) { reason = "bad_sha"; break; }
    records.push({ offset: o, length: len, rawOffset, rawLength: rl, meta: JSON.parse(meta.toString("utf8")), raw });
    o += len;
  }
  return { records, validEnd: o, tailBytes: buf.length - o, tailReason: reason };
}

export const rawSha = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

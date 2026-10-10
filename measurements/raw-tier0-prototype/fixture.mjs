// Deterministic synthetic WS frames + explicitly supplied receive metadata. Not captured from any node.
import crypto from "node:crypto";

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hex = (r, n) => { let s = ""; for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)]; return s; };
const mix = (r, s) => [...s].map((c) => (/[a-f]/.test(c) && r() < 0.3 ? c.toUpperCase() : c)).join("");

export const FIXTURE_META = Object.freeze({
  host_id: "synthetic-host-1", boot_id: "6f1c2e3d-4b5a-4c69-8d7e-0a1b2c3d4e5f", source_id: "synthetic-base-ws",
  wall_base_ns: 1791611000000000000n, mono_base_ns: 5000000000000n, spacing_ns: 500000n,
});

export function makeFrames(n = 10000, seed = 173) {
  const r = prng(seed);
  const subs = ["0x" + hex(r, 32), "0x" + hex(r, 32)];
  const frames = [];
  for (let i = 0; i < n; i++) {
    const sub = subs[i % 2];
    const conn = i < n / 2 ? "conn-1" : "conn-2";
    let raw;
    if (i % 997 === 13) raw = Buffer.from(`{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"${sub}","result":{"address":"0x${hex(r, 40)}"`, "utf8");
    else {
      const res = {
        address: "0x" + mix(r, hex(r, 40)), topics: ["0x" + hex(r, 64), "0x" + hex(r, 64)], data: "0x" + hex(r, 128),
        blockNumber: "0x" + (52410000 + Math.floor(i / 4)).toString(16), blockHash: "0x" + hex(r, 64), transactionHash: "0x" + hex(r, 64),
        logIndex: "0x" + (i % 40).toString(16), removed: i % 251 === 7,
      };
      const keys = Object.keys(res).sort(() => r() - 0.5);
      const sp = r() < 0.5 ? "" : " ";
      const body = keys.map((k) => `${JSON.stringify(k)}:${sp}${JSON.stringify(res[k])}`).join("," + sp);
      let s = `{"jsonrpc":"2.0",${sp}"method":"eth_subscription","params":{"subscription":"${sub}","result":{${body}}}}`;
      if (i % 50 === 3) s = s.replace('"jsonrpc"', '"json\\u0072pc"');
      if (i % 64 === 5) s = `  ${s}\r\n`;
      raw = Buffer.from(s, "utf8");
    }
    const jitter = BigInt(Math.floor(r() * 20000));
    frames.push({
      seq: i + 1,
      raw,
      meta: {
        seq: i + 1,
        t_recv_wall_ns: String(FIXTURE_META.wall_base_ns + BigInt(i) * FIXTURE_META.spacing_ns + jitter),
        t_recv_mono_ns: String(FIXTURE_META.mono_base_ns + BigInt(i) * FIXTURE_META.spacing_ns + jitter),
        clock_source: "fixture_supplied",
        boot_id: FIXTURE_META.boot_id, host_id: FIXTURE_META.host_id, connection_id: conn, subscription_id: sub, source_id: FIXTURE_META.source_id,
      },
    });
  }
  return frames;
}

export function fixtureSha(frames) {
  const h = crypto.createHash("sha256");
  for (const f of frames) { h.update(JSON.stringify(f.meta)); h.update(f.raw); }
  return h.digest("hex");
}

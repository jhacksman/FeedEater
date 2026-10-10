// Deterministic synthetic receipt generator (fixtures only; no network). Usage: node gen.mjs <plan.json> <outdir>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const h = (s) => `0x${crypto.createHash("sha256").update(s).digest("hex")}`;
const q = (n) => `0x${BigInt(n).toString(16)}`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const blockHash = (n) => h(`block:${n}`);

export function syntheticLogs(call) {
  const p = call.request.params[0];
  if (call.segment === "overlap" && !p.topics) return [];
  const n = call.fromBlock;
  const log = (addr, topics, li, ts) => ({ address: addr, topics, data: `0x${"00".repeat(32)}${li.toString(16).padStart(2, "0")}`, blockNumber: q(n), blockHash: blockHash(n), transactionHash: h(`tx:${n}:${li}`), transactionIndex: q(li), logIndex: q(li), removed: false, ...(ts ? { blockTimestamp: q(946684800 + n * 2) } : {}) });
  if (p.topics) return p.topics[0].map((t, i) => log(p.address[0], [t, h(`pool:${n}`)], i, i === 0));
  return [log(p.address[call.index % p.address.length], [h(`unknown-event:${n}`), h(`arg:${n}`)], 5, false)];
}

export function writeReceipts(plan, dir, mutate = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const receipts = [];
  for (const c of plan.calls) {
    const req = { jsonrpc: "2.0", id: c.index + 1, method: c.request.method, params: c.request.params };
    const resp = { jsonrpc: "2.0", id: c.index + 1, result: syntheticLogs(c) };
    const m = mutate(c.index, req, resp) ?? {};
    if (m.drop) continue;
    const reqText = m.reqText ?? JSON.stringify(req);
    const respText = m.respText ?? JSON.stringify(resp);
    const rq = `call-${c.index}.request.json`;
    const rs = `call-${c.index}.response.json`;
    fs.writeFileSync(path.join(dir, rq), reqText);
    fs.writeFileSync(path.join(dir, rs), respText);
    receipts.push({ callIndex: c.index, request: { file: rq, sha256: m.reqSha ?? sha(reqText) }, response: { file: rs, sha256: m.respSha ?? sha(respText) } });
  }
  const idx = JSON.stringify({ schema: "backfill-receipts/1", planSha256: plan.planSha256, receipts }, null, 1);
  fs.writeFileSync(path.join(dir, "receipts.json"), idx);
  return sha(idx);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  console.log(writeReceipts(plan, process.argv[3]));
}

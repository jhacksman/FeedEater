// Bounded node freshness preflight (run by Codex on the measure host; A5 never ran it against a node).
// Budget: exactly 2 HTTP calls (eth_getBlockByNumber "latest") and 1 WS newHeads subscription.
// Pass requires all of:
//   - HTTP latest block number advances between the two calls (n2 > n1);
//   - latest block timestamp is within FE173_MAX_HEAD_LAG_S of this host's wall clock (NTP required);
//   - after the subscription ACK, two newHeads notifications arrive with strictly increasing number
//     and timestamp before FE173_HEADS_DEADLINE_S. An ACK or eth_blockNumber alone is insufficient.
// usage: node preflight.mjs OUT.json   (env: BASE_COLLECTOR_HTTP_URL, BASE_COLLECTOR_WS_URL, FE)
// exit 0 = fresh, 1 = not fresh / unreachable (stop the run), 2 = usage
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname);
const FE = process.env.FE ?? path.resolve(here, "../..");
const require = createRequire(`${FE}/modules/base-collector/package.json`);
const WebSocket = require("ws");
const out = process.argv[2];
const httpUrl = process.env.BASE_COLLECTOR_HTTP_URL;
const wsUrl = process.env.BASE_COLLECTOR_WS_URL;
if (out === undefined || !httpUrl || !wsUrl) {
  process.stderr.write("usage: BASE_COLLECTOR_HTTP_URL=... BASE_COLLECTOR_WS_URL=... node preflight.mjs OUT.json\n");
  process.exit(2);
}
const maxLagS = Number(process.env.FE173_MAX_HEAD_LAG_S ?? "30");
const headsDeadlineS = Number(process.env.FE173_HEADS_DEADLINE_S ?? "20");
const httpTimeoutMs = Number(process.env.FE173_HTTP_TIMEOUT_MS ?? "5000");
const gapMs = Number(process.env.FE173_HTTP_GAP_MS ?? "4000");
const reasons = [];
const res = { tool: "preflight", httpUrl, wsUrl, maxLagS, headsDeadlineS, http: [], wsAck: false, wsHeads: [], calls: { http: 0, wsSubscribe: 0 } };
const n = (h) => Number.parseInt(h, 16);

async function latest() {
  res.calls.http += 1;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), httpTimeoutMs);
  try {
    const r = await fetch(httpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }), signal: ctrl.signal });
    const b = await r.json();
    if (b?.result?.number === undefined) throw new Error(`malformed response: ${JSON.stringify(b).slice(0, 200)}`);
    const row = { number: n(b.result.number), timestamp: n(b.result.timestamp), hash: b.result.hash, atMs: Date.now() };
    res.http.push(row);
    return row;
  } finally {
    clearTimeout(t);
  }
}

function wsHeads() {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const done = (why) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      resolve(why);
    };
    const timer = setTimeout(() => done("deadline"), headsDeadlineS * 1000);
    ws.on("open", () => {
      res.calls.wsSubscribe += 1;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id === 1) {
        if (m.error !== undefined) return done("subscribe_error");
        res.wsAck = true;
      } else if (m.method === "eth_subscription" && res.wsAck) {
        const h = m.params.result;
        res.wsHeads.push({ number: n(h.number), timestamp: n(h.timestamp), atMs: Date.now() });
        if (res.wsHeads.length >= 2) done("two_heads");
      }
    });
    ws.on("error", (e) => done(`ws_error:${e.message}`));
    ws.on("close", () => done("ws_closed"));
  });
}

try {
  const a = await latest();
  const ws = await wsHeads();
  res.wsResult = ws;
  const wait = a.atMs + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const b = await latest();
  if (!(b.number > a.number)) reasons.push(`http_head_not_advancing(${a.number}->${b.number})`);
  const lagS = Math.round(Date.now() / 1000) - b.timestamp;
  res.lagS = lagS;
  if (Math.abs(lagS) > maxLagS) reasons.push(`head_timestamp_stale(lagS=${lagS})`);
  if (!res.wsAck) reasons.push(`ws_no_subscription_ack(${ws})`);
  const [h1, h2] = res.wsHeads;
  if (h2 === undefined) reasons.push(`ws_heads_not_observed(n=${res.wsHeads.length},${ws})`);
  else if (!(h2.number > h1.number && h2.timestamp > h1.timestamp)) reasons.push(`ws_heads_not_advancing(${h1.number}->${h2.number})`);
  res.head = b.number;
} catch (e) {
  reasons.push(`unreachable(${e instanceof Error ? e.message : String(e)})`);
}
res.reasons = reasons;
res.fresh = reasons.length === 0;
fs.writeFileSync(out, `${JSON.stringify(res, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ fresh: res.fresh, head: res.head ?? null, reasons })}\n`);
process.exit(res.fresh ? 0 : 1);

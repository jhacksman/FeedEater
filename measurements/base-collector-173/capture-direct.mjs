// Raw direct node capture with the collector's exact filters (built from the same settings and
// dist as collect/measure), timestamped with process.hrtime.bigint() on the measure host.
// usage: FE=/path/to/checkout (BASE_COLLECTOR_* env loaded) node capture-direct.mjs OUT.jsonl
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(`${process.env.FE}/modules/base-collector/package.json`);
const WebSocket = require("ws");
const { loadSettings, buildFilters, filterDigest } = await import(`${process.env.FE}/modules/base-collector/dist/index.js`);
const cfg = loadSettings(process.env);
const filters = buildFilters(cfg);
const out = fs.createWriteStream(process.argv[2], { flags: "wx" });
const line = (o) => out.write(`${JSON.stringify(o)}\n`);
line({ type: "meta", phase: "start", tool: "capture-direct", clock: "process.hrtime.bigint", hrNs: process.hrtime.bigint().toString(), wallMs: Date.now(), host: os.hostname(), platform: process.platform, node: process.version, wsUrl: cfg.wsUrl, filterDigest: filterDigest(cfg), filters });
let stopping = false;
const ws = new WebSocket(cfg.wsUrl);
ws.on("open", () => filters.forEach((f, i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "eth_subscribe", params: ["logs", f] }))));
ws.on("message", (d) => {
  const hrNs = process.hrtime.bigint().toString();
  if (stopping) return;
  const msg = JSON.parse(d.toString());
  if (msg.error !== undefined) line({ type: "rpc_error", hrNs, wallMs: Date.now(), id: msg.id ?? null, error: msg.error });
  else if (msg.method === "eth_subscription") line({ type: "log", hrNs, wallMs: Date.now(), ...msg.params.result });
});
ws.on("error", (e) => {
  if (!stopping) line({ type: "ws_error", hrNs: process.hrtime.bigint().toString(), wallMs: Date.now(), error: e.message });
});
ws.on("close", () => {
  if (!stopping) line({ type: "direct_ws_closed", hrNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
});
for (const s of ["SIGINT", "SIGTERM"]) {
  process.once(s, () => {
    stopping = true;
    ws.terminate();
    line({ type: "meta", phase: "stop", hrNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
    out.end(() => process.exit(0));
  });
}

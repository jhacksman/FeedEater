#!/usr/bin/env node
// Toy client for compose-drill.sh (fake loopback only). One WS connection through ws-guard (logs
// filter 0 + newHeads, never reconnects) and eth_blockNumber over HTTP through rpc-guard every
// --http-interval-ms; with --bad-after K it sends one disallowed method after K HTTP 200 responses.
// Logs events (hrNs, ids, status, byte counts; no payloads) to LOG.
//   node toy-client.mjs HTTP_URL WS_URL MODE LOG FILTERS [--http-interval-ms N] [--bad-after K]
// MODE on SIGTERM/SIGINT: prompt (exit 0) | delay:MS (traffic continues, exit 0 after MS) | ignore.
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
const WS = createRequire(`${process.env.ASM}/ws-guard.mjs`)("ws");
const [httpUrl, wsUrl, mode, log, filters, ...a] = process.argv.slice(2);
const o = { "http-interval-ms": 100, "bad-after": 0 };
for (let i = 0; i < a.length; i += 2) o[a[i].slice(2)] = Number(a[i + 1]);
const fd = fs.openSync(log, "wx");
const L = (x) => fs.writeSync(fd, `${JSON.stringify({ hrNs: process.hrtime.bigint().toString(), ...x })}\n`);
let n = 0;
let ok200 = 0;
let badSent = false;
function post(method) {
  const id = ++n;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });
  L({ ev: "http_send", id, method });
  const req = http.request(httpUrl, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
    res.resume();
    res.on("end", () => {
      if (res.statusCode === 200) ok200 += 1;
      L({ ev: "http_resp", id, status: res.statusCode });
    });
  });
  req.on("error", (e) => L({ ev: "http_error", id, code: e.code ?? null }));
  req.end(body);
}
setInterval(() => {
  if (o["bad-after"] > 0 && !badSent && ok200 >= o["bad-after"]) {
    badSent = true;
    post("eth_sendRawTransaction");
    return;
  }
  post("eth_blockNumber");
}, o["http-interval-ms"]);
const f0 = JSON.parse(fs.readFileSync(filters, "utf8"))[0];
const w = new WS.WebSocket(wsUrl);
let msgs = 0;
w.on("open", () => {
  L({ ev: "ws_open" });
  w.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", f0] }));
  w.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
});
w.on("message", (d) => {
  msgs += 1;
  L({ ev: "ws_msg", bytes: d.length });
});
w.on("close", (code) => L({ ev: "ws_close", code, msgs }));
w.on("error", (e) => L({ ev: "ws_error", code: e.code ?? null }));
const onSig = (s) => {
  L({ ev: "signal", s, mode });
  if (mode === "prompt") process.exit(0);
  if (mode.startsWith("delay:")) setTimeout(() => process.exit(0), Number(mode.slice(6)));
};
process.on("SIGTERM", () => onSig("TERM"));
process.on("SIGINT", () => onSig("INT"));

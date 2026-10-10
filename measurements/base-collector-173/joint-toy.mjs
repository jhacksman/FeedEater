#!/usr/bin/env node
// Toy client for verify-joint.sh (fake loopback only). HTTP eth_blockNumber through the joint guard every
// --http-interval-ms (plus --http-burst concurrent at start; one disallowed method after --bad-after 200s);
// --ws-conns WS connections, each sending --ws-subs logs subscribes (filter 0) and one newHeads on open; no
// reconnect. Logs hrNs events (ids, status, byte counts; no payloads) to LOG.
//   node joint-toy.mjs HTTP_URL WS_URL MODE LOG FILTERS [--http-interval-ms N] [--http-burst N] [--bad-after K] [--ws-conns N] [--ws-subs N]
// MODE on SIGTERM/SIGINT: prompt (exit 0) | delay:MS (traffic continues, exit 0 after MS) | ignore.
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
const WS = createRequire(import.meta.url)("ws");
const [httpUrl, wsUrl, mode, log, filters, ...a] = process.argv.slice(2);
const o = { "http-interval-ms": 30, "http-burst": 0, "bad-after": 0, "ws-conns": 1, "ws-subs": 1 };
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
  const req = http.request(httpUrl, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
    res.resume();
    res.on("end", () => {
      if (res.statusCode === 200) ok200 += 1;
      L({ ev: "http_resp", id, status: res.statusCode });
    });
  });
  req.on("error", (e) => L({ ev: "http_error", id, code: e.code ?? null }));
  req.end(body);
}
for (let i = 0; i < o["http-burst"]; i++) post("eth_blockNumber");
setInterval(() => {
  if (o["bad-after"] > 0 && !badSent && ok200 >= o["bad-after"]) {
    badSent = true;
    post("eth_sendRawTransaction");
    return;
  }
  post("eth_blockNumber");
}, o["http-interval-ms"]);
const f0 = JSON.parse(fs.readFileSync(filters, "utf8"))[0];
for (let k = 1; k <= o["ws-conns"]; k++) {
  const w = new WS.WebSocket(wsUrl);
  let msgs = 0;
  w.on("open", () => {
    L({ ev: "ws_open", k });
    for (let s = 1; s <= o["ws-subs"]; s++) w.send(JSON.stringify({ jsonrpc: "2.0", id: s, method: "eth_subscribe", params: ["logs", f0] }));
    w.send(JSON.stringify({ jsonrpc: "2.0", id: 1000, method: "eth_subscribe", params: ["newHeads"] }));
  });
  w.on("message", (d) => {
    msgs += 1;
    L({ ev: "ws_msg", k, bytes: d.length });
  });
  w.on("close", (code) => L({ ev: "ws_close", k, code, msgs }));
  w.on("error", (e) => L({ ev: "ws_error", k, code: e.code ?? null }));
}
const onSig = (s) => {
  L({ ev: "signal", s, mode });
  if (mode === "prompt") process.exit(0);
  if (mode.startsWith("delay:")) setTimeout(() => process.exit(0), Number(mode.slice(6)));
};
process.on("SIGTERM", () => onSig("TERM"));
process.on("SIGINT", () => onSig("INT"));

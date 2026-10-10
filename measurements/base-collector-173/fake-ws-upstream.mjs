#!/usr/bin/env node
// Offline fake WS JSON-RPC upstream for verify-ws-guard.sh. 127.0.0.1 only; no outbound calls.
//   node fake-ws-upstream.mjs LOG [--notify N] [--interval-ms M] [--frame-bytes B] [--close-after-ms T] [--accept-delay-ms D]
// Answers each eth_subscribe with {"result":"0xs<conn>_<n>"}, then sends N notifications per subscription
// every M ms (each padded to B bytes when B is set). Logs every connection and every frame it receives
// or sends (sha256 + bytes) to LOG; prints {"port":P} when listening.
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const WS = createRequire(import.meta.url)("ws");
const [log, ...a] = process.argv.slice(2);
const o = { notify: 3, "interval-ms": 20, "frame-bytes": 0, "close-after-ms": 0, "accept-delay-ms": 0 };
for (let i = 0; i < a.length; i += 2) o[a[i].slice(2)] = Number(a[i + 1]);
const fd = fs.openSync(log, "wx");
const L = (x) => fs.writeSync(fd, `${JSON.stringify({ hrNs: process.hrtime.bigint().toString(), ...x })}\n`);
const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
const hs = http.createServer();
const wss = new WS.WebSocketServer({ noServer: true });
hs.on("upgrade", (req, sock, head) => setTimeout(() => wss.handleUpgrade(req, sock, head, (w) => wss.emit("connection", w)), o["accept-delay-ms"]));
let conn = 0;
wss.on("connection", (w) => {
  const c = ++conn;
  let n = 0;
  L({ ev: "connection", c });
  const out = (s) => {
    if (w.readyState !== 1) return;
    w.send(s);
    L({ ev: "sent", c, sha: sha(s), bytes: Buffer.byteLength(s) });
  };
  if (o["close-after-ms"] > 0) setTimeout(() => w.close(1000, "fake close"), o["close-after-ms"]);
  w.on("message", (d) => {
    L({ ev: "recv", c, sha: sha(d), bytes: d.length });
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    if (m.method !== "eth_subscribe") return;
    const sub = `0xs${c}_${++n}`;
    out(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: sub }));
    let k = 0;
    const t = setInterval(() => {
      if (++k > o.notify || w.readyState !== 1) return clearInterval(t);
      const base = { jsonrpc: "2.0", method: "eth_subscription", params: { subscription: sub, result: { k, kind: m.params[0] } } };
      let s = JSON.stringify(base);
      if (o["frame-bytes"] > s.length) s = JSON.stringify({ ...base, pad: "x".repeat(o["frame-bytes"] - s.length - 10) });
      out(s);
    }, o["interval-ms"]);
  });
  w.on("close", () => L({ ev: "closed", c }));
});
hs.listen(0, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ port: hs.address().port })}\n`));
process.on("SIGTERM", () => process.exit(0));

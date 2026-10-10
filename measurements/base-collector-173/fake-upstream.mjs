#!/usr/bin/env node
// Offline fake JSON-RPC upstream for verify-guard.sh. 127.0.0.1 only; makes no outbound calls.
// Appends one JSONL line per request it receives to LOG (hrNs, inflight at arrival, body) and
// prints {"port":N} once listening.
//   node fake-upstream.mjs LOG [ok|slow:MS]
import http from "node:http";
import fs from "node:fs";

const [log, mode = "ok"] = process.argv.slice(2);
const delay = mode.startsWith("slow:") ? Number(mode.slice(5)) : 0;
const fd = fs.openSync(log, "wx");
let inflight = 0;
const hex = (n) => `0x${n.toString(16)}`;
http
  .createServer((req, res) => {
    inflight += 1;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      fs.writeSync(fd, `${JSON.stringify({ hrNs: process.hrtime.bigint().toString(), inflight, method: req.method, body })}\n`);
      let id = null;
      let method = null;
      try {
        ({ id, method } = JSON.parse(body));
      } catch {}
      const result = method === "eth_blockNumber" ? "0x64" : method === "eth_getBlockByNumber" ? { number: "0x64", timestamp: hex(Math.floor(Date.now() / 1000)) } : [];
      setTimeout(() => {
        inflight -= 1;
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      }, delay);
    });
    req.on("close", () => {
      if (!res.writableEnded) inflight -= 1;
    });
  })
  .listen(0, "127.0.0.1", function () {
    process.stdout.write(`${JSON.stringify({ port: this.address().port })}\n`);
  });

// Local fake node for the offline preflight tests only (127.0.0.1, random ports). Never a node probe.
// usage: node fake-node.mjs fresh|stale|http-stuck|ack-only|ws-stuck   -> prints {"http":P,"ws":P}
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname);
const FE = process.env.FE ?? path.resolve(here, "../..");
const require = createRequire(`${FE}/modules/base-collector/package.json`);
const { WebSocketServer } = require("ws");
const sc = process.argv[2];
const hex = (n) => `0x${n.toString(16)}`;
const now = () => Math.floor(Date.now() / 1000);
let httpN = 36_000_000;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id } = JSON.parse(body);
    if (sc !== "http-stuck") httpN += 1;
    const ts = sc === "stale" ? now() - 600 : now();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { number: hex(httpN), timestamp: hex(ts), hash: `0x${"ab".repeat(32)}` } }));
  });
});
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("connection", (ws) => {
  ws.on("message", (d) => {
    const { id } = JSON.parse(d.toString());
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x5ub" }));
    if (sc === "ack-only") return;
    let k = 0;
    const t = setInterval(() => {
      k += 1;
      const num = sc === "ws-stuck" ? httpN : httpN + k;
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0x5ub", result: { number: hex(num), timestamp: hex(now() + (sc === "ws-stuck" ? 0 : k)) } } }));
    }, 300);
    ws.on("close", () => clearInterval(t));
  });
});
srv.listen(0, "127.0.0.1", () => {
  wss.on("listening", () => {});
  const go = () => process.stdout.write(`${JSON.stringify({ http: srv.address().port, ws: wss.address().port })}\n`);
  if (wss.address()) go();
  else wss.once("listening", go);
});

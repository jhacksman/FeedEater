#!/usr/bin/env node
// Loopback JSON-RPC request guard (preparation only; not wired into run-native.sh).
// Listens on 127.0.0.1 only and forwards a strict read-only allowlist to one upstream, one request
// at a time, at most --cap requests, at least --min-interval-ms apart, each bounded by --timeout-ms.
// Every request is numbered and logged when it arrives, before any forwarding decision. Refused
// requests (invalid, disallowed, batch, over cap) never reach the upstream; the first refusal writes
// <run-dir>/guard.STOP, stops dispatch at once and drops every queued request with an explicit
// response. Send starts are spaced by at least --min-interval-ms on the ns monotonic clock. Block
// quantities are hex <= 2^53-1 and compared as BigInt. Summary reconciles admitted = forwarded +
// dropped and forwarded = completed + upstream errors.
//   node rpc-guard.mjs --run-dir ABS_DIR --upstream http://host:port[/path] --cap N
//        --min-interval-ms MS --timeout-ms MS --max-log-span BLOCKS [--port P] [--methods a,b]
// Files in --run-dir: guard.jsonl (evidence, created exclusively), guard.ready.json, guard.STOP,
// guard.summary.json. Exit 2 on invalid configuration; 0 after SIGTERM/SIGINT shutdown.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ALLOWED = ["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"];
const MAX_BODY = 65536;
const MAX_RESPONSE = 64 * 1024 * 1024;
const SHUTDOWN_MS = 2000;

const args = process.argv.slice(2);
const die = (why) => {
  process.stderr.write(`rpc-guard: ${why}\n`);
  process.exit(2);
};
const known = new Set(["run-dir", "upstream", "cap", "min-interval-ms", "timeout-ms", "max-log-span", "port", "methods"]);
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || !known.has(args[i].slice(2))) die(`unknown argument ${args[i]}`);
  if (args[i + 1] === undefined) die(`${args[i]} needs a value`);
}
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const int = (k, min, max, dflt) => {
  const v = opt(k);
  if (v === undefined && dflt !== undefined) return dflt;
  if (v === undefined || !/^(0|[1-9][0-9]*)$/.test(v)) die(`--${k} must be an integer in [${min}, ${max}]`);
  const n = Number(v);
  if (n < min || n > max) die(`--${k} must be an integer in [${min}, ${max}]`);
  return n;
};

const runDir = opt("run-dir");
if (runDir === undefined || !path.isAbsolute(runDir)) die("--run-dir must be an absolute path");
if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) die(`--run-dir ${runDir} is not an existing directory`);
const upRaw = opt("upstream");
let up;
try {
  up = new URL(upRaw ?? "");
} catch {
  die("--upstream must be an http:// URL");
}
if (up.protocol !== "http:" || up.username !== "" || up.password !== "" || up.search !== "" || up.hash !== "") {
  die("--upstream must be a plain http:// URL without credentials, query or fragment");
}
const cap = int("cap", 0, 100000);
const minIntervalMs = int("min-interval-ms", 0, 60000);
const timeoutMs = int("timeout-ms", 1, 60000);
const maxLogSpan = int("max-log-span", 1, 10000);
const port = int("port", 0, 65535, 0);
const methods = new Set((opt("methods") ?? ALLOWED.join(",")).split(","));
for (const m of methods) if (!ALLOWED.includes(m)) die(`--methods: ${m} is not in the read-only allowlist ${ALLOWED.join(",")}`);

let fd;
try {
  fd = fs.openSync(path.join(runDir, "guard.jsonl"), "wx");
} catch {
  die(`cannot create ${path.join(runDir, "guard.jsonl")} exclusively (exists or unwritable)`);
}
const ev = (o) => fs.writeSync(fd, `${JSON.stringify({ hrNs: process.hrtime.bigint().toString(), ...o })}\n`);
const nowNs = () => process.hrtime.bigint();
const intervalNs = BigInt(minIntervalMs) * 1000000n;
const MAX_BLOCK = (1n << 53n) - 1n;

const st = { received: 0, admitted: 0, forwarded: 0, completed: 0, dropped: 0, upstreamErrors: {}, refused: {} };
let stopReason = null;
let stopping = false;
let lastSendNs = null;
let inflight = null;
const queue = [];
let pumping = null;
let pacer = null;

const HEX = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const qty = (x) => (x.length <= 16 && BigInt(x) <= MAX_BLOCK ? BigInt(x) : null);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TOPIC = /^0x[0-9a-fA-F]{64}$/;
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

function validate(m) {
  if (!isObj(m)) return "not_object";
  for (const k of Object.keys(m)) if (!["jsonrpc", "id", "method", "params"].includes(k)) return "extra_field";
  if (m.jsonrpc !== "2.0") return "jsonrpc_version";
  if (!((typeof m.id === "number" && Number.isSafeInteger(m.id)) || (typeof m.id === "string" && m.id.length <= 64))) return "bad_id";
  if (typeof m.method !== "string" || !methods.has(m.method)) return "method_not_allowed";
  if (!Array.isArray(m.params)) return "bad_params";
  const p = m.params;
  if (m.method === "eth_blockNumber") return p.length === 0 ? null : "bad_params";
  if (m.method === "eth_getBlockByNumber") {
    if (p.length !== 2 || p[1] !== false || typeof p[0] !== "string") return "bad_params";
    if (p[0] === "latest") return null;
    if (!HEX.test(p[0])) return "bad_params";
    return qty(p[0]) === null ? "quantity_out_of_range" : null;
  }
  // eth_getLogs: one filter with an explicit address set and a bounded hex block range.
  if (p.length !== 1 || !isObj(p[0])) return "bad_params";
  const f = p[0];
  for (const k of Object.keys(f)) if (!["address", "topics", "fromBlock", "toBlock"].includes(k)) return "logs_bad_field";
  const addrs = typeof f.address === "string" ? [f.address] : f.address;
  if (!Array.isArray(addrs) || addrs.length === 0 || !addrs.every((a) => typeof a === "string" && ADDR.test(a))) return "logs_address_required";
  if (f.topics !== undefined) {
    const okTopic = (t) => t === null || (typeof t === "string" && TOPIC.test(t)) || (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && TOPIC.test(x)));
    if (!Array.isArray(f.topics) || f.topics.length > 4 || !f.topics.every(okTopic)) return "logs_bad_topics";
  }
  if (typeof f.fromBlock !== "string" || typeof f.toBlock !== "string" || !HEX.test(f.fromBlock) || !HEX.test(f.toBlock)) return "logs_range_not_hex";
  const from = qty(f.fromBlock);
  const to = qty(f.toBlock);
  if (from === null || to === null) return "quantity_out_of_range";
  if (to < from) return "logs_range_reversed";
  if (to - from + 1n > BigInt(maxLogSpan)) return "logs_span_exceeded";
  return null;
}

const idOf = (m) => (isObj(m) && (typeof m.id === "number" || typeof m.id === "string") ? m.id : null);
function reply(res, status, id, code, message) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
  res.end(body);
}
function refuse(seq, res, reason, id) {
  st.refused[reason] = (st.refused[reason] ?? 0) + 1;
  ev({ ev: "refuse", seq, reason });
  if (stopReason === null && reason !== "shutting_down") {
    stopReason = reason;
    fs.writeFileSync(path.join(runDir, "guard.STOP"), `${JSON.stringify({ reason, seq, hrNs: process.hrtime.bigint().toString() })}\n`);
    ev({ ev: "stop", seq, reason, queued: queue.length });
    halt("stopped");
  }
  const status = reason === "cap_exceeded" || reason === "stopped" ? 429 : reason === "shutting_down" ? 503 : 400;
  reply(res, status, id, -32005, `rpc-guard refused: ${reason}`);
}

function handle(seq, text, res) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return refuse(seq, res, "malformed_json", null);
  }
  if (Array.isArray(m)) return refuse(seq, res, "batch", null);
  const bad = validate(m);
  if (bad !== null) return refuse(seq, res, bad, idOf(m));
  if (stopping) return refuse(seq, res, "shutting_down", m.id);
  if (stopReason !== null) return refuse(seq, res, "stopped", m.id);
  if (st.admitted >= cap) return refuse(seq, res, "cap_exceeded", m.id);
  st.admitted += 1;
  const n = st.admitted;
  ev({ ev: "admit", seq, n, method: m.method, params: m.params });
  queue.push({ seq, n, m, res });
  if (pumping === null) pumping = pump().finally(() => (pumping = null));
}

const halted = () => stopping || stopReason !== null;
// Drop every queued (admitted, unsent) request with an explicit response and cancel any pacing wait.
function halt(reason) {
  while (queue.length > 0) {
    const { seq, n, m, res } = queue.shift();
    st.dropped += 1;
    ev({ ev: "drop", seq, n, reason });
    reply(res, 503, m.id, -32005, `rpc-guard dropped before send: ${reason}`);
  }
  if (pacer !== null) {
    clearTimeout(pacer.timer);
    pacer.resolve();
    pacer = null;
  }
}
// Wait until at least intervalNs has passed since the previous send start (ns clock, re-checked after
// every timer, so a forward never starts early). Returns early if halted.
async function paced() {
  while (lastSendNs !== null && !halted()) {
    const left = lastSendNs + intervalNs - nowNs();
    if (left <= 0n) return;
    await new Promise((resolve) => {
      pacer = { resolve, timer: setTimeout(resolve, Number((left + 999999n) / 1000000n)) };
    });
    pacer = null;
  }
}
async function pump() {
  while (queue.length > 0 && !halted()) {
    await paced();
    if (halted() || queue.length === 0) break;
    await forward(queue.shift());
  }
}

async function forward(job) {
  const { seq, n, m, res } = job;
  lastSendNs = nowNs();
  st.forwarded += 1;
  ev({ ev: "forward", seq, n, f: st.forwarded, method: m.method, startNs: lastSendNs.toString() });
  const body = JSON.stringify(m);
  await new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    const finish = (o, send) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      inflight = null;
      ev({ seq, n, ...o });
      send();
      resolve();
    };
    const r = http.request(
      { host: up.hostname, port: up.port || 80, path: up.pathname || "/", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (ur) => {
        const chunks = [];
        let size = 0;
        ur.on("data", (c) => {
          size += c.length;
          if (size > MAX_RESPONSE) r.destroy(new Error("response_too_large"));
          else chunks.push(c);
        });
        ur.on("end", () => {
          if (r.destroyed && size > MAX_RESPONSE) return;
          const buf = Buffer.concat(chunks);
          st.completed += 1;
          finish({ ev: "response", status: ur.statusCode, bytes: buf.length }, () => {
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(ur.statusCode ?? 502, { "content-type": "application/json", "content-length": buf.length, connection: "close" });
            res.end(buf);
          });
        });
        ur.on("error", (e) => r.destroy(e));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      r.destroy(new Error("timeout"));
    }, timeoutMs);
    r.on("error", (e) => {
      const reason = timedOut ? "timeout" : stopping ? "aborted_shutdown" : (e.code ?? e.message);
      st.upstreamErrors[reason] = (st.upstreamErrors[reason] ?? 0) + 1;
      finish({ ev: "upstream_error", reason }, () => reply(res, reason === "timeout" ? 504 : 502, m.id, -32003, `rpc-guard upstream ${reason}`));
    });
    inflight = r;
    r.end(body);
  });
}

const server = http.createServer((req, res) => {
  const seq = ++st.received;
  ev({ ev: "recv", seq, httpMethod: req.method });
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
  });
  req.on("end", () => {
    if (req.method !== "POST") return refuse(seq, res, "http_method", null);
    if (size > MAX_BODY) return refuse(seq, res, "body_too_large", null);
    handle(seq, Buffer.concat(chunks).toString("utf8"), res);
  });
  req.on("error", () => undefined);
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  ev({ ev: "shutdown", signal: sig });
  server.close();
  server.closeIdleConnections?.();
  halt("shutting_down");
  inflight?.destroy(new Error("aborted_shutdown"));
  const end = () => {
    const upstreamErrorTotal = Object.values(st.upstreamErrors).reduce((a, b) => a + b, 0);
    const reconciled = st.admitted === st.forwarded + st.dropped && st.forwarded === st.completed + upstreamErrorTotal;
    const summary = { cap, minIntervalMs, timeoutMs, maxLogSpan, methods: [...methods], upstream: up.href, stopReason, ...st, inflightAtExit: inflight !== null, reconciled };
    ev({ ev: "summary", ...summary });
    fs.writeFileSync(path.join(runDir, "guard.summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    fs.closeSync(fd);
    process.exit(0);
  };
  const force = setTimeout(end, SHUTDOWN_MS);
  Promise.resolve(pumping).then(() => {
    clearTimeout(force);
    end();
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, "127.0.0.1", () => {
  const a = server.address();
  const ready = { pid: process.pid, url: `http://127.0.0.1:${a.port}`, cap, minIntervalMs, timeoutMs, maxLogSpan, methods: [...methods], upstream: up.href };
  ev({ ev: "start", ...ready });
  fs.writeFileSync(path.join(runDir, "guard.ready.json"), `${JSON.stringify(ready)}\n`);
});
server.on("error", (e) => {
  process.stderr.write(`rpc-guard: listen failed: ${e.message}\n`);
  process.exit(2);
});

#!/usr/bin/env node
// Loopback joint HTTP JSON-RPC + WS guard behind one latch (preparation only; not wired into run-native.sh
// or the collector). One process, one synchronous latch, one monotonic clock (process.hrtime.bigint()) and
// one seq over every logged event.
//   node joint-guard.mjs --run-dir ABS_DIR --http-upstream http://host:port[/path] --cap N --min-interval-ms MS
//     --timeout-ms MS --max-log-span B --methods a,b --ws-upstream ws://host:port[/path] --filters FILE
//     [--allow-new-heads] --max-concurrent N --max-connections N --max-messages N --max-bytes N
//     --max-frame-bytes N --max-duration-s N --max-preopen-frames N
// Every option is required. HTTP rules come from rpc-guard.mjs@4df26b2 and WS rules from ws-guard.mjs@f694290
// (verbatim blocks pinned in joint-rules.json). New: --max-preopen-frames caps frames queued per connection
// before its upstream opens. The first HTTP refusal, WS refusal/cap/upstream close/error, duration cap or
// TERM/INT sets the latch; every HTTP admit/send and WS forward checks it synchronously in the same callback,
// so no admission or forward decision can follow the latch seq. Then JOINT.STOP is written, both listeners
// close, queued HTTP requests get 503 (dropped), queued WS frames are dropped, WS connections close 1008.
// After up to 2 s for pre-latch in-flight work joint.summary.json is written; exit 10 (0 after TERM/INT,
// 2 usage). Files: joint.jsonl (exclusive), joint-guard.ready.json, JOINT.STOP, joint.summary.json.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const WS = createRequire(import.meta.url)("ws");

const ALLOWED = ["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"];
const MAX_BODY = 65536;
const MAX_RESPONSE = 64 * 1024 * 1024;
const SHUTDOWN_MS = 2000;
const die = (why) => {
  process.stderr.write(`joint-guard: ${why}\n`);
  process.exit(2);
};
const KNOWN = ["run-dir", "http-upstream", "cap", "min-interval-ms", "timeout-ms", "max-log-span", "methods", "ws-upstream", "filters",
  "max-concurrent", "max-connections", "max-messages", "max-bytes", "max-frame-bytes", "max-duration-s", "max-preopen-frames"];
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--allow-new-heads") {
    opt.allowNewHeads = true;
    continue;
  }
  const k = a[i].startsWith("--") ? a[i].slice(2) : "";
  if (!KNOWN.includes(k)) die(`unknown argument ${a[i]}`);
  if (Object.hasOwn(opt, k)) die(`duplicate --${k}`);
  if (a[i + 1] === undefined) die(`${a[i]} needs a value`);
  opt[k] = a[++i];
}
for (const k of KNOWN) if (opt[k] === undefined) die(`--${k} is required`);
const int = (k, min, max) => {
  const v = opt[k];
  if (!/^(0|[1-9][0-9]*)$/.test(v) || Number(v) < min || Number(v) > max) die(`--${k} must be an integer in [${min}, ${max}]`);
  return Number(v);
};
const plainUrl = (k, proto) => {
  let u;
  try {
    u = new URL(opt[k]);
  } catch {
    die(`--${k} must be a ${proto}// URL`);
  }
  if (u.protocol !== proto || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") die(`--${k} must be a plain ${proto}// URL without credentials, query or fragment`);
  return u;
};
const runDir = opt["run-dir"];
if (!path.isAbsolute(runDir) || !fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) die("--run-dir must be an existing absolute directory");
const up = plainUrl("http-upstream", "http:");
const wsUp = plainUrl("ws-upstream", "ws:");
const cap = int("cap", 0, 100000);
const minIntervalMs = int("min-interval-ms", 0, 60000);
const timeoutMs = int("timeout-ms", 1, 60000);
const maxLogSpan = int("max-log-span", 1, 10000);
const methods = new Set(opt.methods.split(","));
for (const m of methods) if (!ALLOWED.includes(m)) die(`--methods: ${m} is not in the read-only allowlist ${ALLOWED.join(",")}`);
const lim = {
  concurrent: int("max-concurrent", 1, 64),
  connections: int("max-connections", 1, 1024),
  messages: int("max-messages", 1, 1e9),
  bytes: int("max-bytes", 1, 1e12),
  frameBytes: int("max-frame-bytes", 1, 64 * 1024 * 1024),
  durationS: int("max-duration-s", 1, 86400),
  preopen: int("max-preopen-frames", 1, 1024),
};
const nowNs = () => process.hrtime.bigint();
const intervalNs = BigInt(minIntervalMs) * 1000000n;
const MAX_BLOCK = (1n << 53n) - 1n;

// verbatim rpc-guard.mjs@4df26b2:88-134
const httpRules = (() => {
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
return { validate, idOf, reply };
})();
// verbatim ws-guard.mjs@f694290:54, :61, :63, :130-151
const wsRules = (() => {
const lc = (x) => (typeof x === "string" ? x.toLowerCase() : Array.isArray(x) ? x.map(lc) : x === null ? null : typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, lc(v)])) : x);
const okFilter = (f) => f !== null && typeof f === "object" && !Array.isArray(f) && Object.keys(f).every((k) => k === "address" || k === "topics") && f.address !== undefined;
const canon = (f) => JSON.stringify({ address: lc(f.address), topics: f.topics === undefined ? null : lc(f.topics) });
function validate(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { reason: "malformed_json" };
  }
  if (Array.isArray(m)) return { reason: "batch_refused" };
  if (m === null || typeof m !== "object") return { reason: "not_object" };
  if (Object.keys(m).some((k) => !["jsonrpc", "id", "method", "params"].includes(k))) return { reason: "extra_field" };
  if (m.jsonrpc !== "2.0" || !(typeof m.id === "number" || typeof m.id === "string")) return { reason: "bad_envelope" };
  const p = m.params;
  if (m.method === "eth_unsubscribe") return Array.isArray(p) && p.length === 1 && typeof p[0] === "string" ? { kind: "unsubscribe" } : { reason: "bad_params" };
  if (m.method !== "eth_subscribe") return { reason: "method_not_allowed" };
  if (!Array.isArray(p)) return { reason: "bad_params" };
  if (p.length === 1 && p[0] === "newHeads") return opt.allowNewHeads ? { kind: "newHeads" } : { reason: "newheads_not_allowed" };
  if (p.length === 2 && p[0] === "logs" && okFilter(p[1])) {
    const i = allowedCanon.indexOf(canon(p[1]));
    return i >= 0 ? { kind: "logs", filter: i } : { reason: "filter_not_allowed" };
  }
  return { reason: "subscription_not_allowed" };
}
return { okFilter, canon, validate };
})();

let allowed;
try {
  allowed = JSON.parse(fs.readFileSync(opt.filters, "utf8"));
} catch {
  die("--filters must be a readable JSON array of log filters");
}
if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(wsRules.okFilter)) die("--filters must be a non-empty array of {address[,topics]} objects");
const allowedCanon = allowed.map(wsRules.canon);

let fd;
try {
  fd = fs.openSync(path.join(runDir, "joint.jsonl"), "wx");
} catch {
  die(`cannot create ${path.join(runDir, "joint.jsonl")} exclusively (exists or unwritable)`);
}
let seq = 0;
const ev = (o) => {
  seq += 1;
  fs.writeSync(fd, `${JSON.stringify({ seq, hrNs: nowNs().toString(), ...o })}\n`);
  return seq;
};
const bump = (o, k) => {
  o[k] = (o[k] ?? 0) + 1;
};

// ---- the one latch: set once, synchronously, before anything else is stopped
let latch = null;
const halted = () => latch !== null;
const dec = { httpAdmit: 0, httpForward: 0, wsUp: 0, wsDown: 0, afterLatch: 0 };
const decide = (k) => {
  dec[k] += 1;
  if (latch !== null) dec.afterLatch += 1;
};
function stopAll(transport, reason, detail = {}) {
  if (latch !== null) return;
  latch = { transport, reason, ...detail, hrNs: nowNs().toString() };
  latch.preLatch = {
    httpInflight: hInflight !== null ? 1 : 0,
    httpQueued: queue.length,
    wsInflightSends: wsInflight,
    wsInflightBytes,
    wsUserspaceBufferedBytes: [...conns].reduce((s, c) => s + (c.client.bufferedAmount ?? 0) + (c.upstream?.bufferedAmount ?? 0), 0),
    wsPreopenQueued: [...conns].reduce((s, c) => s + c.queue.length, 0),
  };
  latch.seq = ev({ ev: "latch", ...latch });
  fs.writeFileSync(path.join(runDir, "JOINT.STOP"), `${JSON.stringify(latch)}\n`);
  httpHalt("stopped");
  httpServer.close();
  httpServer.closeIdleConnections?.();
  wsServer.close();
  for (const c of conns) closeConn(c, "stopped");
  finish(transport === "signal" ? 0 : 10);
}

// ---- HTTP (rpc-guard.mjs@4df26b2 behaviour; refusal STOP latches both transports)
const hst = { received: 0, admitted: 0, refused: 0, aborted: 0, forwarded: 0, completed: 0, dropped: 0, upstreamErrors: 0, refusedReasons: {}, upstreamErrorReasons: {}, respondedAfterLatch: 0 };
let hPending = 0;
let lastSendNs = null;
let hInflight = null;
const queue = [];
let pumping = null;
let pacer = null;
function hRefuse(rseq, res, reason, id) {
  hst.refused += 1;
  bump(hst.refusedReasons, reason);
  ev({ ev: "http_refuse", rseq, reason });
  if (reason !== "stopped") stopAll("http", reason, { rseq });
  const status = reason === "cap_exceeded" || reason === "stopped" ? 429 : 400;
  httpRules.reply(res, status, id, -32005, `joint-guard refused: ${reason}`);
}
function hHandle(rseq, text, res) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return hRefuse(rseq, res, "malformed_json", null);
  }
  if (Array.isArray(m)) return hRefuse(rseq, res, "batch", null);
  const bad = httpRules.validate(m);
  if (bad !== null) return hRefuse(rseq, res, bad, httpRules.idOf(m));
  if (halted()) return hRefuse(rseq, res, "stopped", m.id);
  if (hst.admitted >= cap) return hRefuse(rseq, res, "cap_exceeded", m.id);
  decide("httpAdmit");
  hst.admitted += 1;
  const n = hst.admitted;
  ev({ ev: "http_admit", rseq, n, method: m.method, params: m.params });
  queue.push({ rseq, n, m, res });
  if (pumping === null) pumping = pump().finally(() => (pumping = null));
}
function httpHalt(reason) {
  while (queue.length > 0) {
    const { rseq, n, m, res } = queue.shift();
    hst.dropped += 1;
    ev({ ev: "http_drop", rseq, n, reason });
    httpRules.reply(res, 503, m.id, -32005, `joint-guard dropped before send: ${reason}`);
  }
  if (pacer !== null) {
    clearTimeout(pacer.timer);
    pacer.resolve();
    pacer = null;
  }
}
// verbatim rpc-guard.mjs@4df26b2:183-201
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
  const { rseq, n, m, res } = job;
  decide("httpForward");
  lastSendNs = nowNs();
  hst.forwarded += 1;
  ev({ ev: "http_forward", rseq, n, f: hst.forwarded, method: m.method, startNs: lastSendNs.toString() });
  const body = JSON.stringify(m);
  await new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    const fin = (o, send) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      hInflight = null;
      if (latch !== null) hst.respondedAfterLatch += 1;
      ev({ rseq, n, ...o });
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
          hst.completed += 1;
          fin({ ev: "http_response", status: ur.statusCode, bytes: buf.length }, () => {
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
      const reason = timedOut ? "timeout" : (e.code ?? e.message);
      hst.upstreamErrors += 1;
      bump(hst.upstreamErrorReasons, reason);
      fin({ ev: "http_upstream_error", reason }, () => httpRules.reply(res, reason === "timeout" ? 504 : 502, m.id, -32003, `joint-guard upstream ${reason}`));
    });
    hInflight = r;
    r.end(body);
  });
}
const httpServer = http.createServer((req, res) => {
  hst.received += 1;
  hPending += 1;
  const rseq = hst.received;
  ev({ ev: "http_recv", rseq, httpMethod: req.method });
  const chunks = [];
  let size = 0;
  let settled = false;
  req.on("data", (c) => {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
  });
  req.on("end", () => {
    settled = true;
    hPending -= 1;
    if (req.method !== "POST") return hRefuse(rseq, res, "http_method", null);
    if (size > MAX_BODY) return hRefuse(rseq, res, "body_too_large", null);
    hHandle(rseq, Buffer.concat(chunks).toString("utf8"), res);
  });
  req.on("close", () => {
    if (settled) return;
    settled = true;
    hPending -= 1;
    hst.aborted += 1;
    ev({ ev: "http_aborted", rseq });
  });
  req.on("error", () => undefined);
});
httpServer.requestTimeout = 10000;
httpServer.headersTimeout = 5000;

// ---- WS (ws-guard.mjs@f694290 behaviour; any STOP latches both transports; pre-open queue capped)
const wst = { connectionsAccepted: 0, connectionsRefused: 0, upstreamOpened: 0, received: 0, admitted: 0, refused: 0, dropped: 0, forwarded: 0, sendErrors: 0, bytesAdmitted: 0, refusedReasons: {}, droppedReasons: {} };
const conns = new Set();
let wsInflight = 0;
let wsInflightBytes = 0;
function closeConn(c, why) {
  if (c.closed) return;
  c.closed = true;
  for (const _ of c.queue) {
    wst.dropped += 1;
    bump(wst.droppedReasons, why);
  }
  if (c.queue.length > 0) ev({ ev: "ws_drop", c: c.id, n: c.queue.length, reason: why });
  c.queue = [];
  conns.delete(c);
  try {
    c.client.close(1008, why.slice(0, 60));
  } catch {}
  setTimeout(() => c.client.terminate(), 200).unref();
  c.upstream?.terminate();
  ev({ ev: "ws_close", c: c.id, reason: why });
}
function wsRefuse(c, dir, reason, frame = true) {
  if (frame) wst.refused += 1;
  bump(wst.refusedReasons, reason);
  ev({ ev: "ws_refuse", c: c?.id ?? null, dir, reason });
  stopAll("ws", reason, { c: c?.id ?? null, dir });
}
function wsAdmit(c, dir, data) {
  if (wst.admitted + 1 > lim.messages) return wsRefuse(c, dir, "messages_cap"), false;
  if (wst.bytesAdmitted + data.length > lim.bytes) return wsRefuse(c, dir, "bytes_cap"), false;
  wst.admitted += 1;
  wst.bytesAdmitted += data.length;
  return true;
}
function wsSend(c, dir, sock, data, isBinary) {
  decide(dir === "up" ? "wsUp" : "wsDown");
  wsInflight += 1;
  wsInflightBytes += data.length;
  ev({ ev: "ws_forward", c: c.id, dir, bytes: data.length });
  sock.send(data, { binary: isBinary }, (err) => {
    wsInflight -= 1;
    wsInflightBytes -= data.length;
    if (err) {
      wst.sendErrors += 1;
      ev({ ev: "ws_send_error", c: c.id, dir });
      stopAll("ws", "send_error", { c: c.id, dir });
    } else wst.forwarded += 1;
  });
}
const wsServer = new WS.WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: lim.frameBytes });
let nextId = 0;
wsServer.on("connection", (client) => {
  const c = { id: ++nextId, client, upstream: null, open: false, queue: [], closed: false };
  if (halted()) {
    client.terminate();
    return;
  }
  if (wst.connectionsAccepted + 1 > lim.connections || conns.size + 1 > lim.concurrent) {
    wst.connectionsRefused += 1;
    client.terminate();
    wsRefuse(c, "connect", wst.connectionsAccepted + 1 > lim.connections ? "connections_cap" : "concurrent_cap", false);
    return;
  }
  wst.connectionsAccepted += 1;
  conns.add(c);
  ev({ ev: "ws_accept", c: c.id, open: conns.size });
  const u = new WS.WebSocket(wsUp.href, { maxPayload: lim.frameBytes, perMessageDeflate: false });
  c.upstream = u;
  u.on("open", () => {
    wst.upstreamOpened += 1;
    ev({ ev: "ws_upstream_open", c: c.id });
    c.open = true;
    const q = c.queue;
    c.queue = [];
    for (const [data, isBinary] of q) {
      if (c.closed || halted()) {
        wst.dropped += 1;
        bump(wst.droppedReasons, "stopped");
        continue;
      }
      if (wsAdmit(c, "up", data)) wsSend(c, "up", u, data, isBinary);
    }
  });
  u.on("message", (data, isBinary) => {
    wst.received += 1;
    ev({ ev: "ws_frame", c: c.id, dir: "down", bytes: data.length });
    if (c.closed || halted()) {
      wst.dropped += 1;
      bump(wst.droppedReasons, "stopped");
      return;
    }
    if (wsAdmit(c, "down", data)) wsSend(c, "down", client, data, isBinary);
  });
  u.on("error", (e) => {
    const big = /max payload|too big/i.test(e.message);
    ev({ ev: "ws_upstream_error", c: c.id, code: e.code ?? null, frameTooLarge: big });
    if (halted() || c.closed) return;
    if (big) wst.received += 1;
    wsRefuse(c, "down", big ? "frame_too_large" : "upstream_error", big);
  });
  u.on("close", (code) => {
    ev({ ev: "ws_upstream_close", c: c.id, code });
    if (!halted() && !c.closed) wsRefuse(c, "down", "upstream_closed", false);
  });
  client.on("message", (data, isBinary) => {
    wst.received += 1;
    ev({ ev: "ws_frame", c: c.id, dir: "up", bytes: data.length });
    if (c.closed || halted()) {
      wst.dropped += 1;
      bump(wst.droppedReasons, "stopped");
      return;
    }
    if (isBinary) return wsRefuse(c, "up", "binary_frame");
    const v = wsRules.validate(data.toString("utf8"));
    if (v.reason !== undefined) return wsRefuse(c, "up", v.reason);
    ev({ ev: "ws_subscribe", c: c.id, kind: v.kind, filter: v.filter ?? null });
    if (!c.open) {
      if (c.queue.length + 1 > lim.preopen) return wsRefuse(c, "up", "preopen_cap");
      c.queue.push([data, isBinary]);
    } else if (wsAdmit(c, "up", data)) wsSend(c, "up", u, data, isBinary);
  });
  client.on("error", (e) => {
    const big = /max payload|too big/i.test(e.message);
    ev({ ev: "ws_client_error", c: c.id, frameTooLarge: big });
    if (halted() || c.closed) return;
    if (big) wst.received += 1;
    wsRefuse(c, "up", big ? "frame_too_large" : "client_error", big);
  });
  client.on("close", () => {
    if (!c.closed) closeConn(c, "client_closed");
  });
});

// ---- readiness, duration cap, finish
let durTimer = null;
let listening = 0;
function onListening() {
  if (++listening < 2) return;
  const ready = { pid: process.pid, httpUrl: `http://127.0.0.1:${httpServer.address().port}`, wsUrl: `ws://127.0.0.1:${wsServer.address().port}` };
  ev({ ev: "ready", ...ready, cap, minIntervalMs, timeoutMs, maxLogSpan, methods: [...methods], limits: lim, filters: allowed.length, allowNewHeads: opt.allowNewHeads === true, httpUpstreamHost: up.host, wsUpstreamHost: wsUp.host });
  fs.writeFileSync(path.join(runDir, "joint-guard.ready.json"), `${JSON.stringify(ready)}\n`);
  durTimer = setTimeout(() => stopAll("ws", "duration_cap"), lim.durationS * 1000);
}
let finishing = false;
function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(durTimer);
  const t0 = Date.now();
  const poll = setInterval(() => {
    if ((hInflight === null && wsInflight === 0) || Date.now() - t0 > SHUTDOWN_MS) {
      clearInterval(poll);
      end(code);
    }
  }, 20);
}
function end(code) {
  const h = { ...hst, pendingAtExit: hPending, queuedAtExit: queue.length, inflightAtExit: hInflight !== null ? 1 : 0 };
  const w = { ...wst, inflightAtExit: wsInflight };
  const reconciled = {
    http: h.received === h.admitted + h.refused + h.aborted + h.pendingAtExit && h.admitted === h.forwarded + h.dropped + h.queuedAtExit && h.forwarded === h.completed + h.upstreamErrors + h.inflightAtExit,
    ws: w.received === w.admitted + w.refused + w.dropped && w.admitted === w.forwarded + w.sendErrors + w.inflightAtExit,
    decisionsAfterLatch: dec.afterLatch === 0,
  };
  const summary = { latch, exitCode: code, cap, minIntervalMs, timeoutMs, maxLogSpan, limits: lim, httpUpstreamHost: up.host, wsUpstreamHost: wsUp.host, decisions: dec, http: h, ws: w, reconciled, allReconciled: reconciled.http && reconciled.ws && reconciled.decisionsAfterLatch };
  ev({ ev: "summary", allReconciled: summary.allReconciled });
  fs.writeFileSync(path.join(runDir, "joint.summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.closeSync(fd);
  process.exit(code);
}
process.on("SIGTERM", () => stopAll("signal", "signal_TERM"));
process.on("SIGINT", () => stopAll("signal", "signal_INT"));
const listenFail = (e) => {
  process.stderr.write(`joint-guard: listen failed: ${e.message}\n`);
  process.exit(2);
};
httpServer.on("error", listenFail);
wsServer.on("error", listenFail);
httpServer.listen(0, "127.0.0.1", onListening);
wsServer.on("listening", onListening);

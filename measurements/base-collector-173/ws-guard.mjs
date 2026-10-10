#!/usr/bin/env node
// Loopback WS counting/stop proxy (preparation only; not wired into run-native.sh or the collector).
//   node ws-guard.mjs --run-dir DIR --upstream ws://HOST:PORT[/path] --filters FILE [--allow-new-heads]
//     --max-concurrent N --max-connections N --max-messages N --max-bytes N --max-frame-bytes N
//     --max-duration-s N
// Listens on 127.0.0.1 (ephemeral port, written to DIR/ws-guard.ready.json). Each accepted client
// connection gets exactly one upstream connection; there is no automatic upstream reconnect.
// Client->upstream frames must be single JSON-RPC 2.0 text objects: eth_subscribe ["newHeads"] (only
// with --allow-new-heads), eth_subscribe ["logs", F] where F, lowercased, equals one entry of FILE, or
// eth_unsubscribe [id]. Every frame is counted and recorded (no payload) before it is forwarded
// byte-for-byte; subscribe lines record the filter index. Totals cover both directions.
// The first refusal, cap, upstream close/error or signal writes DIR/ws-guard.STOP, stops accepting,
// drops queued frames, closes every owned connection and exits 10 (0 after TERM/INT, 2 usage). Summary (DIR/ws-guard.summary.json):
//   received = admitted + refused + dropped; admitted = forwarded + sendErrors (+ inflightAtExit).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const WS = createRequire(import.meta.url)("ws");

const SHUTDOWN_MS = 2000;
const usage = (why) => {
  process.stderr.write(`ws-guard: ${why}\n`);
  process.exit(2);
};
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--allow-new-heads") opt.allowNewHeads = true;
  else if (a[i].startsWith("--") && i + 1 < a.length) opt[a[i].slice(2)] = a[++i];
  else usage(`bad argument ${a[i]}`);
}
const posInt = (k, max) => {
  const v = opt[k];
  if (v === undefined || !/^[1-9][0-9]*$/.test(v) || Number(v) > max) usage(`--${k} must be an integer 1..${max}`);
  return Number(v);
};
const runDir = opt["run-dir"];
if (runDir === undefined || !path.isAbsolute(runDir) || !fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) usage("--run-dir must be an existing absolute directory");
let up;
try {
  up = new URL(opt.upstream ?? "");
} catch {
  usage("--upstream must be a ws:// URL");
}
if (up.protocol !== "ws:" || up.username !== "" || up.password !== "" || up.search !== "" || up.hash !== "") usage("--upstream must be plain ws:// without credentials, query or fragment");
const lim = {
  concurrent: posInt("max-concurrent", 64),
  connections: posInt("max-connections", 1024),
  messages: posInt("max-messages", 1e9),
  bytes: posInt("max-bytes", 1e12),
  frameBytes: posInt("max-frame-bytes", 64 * 1024 * 1024),
  durationS: posInt("max-duration-s", 86400),
};
const lc = (x) => (typeof x === "string" ? x.toLowerCase() : Array.isArray(x) ? x.map(lc) : x === null ? null : typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, lc(v)])) : x);
let allowed;
try {
  allowed = JSON.parse(fs.readFileSync(opt.filters ?? "", "utf8"));
} catch {
  usage("--filters must be a readable JSON array of log filters");
}
const okFilter = (f) => f !== null && typeof f === "object" && !Array.isArray(f) && Object.keys(f).every((k) => k === "address" || k === "topics") && f.address !== undefined;
if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(okFilter)) usage("--filters must be a non-empty array of {address[,topics]} objects");
const canon = (f) => JSON.stringify({ address: lc(f.address), topics: f.topics === undefined ? null : lc(f.topics) });
const allowedCanon = allowed.map(canon);

const evFd = fs.openSync(path.join(runDir, "ws-guard.jsonl"), "wx");
const ev = (o) => fs.writeSync(evFd, `${JSON.stringify({ hrNs: process.hrtime.bigint().toString(), ...o })}\n`);
const st = { connectionsAccepted: 0, connectionsRefused: 0, upstreamOpened: 0, received: 0, admitted: 0, refused: 0, dropped: 0, forwarded: 0, sendErrors: 0, bytesAdmitted: 0, refusedReasons: {}, droppedReasons: {} };
let stopReason = null;
let stopping = false;
const conns = new Set();
let inflight = 0;

function stop(reason, detail = {}) {
  if (stopReason !== null) return;
  stopReason = reason;
  fs.writeFileSync(path.join(runDir, "ws-guard.STOP"), `${JSON.stringify({ reason, ...detail, hrNs: process.hrtime.bigint().toString() })}\n`);
  ev({ ev: "stop", reason, ...detail });
  server.close();
  for (const c of conns) closeConn(c, "stopped");
  finish(reason.startsWith("signal_") ? 0 : 10);
}
function bump(o, k) {
  o[k] = (o[k] ?? 0) + 1;
}
function closeConn(c, why) {
  if (c.closed) return;
  c.closed = true;
  for (const _ of c.queue) {
    st.dropped += 1;
    bump(st.droppedReasons, why);
  }
  if (c.queue.length > 0) ev({ ev: "drop", c: c.id, n: c.queue.length, reason: why });
  c.queue = [];
  conns.delete(c);
  try {
    c.client.close(1008, why.slice(0, 60));
  } catch {}
  setTimeout(() => c.client.terminate(), 200).unref();
  c.upstream?.terminate();
  ev({ ev: "close", c: c.id, reason: why });
}
// Count and admit one frame against the totals; returns false (and STOPs) if a cap is hit.
function admit(c, dir, data) {
  if (st.admitted + 1 > lim.messages) return refuse(c, dir, "messages_cap"), false;
  if (st.bytesAdmitted + data.length > lim.bytes) return refuse(c, dir, "bytes_cap"), false;
  st.admitted += 1;
  st.bytesAdmitted += data.length;
  return true;
}
// Frame refusals count toward received/refused; connection and upstream events only STOP.
function refuse(c, dir, reason, frame = true) {
  if (frame) st.refused += 1;
  bump(st.refusedReasons, reason);
  ev({ ev: "refuse", c: c?.id ?? null, dir, reason });
  stop(reason, { c: c?.id ?? null, dir });
}
function send(c, dir, sock, data, isBinary) {
  inflight += 1;
  ev({ ev: "forward", c: c.id, dir, bytes: data.length });
  sock.send(data, { binary: isBinary }, (err) => {
    inflight -= 1;
    if (err) {
      st.sendErrors += 1;
      ev({ ev: "send_error", c: c.id, dir });
      stop("send_error", { c: c.id, dir });
    } else st.forwarded += 1;
  });
}
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

const server = new WS.WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: lim.frameBytes });
let nextId = 0;
server.on("connection", (client) => {
  const c = { id: ++nextId, client, upstream: null, open: false, queue: [], closed: false };
  if (stopReason !== null || stopping) {
    client.terminate();
    return;
  }
  if (st.connectionsAccepted + 1 > lim.connections || conns.size + 1 > lim.concurrent) {
    st.connectionsRefused += 1;
    client.terminate();
    refuse(c, "connect", st.connectionsAccepted + 1 > lim.connections ? "connections_cap" : "concurrent_cap", false);
    return;
  }
  st.connectionsAccepted += 1;
  conns.add(c);
  ev({ ev: "accept", c: c.id, open: conns.size });
  const u = new WS.WebSocket(up.href, { maxPayload: lim.frameBytes, perMessageDeflate: false });
  c.upstream = u;
  u.on("open", () => {
    st.upstreamOpened += 1;
    ev({ ev: "upstream_open", c: c.id });
    c.open = true;
    const q = c.queue;
    c.queue = [];
    for (const [data, isBinary] of q) {
      if (c.closed || stopReason !== null) {
        st.dropped += 1;
        bump(st.droppedReasons, "stopped");
        continue;
      }
      if (admit(c, "up", data)) send(c, "up", u, data, isBinary);
    }
  });
  u.on("message", (data, isBinary) => {
    st.received += 1;
    ev({ ev: "frame", c: c.id, dir: "down", bytes: data.length });
    if (c.closed || stopReason !== null) {
      st.dropped += 1;
      bump(st.droppedReasons, "stopped");
      return;
    }
    if (admit(c, "down", data)) send(c, "down", client, data, isBinary);
  });
  u.on("error", (e) => {
    ev({ ev: "upstream_error", c: c.id, code: e.code ?? null, frameTooLarge: /max payload|too big/i.test(e.message) });
    if (stopReason !== null || c.closed) return;
    const big = /max payload|too big/i.test(e.message);
    if (big) st.received += 1;
    refuse(c, "down", big ? "frame_too_large" : "upstream_error", big);
  });
  u.on("close", (code) => {
    ev({ ev: "upstream_close", c: c.id, code });
    if (stopReason === null && !c.closed) refuse(c, "down", "upstream_closed", false);
  });
  client.on("message", (data, isBinary) => {
    st.received += 1;
    ev({ ev: "frame", c: c.id, dir: "up", bytes: data.length });
    if (c.closed || stopReason !== null) {
      st.dropped += 1;
      bump(st.droppedReasons, "stopped");
      return;
    }
    if (isBinary) return refuse(c, "up", "binary_frame");
    const v = validate(data.toString("utf8"));
    if (v.reason !== undefined) return refuse(c, "up", v.reason);
    ev({ ev: "subscribe", c: c.id, kind: v.kind, filter: v.filter ?? null });
    if (!c.open) c.queue.push([data, isBinary]);
    else if (admit(c, "up", data)) send(c, "up", u, data, isBinary);
  });
  client.on("error", (e) => {
    ev({ ev: "client_error", c: c.id, frameTooLarge: /max payload|too big/i.test(e.message) });
    if (stopReason !== null || c.closed) return;
    const big = /max payload|too big/i.test(e.message);
    if (big) st.received += 1;
    refuse(c, "up", big ? "frame_too_large" : "client_error", big);
  });
  client.on("close", () => {
    if (!c.closed) closeConn(c, "client_closed");
  });
});
server.on("listening", () => {
  const url = `ws://127.0.0.1:${server.address().port}`;
  ev({ ev: "ready", limits: lim, filters: allowed.length, allowNewHeads: opt.allowNewHeads === true, upstreamHost: up.host });
  fs.writeFileSync(path.join(runDir, "ws-guard.ready.json"), `${JSON.stringify({ url, pid: process.pid })}\n`);
  durTimer = setTimeout(() => stop("duration_cap"), lim.durationS * 1000);
});
let durTimer = null;
// After STOP: wait up to SHUTDOWN_MS for in-flight sends, write the summary, exit (10 STOP, 0 signal).
function finish(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(durTimer);
  const end = () => {
    const reconciled = st.received === st.admitted + st.refused + st.dropped && st.admitted === st.forwarded + st.sendErrors + inflight;
    const summary = { limits: lim, upstreamHost: up.host, stopReason, exitCode: code, ...st, inflightAtExit: inflight, reconciled };
    fs.writeFileSync(path.join(runDir, "ws-guard.summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    ev({ ev: "exit", reconciled });
    process.exit(code);
  };
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (inflight === 0 || Date.now() - t0 > SHUTDOWN_MS) {
      clearInterval(poll);
      end();
    }
  }, 20);
}
process.on("SIGTERM", () => stop("signal_TERM"));
process.on("SIGINT", () => stop("signal_INT"));

// Synthetic, loopback-only tests for guard.mjs. No node, network or real inputs: the upstream is a fake 127.0.0.1 server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preflight, serve, validateSpec, runplan, VENDOR } from "./guard.mjs";
import { canonical, strictParse, httpTransport } from "./vendor/capture.mjs";
import { abortableTransport } from "./transport.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "guard.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const results = [];
let fails = 0;
const check = (name, pass, actual) => { results.push({ case: name, pass: !!pass, actual }); if (!pass) fails++; process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(actual)}`}\n`); };
const base = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/spec.synthetic.json")));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reason = (f) => { try { f(); return "NO_REFUSAL"; } catch (e) { return e.reason ?? `THREW_${e.message}`; } };
const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ndg-")));
const req = (o, method = "eth_getLogs", id = 1) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: o }));
const A0 = () => req([], "eth_blockNumber", 1);
const A1 = (id = 2) => req(base.allow[1].params, "eth_getLogs", id);
const A2 = (id = 3) => req(base.allow[2].params, "eth_getLogs", id);

function fake(handler) {
  const calls = []; let inflight = 0; let maxInflight = 0;
  const s = http.createServer((q, r) => {
    const ch = []; q.on("data", (c) => ch.push(c)); q.on("end", async () => {
      const c = { body: Buffer.concat(ch), start: process.hrtime.bigint(), end: null }; calls.push(c); inflight++; maxInflight = Math.max(maxInflight, inflight);
      r.on("close", () => { if (!r.writableFinished) { c.aborted = true; if (c.end === null) { inflight--; c.end = process.hrtime.bigint(); } } });
      const out = await handler(c.body, calls.length - 1);
      if (c.aborted) return;
      inflight--; c.end = process.hrtime.bigint();
      if (out === "HANG") return;
      r.writeHead(out.status ?? 200, { "content-type": "application/json" }); r.end(out.body);
    });
  });
  return new Promise((res) => s.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}/`, calls, max: () => maxInflight, close: () => { s.closeAllConnections(); s.close(); } })));
}
const echo = (body) => { const j = JSON.parse(body); return { body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: j.method === "eth_blockNumber" ? "0x6d" : [] })) }; };
function post(url, body, abortAfterMs = null) {
  return new Promise((res) => {
    const t0 = process.hrtime.bigint(); const done = (x) => res({ ...x, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: "/", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": body.length } }, (s) => { const ch = []; s.on("data", (c) => ch.push(c)); s.on("end", () => done({ status: s.statusCode, body: Buffer.concat(ch) })); });
    r.on("error", (e) => done({ error: e.code === "ECONNRESET" && abortAfterMs !== null ? "CLIENT_ABORTED" : e.code })); r.end(body);
    if (abortAfterMs !== null) setTimeout(() => r.destroy(), abortAfterMs);
  });
}
async function run(specMut, handler, client, opts = {}) {
  const root = tmpRoot(); const up = await fake(handler);
  const s = clone(base); s.projectAromer = root; s.native.measure.out = path.join(root, "measure/report.json"); specMut?.(s);
  const out = path.join(root, "guard-out");
  const pre = preflight(Buffer.from(JSON.stringify(s)), up.url, out);
  let listen; const ready = new Promise((r) => { listen = r; });
  const g = serve(pre, { onListening: (l) => listen(l), transport: opts.transport });
  const l = await Promise.race([ready, g.done.then(() => null)]);
  const t0 = process.hrtime.bigint();
  const replies = l === null ? [] : await client(l.listening, g);
  const sum = await g.done;
  const doneMs = Number(process.hrtime.bigint() - t0) / 1e6;
  for (let i = 0; i < 100 && !up.calls.every((c) => c.end !== null); i++) await new Promise((r) => setTimeout(r, 10));
  const after = l === null ? null : await post(l.listening, A0());
  up.close();
  const log = fs.existsSync(path.join(out, "guard-log.json")) ? JSON.parse(fs.readFileSync(path.join(out, "guard-log.json"))) : null;
  return { sum, replies, up, out, log, after, pre, doneMs };
}
const msg = (r) => (r.body ? JSON.parse(r.body).error?.message?.replace("native-diagnostic-guard: ", "") : r.error);

// vendor and static
const vb = fs.readFileSync(path.join(HERE, VENDOR.file));
const gb = spawnSync("/usr/bin/git", ["hash-object", path.join(HERE, VENDOR.file)], { encoding: "utf8" }).stdout.trim();
check("vendor capture.mjs is byte-identical to 56f8f3b (sha256 + blob)", sha(vb) === VENDOR.sha256 && gb === VENDOR.blob, { sha256: sha(vb), blob: gb });
const src = fs.readFileSync(GUARD, "utf8");
const tsrc = fs.readFileSync(path.join(HERE, "transport.mjs"), "utf8");
check("static: no env, child process, fetch, WebSocket, LAN bind; one listen on LOOPBACK; upstream only via transport.mjs (one mod.request)",
  !/process\.env[.[]|child_process|fetch\(|new WebSocket|from "ws"|0\.0\.0\.0|"::"/.test(src + tsrc) && (src.match(/\.listen\(/g) ?? []).length === 1 && /server\.listen\(0, LOOPBACK/.test(src) && !/http\.request|https\.request|node:https/.test(src)
  && (tsrc.match(/\.request\(/g) ?? []).length === 1 && !/\.listen\(/.test(tsrc), null);

// plan
const p1 = runplan(validateSpec(clone(base)));
const p2 = runplan(validateSpec(clone(base)));
const runplanBytes = Buffer.from(`${canonical(p1)}\n`);
fs.writeFileSync(path.join(HERE, "evidence/runplan.synthetic.json"), runplanBytes);
check("runplan deterministic, self-hash, secrets hashed only", canonical(p1) === canonical(p2) && !runplanBytes.toString().includes("synthetic.invalid") && p1.nativeEnv.BASE_COLLECTOR_START_BLOCK.value === "100", { runplanSha256: p1.runplanSha256 });
const cli = spawnSync(process.execPath, [GUARD, "plan", "--spec", path.join(HERE, "fixtures/spec.synthetic.json")], { cwd: "/", env: {}, encoding: "buffer" });
check("CLI plan by path from cwd=/ with empty env equals evidence", cli.status === 0 && Buffer.compare(cli.stdout, runplanBytes) === 0, { status: cli.status });
const un = spawnSync(process.execPath, [GUARD, "plan", "--spec", path.join(HERE, "fixtures/spec.unresolved.json")], { cwd: "/", env: {}, encoding: "utf8" });
const unj = JSON.parse(un.stdout);
check("unresolved checkpoint/head/window/filters/env -> root_inputs_unresolved exit 2", un.status === 2 && unj.refused === "root_inputs_unresolved" && unj.detail.paths.length === 10, unj);

// spec refusals (no transport)
const neg = [
  ["source commit mismatch", (s) => { s.source.commit = "0".repeat(40); }, "source_commit_mismatch"],
  ["HTTP_URL supplied", (s) => { s.native.env.BASE_COLLECTOR_HTTP_URL = "http://x"; }, "http_url_is_the_guard_listener"],
  ["unknown env key", (s) => { s.native.env.PATH = "/bin"; }, "env_key_unknown"],
  ["paceMs < 1250", (s) => { s.limits.paceMs = 1249; }, "value_invalid"],
  ["timeoutMs > 8000", (s) => { s.limits.timeoutMs = 8001; }, "value_invalid"],
  ["maxResponseBytes > 1MiB", (s) => { s.limits.maxResponseBytes = 1048577; }, "value_invalid"],
  ["maxCalls > allowlist", (s) => { s.limits.maxCalls = 4; }, "call_budget_exceeds_allowlist"],
  ["method eth_call", (s) => { s.allow[0] = { method: "eth_call", params: [] }; }, "method_not_allowed"],
  ["getLogs toBlock latest", (s) => { s.allow[1].params[0].toBlock = "latest"; }, "range_invalid"],
  ["getLogs range 501", (s) => { s.allow[1].params[0].toBlock = "0x258"; }, "range_invalid"],
  ["getLogs blockHash key", (s) => { s.allow[1].params[0].blockHash = "0x" + "1".repeat(64); }, "filter_invalid"],
  ["getLogs undeclared filter (topic order swapped)", (s) => { s.allow[1].params[0].topics = [[...s.allow[1].params[0].topics[0]].reverse()]; }, "filter_not_declared"],
  ["measure out outside projectAromer", (s) => { s.native.measure.out = "/tmp/report.json"; }, "output_outside_project_aromer"],
  ["window end <= start", (s) => { s.rootInputs.window.endUtc = s.rootInputs.window.startUtc; }, "window_invalid"],
];
for (const [n, f, want] of neg) { const s = clone(base); f(s); const got = reason(() => validateSpec(s)); check(`spec refusal: ${n}`, got === want, got); }
check("spec duplicate key refused by strict parser", reason(() => strictParse(Buffer.from('{"a":1,"a":2}'), "spec")) === "json_duplicate_key", null);

// preflight filesystem refusals
{
  const root = tmpRoot(); const s = clone(base); s.projectAromer = root; s.native.measure.out = path.join(root, "m.json"); const b = Buffer.from(JSON.stringify(s));
  fs.mkdirSync(path.join(root, "exists"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "link"));
  const lnRoot = path.join(tmpRoot(), "aliasroot"); fs.symlinkSync(root, lnRoot); const s2 = clone(s); s2.projectAromer = lnRoot; s2.native.measure.out = path.join(lnRoot, "m.json");
  const cases = [["out exists", () => preflight(b, "http://127.0.0.1:1/", path.join(root, "exists")), "out_exists"],
    ["out outside projectAromer", () => preflight(b, "http://127.0.0.1:1/", path.join(os.tmpdir(), "x-out")), "output_outside_project_aromer"],
    ["out parent symlink", () => preflight(b, "http://127.0.0.1:1/", path.join(root, "link/out")), "out_parent_symlink"],
    ["projectAromer symlink", () => preflight(Buffer.from(JSON.stringify(s2)), "http://127.0.0.1:1/", path.join(lnRoot, "o")), "project_aromer_not_canonical"],
    ["upstream userinfo", () => preflight(b, "http://u:p@127.0.0.1:1/", path.join(root, "o")), "upstream_userinfo_refused"],
    ["upstream ws scheme", () => preflight(b, "ws://127.0.0.1:1/", path.join(root, "o")), "upstream_scheme_unsupported"]];
  for (const [n, f, want] of cases) { const got = reason(f); check(`preflight refusal: ${n}`, got === want, got); }
  check("preflight refusals created nothing", !fs.existsSync(path.join(root, "o")), null);
}

// serve: happy path, concurrency, pacing, raw bytes
{
  const t0 = []; const r = await run(null, echo, (u) => Promise.all([post(u, A2()), post(u, A0()), post(u, A1())]));
  const gaps = r.up.calls.slice(1).map((c, i) => Number(c.start - r.up.calls[i].end) / 1e6);
  const fwd = r.up.calls.map((c) => c.body.toString()).sort().join("|") === [A0(), A1(), A2()].map(String).sort().join("|");
  const files = r.log.attempts.every((a) => sha(fs.readFileSync(path.join(r.out, a.requestFile.file))) === a.requestFile.sha256 && sha(fs.readFileSync(path.join(r.out, a.response.file))) === a.response.receivedSha256);
  check("3 concurrent allowed calls: COMPLETE, upstream 3, one in flight, exact bytes forwarded and returned, raw files persisted",
    r.sum.status === "COMPLETE" && r.up.calls.length === 3 && r.up.max() === 1 && r.sum.maxInFlight === 1 && fwd && files && r.replies.every((x) => x.status === 200), { status: r.sum.status, up: r.up.calls.length });
  check(">= 1250 ms between upstream completion and next send", gaps.length === 2 && gaps.every((g) => g >= 1250), { gapsOk: gaps.every((g) => g >= 1250) });
  check("listener closed after budget complete (extra call never reaches upstream)", r.after.error === "ECONNREFUSED" && r.up.calls.length === 3, r.after);
  check("runplan.json in output equals runplan", fs.readFileSync(path.join(r.out, "runplan.json")).equals(Buffer.from(`${canonical(r.pre.plan)}\n`)), null);
}

// refusals before upstream
const bad = [
  ["unlisted range", req([{ ...base.allow[1].params[0], toBlock: "0x6e" }]), "call_not_allowlisted"],
  ["malformed JSON", Buffer.from("{nope"), "request_malformed"],
  ["batch array", Buffer.from(`[${A0()}]`), "request_malformed"],
  ["duplicate key", Buffer.from('{"jsonrpc":"2.0","id":1,"id":2,"method":"eth_blockNumber","params":[]}'), "request_malformed"],
  ["extra key", Buffer.from('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[],"x":1}'), "request_malformed"],
  ["string id", Buffer.from('{"jsonrpc":"2.0","id":"1","method":"eth_blockNumber","params":[]}'), "request_malformed"],
  ["eth_call", req([{}], "eth_call"), "method_not_allowed"],
  ["eth_getLogs latest", req([{ ...base.allow[1].params[0], toBlock: "latest" }]), "call_not_allowlisted"],
  ["oversize body", Buffer.alloc(65537, 32), "request_oversize"],
];
for (const [n, body, want] of bad) {
  const r = await run(null, echo, async (u) => [await post(u, body), await post(u, A0())]);
  check(`refused before upstream: ${n}; later allowed call also refused; STOPPED`, r.up.calls.length === 0 && r.sum.status === "STOPPED" && msg(r.replies[0]) === want && (r.replies[1].status === 403 || r.replies[1].error === "ECONNREFUSED") && r.log.refusals[0].reason === want, { up: r.up.calls.length, got: msg(r.replies[0]) });
}
{
  const r = await run((s) => { s.limits.maxCalls = 2; s.allow = [s.allow[0], s.allow[1]]; }, echo, async (u) => [await post(u, A0()), await post(u, A0())]);
  check("repeat of consumed entry -> call_already_consumed, upstream 1", r.up.calls.length === 1 && msg(r.replies[1]) === "call_already_consumed" && r.sum.notUsed.join() === "1", { up: r.up.calls.length });
}
{
  const r = await run((s) => { s.limits.maxCalls = 1; }, echo, (u) => Promise.all([post(u, A0()), post(u, A1())]));
  check("budget 1 with 2 concurrent -> over-budget refused, STOP latched, no 200 forwarded, upstream <= 1", r.sum.status === "STOPPED" && r.up.calls.length <= 1 && r.replies.every((x) => x.status !== 200) && r.log.refusals.some((x) => x.reason === "call_budget_exhausted") && r.sum.counts.forwarded === 0, { up: r.up.calls.length });
}

// upstream failures: STOP on first error, no retry, queued not sent
const upf = [
  ["response over maxResponseBytes", (s) => { s.limits.maxResponseBytes = 64; }, () => ({ body: Buffer.alloc(200, 0x61) }), "response_oversize"],
  ["total bytes cap", (s) => { s.limits.maxTotalBytes = 50; }, () => ({ body: Buffer.alloc(200, 0x61) }), "total_bytes_cap"],
  ["deadline", (s) => { s.limits.timeoutMs = 200; }, () => new Promise((r) => setTimeout(() => r("HANG"), 600)), "timeout"],
  ["HTTP 500", null, () => ({ status: 500, body: Buffer.from("{}") }), "http_status"],
  ["rpc error", null, (b) => ({ body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(b).id, error: { code: -32005, message: "x" } })) }), "rpc_error"],
  ["id mismatch", null, () => ({ body: Buffer.from('{"jsonrpc":"2.0","id":99,"result":"0x1"}') }), "response_malformed"],
];
for (const [n, mut, h, want] of upf) {
  const r = await run(mut, h, (u) => Promise.all([post(u, A0()), post(u, A1())]));
  const a = r.log.attempts[0];
  const part = want === "response_oversize" ? fs.readFileSync(path.join(r.out, a.response.file)) : null;
  check(`upstream ${n} -> ${want}, STOPPED, upstream 1, no retry, queued call not sent`, r.sum.status === "STOPPED" && r.up.calls.length === 1 && a.outcome === want && r.log.retries === 0 && r.log.refusals.some((x) => x.reason === "guard_stopped_before_send" || x.reason === "guard_stopped")
    && (part === null || (part.length === 64 && a.response.file.endsWith(".partial") && a.response.partialSentinel.receivedBytes === 64)), { outcome: a?.outcome, up: r.up.calls.length });
}
{
  const r = await run((s) => { s.limits.maxDurationMs = 300; }, echo, async () => []);
  check("maxDurationMs with no calls -> STOPPED duration_exhausted, notUsed all, upstream 0", r.sum.status === "STOPPED" && r.sum.stop.outcome === "duration_exhausted" && r.up.calls.length === 0 && r.sum.notUsed.length === 3, r.sum.stop);
}

// write failures (in-process fs injection)
{
  const realOpen = fs.openSync, realWrite = fs.writeSync; const names = new Map();
  fs.openSync = (p, ...x) => { const fd = realOpen(p, ...x); names.set(fd, path.basename(String(p))); return fd; };
  fs.writeSync = (fd, ...x) => { if (names.get(fd) === "call-0.response.json") { const e = new Error("EIO"); e.code = "EIO"; throw e; } return realWrite(fd, ...x); };
  const r = await run(null, echo, (u) => Promise.all([post(u, A0()), post(u, A1())]));
  fs.writeSync = (fd, b, off, len, pos) => realWrite(fd, b, off, Math.min(len, 7), pos);
  const r2 = await run((s) => { s.limits.maxCalls = 1; }, echo, async (u) => [await post(u, A0())]);
  fs.openSync = realOpen; fs.writeSync = realWrite;
  check("EIO on response file -> WRITE_FAILED, client 502, partial disclosed, next call not sent", r.sum.status === "WRITE_FAILED" && r.up.calls.length === 1 && r.replies.some((x) => x.status === 502) && r.sum.writeFailures[0].file === "call-0.response.json" && fs.statSync(path.join(r.out, "call-0.response.json")).size === 0, r.sum.writeFailures);
  check("7-byte short writes -> COMPLETE, files byte-exact", r2.sum.status === "COMPLETE" && sha(fs.readFileSync(path.join(r2.out, "call-0.response.json"))) === r2.log.attempts[0].response.receivedSha256, r2.sum.status);
}

// C1: derived transport parity with pinned vendor httpTransport (same fake responses)
{
  const modes = [["complete", () => ({ body: Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x1"}') })], ["oversize", () => ({ body: Buffer.alloc(300, 0x62) })], ["http500", () => ({ status: 500, body: Buffer.from("err") })], ["timeout", () => new Promise((r) => setTimeout(() => r("HANG"), 400))]];
  for (const [n, h] of modes) {
    const up = await fake(h); const u = new URL(up.url); const o = { timeoutMs: 150, maxBytes: 100 };
    const v = await httpTransport(u, A0(), o); const d = await abortableTransport(u, A0(), { ...o, signal: new AbortController().signal }); up.close();
    const norm = (x) => ({ kind: x.kind, httpStatus: x.httpStatus, bytes: x.bytes.toString("hex"), error: x.error });
    check(`derived transport == vendor httpTransport: ${n}`, canonical(norm(v)) === canonical(norm(d)) && d.created === true, { v: norm(v).kind, d: norm(d).kind });
  }
  const up = await fake(echo); const ac = new AbortController(); ac.abort();
  const d = await abortableTransport(new URL(up.url), A0(), { timeoutMs: 150, maxBytes: 100, signal: ac.signal }); await new Promise((r) => setTimeout(r, 100)); up.close();
  check("derived transport: pre-aborted signal creates no request", d.kind === "aborted" && d.created === false && up.calls.length === 0, d.kind);
}

// C1: STOP latch, interruptible pacing, remaining-duration-bounded calls, disconnects (root/A7 D1-D4)
const slow = (ms) => (b) => new Promise((r) => setTimeout(() => r(echo(b)), ms));
const inflightStopped = (r, outcome, maxMs) => r.sum.status === "STOPPED" && r.sum.stop.outcome === outcome && r.sum.stop.sent === true && r.sum.stop.inFlightCall === 0
  && r.log.attempts[0].outcome === "stopped_in_flight" && r.log.attempts[0].forwarded === false && r.up.calls.length === 1 && r.up.calls[0].aborted === true
  && r.replies[0].status === 502 && msg(r.replies[0]) === "stopped_in_flight" && r.sum.counts.forwarded === 0 && r.replies[0].ms < maxMs && r.doneMs < maxMs;
{
  const r = await run((s) => { s.limits.maxDurationMs = 300; }, slow(1500), async (u) => [await post(u, A0())]);
  check("D1 maxDuration 300 / upstream 1500: in-flight aborted at deadline, 502 not 200, stop sent:true inFlightCall 0, < 800 ms", inflightStopped(r, "duration_exhausted", 800), { stop: r.sum.stop, ms: Math.round(r.replies[0].ms) > 800 });
}
{
  const r = await run((s) => { s.limits.maxDurationMs = 500; s.limits.timeoutMs = 8000; }, slow(3000), async (u) => [await post(u, A0())]);
  check("D1b timeout 8000 / upstream 3000 / maxDuration 500: bounded by remaining duration, < 1000 ms", inflightStopped(r, "duration_exhausted", 1000), { stop: r.sum.stop });
}
{
  const seen = [];
  const r = await run((s) => { s.limits.maxDurationMs = 400; }, slow(50), async (u) => [await post(u, A0())], { transport: (u, b, o) => { seen.push(o.timeoutMs); return abortableTransport(u, b, o); } });
  check("per-call timeout = min(timeoutMs, remaining maxDuration)", seen.length === 1 && seen[0] <= 400 && seen[0] > 0 && r.log.attempts[0].effTimeoutMs === seen[0], seen);
}
{
  const r = await run(null, slow(1000), async (u, g) => { setTimeout(() => g.stop(), 100); return [await post(u, A0())]; });
  check("D2 root stop at 100 ms during in-flight: aborted, 502 not 200, stop sent:true, < 500 ms", inflightStopped(r, "root_stop", 500), { stop: r.sum.stop });
}
{
  const r = await run((s) => { s.limits.paceMs = 600000; s.limits.maxCalls = 2; }, echo, async (u, g) => { const a = await post(u, A0()); const p = post(u, A1()); setTimeout(() => g.stop(), 100); return [a, await p]; });
  check("D4 stop during 600000 ms pace: pacing interrupted, second call never sent, done < 1000 ms", r.sum.status === "STOPPED" && r.sum.stop.outcome === "root_stop" && r.sum.stop.sent === false && r.up.calls.length === 1
    && r.replies[0].status === 200 && r.replies[1].status === 403 && r.log.refusals.some((x) => x.reason === "guard_stopped_before_send") && r.doneMs < 1000 && r.sum.counts.forwarded === 1, { stop: r.sum.stop, up: r.up.calls.length });
}
{
  const r = await run((s) => { s.limits.maxCalls = 2; }, slow(500), (u) => Promise.all([post(u, A0()), new Promise((res) => setTimeout(res, 20)).then(() => post(u, A1(), 100))]));
  check("D3 queued client disconnects: refused before upstream, STOPPED (not COMPLETE), first still forwarded, upstream 1", r.sum.status === "STOPPED" && r.sum.stop.outcome === "client_disconnected_before_send" && r.sum.stop.sent === false
    && r.up.calls.length === 1 && r.replies[0].status === 200 && r.replies[1].error === "CLIENT_ABORTED" && canonical(r.sum.counts) === canonical({ admitted: 2, forwarded: 1, persisted: 1, received: 2, responded: 1, sent: 1 }), { stop: r.sum.stop, counts: r.sum.counts });
}
{
  const r = await run(null, slow(1000), async (u) => [await post(u, A0(), 100)]);
  check("in-flight client disconnect: upstream aborted, outcome client_disconnected_in_flight, STOPPED, < 500 ms", r.sum.status === "STOPPED" && r.sum.stop.outcome === "client_disconnected_in_flight" && r.up.calls[0].aborted === true
    && r.log.attempts[0].outcome === "client_disconnected_in_flight" && r.sum.counts.forwarded === 0 && r.doneMs < 500, { stop: r.sum.stop, up: r.up.calls.map((c) => !!c.aborted), at: r.log.attempts.map((x) => x.outcome), ms: r.doneMs > 500 });
}
{
  const r = await run(null, (b) => new Promise((res) => setTimeout(() => res({ body: Buffer.alloc(10, 0x63) }), 10)), async (u) => [await post(u, A0())]);
  check("STOP after a sent call: no retry, no new upstream, counts admitted/sent/responded/persisted/forwarded distinguished", r.sum.status === "STOPPED" && r.up.calls.length === 1 && r.log.retries === 0
    && canonical(r.sum.counts) === canonical({ admitted: 1, forwarded: 0, persisted: 1, received: 1, responded: 1, sent: 1 }) && r.after.error === "ECONNREFUSED", r.sum.counts);
}

// CLI serve by path from cwd=/, empty env
{
  const root = tmpRoot(); const up = await fake(echo); const s = clone(base); s.projectAromer = root; s.native.measure.out = path.join(root, "m/r.json"); s.limits.maxCalls = 1;
  const sp = path.join(root, "spec.json"); fs.writeFileSync(sp, JSON.stringify(s));
  const ch = spawn(process.execPath, [GUARD, "serve", "--spec", sp, "--upstream", up.url, "--out", path.join(root, "g")], { cwd: "/", env: {} });
  let buf = ""; const lines = []; ch.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  while (lines.length === 0) await new Promise((r) => setTimeout(r, 20));
  const l = JSON.parse(lines[0]); const rr = await post(l.listening, A0());
  const exit = await new Promise((r) => ch.on("exit", r)); up.close();
  const last = JSON.parse(lines[lines.length - 1]);
  check("CLI serve from cwd=/: loopback listener, 1 call, exit 0 COMPLETE", /^http:\/\/127\.0\.0\.1:\d+\/$/.test(l.listening) && rr.status === 200 && exit === 0 && last.status === "COMPLETE" && up.calls.length === 1, { exit, status: last.status });
}

async function cliServe(mut, handler, act) {
  const root = tmpRoot(); const up = await fake(handler); const s = clone(base); s.projectAromer = root; s.native.measure.out = path.join(root, "m/r.json"); mut(s);
  const sp = path.join(root, "spec.json"); fs.writeFileSync(sp, JSON.stringify(s));
  const ch = spawn(process.execPath, [GUARD, "serve", "--spec", sp, "--upstream", up.url, "--out", path.join(root, "g")], { cwd: "/", env: {} });
  let buf = ""; const lines = []; ch.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  while (lines.length === 0) await new Promise((r) => setTimeout(r, 20));
  const t0 = process.hrtime.bigint(); const replies = await act(JSON.parse(lines[0]).listening, ch);
  const exit = await new Promise((r) => ch.on("exit", r)); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  for (let i = 0; i < 100 && !up.calls.every((c) => c.end !== null); i++) await new Promise((r) => setTimeout(r, 10));
  up.close();
  return { exit, last: JSON.parse(lines[lines.length - 1]), replies, up, ms, log: JSON.parse(fs.readFileSync(path.join(root, "g/guard-log.json"))) };
}
{
  const r = await cliServe(() => {}, slow(3000), async (u, ch) => { setTimeout(() => ch.kill("SIGTERM"), 150); return [await post(u, A0())]; });
  check("CLI SIGTERM during in-flight: exit 3 STOPPED root_signal sent:true, upstream aborted, 502, < 1000 ms", r.exit === 3 && r.last.status === "STOPPED" && r.last.stop.outcome === "root_signal" && r.last.stop.sent === true
    && r.up.calls.length === 1 && r.up.calls[0].aborted === true && r.replies[0].status === 502 && r.log.attempts[0].outcome === "stopped_in_flight" && r.ms < 1000, { exit: r.exit, stop: r.last.stop });
}
{
  const r = await cliServe((s) => { s.limits.paceMs = 600000; s.limits.maxCalls = 2; }, echo, async (u, ch) => { const a = await post(u, A0()); const p = post(u, A1()); setTimeout(() => ch.kill("SIGINT"), 150); return [a, await p]; });
  check("CLI SIGINT during 600000 ms pace: exit 3 root_signal sent:false, second not sent, < 1000 ms", r.exit === 3 && r.last.stop.outcome === "root_signal" && r.last.stop.sent === false && r.up.calls.length === 1
    && r.replies[0].status === 200 && r.replies[1].status === 403 && r.ms < 1000, { exit: r.exit, stop: r.last.stop });
}

fs.writeFileSync(path.join(HERE, "evidence/results.json"), `${JSON.stringify({ schema: "native-diagnostic-guard-results/1", runplanSha256: p1.runplanSha256, cases: results.map((r) => ({ case: r.case, pass: r.pass })) }, null, 1)}\n`);
process.stdout.write(`${results.length - fails} PASS, ${fails} FAIL\n`);
process.exitCode = fails === 0 ? 0 : 1;

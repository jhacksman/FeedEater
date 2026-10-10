// Hermetic tests: a fake JSON-RPC HTTP server on 127.0.0.1 only. Run from this directory: node test.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HERE = path.resolve(".");
const W = path.join(HERE, "work");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PIN = { plan: ["a345d48a2f003348d3fe21910518ec1e6e54db35", "measurements/backfill-plan", "c527e1808fcd4efa00a34a0c1dd957bffa8d56adadb584d056babe8084edcf7a"], verifier: ["83aec5d72f6712711b5f22ef29777858c5b797e0", "measurements/backfill-receipts", "0eb02c033103a13053b5797614dedf8724c686f24d42bdf3f476fc1f303fda56"] };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)?.slice(0, 600)}`}`); };
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const at = {};
for (const [k, [commit, dir, s]] of Object.entries(PIN)) {
  fs.mkdirSync(path.join(W, k));
  spawnSync("sh", ["-c", `git -C "$1" archive "$2" "$3" | tar -x -C "$4"`, "sh", root, commit, dir, path.join(W, k)]);
  at[k] = path.join(W, k, dir);
}
check("pins: a345d48 plan.mjs and 83aec5d verify.mjs extracted with expected sha256", sha(fs.readFileSync(path.join(at.plan, "plan.mjs"))) === PIN.plan[2] && sha(fs.readFileSync(path.join(at.verifier, "verify.mjs"))) === PIN.verifier[2]);
const MAN = path.join(HERE, "fixtures/manifest.synthetic.json");
const PLAN = path.join(HERE, "fixtures/plan.4calls.json");
const planObj = JSON.parse(fs.readFileSync(PLAN, "utf8"));
const regen = spawnSync(process.execPath, ["plan.mjs", "--spec", path.join(HERE, "fixtures/planspec.4calls.json"), "--manifest", MAN], { cwd: at.plan });
check("fixture plan.4calls.json == pinned a345d48 plan.mjs output (PLANNED, 4 calls)", regen.status === 0 && Buffer.compare(regen.stdout, fs.readFileSync(PLAN)) === 0 && planObj.status === "PLANNED" && planObj.callCount === 4);
check("fixture manifest == 83aec5d fixtures/manifest.synthetic.json bytes", sha(fs.readFileSync(MAN)) === sha(fs.readFileSync(path.join(at.verifier, "fixtures/manifest.synthetic.json"))));
const baseSpec = JSON.parse(fs.readFileSync("fixtures/spec.synthetic.json", "utf8"));
let n = 0;
const writeJson = (o) => { const f = path.join(W, `in-${++n}.json`); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); return f; };
const specWith = (limits = {}, extra = {}) => writeJson({ ...baseSpec, ...extra, limits: { ...baseSpec.limits, ...limits } });
const planVariant = (mut) => { const s = JSON.parse(fs.readFileSync("fixtures/planspec.4calls.json", "utf8")); mut(s); const r = spawnSync(process.execPath, ["plan.mjs", "--spec", writeJson(s), "--manifest", MAN], { cwd: at.plan }); const f = path.join(W, `plan-${++n}.json`); fs.writeFileSync(f, r.stdout); return f; };
const pinsFor = (planFile) => { const b = fs.readFileSync(planFile); return { plan: { fileSha256: sha(b), planSha256: JSON.parse(b).planSha256 } }; };

// fake server: behave(i, body) -> { status, body: Buffer, delayMs, hangAfter, destroyAfter }
function server(behave) {
  const log = [];
  let inflight = 0;
  let maxInflight = 0;
  const srv = http.createServer((req, res) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const i = log.length;
      log.push({ t: performance.now(), body, method: req.method, ctype: req.headers["content-type"] });
      const b = behave(i, body);
      const done = () => { inflight--; };
      res.on("close", done);
      res.writeHead(b.status ?? 200, { "content-type": "application/json" });
      if (b.destroyAfter !== undefined) { res.write(b.body.subarray(0, b.destroyAfter)); setTimeout(() => res.socket.destroy(), 50); return; }
      if (b.hangAfter !== undefined) { res.write(b.body.subarray(0, b.hangAfter)); setTimeout(() => { try { res.end(b.body.subarray(b.hangAfter)); } catch {} }, b.delayMs); return; }
      res.end(b.body);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/rpc`, log, maxInflight: () => maxInflight, close: () => new Promise((c) => { srv.closeAllConnections(); srv.close(c); }) })));
}
const okBody = (body) => { const id = JSON.parse(body).id; return Buffer.from(`{ "jsonrpc": "2.0", "id": ${id},\n  "result": [] }\r\n`); };
// Test-only fault injector, preloaded with --import into the CLI child; capture.mjs itself reads no environment.
const INJ = path.join(W, "inject.mjs");
fs.writeFileSync(INJ, `import fs from "node:fs";
const f = JSON.parse(process.env.CAPTURE_TEST_FAULT);
const names = new Map(); const o = fs.openSync, w = fs.writeSync, s = fs.fsyncSync; let first = true;
const eio = () => { const e = new Error("EIO"); e.code = "EIO"; return e; };
fs.openSync = (p, ...a) => { const fd = o(p, ...a); names.set(fd, String(p).split("/").pop()); return fd; };
fs.writeSync = (fd, buf, off, len, pos) => {
  if (f.file !== "*" && names.get(fd) !== f.file) return w(fd, buf, off, len, pos);
  if (f.mode === "short_first") { if (first) { first = false; return w(fd, buf, off, Math.min(len, 16), pos); } return w(fd, buf, off, len, pos); }
  if (f.mode === "short_all") return w(fd, buf, off, Math.min(len, 7), pos);
  if (f.mode === "zero") return 0;
  if (f.mode === "eio") throw eio();
  if (f.mode === "eio_after_partial") { if (first) { first = false; return w(fd, buf, off, Math.min(len, 5), pos); } throw eio(); }
  if (f.mode === "corrupt") { const b = Buffer.from(buf.subarray(off, off + len)); b[0] ^= 0xff; return w(fd, b, 0, b.length, pos); }
  return w(fd, buf, off, len, pos);
};
fs.fsyncSync = (fd) => { if (f.mode === "fsync_eio" && names.get(fd) === f.file) throw eio(); return s(fd); };
`);
const run = (args, fault = null) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [...(fault ? ["--import", pathToFileURL(INJ).href] : []), "capture.mjs", ...args], { cwd: HERE, env: fault ? { ...process.env, CAPTURE_TEST_FAULT: JSON.stringify(fault) } : process.env });
  const out = []; const err = [];
  ch.stdout.on("data", (d) => out.push(d)); ch.stderr.on("data", (d) => err.push(d));
  ch.on("close", (rc) => { const s = Buffer.concat(out).toString(); let j = null; try { j = JSON.parse(s); } catch {} resolve({ rc, stdout: s, stderr: Buffer.concat(err).toString(), j }); });
});
const outDir = () => path.join(W, `out-${++n}`);
const cap = (srv, { spec = specWith(), plan = PLAN, out = outDir(), extra = [], fault = null } = {}) => run(["--spec", spec, "--manifest", MAN, "--plan", plan, "--endpoint", srv.url, "--out", out, ...extra], fault).then((r) => ({ ...r, out }));
const rd = (out, f) => fs.readFileSync(path.join(out, f));
const att = (out) => JSON.parse(rd(out, "attempts.json"));
const verify = (out, planFile = PLAN) => {
  const idx = rd(out, "receipts.json");
  const pb = fs.readFileSync(planFile);
  const vs = writeJson({ schema: "backfill-receipt-verify-input/1", manifest: baseSpec.manifest, plan: { fileSha256: sha(pb), planSha256: JSON.parse(pb).planSha256 }, receipts: { fileSha256: sha(idx) } });
  const r = spawnSync(process.execPath, ["verify.mjs", "--spec", vs, "--manifest", MAN, "--plan", planFile, "--receipts", path.join(out, "receipts.json")], { cwd: at.verifier, encoding: "utf8" });
  return JSON.parse(r.stdout);
};

const srv0len = (i) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "eth_getLogs", params: [planObj.calls[i].request.params[0]] })).length;
const okLen = (id) => okBody(JSON.stringify({ id })).length;
// 1. complete capture
{
  const srv = await server((i, b) => ({ body: okBody(b) }));
  const r = await cap(srv);
  const a = att(r.out);
  check("complete: exit 0, CAPTURED_ALL_PLANNED, 4 attempted/4 receipted, verifierRun false, live false, resume not permitted", r.rc === 0 && r.stderr === "" && r.j.status === "CAPTURED_ALL_PLANNED" && r.j.attempted === 4 && r.j.receipted === 4 && r.j.verifierRun === false && r.j.publicationProvenance.live === false && r.j.resumeLive.permitted === false, r);
  check("complete: server saw exactly 4 POSTs, application/json, max one in flight", srv.log.length === 4 && srv.log.every((x) => x.method === "POST" && x.ctype === "application/json") && srv.maxInflight() === 1, { n: srv.log.length, inflight: srv.maxInflight() });
  check("complete: each request = planned params[0] verbatim, id = index+1, eth_getLogs; request file bytes == bytes the server received", srv.log.every((x, i) => { const q = JSON.parse(x.body); return q.jsonrpc === "2.0" && q.id === i + 1 && q.method === "eth_getLogs" && JSON.stringify(q.params) === JSON.stringify([planObj.calls[i].request.params[0]]) && Buffer.compare(rd(r.out, `call-${i}.request.json`), x.body) === 0; }));
  check("complete: response files are the exact server bytes (whitespace/CRLF preserved) and sidecar shas match", [0, 1, 2, 3].every((i) => Buffer.compare(rd(r.out, `call-${i}.response.json`), okBody(srv.log[i].body)) === 0 && a.attempts[i].response.sha256 === sha(rd(r.out, `call-${i}.response.json`)) && a.attempts[i].request.sha256 === sha(srv.log[i].body)));
  const gaps = srv.log.slice(1).map((x, i) => x.t - srv.log[i].t);
  check("complete: pace >= 1250 ms between requests", gaps.every((g) => g >= 1245), gaps);
  check("complete: stdout is a summary only (no payload, no endpoint); attempts.json endpointSha256 only, retries 0", !/jsonrpc|result|eth_getLogs|127\.0\.0\.1|0x/.test(r.stdout) && a.endpointSha256 === sha(srv.url) && a.retries === 0 && a.stop === null && a.notAttempted.length === 0 && !JSON.stringify(a).includes("127.0.0.1"), r.stdout);
  check("complete: receipts.json/attempts.json shas in summary match files; output dir holds only the 10 expected files", r.j.receiptsIndex.sha256 === sha(rd(r.out, "receipts.json")) && r.j.attempts.sha256 === sha(rd(r.out, "attempts.json")) && fs.readdirSync(r.out).length === 10);
  const v = verify(r.out);
  check("complete: 83aec5d verifier (run by the test, not the CLI) -> ALL_CALLS_RECEIPTED", v.verdict === "ALL_CALLS_RECEIPTED", v.verdict);
  await srv.close();
}
// 2. RPC error stops; error bytes preserved and receipted; remaining calls not attempted
{
  const errBody = (b) => Buffer.from(`{"jsonrpc":"2.0","id":${JSON.parse(b).id},"error":{"code":-32005,"message":"limit exceeded"}}`);
  const srv = await server((i, b) => ({ body: i === 1 ? errBody(b) : okBody(b) }));
  const r = await cap(srv);
  const a = att(r.out);
  check("rpc error: exit 3 STOPPED at call 1 rpc_error; server saw 2 requests; notAttempted [2,3]", r.rc === 3 && r.j.status === "STOPPED" && JSON.stringify(r.j.stop) === '{"callIndex":1,"outcome":"rpc_error","sent":true}' && srv.log.length === 2 && JSON.stringify(r.j.notAttempted) === "[2,3]", r.j);
  check("rpc error: error bytes kept verbatim as call-1.response.json and receipted; no call-2/3 files", Buffer.compare(rd(r.out, "call-1.response.json"), errBody(srv.log[1].body)) === 0 && a.attempts[1].receipted === true && !fs.existsSync(path.join(r.out, "call-2.request.json")));
  const v = verify(r.out);
  check("rpc error: verifier -> UNKNOWN, call 1 RPC_ERROR, missingCalls [2,3] (no fabricated empty)", v.verdict === "UNKNOWN" && v.calls[1].status === "RPC_ERROR" && JSON.stringify(v.missingCalls) === "[2,3]", { verdict: v.verdict, m: v.missingCalls });
  await srv.close();
}
// 3. HTTP status, timeout, oversize, total cap, transport errors, unparsed 200
const stopCase = async (name, behave, { limits = {}, expect, at: idx = 0, partial, receipted = 0, lastReceipted = false, extraCheck }) => {
  const srv = await server(behave);
  const r = await cap(srv, { spec: specWith(limits) });
  const a = att(r.out);
  const last = a.attempts[a.attempts.length - 1];
  const pf = path.join(r.out, `call-${idx}.response.unreceipted`);
  const okPartial = partial === undefined ? !fs.existsSync(pf) && (lastReceipted || last.response.file === null) : fs.existsSync(pf) && Buffer.compare(fs.readFileSync(pf), partial(srv)) === 0 && last.response.sha256 === sha(fs.readFileSync(pf));
  check(`${name}: exit 3 STOPPED ${expect} at call ${idx}, server saw ${idx + 1}, receipted ${receipted}, exact partial bytes ${partial ? "kept as .unreceipted" : "none"}`,
    r.rc === 3 && r.j.stop?.outcome === expect && r.j.stop.callIndex === idx && srv.log.length === idx + 1 && r.j.receipted === receipted && (lastReceipted || !fs.existsSync(path.join(r.out, `call-${idx}.response.json`))) && okPartial && last.receipted === lastReceipted && (extraCheck ? extraCheck(r, a, srv) : true), { j: r.j, last });
  await srv.close();
  return r;
};
const big = Buffer.from(`{"jsonrpc":"2.0","id":1,"result":[${'"x",'.repeat(60)}"x"]}`);
await stopCase("http 500", () => ({ status: 500, body: Buffer.from("upstream exploded\n") }), { expect: "http_status", partial: () => Buffer.from("upstream exploded\n"), extraCheck: (r, a) => a.attempts[0].httpStatus === 500 });
await stopCase("timeout (whole-call deadline)", (i, b) => ({ body: okBody(b), hangAfter: 7, delayMs: 3000 }), { limits: { timeoutMs: 400 }, expect: "timeout", partial: (s) => okBody(s.log[0].body).subarray(0, 7) });
await stopCase("per-response oversize", () => ({ body: big }), { limits: { maxResponseBytes: 64 }, expect: "response_oversize", partial: () => big.subarray(0, 64), extraCheck: (r) => r.j.totalResponseBytes === 64 });
const sz = (b) => okBody(b).length;
await stopCase("total byte cap on call 1", (i, b) => ({ body: okBody(b) }), { limits: { maxTotalBytes: 50 }, at: 1, receipted: 1, expect: "total_bytes_cap", partial: (s) => okBody(s.log[1].body).subarray(0, 50 - sz(s.log[0].body)), extraCheck: (r) => r.j.totalResponseBytes === 50 });
await stopCase("connection reset mid-body", (i, b) => ({ body: okBody(b), destroyAfter: 10 }), { expect: "transport_error", partial: (s) => okBody(s.log[0].body).subarray(0, 10) });
await stopCase("200 non-JSON body", () => ({ body: Buffer.from("<html>nope</html>") }), { expect: "response_unparsed", receipted: 1, lastReceipted: true, partial: undefined, extraCheck: (r, a) => a.attempts[0].receipted === true && Buffer.compare(rd(r.out, "call-0.response.json"), Buffer.from("<html>nope</html>")) === 0 && a.attempts[0].response.file === "call-0.response.json" });
{
  const srv = await server(() => ({ body: Buffer.from("") }));
  const dead = srv.url; await srv.close();
  const r = await run(["--spec", specWith(), "--manifest", MAN, "--plan", PLAN, "--endpoint", dead, "--out", outDir()]);
  check("connection refused: exit 3 transport_error at call 0, no response file, receipts index empty", r.rc === 3 && r.j.stop.outcome === "transport_error" && r.j.receipted === 0 && r.j.attempted === 1, r.j);
}
// 4. preflight refusals: exit 2, no request reaches the server, no output dir
const truncated = planVariant((s) => { s.caps.maxCalls = 3; });
const reconcile = planVariant((s) => { s.evidence.removedLogsSeen = true; });
const fixture8 = path.join(at.verifier, "fixtures/plan.synthetic.json");
fs.mkdirSync(path.join(W, "real")); fs.symlinkSync(path.join(W, "real"), path.join(W, "link"));
fs.mkdirSync(path.join(W, "exists"));
const refusals = [
  ["8-call plan > maxCalls 5", { plan: fixture8, spec: specWith({}, pinsFor(fixture8)) }, "call_budget_exceeds_limit"],
  ["plan truncated by call budget", { plan: truncated, spec: specWith({}, pinsFor(truncated)) }, "plan_not_capturable"],
  ["plan UNKNOWN_NEEDS_RECONCILIATION", { plan: reconcile, spec: specWith({}, pinsFor(reconcile)) }, "plan_not_capturable"],
  ["maxCalls 6", { spec: specWith({ maxCalls: 6 }) }, "limit_invalid"],
  ["maxCalls 3 < callCount 4", { spec: specWith({ maxCalls: 3 }) }, "call_budget_exceeds_limit"],
  ["paceMs 1249", { spec: specWith({ paceMs: 1249 }) }, "limit_invalid"],
  ["timeoutMs 8001", { spec: specWith({ timeoutMs: 8001 }) }, "limit_invalid"],
  ["maxResponseBytes 1048577", { spec: specWith({ maxResponseBytes: 1048577 }) }, "limit_invalid"],
  ["maxTotalBytes 0", { spec: specWith({ maxTotalBytes: 0 }) }, "limit_invalid"],
  ["maxTotalBytes above plan maxBytes", { spec: specWith({ maxTotalBytes: 50000001 }) }, "total_bytes_exceeds_plan_maxBytes"],
  ["limits.maxTotalBytes missing", { spec: writeJson({ ...baseSpec, limits: { ...baseSpec.limits, maxTotalBytes: undefined } }) }, "spec_missing_field"],
  ["planSha256 pin mismatch", { spec: specWith({}, { plan: { ...baseSpec.plan, planSha256: "0".repeat(64) } }) }, null],
  ["plan file sha pin mismatch", { spec: specWith({}, { plan: { ...baseSpec.plan, fileSha256: "0".repeat(64) } }) }, null],
  ["manifest pin mismatch", { spec: specWith({}, { manifest: { ...baseSpec.manifest, manifestSha256: "0".repeat(64) } }) }, null],
  ["unknown spec field", { spec: specWith({}, { endpoint: "http://x" }) }, "spec_unknown_field"],
  ["duplicate spec key", { spec: writeJson(JSON.stringify(baseSpec).replace('"schema":', '"schema":"x","schema":')) }, "json_duplicate_key"],
  ["--out exists", { out: path.join(W, "exists") }, "out_dir_exists"],
  ["--out parent is a symlink", { out: path.join(W, "link", "o") }, "out_parent_symlink"],
  ["--out parent missing", { out: path.join(W, "nope", "o") }, "out_parent_missing"],
];
for (const [name, o, reason] of refusals) {
  const srv = await server(() => ({ body: Buffer.from("{}") }));
  const out = o.out ?? outDir();
  const existed = fs.existsSync(out);
  const r = await cap(srv, { ...o, out });
  check(`refuse ${name}: exit 2${reason ? ` ${reason}` : ""}, no request sent, no output created`, r.rc === 2 && r.stderr === "" && typeof r.j?.refused === "string" && (reason === null || r.j.refused === reason) && srv.log.length === 0 && (existed || !fs.existsSync(out)), r.j);
  await srv.close();
}
for (const [name, args, reason] of [
  ["ftp endpoint", ["--endpoint", "ftp://127.0.0.1/x"], "endpoint_scheme_unsupported"],
  ["endpoint with userinfo", ["--endpoint", "http://u:p@127.0.0.1/x"], "endpoint_userinfo_refused"],
  ["missing --endpoint", [], "usage"],
  ["unknown --retries", ["--endpoint", "http://127.0.0.1:9/x", "--retries", "3"], "usage"],
  ["duplicate --plan", ["--endpoint", "http://127.0.0.1:9/x", "--plan", PLAN], "usage_duplicate_argument"],
]) {
  const out = outDir();
  const r = await run(["--spec", specWith(), "--manifest", MAN, "--plan", PLAN, "--out", out, ...args]);
  check(`refuse ${name}: exit 2 ${reason}, no output created`, r.rc === 2 && r.j?.refused === reason && !fs.existsSync(out), r.j);
}
// C1-B1: exhausted total byte budget sends nothing more
const tight = (b) => Buffer.from(`{"jsonrpc":"2.0","id":${JSON.parse(b).id},"result":[]}`);
{
  const srv = await server((i, b) => ({ body: tight(b) }));
  const r = await cap(srv, { spec: specWith({ maxTotalBytes: 36 }) });
  const a = att(r.out);
  check("B1 exact exhaustion: 36 B cap, first body exactly 36 B -> exit 3 STOPPED total_bytes_exhausted at call 1 sent:false; exactly 1 POST; no call-1 request file; notAttempted [1,2,3]",
    tight(srv.log[0].body).length === 36 && r.rc === 3 && r.j.status === "STOPPED" && JSON.stringify(r.j.stop) === '{"callIndex":1,"outcome":"total_bytes_exhausted","sent":false}' && srv.log.length === 1 && !fs.existsSync(path.join(r.out, "call-1.request.json")) && JSON.stringify(r.j.notAttempted) === "[1,2,3]" && r.j.totalResponseBytes === 36 && a.attempts.length === 1 && r.j.receipted === 1, { j: r.j, posts: srv.log.length });
  const v = verify(r.out);
  check("B1 exact exhaustion: verifier -> UNKNOWN, call 0 VERIFIED_EMPTY, missingCalls [1,2,3]", v.verdict === "UNKNOWN" && v.calls[0].status === "VERIFIED_EMPTY" && JSON.stringify(v.missingCalls) === "[1,2,3]", v.missingCalls);
  await srv.close();
}
{
  const srv = await server((i, b) => ({ body: tight(b) }));
  const r = await cap(srv, { spec: specWith({ maxTotalBytes: 144 }) });
  check("B1 cap == exact sum of 4 bodies (144 B): exit 0 CAPTURED_ALL_PLANNED, exactly 4 POSTs, no extra call", r.rc === 0 && r.j.status === "CAPTURED_ALL_PLANNED" && srv.log.length === 4 && r.j.totalResponseBytes === 144, r.j);
  await srv.close();
}
await stopCase("B1 cap == sum-1 (143 B)", (i, b) => ({ body: tight(b) }), { limits: { maxTotalBytes: 143 }, at: 3, receipted: 3, expect: "total_bytes_cap", partial: (s) => tight(s.log[3].body).subarray(0, 35), extraCheck: (r) => r.j.totalResponseBytes === 143 });
// C1-B2: short / zero / failed writes
const allExact = (out, srv) => { const a = att(out); return a.attempts.every((x, i) => { const q = rd(out, x.request.file); const p = rd(out, x.response.file); return Buffer.compare(q, srv.log[i].body) === 0 && q.length === x.request.bytes && sha(q) === x.request.sha256 && Buffer.compare(p, okBody(srv.log[i].body)) === 0 && p.length === x.response.bytes && sha(p) === x.response.sha256 && x.response.persisted; }) && JSON.parse(rd(out, "receipts.json")).receipts.every((e) => sha(rd(out, e.request.file)) === e.request.sha256 && sha(rd(out, e.response.file)) === e.response.sha256); };
for (const [name, fault] of [["B2 first writeSync returns 16 B (looped to completion)", { file: "*", mode: "short_first" }], ["B2 every writeSync capped at 7 B", { file: "*", mode: "short_all" }]]) {
  const srv = await server((i, b) => ({ body: okBody(b) }));
  const r = await cap(srv, { fault });
  const v = r.rc === 0 ? verify(r.out) : {};
  check(`${name}: exit 0, every request/response file full and byte-equal to the wire, sizes and shas equal sidecar and index; sidecars parse; verifier ALL_CALLS_RECEIPTED`,
    r.rc === 0 && r.j.status === "CAPTURED_ALL_PLANNED" && srv.log.length === 4 && rd(r.out, "call-0.request.json").length === srv.log[0].body.length && allExact(r.out, srv) && r.j.attempts.sha256 === sha(rd(r.out, "attempts.json")) && r.j.receiptsIndex.sha256 === sha(rd(r.out, "receipts.json")) && v.verdict === "ALL_CALLS_RECEIPTED", { j: r.j, v: v.verdict });
  await srv.close();
}
const failCase = async (name, fault, { posts, stopAt, outcome, stage, written, receipted, extraCheck }) => {
  const srv = await server((i, b) => ({ body: okBody(b) }));
  const r = await cap(srv, { fault });
  let a = null; try { a = att(r.out); } catch {}
  const w = r.j?.writeFailures?.[0];
  check(`${name}: exit 5 WRITE_FAILED, ${outcome ?? "sidecar"} ${stage}, bytesWritten ${written}, exactly ${posts} POSTs, ${receipted} receipted, no retry`,
    r.rc === 5 && r.j.status === "WRITE_FAILED" && srv.log.length === posts && w?.file === fault.file && w?.stage === stage && w?.bytesWritten === written && r.j.receipted === receipted && (outcome === undefined || (r.j.stop?.outcome === outcome && r.j.stop.callIndex === stopAt)) && (extraCheck ? extraCheck(r, a, srv) : true), { j: r.j, posts: srv.log.length });
  await srv.close();
};
await failCase("B2 request write returns 0", { file: "call-0.request.json", mode: "zero" }, { posts: 0, stopAt: 0, outcome: "request_write_failed", stage: "write_no_progress", written: 0, receipted: 0, extraCheck: (r, a) => r.j.stop.sent === false && a.attempts.length === 0 && JSON.stringify(a.notAttempted) === "[0,1,2,3]" && JSON.parse(rd(r.out, "receipts.json")).receipts.length === 0 });
await failCase("B2 request write EIO on call 2", { file: "call-2.request.json", mode: "eio" }, { posts: 2, stopAt: 2, outcome: "request_write_failed", stage: "write", written: 0, receipted: 2, extraCheck: (r, a) => JSON.stringify(a.notAttempted) === "[2,3]" });
await failCase("B2 request bytes corrupted on disk (call 2)", { file: "call-2.request.json", mode: "corrupt" }, { posts: 2, stopAt: 2, outcome: "request_write_failed", stage: "readback_mismatch", written: srv0len(2), receipted: 2 });
await failCase("B2 response write EIO on call 1", { file: "call-1.response.json", mode: "eio" }, { posts: 2, stopAt: 1, outcome: "response_write_failed", stage: "write", written: 0, receipted: 1, extraCheck: (r, a) => a.attempts[1].response.persisted === false && a.attempts[1].response.sha256 === null && a.attempts[1].receipted === false && r.j.stop.sent === true && JSON.stringify(JSON.parse(rd(r.out, "receipts.json")).receipts.map((e) => e.callIndex)) === "[0]" && JSON.stringify(verify(r.out).missingCalls) === "[1,2,3]" });
await failCase("B2 response partial 5 B then EIO (call 0)", { file: "call-0.response.json", mode: "eio_after_partial" }, { posts: 1, stopAt: 0, outcome: "response_write_failed", stage: "write", written: 5, receipted: 0, extraCheck: (r, a, s) => a.attempts[0].response.receivedSha256 === sha(okBody(s.log[0].body)) && a.attempts[0].response.write.bytesWritten === 5 });
await failCase("B2 response fsync EIO (call 0)", { file: "call-0.response.json", mode: "fsync_eio" }, { posts: 1, stopAt: 0, outcome: "response_write_failed", stage: "fsync", written: okLen(1), receipted: 0 });
await failCase("B2 receipts.json write EIO", { file: "receipts.json", mode: "eio" }, { posts: 4, stage: "write", written: 0, receipted: 4, extraCheck: (r, a) => r.j.stop === null && r.j.receiptsIndex.persisted === false && r.j.receiptsIndex.sha256 === null && a.receiptsIndex.persisted === false && a.writeFailures[0].file === "receipts.json" });
await failCase("B2 attempts.json short-then-EIO", { file: "attempts.json", mode: "eio_after_partial" }, { posts: 4, stage: "write", written: 5, receipted: 4, extraCheck: (r) => r.j.attempts.persisted === false && r.j.attempts.sha256 === null && r.j.receiptsIndex.sha256 === sha(rd(r.out, "receipts.json")) });
// 5. static
const src = fs.readFileSync("capture.mjs", "utf8");
const banned = ["child_process", "process.env", "readdir", "writeFileSync", "appendFile", "rmSync", "unlink", "rename", "Date.now", "new Date", "/Volumes", "T7", "/Users", "fetch(", "WebSocket", "retry"];
check("static: no child_process/env/dir-scan/non-exclusive writes/deletes/wall clock/hardcoded paths/fetch/retry in capture.mjs", banned.every((b) => !src.includes(b)), banned.filter((b) => src.includes(b)));
check("static: every output write goes through one O_CREAT|O_EXCL|O_NOFOLLOW open with a single looped writeSync + fsync + readback; the only network call is one http(s).request per call", (src.match(/fs\.openSync\(/g) ?? []).length === 2 && src.includes("O_EXCL | fs.constants.O_NOFOLLOW") && (src.match(/fs\.writeSync\(/g) ?? []).length === 1 && (src.match(/fs\.fsyncSync\(/g) ?? []).length === 1 && src.includes("readback_mismatch") && (src.match(/\.request\(/g) ?? []).length === 1);
check("static: fixtures unchanged", spawnSync("git", ["diff", "--quiet", "HEAD", "--", "fixtures"]).status === 0);
fs.rmSync(W, { recursive: true, force: true });
const pass = results.filter((x) => x.ok).length;
console.log(`${pass} PASS, ${results.length - pass} FAIL`);
fs.mkdirSync("evidence", { recursive: true });
fs.writeFileSync("evidence/results.json", `${JSON.stringify({ schema: "backfill-receipt-capture-test/1", node: process.version.split(".")[0], cases: results }, null, 1)}\n`);
process.exitCode = pass === results.length ? 0 : 1;

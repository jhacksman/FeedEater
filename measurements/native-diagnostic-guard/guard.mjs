// Loopback-only read-only JSON-RPC budget guard for a root-operated isolated native diagnostic of frozen #173.
// Transport-budget guard only: not a source-latency path, not a collector, no admission or delivery claim.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { CEIL, Refusal, canonical, strictParse } from "./vendor/capture.mjs";
import { abortableTransport } from "./transport.mjs";

export const SPEC_SCHEMA = "native-diagnostic-guard-spec/1";
export const RUNPLAN_SCHEMA = "native-diagnostic-guard-runplan/1";
export const LOG_SCHEMA = "native-diagnostic-guard-log/1";
export const SOURCE = Object.freeze({ commit: "5206f9035ad1c057d78990b294941221e936f895", module: "modules/base-collector" });
export const VENDOR = Object.freeze({ file: "vendor/capture.mjs", from: "56f8f3bcc072f86d13b55f34f6f3632bd142f6ba:measurements/backfill-receipt-capture/capture.mjs", blob: "b9f0aaa92e306b5a8cecdd7d0fcfd61b2110f2a0", sha256: "d2c1395331150c50bdee6a0bec6c7a1fb94f90499b8923b0dcb152a15ac93e9a" });
export const LOOPBACK = "127.0.0.1";
export const GUARD_CEIL = Object.freeze({ maxCalls: 64, maxRangeBlocks: 500, maxDurationMs: 21600000, maxRequestBytes: 65536 });
export const METHODS = Object.freeze(["eth_blockNumber", "eth_getLogs"]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const refuse = (reason, detail = {}) => { throw new Refusal(reason, detail); };
{
  const v = fs.readFileSync(path.join(HERE, VENDOR.file));
  if (sha256(v) !== VENDOR.sha256) refuse("vendor_hash_mismatch", { file: VENDOR.file });
}

// Native env keys, literal from 5206f90 modules/base-collector/src/config.ts:3-33 and envName() :36-38.
const NATIVE_STRING = ["wsUrl", "httpUrl", "natsUrl", "databaseUrl", "stateDir", "poolManager"];
const NATIVE_NUMERIC = ["startBlock", "confirmBlocks", "overlapBlocks", "backfillChunkBlocks", "maxBackfillBlocks", "maxRecoverBlocks", "retainBlocks", "maxTrackedPools", "poolIdleBlocks", "maxPendingSwaps", "rpcMinIntervalMs", "rpcTimeoutMs", "reconnectBaseMs", "reconnectMaxMs", "statusIntervalMs", "checkpointIntervalMs", "persisterTimeoutMs", "rateAlertPerSec", "persistBatchSize", "persistFlushMs", "persistMaxQueue", "persistHeartbeatMs", "persistRecoverIntervalMs", "persistRecoverOverlapBlocks", "persistMissingSealGraceBlocks", "persistStartBlock"];
const NATIVE_LIST = ["extraHooks", "extraPoolIds", "suitesJson"];
const envName = (k) => `BASE_COLLECTOR_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
export const NATIVE_ENV_KEYS = Object.freeze([...NATIVE_STRING, ...NATIVE_NUMERIC, ...NATIVE_LIST].map(envName));
export const HTTP_ENV = envName("httpUrl");
export const REQUIRED_ENV = Object.freeze(["wsUrl", "natsUrl", "databaseUrl", "stateDir", "startBlock", "persistStartBlock"].map(envName));
const SECRET_ENV = new Set(["wsUrl", "natsUrl", "databaseUrl"].map(envName));

const ADDR = /^0x[0-9a-f]{40}$/;
const H32 = /^0x[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;
const QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const shape = (o, keys, where) => {
  if (!isObj(o)) refuse("shape_invalid", { where, m: "object" });
  const got = Object.keys(o).sort(); const want = [...keys].sort();
  if (canonical(got) !== canonical(want)) refuse("shape_invalid", { where, expected: want, got });
};
const nat = (v, where, min, max) => { if (!Number.isSafeInteger(v) || v < min || v > max) refuse("value_invalid", { where, m: `safe integer in [${min}, ${max}]` }); return v; };
const absPath = (p, where) => { if (typeof p !== "string" || !path.isAbsolute(p) || path.normalize(p) !== p || (p.length > 1 && p.endsWith("/"))) refuse("path_invalid", { where }); return p; };
const inside = (root, p) => { const r = path.relative(root, p); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };

function unresolved(v, where, acc) {
  if (v === null || v === "UNRESOLVED") acc.push(where);
  else if (Array.isArray(v)) v.forEach((x, i) => unresolved(x, `${where}[${i}]`, acc));
  else if (isObj(v)) for (const k of Object.keys(v).sort()) unresolved(v[k], `${where}.${k}`, acc);
  return acc;
}

function checkFilter(f, where) {
  if (!isObj(f) || !Object.hasOwn(f, "address")) refuse("filter_invalid", { where });
  for (const k of Object.keys(f)) if (k !== "address" && k !== "topics") refuse("filter_invalid", { where, key: k });
  if (!Array.isArray(f.address) || f.address.length < 1 || !f.address.every((a) => typeof a === "string" && ADDR.test(a))) refuse("filter_invalid", { where, m: "address" });
  if (Object.hasOwn(f, "topics")) {
    const ok = Array.isArray(f.topics) && f.topics.length <= 4 && f.topics.every((t) => t === null || (typeof t === "string" && H32.test(t)) || (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && H32.test(x))));
    if (!ok) refuse("filter_invalid", { where, m: "topics" });
  }
}

export function validateSpec(spec) {
  shape(spec, ["schema", "source", "projectAromer", "native", "rootInputs", "limits", "allow"], "spec");
  if (spec.schema !== SPEC_SCHEMA) refuse("spec_schema_mismatch", { expected: SPEC_SCHEMA });
  shape(spec.source, ["commit"], "source");
  if (spec.source.commit !== SOURCE.commit) refuse("source_commit_mismatch", { expected: SOURCE.commit });
  shape(spec.native, ["env", "measure"], "native");
  shape(spec.native.measure, ["out", "warmupS", "windowS", "teardownS", "poolsFromCheckpoint"], "native.measure");
  shape(spec.rootInputs, ["checkpoint", "head", "window", "filters"], "rootInputs");
  shape(spec.rootInputs.checkpoint, ["verifiedBlock", "blockHash", "fileSha256"], "rootInputs.checkpoint");
  shape(spec.rootInputs.head, ["number", "hash"], "rootInputs.head");
  shape(spec.rootInputs.window, ["clockId", "startUtc", "endUtc"], "rootInputs.window");
  if (!isObj(spec.native.env)) refuse("shape_invalid", { where: "native.env" });
  for (const k of Object.keys(spec.native.env)) {
    if (k === HTTP_ENV) refuse("http_url_is_the_guard_listener", { key: k });
    if (!NATIVE_ENV_KEYS.includes(k)) refuse("env_key_unknown", { key: k });
  }
  const missing = unresolved(spec.projectAromer, "projectAromer", []);
  for (const k of REQUIRED_ENV) if (!Object.hasOwn(spec.native.env, k)) missing.push(`native.env.${k}`);
  unresolved(spec.native, "native", missing);
  unresolved(spec.rootInputs, "rootInputs", missing);
  if (missing.length > 0) refuse("root_inputs_unresolved", { paths: [...new Set(missing)].sort() });

  const root = absPath(spec.projectAromer, "projectAromer");
  for (const [k, v] of Object.entries(spec.native.env)) if (typeof v !== "string" || v === "") refuse("env_value_invalid", { key: k });
  const m = spec.native.measure;
  if (!inside(root, absPath(m.out, "native.measure.out"))) refuse("output_outside_project_aromer", { where: "native.measure.out" });
  nat(m.warmupS, "native.measure.warmupS", 0, 86400); nat(m.windowS, "native.measure.windowS", 1, 86400); nat(m.teardownS, "native.measure.teardownS", 0, 86400);
  if (m.poolsFromCheckpoint !== false) absPath(m.poolsFromCheckpoint, "native.measure.poolsFromCheckpoint");
  const ri = spec.rootInputs;
  nat(ri.checkpoint.verifiedBlock, "rootInputs.checkpoint.verifiedBlock", 0, Number.MAX_SAFE_INTEGER);
  if (typeof ri.checkpoint.blockHash !== "string" || !H32.test(ri.checkpoint.blockHash)) refuse("value_invalid", { where: "rootInputs.checkpoint.blockHash" });
  if (typeof ri.checkpoint.fileSha256 !== "string" || !SHA.test(ri.checkpoint.fileSha256)) refuse("value_invalid", { where: "rootInputs.checkpoint.fileSha256" });
  nat(ri.head.number, "rootInputs.head.number", 0, Number.MAX_SAFE_INTEGER);
  if (typeof ri.head.hash !== "string" || !H32.test(ri.head.hash)) refuse("value_invalid", { where: "rootInputs.head.hash" });
  const w = ri.window;
  if (typeof w.clockId !== "string" || w.clockId === "") refuse("value_invalid", { where: "rootInputs.window.clockId" });
  for (const k of ["startUtc", "endUtc"]) if (typeof w[k] !== "string" || !UTC.test(w[k]) || Number.isNaN(Date.parse(w[k]))) refuse("value_invalid", { where: `rootInputs.window.${k}` });
  if (!(Date.parse(w.endUtc) > Date.parse(w.startUtc))) refuse("window_invalid", {});
  if (!Array.isArray(ri.filters) || ri.filters.length < 1) refuse("filter_invalid", { where: "rootInputs.filters" });
  ri.filters.forEach((f, i) => checkFilter(f, `rootInputs.filters[${i}]`));
  const fkeys = ri.filters.map(canonical);
  if (new Set(fkeys).size !== fkeys.length) refuse("filter_duplicate", {});

  const L = spec.limits;
  shape(L, ["maxCalls", "paceMs", "timeoutMs", "maxResponseBytes", "maxTotalBytes", "maxDurationMs", "maxRangeBlocks"], "limits");
  nat(L.maxCalls, "limits.maxCalls", 1, GUARD_CEIL.maxCalls);
  nat(L.paceMs, "limits.paceMs", CEIL.minPaceMs, 600000);
  nat(L.timeoutMs, "limits.timeoutMs", 1, CEIL.maxTimeoutMs);
  nat(L.maxResponseBytes, "limits.maxResponseBytes", 1, CEIL.maxResponseBytes);
  nat(L.maxTotalBytes, "limits.maxTotalBytes", 1, Number.MAX_SAFE_INTEGER);
  nat(L.maxDurationMs, "limits.maxDurationMs", 1, GUARD_CEIL.maxDurationMs);
  nat(L.maxRangeBlocks, "limits.maxRangeBlocks", 1, GUARD_CEIL.maxRangeBlocks);
  if (!Array.isArray(spec.allow) || spec.allow.length < 1 || spec.allow.length > GUARD_CEIL.maxCalls) refuse("allow_invalid", { m: `1..${GUARD_CEIL.maxCalls} entries` });
  if (L.maxCalls > spec.allow.length) refuse("call_budget_exceeds_allowlist", { maxCalls: L.maxCalls, allow: spec.allow.length });
  spec.allow.forEach((e, i) => checkAllowed(e, `allow[${i}]`, fkeys, L.maxRangeBlocks));
  return spec;
}

function checkAllowed(e, where, fkeys, maxRange) {
  shape(e, ["method", "params"], where);
  if (!METHODS.includes(e.method)) refuse("method_not_allowed", { where, method: e.method });
  if (!Array.isArray(e.params)) refuse("params_invalid", { where });
  if (e.method === "eth_blockNumber") { if (e.params.length !== 0) refuse("params_invalid", { where }); return; }
  if (e.params.length !== 1 || !isObj(e.params[0])) refuse("params_invalid", { where });
  const { fromBlock, toBlock, ...filter } = e.params[0];
  if (typeof fromBlock !== "string" || !QTY.test(fromBlock) || typeof toBlock !== "string" || !QTY.test(toBlock)) refuse("range_invalid", { where, m: "fromBlock/toBlock must be hex quantities" });
  const a = BigInt(fromBlock); const b = BigInt(toBlock);
  if (b < a || b - a + 1n > BigInt(maxRange)) refuse("range_invalid", { where, m: `1..${maxRange} blocks` });
  checkFilter(filter, where);
  if (!fkeys.includes(canonical(filter))) refuse("filter_not_declared", { where });
}

export function runplan(spec) {
  const env = {};
  for (const k of Object.keys(spec.native.env).sort()) env[k] = SECRET_ENV.has(k) ? { sha256: sha256(spec.native.env[k]) } : { value: spec.native.env[k] };
  env[HTTP_ENV] = { value: "GUARD_LISTENER_URL (printed by serve on stdout)" };
  const m = spec.native.measure;
  const measureArgv = ["node", "dist/main.js", "measure", "--out", m.out, "--warmup-s", String(m.warmupS), "--window-s", String(m.windowS), "--teardown-s", String(m.teardownS), ...(m.poolsFromCheckpoint === false ? [] : ["--pools-from-checkpoint", m.poolsFromCheckpoint])];
  const body = {
    schema: RUNPLAN_SCHEMA,
    source: { ...SOURCE, build: "package.json scripts.build: tsup src/index.ts src/main.ts --format esm --dts (root builds; dist path root-verified)", cli: "src/main.ts:238-244 collect | persist | measure | verify-persist; settings from process.env via src/config.ts loadSettings" },
    projectAromer: spec.projectAromer,
    commands: [
      { role: "guard", argv: ["node", "<reviewed candidate>/measurements/native-diagnostic-guard/guard.mjs", "serve", "--spec", "<ROOT_SPEC>", "--upstream", "<ROOT_UPSTREAM_HTTP>", "--out", "<ROOT_GUARD_OUT under projectAromer>"] },
      { role: "collect", argv: ["node", "dist/main.js", "collect"], env: "nativeEnv" },
      { role: "persist", argv: ["node", "dist/main.js", "persist"], env: "nativeEnv" },
      { role: "measure", argv: measureArgv, env: "nativeEnv" },
    ],
    nativeEnv: env,
    nativeEnvKeys: [...NATIVE_ENV_KEYS],
    httpUsersAt5206: { collect: "src/main.ts:70 PacedHttpRpc (eth_blockNumber, eth_getLogs)", verifyPersist: "src/main.ts:201 PacedHttpRpc (eth_getLogs)", measure: "none" },
    notGuarded: ["WebSocket eth_subscribe logs/newHeads to wsUrl (collect, measure src/main.ts:159-164)", "NATS", "PostgreSQL"],
    rootInputs: spec.rootInputs,
    rootInputsWiring: "declared and hashed here only; 5206f90 consumes none of checkpoint/head/window/filters from this plan",
    limits: spec.limits,
    allow: { count: spec.allow.length, sha256: sha256(canonical(spec.allow)), entries: spec.allow },
    claims: { sourceAdmission: "NOT_ESTABLISHED", latency: "NONE", liveDelivery: "NOT_CHANGED_BY_GUARD", acceptance: "NONE", q1q2: "UNADOPTED", t7: "NOT_INFERRED" },
  };
  return { ...body, runplanSha256: sha256(canonical(body)) };
}

class WriteFailure extends Error { constructor(file, stage, written, code) { super(stage); this.file = file; this.stage = stage; this.written = written; this.code = code; } }
// Same algorithm as capture C1 writeExclusive (not exported there): O_EXCL|O_NOFOLLOW, looped writes, fsync, readback.
function writeExclusive(dir, name, buf) {
  let fd;
  try { fd = fs.openSync(path.join(dir, name), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); } catch (e) { throw new WriteFailure(name, "open", 0, e.code ?? "error"); }
  let off = 0;
  try {
    while (off < buf.length) {
      let w;
      try { w = fs.writeSync(fd, buf, off, buf.length - off, off); } catch (e) { throw new WriteFailure(name, "write", off, e.code ?? "error"); }
      if (!Number.isSafeInteger(w) || w <= 0 || w > buf.length - off) throw new WriteFailure(name, "write_no_progress", off, null);
      off += w;
    }
    try { fs.fsyncSync(fd); } catch (e) { throw new WriteFailure(name, "fsync", off, e.code ?? "error"); }
    const back = Buffer.alloc(buf.length + 1);
    let got = 0;
    try { for (let r; got < back.length && (r = fs.readSync(fd, back, got, back.length - got, got)) > 0;) got += r; } catch (e) { throw new WriteFailure(name, "readback", off, e.code ?? "error"); }
    if (got !== buf.length || Buffer.compare(back.subarray(0, got), buf) !== 0) throw new WriteFailure(name, "readback_mismatch", off, null);
  } finally { fs.closeSync(fd); }
  return sha256(buf);
}
const tryWrite = (dir, name, buf) => { try { return { sha256: writeExclusive(dir, name, buf), write: null }; } catch (e) { if (!(e instanceof WriteFailure)) throw e; return { sha256: null, write: { file: e.file, stage: e.stage, bytesWritten: e.written, code: e.code } }; } };

function noSymlinkDir(p, what) {
  let s; try { s = fs.lstatSync(p); } catch { refuse(`${what}_missing`, {}); }
  if (s.isSymbolicLink()) refuse(`${what}_symlink`, {});
  if (!s.isDirectory()) refuse(`${what}_not_directory`, {});
}

export function preflight(specBuf, upstream, out) {
  const spec = validateSpec(strictParse(specBuf, "spec"));
  const root = spec.projectAromer;
  let real; try { real = fs.realpathSync(root); } catch { refuse("project_aromer_missing", {}); }
  if (real !== root) refuse("project_aromer_not_canonical", { m: "must be its own realpath (no symlink component)" });
  noSymlinkDir(root, "project_aromer");
  if (!inside(root, absPath(out, "--out"))) refuse("output_outside_project_aromer", { where: "--out" });
  let p = root;
  for (const c of path.relative(root, path.dirname(out)).split(path.sep).filter(Boolean)) { p = path.join(p, c); noSymlinkDir(p, "out_parent"); }
  let st = null; try { st = fs.lstatSync(out); } catch (e) { if (e.code !== "ENOENT") refuse("out_stat_failed", { code: e.code }); }
  if (st !== null) refuse("out_exists", {});
  let url; try { url = new URL(upstream); } catch { refuse("upstream_invalid", {}); }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("upstream_scheme_unsupported", {});
  if (url.username !== "" || url.password !== "") refuse("upstream_userinfo_refused", {});
  return { spec, plan: runplan(spec), url, out, upstreamSha256: sha256(upstream) };
}

const nowNs = () => process.hrtime.bigint();
const sleepUnless = (ms, signals) => new Promise((r) => {
  if (signals.some((x) => x.aborted)) { r(); return; }
  const done = () => { clearTimeout(t); for (const x of signals) x.removeEventListener("abort", done); r(); };
  const t = setTimeout(done, ms);
  for (const x of signals) x.addEventListener("abort", done, { once: true });
});
const rpcError = (reason) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `native-diagnostic-guard: ${reason}` } }));

function classifyRequest(body, method, url) {
  if (method !== "POST" || url !== "/") return { reason: "http_shape_refused" };
  if (body === null) return { reason: "request_oversize" };
  let j;
  try { j = strictParse(body, "request"); } catch (e) { if (e instanceof Refusal) return { reason: "request_malformed", detail: e.reason }; throw e; }
  if (!isObj(j)) return { reason: "request_malformed", detail: "not_single_object" };
  if (canonical(Object.keys(j).sort()) !== canonical(["id", "jsonrpc", "method", "params"])) return { reason: "request_malformed", detail: "keys" };
  if (j.jsonrpc !== "2.0" || !Number.isSafeInteger(j.id) || j.id < 0 || !Array.isArray(j.params)) return { reason: "request_malformed", detail: "envelope" };
  if (!METHODS.includes(j.method)) return { reason: "method_not_allowed" };
  return { j, key: canonical({ method: j.method, params: j.params }) };
}

function classifyResponse(r, room, L, reqJ) {
  if (r.kind === "oversize") return room < L.maxResponseBytes ? "total_bytes_cap" : "response_oversize";
  if (r.kind !== "complete") return r.kind;
  if (r.httpStatus !== 200) return "http_status";
  let j;
  try { j = strictParse(r.bytes, "response"); } catch (e) { if (e instanceof Refusal) return "response_malformed"; throw e; }
  if (!isObj(j) || j.jsonrpc !== "2.0" || j.id !== reqJ.id) return "response_malformed";
  if (Object.hasOwn(j, "error")) return "rpc_error";
  if (!Object.hasOwn(j, "result")) return "response_malformed";
  const ok = reqJ.method === "eth_blockNumber" ? typeof j.result === "string" && QTY.test(j.result) : Array.isArray(j.result);
  return ok ? "ok" : "response_malformed";
}

// Serves until every budgeted response was forwarded (COMPLETE), or the first error/refusal/disconnect, maxDurationMs or
// stop() latches STOP: the in-flight call and any pacing wait are aborted, nothing more goes upstream, nothing is retried.
export function serve(pre, { transport = abortableTransport, onListening = () => {} } = {}) {
  const { spec, plan, url, out } = pre;
  const L = spec.limits;
  try { fs.mkdirSync(out, { mode: 0o700 }); } catch (e) { refuse(e.code === "EEXIST" ? "out_exists" : "out_create_failed", { code: e.code }); }
  const writeFailures = [];
  const attempts = [];
  const refusals = [];
  const counts = { received: 0, admitted: 0, sent: 0, responded: 0, persisted: 0, forwarded: 0 };
  const used = spec.allow.map(() => false);
  const keys = spec.allow.map(canonical);
  const latch = new AbortController();
  let stop = null;
  let total = 0;
  let seq = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let current = null;
  let lastEnd = null;
  let deadline = null;
  let chain = Promise.resolve();
  let finished = false;
  let timer = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const setStop = (outcome, extra = {}) => {
    if (stop !== null) return;
    stop = { outcome, request: null, call: null, ...extra, sent: extra.sent ?? current !== null, inFlightCall: extra.inFlightCall !== undefined ? extra.inFlightCall : current };
    latch.abort();
  };
  const rp = tryWrite(out, "runplan.json", Buffer.from(`${canonical(plan)}\n`));
  const server = http.createServer();
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    latch.abort();
    server.close();
    chain.then(() => {
      server.closeAllConnections?.();
      const log = { schema: LOG_SCHEMA, runplanSha256: plan.runplanSha256, upstreamSha256: pre.upstreamSha256, limits: L, stop, counts: { ...counts }, attempts, refusals,
        notUsed: used.map((u, i) => (u ? null : i)).filter((i) => i !== null), upstreamCalls: counts.sent, maxInFlight, totalResponseBytes: total, retries: 0, writeFailures: [...writeFailures],
        notClaimed: "transport budget guard only: no source latency, live delivery, completeness, admission or acceptance claim; WS/NATS/PostgreSQL not guarded; Q1/Q2 UNADOPTED; T7 not inferred" };
      const lg = tryWrite(out, "guard-log.json", Buffer.from(`${JSON.stringify(log, null, 1)}\n`));
      if (lg.write !== null) writeFailures.push(lg.write);
      const status = writeFailures.length > 0 ? "WRITE_FAILED" : stop === null && counts.forwarded === L.maxCalls ? "COMPLETE" : "STOPPED";
      resolveDone({ status, stop, counts: { ...counts }, upstreamCalls: counts.sent, refused: refusals.length, notUsed: log.notUsed, maxInFlight, totalResponseBytes: total, writeFailures,
        runplan: { file: "runplan.json", sha256: rp.sha256, runplanSha256: plan.runplanSha256 }, log: { file: "guard-log.json", sha256: lg.sha256, persisted: lg.write === null } });
    });
  };
  if (rp.write !== null) { writeFailures.push(rp.write); setStop("runplan_write_failed", { sent: false }); finish(); return { done, stop: () => {} }; }
  // Resolves true only when the whole reply was handed to the client socket.
  const reply = (res, code, buf) => new Promise((r) => {
    if (res.headersSent || res.destroyed || res.writableEnded) { r(false); return; }
    res.once("finish", () => r(true));
    res.once("close", () => r(res.writableFinished));
    res.writeHead(code, { "content-type": "application/json", "content-length": buf.length, connection: "close" });
    res.end(buf);
  });
  const note = (idx, body, reason, extra = {}) => refusals.push({ request: idx, reason, detail: null, bytes: body === null ? null : body.length, receivedSha256: body === null ? null : sha256(body), file: null, fileSha256: null, afterStop: stop !== null, ...extra });
  const refuseReq = (res, idx, body, reason, detail) => {
    let file = null; let fsha = null;
    if (body !== null) { const w = tryWrite(out, `refused-${idx}.request.bin`, body); if (w.write !== null) writeFailures.push(w.write); else { file = `refused-${idx}.request.bin`; fsha = w.sha256; } }
    note(idx, body, reason, { detail: detail ?? null, file, fileSha256: fsha });
    setStop("refused", { request: idx, reason, sent: false });
    reply(res, 403, rpcError(reason));
    finish();
  };
  const notSent = async (res, idx, body, a, reason, code) => {
    used[a] = false;
    note(idx, body, reason);
    if (stop === null) setStop(reason, { request: idx, sent: false });
    await reply(res, code, rpcError(reason));
    finish();
  };
  const forward = async (res, idx, body, j, a, rctl) => {
    const before = () => (stop !== null ? "guard_stopped_before_send" : rctl.signal.aborted ? "client_disconnected_before_send" : null);
    if (before() !== null) return notSent(res, idx, body, a, before(), 403);
    if (lastEnd !== null) { const wait = L.paceMs - Number(nowNs() - lastEnd) / 1e6; if (wait > 0) await sleepUnless(Math.ceil(wait), [latch.signal, rctl.signal]); }
    if (before() !== null) return notSent(res, idx, body, a, before(), 403);
    const remaining = Math.floor(Number(deadline - nowNs()) / 1e6);
    if (remaining <= 0) return notSent(res, idx, body, a, "duration_exhausted", 502);
    const n = attempts.length;
    const reqFile = `call-${n}.request.json`;
    const rq = tryWrite(out, reqFile, body);
    if (rq.write !== null) { writeFailures.push(rq.write); return notSent(res, idx, body, a, "request_write_failed", 502); }
    const room = Math.min(L.maxResponseBytes, L.maxTotalBytes - total);
    if (room <= 0) return notSent(res, idx, body, a, "total_bytes_exhausted", 502);
    const effTimeoutMs = Math.min(L.timeoutMs, remaining);
    const cctl = new AbortController();
    const ab = () => cctl.abort();
    latch.signal.addEventListener("abort", ab, { once: true });
    rctl.signal.addEventListener("abort", ab, { once: true });
    if (latch.signal.aborted || rctl.signal.aborted) cctl.abort();
    current = n; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    const r = await transport(url, body, { timeoutMs: effTimeoutMs, maxBytes: room, signal: cctl.signal });
    inFlight -= 1; current = null;
    latch.signal.removeEventListener("abort", ab); rctl.signal.removeEventListener("abort", ab);
    if (r.created !== false) counts.sent += 1;
    lastEnd = nowNs();
    total += r.bytes.length;
    let outcome = classifyResponse(r, room, L, j);
    if (r.kind === "aborted") outcome = rctl.signal.aborted && stop === null ? "client_disconnected_in_flight" : "stopped_in_flight";
    else if (r.kind === "timeout" && effTimeoutMs < L.timeoutMs) outcome = "duration_exhausted";
    else if (stop !== null) outcome = "stopped_in_flight";
    else if (rctl.signal.aborted) outcome = "client_disconnected_in_flight";
    const complete200 = r.kind === "complete" && r.httpStatus === 200;
    if (complete200) counts.responded += 1;
    let respFile = null; let rs = { sha256: null, write: null };
    if (complete200 || r.bytes.length > 0) { respFile = complete200 ? `call-${n}.response.json` : `call-${n}.response.partial`; rs = tryWrite(out, respFile, r.bytes); }
    if (respFile !== null && rs.write === null) counts.persisted += 1;
    const at = { call: n, request: idx, allowIndex: a, method: j.method, requestFile: { file: reqFile, sha256: rq.sha256, bytes: body.length }, sent: r.created !== false, effTimeoutMs, outcome, transport: r.kind, httpStatus: r.httpStatus, error: r.error,
      response: { file: respFile, sha256: rs.write === null ? rs.sha256 : null, receivedSha256: sha256(r.bytes), bytes: r.bytes.length, complete: r.kind === "complete", partialSentinel: r.kind === "complete" ? null : { receivedBytes: r.bytes.length, complete: false, reason: r.kind }, persisted: respFile !== null && rs.write === null, write: rs.write }, forwarded: false };
    attempts.push(at);
    if (rs.write !== null) { writeFailures.push(rs.write); setStop("response_write_failed", { call: n, sent: true }); await reply(res, 502, rpcError("response_write_failed")); finish(); return; }
    if (outcome !== "ok") {
      setStop(outcome, { call: n, sent: at.sent, inFlightCall: r.kind === "aborted" ? n : null });
      if (outcome === "rpc_error") at.forwardedRpcError = await reply(res, 200, r.bytes); else await reply(res, 502, rpcError(outcome));
      finish();
      return;
    }
    at.forwarded = await reply(res, 200, r.bytes);
    if (!at.forwarded) { setStop("client_disconnected_on_reply", { call: n, sent: true }); finish(); return; }
    counts.forwarded += 1;
    if (counts.forwarded >= L.maxCalls) finish();
  };
  server.on("request", (req, res) => {
    const idx = seq++;
    counts.received += 1;
    const rctl = new AbortController();
    res.on("close", () => { if (!res.writableFinished) rctl.abort(); });
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n <= GUARD_CEIL.maxRequestBytes) chunks.push(c); });
    req.on("end", () => {
      const body = n > GUARD_CEIL.maxRequestBytes ? null : Buffer.concat(chunks);
      if (stop !== null || finished) { note(idx, body, "guard_stopped"); reply(res, 403, rpcError("guard_stopped")); return; }
      const c = classifyRequest(body, req.method, req.url);
      if (c.reason !== undefined) return refuseReq(res, idx, body, c.reason, c.detail);
      if (counts.admitted >= L.maxCalls) return refuseReq(res, idx, body, "call_budget_exhausted");
      let a = -1;
      for (let i = 0; i < keys.length; i++) if (!used[i] && keys[i] === c.key) { a = i; break; }
      if (a < 0) return refuseReq(res, idx, body, keys.includes(c.key) ? "call_already_consumed" : "call_not_allowlisted");
      used[a] = true; counts.admitted += 1;
      chain = chain.then(() => forward(res, idx, body, c.j, a, rctl)).catch(() => { setStop("internal_error"); reply(res, 502, rpcError("internal_error")); finish(); });
    });
  });
  server.listen(0, LOOPBACK, () => {
    const addr = server.address();
    deadline = nowNs() + BigInt(L.maxDurationMs) * 1000000n;
    timer = setTimeout(() => { setStop("duration_exhausted"); finish(); }, L.maxDurationMs);
    onListening({ listening: `http://${LOOPBACK}:${addr.port}/`, runplanSha256: plan.runplanSha256 });
  });
  server.on("error", () => { setStop("listen_failed", { sent: false }); finish(); });
  return { done, stop: (outcome = "root_stop") => { setStop(outcome); finish(); } };
}

function readNoFollow(p) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { refuse(e.code === "ENOENT" ? "spec_missing" : e.code === "ELOOP" ? "spec_is_symlink" : `spec_open_${e.code}`, {}); }
  try { if (!fs.fstatSync(fd).isFile()) refuse("spec_not_regular_file", {}); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

function args(argv, names) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.includes(argv[i]) || argv[i + 1] === undefined || argv[i + 1] === "") refuse("usage", { usage: `--spec <file>${names.length > 1 ? " --upstream <http(s)://...> --out <new dir under projectAromer>" : ""}` });
    if (Object.hasOwn(a, argv[i])) refuse("usage_duplicate_argument", { arg: argv[i] });
    a[argv[i]] = argv[i + 1];
  }
  if (names.some((n) => a[n] === undefined)) refuse("usage", { missing: names.filter((n) => a[n] === undefined) });
  return a;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "plan") { const a = args(rest, ["--spec"]); return { exit: 0, out: runplan(validateSpec(strictParse(readNoFollow(a["--spec"]), "spec"))) }; }
  if (cmd !== "serve") refuse("usage", { usage: "guard.mjs plan --spec S | serve --spec S --upstream URL --out DIR" });
  const a = args(rest, ["--spec", "--upstream", "--out"]);
  const pre = preflight(readNoFollow(a["--spec"]), a["--upstream"], a["--out"]);
  const g = serve(pre, { onListening: (l) => process.stdout.write(`${canonical(l)}\n`) });
  process.once("SIGINT", () => g.stop("root_signal"));
  process.once("SIGTERM", () => g.stop("root_signal"));
  const s = await g.done;
  return { exit: s.status === "WRITE_FAILED" ? 5 : s.status === "STOPPED" ? 3 : 0, out: s };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(({ exit, out }) => { process.stdout.write(`${canonical(out)}\n`); process.exitCode = exit; }, (e) => {
    if (!(e instanceof Refusal)) { process.stdout.write(`${canonical({ refused: "internal_error", detail: { m: String(e?.code ?? e?.name ?? "error") } })}\n`); process.exitCode = 4; return; }
    process.stdout.write(`${canonical({ refused: e.reason, detail: e.detail })}\n`); process.exitCode = 2;
  });
}

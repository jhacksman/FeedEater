#!/usr/bin/env node
// Root-operated backfill receipt capture for verifier 83aec5d. Sends ONLY the calls of a pinned PLANNED plan to a
// root-supplied endpoint, one at a time, and retains the exact request/response bytes plus sha/attempt sidecars.
// Never runs the verifier, retries, re-chunks, prints payload, or grants live resumption.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

export const INPUT_SCHEMA = "backfill-receipt-capture-input/1";
export const PLAN_SCHEMA = "backfill-plan/1";
export const MANIFEST_SCHEMA = "filter-manifest/1";
export const RECEIPTS_SCHEMA = "backfill-receipts/1";
export const ATTEMPTS_SCHEMA = "backfill-receipt-capture-attempts/1";
export const CEIL = Object.freeze({ maxCalls: 5, minPaceMs: 1250, maxTimeoutMs: 8000, maxResponseBytes: 1048576 });
export class Refusal extends Error {
  constructor(reason, detail = {}) { super(reason); this.reason = reason; this.detail = detail; }
}
const refuse = (reason, detail) => { throw new Refusal(reason, detail); };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// Strict JSON: refuses duplicate keys, __proto__, trailing data and invalid UTF-8.
export function strictParse(buf, where) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { refuse("json_malformed", { where, m: "utf8" }); }
  let i = 0;
  const STR = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const LIT = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const fail = (m) => refuse("json_malformed", { where, at: i, m });
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const NONE = Symbol("none");
  const tok = (re) => { re.lastIndex = i; const m = re.exec(text); if (m === null) return NONE; i = re.lastIndex; return JSON.parse(m[0]); };
  const val = (depth) => {
    if (depth > 64) fail("depth");
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o = {}; ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("key");
        const k = tok(STR); if (k === NONE) fail("key");
        if (k === "__proto__") refuse("json_forbidden_key", { where, key: k });
        if (Object.hasOwn(o, k)) refuse("json_duplicate_key", { where, key: k });
        ws(); if (text[i] !== ":") fail("colon"); i++;
        o[k] = val(depth + 1); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("object");
      }
    }
    if (c === "[") {
      i++; const a = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) { a.push(val(depth + 1)); ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; } fail("array"); }
    }
    const v = c === '"' ? tok(STR) : tok(LIT);
    if (v === NONE) fail("value");
    return v;
  };
  const v = val(0); ws();
  if (i !== text.length) fail("trailing");
  return v;
}


function readFileNoFollow(p, what) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { refuse(e.code === "ENOENT" ? `${what}_missing` : e.code === "ELOOP" ? `${what}_is_symlink` : `${what}_open_${e.code}`, { path: p }); }
  try {
    if (!fs.fstatSync(fd).isFile()) refuse(`${what}_not_regular_file`, { path: p });
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

const ADDR = /^0x[0-9a-f]{40}$/;
const H32 = /^0x[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;

function shape(o, keys, where) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) refuse("spec_malformed", { where, m: "not_object" });
  const have = Object.keys(o);
  const missing = keys.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !keys.includes(k));
  if (missing.length > 0) refuse("spec_missing_field", { where, missing });
  if (extra.length > 0) refuse("spec_unknown_field", { where, extra });
}
const nat = (v, where, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(v) || v < min || v > max) refuse("value_invalid", { where, m: `safe integer in [${min}, ${max}]` }); return v; };
const hash32 = (v, where) => { if (typeof v !== "string" || !H32.test(v)) refuse("value_invalid", { where, m: "lowercase 0x + 64 hex" }); return v; };

export function loadManifest(buf, pin) {
  const fileSha = sha256(buf);
  if (fileSha !== pin.fileSha256) refuse("manifest_file_hash_mismatch", { expected: pin.fileSha256, actual: fileSha });
  const m = strictParse(buf, "manifest");
  if (`${canonical(m)}\n` !== buf.toString("utf8")) refuse("manifest_noncanonical", {});
  if (m === null || typeof m !== "object" || Array.isArray(m) || m.schema !== MANIFEST_SCHEMA) refuse("manifest_schema_mismatch", { expected: MANIFEST_SCHEMA });
  const body = { ...m }; delete body.manifestSha256;
  if (m.manifestSha256 !== sha256(canonical(body))) refuse("manifest_self_hash_mismatch", {});
  if (m.manifestSha256 !== pin.manifestSha256) refuse("filter_identity_mismatch", { where: "spec.manifest.manifestSha256", expected: m.manifestSha256 });
  if (!Array.isArray(m.filtersets) || m.filtersets.length === 0) refuse("manifest_filtersets_invalid", {});
  const ids = new Set();
  const out = m.filtersets.map((f, i) => {
    const flt = f?.filter;
    const okFilter = flt !== null && typeof flt === "object" && !Array.isArray(flt) && Array.isArray(flt.address) && flt.address.length > 0 && flt.address.every((a) => typeof a === "string" && ADDR.test(a))
      && Object.keys(flt).every((k) => k === "address" || k === "topics")
      && (flt.topics === undefined || (Array.isArray(flt.topics) && flt.topics.every((t) => t === null || (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && H32.test(x))))));
    if (typeof f?.id !== "string" || ids.has(f.id) || !okFilter) refuse("manifest_filtersets_invalid", { index: i });
    if (f.filterSha256 !== sha256(canonical(flt))) refuse("manifest_filter_hash_mismatch", { id: f.id });
    ids.add(f.id);
    return { id: f.id, filter: flt, filterSha256: f.filterSha256 };
  });
  return { manifestSha256: m.manifestSha256, fileSha256: fileSha, filtersets: out, status: m.status ?? null };
}

const QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const LOG_REQ = ["address", "blockHash", "blockNumber", "data", "logIndex", "removed", "topics", "transactionHash", "transactionIndex"];
const LOG_OPT = ["blockTimestamp"];
const q = (n) => `0x${BigInt(n).toString(16)}`;
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const hex64 = (v, where) => { if (typeof v !== "string" || !SHA.test(v)) refuse("value_invalid", { where, m: "64 lowercase hex" }); };

function loadCanonical(buf, pinSha, what) {
  const fileSha = sha256(buf);
  if (fileSha !== pinSha) refuse(`${what}_file_hash_mismatch`, { expected: pinSha, actual: fileSha });
  const v = strictParse(buf, what);
  if (`${canonical(v)}\n` !== buf.toString("utf8")) refuse(`${what}_noncanonical`, {});
  return v;
}

export function loadPlan(buf, pin, man) {
  const p = loadCanonical(buf, pin.fileSha256, "plan");
  if (!isObj(p) || p.schema !== PLAN_SCHEMA) refuse("plan_schema_mismatch", { expected: PLAN_SCHEMA });
  const body = { ...p }; delete body.planSha256;
  if (p.planSha256 !== sha256(canonical(body))) refuse("plan_self_hash_mismatch", {});
  if (p.planSha256 !== pin.planSha256) refuse("plan_identity_mismatch", { expected: p.planSha256 });
  if (p.inputs?.manifest?.manifestSha256 !== man.manifestSha256) refuse("plan_manifest_mismatch", { plan: p.inputs?.manifest?.manifestSha256 ?? null, manifest: man.manifestSha256 });
  const maxBytes = p.inputs?.caps?.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Array.isArray(p.calls) || p.callCount !== p.calls.length) refuse("plan_invalid", {});
  p.calls.forEach((c, i) => {
    const f = man.filtersets.find((x) => x.id === c?.filtersetId);
    const ok = isObj(c) && c.index === i && f !== undefined && c.filterSha256 === f.filterSha256 && Number.isSafeInteger(c.fromBlock) && Number.isSafeInteger(c.toBlock) && c.fromBlock >= 0 && c.fromBlock <= c.toBlock
      && canonical(c.request) === canonical({ method: "eth_getLogs", params: [{ ...f.filter, fromBlock: q(c.fromBlock), toBlock: q(c.toBlock) }] });
    if (!ok) refuse("plan_call_unbound", { index: i });
  });
  return p;
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lim = (v, where, min, max) => { if (!Number.isSafeInteger(v) || v < min || v > max) refuse("limit_invalid", { where, m: `safe integer in [${min}, ${max}]` }); return v; };

function freshOutDir(out) {
  const abs = path.resolve(out);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (e) { if (e.code !== "ENOENT") refuse("out_dir_stat_failed", { code: e.code }); }
  if (st !== null) refuse("out_dir_exists", {});
  const parts = path.dirname(abs).split(path.sep).filter(Boolean);
  let p = path.sep;
  for (const c of parts) { p = path.join(p, c); let s; try { s = fs.lstatSync(p); } catch { refuse("out_parent_missing", {}); } if (s.isSymbolicLink()) refuse("out_parent_symlink", {}); if (!s.isDirectory()) refuse("out_parent_not_directory", {}); }
  return abs;
}

export function preflight(specBuf, manifestBuf, planBuf, endpoint, out) {
  const spec = strictParse(specBuf, "spec");
  shape(spec, ["schema", "manifest", "plan", "limits"], "spec");
  if (spec.schema !== INPUT_SCHEMA) refuse("spec_schema_mismatch", { expected: INPUT_SCHEMA });
  shape(spec.manifest, ["fileSha256", "manifestSha256"], "manifest");
  shape(spec.plan, ["fileSha256", "planSha256"], "plan");
  shape(spec.limits, ["maxCalls", "paceMs", "timeoutMs", "maxResponseBytes", "maxTotalBytes"], "limits");
  for (const [w, v] of [["manifest.fileSha256", spec.manifest.fileSha256], ["manifest.manifestSha256", spec.manifest.manifestSha256], ["plan.fileSha256", spec.plan.fileSha256], ["plan.planSha256", spec.plan.planSha256]]) hex64(v, w);
  const L = spec.limits;
  lim(L.maxCalls, "limits.maxCalls", 1, CEIL.maxCalls);
  lim(L.paceMs, "limits.paceMs", CEIL.minPaceMs, 600000);
  lim(L.timeoutMs, "limits.timeoutMs", 1, CEIL.maxTimeoutMs);
  lim(L.maxResponseBytes, "limits.maxResponseBytes", 1, CEIL.maxResponseBytes);
  lim(L.maxTotalBytes, "limits.maxTotalBytes", 1, Number.MAX_SAFE_INTEGER);
  const man = loadManifest(manifestBuf, spec.manifest);
  const plan = loadPlan(planBuf, spec.plan, man);
  if (plan.status !== "PLANNED" || plan.truncated !== false) refuse("plan_not_capturable", { status: plan.status, truncated: plan.truncated });
  if (plan.callCount < 1) refuse("plan_has_no_calls", {});
  if (plan.callCount > L.maxCalls) refuse("call_budget_exceeds_limit", { callCount: plan.callCount, maxCalls: L.maxCalls });
  if (L.maxTotalBytes > plan.inputs.caps.maxBytes) refuse("total_bytes_exceeds_plan_maxBytes", { maxTotalBytes: L.maxTotalBytes, planMaxBytes: plan.inputs.caps.maxBytes });
  let url;
  try { url = new URL(endpoint); } catch { refuse("endpoint_invalid", {}); }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("endpoint_scheme_unsupported", {});
  if (url.username !== "" || url.password !== "") refuse("endpoint_userinfo_refused", {});
  return { spec, man, plan, url, out: freshOutDir(out), endpointSha256: sha256(endpoint) };
}

// One POST, whole-call deadline, bytes capped at maxBytes; resolves {kind, httpStatus, bytes, error}.
export function httpTransport(url, body, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let settled = false;
    let status = null;
    const finish = (kind, error = null) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve({ kind, httpStatus: status, bytes: Buffer.concat(chunks), error }); };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": body.length } }, (res) => {
      status = res.statusCode;
      res.on("data", (c) => {
        if (settled) return;
        const room = maxBytes - n;
        if (c.length > room) { chunks.push(c.subarray(0, room)); n += room; finish("oversize"); return; }
        chunks.push(c); n += c.length;
      });
      res.on("end", () => finish("complete"));
      res.on("error", (e) => finish("transport_error", e.code ?? "response_error"));
      res.on("aborted", () => finish("transport_error", "aborted"));
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    req.on("error", (e) => finish("transport_error", e.code ?? "request_error"));
    req.end(body);
  });
}

export class WriteFailure extends Error {
  constructor(file, stage, written, code) { super(stage); this.file = file; this.stage = stage; this.written = written; this.code = code; }
}
const wf = (e) => ({ file: e.file, stage: e.stage, bytesWritten: e.written, code: e.code });

// Exclusive create, full write (short writes looped, zero/no progress refused), fsync, then read back through the same fd.
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
const tryWrite = (dir, name, buf) => { try { return { sha256: writeExclusive(dir, name, buf), write: null }; } catch (e) { if (!(e instanceof WriteFailure)) throw e; return { sha256: null, write: wf(e) }; } };

export async function capture(pre, transport = httpTransport) {
  const { spec, plan, url, out } = pre;
  const L = spec.limits;
  try { fs.mkdirSync(out, { mode: 0o700 }); } catch (e) { refuse(e.code === "EEXIST" ? "out_dir_exists" : "out_dir_create_failed", { code: e.code }); }
  const attempts = [];
  const receipts = [];
  let total = 0;
  let stop = null;
  const writeFailures = [];
  for (const c of plan.calls) {
    if (L.maxTotalBytes - total <= 0) { stop = { callIndex: c.index, outcome: "total_bytes_exhausted", sent: false }; break; }
    if (c.index > 0) await sleep(L.paceMs);
    const reqBuf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: c.index + 1, method: "eth_getLogs", params: [c.request.params[0]] }));
    const reqFile = `call-${c.index}.request.json`;
    const rq = tryWrite(out, reqFile, reqBuf);
    if (rq.write !== null) { writeFailures.push(rq.write); stop = { callIndex: c.index, outcome: "request_write_failed", sent: false, write: rq.write }; break; }
    const room = L.maxTotalBytes - total < L.maxResponseBytes ? L.maxTotalBytes - total : L.maxResponseBytes;
    const r = await transport(url, reqBuf, { timeoutMs: L.timeoutMs, maxBytes: room });
    total += r.bytes.length;
    let outcome;
    if (r.kind === "oversize") outcome = room < L.maxResponseBytes ? "total_bytes_cap" : "response_oversize";
    else if (r.kind !== "complete") outcome = r.kind;
    else if (r.httpStatus !== 200) outcome = "http_status";
    else {
      let j = null;
      try { j = JSON.parse(r.bytes.toString("utf8")); } catch {}
      outcome = j !== null && typeof j === "object" && Object.hasOwn(j, "error") ? "rpc_error" : j !== null && typeof j === "object" && Array.isArray(j.result) ? "ok" : "response_unparsed";
    }
    const complete200 = r.kind === "complete" && r.httpStatus === 200;
    let respFile = null;
    let rs = { sha256: null, write: null };
    if (complete200 || r.bytes.length > 0) { respFile = complete200 ? `call-${c.index}.response.json` : `call-${c.index}.response.unreceipted`; rs = tryWrite(out, respFile, r.bytes); }
    const persisted = respFile !== null && rs.write === null;
    const receipted = complete200 && persisted;
    if (receipted) receipts.push({ callIndex: c.index, request: { file: reqFile, sha256: rq.sha256 }, response: { file: respFile, sha256: rs.sha256 } });
    attempts.push({ attempt: attempts.length + 1, callIndex: c.index, request: { file: reqFile, sha256: rq.sha256, bytes: reqBuf.length, persisted: true }, outcome, transport: r.kind, httpStatus: r.httpStatus, error: r.error,
      response: { file: respFile, sha256: persisted ? rs.sha256 : null, receivedSha256: sha256(r.bytes), bytes: r.bytes.length, complete: r.kind === "complete", persisted, write: rs.write }, receipted });
    if (rs.write !== null) { writeFailures.push(rs.write); stop = { callIndex: c.index, outcome: "response_write_failed", sent: true, transportOutcome: outcome, write: rs.write }; break; }
    if (outcome !== "ok") { stop = { callIndex: c.index, outcome, sent: true }; break; }
  }
  const attempted = new Set(attempts.map((a) => a.callIndex));
  const notAttempted = plan.calls.map((c) => c.index).filter((i) => !attempted.has(i));
  const ri = tryWrite(out, "receipts.json", Buffer.from(`${JSON.stringify({ schema: RECEIPTS_SCHEMA, planSha256: plan.planSha256, receipts }, null, 1)}\n`));
  if (ri.write !== null) writeFailures.push(ri.write);
  const provenance = { backfill: true, live: false };
  const sidecar = { schema: ATTEMPTS_SCHEMA, pins: { manifest: spec.manifest, plan: spec.plan }, limits: L, endpointSha256: pre.endpointSha256, attempts, stop, notAttempted, totalResponseBytes: total,
    receiptsIndex: { file: "receipts.json", sha256: ri.sha256, persisted: ri.write === null, write: ri.write, receipted: receipts.length }, writeFailures: [...writeFailures], retries: 0, publicationProvenance: provenance, resumeLive: { permitted: false },
    notClaimed: "capture only: the verifier was not run; no completeness, canonicality, latency or source-admission claim; Q1/Q2 UNADOPTED" };
  const as = tryWrite(out, "attempts.json", Buffer.from(`${JSON.stringify(sidecar, null, 1)}\n`));
  if (as.write !== null) writeFailures.push(as.write);
  const status = writeFailures.length > 0 ? "WRITE_FAILED" : stop === null ? "CAPTURED_ALL_PLANNED" : "STOPPED";
  return { status, stop, attempted: attempts.length, receipted: receipts.length, notAttempted, totalResponseBytes: total, writeFailures,
    receiptsIndex: { file: "receipts.json", sha256: ri.sha256, persisted: ri.write === null }, attempts: { file: "attempts.json", sha256: as.sha256, persisted: as.write === null }, verifierRun: false, publicationProvenance: provenance, resumeLive: { permitted: false } };
}

async function main(argv) {
  const usage = "node capture.mjs --spec <spec.json> --manifest <manifest.json> --plan <plan.json> --endpoint <http(s)://...> --out <new-dir>";
  const names = ["--spec", "--manifest", "--plan", "--endpoint", "--out"];
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.includes(argv[i]) || argv[i + 1] === undefined) refuse("usage", { usage });
    if (Object.hasOwn(a, argv[i])) refuse("usage_duplicate_argument", { arg: argv[i] });
    a[argv[i]] = argv[i + 1];
  }
  if (names.some((n) => a[n] === undefined)) refuse("usage", { usage });
  const pre = preflight(readFileNoFollow(a["--spec"], "spec"), readFileNoFollow(a["--manifest"], "manifest"), readFileNoFollow(a["--plan"], "plan"), a["--endpoint"], a["--out"]);
  return capture(pre);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((s) => { process.stdout.write(`${canonical(s)}\n`); process.exitCode = s.status === "WRITE_FAILED" ? 5 : s.status === "STOPPED" ? 3 : 0; }, (e) => {
    if (!(e instanceof Refusal)) { process.stdout.write(`${canonical({ refused: "internal_error", detail: { m: String(e?.code ?? e?.name ?? "error") } })}\n`); process.exitCode = 4; return; }
    process.stdout.write(`${canonical({ refused: e.reason, detail: e.detail })}\n`); process.exitCode = 2;
  });
}

#!/usr/bin/env node
// Offline backfill receipt verifier. Checks caller-supplied request/response byte receipts against a pinned
// filter manifest and backfill plan. Never executes, publishes, reads a clock or the network, or scans directories.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const INPUT_SCHEMA = "backfill-receipt-verify-input/1";
export const OUTPUT_SCHEMA = "backfill-receipt-verification/1";
export const RECEIPTS_SCHEMA = "backfill-receipts/1";
export const PLAN_SCHEMA = "backfill-plan/1";
export const MANIFEST_SCHEMA = "filter-manifest/1";
export const CONTRACTS = Object.freeze({ filterManifest: "jhacksman/FeedEater 42185f2170fb68e5d55b5e8507f480229f58b4df measurements/filter-manifest (filter-manifest/1)", backfillPlan: "jhacksman/FeedEater a345d48a2f003348d3fe21910518ec1e6e54db35 measurements/backfill-plan (backfill-plan/1)" });
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

export function loadReceipts(buf, pin, plan) {
  const fileSha = sha256(buf);
  if (fileSha !== pin.fileSha256) refuse("receipts_file_hash_mismatch", { expected: pin.fileSha256, actual: fileSha });
  const r = strictParse(buf, "receipts");
  shape(r, ["schema", "planSha256", "receipts"], "receipts");
  if (r.schema !== RECEIPTS_SCHEMA) refuse("receipts_schema_mismatch", { expected: RECEIPTS_SCHEMA });
  if (r.planSha256 !== plan.planSha256) refuse("receipts_plan_mismatch", { expected: plan.planSha256 });
  if (!Array.isArray(r.receipts)) refuse("spec_malformed", { where: "receipts.receipts" });
  const seen = new Set();
  return r.receipts.map((x, i) => {
    shape(x, ["callIndex", "request", "response"], `receipts[${i}]`);
    if (!Number.isSafeInteger(x.callIndex) || x.callIndex < 0 || x.callIndex >= plan.calls.length) refuse("receipt_for_unplanned_call", { receipt: i, callIndex: x.callIndex });
    if (seen.has(x.callIndex)) refuse("receipt_duplicate_call", { callIndex: x.callIndex });
    seen.add(x.callIndex);
    for (const k of ["request", "response"]) {
      shape(x[k], ["file", "sha256"], `receipts[${i}].${k}`);
      if (typeof x[k].file !== "string" || !FILE.test(x[k].file)) refuse("receipt_file_name_invalid", { receipt: i, which: k });
      hex64(x[k].sha256, `receipts[${i}].${k}.sha256`);
    }
    return x;
  });
}

function checkLog(l, filter, call) {
  if (!isObj(l)) return ["MALFORMED_LOG", "not_object"];
  const ks = Object.keys(l);
  const miss = LOG_REQ.filter((k) => !ks.includes(k));
  const extra = ks.filter((k) => !LOG_REQ.includes(k) && !LOG_OPT.includes(k));
  if (miss.length > 0) return ["MALFORMED_LOG", `missing:${miss.join(",")}`];
  if (extra.length > 0) return ["MALFORMED_LOG", `unknown:${extra.join(",")}`];
  if (typeof l.address !== "string" || !ADDR.test(l.address)) return ["MALFORMED_LOG", "address"];
  for (const k of ["blockHash", "transactionHash"]) if (typeof l[k] !== "string" || !H32.test(l[k])) return ["MALFORMED_LOG", k];
  for (const k of ["blockNumber", "logIndex", "transactionIndex"]) if (typeof l[k] !== "string" || !QTY.test(l[k])) return ["MALFORMED_LOG", k];
  if (Object.hasOwn(l, "blockTimestamp") && (typeof l.blockTimestamp !== "string" || !QTY.test(l.blockTimestamp))) return ["MALFORMED_LOG", "blockTimestamp"];
  if (typeof l.data !== "string" || !DATA.test(l.data)) return ["MALFORMED_LOG", "data"];
  if (!Array.isArray(l.topics) || l.topics.length > 4 || !l.topics.every((t) => typeof t === "string" && H32.test(t))) return ["MALFORMED_LOG", "topics"];
  if (typeof l.removed !== "boolean") return ["MALFORMED_LOG", "removed"];
  if (!filter.address.includes(l.address)) return ["FILTER_MISMATCH", "log_address_not_in_filter"];
  for (const [j, t] of (filter.topics ?? []).entries()) if (t !== null && !t.includes(l.topics[j])) return ["FILTER_MISMATCH", `log_topic${j}_not_in_filter`];
  const bn = BigInt(l.blockNumber);
  if (bn < BigInt(call.fromBlock) || bn > BigInt(call.toBlock)) return ["FILTER_MISMATCH", "log_block_outside_request"];
  return null;
}

// Truncation = bytes end inside an unterminated string or an unclosed object/array (prefix of a JSON value).
function endsInsideValue(t) {
  let depth = 0;
  let str = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (str) { if (c === "\\") i++; else if (c === '"') str = false; }
    else if (c === '"') str = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth < 0) return false; }
  }
  return str || depth > 0;
}

function verifyCall(call, rc, dir, filter, budget) {
  const reqBuf = readFileNoFollow(path.join(dir, rc.request.file), "receipt_file");
  const respBuf = readFileNoFollow(path.join(dir, rc.response.file), "receipt_file");
  const out = { request: { file: rc.request.file, sha256: rc.request.sha256 }, response: { file: rc.response.file, sha256: rc.response.sha256, bytes: respBuf.length } };
  const done = (status, detail = null, extra = {}) => ({ ...out, status, detail, ...extra });
  if (sha256(reqBuf) !== rc.request.sha256) return done("HASH_MISMATCH", "request");
  if (sha256(respBuf) !== rc.response.sha256) return done("HASH_MISMATCH", "response");
  budget.used += respBuf.length;
  if (budget.used > budget.max) return done("OVER_BUDGET", { cumulativeResponseBytes: budget.used, maxBytes: budget.max });
  let req;
  try { req = strictParse(reqBuf, "request"); } catch (e) { if (e instanceof Refusal) return done("MALFORMED_REQUEST", e.detail); throw e; }
  if (!isObj(req) || canonical(Object.keys(req).sort()) !== '["id","jsonrpc","method","params"]' || req.jsonrpc !== "2.0" || !(Number.isSafeInteger(req.id) || typeof req.id === "string")) return done("MALFORMED_REQUEST", "jsonrpc_shape");
  if (canonical({ method: req.method, params: req.params }) !== canonical(call.request)) return done("FILTER_MISMATCH", "request_not_planned_request");
  let resp;
  try { resp = strictParse(respBuf, "response"); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return done(endsInsideValue(respBuf.toString("utf8")) ? "TRUNCATED_RESPONSE" : "MALFORMED_RESPONSE", e.detail);
  }
  if (!isObj(resp) || resp.jsonrpc !== "2.0" || !Object.keys(resp).every((k) => ["jsonrpc", "id", "result", "error"].includes(k))) return done("MALFORMED_RESPONSE", "jsonrpc_shape");
  if (!Object.hasOwn(resp, "id") || canonical(resp.id) !== canonical(req.id)) return done("ID_MISMATCH", { request: req.id, response: resp.id ?? null });
  const hasR = Object.hasOwn(resp, "result");
  const hasE = Object.hasOwn(resp, "error");
  if (hasR === hasE) return done("MALFORMED_RESPONSE", "result_xor_error");
  if (hasE) return done("RPC_ERROR", { code: Number.isSafeInteger(resp.error?.code) ? resp.error.code : null, message: typeof resp.error?.message === "string" ? resp.error.message.slice(0, 200) : null });
  if (!Array.isArray(resp.result)) return done("MALFORMED_RESPONSE", "result_not_array");
  const logs = [];
  for (const [i, l] of resp.result.entries()) {
    const bad = checkLog(l, filter, call);
    if (bad !== null) return done(bad[0], { resultIndex: i, m: bad[1] });
    const { removed, ...content } = l;
    logs.push({ blockNumber: l.blockNumber, blockHash: l.blockHash, logIndex: l.logIndex, transactionHash: l.transactionHash, transactionIndex: l.transactionIndex, address: l.address, topic0: l.topics[0] ?? null, removed,
      blockTimestamp: Object.hasOwn(l, "blockTimestamp") ? l.blockTimestamp : "ABSENT", contentSha256: sha256(canonical(content)) });
  }
  return done(logs.length === 0 ? "VERIFIED_EMPTY" : "VERIFIED_LOGS", null, { logCount: logs.length, logs });
}

export function verify(specBuf, manifestBuf, planBuf, receiptsBuf, receiptsDir) {
  const spec = strictParse(specBuf, "spec");
  shape(spec, ["schema", "manifest", "plan", "receipts"], "spec");
  if (spec.schema !== INPUT_SCHEMA) refuse("spec_schema_mismatch", { expected: INPUT_SCHEMA });
  shape(spec.manifest, ["fileSha256", "manifestSha256"], "manifest");
  shape(spec.plan, ["fileSha256", "planSha256"], "plan");
  shape(spec.receipts, ["fileSha256"], "receipts");
  for (const [w, v] of [["manifest.fileSha256", spec.manifest.fileSha256], ["manifest.manifestSha256", spec.manifest.manifestSha256], ["plan.fileSha256", spec.plan.fileSha256], ["plan.planSha256", spec.plan.planSha256], ["receipts.fileSha256", spec.receipts.fileSha256]]) hex64(v, w);
  const man = loadManifest(manifestBuf, spec.manifest);
  const plan = loadPlan(planBuf, spec.plan, man);
  const receipts = loadReceipts(receiptsBuf, spec.receipts, plan);
  const byIndex = new Map(receipts.map((r) => [r.callIndex, r]));
  const budget = { used: 0, max: plan.inputs.caps.maxBytes };
  const calls = plan.calls.map((c) => {
    const base = { callIndex: c.index, segment: c.segment, filtersetId: c.filtersetId, fromBlock: c.fromBlock, toBlock: c.toBlock };
    const rc = byIndex.get(c.index);
    if (rc === undefined) return { ...base, status: "MISSING", detail: null };
    return { ...base, ...verifyCall(c, rc, receiptsDir, man.filtersets.find((f) => f.id === c.filtersetId).filter, budget) };
  });
  const ids = new Map();
  const blocks = new Map();
  for (const c of calls) for (const l of c.logs ?? []) {
    const k = `${l.blockHash}/${l.logIndex}`;
    const e = ids.get(k) ?? { content: new Set(), removed: false, calls: new Set() };
    e.content.add(l.contentSha256); if (l.removed) e.removed = true; e.calls.add(c.callIndex); ids.set(k, e);
    const b = blocks.get(l.blockNumber) ?? { hashes: new Set(), calls: new Set() };
    b.hashes.add(l.blockHash); b.calls.add(c.callIndex); blocks.set(l.blockNumber, b);
  }
  const amb = new Map();
  const flag = (set, what, key) => { for (const i of set) { const a = amb.get(i) ?? []; a.push({ what, key }); amb.set(i, a); } };
  for (const [k, e] of ids) { if (e.content.size > 1) flag(e.calls, "IDENTITY_CONTENT_CONFLICT", k); if (e.removed) flag(e.calls, "REMOVED_READD_OBSERVED", k); }
  for (const [n, b] of blocks) if (b.hashes.size > 1) flag(b.calls, "BLOCK_HASH_CONFLICT", n);
  for (const c of calls) {
    const a = amb.get(c.callIndex);
    if (a !== undefined) { c.status = a[0].what; c.detail = { ambiguities: a }; }
  }
  const byStatus = {};
  for (const c of calls) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  const missingCalls = calls.filter((c) => c.status === "MISSING").map((c) => c.callIndex);
  const reasons = [];
  if (plan.status !== "PLANNED") reasons.push(`plan_status_${plan.status}`);
  if (plan.truncated === true) reasons.push("plan_truncated");
  if (missingCalls.length > 0) reasons.push("missing_calls");
  if (calls.some((c) => !["VERIFIED_LOGS", "VERIFIED_EMPTY", "MISSING"].includes(c.status))) reasons.push("calls_not_verified");
  const verdict = reasons.length === 0 ? "ALL_CALLS_RECEIPTED" : "UNKNOWN";
  const provenance = { backfill: true, live: false };
  const body = {
    schema: OUTPUT_SCHEMA,
    verdict,
    reasons,
    contracts: CONTRACTS,
    pins: { specSha256: sha256(specBuf), manifest: { fileSha256: man.fileSha256, manifestSha256: man.manifestSha256 }, plan: { fileSha256: spec.plan.fileSha256, planSha256: plan.planSha256, status: plan.status, truncated: plan.truncated }, receipts: { fileSha256: spec.receipts.fileSha256, count: receipts.length } },
    budget: { maxBytes: budget.max, receiptedResponseBytes: budget.used, plannedCalls: plan.calls.length },
    calls,
    missingCalls,
    counts: byStatus,
    publicationProvenance: provenance,
    resumeLive: { permitted: false, reason: "a receipt verification never grants live resumption; caller hashes and RPC content are unverified against any chain" },
    claims: { binding: "UNKNOWN", canonicality: "UNVERIFIED", sourceAdmission: "NOT_ESTABLISHED", completeness: "NOT_ESTABLISHED", latency: "NOT_MEASURED" },
    policy: { Q1: "UNADOPTED", Q2: "UNADOPTED" },
    notClaimed: "no execution, network, publication, clock or directory scan; ALL_CALLS_RECEIPTED means every planned call has a hash-matching, filter-bound, id-matching, strictly valid receipt, not that the provider returned every log",
  };
  return `${canonical({ ...body, reportSha256: sha256(canonical(body)) })}\n`;
}

function main(argv) {
  const usage = "node verify.mjs --spec <spec.json> --manifest <filter-manifest.json> --plan <backfill-plan.json> --receipts <receipts.json>";
  const names = ["--spec", "--manifest", "--plan", "--receipts"];
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!names.includes(k) || argv[i + 1] === undefined) refuse("usage", { usage });
    if (Object.hasOwn(args, k)) refuse("usage_duplicate_argument", { arg: k });
    args[k] = argv[i + 1];
  }
  if (names.some((n) => args[n] === undefined)) refuse("usage", { usage });
  return verify(readFileNoFollow(args["--spec"], "spec"), readFileNoFollow(args["--manifest"], "manifest"), readFileNoFollow(args["--plan"], "plan"), readFileNoFollow(args["--receipts"], "receipts"), path.dirname(args["--receipts"]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stdout.write(`${canonical({ refused: e.reason, detail: e.detail })}\n`);
    process.exitCode = 2;
  }
}

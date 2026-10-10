#!/usr/bin/env node
// Offline full-coverage filter contract check. Binds a root-declared inclusive block window, caps, the direct/native
// filters actually used and one-clock prerequisites to pinned filter-manifest 42185f2 and backfill plan a345d48.
// Never executes, publishes, reads a clock, the environment or the network, writes, or scans directories.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const CONTRACT_SCHEMA = "full-coverage-filter-contract-input/1";
export const REPORT_SCHEMA = "full-coverage-filter-contract-report/1";
export const PLAN_SCHEMA = "backfill-plan/1";
export const MANIFEST_SCHEMA = "filter-manifest/1";
export const CONTRACTS = Object.freeze({ filterManifest: "jhacksman/FeedEater 42185f2170fb68e5d55b5e8507f480229f58b4df measurements/filter-manifest (filter-manifest/1)", backfillPlan: "jhacksman/FeedEater a345d48a2f003348d3fe21910518ec1e6e54db35 measurements/backfill-plan (backfill-plan/1)", receiptVerifier: "jhacksman/FeedEater 83aec5d72f6712711b5f22ef29777858c5b797e0 measurements/backfill-receipts (backfill-receipt-verification/1)" });
// Lines below up to the "contract" marker are copied verbatim from 83aec5d verify.mjs l.15-153.
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

// ---- contract (new in this candidate) ----
const TOPIC0 = Object.freeze({ Initialize: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", Swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" });
export const LAUNCHED_TOPIC0 = "0x207384e895174175cc774fe7f7457b37c382f27ebf53d37d5257b862f80eaf9c";
export const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
export const FACTORIES = Object.freeze(["0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc", "0x1de58a6769526a03a504d9d59b8757cd8097dc57", "0xa52ad458ce0282a971ecc71c051a32f28946bb9f", "0xb9e5910043353717af54d8dd34b6ee57ffe49c35", "0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64", "0xff70918ef17a2d74d683a8297813b177bafad1f4"]);
export const LANES = Object.freeze({
  poolmanager: { filtersetId: "poolmanager.initialize_swap", filter: { address: [POOL_MANAGER], topics: [[TOPIC0.Swap, TOPIC0.Initialize]] } },
  factories: { filtersetId: "o1.factories.raw_all_topics", filter: { address: [...FACTORIES] } },
});
export const NARROW_LAUNCHED = Object.freeze({ filtersetId: "o1.factories.launched_only (census; distinct recipe 9d7d087)", filter: { address: [...FACTORIES], topics: [LAUNCHED_TOPIC0] } });
const UTC = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$/;
const utc = (v, where) => { const m = typeof v === "string" ? UTC.exec(v) : null; const t = m ? new Date(v) : null; if (!m || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 19) + "Z" !== v) refuse("value_invalid", { where, m: "YYYY-MM-DDTHH:MM:SSZ" }); return v; };
const nullable = (v, where, f) => (v === null ? null : f(v, where));
const label = (v, where) => { if (typeof v !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(v)) refuse("value_invalid", { where, m: "1-128 of [A-Za-z0-9._:-] or null" }); return v; };

export function parseContract(buf) {
  const c = strictParse(buf, "contract");
  shape(c, ["schema", "manifest", "plan", "window", "caps", "lanes", "comparison", "observationClock", "subjects"], "contract");
  if (c.schema !== CONTRACT_SCHEMA) refuse("contract_schema_mismatch", { expected: CONTRACT_SCHEMA });
  shape(c.manifest, ["fileSha256", "manifestSha256"], "manifest"); hex64(c.manifest.fileSha256, "manifest.fileSha256"); hex64(c.manifest.manifestSha256, "manifest.manifestSha256");
  shape(c.plan, ["fileSha256", "planSha256"], "plan"); hex64(c.plan.fileSha256, "plan.fileSha256"); hex64(c.plan.planSha256, "plan.planSha256");
  shape(c.window, ["fromBlock", "toBlock"], "window"); nat(c.window.fromBlock, "window.fromBlock"); nat(c.window.toBlock, "window.toBlock");
  if (c.window.fromBlock > c.window.toBlock) refuse("value_invalid", { where: "window", m: "fromBlock <= toBlock (inclusive)" });
  shape(c.caps, ["plan", "comparison"], "caps");
  shape(c.caps.plan, ["maxCalls", "maxBytes", "maxChunkBlocks", "maxGapBlocks"], "caps.plan"); for (const k of Object.keys(c.caps.plan)) nat(c.caps.plan[k], `caps.plan.${k}`, 1);
  shape(c.caps.comparison, ["maxBytes", "maxRawEvents"], "caps.comparison"); for (const k of Object.keys(c.caps.comparison)) nat(c.caps.comparison[k], `caps.comparison.${k}`, 1);
  shape(c.lanes, ["poolmanager", "factories"], "lanes");
  for (const l of ["poolmanager", "factories"]) { shape(c.lanes[l], ["filterSha256"], `lanes.${l}`); hex64(c.lanes[l].filterSha256, `lanes.${l}.filterSha256`); }
  shape(c.comparison, ["direct", "native"], "comparison");
  for (const side of ["direct", "native"]) { shape(c.comparison[side], ["poolmanager", "factories"], `comparison.${side}`); for (const l of ["poolmanager", "factories"]) { const v = c.comparison[side][l]; if (v !== null && !isObj(v)) refuse("value_invalid", { where: `comparison.${side}.${l}`, m: "filter object or null" }); } }
  shape(c.observationClock, ["clockId", "fromUtc", "toUtc"], "observationClock");
  nullable(c.observationClock.clockId, "observationClock.clockId", label); utc(c.observationClock.fromUtc, "observationClock.fromUtc"); utc(c.observationClock.toUtc, "observationClock.toUtc");
  shape(c.subjects, ["backfill", "live"], "subjects"); nullable(c.subjects.backfill, "subjects.backfill", label); nullable(c.subjects.live, "subjects.live", label);
  return c;
}

// Compare an observed filter (no block range) with a lane's planned filter; every difference is named.
export function filterDiff(obs, lane) {
  const exp = LANES[lane].filter;
  const diffs = [];
  if (!isObj(obs)) return ["filter_not_object"];
  for (const k of Object.keys(obs)) if (k !== "address" && k !== "topics") diffs.push(k === "fromBlock" || k === "toBlock" || k === "blockHash" ? `range_key_in_filter:${k}` : `key_extra:${k}`);
  const addr = Array.isArray(obs.address) ? obs.address : [];
  if (!Array.isArray(obs.address)) diffs.push("address_not_array");
  const seen = new Set();
  for (const a of addr) { if (seen.has(a)) diffs.push(`address_duplicate:${a}`); seen.add(a); if (!exp.address.includes(a)) diffs.push(`address_extra:${a}`); }
  for (const a of exp.address) if (!seen.has(a)) diffs.push(`address_missing:${a}`);
  if (diffs.length === 0 && canonical(addr) !== canonical(exp.address)) diffs.push("address_order");
  if (exp.topics === undefined) { if (Object.hasOwn(obs, "topics")) diffs.push("topics_present_on_all_topics_lane"); }
  else if (!Object.hasOwn(obs, "topics")) diffs.push("topics_missing");
  else if (canonical(obs.topics) !== canonical(exp.topics)) {
    const t0 = Array.isArray(obs.topics) ? obs.topics[0] : undefined;
    const got = Array.isArray(t0) ? t0 : typeof t0 === "string" ? [t0] : [];
    for (const [n, h] of Object.entries(TOPIC0)) if (!got.includes(h)) diffs.push(`topic0_missing:${n}`);
    for (const h of got) if (!Object.values(TOPIC0).includes(h)) diffs.push(`topic0_extra:${h}`);
    if (!Array.isArray(obs.topics) || obs.topics.length !== 1) diffs.push("topics_positions_differ");
    if (diffs.length === 0) diffs.push("topics_encoding_differs");
  }
  return diffs;
}
const classify = (obs, lane, manFilterSha) => {
  if (obs === null) return { status: "UNKNOWN", outcome: "NOT_DECLARED", filterSha256: null, diffs: [] };
  const sha = sha256(canonical(obs));
  if (lane === "factories" && canonical(obs) === canonical(NARROW_LAUNCHED.filter)) return { status: "FAIL", outcome: "NARROW_LAUNCHED_CENSUS_NOT_ALL_TOPICS", filterSha256: sha, diffs: filterDiff(obs, lane) };
  const diffs = filterDiff(obs, lane);
  return diffs.length === 0 && sha === manFilterSha ? { status: "PASS", outcome: "FILTER_EQUAL", filterSha256: sha, diffs } : { status: "FAIL", outcome: "FILTER_MISMATCH", filterSha256: sha, diffs: diffs.length ? diffs : ["filter_sha_differs"] };
};

export function check(contractBuf, manifestBuf, planBuf) {
  const c = parseContract(contractBuf);
  const man = loadManifest(manifestBuf, c.manifest);
  const raw = strictParse(manifestBuf, "manifest");
  const plan = loadPlan(planBuf, c.plan, man);
  const checks = [];
  const add = (id, status, detail = {}) => checks.push({ ...detail, id, status });
  // 1. manifest lanes: exactly PoolManager Initialize/Swap OR + six factories all-topics, nothing else
  const ids = man.filtersets.map((f) => f.id);
  add("manifest.filtersets_exactly_two_lanes", canonical(ids) === canonical([LANES.poolmanager.filtersetId, LANES.factories.filtersetId]) ? "PASS" : "FAIL", { ids });
  const fsFor = (l) => man.filtersets.find((f) => f.id === LANES[l].filtersetId) ?? null;
  for (const l of ["poolmanager", "factories"]) {
    const f = fsFor(l);
    const diffs = f === null ? ["lane_absent"] : filterDiff(f.filter, l);
    add(`manifest.${l}_filter`, diffs.length === 0 ? "PASS" : "FAIL", { diffs });
  }
  const rawFac = Array.isArray(raw.filtersets) ? raw.filtersets.find((f) => f?.id === LANES.factories.filtersetId) : undefined;
  const rows = Array.isArray(rawFac?.rows) ? rawFac.rows.map((r) => r?.address) : [];
  const rowsOk = rows.length === 6 && new Set(rows).size === 6 && canonical([...rows].sort()) === canonical(FACTORIES);
  add("manifest.factory_rows_six_each_once", rowsOk ? "PASS" : "FAIL", { rowCount: rows.length, distinct: new Set(rows).size });
  add("manifest.no_fixed_pool_list", man.filtersets.every((f) => f.id === LANES.poolmanager.filtersetId ? canonical(f.filter.address) === canonical([POOL_MANAGER]) : f.filter.address.every((a) => FACTORIES.includes(a))) ? "PASS" : "FAIL");
  // 2. lane pins
  for (const l of ["poolmanager", "factories"]) { const f = fsFor(l); add(`lanes.${l}_pin`, f !== null && f.filterSha256 === c.lanes[l].filterSha256 ? "PASS" : "FAIL", { contract: c.lanes[l].filterSha256, manifest: f?.filterSha256 ?? null }); }
  // 3. plan state, window coverage per lane, provenance
  add("plan.planned_untruncated", plan.status === "PLANNED" && plan.truncated === false ? "PASS" : "UNKNOWN", { planStatus: plan.status, truncated: plan.truncated });
  for (const l of ["poolmanager", "factories"]) {
    const calls = plan.calls.filter((x) => x.filtersetId === LANES[l].filtersetId).sort((a, b) => a.fromBlock - b.fromBlock);
    let firstGap = null;
    for (let i = 1; i < calls.length && firstGap === null; i++) if (calls[i].fromBlock !== calls[i - 1].toBlock + 1) firstGap = { afterBlock: calls[i - 1].toBlock, nextFromBlock: calls[i].fromBlock };
    const covered = calls.length === 0 ? null : { fromBlock: calls[0].fromBlock, toBlock: calls[calls.length - 1].toBlock };
    const ok = covered !== null && firstGap === null && covered.fromBlock === c.window.fromBlock && covered.toBlock === c.window.toBlock;
    add(`plan.${l}_covers_window_exactly`, ok ? "PASS" : "FAIL", { window: c.window, covered, firstGap, calls: calls.length });
  }
  const provOk = plan.publicationProvenance?.backfill === true && plan.publicationProvenance?.live === false && plan.calls.every((x) => x.publicationProvenance?.backfill === true && x.publicationProvenance?.live === false)
    && plan.backfillSubject?.class === "backfill" && plan.backfillSubject?.mustDifferFromLiveSubject === true && plan.resumeLive?.allowed === false;
  add("plan.backfill_only_provenance", provOk ? "PASS" : "FAIL");
  // 4. caps
  const pc = plan.inputs.caps; const mc = raw.comparison?.caps ?? {};
  add("caps.plan_equal", canonical(c.caps.plan) === canonical({ maxCalls: pc.maxCalls, maxBytes: pc.maxBytes, maxChunkBlocks: pc.maxChunkBlocks, maxGapBlocks: pc.maxGapBlocks }) ? "PASS" : "FAIL", { plan: { maxCalls: pc.maxCalls, maxBytes: pc.maxBytes, maxChunkBlocks: pc.maxChunkBlocks, maxGapBlocks: pc.maxGapBlocks } });
  add("caps.comparison_equal", canonical(c.caps.comparison) === canonical({ maxBytes: mc.maxBytes, maxRawEvents: mc.maxRawEvents }) ? "PASS" : "FAIL", { manifest: { maxBytes: mc.maxBytes ?? null, maxRawEvents: mc.maxRawEvents ?? null } });
  // 5. direct/native filters actually used
  const cmp = {};
  for (const side of ["direct", "native"]) for (const l of ["poolmanager", "factories"]) {
    const r = classify(c.comparison[side][l], l, fsFor(l)?.filterSha256 ?? null);
    cmp[`${side}.${l}`] = r;
    add(`comparison.${side}.${l}`, r.status, { outcome: r.outcome, filterSha256: r.filterSha256, diffs: r.diffs });
  }
  for (const l of ["poolmanager", "factories"]) {
    const d = c.comparison.direct[l], n = c.comparison.native[l];
    add(`comparison.direct_native_equal.${l}`, d === null || n === null ? "UNKNOWN" : canonical(d) === canonical(n) && cmp[`direct.${l}`].status === "PASS" ? "PASS" : "FAIL");
  }
  // 6. one-clock observation window prerequisites
  const mw = raw.comparison?.window ?? {};
  add("clock.window_equals_manifest", c.observationClock.fromUtc === mw.fromUtc && c.observationClock.toUtc === mw.toUtc && c.observationClock.fromUtc < c.observationClock.toUtc ? "PASS" : "FAIL", { manifest: { fromUtc: mw.fromUtc ?? null, toUtc: mw.toUtc ?? null } });
  add("clock.one_clock_declared", c.observationClock.clockId === null ? "UNKNOWN" : "PASS", { verification: "UNVERIFIED_CALLER_DECLARED; no clock read or implemented here" });
  // 7. historical/backfill subject distinct from live
  const s = c.subjects;
  add("subjects.backfill_distinct_from_live", s.backfill === null || s.live === null ? "UNKNOWN" : s.backfill === s.live ? "FAIL" : "PASS", { backfill: s.backfill, live: s.live });
  const verdict = checks.some((x) => x.status === "FAIL") ? "FAIL" : checks.some((x) => x.status === "UNKNOWN") ? "UNKNOWN" : "CONTRACT_CONSISTENT";
  const missing = [];
  for (const side of ["direct", "native"]) for (const l of ["poolmanager", "factories"]) if (c.comparison[side][l] === null) missing.push(`comparison.${side}.${l}`);
  if (c.observationClock.clockId === null) missing.push("observationClock.clockId");
  if (s.backfill === null) missing.push("subjects.backfill");
  if (s.live === null) missing.push("subjects.live");
  const body = {
    schema: REPORT_SCHEMA, contracts: CONTRACTS,
    pins: { manifest: { fileSha256: man.fileSha256, manifestSha256: man.manifestSha256 }, plan: { fileSha256: c.plan.fileSha256, planSha256: plan.planSha256 } },
    window: { ...c.window, inclusive: true },
    lanes: Object.fromEntries(["poolmanager", "factories"].map((l) => [l, { filtersetId: LANES[l].filtersetId, filter: LANES[l].filter, filterSha256: fsFor(l)?.filterSha256 ?? null }])),
    narrowCensus: { filtersetId: NARROW_LAUNCHED.filtersetId, filter: NARROW_LAUNCHED.filter, filterSha256: sha256(canonical(NARROW_LAUNCHED.filter)), relation: "NOT_ALL_TOPICS: never a substitute for o1.factories.raw_all_topics" },
    checks, verdict, rootInputsMissing: missing,
    publicationProvenance: { backfill: true, live: false }, resumeLive: { permitted: false },
    claims: { sourceAdmission: "NOT_ESTABLISHED", completeness: "NOT_MEASURED", delivery: "NOT_MEASURED", latency: "NOT_MEASURED", oneClock: "NOT_ESTABLISHED", binding: "UNKNOWN", q1: "UNADOPTED", q2: "UNADOPTED" },
    notClaimed: "contract consistency only: no request, receipt, node, clock or network; CONTRACT_CONSISTENT is not coverage, completeness, latency or admission",
  };
  return { ...body, reportSha256: sha256(canonical(body)) };
}

function main(argv) {
  const want = ["--contract", "--manifest", "--plan"];
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!want.includes(k)) refuse("cli_unknown_argument", { arg: k });
    if (Object.hasOwn(a, k)) refuse("cli_duplicate_argument", { arg: k });
    if (typeof v !== "string" || v.startsWith("--")) refuse("cli_missing_value", { arg: k });
    a[k] = v;
  }
  const miss = want.filter((k) => !Object.hasOwn(a, k));
  if (miss.length) refuse("cli_missing_argument", { missing: miss });
  return check(readFileNoFollow(a["--contract"], "contract"), readFileNoFollow(a["--manifest"], "manifest"), readFileNoFollow(a["--plan"], "plan"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { process.stdout.write(`${canonical(main(process.argv.slice(2)))}\n`); }
  catch (e) {
    if (e instanceof Refusal) { process.stdout.write(`${canonical({ refused: e.reason, detail: e.detail })}\n`); process.exitCode = 2; }
    else { process.stdout.write(`${canonical({ refused: "internal_error", detail: { m: String(e?.message ?? e) } })}\n`); process.exitCode = 4; }
  }
}

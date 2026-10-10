#!/usr/bin/env node
// Offline durable reconnect/backfill PLAN primitive. Reads one caller spec and one pinned filter manifest; emits an
// inert, capped eth_getLogs plan on stdout. Never executes, publishes, reads a clock, or touches the network. See README.md.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const INPUT_SCHEMA = "backfill-plan-input/1";
export const OUTPUT_SCHEMA = "backfill-plan/1";
export const MANIFEST_SCHEMA = "filter-manifest/1";
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
const SRCID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

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
function utc(s, where) {
  const m = typeof s === "string" ? TS.exec(s) : null;
  if (m === null) refuse("value_invalid", { where, m: "YYYY-MM-DDTHH:MM:SSZ" });
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== se) refuse("value_invalid", { where, m: "calendar" });
  return ms;
}
function source(o, where) {
  shape(o, ["chainId", "sourceId"], where);
  nat(o.chainId, `${where}.chainId`, 1);
  if (typeof o.sourceId !== "string" || !SRCID.test(o.sourceId)) refuse("value_invalid", { where: `${where}.sourceId`, m: "[a-z0-9][a-z0-9._:-]{0,127}" });
  return o;
}

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

export function validateSpec(spec) {
  shape(spec, ["schema", "manifest", "source", "checkpoint", "head", "evidence", "lookbackBlocks", "caps"], "spec");
  if (spec.schema !== INPUT_SCHEMA) refuse("spec_schema_mismatch", { expected: INPUT_SCHEMA });
  shape(spec.manifest, ["fileSha256", "manifestSha256"], "manifest");
  for (const k of ["fileSha256", "manifestSha256"]) if (typeof spec.manifest[k] !== "string" || !SHA.test(spec.manifest[k])) refuse("value_invalid", { where: `manifest.${k}`, m: "64 lowercase hex" });
  source(spec.source, "source");
  shape(spec.checkpoint, ["source", "manifestSha256", "blockNumber", "blockHash", "recordedAtUtc"], "checkpoint");
  source(spec.checkpoint.source, "checkpoint.source");
  if (typeof spec.checkpoint.manifestSha256 !== "string" || !SHA.test(spec.checkpoint.manifestSha256)) refuse("value_invalid", { where: "checkpoint.manifestSha256" });
  nat(spec.checkpoint.blockNumber, "checkpoint.blockNumber", 0, MAX_BLOCK);
  hash32(spec.checkpoint.blockHash, "checkpoint.blockHash");
  const recAt = utc(spec.checkpoint.recordedAtUtc, "checkpoint.recordedAtUtc");
  shape(spec.head, ["source", "blockNumber", "blockHash", "observedAtUtc"], "head");
  source(spec.head.source, "head.source");
  nat(spec.head.blockNumber, "head.blockNumber", 0, MAX_BLOCK);
  hash32(spec.head.blockHash, "head.blockHash");
  const obsAt = utc(spec.head.observedAtUtc, "head.observedAtUtc");
  shape(spec.evidence, ["checkpointBlockHashAtHead", "removedLogsSeen"], "evidence");
  if (spec.evidence.checkpointBlockHashAtHead !== null) hash32(spec.evidence.checkpointBlockHashAtHead, "evidence.checkpointBlockHashAtHead");
  if (![true, false, null].includes(spec.evidence.removedLogsSeen)) refuse("value_invalid", { where: "evidence.removedLogsSeen", m: "true | false | null" });
  shape(spec.caps, ["maxGapBlocks", "maxChunkBlocks", "maxCalls", "maxBytes"], "caps");
  for (const k of ["maxGapBlocks", "maxChunkBlocks", "maxCalls", "maxBytes"]) nat(spec.caps[k], `caps.${k}`, 1, k === "maxCalls" ? MAX_CALLS_CEILING : Number.MAX_SAFE_INTEGER);
  nat(spec.lookbackBlocks, "lookbackBlocks", 1);
  if (spec.lookbackBlocks > spec.caps.maxGapBlocks) refuse("value_invalid", { where: "lookbackBlocks", m: "must be <= caps.maxGapBlocks" });
  const same = (a, b) => a.chainId === b.chainId && a.sourceId === b.sourceId;
  if (spec.checkpoint.source.chainId !== spec.source.chainId || spec.head.source.chainId !== spec.source.chainId) refuse("chain_mismatch", { source: spec.source.chainId, checkpoint: spec.checkpoint.source.chainId, head: spec.head.source.chainId });
  if (!same(spec.checkpoint.source, spec.source)) refuse("checkpoint_source_mismatch", {});
  if (!same(spec.head.source, spec.source)) refuse("head_source_mismatch", {});
  if (spec.checkpoint.manifestSha256 !== spec.manifest.manifestSha256) refuse("checkpoint_filter_identity_mismatch", { checkpoint: spec.checkpoint.manifestSha256, spec: spec.manifest.manifestSha256 });
  return { recAt, obsAt };
}

export const MAX_BLOCK = Number.MAX_SAFE_INTEGER - 1;
export const MAX_CALLS_CEILING = 10000;
const q = (n) => `0x${n.toString(16)}`;
const ceilDiv = (a, b) => (a + b - 1n) / b;

export const RULES = Object.freeze({
  overlap: "re-read [max(0, C-L+1), C]: L = operator-declared lookbackBlocks (>=1, <= maxGapBlocks); the checkpoint block itself is always re-read",
  gap: "read [C+1, H] only when 1 <= H-C <= maxGapBlocks; H-C = 0 plans the overlap only; H-C > maxGapBlocks plans nothing (GAP_EXCEEDS_CAP)",
  chunking: "each segment split ascending into ranges of <= maxChunkBlocks blocks; overlap before gap; every filterset per range in manifest order; one call per (range, filterset); range and call counts are computed arithmetically and only emitted calls are generated",
  budget: "if calls > maxCalls emit only the first maxCalls calls (TRUNCATED_CALL_BUDGET) and state the first uncovered (range, filterset) and the uncovered block range; maxBytes is an executor stop limit (no volume estimate)",
  integers: "block numbers <= 2^53-2 so C+1 and H+1 are exact; caps are safe integers >= 1; maxCalls <= 10000 bounds the output; counts are exact decimal strings (BigInt)",
  reconciliation: "UNKNOWN_NEEDS_RECONCILIATION (no ranges) when: checkpointBlockHashAtHead null or != checkpoint.blockHash; removedLogsSeen true or null; H < C; H == C with a different hash; head observed before the checkpoint was recorded",
  historyLimit: "nothing below max(0, C-L+1) is ever requested; reorgs deeper than L, provider log-history retention and pruning are not detectable here; an executor that cannot serve a range must report UNKNOWN, never empty",
  resumeLive: "live may resume at H+1 only after every planned call completed within maxBytes and canonicality was re-verified by the executor; this plan proves neither",
});

export function plan(specBuf, manifestBuf) {
  const spec = strictParse(specBuf, "spec");
  const { recAt, obsAt } = validateSpec(spec);
  const man = loadManifest(manifestBuf, spec.manifest);
  const C = spec.checkpoint.blockNumber;
  const H = spec.head.blockNumber;
  const L = spec.lookbackBlocks;
  const caps = spec.caps;
  const reasons = [];
  const ev = spec.evidence;
  if (ev.checkpointBlockHashAtHead === null) reasons.push("checkpoint_hash_evidence_missing");
  else if (ev.checkpointBlockHashAtHead !== spec.checkpoint.blockHash) reasons.push("checkpoint_hash_conflict");
  if (ev.removedLogsSeen === null) reasons.push("removed_logs_evidence_missing");
  else if (ev.removedLogsSeen === true) reasons.push("removed_readd_ambiguity");
  if (H < C) reasons.push("head_below_checkpoint");
  if (H === C && spec.head.blockHash !== spec.checkpoint.blockHash) reasons.push("head_hash_conflict_at_checkpoint_height");
  if (obsAt < recAt) reasons.push("head_observed_before_checkpoint_recorded");
  const bC = BigInt(C);
  const bH = BigInt(H);
  const chunk = BigInt(caps.maxChunkBlocks);
  const F = BigInt(man.filtersets.length);
  const gap = bH - bC;
  const overlapFrom = bC - BigInt(L) + 1n < 0n ? 0n : bC - BigInt(L) + 1n;
  let status;
  let oR = 0n;
  let gR = 0n;
  if (reasons.length > 0) status = "UNKNOWN_NEEDS_RECONCILIATION";
  else if (gap > BigInt(caps.maxGapBlocks)) { status = "GAP_EXCEEDS_CAP"; reasons.push("gap_exceeds_maxGapBlocks"); }
  else {
    oR = ceilDiv(bC - overlapFrom + 1n, chunk);
    gR = gap > 0n ? ceilDiv(gap, chunk) : 0n;
    status = "PLANNED";
  }
  const total = (oR + gR) * F;
  const n = total < BigInt(caps.maxCalls) ? total : BigInt(caps.maxCalls);
  const seg = (segment, a, to) => ({ segment, fromBlock: a, toBlock: a + chunk - 1n < to ? a + chunk - 1n : to });
  const rangeAt = (r) => (r < oR ? seg("overlap", overlapFrom + r * chunk, bC) : seg("gap", bC + 1n + (r - oR) * chunk, bH));
  const provenance = { backfill: true, live: false };
  const calls = [];
  for (let x = 0n; x < n; x++) {
    const r = rangeAt(x / F);
    const f = man.filtersets[Number(x % F)];
    calls.push({ index: Number(x), segment: r.segment, filtersetId: f.id, filterSha256: f.filterSha256, fromBlock: Number(r.fromBlock), toBlock: Number(r.toBlock),
      request: { method: "eth_getLogs", params: [{ ...f.filter, fromBlock: q(r.fromBlock), toBlock: q(r.toBlock) }] }, publicationProvenance: provenance });
  }
  const truncated = total > n;
  let uncovered = null;
  if (truncated) {
    const r = rangeAt(n / F);
    uncovered = { fromBlock: Number(r.fromBlock), toBlock: Number(gap > 0n ? bH : bC), firstUncoveredFilterset: man.filtersets[Number(n % F)].id, firstUncoveredRange: { segment: r.segment, fromBlock: Number(r.fromBlock), toBlock: Number(r.toBlock) } };
    status = "TRUNCATED_CALL_BUDGET";
    reasons.push("calls_exceed_maxCalls");
  }
  const planned = status === "PLANNED" || status === "TRUNCATED_CALL_BUDGET";
  const body = {
    schema: OUTPUT_SCHEMA,
    status,
    reasons,
    inert: "plan only: no call was executed, nothing was published, no network or clock was used",
    inputs: {
      specSha256: sha256(specBuf),
      manifest: { fileSha256: man.fileSha256, manifestSha256: man.manifestSha256, filtersets: man.filtersets.map((f) => ({ id: f.id, filterSha256: f.filterSha256 })) },
      source: spec.source,
      checkpoint: spec.checkpoint,
      head: { ...spec.head, verification: "UNVERIFIED_CALLER_SUPPLIED" },
      evidence: { ...ev, verification: "UNVERIFIED_CALLER_SUPPLIED" },
      lookbackBlocks: L,
      caps,
    },
    rules: RULES,
    span: planned ? { overlap: { fromBlock: Number(overlapFrom), toBlock: C, clippedAtGenesis: C - L + 1 < 0 }, gap: gap > 0n ? { fromBlock: C + 1, toBlock: H, blocks: Number(gap) } : null, nonAdvancingHead: gap === 0n } : null,
    calls,
    callCount: calls.length,
    rangesBeforeBudget: { overlap: oR.toString(), gap: gR.toString() },
    plannedCallsBeforeBudget: total.toString(),
    truncated,
    uncovered,
    executorStopLimits: { maxBytes: caps.maxBytes, onExceed: "stop; plan outcome UNKNOWN" },
    backfillSubject: { class: "backfill", name: "UNADOPTED (owner-assigned)", mustDifferFromLiveSubject: true, publicationProvenance: provenance },
    publicationProvenance: provenance,
    resumeLive: { allowed: false, candidateFromBlock: status === "PLANNED" ? H + 1 : null, condition: RULES.resumeLive },
    claims: { binding: "UNKNOWN", canonicality: "UNVERIFIED_CALLER_SUPPLIED", sourceAdmission: "NOT_ESTABLISHED", completeness: "NOT_MEASURED", latency: "NOT_MEASURED" },
    notClaimed: "no execution, publication, network, T7 or clock; no canonicality, completeness, delivery, latency or admission evidence; Q1/Q2 unresolved, no dedup/identity policy chosen",
  };
  return `${canonical({ ...body, planSha256: sha256(canonical(body)) })}\n`;
}

function main(argv) {
  const usage = "node plan.mjs --spec <spec.json> --manifest <filter-manifest.json>";
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!["--spec", "--manifest"].includes(k) || argv[i + 1] === undefined) refuse("usage", { usage });
    if (Object.hasOwn(args, k)) refuse("usage_duplicate_argument", { arg: k });
    args[k] = argv[i + 1];
  }
  if (args["--spec"] === undefined || args["--manifest"] === undefined) refuse("usage", { usage });
  return plan(readFileNoFollow(args["--spec"], "spec"), readFileNoFollow(args["--manifest"], "manifest"));
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

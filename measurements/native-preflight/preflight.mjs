#!/usr/bin/env node
// Offline native-run preflight validator. Reads one operator-supplied JSON file; no network, no processes, no clock.
import fs from "node:fs";

const NOTE =
  "READY means every prerequisite is bound to a reviewed registry entry or owner record built into this validator and the operator-supplied values are consistent. It is not DAT-SRC-011 admission, performance or latency evidence, validates no run outcome, and says nothing about Aromer processing unless claimScope includes aromer_measurement.";

// Reviewed, immutable bindings. Changing these requires a reviewed commit to this file; input cannot extend them.
// Empty: no reviewed corrected collector, native path, reference subscriber or Tier-0 writer exists (2026-10-10).
export const REVIEWED = Object.freeze({ collector: [], nativePath: [], reference: [], rawWriter: [] });
// Owner records for unresolved spec questions (audit b9dd122 D2/P3; proposal 861bb80 Q1/Q2). None recorded.
export const OWNER_RECORDS = Object.freeze({ Q1: null, Q2: null });
const SPEC_Q = {
  Q1: "raw_ref/t_ingest unavailable at publish (DAT-PRV-001/003) vs DAT-PRV-002 every record, 0 missing",
  Q2: "natural key: LAT-006 (chainId, blockHash, txHash, logIndex) vs DAT-IDN-012/I-1 (chain_id, block_hash, log_index)",
};
const DENIED = {
  "5206f9035ad1c057d78990b294941221e936f895": { roles: ["collector", "nativePath", "reference"], why: "frozen #173 with M1, M2, provenance, caps recorded (audit b9dd122); not a native path" },
  "54ba98a98bce1eb307852861deb394ef196638ae": { roles: ["collector", "nativePath", "reference"], why: "joint guard: fake-loopback only, unwired" },
  "56fde238e85ac34268d958578bed291802ed99f7": { roles: ["collector", "nativePath", "reference"], why: "FeedEater 56fde238 Base-module output is never a source of record (DAT-SRC-011)" },
  "d7719e533f170222bbe3a8548090e8c9e579d42b": { roles: ["collector", "nativePath", "reference", "rawWriter"], why: "audit rev 1, docs only" },
  "419346d7f774118b66cb786397ea015709280345": { roles: ["collector", "nativePath", "reference", "rawWriter"], why: "audit rev 2, docs only" },
  "b9dd1228e97ff39340f002442ce3460ef41ee9d0": { roles: ["collector", "nativePath", "reference", "rawWriter"], why: "audit rev 3, docs only" },
  "1c519811df3e2a624b45b9e4e95facd77a840a1f": { roles: ["collector", "nativePath", "reference", "rawWriter"], why: "owner proposal, docs only" },
  "861bb80f821c7110f7bf4178f77b454d0d8fbbb7": { roles: ["collector", "nativePath", "reference", "rawWriter"], why: "owner proposal correction 1, docs only" },
};
const PM = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const T_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const T_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const FACTORIES = [
  "0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc", "0x1de58a6769526a03a504d9d59b8757cd8097dc57", "0xa52ad458ce0282a971ecc71c051a32f28946bb9f",
  "0xb9e5910043353717af54d8dd34b6ee57ffe49c35", "0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64", "0xff70918ef17a2d74d683a8297813b177bafad1f4",
];
export const CANONICAL_FILTERS = [{ address: [PM], topics: [[T_INIT, T_SWAP]] }, { address: FACTORIES }];

// Outcome key families: a normalized key (lowercase alphanumerics) containing any family is refused at any depth.
export const FORBIDDEN_FAMILIES = ["result", "outcome", "latency", "p50", "p90", "p95", "p99", "p999", "datsrc011", "admission", "admit", "performance", "pass", "success", "verdict", "ready", "score"];
// Values that only exist after a Tier-0 append (spec:Q1): refused at any depth under any alias.
export const DEFERRED_FAMILIES = ["rawref", "tingest"];
const SELF_ATTEST = new Set(["reviewed", "reviewedpins", "registry", "ownerrecord", "ownerrecords", "ownerdecision", "waiver", "waived"]);
const CAPTURE = ["live_ws", "live_poll", "repair", "backfill_node", "backfill_thirdparty", "manual", "sealed_capture"];
const DEFECTS = ["M1", "M2", "provenance", "inSourceCaps", "jointIntegration"];
const SCOPES = ["native_collector_run", "aromer_measurement"];
const INT64_MAX = 9223372036854775807n;
const MIN_WINDOW_NS = 3_600_000_000_000n;
const MAX_WINDOW_NS = 86_400_000_000_000n;
const MAX_AGE_S = 10;
const MAX_EVIDENCE_AGE_S = 600;
const BLOCK_S = 2;
const HEAD_TOL = 3;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SENT = /^(|unknown|tbd|todo|fixme|\?+|n\/a|na|none|null|nil|pending|placeholder|unresolved|unset|dummy|example|xxx+|-+)$/;
const SENT_WORD = /\b(unknown|pending|placeholder|tbd|todo|fixme|unresolved|dummy)\b/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const normKey = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const placeholderHex = (s) => typeof s === "string" && /^(.)\1+$/.test(s);
const absent = (v) =>
  v === undefined || v === null || (typeof v === "string" && (SENT.test(v.trim().toLowerCase()) || SENT_WORD.test(v) || placeholderHex(v)));
const canon = (v) =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const finNonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const sortedFilters = (fs) =>
  fs.map((f) => ({ ...f, address: [...f.address].sort(), ...(f.topics ? { topics: f.topics.map((t) => (Array.isArray(t) ? [...t].sort() : t)) } : {}) }))
    .sort((a, b) => (canon(a) < canon(b) ? -1 : 1));

// Strict calendar-valid ISO-8601 UTC (Z), years 2020-2100. Returns epoch ms or null.
export function parseUtc(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(s);
  if (m === null) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  const frac = m[7] === undefined ? 0 : Number(`0.${m[7]}`) * 1000;
  return Number.isFinite(ms + frac) ? ms + frac : null;
}

function grade(id, fn) {
  const miss = [];
  const bad = [];
  fn({ miss: (x) => miss.push(x), bad: (x) => bad.push(x) });
  return { id, status: bad.length > 0 ? "invalid" : miss.length > 0 ? "missing" : "known", detail: [...bad, ...miss] };
}

function scanKeys(v, path, forb, self, deferred) {
  if (Array.isArray(v)) v.forEach((x, i) => scanKeys(x, `${path}[${i}]`, forb, self, deferred));
  else if (isObj(v)) for (const k of Object.keys(v)) {
    const n = normKey(k);
    if (FORBIDDEN_FAMILIES.some((f) => n.includes(f))) forb.push(`${path}.${k}`);
    if (SELF_ATTEST.has(n)) self.push(`${path}.${k}`);
    if (DEFERRED_FAMILIES.some((f) => n.includes(f))) deferred.push(`${path}.${k}`);
    scanKeys(v[k], `${path}.${k}`, forb, self, deferred);
  }
}

export function refusal(input) {
  if (!isObj(input) || input.schema !== "native-preflight-input/2") return 'schema must be "native-preflight-input/2"';
  const forb = [];
  const self = [];
  const deferred = [];
  scanKeys(input, "$", forb, self, deferred);
  if (forb.length > 0) return `run outcomes are not preflight input: ${forb.join(", ")}`;
  if (self.length > 0) return `self-attested registry/owner records are not accepted from input: ${self.join(", ")}`;
  if (deferred.length > 0) return `raw_ref/t_ingest cannot be pre-supplied (exist only after a Tier-0 append; spec:Q1 unresolved): ${deferred.join(", ")}`;
  return null;
}

function reviewedEntry(registry, role, commit) {
  return (registry[role] ?? []).find((e) => e.commit === commit);
}

function pinCheck(c, registry, role, p) {
  if (!isObj(p)) return c.miss(`${role}: pin absent`);
  for (const [k, re] of [["commit", HEX40], ["tree", HEX40], ["manifestSha256", HEX64]]) {
    if (absent(p[k])) c.miss(`${role}.${k} absent or placeholder`);
    else if (typeof p[k] !== "string" || !re.test(p[k])) c.bad(`${role}.${k} malformed`);
  }
  if (typeof p.commit !== "string" || !HEX40.test(p.commit)) return;
  const d = DENIED[p.commit];
  if (d !== undefined && d.roles.includes(role)) return c.bad(`${role}.commit ${p.commit.slice(0, 7)} denied: ${d.why}`);
  const e = reviewedEntry(registry, role, p.commit);
  if (e === undefined) return c.miss(`${role}.commit ${p.commit.slice(0, 7)} is not a reviewed ${role} pin (registry has ${(registry[role] ?? []).length})`);
  if (e.tree !== p.tree) c.bad(`${role}.tree does not match the reviewed binding`);
  if (e.manifestSha256 !== p.manifestSha256) c.bad(`${role}.manifestSha256 does not match the reviewed binding`);
}

function filterArm(c, arm, f) {
  if (!isObj(f)) return c.miss(`${arm}: filters absent`);
  if (absent(f.digest)) c.miss(`${arm}.digest absent`);
  else if (typeof f.digest !== "string" || !HEX64.test(f.digest)) c.bad(`${arm}.digest malformed`);
  if (!Array.isArray(f.filters) || f.filters.length === 0) return c.miss(`${arm}.filters absent or empty`);
  const shapeOk = f.filters.every((x) => isObj(x) && Array.isArray(x.address) && x.address.every((a) => typeof a === "string") &&
    (x.topics === undefined || (Array.isArray(x.topics) && x.topics.every((t) => (Array.isArray(t) ? t.every((a) => typeof a === "string") : typeof t === "string")))) &&
    Object.keys(x).every((k) => k === "address" || k === "topics"));
  if (!shapeOk) return c.bad(`${arm}.filters malformed (only address/topics arrays of strings; no null wildcards)`);
  if (canon(sortedFilters(f.filters)) !== canon(sortedFilters(CANONICAL_FILTERS)))
    c.bad(`${arm}.filters are not the canonical PoolManager Initialize/Swap + six-factory coverage`);
}

export function validate(input, opts = {}) {
  const registry = opts.registry ?? REVIEWED;
  const owner = opts.ownerRecords ?? OWNER_RECORDS;
  const P = [];
  const pins = isObj(input.pins) ? input.pins : {};
  const collectorPin = pins.collector?.commit;
  const nativePin = pins.nativePath?.commit;
  const asOf = parseUtc(input.asOfUtc);
  const scope = Array.isArray(input.claimScope) ? input.claimScope : [];

  P.push(grade("claimScope", (c) => {
    if (!Array.isArray(input.claimScope) || input.claimScope.length === 0) return c.miss("claimScope absent");
    for (const s of input.claimScope) if (!SCOPES.includes(s)) c.bad(`claimScope ${JSON.stringify(s)} not in ${SCOPES.join("|")}`);
    if (!input.claimScope.includes("native_collector_run")) c.bad("claimScope must include native_collector_run");
  }));

  P.push(grade("pins", (c) => { for (const r of ["collector", "nativePath", "reference"]) pinCheck(c, registry, r, pins[r]); }));

  P.push(grade("filters", (c) => {
    const f = isObj(input.filters) ? input.filters : {};
    filterArm(c, "collector", f.collector);
    filterArm(c, "reference", f.reference);
    if (isObj(f.collector) && isObj(f.reference) && f.collector.digest !== f.reference.digest) c.bad("collector and reference digests differ");
  }));

  P.push(grade("window", (c) => {
    const w = isObj(input.window) ? input.window : {};
    for (const arm of ["collector", "reference"]) {
      const x = w[arm];
      if (!isObj(x)) { c.miss(`${arm}: window absent`); continue; }
      let ok = true;
      for (const k of ["startNs", "endNs"]) {
        if (absent(x[k])) { c.miss(`${arm}.${k} absent`); ok = false; }
        else if (typeof x[k] !== "string" || !DEC.test(x[k]) || BigInt(x[k]) > INT64_MAX) { c.bad(`${arm}.${k} must be a decimal int64-ns string`); ok = false; }
      }
      if (x.clock !== "mono_ns") c.bad(`${arm}.clock must be "mono_ns"`);
      if (ok) {
        const dur = BigInt(x.endNs) - BigInt(x.startNs);
        if (dur < MIN_WINDOW_NS || dur > MAX_WINDOW_NS) c.bad(`${arm}: window ${dur} ns outside [60 min, 24 h]`);
      }
    }
    if (isObj(w.collector) && isObj(w.reference) && (w.collector.startNs !== w.reference.startNs || w.collector.endNs !== w.reference.endNs)) c.bad("collector and reference windows differ");
  }));

  P.push(grade("clock", (c) => {
    const k = isObj(input.clock) ? input.clock : {};
    for (const arm of ["collector", "reference"]) {
      const x = k[arm];
      if (!isObj(x)) { c.miss(`${arm}: clock binding absent`); continue; }
      if (absent(x.host_id)) c.miss(`${arm}.host_id absent`);
      if (absent(x.boot_id)) c.miss(`${arm}.boot_id absent`);
      else if (!UUID.test(String(x.boot_id))) c.bad(`${arm}.boot_id not a lowercase uuid`);
      if (x.unit !== "ns") c.bad(`${arm}.unit must be "ns" (int64)`);
      if (x.clock_uncert_ms === undefined || x.clock_uncert_ms === null || absent(x.clock_uncert_ms)) c.miss(`${arm}.clock_uncert_ms absent (measured value required)`);
      else if (!finNonNeg(x.clock_uncert_ms) || x.clock_uncert_ms > 1000) c.bad(`${arm}.clock_uncert_ms invalid`);
      else if (x.clock_uncert_ms === 0) c.miss(`${arm}.clock_uncert_ms 0 is not a measurement (unknown)`);
      const ev = x.clock_uncert_evidence;
      if (!isObj(ev) || absent(ev.method) || absent(ev.ref)) c.miss(`${arm}.clock_uncert_evidence {method, ref} absent: uncertainty unsubstantiated`);
    }
    if (isObj(k.collector) && isObj(k.reference)) {
      if (k.collector.host_id !== k.reference.host_id) c.bad("arms on different host_id");
      if (k.collector.boot_id !== k.reference.boot_id) c.bad("arms on different boot_id");
    }
  }));

  P.push(grade("provenance", (c) => {
    const v = isObj(input.provenance) ? input.provenance : {};
    for (const f of ["source_id", "capture_source", "endpoint", "client_version", "decoder_version", "registry_version", "license_class", "partition"]) {
      if (absent(v[f])) c.miss(`${f} absent or placeholder`);
      else if (typeof v[f] !== "string") c.bad(`${f} not a string`);
    }
    if (!absent(v.capture_source) && !CAPTURE.includes(v.capture_source)) c.bad("capture_source not in DAT-PRV-002 enum");
    for (const f of ["raw_ref", "t_ingest"]) if (v[f] !== undefined) c.bad(`${f} must not be pre-supplied: unknown before a Tier-0 append (see spec:Q1)`);
    const w = v.rawWriter;
    if (!isObj(w)) return c.miss("rawWriter binding absent (DAT-PRV-001 writer missing)");
    if (absent(w.location)) c.miss("rawWriter.location absent");
    if (absent(w.pin)) c.miss("rawWriter.pin absent");
    else if (!HEX40.test(String(w.pin))) c.bad("rawWriter.pin malformed");
    else if (DENIED[w.pin]?.roles.includes("rawWriter")) c.bad(`rawWriter.pin denied: ${DENIED[w.pin].why}`);
    else if (reviewedEntry(registry, "rawWriter", w.pin) === undefined) c.miss(`rawWriter.pin is not a reviewed writer (registry has ${(registry.rawWriter ?? []).length})`);
  }));

  P.push(grade("caps", (c) => {
    const k = isObj(input.caps) ? input.caps : {};
    for (const f of ["reconnect", "wsMessages", "wsBytes", "backfillBlocks"]) {
      if (absent(k[f])) c.miss(`${f} absent`);
      else if (!posInt(k[f])) c.bad(`${f} must be a finite positive integer`);
    }
    if (k.enforcedInSource !== true) c.miss("caps not claimed enforced in collector source");
    if (absent(k.enforcementPin)) c.miss("enforcementPin absent");
    else if (k.enforcementPin !== collectorPin) c.bad("enforcementPin is not the collector pin");
  }));

  P.push(grade("freshness", (c) => {
    const f = isObj(input.freshness) ? input.freshness : {};
    if (f.source !== "operator_supplied") c.miss('freshness.source must be "operator_supplied"');
    if (input.asOfUtc === undefined) c.miss("asOfUtc absent");
    else if (asOf === null) c.bad("asOfUtc is not a calendar-valid ISO-8601 UTC time");
    const bound = (k, max) => {
      if (f[k] === undefined) return c.miss(`${k} absent`);
      if (!finNonNeg(f[k]) || f[k] <= 0 || f[k] > max) c.bad(`${k} must be in (0, ${max}]`);
    };
    bound("maxAgeS", MAX_AGE_S);
    bound("maxEvidenceAgeS", MAX_EVIDENCE_AGE_S);
    const maxAge = finNonNeg(f.maxAgeS) && f.maxAgeS > 0 && f.maxAgeS <= MAX_AGE_S ? f.maxAgeS : MAX_AGE_S;
    const maxEv = finNonNeg(f.maxEvidenceAgeS) && f.maxEvidenceAgeS > 0 && f.maxEvidenceAgeS <= MAX_EVIDENCE_AGE_S ? f.maxEvidenceAgeS : MAX_EVIDENCE_AGE_S;
    const obs = (arm, x) => {
      if (x.observedAtUtc === undefined) { c.miss(`${arm}.observedAtUtc absent`); return null; }
      const t = parseUtc(x.observedAtUtc);
      if (t === null) { c.bad(`${arm}.observedAtUtc is not a calendar-valid ISO-8601 UTC time`); return null; }
      if (asOf !== null) {
        const age = (asOf - t) / 1000;
        if (age < 0) c.bad(`${arm} observed after asOfUtc`);
        else if (age > maxEv) c.bad(`${arm} evidence stale: ${age}s > ${maxEv}s`);
      }
      if (x.ageS === undefined) c.miss(`${arm}.ageS absent`);
      else if (!finNonNeg(x.ageS)) c.bad(`${arm}.ageS invalid`);
      else if (x.ageS > maxAge) c.bad(`${arm} head age ${x.ageS}s > ${maxAge}s`);
      return t;
    };
    let tH = null;
    let tW = null;
    const h = f.http;
    if (!isObj(h)) c.miss("http observation absent");
    else {
      tH = obs("http", h);
      if (!posInt(h.head)) c.miss("http.head absent");
    }
    const w = f.ws;
    if (!isObj(w)) c.miss("ws observation absent");
    else {
      tW = obs("ws", w);
      if (!Array.isArray(w.heads) || w.heads.length < 2 || !w.heads.every(posInt)) c.miss("ws.heads needs >= 2 observed newHeads");
      else if (!w.heads.every((x, i) => i === 0 || x === w.heads[i - 1] + 1)) c.bad("ws.heads not consecutive (gap or regression)");
    }
    if (tH !== null && tW !== null && isObj(h) && posInt(h.head) && Array.isArray(w.heads) && w.heads.length > 0 && w.heads.every(posInt)) {
      const expect = (tW - tH) / 1000 / BLOCK_S;
      const got = w.heads[w.heads.length - 1] - h.head;
      if (Math.abs(got - expect) > HEAD_TOL) c.bad(`HTTP/WS heads inconsistent: WS-HTTP = ${got} blocks, expected ${expect.toFixed(1)} ± ${HEAD_TOL} at ${BLOCK_S} s/block`);
    }
    if (f.recovery === "partial") c.bad("transport recovery partial");
    else if (f.recovery !== "complete") c.miss('recovery must be "complete"');
  }));

  // Aromer processing is a separate claim from node transport. Its head is cross-checked against the HTTP node
  // observation projected at BLOCK_S per block (fixed tolerance HEAD_TOL); a reported ageS cannot override the head.
  let aromer = "NOT_SUPPLIED";
  const aromerDetail = [];
  const a = input.aromer;
  if (isObj(a)) {
    const t = parseUtc(a.observedAtUtc);
    const fr = isObj(input.freshness) ? input.freshness : {};
    const maxAge = finNonNeg(fr.maxAgeS) && fr.maxAgeS > 0 && fr.maxAgeS <= MAX_AGE_S ? fr.maxAgeS : MAX_AGE_S;
    const h = isObj(fr.http) ? fr.http : {};
    const tH = parseUtc(h.observedAtUtc);
    const bad = (x) => { aromer = "INVALID_OR_INCOMPLETE"; aromerDetail.push(x); };
    if (t === null || !finNonNeg(a.ageS) || !posInt(a.head) || absent(a.feedState)) bad("aromer observation needs calendar-valid observedAtUtc, head, ageS, feedState");
    else if (asOf === null) bad("asOfUtc invalid: aromer evidence age unknown");
    else if (t > asOf) bad("aromer observed after asOfUtc (negative evidence age)");
    else if (tH === null || !posInt(h.head)) bad("no valid HTTP node observation to cross-check the aromer head");
    else {
      const expected = h.head + (t - tH) / 1000 / BLOCK_S;
      const lag = expected - a.head;
      aromerDetail.push(`aromer head ${a.head}, node-projected ${expected.toFixed(1)} (lag ${lag.toFixed(1)} blocks = ${(lag * BLOCK_S).toFixed(1)} s), ageS ${a.ageS}, feedState ${a.feedState}`);
      if (lag < -HEAD_TOL) bad("aromer head ahead of the node observation beyond tolerance");
      else if (lag > HEAD_TOL || a.feedState !== "up" || a.ageS > maxAge || (asOf - t) / 1000 > MAX_EVIDENCE_AGE_S) aromer = "BLOCKED_STALE";
      else aromer = "FRESH_OBSERVATION";
    }
  }
  if (scope.includes("aromer_measurement")) {
    P.push(grade("aromer", (c) => {
      if (aromer === "NOT_SUPPLIED") c.miss("aromer_measurement claimed but no Aromer observation");
      else if (aromer !== "FRESH_OBSERVATION") c.bad(`aromer_measurement blocked: ${aromer} (${aromerDetail.join("; ")})`);
    }));
  }

  for (const q of Object.keys(SPEC_Q)) {
    P.push(grade(`spec:${q}`, (c) => {
      const r = owner[q];
      if (!isObj(r) || absent(r.decision) || absent(r.ref)) c.miss(`unresolved until an owner record exists: ${SPEC_Q[q]}`);
    }));
  }

  for (const d of DEFECTS) {
    P.push(grade(`defect:${d}`, (c) => {
      const x = isObj(input.defects) ? input.defects[d] : undefined;
      const role = d === "jointIntegration" ? "nativePath" : "collector";
      const runPin = role === "nativePath" ? nativePin : collectorPin;
      const e = typeof runPin === "string" ? reviewedEntry(registry, role, runPin) : undefined;
      const backed = e !== undefined && Array.isArray(e.resolves) && e.resolves.includes(d);
      if (!isObj(x) || absent(x.state)) return c.miss(`${d}: explicit flag absent`);
      if (x.state === "unresolved") return c.miss(`${d} unresolved`);
      if (x.state !== "resolved") return c.bad(`${d}.state must be "resolved" or "unresolved"`);
      if (!backed) return c.bad(`${d} claimed resolved but no reviewed ${role} binding for ${String(runPin).slice(0, 7)} resolves it`);
    }));
  }

  const verdict = P.every((p) => p.status === "known") ? "READY" : "NOT_READY";
  return {
    schema: "native-preflight-result/2",
    verdict,
    claimScope: scope,
    aromerProcessing: { status: aromer, detail: aromerDetail, claimed: scope.includes("aromer_measurement") },
    registrySizes: Object.fromEntries(Object.entries(registry).map(([k, v]) => [k, v.length])),
    note: NOTE,
    prerequisites: P,
  };
}

function main() {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: node preflight.mjs <operator-input.json>\n");
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  } catch (e) {
    process.stderr.write(`preflight: unreadable input: ${e.message}\n`);
    process.exit(2);
  }
  const why = refusal(input);
  if (why !== null) {
    process.stderr.write(`preflight: refused: ${why}\n`);
    process.exit(2);
  }
  const r = validate(input);
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.verdict === "READY" ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

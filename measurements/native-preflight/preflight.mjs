#!/usr/bin/env node
// Offline native-run preflight validator. Reads one operator-supplied JSON file; no network, no processes.
import fs from "node:fs";

const NOTE =
  "READY means the operator-supplied prerequisites are present and mutually consistent. It is not DAT-SRC-011 admission, performance or latency evidence, and validates no run outcome.";
const FORBIDDEN = ["results", "outcomes", "outcome", "latency", "dat_src_011", "datSrc011", "admission", "performance", "pass"];
const CAPTURE = ["live_ws", "live_poll", "repair", "backfill_node", "backfill_thirdparty", "manual", "sealed_capture"];
const DEFECTS = ["M1", "M2", "provenance", "inSourceCaps", "jointIntegration"];
// Pins whose defects are recorded in pinned audits; an operator "resolved" claim against them is a contradiction.
const KNOWN_DEFECT_PINS = {
  "5206f9035ad1c057d78990b294941221e936f895": {
    role: "collector",
    defects: ["M1", "M2", "provenance", "inSourceCaps"],
    ref: "collector-173-audit 419346d AUDIT-2026-10-10.md M1, M2, V1-V8, C6, C7",
  },
  "54ba98a98bce1eb307852861deb394ef196638ae": {
    role: "nativePath",
    defects: ["jointIntegration"],
    ref: "54ba98a JOINT-GUARD.md: fake-loopback only, not wired into run-native.sh",
  },
};
const DOCS_ONLY_PINS = {
  "d7719e533f170222bbe3a8548090e8c9e579d42b": "audit rev 1 (docs only)",
  "419346d7f774118b66cb786397ea015709280345": "audit rev 2 (docs only)",
  "1c519811df3e2a624b45b9e4e95facd77a840a1f": "owner-decision proposal (docs only)",
};

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const TOPIC = /^0x[0-9a-f]{64}$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SENTINELS = new Set(["", "unknown", "tbd", "todo", "?", "n/a", "none", "null"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v) => v === undefined || v === null || (typeof v === "string" && SENTINELS.has(v.trim().toLowerCase()));
const canon = (v) =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const nonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function grade(id, fn) {
  const miss = [];
  const bad = [];
  fn({ miss: (m) => miss.push(m), bad: (m) => bad.push(m) });
  const status = bad.length > 0 ? "invalid" : miss.length > 0 ? "missing" : "known";
  return { id, status, detail: [...bad, ...miss] };
}

function findForbidden(v, path, out) {
  if (Array.isArray(v)) v.forEach((x, i) => findForbidden(x, `${path}[${i}]`, out));
  else if (isObj(v)) for (const k of Object.keys(v)) {
    if (FORBIDDEN.includes(k)) out.push(`${path}.${k}`);
    findForbidden(v[k], `${path}.${k}`, out);
  }
}

function pinCheck(c, role, p) {
  if (!isObj(p)) return c.miss(`${role}: pin absent`);
  for (const [k, re] of [["commit", HEX40], ["tree", HEX40], ["manifestSha256", HEX64]]) {
    if (absent(p[k])) c.miss(`${role}.${k} absent`);
    else if (typeof p[k] !== "string" || !re.test(p[k])) c.bad(`${role}.${k} malformed`);
  }
  if (typeof p.commit === "string" && DOCS_ONLY_PINS[p.commit]) c.bad(`${role}.commit is ${DOCS_ONLY_PINS[p.commit]}, not source`);
}

function filterSet(c, arm, f) {
  if (!isObj(f)) return c.miss(`${arm}: filters absent`);
  if (absent(f.digest)) c.miss(`${arm}.digest absent`);
  else if (!HEX64.test(String(f.digest))) c.bad(`${arm}.digest malformed`);
  if (!Array.isArray(f.filters) || f.filters.length === 0) return c.miss(`${arm}.filters absent or empty`);
  f.filters.forEach((x, i) => {
    if (!isObj(x) || !Array.isArray(x.address) || x.address.length === 0) return c.bad(`${arm}.filters[${i}].address must be an explicit non-empty array`);
    if (!x.address.every((a) => typeof a === "string" && ADDR.test(a))) c.bad(`${arm}.filters[${i}].address not lowercased 0x40-hex`);
    if (x.topics !== undefined) {
      if (!Array.isArray(x.topics)) return c.bad(`${arm}.filters[${i}].topics not an array`);
      for (const t of x.topics) {
        const alts = Array.isArray(t) ? t : [t];
        if (alts.length === 0 || !alts.every((a) => typeof a === "string" && TOPIC.test(a))) c.bad(`${arm}.filters[${i}].topics has a wildcard/null or non-lowercased topic`);
      }
    }
    for (const k of Object.keys(x)) if (k !== "address" && k !== "topics") c.bad(`${arm}.filters[${i}].${k} not allowed`);
  });
}

export function validate(input) {
  const P = [];
  const pins = isObj(input.pins) ? input.pins : {};
  const collectorPin = pins.collector?.commit;
  const nativePin = pins.nativePath?.commit;

  P.push(grade("pins", (c) => {
    for (const r of ["collector", "nativePath", "reference"]) pinCheck(c, r, pins[r]);
  }));

  P.push(grade("filters", (c) => {
    const f = isObj(input.filters) ? input.filters : {};
    filterSet(c, "collector", f.collector);
    filterSet(c, "reference", f.reference);
    if (isObj(f.collector) && isObj(f.reference) && Array.isArray(f.collector.filters) && Array.isArray(f.reference.filters)) {
      if (canon(f.collector.filters) !== canon(f.reference.filters)) c.bad("collector and reference filters differ");
      if (f.collector.digest !== f.reference.digest) c.bad("collector and reference digests differ");
    }
  }));

  P.push(grade("window", (c) => {
    const w = isObj(input.window) ? input.window : {};
    for (const arm of ["collector", "reference"]) {
      const x = w[arm];
      if (!isObj(x)) { c.miss(`${arm}: window absent`); continue; }
      for (const k of ["startNs", "endNs"]) {
        if (absent(x[k])) c.miss(`${arm}.${k} absent`);
        else if (typeof x[k] !== "string" || !DEC.test(x[k])) c.bad(`${arm}.${k} must be a decimal int64-ns string`);
      }
      if (typeof x.startNs === "string" && typeof x.endNs === "string" && DEC.test(x.startNs) && DEC.test(x.endNs) && BigInt(x.endNs) <= BigInt(x.startNs)) c.bad(`${arm}: endNs <= startNs`);
      if (x.clock !== "mono_ns") c.bad(`${arm}.clock must be "mono_ns"`);
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
      if (absent(x.clock_uncert_ms)) c.miss(`${arm}.clock_uncert_ms absent (measured value required, never defaulted)`);
      else if (!nonNeg(x.clock_uncert_ms)) c.bad(`${arm}.clock_uncert_ms invalid`);
    }
    if (isObj(k.collector) && isObj(k.reference)) {
      if (k.collector.host_id !== k.reference.host_id) c.bad("arms on different host_id");
      if (k.collector.boot_id !== k.reference.boot_id) c.bad("arms on different boot_id");
    }
  }));

  P.push(grade("provenance", (c) => {
    const v = isObj(input.provenance) ? input.provenance : {};
    for (const f of ["source_id", "capture_source", "endpoint", "client_version", "decoder_version", "registry_version", "license_class", "partition"]) {
      if (absent(v[f])) c.miss(`${f} absent or unknown`);
      else if (typeof v[f] !== "string") c.bad(`${f} not a string`);
    }
    if (!absent(v.capture_source) && !CAPTURE.includes(v.capture_source)) c.bad("capture_source not in DAT-PRV-002 enum");
    const w = v.rawWriter;
    if (!isObj(w)) return c.miss("rawWriter binding absent");
    if (absent(w.location)) c.miss("rawWriter.location absent");
    if (absent(w.pin)) c.miss("rawWriter.pin absent");
    else if (!HEX40.test(String(w.pin))) c.bad("rawWriter.pin malformed");
    if (absent(w.ackBinding)) c.miss("rawWriter.ackBinding absent");
    else if (canon(w.ackBinding) !== canon(["id", "epoch", "seq"])) c.bad('rawWriter.ackBinding must be ["id","epoch","seq"]');
    for (const f of ["raw_ref", "t_ingest"]) if (v[f] !== undefined) c.bad(`${f} must not be pre-supplied: known only after the writer ack`);
  }));

  P.push(grade("caps", (c) => {
    const k = isObj(input.caps) ? input.caps : {};
    for (const f of ["reconnect", "wsMessages", "wsBytes", "backfillBlocks"]) {
      if (absent(k[f])) c.miss(`${f} absent`);
      else if (!posInt(k[f])) c.bad(`${f} must be a finite positive integer`);
    }
    if (k.enforcedInSource !== true) c.miss("caps not enforced in collector source");
    if (absent(k.enforcementPin)) c.miss("enforcementPin absent");
    else if (k.enforcementPin !== collectorPin) c.bad("enforcementPin is not the collector pin");
  }));

  P.push(grade("freshness", (c) => {
    const f = isObj(input.freshness) ? input.freshness : {};
    if (f.source !== "operator_supplied") c.miss('freshness.source must be "operator_supplied"');
    const asOf = typeof input.asOfUtc === "string" && ISO.test(input.asOfUtc) ? Date.parse(input.asOfUtc) : null;
    if (asOf === null) c.miss("asOfUtc absent or not ISO-8601 UTC");
    if (!nonNeg(f.maxAgeS)) c.miss("maxAgeS absent");
    if (!nonNeg(f.maxEvidenceAgeS)) c.miss("maxEvidenceAgeS absent");
    const at = (arm, s) => {
      if (typeof s !== "string" || !ISO.test(s)) return c.miss(`${arm}.observedAtUtc absent`);
      const age = asOf === null ? null : (asOf - Date.parse(s)) / 1000;
      if (age !== null && age < 0) c.bad(`${arm} observed after asOfUtc`);
      if (age !== null && nonNeg(f.maxEvidenceAgeS) && age > f.maxEvidenceAgeS) c.bad(`${arm} evidence stale: ${age}s > ${f.maxEvidenceAgeS}s`);
    };
    const h = f.http;
    if (!isObj(h)) c.miss("http observation absent");
    else {
      at("http", h.observedAtUtc);
      if (!posInt(h.head)) c.miss("http.head absent");
      if (!nonNeg(h.ageS)) c.miss("http.ageS absent");
      else if (nonNeg(f.maxAgeS) && h.ageS > f.maxAgeS) c.bad(`http head age ${h.ageS}s > ${f.maxAgeS}s`);
    }
    const w = f.ws;
    if (!isObj(w)) c.miss("ws observation absent");
    else {
      at("ws", w.observedAtUtc);
      if (!Array.isArray(w.heads) || w.heads.length < 2 || !w.heads.every(posInt)) c.miss("ws.heads needs >= 2 observed newHeads");
      else if (!w.heads.every((x, i) => i === 0 || x === w.heads[i - 1] + 1)) c.bad("ws.heads not consecutive (gap or regression)");
      if (!nonNeg(w.ageS)) c.miss("ws.ageS absent");
      else if (nonNeg(f.maxAgeS) && w.ageS > f.maxAgeS) c.bad(`ws head age ${w.ageS}s > ${f.maxAgeS}s`);
    }
    if (f.recovery === "partial") c.bad("transport recovery partial");
    else if (f.recovery !== "complete") c.miss('recovery must be "complete"');
  }));

  for (const d of DEFECTS) {
    P.push(grade(`defect:${d}`, (c) => {
      const x = isObj(input.defects) ? input.defects[d] : undefined;
      const runPin = d === "jointIntegration" ? nativePin : collectorPin;
      const known = KNOWN_DEFECT_PINS[runPin];
      const recorded = known !== undefined && known.defects.includes(d);
      if (!isObj(x) || absent(x.state)) return c.miss(`${d}: explicit flag absent`);
      if (x.state === "unresolved") return recorded ? c.miss(`${d} unresolved (${known.ref})`) : c.miss(`${d} unresolved`);
      if (x.state !== "resolved") return c.bad(`${d}.state must be "resolved" or "unresolved"`);
      if (recorded) return c.bad(`${d} claimed resolved but the run pin ${runPin.slice(0, 7)} has it recorded (${known.ref})`);
      if (absent(x.pin) || x.pin !== runPin) c.bad(`${d}.pin must equal the ${d === "jointIntegration" ? "nativePath" : "collector"} pin`);
      if (!Array.isArray(x.oracle) || x.oracle.length === 0) c.miss(`${d}.oracle cases absent`);
      if (absent(x.reviewRef)) c.miss(`${d}.reviewRef absent`);
    }));
  }

  const verdict = P.every((p) => p.status === "known") ? "READY" : "NOT_READY";
  return { schema: "native-preflight-result/1", verdict, note: NOTE, prerequisites: P };
}

function main() {
  const file = process.argv[2];
  if (process.argv.length !== 3) {
    process.stderr.write("usage: node preflight.mjs <operator-input.json>\n");
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    process.stderr.write(`preflight: unreadable input: ${e.message}\n`);
    process.exit(2);
  }
  if (!isObj(input) || input.schema !== "native-preflight-input/1") {
    process.stderr.write('preflight: schema must be "native-preflight-input/1"\n');
    process.exit(2);
  }
  const forb = [];
  findForbidden(input, "$", forb);
  if (forb.length > 0) {
    process.stderr.write(`preflight: refused, run outcomes are not preflight input: ${forb.join(", ")}\n`);
    process.exit(2);
  }
  const r = validate(input);
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.verdict === "READY" ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

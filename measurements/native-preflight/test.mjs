// Hermetic tests: CLI matrix (built-in empty registry) + in-process matrix (test-only synthetic registry) + static checks.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { validate, refusal, parseUtc, REVIEWED, OWNER_RECORDS, CANONICAL_FILTERS } from "./preflight.mjs";

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const fx = (n) => JSON.parse(fs.readFileSync(`fixtures/${n}.json`, "utf8"));
const names = fs.readdirSync("fixtures").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const SYN = JSON.parse(fs.readFileSync("fixtures/SYNTHETIC-REGISTRY.test-only.json.txt", "utf8"));
const statusMap = (r) => Object.fromEntries(r.prerequisites.map((p) => [p.id, p.status]));
const nonKnown = (r) => Object.fromEntries(r.prerequisites.filter((p) => p.status !== "known").map((p) => [p.id, p.status]));
const eq = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function cli(n) {
  try { return { rc: 0, out: JSON.parse(execFileSync("node", ["preflight.mjs", `fixtures/${n}.json`], { stdio: ["ignore", "pipe", "pipe"] }).toString()) }; }
  catch (e) { return { rc: e.status, out: e.status === 1 ? JSON.parse(e.stdout.toString()) : null, err: e.stderr.toString() }; }
}

// 1. Static: offline, clockless, registry empty.
const src = fs.readFileSync("preflight.mjs", "utf8");
const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
ok(imports.length === 1 && imports[0] === "node:fs", `imports only node:fs (${imports})`);
for (const re of [/Date\.now/, /new Date\(\)/, /process\.env/, /fetch\(/, /require\(/, /child_process/, /node:(net|http|https|dgram|dns|tls|worker_threads)/, /performance\.now/, /hrtime/])
  ok(!re.test(src), `preflight.mjs has no ${re}`);
for (const k of ["collector", "nativePath", "reference", "rawWriter"]) ok(Array.isArray(REVIEWED[k]) && REVIEWED[k].length === 0, `built-in registry ${k} empty`);
ok(Object.isFrozen(REVIEWED) && OWNER_RECORDS.Q1 === null && OWNER_RECORDS.Q2 === null, "owner records Q1/Q2 null, registry frozen");
ok(CANONICAL_FILTERS[1].address.length === 6 && CANONICAL_FILTERS[0].topics[0].length === 2, "canonical PoolManager Initialize/Swap + six factories");

// 2. Dates.
for (const s of ["2026-99-99T99:99:99Z", "2026-13-45T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-10T24:00:00Z", "2026-10-10T05:47:11", "2026-10-10T05:47:11+00:00", "1999-01-01T00:00:00Z", "", null, 5])
  ok(parseUtc(s) === null, `parseUtc rejects ${JSON.stringify(s)}`);
ok(parseUtc("2028-02-29T00:00:00Z") !== null && parseUtc("2026-10-10T05:47:11.720Z") === Date.UTC(2026, 9, 10, 5, 47, 11) + 720, "parseUtc accepts valid leap day and fraction");

// 3. CLI matrix (actual shipped registry: nothing can be READY).
const REFUSED = ["forbidden-outcome", "forbidden-alias-nested", "self-attested-registry", "old-schema"];
for (const n of names) {
  const r = cli(n);
  if (REFUSED.includes(n)) { ok(r.rc === 2 && r.out === null, `CLI ${n} refused exit 2 (got ${r.rc})`); continue; }
  ok(r.rc === 1 && r.out.verdict === "NOT_READY", `CLI ${n} NOT_READY exit 1 (got ${r.rc})`);
  ok(/not DAT-SRC-011 admission/.test(r.out.note), `CLI ${n} carries non-admission note`);
  const s = statusMap(r.out);
  ok(s["spec:Q1"] === "missing" && s["spec:Q2"] === "missing", `CLI ${n} spec Q1/Q2 missing`);
  ok(s.pins !== "known" && s.provenance !== "known", `CLI ${n} pins/provenance not known under empty registry`);
}
const cf = statusMap(cli("corrected-full").out);
ok(cf.pins === "missing" && ["M1", "M2", "provenance", "inSourceCaps", "jointIntegration"].every((d) => cf[`defect:${d}`] === "invalid"), "CLI corrected-full: arbitrary pins missing, resolved claims invalid");
const cur = cli("current-0547").out;
ok(eq(nonKnown(cur), { pins: "invalid", window: "missing", clock: "missing", provenance: "missing", caps: "missing", freshness: "invalid", "spec:Q1": "missing", "spec:Q2": "missing", "defect:M1": "missing", "defect:M2": "missing", "defect:provenance": "missing", "defect:inSourceCaps": "missing", "defect:jointIntegration": "missing" }), `CLI current-0547 statuses ${JSON.stringify(nonKnown(cur))}`);
ok(cur.aromerProcessing.status === "BLOCKED_STALE" && cur.aromerProcessing.claimed === false, "CLI current-0547 Aromer stale reported, not claimed");
ok(cur.prerequisites.find((p) => p.id === "freshness").detail.some((d) => /ws evidence stale/.test(d)), "CLI current-0547 05:36 WS evidence stale at 05:47:20");
ok(statusMap(cli("claim-resolved-on-173").out)["defect:M1"] === "invalid", "CLI claim-resolved-on-173 M1 invalid");

// 4. In-process with test-only synthetic registry: each mutation alone flips READY.
const opt = { registry: SYN.registry, ownerRecords: SYN.ownerRecords };
const EXPECT = {
  "corrected-full": {}, "stale-aromer-native": {},
  "invalid-asof": { freshness: "invalid" }, "invalid-observedat": { freshness: "invalid" }, feb30: { freshness: "invalid" },
  "forkmain-collector": { pins: "invalid", "defect:M1": "invalid", "defect:M2": "invalid", "defect:provenance": "invalid", "defect:inSourceCaps": "invalid" },
  "nativepath-173": { pins: "invalid", "defect:jointIntegration": "invalid" }, "nativepath-54": { pins: "invalid", "defect:jointIntegration": "invalid" },
  "tree-mismatch": { pins: "invalid" },
  "one-ns-window": { window: "invalid" }, "window-over-int64": { window: "invalid" }, "window-over-24h": { window: "invalid" },
  "noncanonical-identical": { filters: "invalid" }, "mismatched-filters": { filters: "invalid" }, "mismatched-clock": { clock: "invalid" },
  "unbounded-threshold": { freshness: "invalid" }, stale: { freshness: "invalid" }, "partial-recovery": { freshness: "invalid" }, "http-ws-inconsistent": { freshness: "invalid" },
  "placeholder-values": { pins: "missing", provenance: "missing" }, "unknown-proof": { provenance: "missing", "defect:M2": "missing" },
  "raw-ref-supplied": { provenance: "invalid" }, "stale-aromer-claimed": { aromer: "invalid" },
};
for (const n of names) {
  const x = fx(n);
  if (REFUSED.includes(n)) { ok(refusal(x) !== null, `in-process ${n} refused`); continue; }
  ok(refusal(x) === null, `in-process ${n} not refused`);
  const r = validate(x, opt);
  if (n in EXPECT) {
    ok(eq(nonKnown(r), EXPECT[n]), `synthetic ${n}: ${JSON.stringify(nonKnown(r))} vs ${JSON.stringify(EXPECT[n])}`);
    ok(r.verdict === (Object.keys(EXPECT[n]).length === 0 ? "READY" : "NOT_READY"), `synthetic ${n} verdict ${r.verdict}`);
  } else ok(r.verdict === "NOT_READY", `synthetic ${n} NOT_READY`);
}
const sa = validate(fx("stale-aromer-native"), opt);
ok(sa.verdict === "READY" && sa.aromerProcessing.status === "BLOCKED_STALE" && !sa.aromerProcessing.claimed, "stale Aromer reported separately; native-run scope unaffected, no Aromer claim");
ok(validate(fx("current-0547"), opt).prerequisites.find((p) => p.id === "defect:M1").status === "missing", "current: M1 unresolved stays missing");
const noOwner = validate(fx("corrected-full"), { registry: SYN.registry });
ok(eq(nonKnown(noOwner), { "spec:Q1": "missing", "spec:Q2": "missing" }), "synthetic registry without owner records: only Q1/Q2 missing");
const noWriter = validate(fx("corrected-full"), { registry: { ...SYN.registry, rawWriter: [] }, ownerRecords: SYN.ownerRecords });
ok(eq(nonKnown(noWriter), { provenance: "missing" }), "no reviewed writer: provenance missing");
const unres = fx("corrected-full"); unres.defects.M1 = { state: "unresolved" };
ok(eq(nonKnown(validate(unres, opt)), { "defect:M1": "missing" }), "operator 'unresolved' wins over registry");
const noScope = fx("corrected-full"); delete noScope.claimScope;
ok(eq(nonKnown(validate(noScope, opt)), { claimScope: "missing" }), "claimScope required");
const aromerOnly = fx("corrected-full"); aromerOnly.claimScope = ["aromer_measurement"];
ok(validate(aromerOnly, opt).verdict === "NOT_READY", "claimScope must include native_collector_run");
const freshA = fx("corrected-full"); freshA.claimScope = ["native_collector_run", "aromer_measurement"];
ok(eq(nonKnown(validate(freshA, opt)), { aromer: "missing" }), "aromer_measurement without observation: missing");
for (const alias of ["Results", "p99_ms", "Admitted", "DAT_SRC_011", "outcome"]) {
  const y = fx("corrected-full"); y.caps.extra = [{ [alias]: 1 }];
  ok(refusal(y) !== null, `nested alias ${alias} refused`);
}

console.log(`${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// Hermetic tests: runs preflight.mjs on each fixture; no network.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = ["pins", "filters", "window", "clock", "provenance", "caps", "freshness", "defect:M1", "defect:M2", "defect:provenance", "defect:inSourceCaps", "defect:jointIntegration"];
const allKnown = Object.fromEntries(ALL.map((k) => [k, "known"]));
const EXPECT = {
  "current-419-173-54": { rc: 1, verdict: "NOT_READY", st: { pins: "missing", filters: "known", window: "missing", clock: "missing", provenance: "missing", caps: "missing", freshness: "known", "defect:M1": "missing", "defect:M2": "missing", "defect:provenance": "missing", "defect:inSourceCaps": "missing", "defect:jointIntegration": "missing" } },
  "claim-resolved-on-173": { rc: 1, verdict: "NOT_READY", st: { "defect:M1": "invalid", freshness: "known" } },
  "corrected-full": { rc: 0, verdict: "READY", st: allKnown },
  stale: { rc: 1, verdict: "NOT_READY", st: { ...allKnown, freshness: "invalid" } },
  "partial-recovery": { rc: 1, verdict: "NOT_READY", st: { ...allKnown, freshness: "invalid" } },
  "mismatched-filters": { rc: 1, verdict: "NOT_READY", st: { ...allKnown, filters: "invalid" } },
  "mismatched-clock": { rc: 1, verdict: "NOT_READY", st: { ...allKnown, window: "invalid", clock: "invalid" } },
  "unknown-proof": { rc: 1, verdict: "NOT_READY", st: { ...allKnown, provenance: "missing", "defect:M2": "missing" } },
  "forbidden-outcome": { rc: 2, verdict: null, st: {} },
};

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  if (ok) pass += 1;
  else fail += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${msg}\n`);
};

const files = fs.readdirSync(path.join(here, "fixtures")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
check(files.join(",") === Object.keys(EXPECT).sort().join(","), `fixture set = expectation set (${files.length})`);

for (const name of Object.keys(EXPECT).sort()) {
  const e = EXPECT[name];
  const r = spawnSync(process.execPath, [path.join(here, "preflight.mjs"), path.join(here, "fixtures", `${name}.json`)], { encoding: "utf8" });
  check(r.status === e.rc, `${name}: exit ${r.status} (want ${e.rc})`);
  if (e.verdict === null) {
    check(r.stdout === "" && /refused/.test(r.stderr), `${name}: refused with no verdict`);
    continue;
  }
  const out = JSON.parse(r.stdout);
  check(out.verdict === e.verdict, `${name}: verdict ${out.verdict}`);
  check(/not DAT-SRC-011 admission/.test(out.note), `${name}: non-admission note present`);
  const got = Object.fromEntries(out.prerequisites.map((p) => [p.id, p.status]));
  for (const [k, v] of Object.entries(e.st)) check(got[k] === v, `${name}: ${k}=${got[k]} (want ${v})`);
  for (const p of out.prerequisites) if (p.status !== "known") check(p.detail.length > 0, `${name}: ${p.id} ${p.status} carries a reason`);
  check(out.verdict !== "READY" || out.prerequisites.every((p) => p.status === "known"), `${name}: READY only if all known`);
}

const src = fs.readFileSync(path.join(here, "preflight.mjs"), "utf8");
const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
check(imports.join(",") === "node:fs", `preflight imports only node:fs (${imports.join(",")})`);
check(!/\b(fetch|require|process\.env|spawn|exec|WebSocket|Date\.now)\b/.test(src), "no network/process/env/wall-clock use in preflight.mjs");

process.stdout.write(`native-preflight tests: ${pass} PASS, ${fail} FAIL\n`);
process.exit(fail === 0 ? 0 : 1);

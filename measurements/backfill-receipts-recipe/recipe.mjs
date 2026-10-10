#!/usr/bin/env node
// Inert, offline recipe check. Extracts the three pinned components with `git archive` into ./work, then:
// (1) replays the synthetic chain filter-manifest -> backfill-plan -> receipt verifier; (2) shows the templates are refused
// while UNRESOLVED; (3) verifies the committed census-style narrow (Launched-only) factory receipts as FILTER_MISMATCH / UNKNOWN,
// with their original bytes hash-checked before and after. No network, node, T7 or production input. Run from this directory.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const PINS = {
  filterManifest: { commit: "42185f2170fb68e5d55b5e8507f480229f58b4df", dir: "measurements/filter-manifest", main: "compile.mjs", sha: "a01e632ea490479b517ca676d8664e15920e633e977dd2d6c844f3019d55c903" },
  backfillPlan: { commit: "a345d48a2f003348d3fe21910518ec1e6e54db35", dir: "measurements/backfill-plan", main: "plan.mjs", sha: "c527e1808fcd4efa00a34a0c1dd957bffa8d56adadb584d056babe8084edcf7a" },
  verifier: { commit: "83aec5d72f6712711b5f22ef29777858c5b797e0", dir: "measurements/backfill-receipts", main: "verify.mjs", sha: "0eb02c033103a13053b5797614dedf8724c686f24d42bdf3f476fc1f303fda56" },
};
const HERE = path.resolve(".");
const W = path.join(HERE, "work");
const EX = path.join(HERE, "example-narrow-launched");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`); };
const node = (script, args, cwd) => { const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd }); let out = null; try { out = JSON.parse(r.stdout); } catch {} return { rc: r.status, stdout: r.stdout, stderr: r.stderr, out }; };

fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const at = {};
for (const [k, p] of Object.entries(PINS)) {
  const dest = path.join(W, k);
  fs.mkdirSync(dest);
  const r = spawnSync("sh", ["-c", `git -C "$1" archive "$2" "$3" | tar -x -C "$4"`, "sh", root, p.commit, p.dir, dest], { encoding: "utf8" });
  at[k] = path.join(dest, p.dir);
  const main = path.join(at[k], p.main);
  check(`pin ${k}: ${p.commit} ${p.dir}/${p.main} sha256 ${p.sha.slice(0, 8)}`, r.status === 0 && fs.existsSync(main) && sha(fs.readFileSync(main)) === p.sha, { rc: r.status, stderr: r.stderr });
}

// (1) synthetic hash sequence: filter spec -> manifest bytes -> plan bytes -> receipts -> report
const fm = node("compile.mjs", ["--spec", "fixtures/spec.synthetic.json"], at.filterManifest);
check("1a filter-manifest compile of its synthetic spec == its evidence/manifest.synthetic.json bytes (3a5431c2)", fm.rc === 0 && sha(fm.stdout) === "3a5431c2e55a0a1f1b99d6c22b219febe47f2b0f5a10800abf8f80011484a527", { rc: fm.rc });
fs.writeFileSync(path.join(W, "manifest.json"), fm.stdout);
const pl = node("plan.mjs", ["--spec", "fixtures/spec.synthetic.json", "--manifest", path.join(W, "manifest.json")], at.backfillPlan);
check("1b backfill-plan of its synthetic spec over that manifest == its evidence/plan.synthetic.json bytes (3299b8fb, planSha256 7e9483a1)", pl.rc === 0 && sha(pl.stdout) === "3299b8fbcdd1156efd690d779758c5c8818d2ca36df4f18162e9a9fc771ef716" && pl.out.planSha256.startsWith("7e9483a1"), { rc: pl.rc });
fs.writeFileSync(path.join(W, "plan.json"), pl.stdout);
const ok = node("verify.mjs", ["--spec", "fixtures/spec.synthetic.json", "--manifest", path.join(W, "manifest.json"), "--plan", path.join(W, "plan.json"), "--receipts", "fixtures/receipts/receipts.json"], at.verifier);
check("1c verifier on its complete synthetic receipts: ALL_CALLS_RECEIPTED, live:false, resumeLive not permitted", ok.rc === 0 && ok.out.verdict === "ALL_CALLS_RECEIPTED" && ok.out.publicationProvenance.live === false && ok.out.resumeLive.permitted === false, { rc: ok.rc, v: ok.out?.verdict });

// (2) templates stay inert until every UNRESOLVED_* field is supplied by the caller
const T = (f) => path.join(HERE, "templates", f);
const tf = node("compile.mjs", ["--spec", T("filter-spec.template.json")], at.filterManifest);
check("2a filter-spec template refused while window/caps UNRESOLVED (exit 2)", tf.rc === 2 && typeof tf.out?.refused === "string", tf.out);
const tp = node("plan.mjs", ["--spec", T("plan-spec.template.json"), "--manifest", path.join(W, "manifest.json")], at.backfillPlan);
check("2b plan-spec template refused while UNRESOLVED (exit 2)", tp.rc === 2 && typeof tp.out?.refused === "string", tp.out);
const tv = node("verify.mjs", ["--spec", T("verify-spec.template.json"), "--manifest", path.join(W, "manifest.json"), "--plan", path.join(W, "plan.json"), "--receipts", T("receipts.template.json")], at.verifier);
check("2c verify-spec template refused while UNRESOLVED (exit 2)", tv.rc === 2 && typeof tv.out?.refused === "string", tv.out);

// (3) census-style narrow factory receipts (six factories, topic0 = Launched only) cannot stand in for raw-all-topics
const sums = JSON.parse(fs.readFileSync(path.join(EX, "SHA256SUMS.json"), "utf8"));
const hashAll = () => Object.fromEntries(Object.keys(sums).map((f) => [f, sha(fs.readFileSync(path.join(EX, f)))]));
check("3a example original bytes match SHA256SUMS.json before the run", JSON.stringify(hashAll()) === JSON.stringify(sums), hashAll());
const LAUNCHED = "0x207384e895174175cc774fe7f7457b37c382f27ebf53d37d5257b862f80eaf9c";
const fac = JSON.parse(fs.readFileSync(path.join(EX, "call-1.request.json"), "utf8")).params[0];
const planned = pl.out.calls[1].request.params[0];
check("3b narrow request = the six factory addresses with topics [Launched]; planned factory filter has the same six and NO topics key", JSON.stringify(fac.address) === JSON.stringify(planned.address) && JSON.stringify(fac.topics) === JSON.stringify([LAUNCHED]) && !Object.hasOwn(planned, "topics"), { fac, planned });
const neg = node("verify.mjs", ["--spec", path.join(EX, "spec.json"), "--manifest", path.join(W, "manifest.json"), "--plan", path.join(W, "plan.json"), "--receipts", path.join(EX, "receipts.json")], at.verifier);
const by = (lane) => neg.out?.calls.filter((c) => c.filtersetId === lane).map((c) => [c.callIndex, c.status, c.detail]);
check("3c verdict UNKNOWN (calls_not_verified); every factory lane call FILTER_MISMATCH request_not_planned_request",
  neg.rc === 0 && neg.out.verdict === "UNKNOWN" && JSON.stringify(neg.out.reasons) === '["calls_not_verified"]' && JSON.stringify(by("o1.factories.raw_all_topics")) === JSON.stringify([[1, "FILTER_MISMATCH", "request_not_planned_request"], [3, "FILTER_MISMATCH", "request_not_planned_request"], [5, "FILTER_MISMATCH", "request_not_planned_request"], [7, "FILTER_MISMATCH", "request_not_planned_request"]]), by("o1.factories.raw_all_topics"));
check("3d PoolManager Initialize/Swap lane (byte-identical 83aec5d receipts) still VERIFIED_LOGS; lanes are judged separately", JSON.stringify(by("poolmanager.initialize_swap")?.map((x) => x[1])) === '["VERIFIED_LOGS","VERIFIED_LOGS","VERIFIED_LOGS","VERIFIED_LOGS"]', by("poolmanager.initialize_swap"));
check("3e the Launched log in narrow call 3 is not credited (call has no logs in the report)", neg.out?.calls[3].logs === undefined, neg.out?.calls[3]);
check("3f report bytes == committed expected.report.json; no resume, admission NOT_ESTABLISHED, live:false", neg.stdout === fs.readFileSync(path.join(EX, "expected.report.json"), "utf8") && neg.out.resumeLive.permitted === false && neg.out.claims.sourceAdmission === "NOT_ESTABLISHED" && neg.out.publicationProvenance.live === false, { sha: sha(neg.stdout) });
check("3g example original bytes unchanged after the run", JSON.stringify(hashAll()) === JSON.stringify(sums));
fs.rmSync(W, { recursive: true, force: true });
console.log(`${pass} PASS, ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;

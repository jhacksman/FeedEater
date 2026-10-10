// Offline acceptance for check.mjs. Synthetic fixtures only; pinned components extracted with `git archive` into ./work.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonical } from "./check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(HERE, "work");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PIN = { manifest: "42185f2170fb68e5d55b5e8507f480229f58b4df", plan: "a345d48a2f003348d3fe21910518ec1e6e54db35", verifier: "83aec5d72f6712711b5f22ef29777858c5b797e0", recipe: "9d7d08736b2731fe2b45ad9f96f322e4f31b74a9" };
const ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE }).stdout.toString().trim();
const git = (args, opts = {}) => spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28, ...opts });
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
for (const [k, sub] of [["plan", "measurements/backfill-plan"], ["verifier", "measurements/backfill-receipts"], ["recipe", "measurements/backfill-receipts-recipe"]]) {
  fs.mkdirSync(path.join(W, k));
  const ar = git(["archive", PIN[k], sub]);
  spawnSync("tar", ["-x", "-C", path.join(W, k)], { input: ar.stdout });
}
const PD = path.join(W, "plan/measurements/backfill-plan");
const VD = path.join(W, "verifier/measurements/backfill-receipts");
const RD = path.join(W, "recipe/measurements/backfill-receipts-recipe/example-narrow-launched");
const MAN = path.join(HERE, "fixtures/manifest.synthetic.json");
const PLAN = path.join(HERE, "fixtures/plan.synthetic.json");
const CON = path.join(HERE, "fixtures/contract.synthetic.json");
const base = JSON.parse(fs.readFileSync(CON, "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const results = [];
const check = (name, ok, detail) => { results.push({ name, pass: !!ok }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)?.slice(0, 600)}`}\n`); };
const run = (args, cwd = HERE) => { const r = spawnSync(process.execPath, [path.join(HERE, "check.mjs"), ...args], { cwd }); let j = null; try { j = JSON.parse(r.stdout.toString()); } catch {} return { rc: r.status, out: r.stdout, err: r.stderr.toString(), j }; };
let n = 0;
const put = (obj, raw = null) => { const p = path.join(W, `c${n++}.json`); fs.writeFileSync(p, raw ?? `${JSON.stringify(obj, null, 2)}\n`); return p; };
const chk = (contract, { man = MAN, plan = PLAN } = {}) => run(["--contract", typeof contract === "string" ? contract : put(contract), "--manifest", man, "--plan", plan]);
const st = (r, id) => r.j?.checks?.find((c) => c.id === id);
const mut = (f) => { const c = clone(base); f(c); return c; };
const recipeShas = () => fs.readdirSync(RD).sort().map((f) => `${f}:${sha(fs.readFileSync(path.join(RD, f)))}`).join(",");
const recipeBefore = recipeShas();

// P. pins
check("pins: fixtures/manifest.synthetic.json == 42185f2 evidence/manifest.synthetic.json bytes (3a5431c2)", Buffer.compare(fs.readFileSync(MAN), git(["show", `${PIN.manifest}:measurements/filter-manifest/evidence/manifest.synthetic.json`]).stdout) === 0 && sha(fs.readFileSync(MAN)).startsWith("3a5431c2"));
check("pins: fixtures/plan.synthetic.json == a345d48 evidence/plan.synthetic.json bytes (3299b8fb)", Buffer.compare(fs.readFileSync(PLAN), git(["show", `${PIN.plan}:measurements/backfill-plan/evidence/plan.synthetic.json`]).stdout) === 0 && sha(fs.readFileSync(PLAN)).startsWith("3299b8fb"));
check("pins: extracted plan.mjs c527e180, verify.mjs 0eb02c03", sha(fs.readFileSync(path.join(PD, "plan.mjs"))).startsWith("c527e180") && sha(fs.readFileSync(path.join(VD, "verify.mjs"))).startsWith("0eb02c03"));
const planSpec = JSON.parse(fs.readFileSync(path.join(PD, "fixtures/spec.synthetic.json"), "utf8"));
const mkPlan = (spec, man = MAN) => { const p = typeof spec === "string" ? spec : put(spec); const r = spawnSync(process.execPath, ["plan.mjs", "--spec", p, "--manifest", man], { cwd: PD }); const out = path.join(W, `p${n++}.json`); fs.writeFileSync(out, r.stdout); return { file: out, rc: r.status, j: JSON.parse(r.stdout.toString()) }; };
const regen = mkPlan(path.join(PD, "fixtures/spec.synthetic.json"));
check("pins: a345d48 plan.mjs regenerates the fixture plan byte-identically", regen.rc === 0 && Buffer.compare(fs.readFileSync(regen.file), fs.readFileSync(PLAN)) === 0);
const pinPlan = (c, pl) => { c.plan = { fileSha256: sha(fs.readFileSync(pl.file)), planSha256: pl.j.planSha256 }; };

// A. complete synthetic contract
const A = chk(CON);
check("complete: exit 0, verdict CONTRACT_CONSISTENT, all 22 checks PASS, rootInputsMissing []", A.rc === 0 && A.j.verdict === "CONTRACT_CONSISTENT" && A.j.checks.length === 22 && A.j.checks.every((c) => c.status === "PASS") && A.j.rootInputsMissing.length === 0, A.j);
check("complete: window [937,1250] inclusive covered by each lane exactly (4 calls each, contiguous)", ["poolmanager", "factories"].every((l) => { const c = st(A, `plan.${l}_covers_window_exactly`); return c.calls === 4 && c.firstGap === null && c.covered.fromBlock === 937 && c.covered.toBlock === 1250; }));
check("complete: lanes = PoolManager [[Swap,Initialize]] + six factories with no topics key; narrow census reported separately as NOT_ALL_TOPICS", canonical(A.j.lanes.poolmanager.filter.topics[0].slice().sort()) === canonical(["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"]) && A.j.lanes.factories.filter.address.length === 6 && !Object.hasOwn(A.j.lanes.factories.filter, "topics") && A.j.narrowCensus.relation.startsWith("NOT_ALL_TOPICS") && A.j.narrowCensus.filterSha256 !== A.j.lanes.factories.filterSha256);
check("complete: backfill:true/live:false, resumeLive.permitted false, admission NOT_ESTABLISHED, latency/oneClock not measured, Q1/Q2 UNADOPTED", A.j.publicationProvenance.backfill === true && A.j.publicationProvenance.live === false && A.j.resumeLive.permitted === false && A.j.claims.sourceAdmission === "NOT_ESTABLISHED" && A.j.claims.latency === "NOT_MEASURED" && A.j.claims.oneClock === "NOT_ESTABLISHED" && A.j.claims.q1 === "UNADOPTED" && A.j.claims.q2 === "UNADOPTED");
const { reportSha256, ...body } = A.j;
const A2 = run(["--contract", CON, "--manifest", MAN, "--plan", PLAN], "/");
check("complete: reportSha256 recomputes; rerun and cwd=/ byte-identical", reportSha256 === sha(canonical(body)) && Buffer.compare(A.out, chk(CON).out) === 0 && Buffer.compare(A.out, A2.out) === 0);
fs.mkdirSync(path.join(HERE, "evidence"), { recursive: true });
fs.writeFileSync(path.join(HERE, "evidence/report.synthetic.json"), A.out);

// B. unresolved root inputs stay UNKNOWN
const U = chk(mut((c) => { c.comparison = { direct: { poolmanager: null, factories: null }, native: { poolmanager: null, factories: null } }; c.observationClock.clockId = null; c.subjects = { backfill: null, live: null }; }));
check("unresolved: null direct/native filters, clockId and subjects -> UNKNOWN (no FAIL), rootInputsMissing lists all 7", U.rc === 0 && U.j.verdict === "UNKNOWN" && U.j.checks.every((c) => c.status !== "FAIL") && U.j.rootInputsMissing.length === 7, U.j?.rootInputsMissing);
for (const [nm, f, id] of [["only native.factories null", (c) => { c.comparison.native.factories = null; }, "comparison.native.factories"], ["only clockId null", (c) => { c.observationClock.clockId = null; }, "clock.one_clock_declared"], ["only subjects.live null", (c) => { c.subjects.live = null; }, "subjects.backfill_distinct_from_live"]]) {
  const r = chk(mut(f));
  check(`unresolved: ${nm} -> UNKNOWN at ${id}`, r.j.verdict === "UNKNOWN" && st(r, id).status === "UNKNOWN", r.j?.verdict);
}

// C. narrow Launched-only census is never reinterpreted as all-topics
const narrowReq = JSON.parse(fs.readFileSync(path.join(RD, "call-1.request.json"), "utf8")).params[0];
const { fromBlock: _f, toBlock: _t, ...narrow } = narrowReq;
const N1 = chk(mut((c) => { c.comparison.direct.factories = narrow; }));
check("narrow: direct.factories = 9d7d087 retained Launched-only request filter -> FAIL NARROW_LAUNCHED_CENSUS_NOT_ALL_TOPICS (topics_present_on_all_topics_lane); direct/native factories not equal", N1.j.verdict === "FAIL" && st(N1, "comparison.direct.factories").outcome === "NARROW_LAUNCHED_CENSUS_NOT_ALL_TOPICS" && canonical(st(N1, "comparison.direct.factories").diffs) === canonical(["topics_present_on_all_topics_lane"]) && st(N1, "comparison.direct_native_equal.factories").status === "FAIL", st(N1, "comparison.direct.factories"));
const N2 = chk(mut((c) => { c.comparison.native.factories = narrowReq; }));
check("narrow: the request params verbatim (with range keys) -> FAIL FILTER_MISMATCH incl. range_key_in_filter", st(N2, "comparison.native.factories").outcome === "FILTER_MISMATCH" && st(N2, "comparison.native.factories").diffs.includes("range_key_in_filter:fromBlock"), st(N2, "comparison.native.factories"));
const N3 = chk(mut((c) => { c.comparison.direct.factories = narrow; c.comparison.native.factories = narrow; }));
check("narrow: both sides narrow (equal to each other) still FAIL: equality to the planned all-topics filter is required", N3.j.verdict === "FAIL" && st(N3, "comparison.direct_native_equal.factories").status === "FAIL");
const VN = spawnSync(process.execPath, ["verify.mjs", "--spec", path.join(RD, "spec.json"), "--manifest", "fixtures/manifest.synthetic.json", "--plan", "fixtures/plan.synthetic.json", "--receipts", path.join(RD, "receipts.json")], { cwd: VD });
const vn = JSON.parse(VN.stdout.toString());
check("narrow: 83aec5d verifier (run by this test) on the 9d7d087 narrow receipts -> 4 factory calls FILTER_MISMATCH, verdict UNKNOWN", VN.status === 0 && vn.verdict === "UNKNOWN" && vn.calls.filter((c) => c.status === "FILTER_MISMATCH").length === 4 && vn.calls.filter((c) => c.status === "FILTER_MISMATCH").every((c) => c.filtersetId === "o1.factories.raw_all_topics"), vn.calls?.map((c) => c.status));

// D. PoolManager topic omissions / differences
const pm = base.comparison.direct.poolmanager;
for (const [nm, obs, want] of [
  ["Swap only", { address: pm.address, topics: [[pm.topics[0][0]]] }, "topic0_missing:Initialize"],
  ["Initialize only", { address: pm.address, topics: [[pm.topics[0][1]]] }, "topic0_missing:Swap"],
  ["no topics key", { address: pm.address }, "topics_missing"],
  ["plus ModifyLiquidity topic0", { address: pm.address, topics: [[...pm.topics[0], "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"]] }, "topic0_extra:0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"],
  ["topics as two positions", { address: pm.address, topics: [pm.topics[0][0], pm.topics[0][1]] }, "topics_positions_differ"],
  ["OR order swapped", { address: pm.address, topics: [[pm.topics[0][1], pm.topics[0][0]]] }, "topics_encoding_differs"],
  ["foreign address", { address: ["0x0000000000000000000000000000000000000001"], topics: pm.topics }, "address_missing:0x498581ff718922c3f8e6a244956af099b2652b2b"],
]) {
  const r = chk(mut((c) => { c.comparison.native.poolmanager = obs; }));
  const x = st(r, "comparison.native.poolmanager");
  check(`poolmanager native ${nm} -> FAIL FILTER_MISMATCH (${want})`, r.j.verdict === "FAIL" && x.outcome === "FILTER_MISMATCH" && x.diffs.includes(want), x);
}

// E. factory lane: six exactly once, no pool list, no topics
const fa = base.comparison.direct.factories.address;
for (const [nm, obs, want] of [
  ["five factories", { address: fa.slice(1) }, `address_missing:${fa[0]}`],
  ["duplicate factory (7 entries)", { address: [...fa, fa[2]] }, `address_duplicate:${fa[2]}`],
  ["six factories + a pool address", { address: [...fa, "0x00000000000000000000000000000000000000aa"] }, "address_extra:0x00000000000000000000000000000000000000aa"],
  ["fixed pool list instead of factories", { address: ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"] }, `address_missing:${fa[5]}`],
  ["reordered addresses", { address: [...fa].reverse() }, "address_order"],
  ["topics [null] added", { address: fa, topics: [null] }, "topics_present_on_all_topics_lane"],
  ["extra key", { address: fa, blockHash: "0x00" }, "range_key_in_filter:blockHash"],
]) {
  const r = chk(mut((c) => { c.comparison.direct.factories = obs; }));
  const x = st(r, "comparison.direct.factories");
  check(`factories direct ${nm} -> FAIL FILTER_MISMATCH (${want})`, r.j.verdict === "FAIL" && x.outcome === "FILTER_MISMATCH" && x.diffs.includes(want), x);
}

// F. window differences
for (const [nm, w] of [["toBlock 1249", { fromBlock: 937, toBlock: 1249 }], ["fromBlock 936", { fromBlock: 936, toBlock: 1250 }], ["fromBlock 938", { fromBlock: 938, toBlock: 1250 }], ["toBlock 1251", { fromBlock: 937, toBlock: 1251 }]]) {
  const r = chk(mut((c) => { c.window = w; }));
  check(`window ${nm} vs plan [937,1250] -> FAIL both lanes`, r.j.verdict === "FAIL" && st(r, "plan.poolmanager_covers_window_exactly").status === "FAIL" && st(r, "plan.factories_covers_window_exactly").status === "FAIL", r.j?.verdict);
}
{
  const s = clone(planSpec); s.head.blockNumber = 1249;
  const pl = mkPlan(s);
  const r = chk(mut((c) => pinPlan(c, pl)), { plan: pl.file });
  check("window: plan regenerated with H=1249 (PLANNED) vs contract window [937,1250] -> FAIL coverage", pl.j.status === "PLANNED" && r.j.verdict === "FAIL" && st(r, "plan.factories_covers_window_exactly").covered.toBlock === 1249, r.j);
}
{
  const s = clone(planSpec); s.caps.maxCalls = 5;
  const pl = mkPlan(s);
  const r = chk(mut((c) => { pinPlan(c, pl); c.caps.plan.maxCalls = 5; }), { plan: pl.file });
  check("plan TRUNCATED_CALL_BUDGET (5 of 8 calls) -> planned_untruncated UNKNOWN, coverage FAIL, verdict FAIL", pl.j.status === "TRUNCATED_CALL_BUDGET" && st(r, "plan.planned_untruncated").status === "UNKNOWN" && st(r, "plan.planned_untruncated").planStatus === "TRUNCATED_CALL_BUDGET" && r.j.verdict === "FAIL", r.j?.checks?.slice(7, 10));
}
{
  const s = clone(planSpec); s.evidence.removedLogsSeen = true;
  const pl = mkPlan(s);
  const r = chk(mut((c) => pinPlan(c, pl)), { plan: pl.file });
  check("plan UNKNOWN_NEEDS_RECONCILIATION (no calls) -> planned_untruncated UNKNOWN, coverage FAIL (covered null)", pl.j.status === "UNKNOWN_NEEDS_RECONCILIATION" && st(r, "plan.planned_untruncated").status === "UNKNOWN" && st(r, "plan.poolmanager_covers_window_exactly").covered === null && r.j.verdict === "FAIL", r.j?.verdict);
}

// G. caps, lane pins, clock, subjects
for (const [nm, f, id] of [
  ["caps.plan.maxCalls 19", (c) => { c.caps.plan.maxCalls = 19; }, "caps.plan_equal"],
  ["caps.plan.maxBytes 1", (c) => { c.caps.plan.maxBytes = 1; }, "caps.plan_equal"],
  ["caps.comparison.maxRawEvents 999", (c) => { c.caps.comparison.maxRawEvents = 999; }, "caps.comparison_equal"],
  ["lanes.factories.filterSha256 = narrow sha", (c) => { c.lanes.factories.filterSha256 = sha(canonical(narrow)); }, "lanes.factories_pin"],
  ["clock fromUtc differs from manifest window", (c) => { c.observationClock.fromUtc = "2000-01-01T00:00:01Z"; }, "clock.window_equals_manifest"],
  ["clock toUtc differs from manifest window", (c) => { c.observationClock.toUtc = "2000-01-01T00:59:59Z"; }, "clock.window_equals_manifest"],
  ["backfill subject == live subject", (c) => { c.subjects.backfill = c.subjects.live; }, "subjects.backfill_distinct_from_live"],
]) {
  const r = chk(mut(f));
  check(`${nm} -> FAIL at ${id}`, r.j.verdict === "FAIL" && st(r, id).status === "FAIL" && r.j.checks.filter((c) => c.status === "FAIL").length === 1, r.j?.checks?.filter((c) => c.status !== "PASS"));
}

// H. manifest variants (re-hashed, plan regenerated with pinned a345d48 plan.mjs)
const manObj = JSON.parse(fs.readFileSync(MAN, "utf8"));
const rehash = (m) => { for (const f of m.filtersets) f.filterSha256 = sha(canonical(f.filter)); const b = { ...m }; delete b.manifestSha256; m.manifestSha256 = sha(canonical(b)); const p = path.join(W, `m${n++}.json`); fs.writeFileSync(p, `${canonical(m)}\n`); return { file: p, m }; };
const viaManifest = (f) => {
  const m = clone(manObj); f(m); const mv = rehash(m);
  const s = clone(planSpec); s.manifest = { fileSha256: sha(fs.readFileSync(mv.file)), manifestSha256: mv.m.manifestSha256 }; s.checkpoint.manifestSha256 = mv.m.manifestSha256;
  const pl = mkPlan(s, mv.file);
  const c = mut((x) => { x.manifest = clone(s.manifest); pinPlan(x, pl); });
  return { r: chk(c, { man: mv.file, plan: pl.file }), pl, mv };
};
for (const [nm, f, ids] of [
  ["factory lane with five addresses (row 6 kept)", (m) => { m.filtersets[1].filter.address = m.filtersets[1].filter.address.slice(1); }, ["manifest.factories_filter", "lanes.factories_pin", "comparison.direct.factories", "comparison.native.factories", "comparison.direct_native_equal.factories"]],
  ["factory row duplicated (7 rows)", (m) => { m.filtersets[1].rows.push(clone(m.filtersets[1].rows[0])); }, ["manifest.factory_rows_six_each_once"]],
  ["PoolManager lane without Initialize", (m) => { m.filtersets[0].filter.topics = [[m.filtersets[0].filter.topics[0][0]]]; }, ["manifest.poolmanager_filter", "lanes.poolmanager_pin", "comparison.direct.poolmanager", "comparison.native.poolmanager", "comparison.direct_native_equal.poolmanager"]],
  ["extra fixed-pool filterset", (m) => { m.filtersets.push({ id: "pools.fixed", family: "fixed_pool_list", filter: { address: ["0x00000000000000000000000000000000000000aa"] } }); }, ["manifest.filtersets_exactly_two_lanes", "manifest.no_fixed_pool_list"]],
]) {
  const { r, pl } = viaManifest(f);
  const fails = r.j?.checks?.filter((c) => c.status === "FAIL").map((c) => c.id) ?? [];
  const ok = r.rc === 0 && r.j.verdict === "FAIL" && ids.every((i) => fails.includes(i));
  check(`manifest variant: ${nm} (re-hashed; plan ${pl.j.status ?? pl.j.refused}) -> FAIL incl. ${ids[0]}`, ok, { rc: r.rc, fails, refused: r.j?.refused, plan: pl.j.status ?? pl.j.refused });
}

{
  const { r, pl } = viaManifest((m) => { m.filtersets[1].filter.topics = [narrow.topics[0]]; });
  check("manifest variant: factory lane narrowed to Launched-only (re-hashed) -> pinned a345d48 plan.mjs refuses it (manifest_filtersets_invalid), so no plan; check.mjs refuses the unplanned contract (exit 2)", pl.rc === 2 && pl.j.refused === "manifest_filtersets_invalid" && r.rc === 2 && typeof r.j?.refused === "string", { plan: pl.j, check: r.j });
}

// I. backfill receipts stay on the backfill subject (verifier 83aec5d, run by this test)
const VC = spawnSync(process.execPath, ["verify.mjs", "--spec", "fixtures/spec.synthetic.json", "--manifest", "fixtures/manifest.synthetic.json", "--plan", "fixtures/plan.synthetic.json", "--receipts", "fixtures/receipts/receipts.json"], { cwd: VD });
const vc = JSON.parse(VC.stdout.toString());
check("receipts: 83aec5d complete synthetic receipts for this same plan -> ALL_CALLS_RECEIPTED with backfill:true/live:false and resumeLive.permitted false", VC.status === 0 && vc.verdict === "ALL_CALLS_RECEIPTED" && vc.publicationProvenance.backfill === true && vc.publicationProvenance.live === false && vc.resumeLive.permitted === false, vc.verdict);

// J. refusals (exit 2, no stderr)
const refusal = (nm, args, reason) => { const r = run(args); check(`refuse ${nm} -> ${reason}`, r.rc === 2 && r.err === "" && r.j?.refused === reason, r.j ?? r.err); };
const R = (c, raw) => ["--contract", put(c, raw), "--manifest", MAN, "--plan", PLAN];
refusal("template with UNRESOLVED fields", ["--contract", path.join(HERE, "templates/contract.template.json"), "--manifest", MAN, "--plan", PLAN], "value_invalid");
refusal("manifest file pin mismatch", R(mut((c) => { c.manifest.fileSha256 = "0".repeat(64); })), "manifest_file_hash_mismatch");
refusal("plan identity pin mismatch", R(mut((c) => { c.plan.planSha256 = "0".repeat(64); })), "plan_identity_mismatch");
refusal("unknown contract field", R(mut((c) => { c.extra = 1; })), "spec_unknown_field");
refusal("missing window", R(mut((c) => { delete c.window; })), "spec_missing_field");
refusal("duplicate key", R(null, `{"schema":"x","schema":"y"}\n`), "json_duplicate_key");
refusal("window fromBlock > toBlock", R(mut((c) => { c.window = { fromBlock: 1251, toBlock: 1250 }; })), "value_invalid");
refusal("window block as hex string", R(mut((c) => { c.window.fromBlock = "0x3a9"; })), "value_invalid");
refusal("clock time with offset", R(mut((c) => { c.observationClock.fromUtc = "2000-01-01T00:00:00+00:00"; })), "value_invalid");
refusal("comparison filter as string", R(mut((c) => { c.comparison.direct.poolmanager = "same"; })), "value_invalid");
refusal("wrong schema", R(mut((c) => { c.schema = "full-coverage-filter-contract-input/0"; })), "contract_schema_mismatch");
fs.symlinkSync(CON, path.join(W, "link.json"));
refusal("symlinked contract", ["--contract", path.join(W, "link.json"), "--manifest", MAN, "--plan", PLAN], "contract_is_symlink");
refusal("missing --plan", ["--contract", CON, "--manifest", MAN], "cli_missing_argument");
refusal("duplicate --plan", ["--contract", CON, "--manifest", MAN, "--plan", PLAN, "--plan", PLAN], "cli_duplicate_argument");
refusal("unknown --endpoint", ["--contract", CON, "--manifest", MAN, "--plan", PLAN, "--endpoint", "http://127.0.0.1:1"], "cli_unknown_argument");

// K. static
const src = fs.readFileSync(path.join(HERE, "check.mjs"), "utf8");
const banned = ["node:http", "node:https", "node:net", "node:dgram", "node:child_process", "fetch(", "WebSocket", "process.env", "Date.now", "new Date()", "performance", "readdir", "opendir", "writeFile", "writeSync", "appendFile", "unlink", "rmSync", "mkdir", "setTimeout"];
check("static: check.mjs has no network, child process, env, wall-clock, write or directory-scan API", banned.every((b) => !src.includes(b)), banned.filter((b) => src.includes(b)));
check("static: fixtures and 9d7d087 narrow example bytes unchanged", sha(fs.readFileSync(MAN)).startsWith("3a5431c2") && sha(fs.readFileSync(PLAN)).startsWith("3299b8fb") && sha(fs.readFileSync(CON)) === sha(Buffer.from(`${JSON.stringify(base, null, 2)}\n`)) && recipeShas() === recipeBefore);

const pass = results.filter((r) => r.pass).length, fail = results.length - pass;
fs.writeFileSync(path.join(HERE, "evidence/results.json"), `${JSON.stringify({ pass, fail, cases: results }, null, 1)}\n`);
process.stdout.write(`${pass} PASS, ${fail} FAIL\n`);
fs.rmSync(W, { recursive: true, force: true });
process.exitCode = fail === 0 ? 0 : 1;

// Synthetic acceptance cases for verify.mjs. Offline, deterministic. Run from this directory. Needs git + a345d48 locally
// (plan variants are produced by the pinned a345d48 plan.mjs). Writes evidence/results.json; stdout is test.out.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonical } from "./verify.mjs";
import { writeReceipts, blockHash } from "./gen.mjs";

const HERE = path.resolve(".");
const W = path.join(HERE, "work");
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const MAN = path.join(HERE, "fixtures/manifest.synthetic.json");
const PLAN = path.join(HERE, "fixtures/plan.synthetic.json");
const manText = fs.readFileSync(MAN, "utf8");
const planText = fs.readFileSync(PLAN, "utf8");
const specText = fs.readFileSync("fixtures/spec.synthetic.json", "utf8");
const fixHashes = () => Object.fromEntries(["fixtures/manifest.synthetic.json", "fixtures/plan.synthetic.json", "fixtures/spec.synthetic.json", ...fs.readdirSync("fixtures/receipts").sort().map((f) => `fixtures/receipts/${f}`)].map((f) => [f, sha(fs.readFileSync(f))]));
const before = fixHashes();
const results = [];
let pass = 0, fail = 0, k = 0;
const check = (name, ok, expected, actual) => { results.push({ case: name, ok, expected, actual }); if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const run = (args, cwd = HERE) => { const r = spawnSync(process.execPath, [path.join(HERE, "verify.mjs"), ...args], { encoding: "utf8", cwd }); let out = null; try { out = JSON.parse(r.stdout); } catch {} return { rc: r.status, stdout: r.stdout, stderr: r.stderr, out }; };
const spec0 = JSON.parse(specText);
const plan0 = JSON.parse(planText);

// pinned contracts
check("fixture manifest = 42185f2 evidence/manifest.synthetic.json; fixture plan = a345d48 evidence/plan.synthetic.json (byte-exact)",
  sha(manText) === "3a5431c2e55a0a1f1b99d6c22b219febe47f2b0f5a10800abf8f80011484a527" && sha(planText) === "3299b8fbcdd1156efd690d779758c5c8818d2ca36df4f18162e9a9fc771ef716"
  && spawnSync("git", ["show", "42185f2170fb68e5d55b5e8507f480229f58b4df:measurements/filter-manifest/evidence/manifest.synthetic.json"], { encoding: "utf8" }).stdout === manText
  && spawnSync("git", ["show", "a345d48a2f003348d3fe21910518ec1e6e54db35:measurements/backfill-plan/evidence/plan.synthetic.json"], { encoding: "utf8" }).stdout === planText, "byte-exact", { manifest: sha(manText), plan: sha(planText) });
fs.mkdirSync(`${W}/a345d48`);
const planSrc = spawnSync("git", ["show", "a345d48a2f003348d3fe21910518ec1e6e54db35:measurements/backfill-plan/plan.mjs"], { encoding: "utf8" }).stdout;
fs.writeFileSync(`${W}/a345d48/plan.mjs`, planSrc);
check("a345d48 plan.mjs extracted for plan variants matches its pinned sha256", sha(planSrc) === "c527e1808fcd4efa00a34a0c1dd957bffa8d56adadb584d056babe8084edcf7a", "c527e180…", sha(planSrc));
const planSpec0 = JSON.parse(spawnSync("git", ["show", "a345d48a2f003348d3fe21910518ec1e6e54db35:measurements/backfill-plan/fixtures/spec.synthetic.json"], { encoding: "utf8" }).stdout);
const planSpecText = spawnSync("git", ["show", "a345d48a2f003348d3fe21910518ec1e6e54db35:measurements/backfill-plan/fixtures/spec.synthetic.json"], { encoding: "utf8" }).stdout;
const makePlan = (f) => { const s = structuredClone(planSpec0); f(s); const p = `${W}/planspec${++k}.json`; fs.writeFileSync(p, canonical(s) === canonical(planSpec0) ? planSpecText : JSON.stringify(s)); const r = spawnSync(process.execPath, [`${W}/a345d48/plan.mjs`, "--spec", p, "--manifest", MAN], { encoding: "utf8" }); const pp = `${W}/plan${k}.json`; fs.writeFileSync(pp, r.stdout); return { path: pp, plan: JSON.parse(r.stdout), text: r.stdout }; };
const regen = makePlan(() => {});
check("a345d48 plan.mjs regenerates the fixture plan byte-identically", regen.text === planText, sha(planText), sha(regen.text));
const g = `${W}/regen-receipts`; writeReceipts(plan0, g);
check("gen.mjs regenerates the checked-in fixtures/receipts byte-identically", fs.readdirSync(g).sort().every((f) => fs.readFileSync(`${g}/${f}`).equals(fs.readFileSync(`fixtures/receipts/${f}`))) && fs.readdirSync(g).length === fs.readdirSync("fixtures/receipts").length, "identical", fs.readdirSync(g).length);

// case runner
const V = (plan, planPath, mutate, specMut = () => {}) => {
  const d = `${W}/r${++k}`;
  const rs = writeReceipts(plan, d, mutate);
  const s = structuredClone(spec0);
  s.plan = { fileSha256: sha(fs.readFileSync(planPath)), planSha256: plan.planSha256 };
  s.receipts.fileSha256 = rs;
  specMut(s, d);
  const sp = `${W}/spec${k}.json`; fs.writeFileSync(sp, JSON.stringify(s));
  return run(["--spec", sp, "--manifest", MAN, "--plan", planPath, "--receipts", `${d}/receipts.json`]);
};
const st = (o) => o?.calls?.map((c) => c.status);
const VER = ["VERIFIED_LOGS", "VERIFIED_EMPTY", "VERIFIED_LOGS", "VERIFIED_LOGS", "VERIFIED_LOGS", "VERIFIED_LOGS", "VERIFIED_LOGS", "VERIFIED_LOGS"];
const with1 = (i, s) => VER.map((x, j) => (j === i ? s : x));
const caseS = (name, r, verdict, statuses, extra = () => true) => check(`${name}: exit 0 ${verdict}`, r.rc === 0 && r.stderr === "" && r.out?.verdict === verdict && canonical(st(r.out)) === canonical(statuses) && extra(r.out), { verdict, statuses }, { rc: r.rc, verdict: r.out?.verdict, statuses: st(r.out), reasons: r.out?.reasons, refused: r.out?.refused, detail: r.out?.calls?.find((c) => !c.status.startsWith("VERIFIED"))?.detail ?? r.out?.detail });

const ok = run(["--spec", "fixtures/spec.synthetic.json", "--manifest", "fixtures/manifest.synthetic.json", "--plan", "fixtures/plan.synthetic.json", "--receipts", "fixtures/receipts/receipts.json"]);
const o = ok.out;
caseS("complete receipts (8/8)", ok, "ALL_CALLS_RECEIPTED", VER, (x) => x.missingCalls.length === 0 && x.reasons.length === 0);
check("complete: provenance backfill:true live:false; resumeLive.permitted false; admission NOT_ESTABLISHED; completeness NOT_ESTABLISHED; Q1/Q2 UNADOPTED",
  canonical(o.publicationProvenance) === '{"backfill":true,"live":false}' && o.resumeLive.permitted === false && o.claims.sourceAdmission === "NOT_ESTABLISHED" && o.claims.completeness === "NOT_ESTABLISHED" && o.claims.canonicality === "UNVERIFIED" && canonical(o.policy) === '{"Q1":"UNADOPTED","Q2":"UNADOPTED"}', "as stated", { p: o.publicationProvenance, r: o.resumeLive, c: o.claims });
check("optional reth blockTimestamp preserved verbatim where present, ABSENT where absent", o.calls[0].logs[0].blockTimestamp === `0x${(946684800 + 937 * 2).toString(16)}` && o.calls[0].logs[1].blockTimestamp === "ABSENT", { present: `0x${(946684800 + 937 * 2).toString(16)}`, absent: "ABSENT" }, o.calls[0].logs.map((l) => l.blockTimestamp));
check("PoolManager logs Initialize/Swap; factory logs with unknown topic0 accepted (raw all topics, no fixed pools)", o.calls[0].logs.every((l) => l.address === "0x498581ff718922c3f8e6a244956af099b2652b2b") && o.calls[3].logs[0].topic0 === `0x${sha("unknown-event:1001")}`, "as stated", { pm: o.calls[0].logs.map((l) => l.topic0), fac: o.calls[3].logs[0] });
const body = { ...o }; delete body.reportSha256;
const abs = run(["--spec", path.join(HERE, "fixtures/spec.synthetic.json"), "--manifest", MAN, "--plan", PLAN, "--receipts", path.join(HERE, "fixtures/receipts/receipts.json")], "/");
check("reportSha256 recomputes; canonical stdout; rerun and cwd=/ with absolute paths byte-identical", o.reportSha256 === sha(canonical(body)) && ok.stdout === `${canonical(o)}\n` && abs.stdout === ok.stdout && run(["--spec", "fixtures/spec.synthetic.json", "--manifest", "fixtures/manifest.synthetic.json", "--plan", "fixtures/plan.synthetic.json", "--receipts", "fixtures/receipts/receipts.json"]).stdout === ok.stdout, "identical", o.reportSha256);

caseS("one missing receipt (call 3)", V(plan0, PLAN, (i) => (i === 3 ? { drop: true } : null)), "UNKNOWN", with1(3, "MISSING"), (x) => canonical(x.missingCalls) === "[3]" && x.reasons.includes("missing_calls"));
caseS("all receipts missing", V(plan0, PLAN, () => ({ drop: true })), "UNKNOWN", VER.map(() => "MISSING"), (x) => canonical(x.missingCalls) === "[0,1,2,3,4,5,6,7]");
caseS("RPC error on call 2", V(plan0, PLAN, (i, q, r) => { if (i === 2) { delete r.result; r.error = { code: -32005, message: "query returned more than 10000 results" }; } }), "UNKNOWN", with1(2, "RPC_ERROR"), (x) => x.calls[2].detail.code === -32005);
const sizes = plan0.calls.map((c) => fs.statSync(`fixtures/receipts/call-${c.index}.response.json`).size);
const tight = makePlan((s) => { s.caps.maxBytes = sizes.reduce((a, b) => a + b, 0) - 1; });
caseS("over budget: plan maxBytes = total response bytes - 1", V(tight.plan, tight.path, () => null), "UNKNOWN", with1(7, "OVER_BUDGET"), (x) => x.calls[7].detail.maxBytes === x.budget.maxBytes);
caseS("valid empty result where plan expects logs is still VERIFIED_EMPTY (no expected-volume claim)", V(plan0, PLAN, (i, q, r) => { if (i === 0) r.result = []; }), "ALL_CALLS_RECEIPTED", with1(0, "VERIFIED_EMPTY"));
caseS("truncated response bytes (last 7 bytes cut)", V(plan0, PLAN, (i, q, r) => (i === 4 ? { respText: JSON.stringify(r).slice(0, -7) } : null)), "UNKNOWN", with1(4, "TRUNCATED_RESPONSE"));
caseS("malformed response bytes", V(plan0, PLAN, (i) => (i === 4 ? { respText: "{]}" } : null)), "UNKNOWN", with1(4, "MALFORMED_RESPONSE"));
caseS("duplicate key in response", V(plan0, PLAN, (i, q, r) => (i === 4 ? { respText: JSON.stringify(r).replace('"id":', '"id":9,"id":') } : null)), "UNKNOWN", with1(4, "MALFORMED_RESPONSE"));
caseS("result and error both present", V(plan0, PLAN, (i, q, r) => { if (i === 5) r.error = { code: 1, message: "x" }; }), "UNKNOWN", with1(5, "MALFORMED_RESPONSE"));
caseS("response sha mismatch (receipt sha of other bytes)", V(plan0, PLAN, (i) => (i === 6 ? { respSha: "0".repeat(64) } : null)), "UNKNOWN", with1(6, "HASH_MISMATCH"));
caseS("request sha mismatch", V(plan0, PLAN, (i) => (i === 6 ? { reqSha: "0".repeat(64) } : null)), "UNKNOWN", with1(6, "HASH_MISMATCH"));
caseS("request range differs from plan (toBlock+1)", V(plan0, PLAN, (i, q) => { if (i === 2) q.params = [{ ...q.params[0], toBlock: "0x44d" }]; }), "UNKNOWN", with1(2, "FILTER_MISMATCH"));
caseS("PoolManager request without topics", V(plan0, PLAN, (i, q) => { if (i === 0) { const { topics, ...rest } = q.params[0]; q.params = [rest]; } }), "UNKNOWN", with1(0, "FILTER_MISMATCH"));
caseS("factory request missing one factory address", V(plan0, PLAN, (i, q) => { if (i === 1) q.params = [{ ...q.params[0], address: q.params[0].address.slice(1) }]; }), "UNKNOWN", with1(1, "FILTER_MISMATCH"));
caseS("request method eth_getFilterLogs", V(plan0, PLAN, (i, q) => { if (i === 1) q.method = "eth_getFilterLogs"; }), "UNKNOWN", with1(1, "FILTER_MISMATCH"));
caseS("response id differs", V(plan0, PLAN, (i, q, r) => { if (i === 3) r.id = 104; }), "UNKNOWN", with1(3, "ID_MISMATCH"));
caseS("response id type differs (\"4\" vs 4)", V(plan0, PLAN, (i, q, r) => { if (i === 3) r.id = "4"; }), "UNKNOWN", with1(3, "ID_MISMATCH"));
caseS("response id missing", V(plan0, PLAN, (i, q, r) => { if (i === 3) delete r.id; }), "UNKNOWN", with1(3, "ID_MISMATCH"));
caseS("log block outside request range", V(plan0, PLAN, (i, q, r) => { if (i === 3) r.result[0].blockNumber = "0x44d"; }), "UNKNOWN", with1(3, "FILTER_MISMATCH"));
caseS("log address not in filter", V(plan0, PLAN, (i, q, r) => { if (i === 3) r.result[0].address = "0x0000000000000000000000000000000000000001"; }), "UNKNOWN", with1(3, "FILTER_MISMATCH"));
caseS("PoolManager log with ModifyLiquidity topic0", V(plan0, PLAN, (i, q, r) => { if (i === 2) r.result[0].topics[0] = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"; }), "UNKNOWN", with1(2, "FILTER_MISMATCH"));
for (const [n, f] of [["uppercase blockHash", (l) => { l.blockHash = l.blockHash.toUpperCase().replace("0X", "0x"); }], ["leading-zero quantity", (l) => { l.logIndex = "0x05"; }], ["unknown field", (l) => { l.chainId = "0x2105"; }], ["missing removed", (l) => { delete l.removed; }], ["odd data", (l) => { l.data = "0x0"; }], ["5 topics", (l) => { l.topics = [...l.topics, ...l.topics, l.topics[0]]; }], ["blockTimestamp number", (l) => { l.blockTimestamp = 1; }]])
  caseS(`malformed log: ${n}`, V(plan0, PLAN, (i, q, r) => { if (i === 3) f(r.result[0]); }), "UNKNOWN", with1(3, "MALFORMED_LOG"));
caseS("same identity (blockHash, logIndex) with conflicting data in calls 2 and 3", V(plan0, PLAN, (i, q, r) => { if (i === 3) { r.result[0].logIndex = "0x0"; r.result[0].transactionIndex = "0x0"; } }), "UNKNOWN", VER.map((x, j) => (j === 2 || j === 3 ? "IDENTITY_CONTENT_CONFLICT" : x)), (x) => x.calls[2].detail.ambiguities[0].key === `${blockHash(1001)}/0x0`);
caseS("same identity identical content repeated in one response is not a conflict", V(plan0, PLAN, (i, q, r) => { if (i === 3) r.result.push({ ...r.result[0] }); }), "ALL_CALLS_RECEIPTED", VER);
caseS("removed then re-added (removed:true and removed:false, same identity)", V(plan0, PLAN, (i, q, r) => { if (i === 5) r.result = [{ ...r.result[0], removed: true }, r.result[0]]; }), "UNKNOWN", with1(5, "REMOVED_READD_OBSERVED"), (x) => x.calls[5].logs.map((l) => l.removed).join() === "true,false");
caseS("removed:true alone", V(plan0, PLAN, (i, q, r) => { if (i === 5) r.result[0].removed = true; }), "UNKNOWN", with1(5, "REMOVED_READD_OBSERVED"));
caseS("same blockNumber, two blockHashes (calls 2 and 3)", V(plan0, PLAN, (i, q, r) => { if (i === 3) r.result[0].blockHash = blockHash(999999); }), "UNKNOWN", VER.map((x, j) => (j === 2 || j === 3 ? "BLOCK_HASH_CONFLICT" : x)));
const trunc = makePlan((s) => { s.caps.maxCalls = 5; });
caseS("plan TRUNCATED_CALL_BUDGET with all 5 planned calls receipted", V(trunc.plan, trunc.path, () => null), "UNKNOWN", VER.slice(0, 5), (x) => canonical(x.reasons) === '["plan_status_TRUNCATED_CALL_BUDGET","plan_truncated"]');
const unk = makePlan((s) => { s.evidence.removedLogsSeen = null; });
caseS("plan UNKNOWN_NEEDS_RECONCILIATION (no calls)", V(unk.plan, unk.path, () => null), "UNKNOWN", [], (x) => x.reasons[0] === "plan_status_UNKNOWN_NEEDS_RECONCILIATION");
const noScan = V(plan0, PLAN, (i) => (i === 7 ? { drop: true } : null), (s, d) => { fs.copyFileSync("fixtures/receipts/call-7.request.json", `${d}/call-7.request.json`); fs.copyFileSync("fixtures/receipts/call-7.response.json", `${d}/call-7.response.json`); });
caseS("no implicit file scan: valid call-7 files present but not in the index stay MISSING", noScan, "UNKNOWN", with1(7, "MISSING"));

const ref = (name, r, reason) => check(`refuse ${name}: exit 2 ${reason}`, r.rc === 2 && r.out?.refused === reason && r.stderr === "" && r.stdout.split("\n").length === 2, { rc: 2, refused: reason }, { rc: r.rc, refused: r.out?.refused, detail: r.out?.detail, stderr: r.stderr });
const Vidx = (edit, specMut = () => {}) => V(plan0, PLAN, () => null, (s, d) => { const p = `${d}/receipts.json`; const t = edit(fs.readFileSync(p, "utf8")); fs.writeFileSync(p, t); s.receipts.fileSha256 = sha(t); specMut(s, d); });
const J = (f) => (t) => { const v = JSON.parse(t); f(v); return JSON.stringify(v); };
ref("duplicate key in receipts index", Vidx((t) => t.replace('"schema":', '"planSha256": "x", "schema":')), "json_duplicate_key");
ref("receipt for unplanned call 8", Vidx(J((v) => { v.receipts[7].callIndex = 8; })), "receipt_for_unplanned_call");
ref("two receipts for call 0", Vidx(J((v) => { v.receipts[1].callIndex = 0; })), "receipt_duplicate_call");
ref("receipt file with path separator", Vidx(J((v) => { v.receipts[0].response.file = "../call-0.response.json"; })), "receipt_file_name_invalid");
ref("receipt file '..'", Vidx(J((v) => { v.receipts[0].request.file = ".."; })), "receipt_file_name_invalid");
ref("receipt file absent", Vidx(J((v) => { v.receipts[0].response.file = "absent.json"; })), "receipt_file_missing");
ref("receipt file is a symlink", Vidx((t) => t, (s, d) => { fs.renameSync(`${d}/call-0.response.json`, `${d}/real.json`); fs.symlinkSync("real.json", `${d}/call-0.response.json`); }), "receipt_file_is_symlink");
ref("receipts index for another plan", Vidx(J((v) => { v.planSha256 = "0".repeat(64); })), "receipts_plan_mismatch");
ref("receipts index unknown field", Vidx(J((v) => { v.complete = true; })), "spec_unknown_field");
ref("receipts index sha not pinned", V(plan0, PLAN, () => null, (s) => { s.receipts.fileSha256 = "0".repeat(64); }), "receipts_file_hash_mismatch");
const pretty = `${JSON.stringify(plan0, null, 1)}\n`; const pp = `${W}/pretty.json`; fs.writeFileSync(pp, pretty);
ref("non-canonical plan bytes", V(plan0, pp, () => null), "plan_noncanonical");
const forge = (f) => { const p = structuredClone(plan0); f(p); delete p.planSha256; const t = `${canonical({ ...p, planSha256: sha(canonical(p)) })}\n`; const fp = `${W}/forged${++k}.json`; fs.writeFileSync(fp, t); return { path: fp, plan: JSON.parse(t) }; };
const bad1 = (() => { const p = structuredClone(plan0); p.status = "PLANNED_X"; const t = `${canonical(p)}\n`; const fp = `${W}/selfbad.json`; fs.writeFileSync(fp, t); return { path: fp, plan: p }; })();
ref("plan self-hash broken", V(bad1.plan, bad1.path, () => null), "plan_self_hash_mismatch");
const f2 = forge((p) => { p.calls[2].request.params[0].toBlock = "0x44d"; });
ref("plan call request not bound to manifest filter/range (re-hashed)", V(f2.plan, f2.path, () => null), "plan_call_unbound");
const f3 = forge((p) => { p.inputs.manifest.manifestSha256 = "0".repeat(64); });
ref("plan built from another manifest (re-hashed)", V(f3.plan, f3.path, () => null), "plan_manifest_mismatch");
ref("spec pins another planSha256", V(plan0, PLAN, () => null, (s) => { s.plan.planSha256 = "0".repeat(64); }), "plan_identity_mismatch");
ref("spec pins another plan file sha", V(plan0, PLAN, () => null, (s) => { s.plan.fileSha256 = "0".repeat(64); }), "plan_file_hash_mismatch");
ref("spec pins another manifest", V(plan0, PLAN, () => null, (s) => { s.manifest.manifestSha256 = "0".repeat(64); }), "filter_identity_mismatch");
ref("spec unknown field", V(plan0, PLAN, () => null, (s) => { s.resumeLive = true; }), "spec_unknown_field");
ref("spec duplicate key", run(["--spec", (() => { const p = `${W}/dup.json`; fs.writeFileSync(p, specText.replace('"schema":', '"schema": "x", "schema":')); return p; })(), "--manifest", MAN, "--plan", PLAN, "--receipts", "fixtures/receipts/receipts.json"]), "json_duplicate_key");
ref("no arguments", run([]), "usage");
ref("missing --receipts", run(["--spec", "fixtures/spec.synthetic.json", "--manifest", MAN, "--plan", PLAN]), "usage");
ref("duplicate --plan", run(["--plan", PLAN, "--plan", PLAN]), "usage_duplicate_argument");
ref("unknown --dir", run(["--spec", "fixtures/spec.synthetic.json", "--manifest", MAN, "--plan", PLAN, "--receipts", "fixtures/receipts/receipts.json", "--dir", "fixtures/receipts"]), "usage");

const code = fs.readFileSync("verify.mjs", "utf8");
const banned = ["node:net", "node:http", "node:https", "node:dns", "node:child_process", "node:worker_threads", "fetch(", "WebSocket", "Date", "performance", "hrtime", "writeFile", "appendFile", "rmSync", "unlink", "rename", "truncateSync", "mkdir", "symlinkSync", "process.env", "readdir", "opendir", "glob"];
const hits = banned.filter((b) => code.includes(b));
check("static: verify.mjs has no network/process/clock/write/env/directory-scan APIs", hits.length === 0, [], hits);
check("fixtures unchanged by the run", canonical(fixHashes()) === canonical(before), "same", "compared");
fs.rmSync(W, { recursive: true, force: true });
fs.writeFileSync("evidence/results.json", `${JSON.stringify({ note: "synthetic acceptance cases only; not canonicality, completeness, delivery, latency or source-admission evidence", pass, fail, results }, null, 2)}\n`);
console.log(`${pass} PASS, ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;

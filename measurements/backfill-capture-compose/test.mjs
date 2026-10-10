// Offline acceptance for compose.mjs. Pinned components are extracted with `git archive` into ./work/components.
// The only transport is the pinned capture C1 run against a hermetic fake on 127.0.0.1 (handoff proof); compose itself sends nothing.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(HERE, "work");
const CO = path.join(W, "components");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE }).stdout.toString().trim();
const git = (args) => spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28 });
const PINS = [["42185f2170fb68e5d55b5e8507f480229f58b4df", "filter-manifest"], ["a345d48a2f003348d3fe21910518ec1e6e54db35", "backfill-plan"], ["56f8f3bcc072f86d13b55f34f6f3632bd142f6ba", "backfill-receipt-capture"], ["d568aee4779d648f669753a009e564ed2be4d456", "full-coverage-filter-contract"], ["83aec5d72f6712711b5f22ef29777858c5b797e0", "backfill-receipts"]];
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(CO, { recursive: true });
for (const [c, d] of PINS) spawnSync("tar", ["-x", "--strip-components=1", "-C", CO], { input: git(["archive", c, `measurements/${d}`]).stdout });
const SPEC = path.join(HERE, "fixtures/compose.synthetic.json");
const base = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const results = [];
const check = (name, ok, detail) => { results.push({ name, pass: !!ok }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)?.slice(0, 700)}`}\n`); };
let n = 0;
const put = (o, raw = null) => { const p = path.join(W, `s${n++}.json`); fs.writeFileSync(p, raw ?? `${JSON.stringify(o, null, 2)}\n`); return p; };
const FAULT = path.join(W, "fault.mjs");
fs.writeFileSync(FAULT, `import fs from "node:fs";
const [mode, target] = (process.env.COMPOSE_FAULT ?? "").split(":");
const names = new Map(); const open = fs.openSync, write = fs.writeSync;
fs.openSync = (p, ...r) => { const fd = open(p, ...r); names.set(fd, String(p).split("/").pop()); return fd; };
fs.writeSync = (fd, buf, off, len, pos) => { const hit = target === undefined || names.get(fd) === target;
  if (hit && mode === "short") return write(fd, buf, off, Math.min(len, 8), pos);
  if (hit && mode === "eio") { const e = new Error("EIO"); e.code = "EIO"; throw e; }
  return write(fd, buf, off, len, pos); };
`);
const compose = (spec, { out = path.join(W, `o${n++}`), components = CO, cwd = HERE, fault = null, args = null } = {}) => {
  const a = args ?? ["--spec", typeof spec === "string" ? spec : put(spec), "--components", components, "--out", out];
  const r = spawnSync(process.execPath, [...(fault ? ["--import", FAULT] : []), path.join(HERE, "compose.mjs"), ...a], { cwd, env: fault ? { ...process.env, COMPOSE_FAULT: fault } : process.env });
  let j = null; try { j = JSON.parse(r.stdout.toString()); } catch {}
  return { rc: r.status, j, out, err: r.stderr.toString(), exists: fs.existsSync(out) };
};
const mut = (f) => { const s = clone(base); f(s); return s; };
const rd = (d, f) => fs.readFileSync(path.join(d, f));
const show = (c, p) => git(["show", `${c}:${p}`]).stdout;

// A. compose and pinned reproduction
const A = compose(SPEC);
const FILES = ["filter-spec.json", "manifest.json", "plan-spec.json", "plan.json", "capture-spec.json", "contract.json", "verify-spec.template.json", "handoff.json"];
check("compose: exit 0 COMPOSED, exactly 8 files persisted, transportExecuted false", A.rc === 0 && A.j.status === "COMPOSED" && fs.readdirSync(A.out).sort().join() === [...FILES].sort().join() && A.j.transportExecuted === false, A.j);
const H = JSON.parse(rd(A.out, "handoff.json"));
check("compose: every file sha/bytes in handoff.json and stdout equals the bytes on disk", FILES.filter((f) => f !== "handoff.json").every((f) => H.files[f].sha256 === sha(rd(A.out, f)) && H.files[f].bytes === rd(A.out, f).length && A.j.files[f] === sha(rd(A.out, f))) && A.j.files["handoff.json"] === sha(rd(A.out, "handoff.json")));
check("compose: manifest.json == 42185f2 evidence manifest bytes (3a5431c2)", Buffer.compare(rd(A.out, "manifest.json"), show(PINS[0][0], "measurements/filter-manifest/evidence/manifest.synthetic.json")) === 0);
check("compose: plan-spec.json, plan.json, capture-spec.json == capture C1 56f8f3b fixtures planspec.4calls (02373fdc), plan.4calls (794ec161), spec.synthetic (fbbff88d)", Buffer.compare(rd(A.out, "plan-spec.json"), show(PINS[2][0], "measurements/backfill-receipt-capture/fixtures/planspec.4calls.json")) === 0 && Buffer.compare(rd(A.out, "plan.json"), show(PINS[2][0], "measurements/backfill-receipt-capture/fixtures/plan.4calls.json")) === 0 && Buffer.compare(rd(A.out, "capture-spec.json"), show(PINS[2][0], "measurements/backfill-receipt-capture/fixtures/spec.synthetic.json")) === 0);
check("compose: handoff pins all 6 component files (commit + sha), plan PLANNED 4 calls, contract CONTRACT_CONSISTENT, backfill:true/live:false, resume not permitted, admission NOT_ESTABLISHED", Object.keys(H.components).length === 6 && H.plan.status === "PLANNED" && H.plan.callCount === 4 && H.contract.verdict === "CONTRACT_CONSISTENT" && H.publicationProvenance.live === false && H.resumeLive.permitted === false && H.claims.sourceAdmission === "NOT_ESTABLISHED");
const B = compose(SPEC, { cwd: "/" });
check("compose: rerun (cwd=/) emits byte-identical files", FILES.every((f) => Buffer.compare(rd(A.out, f), rd(B.out, f)) === 0));
check("compose: no machine path or endpoint in any emitted file", FILES.every((f) => !rd(A.out, f).toString().includes(W) && !rd(A.out, f).toString().includes("127.0.0.1")));

// B. documented commands run verbatim (bash, root-supplied variables)
const sh = (cmd, env = {}) => spawnSync("bash", ["-c", cmd], { cwd: A.out, env: { PATH: process.env.PATH, COMPONENTS: CO, ...env } });
check("commands: rebuildManifest reproduces manifest.json (cmp exit 0)", sh(H.commands.rebuildManifest).status === 0);
check("commands: rebuildPlan reproduces plan.json (cmp exit 0)", sh(H.commands.rebuildPlan).status === 0);
const ck = sh(H.commands.checkContract);
const ckj = JSON.parse(ck.stdout.toString());
check("commands: checkContract (d568aee check.mjs) -> exit 0 CONTRACT_CONSISTENT, 22/22 PASS, reportSha256 == handoff", ck.status === 0 && ckj.verdict === "CONTRACT_CONSISTENT" && ckj.checks.length === 22 && ckj.checks.every((c) => c.status === "PASS") && ckj.reportSha256 === H.contract.reportSha256, ckj.verdict);
const verifyTemplate = JSON.parse(rd(A.out, "verify-spec.template.json"));
const vt = sh(H.commands.verify.replace("verify-spec.json", "verify-spec.template.json"), { ROOT_CAPTURE_OUT: path.join(W, "none") });
check("commands: verify with the unfilled template is refused (exit 2), receipts sha left UNRESOLVED", vt.status === 2 && verifyTemplate.receipts.fileSha256.startsWith("UNRESOLVED"), vt.stdout.toString());

// C. handoff: capture C1 against a hermetic 127.0.0.1 fake, then 83aec5d verify
const log = [];
const srv = http.createServer((req, res) => { const ch = []; req.on("data", (c) => ch.push(c)); req.on("end", () => { const b = Buffer.concat(ch); log.push(b); const id = JSON.parse(b).id; res.end(`{"jsonrpc":"2.0","id":${id},"result":[]}`); }); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const CAP = path.join(W, "capture-out");
const capRun = await new Promise((r) => { const p = spawn("bash", ["-c", H.commands.capture], { cwd: A.out, env: { PATH: process.env.PATH, COMPONENTS: CO, ROOT_ENDPOINT: `http://127.0.0.1:${srv.address().port}/rpc`, ROOT_CAPTURE_OUT: CAP } }); const o = []; p.stdout.on("data", (c) => o.push(c)); p.on("close", (code) => r({ code, out: Buffer.concat(o).toString() })); });
await new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
const capj = JSON.parse(capRun.out);
check("handoff: capture C1 run by its documented command on the emitted bytes -> exit 0 CAPTURED_ALL_PLANNED, exactly 4 POSTs to the fake", capRun.code === 0 && capj.status === "CAPTURED_ALL_PLANNED" && log.length === 4, capj);
const plan = JSON.parse(rd(A.out, "plan.json"));
check("handoff: each POST body == the emitted plan's params[0] verbatim with id index+1", log.every((b, i) => { const j = JSON.parse(b); return j.id === i + 1 && JSON.stringify(j.params[0]) === JSON.stringify(plan.calls[i].request.params[0]); }));
fs.writeFileSync(path.join(A.out, "verify-spec.json"), `${JSON.stringify({ ...verifyTemplate, receipts: { fileSha256: sha(fs.readFileSync(path.join(CAP, "receipts.json"))) } }, null, 2)}\n`);
const vr = sh(H.commands.verify, { ROOT_CAPTURE_OUT: CAP });
const vj = JSON.parse(vr.stdout.toString());
check("handoff: 83aec5d verify by its documented command on the fake receipts -> ALL_CALLS_RECEIPTED, 4 VERIFIED_EMPTY, backfill:true/live:false, resume not permitted", vr.status === 0 && vj.verdict === "ALL_CALLS_RECEIPTED" && vj.calls.length === 4 && vj.calls.every((c) => c.status === "VERIFIED_EMPTY") && vj.publicationProvenance.live === false && vj.resumeLive.permitted === false, vj.verdict ?? vj);
fs.rmSync(path.join(A.out, "verify-spec.json"));

// D. honest incomplete root input refusal: exit 2, nothing created
const refused = (nm, spec, reason, pred = () => true, opts = {}) => { const r = compose(spec, opts); check(`refuse ${nm} -> ${reason}, exit 2, no output`, r.rc === 2 && r.j?.refused === reason && !r.exists && pred(r.j), r.j ?? r.err); return r; };
refused("contract.subjects.live null", mut((s) => { s.contract.subjects.live = null; }), "root_inputs_unresolved", (j) => j.detail.paths.join() === "spec.contract.subjects.live");
refused("head.blockHash UNRESOLVED_ROOT_HEAD_HASH", mut((s) => { s.planInputs.head.blockHash = "UNRESOLVED_ROOT_HEAD_HASH"; }), "root_inputs_unresolved", (j) => j.detail.paths.join() === "spec.planInputs.head.blockHash");
refused("six unresolved root fields at once (C, H, clockId, native factories, window.toUtc, maxTotalBytes)", mut((s) => { s.planInputs.checkpoint.blockNumber = null; s.planInputs.head.blockNumber = "UNRESOLVED"; s.contract.observationClock.clockId = null; s.contract.comparison.native.factories = null; s.filterSpec.window.toUtc = "UNRESOLVED_ROOT_TO_UTC"; s.captureLimits.maxTotalBytes = null; }), "root_inputs_unresolved", (j) => j.detail.paths.length === 6);
refused("missing contract.subjects", mut((s) => { delete s.contract.subjects; }), "spec_missing_field");
refused("missing captureLimits", mut((s) => { delete s.captureLimits; }), "spec_missing_field");
refused("caller-supplied planInputs.manifest (pins are derived from the compile only)", mut((s) => { s.planInputs.manifest = { fileSha256: "0".repeat(64), manifestSha256: "0".repeat(64) }; }), "spec_unknown_field");
refused("unknown top-level field endpoint", mut((s) => { s.endpoint = "http://x/"; }), "spec_unknown_field");
refused("duplicate key", null, "spec_refused", () => true, { args: ["--spec", put(null, '{"schema":"a","schema":"b"}\n'), "--components", CO, "--out", path.join(W, `o${n++}`)] });
refused("wrong schema", mut((s) => { s.schema = "backfill-capture-compose-input/0"; }), "spec_schema_mismatch");
refused("compile: PoolManager Swap topic changed", mut((s) => { s.filterSpec.poolManager.topics.Swap = `0x${"0".repeat(64)}`; }), "compile_refused");
refused("compile: five factories", mut((s) => { s.filterSpec.factories.pop(); }), "compile_refused");
refused("plan: checkpoint.manifestSha256 not the compiled manifest", mut((s) => { s.planInputs.checkpoint.manifestSha256 = "0".repeat(64); }), "plan_refused");
refused("plan: head before checkpoint (pinned plan.mjs plans UNKNOWN_NEEDS_RECONCILIATION, not a refusal)", mut((s) => { s.planInputs.head.blockNumber = 999; }), "capture_preflight_refused", (j) => j.detail.reason === "plan_not_capturable" && j.detail.detail.status === "UNKNOWN_NEEDS_RECONCILIATION");
refused("capture preflight: 8-call plan (H=1250, L=64) over maxCalls 5", mut((s) => { s.planInputs.head.blockNumber = 1250; s.planInputs.lookbackBlocks = 64; s.contract.window = { fromBlock: 937, toBlock: 1250 }; }), "capture_preflight_refused", (j) => j.detail.reason === "call_budget_exceeds_limit");
refused("capture preflight: removedLogsSeen -> UNKNOWN_NEEDS_RECONCILIATION", mut((s) => { s.planInputs.evidence.removedLogsSeen = true; }), "capture_preflight_refused", (j) => j.detail.reason === "plan_not_capturable");
refused("capture preflight: plan maxCalls 3 truncates 4 calls", mut((s) => { s.planInputs.caps.maxCalls = 3; s.contract.caps.plan.maxCalls = 3; }), "capture_preflight_refused", (j) => j.detail.reason === "plan_not_capturable");
refused("capture preflight: paceMs 1249", mut((s) => { s.captureLimits.paceMs = 1249; }), "capture_preflight_refused");
refused("capture preflight: maxCalls 6", mut((s) => { s.captureLimits.maxCalls = 6; }), "capture_preflight_refused");
refused("capture preflight: maxTotalBytes above plan maxBytes", mut((s) => { s.captureLimits.maxTotalBytes = 50000001; }), "capture_preflight_refused");
refused("contract: window toBlock 1099", mut((s) => { s.contract.window.toBlock = 1099; }), "contract_not_consistent", (j) => j.detail.notPassing.some((c) => c.id === "plan.factories_covers_window_exactly"));
refused("contract: narrow Launched-only direct.factories", mut((s) => { s.contract.comparison.direct.factories.topics = ["0x207384e895174175cc774fe7f7457b37c382f27ebf53d37d5257b862f80eaf9c"]; }), "contract_not_consistent", (j) => j.detail.notPassing.some((c) => c.id === "comparison.direct.factories"));
refused("contract: native PoolManager Swap only", mut((s) => { s.contract.comparison.native.poolmanager.topics = [[s.contract.comparison.native.poolmanager.topics[0][0]]]; }), "contract_not_consistent", (j) => j.detail.notPassing.some((c) => c.id === "comparison.native.poolmanager"));
refused("contract: backfill subject == live subject", mut((s) => { s.contract.subjects.backfill = s.contract.subjects.live; }), "contract_not_consistent");
refused("contract: observation fromUtc differs from manifest window", mut((s) => { s.contract.observationClock.fromUtc = "2000-01-01T00:00:01Z"; }), "contract_not_consistent");
refused("contract: comparison caps differ", mut((s) => { s.contract.caps.comparison.maxRawEvents = 999; }), "contract_not_consistent");

// E. components and output containment
const BAD = path.join(W, "components-bad");
fs.cpSync(CO, BAD, { recursive: true });
fs.appendFileSync(path.join(BAD, "backfill-plan/plan.mjs"), "\n");
refused("modified plan.mjs component", SPEC, "component_hash_mismatch", (j) => j.detail.component === "plan", { components: BAD });
const BAD2 = path.join(W, "components-bad2");
fs.cpSync(CO, BAD2, { recursive: true });
fs.rmSync(path.join(BAD2, "backfill-receipts/verify.mjs"));
refused("missing verify.mjs component", SPEC, "component_missing", (j) => j.detail.component === "verify", { components: BAD2 });
const BAD3 = path.join(W, "components-bad3");
fs.cpSync(CO, BAD3, { recursive: true });
fs.rmSync(path.join(BAD3, "full-coverage-filter-contract/check.mjs"));
fs.symlinkSync(path.join(CO, "full-coverage-filter-contract/check.mjs"), path.join(BAD3, "full-coverage-filter-contract/check.mjs"));
refused("symlinked check.mjs component", SPEC, "component_is_symlink", () => true, { components: BAD3 });
const EX = path.join(W, "exists"); fs.mkdirSync(EX);
{ const r = compose(SPEC, { out: EX }); check("refuse existing --out -> capture_preflight_refused out_dir_exists, exit 2, directory left empty", r.rc === 2 && r.j?.detail?.reason === "out_dir_exists" && fs.readdirSync(EX).length === 0, r.j); }
fs.mkdirSync(path.join(W, "real")); fs.symlinkSync(path.join(W, "real"), path.join(W, "lnk"));
refused("--out under a symlinked parent", SPEC, "capture_preflight_refused", (j) => j.detail.reason === "out_parent_symlink", { out: path.join(W, "lnk/out") });
refused("--out with a missing parent", SPEC, "capture_preflight_refused", (j) => j.detail.reason === "out_parent_missing", { out: path.join(W, "nope/out") });
for (const [nm, a, reason] of [["missing --components", ["--spec", SPEC, "--out", path.join(W, "x1")], "cli_missing_argument"], ["duplicate --spec", ["--spec", SPEC, "--spec", SPEC, "--components", CO, "--out", path.join(W, "x2")], "cli_duplicate_argument"], ["unknown --endpoint", ["--spec", SPEC, "--components", CO, "--out", path.join(W, "x3"), "--endpoint", "http://127.0.0.1:1/"], "cli_unknown_argument"]]) {
  const r = compose(null, { args: a });
  check(`refuse ${nm} -> ${reason}`, r.rc === 2 && r.j?.refused === reason, r.j);
}

// F. write path (fault injection in this harness only)
{ const r = compose(SPEC, { fault: "short" }); check("write: every writeSync capped at 8 B -> COMPOSED, all files byte-identical to the normal run", r.rc === 0 && FILES.every((f) => Buffer.compare(rd(r.out, f), rd(A.out, f)) === 0), r.j); }
{ const r = compose(SPEC, { fault: "eio:contract.json" }); check("write: EIO on contract.json -> exit 5 WRITE_FAILED, stage write, 5 earlier files persisted exact, no handoff.json", r.rc === 5 && r.j.status === "WRITE_FAILED" && r.j.writeFailure.file === "contract.json" && r.j.writeFailure.stage === "write" && r.j.persisted.length === 5 && r.j.persisted.every((f) => Buffer.compare(rd(r.out, f), rd(A.out, f)) === 0) && !fs.existsSync(path.join(r.out, "handoff.json")) && r.j.handoffPersisted === false, r.j); }

// G. static
const src = fs.readFileSync(path.join(HERE, "compose.mjs"), "utf8");
const banned = ["node:http", "node:https", "node:net", "node:child_process", "fetch(", "process.env", "Date", "performance", "readdir", "opendir", "unlink", "rmSync", "rename", "setTimeout", "httpTransport", ".capture(", "git "];
check("static: compose.mjs has no network, child process, env, clock, scan, delete or capture-transport call", banned.every((b) => !src.includes(b)), banned.filter((b) => src.includes(b)));
check("static: the only capture export used is preflight; the only plan export besides plan() is strictParse", (src.match(/C\.capture\.\w+/g) ?? []).every((x) => x === "C.capture.preflight") && (src.match(/C\.plan\.\w+/g) ?? []).every((x) => ["C.plan.plan", "C.plan.strictParse"].includes(x)));
check("static: fixture unchanged", sha(fs.readFileSync(SPEC)) === sha(Buffer.from(`${JSON.stringify(base, null, 2)}\n`)));

const pass = results.filter((r) => r.pass).length, fail = results.length - pass;
fs.writeFileSync(path.join(HERE, "evidence/results.json"), `${JSON.stringify({ pass, fail, cases: results }, null, 1)}\n`);
for (const f of FILES) fs.copyFileSync(path.join(A.out, f), path.join(HERE, "evidence/composed", f));
process.stdout.write(`${pass} PASS, ${fail} FAIL\n`);
fs.rmSync(W, { recursive: true, force: true });
process.exitCode = fail === 0 ? 0 : 1;

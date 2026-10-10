// Synthetic acceptance cases for plan.mjs. Offline, deterministic (no timing). Writes evidence/results.json; stdout is test.out.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonical } from "./plan.mjs";

const HERE = path.resolve(".");
const W = "work";
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const MAN = "fixtures/manifest.synthetic.json";
const manText = fs.readFileSync(MAN, "utf8");
const specText = fs.readFileSync("fixtures/spec.synthetic.json", "utf8");
const fixBefore = [sha(manText), sha(specText)];
const results = [];
let pass = 0, fail = 0, k = 0;
const check = (name, ok, expected, actual) => { results.push({ case: name, ok, expected, actual }); if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const run = (args, cwd = HERE) => { const r = spawnSync(process.execPath, [path.join(HERE, "plan.mjs"), ...args], { encoding: "utf8", cwd }); let out = null; try { out = JSON.parse(r.stdout); } catch {} return { rc: r.status, stdout: r.stdout, stderr: r.stderr, out }; };
const put = (text) => { const p = path.join(HERE, W, `f${++k}.json`); fs.writeFileSync(p, text); return p; };
const base = () => JSON.parse(specText);
const P = (spec, man = MAN) => run(["--spec", put(typeof spec === "string" ? spec : JSON.stringify(spec)), "--manifest", man]);
const mut = (f) => { const s = base(); f(s); return s; };
const H1 = `0x${"1".repeat(64)}`, H3 = `0x${"3".repeat(64)}`;

const ok = P(specText);
const p = ok.out;
const exp = [["overlap", 937, 1000], ["gap", 1001, 1100], ["gap", 1101, 1200], ["gap", 1201, 1250]].flatMap(([s, a, b]) => ["poolmanager.initialize_swap", "o1.factories.raw_all_topics"].map((id) => [s, id, a, b]));
check("clean checkpoint C=1000, head H=1250, L=64, chunk 100: PLANNED, overlap [937,1000] + gap [1001,1250] in 4 ranges x 2 filtersets = 8 calls in order",
  ok.rc === 0 && ok.stderr === "" && p.status === "PLANNED" && canonical(p.calls.map((c) => [c.segment, c.filtersetId, c.fromBlock, c.toBlock])) === canonical(exp), exp, p?.calls?.map((c) => [c.segment, c.filtersetId, c.fromBlock, c.toBlock]));
const man = JSON.parse(manText);
check("each call is an inert eth_getLogs with the manifest filter verbatim + hex fromBlock/toBlock; provenance backfill:true live:false",
  p.calls.every((c) => { const f = man.filtersets.find((x) => x.id === c.filtersetId); const { fromBlock, toBlock, ...rest } = c.request.params[0]; return c.request.method === "eth_getLogs" && canonical(rest) === canonical(f.filter) && fromBlock === `0x${c.fromBlock.toString(16)}` && toBlock === `0x${c.toBlock.toString(16)}` && c.filterSha256 === f.filterSha256 && canonical(c.publicationProvenance) === '{"backfill":true,"live":false}' && c.toBlock - c.fromBlock + 1 <= 100; }),
  "all", p.calls[0]);
check("separate backfill subject: name UNADOPTED, mustDifferFromLiveSubject; resumeLive not allowed, candidate H+1=1251",
  p.backfillSubject.mustDifferFromLiveSubject === true && /^UNADOPTED/.test(p.backfillSubject.name) && p.resumeLive.allowed === false && p.resumeLive.candidateFromBlock === 1251, "as stated", { s: p.backfillSubject, r: p.resumeLive });
check("claims: binding UNKNOWN, canonicality UNVERIFIED_CALLER_SUPPLIED, admission NOT_ESTABLISHED, completeness/latency NOT_MEASURED; head and evidence marked unverified",
  canonical(p.claims) === canonical({ binding: "UNKNOWN", canonicality: "UNVERIFIED_CALLER_SUPPLIED", sourceAdmission: "NOT_ESTABLISHED", completeness: "NOT_MEASURED", latency: "NOT_MEASURED" }) && p.inputs.head.verification === "UNVERIFIED_CALLER_SUPPLIED" && p.inputs.evidence.verification === "UNVERIFIED_CALLER_SUPPLIED", "as stated", p.claims);
const body = { ...p }; delete body.planSha256;
check("planSha256 recomputes; specSha256 is the spec file sha; output canonical", p.planSha256 === sha(canonical(body)) && p.inputs.specSha256 === sha(specText) && ok.stdout === `${canonical(p)}\n`, "match", p.planSha256);
const again = P(specText);
const abs = run(["--spec", path.join(HERE, "fixtures/spec.synthetic.json"), "--manifest", path.join(HERE, MAN)], "/");
check("deterministic: rerun byte-identical; run with cwd=/ and absolute paths byte-identical", again.stdout === ok.stdout && abs.stdout === ok.stdout && abs.stderr === "", "identical", { rerun: again.stdout === ok.stdout, cwdRoot: abs.stdout === ok.stdout });

const st = (name, spec, status, reasons, extra = () => true) => { const r = P(spec); check(`${name}: exit 0 ${status} ${reasons.join(",")}`, r.rc === 0 && r.stderr === "" && r.out?.status === status && canonical(r.out?.reasons) === canonical(reasons) && extra(r.out), { status, reasons }, { rc: r.rc, status: r.out?.status, reasons: r.out?.reasons, refused: r.out?.refused }); };
const noCalls = (o) => o.callCount === 0 && o.resumeLive.candidateFromBlock === null;
st("non-advancing head H=C same hash", mut((s) => { s.head.blockNumber = 1000; s.head.blockHash = H1; }), "PLANNED", [], (o) => o.span.nonAdvancingHead && o.span.gap === null && o.callCount === 2);
st("H=C different hash", mut((s) => { s.head.blockNumber = 1000; }), "UNKNOWN_NEEDS_RECONCILIATION", ["head_hash_conflict_at_checkpoint_height"], noCalls);
st("stale head below checkpoint", mut((s) => { s.head.blockNumber = 999; }), "UNKNOWN_NEEDS_RECONCILIATION", ["head_below_checkpoint"], noCalls);
st("head observed before checkpoint recorded", mut((s) => { s.head.observedAtUtc = "1999-12-31T23:59:59Z"; }), "UNKNOWN_NEEDS_RECONCILIATION", ["head_observed_before_checkpoint_recorded"], noCalls);
st("checkpoint hash evidence missing", mut((s) => { s.evidence.checkpointBlockHashAtHead = null; }), "UNKNOWN_NEEDS_RECONCILIATION", ["checkpoint_hash_evidence_missing"], noCalls);
st("checkpoint hash conflict (reorg at/below C)", mut((s) => { s.evidence.checkpointBlockHashAtHead = H3; }), "UNKNOWN_NEEDS_RECONCILIATION", ["checkpoint_hash_conflict"], noCalls);
st("removed/re-add ambiguity (removedLogsSeen true)", mut((s) => { s.evidence.removedLogsSeen = true; }), "UNKNOWN_NEEDS_RECONCILIATION", ["removed_readd_ambiguity"], noCalls);
st("removed-log evidence missing (null)", mut((s) => { s.evidence.removedLogsSeen = null; }), "UNKNOWN_NEEDS_RECONCILIATION", ["removed_logs_evidence_missing"], noCalls);
st("several ambiguities reported together", mut((s) => { s.evidence.checkpointBlockHashAtHead = null; s.evidence.removedLogsSeen = true; s.head.blockNumber = 999; }), "UNKNOWN_NEEDS_RECONCILIATION", ["checkpoint_hash_evidence_missing", "removed_readd_ambiguity", "head_below_checkpoint"], noCalls);
st("gap above maxGapBlocks (1001 > 1000)", mut((s) => { s.head.blockNumber = 2001; }), "GAP_EXCEEDS_CAP", ["gap_exceeds_maxGapBlocks"], (o) => noCalls(o) && o.span === null);
st("gap exactly maxGapBlocks", mut((s) => { s.head.blockNumber = 2000; s.caps.maxCalls = 100; }), "PLANNED", [], (o) => o.calls.at(-1).toBlock === 2000 && o.callCount === 22);
st("call budget truncation (maxCalls 5 of 8)", mut((s) => { s.caps.maxCalls = 5; }), "TRUNCATED_CALL_BUDGET", ["calls_exceed_maxCalls"], (o) => o.callCount === 5 && o.plannedCallsBeforeBudget === "8" && o.truncated && canonical(o.uncovered) === canonical({ firstUncoveredFilterset: "o1.factories.raw_all_topics", firstUncoveredRange: { segment: "gap", fromBlock: 1101, toBlock: 1200 }, fromBlock: 1101, toBlock: 1250 }) && o.resumeLive.candidateFromBlock === null);
st("lookback clipped at genesis (C=10, L=64)", mut((s) => { s.checkpoint.blockNumber = 10; s.head.blockNumber = 20; }), "PLANNED", [], (o) => o.span.overlap.fromBlock === 0 && o.span.overlap.clippedAtGenesis && o.calls[0].fromBlock === 0);
st("chunk size 1 respects maxChunkBlocks", mut((s) => { s.head.blockNumber = 1002; s.lookbackBlocks = 1; s.caps.maxChunkBlocks = 1; }), "PLANNED", [], (o) => o.callCount === 6 && o.calls.every((c) => c.fromBlock === c.toBlock));

const ref = (name, r, reason) => check(`refuse ${name}: exit 2 ${reason}`, r.rc === 2 && r.out?.refused === reason && r.stderr === "" && r.stdout.split("\n").length === 2, { rc: 2, refused: reason }, { rc: r.rc, refused: r.out?.refused, stderr: r.stderr });
ref("wrong chain (head chainId 1)", P(mut((s) => { s.head.source.chainId = 1; })), "chain_mismatch");
ref("wrong chain (checkpoint chainId 1)", P(mut((s) => { s.checkpoint.source.chainId = 1; })), "chain_mismatch");
ref("checkpoint from another source", P(mut((s) => { s.checkpoint.source.sourceId = "synthetic-source-b"; })), "checkpoint_source_mismatch");
ref("head from another source", P(mut((s) => { s.head.source.sourceId = "synthetic-source-b"; })), "head_source_mismatch");
ref("checkpoint recorded under another filter manifest", P(mut((s) => { s.checkpoint.manifestSha256 = "0".repeat(64); })), "checkpoint_filter_identity_mismatch");
ref("spec+checkpoint pin another manifestSha256", P(mut((s) => { s.checkpoint.manifestSha256 = s.manifest.manifestSha256 = "0".repeat(64); })), "filter_identity_mismatch");
ref("manifest file altered", P(specText, put(manText.replace("NOT_ESTABLISHED", "ESTABLISHED"))), "manifest_file_hash_mismatch");
const pretty = `${JSON.stringify(man, null, 1)}\n`;
ref("non-canonical manifest bytes (pinned)", P(mut((s) => { s.manifest.fileSha256 = sha(pretty); }), put(pretty)), "manifest_noncanonical");
const forged = `${canonical({ ...man, status: { ...man.status, sourceAdmission: "ESTABLISHED" } })}\n`;
ref("manifest self-hash broken (canonical, pinned)", P(mut((s) => { s.manifest.fileSha256 = sha(forged); }), put(forged)), "manifest_self_hash_mismatch");
const badF = structuredClone(man); badF.filtersets[0].filter.address = ["0x0000000000000000000000000000000000000001"]; const bodyF = { ...badF }; delete bodyF.manifestSha256; const badText = `${canonical({ ...bodyF, manifestSha256: sha(canonical(bodyF)) })}\n`;
ref("manifest filter edited without filterSha256", P(mut((s) => { s.manifest.fileSha256 = sha(badText); s.manifest.manifestSha256 = s.checkpoint.manifestSha256 = JSON.parse(badText).manifestSha256; }), put(badText)), "manifest_filter_hash_mismatch");
ref("duplicate JSON key in spec", P(specText.replace('"lookbackBlocks": 64,', '"lookbackBlocks": 64, "lookbackBlocks": 1,')), "json_duplicate_key");
ref("malformed spec JSON", P("{"), "json_malformed");
ref("unknown spec field", P(mut((s) => { s.expectedLogs = 1; })), "spec_unknown_field");
ref("missing evidence", P(mut((s) => { delete s.evidence; })), "spec_missing_field");
ref("wrong schema", P(mut((s) => { s.schema = "x"; })), "spec_schema_mismatch");
ref("uppercase block hash", P(mut((s) => { s.checkpoint.blockHash = `0x${"A".repeat(64)}`; })), "value_invalid");
ref("negative blockNumber", P(mut((s) => { s.head.blockNumber = -1; })), "value_invalid");
ref("fractional blockNumber", P(mut((s) => { s.head.blockNumber = 1250.5; })), "value_invalid");
ref("blockNumber 2^53", P(mut((s) => { s.head.blockNumber = 2 ** 53; })), "value_invalid");
ref("head blockNumber 2^53-1 (H+1 unsafe)", P(mut((s) => { s.head.blockNumber = Number.MAX_SAFE_INTEGER; })), "value_invalid");
ref("checkpoint blockNumber 2^53-1", P(mut((s) => { s.checkpoint.blockNumber = Number.MAX_SAFE_INTEGER; })), "value_invalid");
ref("maxCalls above ceiling 10000", P(mut((s) => { s.caps.maxCalls = 10001; })), "value_invalid");
ref("blockNumber as hex string", P(mut((s) => { s.head.blockNumber = "0x4e2"; })), "value_invalid");
ref("lookback 0", P(mut((s) => { s.lookbackBlocks = 0; })), "value_invalid");
ref("lookback above maxGapBlocks", P(mut((s) => { s.lookbackBlocks = 1001; })), "value_invalid");
ref("maxCalls 0", P(mut((s) => { s.caps.maxCalls = 0; })), "value_invalid");
ref("maxBytes missing", P(mut((s) => { delete s.caps.maxBytes; })), "spec_missing_field");
ref("removedLogsSeen string", P(mut((s) => { s.evidence.removedLogsSeen = "no"; })), "value_invalid");
ref("timestamp with offset", P(mut((s) => { s.head.observedAtUtc = "2000-01-01T00:10:00+00:00"; })), "value_invalid");
ref("timestamp calendar invalid", P(mut((s) => { s.checkpoint.recordedAtUtc = "2000-02-30T00:00:00Z"; })), "value_invalid");
fs.symlinkSync("../fixtures/spec.synthetic.json", `${W}/link.json`);
ref("spec is a symlink", run(["--spec", `${W}/link.json`, "--manifest", MAN]), "spec_is_symlink");
ref("manifest missing", run(["--spec", "fixtures/spec.synthetic.json", "--manifest", `${W}/absent.json`]), "manifest_missing");
ref("no arguments", run([]), "usage");
ref("duplicate --spec", run(["--spec", "fixtures/spec.synthetic.json", "--spec", "fixtures/spec.synthetic.json"]), "usage_duplicate_argument");
ref("unknown --execute", run(["--spec", "fixtures/spec.synthetic.json", "--manifest", MAN, "--execute", "1"]), "usage");

// boundedness (A5 c1): root's exact 32 MiB reproduction, imported, spec passed as JSON.stringify bytes
const MAX = Number.MAX_SAFE_INTEGER;
const big = mut((s) => { s.checkpoint.blockNumber = 1000; s.head.blockNumber = 501000; s.lookbackBlocks = 1; s.caps.maxGapBlocks = 500000; s.caps.maxChunkBlocks = 1; s.caps.maxCalls = 1; });
const imp = (planPath, spec) => { const sp = put(JSON.stringify(spec)); const r = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", `import fs from "node:fs"; import { plan } from ${JSON.stringify(planPath)}; process.stdout.write(plan(Buffer.from(fs.readFileSync(process.argv[1], "utf8")), fs.readFileSync(process.argv[2])));`, sp, path.join(HERE, MAN)], { encoding: "utf8", maxBuffer: 1 << 26 }); let out = null; try { out = JSON.parse(r.stdout); } catch {} return { rc: r.status, signal: r.signal, out, bytes: r.stdout.length, stderrHead: r.stderr.split("\n").find((l) => /heap|memory/i.test(l)) ?? null }; };
const lz = imp(path.join(HERE, "plan.mjs"), big);
check("root repro C=1000 H=501000 L=1 maxGap 500000 chunk 1 maxCalls 1 under --max-old-space-size=32: exit 0 TRUNCATED_CALL_BUDGET, 1 call, planned 1000002 (500001 ranges x 2), first uncovered o1.factories [1000,1000], uncovered to 501000",
  lz.rc === 0 && lz.out?.status === "TRUNCATED_CALL_BUDGET" && lz.out.callCount === 1 && lz.out.plannedCallsBeforeBudget === "1000002" && canonical(lz.out.rangesBeforeBudget) === '{"gap":"500000","overlap":"1"}'
    && lz.out.calls[0].filtersetId === "poolmanager.initialize_swap" && lz.out.calls[0].fromBlock === 1000 && lz.out.calls[0].toBlock === 1000
    && canonical(lz.out.uncovered) === canonical({ firstUncoveredFilterset: "o1.factories.raw_all_topics", firstUncoveredRange: { segment: "overlap", fromBlock: 1000, toBlock: 1000 }, fromBlock: 1000, toBlock: 501000 }),
  { rc: 0, planned: "1000002", callCount: 1 }, { rc: lz.rc, status: lz.out?.status, planned: lz.out?.plannedCallsBeforeBudget, uncovered: lz.out?.uncovered });
const ctl = imp(path.join(HERE, "plan.mjs"), base());
check("32 MiB fixture control (current plan.mjs): exit 0 PLANNED 8 calls", ctl.rc === 0 && ctl.out?.status === "PLANNED" && ctl.out.callCount === 8, { rc: 0 }, { rc: ctl.rc, status: ctl.out?.status });
fs.mkdirSync(`${W}/e1d8346`);
fs.writeFileSync(`${W}/e1d8346/plan.mjs`, spawnSync("git", ["show", "e1d8346fd08a879dff860c77ebd3938c792ef0d4:measurements/backfill-plan/plan.mjs"], { encoding: "utf8" }).stdout);
const old = imp(path.join(HERE, W, "e1d8346/plan.mjs"), big);
check("pre-correction e1d8346 plan.mjs, same 32 MiB repro: no plan (heap OOM), reproducing the A5 failure", old.rc !== 0 && old.out === null && old.stderrHead !== null, { rc: "!=0", heap: true }, { rc: old.rc, signal: old.signal, stderr: old.stderrHead });

// integer-edge vectors near 2^53
st("C=0 H=2^53-2 maxGap 2^53-1 chunk 1 maxCalls 1: exact planned count 2*(2^53-1) as decimal string", mut((s) => { s.checkpoint.blockNumber = 0; s.head.blockNumber = MAX - 1; s.lookbackBlocks = 1; s.caps.maxGapBlocks = MAX; s.caps.maxChunkBlocks = 1; s.caps.maxCalls = 1; }), "TRUNCATED_CALL_BUDGET", ["calls_exceed_maxCalls"],
  (o) => o.plannedCallsBeforeBudget === "18014398509481982" && o.rangesBeforeBudget.gap === "9007199254740990" && o.callCount === 1 && o.uncovered.toBlock === MAX - 1 && o.span.gap.blocks === MAX - 1);
st("H=2^53-2, C=H-10, chunk 2^53-1: 2 ranges, last toBlock 2^53-2 exact, candidate H+1 = 2^53-1", mut((s) => { s.checkpoint.blockNumber = MAX - 11; s.head.blockNumber = MAX - 1; s.lookbackBlocks = 1; s.caps.maxGapBlocks = MAX; s.caps.maxChunkBlocks = MAX; s.caps.maxCalls = 4; }), "PLANNED", [],
  (o) => o.callCount === 4 && o.calls[2].fromBlock === MAX - 10 && o.calls[3].toBlock === MAX - 1 && o.calls[3].request.params[0].toBlock === "0x1ffffffffffffe" && o.resumeLive.candidateFromBlock === MAX);
st("non-advancing at C=H=2^53-2", mut((s) => { s.checkpoint.blockNumber = MAX - 1; s.head.blockNumber = MAX - 1; s.head.blockHash = H1; s.lookbackBlocks = 3; }), "PLANNED", [], (o) => o.callCount === 2 && o.calls[0].fromBlock === MAX - 3 && o.calls[0].toBlock === MAX - 1 && o.resumeLive.candidateFromBlock === MAX);
st("lookback 2^53-1 clips at genesis", mut((s) => { s.lookbackBlocks = MAX; s.caps.maxGapBlocks = MAX; s.caps.maxCalls = 100; }), "PLANNED", [], (o) => o.span.overlap.fromBlock === 0 && o.span.overlap.clippedAtGenesis && o.calls[0].fromBlock === 0 && o.calls[0].toBlock === 99);
const cap = mut((s) => { s.checkpoint.blockNumber = 0; s.head.blockNumber = MAX - 1; s.caps.maxGapBlocks = MAX; s.caps.maxChunkBlocks = 1; s.caps.maxCalls = 10000; });
const cr = imp(path.join(HERE, "plan.mjs"), cap);
check("output bound: maxCalls at ceiling 10000 over a 2^53-2 gap under 32 MiB: exit 0, 10000 calls, stdout bytes recorded", cr.rc === 0 && cr.out?.callCount === 10000 && cr.out.status === "TRUNCATED_CALL_BUDGET", { rc: 0, callCount: 10000 }, { rc: cr.rc, callCount: cr.out?.callCount, stdoutBytes: cr.bytes });

const code = fs.readFileSync("plan.mjs", "utf8");
const banned = ["node:net", "node:http", "node:https", "node:dns", "node:child_process", "node:worker_threads", "fetch(", "WebSocket", "Date.now", "new Date()", "performance", "hrtime", "writeFile", "appendFile", "rmSync", "unlink", "rename", "truncateSync", "mkdir", "symlinkSync", "process.env", "readdir", "opendir"];
const hits = banned.filter((b) => code.includes(b));
check("static: no network/process/clock/write/env/directory-scan APIs (T7 unreadable: plan.mjs opens only --spec and --manifest) in plan.mjs", hits.length === 0, [], hits);
check("fixtures unchanged by the run", sha(fs.readFileSync(MAN)) === fixBefore[0] && sha(fs.readFileSync("fixtures/spec.synthetic.json")) === fixBefore[1], fixBefore, "same");
fs.rmSync(W, { recursive: true, force: true });
fs.writeFileSync("evidence/results.json", `${JSON.stringify({ note: "synthetic acceptance cases only; not canonicality, completeness, delivery, latency or source-admission evidence", pass, fail, results }, null, 2)}\n`);
console.log(`${pass} PASS, ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;

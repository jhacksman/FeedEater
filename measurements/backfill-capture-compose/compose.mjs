#!/usr/bin/env node
// Offline composition of capture inputs. Runs the pinned, hash-checked filter-manifest compile (42185f2), backfill plan
// (a345d48), capture C1 preflight (56f8f3b) and full-coverage contract check (d568aee) on one explicit root spec, and
// emits their exact bytes with hashes and the documented commands. Never runs transport, reads the environment or a
// clock, or fills a value the spec does not supply.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INPUT_SCHEMA = "backfill-capture-compose-input/1";
export const HANDOFF_SCHEMA = "backfill-capture-compose-handoff/1";
export const COMPONENTS = Object.freeze({
  compile: { file: "filter-manifest/compile.mjs", sha256: "a01e632ea490479b517ca676d8664e15920e633e977dd2d6c844f3019d55c903", commit: "42185f2170fb68e5d55b5e8507f480229f58b4df" },
  keccak: { file: "filter-manifest/keccak.mjs", sha256: "f2cd3d33fe6ec210ff085f5de7b7e24b7a228775ad3e7fc015712614530df142", commit: "42185f2170fb68e5d55b5e8507f480229f58b4df" },
  plan: { file: "backfill-plan/plan.mjs", sha256: "c527e1808fcd4efa00a34a0c1dd957bffa8d56adadb584d056babe8084edcf7a", commit: "a345d48a2f003348d3fe21910518ec1e6e54db35" },
  capture: { file: "backfill-receipt-capture/capture.mjs", sha256: "d2c1395331150c50bdee6a0bec6c7a1fb94f90499b8923b0dcb152a15ac93e9a", commit: "56f8f3bcc072f86d13b55f34f6f3632bd142f6ba" },
  check: { file: "full-coverage-filter-contract/check.mjs", sha256: "d1d450d3f48846e897b46cd8540a25131310fa1de1b2108b43c784591c75e416", commit: "d568aee4779d648f669753a009e564ed2be4d456" },
  verify: { file: "backfill-receipts/verify.mjs", sha256: "0eb02c033103a13053b5797614dedf8724c686f24d42bdf3f476fc1f303fda56", commit: "83aec5d72f6712711b5f22ef29777858c5b797e0" },
});
const SOURCES = "filter-manifest/sources/aromer-5669951";
// Never contacted: capture preflight validates URL syntax only and records its sha; it is not emitted.
const PREFLIGHT_ENDPOINT = "http://127.0.0.1:1/preflight-only";

export class Refusal extends Error {
  constructor(reason, detail = {}) { super(reason); this.reason = reason; this.detail = detail; }
}
const refuse = (reason, detail = {}) => { throw new Refusal(reason, detail); };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

function readNoFollow(p, where) {
  let st;
  try { st = fs.lstatSync(p); } catch { refuse(`${where}_missing`, {}); }
  if (st.isSymbolicLink()) refuse(`${where}_is_symlink`, {});
  if (!st.isFile()) refuse(`${where}_not_file`, {});
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

export async function loadComponents(dir) {
  const root = path.resolve(dir);
  for (const [name, c] of Object.entries(COMPONENTS)) {
    const p = path.join(root, c.file);
    let buf;
    try { buf = readNoFollow(p, "component"); } catch (e) { if (e instanceof Refusal) refuse(e.reason, { component: name, file: c.file }); throw e; }
    if (sha256(buf) !== c.sha256) refuse("component_hash_mismatch", { component: name, file: c.file, expected: c.sha256, actual: sha256(buf) });
  }
  const imp = (n) => import(pathToFileURL(path.join(root, COMPONENTS[n].file)).href);
  const [compile, plan, capture, check] = await Promise.all(["compile", "plan", "capture", "check"].map(imp));
  return { root, compile, plan, capture, check, sources: path.join(root, SOURCES) };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function shape(o, keys, where) {
  if (!isObj(o)) refuse("spec_not_object", { where });
  for (const k of Object.keys(o)) if (!keys.includes(k)) refuse("spec_unknown_field", { where: `${where}.${k}` });
  for (const k of keys) if (!Object.hasOwn(o, k)) refuse("spec_missing_field", { where: `${where}.${k}` });
}
// Every null or UNRESOLVED* leaf anywhere in the root spec, listed together; nothing is defaulted.
function unresolved(v, where, out) {
  if (v === null) out.push(where);
  else if (typeof v === "string" && /UNRESOLVED/.test(v)) out.push(where);
  else if (Array.isArray(v)) v.forEach((x, i) => unresolved(x, `${where}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) unresolved(x, `${where}.${k}`, out);
  return out;
}
const stage = (name, f) => {
  try { return f(); } catch (e) { if (e instanceof Refusal || typeof e?.reason === "string") refuse(`${name}_refused`, { reason: e.reason, detail: e.detail ?? {} }); throw e; }
};
const refusedOut = (name, text) => { const j = JSON.parse(text); if (Object.hasOwn(j, "refused")) refuse(`${name}_refused`, { reason: j.refused, detail: j.detail ?? {} }); return j; };
const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;

// Composes everything in memory; returns the exact file bytes. Throws Refusal before any output.
export function compose(C, specBuf, out) {
  const spec = stage("spec", () => C.plan.strictParse(specBuf, "spec"));
  shape(spec, ["schema", "filterSpec", "planInputs", "captureLimits", "contract"], "spec");
  if (spec.schema !== INPUT_SCHEMA) refuse("spec_schema_mismatch", { expected: INPUT_SCHEMA });
  shape(spec.planInputs, ["source", "checkpoint", "head", "evidence", "lookbackBlocks", "caps"], "planInputs");
  shape(spec.contract, ["window", "caps", "comparison", "observationClock", "subjects"], "contract");
  const missing = unresolved(spec, "spec", []);
  if (missing.length) refuse("root_inputs_unresolved", { paths: missing });
  const files = {};
  files["filter-spec.json"] = Buffer.from(pretty(spec.filterSpec));
  files["manifest.json"] = Buffer.from(stage("compile", () => C.compile.compile(files["filter-spec.json"], C.sources)));
  const man = JSON.parse(files["manifest.json"].toString("utf8"));
  const manPin = { fileSha256: sha256(files["manifest.json"]), manifestSha256: man.manifestSha256 };
  files["plan-spec.json"] = Buffer.from(pretty({ schema: "backfill-plan-input/1", manifest: manPin, ...spec.planInputs }));
  const planText = stage("plan", () => C.plan.plan(files["plan-spec.json"], files["manifest.json"]));
  refusedOut("plan", planText);
  files["plan.json"] = Buffer.from(planText);
  const plan = JSON.parse(planText);
  const planPin = { fileSha256: sha256(files["plan.json"]), planSha256: plan.planSha256 };
  files["capture-spec.json"] = Buffer.from(pretty({ schema: "backfill-receipt-capture-input/1", manifest: manPin, plan: planPin, limits: spec.captureLimits }));
  stage("capture_preflight", () => C.capture.preflight(files["capture-spec.json"], files["manifest.json"], files["plan.json"], PREFLIGHT_ENDPOINT, out));
  const lane = (id) => man.filtersets.find((f) => f.id === id)?.filterSha256 ?? null;
  files["contract.json"] = Buffer.from(pretty({ schema: "full-coverage-filter-contract-input/1", manifest: manPin, plan: planPin, window: spec.contract.window, caps: spec.contract.caps, lanes: { poolmanager: { filterSha256: lane("poolmanager.initialize_swap") }, factories: { filterSha256: lane("o1.factories.raw_all_topics") } }, comparison: spec.contract.comparison, observationClock: spec.contract.observationClock, subjects: spec.contract.subjects }));
  const rep = stage("contract_check", () => C.check.check(files["contract.json"], files["manifest.json"], files["plan.json"]));
  if (rep.verdict !== "CONTRACT_CONSISTENT") refuse("contract_not_consistent", { verdict: rep.verdict, notPassing: rep.checks.filter((c) => c.status !== "PASS").map((c) => ({ id: c.id, status: c.status })) });
  files["verify-spec.template.json"] = Buffer.from(pretty({ schema: "backfill-receipt-verify-input/1", manifest: manPin, plan: planPin, receipts: { fileSha256: "UNRESOLVED_AFTER_CAPTURE_RECEIPTS_JSON_SHA256" } }));
  const comp = (n) => `"$COMPONENTS/${COMPONENTS[n].file}"`;
  const handoff = {
    schema: HANDOFF_SCHEMA,
    components: Object.fromEntries(Object.entries(COMPONENTS).map(([k, c]) => [k, { ...c }])),
    files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, { sha256: sha256(b), bytes: b.length }])),
    manifest: manPin,
    plan: { ...planPin, status: plan.status, truncated: plan.truncated, callCount: plan.callCount, calls: plan.calls.map((c) => ({ index: c.index, filtersetId: c.filtersetId, fromBlock: c.fromBlock, toBlock: c.toBlock })) },
    contract: { verdict: rep.verdict, reportSha256: rep.reportSha256 },
    captureLimits: spec.captureLimits,
    commands: {
      cwd: "this output directory; COMPONENTS, ROOT_ENDPOINT and ROOT_CAPTURE_OUT are root-supplied shell variables",
      rebuildManifest: `node ${comp("compile")} --spec filter-spec.json --sources "$COMPONENTS/${SOURCES}" | cmp - manifest.json`,
      rebuildPlan: `node ${comp("plan")} --spec plan-spec.json --manifest manifest.json | cmp - plan.json`,
      checkContract: `node ${comp("check")} --contract contract.json --manifest manifest.json --plan plan.json`,
      capture: `node ${comp("capture")} --spec capture-spec.json --manifest manifest.json --plan plan.json --endpoint "$ROOT_ENDPOINT" --out "$ROOT_CAPTURE_OUT"`,
      verifySpec: "copy verify-spec.template.json to verify-spec.json and set receipts.fileSha256 = sha256 of $ROOT_CAPTURE_OUT/receipts.json",
      verify: `node ${comp("verify")} --spec verify-spec.json --manifest manifest.json --plan plan.json --receipts "$ROOT_CAPTURE_OUT/receipts.json"`,
    },
    rootInputsStillRequired: ["COMPONENTS", "ROOT_ENDPOINT", "ROOT_CAPTURE_OUT (new directory)", "verify-spec.json receipts.fileSha256 (after capture)"],
    transportExecuted: false,
    publicationProvenance: { backfill: true, live: false },
    resumeLive: { permitted: false },
    claims: { sourceAdmission: "NOT_ESTABLISHED", completeness: "NOT_MEASURED", delivery: "NOT_MEASURED", latency: "NOT_MEASURED", oneClock: "NOT_ESTABLISHED", q1: "UNADOPTED", q2: "UNADOPTED" },
  };
  files["handoff.json"] = Buffer.from(pretty(handoff));
  return files;
}

export class WriteFailure extends Error {
  constructor(file, st, written, code) { super(st); this.file = file; this.stage = st; this.written = written; this.code = code; }
}
function writeExclusive(dir, name, buf) {
  let fd;
  try { fd = fs.openSync(path.join(dir, name), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (e) { throw new WriteFailure(name, "open", 0, e.code ?? "error"); }
  let off = 0;
  try {
    while (off < buf.length) {
      let w;
      try { w = fs.writeSync(fd, buf, off, buf.length - off, off); } catch (e) { throw new WriteFailure(name, "write", off, e.code ?? "error"); }
      if (!Number.isSafeInteger(w) || w <= 0 || w > buf.length - off) throw new WriteFailure(name, "write_no_progress", off, null);
      off += w;
    }
    try { fs.fsyncSync(fd); } catch (e) { throw new WriteFailure(name, "fsync", off, e.code ?? "error"); }
    const back = Buffer.alloc(buf.length + 1);
    let got = 0;
    try { for (let r; got < back.length && (r = fs.readSync(fd, back, got, back.length - got, got)) > 0;) got += r; }
    catch (e) { throw new WriteFailure(name, "readback", off, e.code ?? "error"); }
    if (got !== buf.length || Buffer.compare(back.subarray(0, got), buf) !== 0) throw new WriteFailure(name, "readback_mismatch", off, null);
  } finally { fs.closeSync(fd); }
}

export function emit(out, files) {
  try { fs.mkdirSync(out, { mode: 0o700 }); } catch (e) { refuse("out_dir_create_failed", { code: e.code ?? "error" }); }
  const persisted = [];
  for (const [name, buf] of Object.entries(files)) {
    try { writeExclusive(out, name, buf); persisted.push(name); }
    catch (e) { if (!(e instanceof WriteFailure)) throw e; return { status: "WRITE_FAILED", persisted, writeFailure: { file: e.file, stage: e.stage, bytesWritten: e.written, code: e.code }, handoffPersisted: false }; }
  }
  return { status: "COMPOSED", persisted, writeFailure: null, handoffPersisted: true };
}

async function main(argv) {
  const want = ["--spec", "--components", "--out"];
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!want.includes(k)) refuse("cli_unknown_argument", { arg: k });
    if (Object.hasOwn(a, k)) refuse("cli_duplicate_argument", { arg: k });
    if (typeof v !== "string" || v.startsWith("--")) refuse("cli_missing_value", { arg: k });
    a[k] = v;
  }
  const miss = want.filter((k) => !Object.hasOwn(a, k));
  if (miss.length) refuse("cli_missing_argument", { missing: miss });
  const C = await loadComponents(a["--components"]);
  const out = path.resolve(a["--out"]);
  const files = compose(C, readNoFollow(a["--spec"], "spec"), out);
  const r = emit(out, files);
  return { ...r, files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha256(b)])), transportExecuted: false };
}

const code = { COMPOSED: 0, WRITE_FAILED: 5 };
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((r) => { process.stdout.write(`${JSON.stringify(r)}\n`); process.exitCode = code[r.status]; }, (e) => {
    if (e instanceof Refusal) { process.stdout.write(`${JSON.stringify({ refused: e.reason, detail: e.detail })}\n`); process.exitCode = 2; }
    else { process.stdout.write(`${JSON.stringify({ refused: "internal_error", detail: { m: String(e?.message ?? e) } })}\n`); process.exitCode = 4; }
  });
}

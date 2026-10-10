// Synthetic acceptance cases for compile.mjs. Offline; uses only the vendored retained sources and fixtures/.
// Deterministic: no timing, no clock. Writes evidence/results.json; stdout is test.out.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { keccak256Hex } from "./keccak.mjs";
import { PIN } from "./compile.mjs";

const SRC = "sources/aromer-5669951";
const W = "work";
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hashDir = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, sha(fs.readFileSync(path.join(d, f)))]));
const srcBefore = hashDir(SRC);
const fixtureBefore = sha(fs.readFileSync("fixtures/spec.synthetic.json"));
const results = [];
let pass = 0;
let fail = 0;
function check(name, ok, expected, actual) {
  results.push({ case: name, ok, expected, actual });
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
let k = 0;
function run(args) {
  const r = spawnSync(process.execPath, ["compile.mjs", ...args], { encoding: "utf8" });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr, out };
}
const specText = fs.readFileSync("fixtures/spec.synthetic.json", "utf8");
const base = () => JSON.parse(specText);
function withSpec(textOrObj, extra = []) {
  const p = `${W}/spec${++k}.json`;
  fs.writeFileSync(p, typeof textOrObj === "string" ? textOrObj : JSON.stringify(textOrObj));
  return run(["--spec", p, ...extra]);
}
function srcCopy(mut) {
  const d = `${W}/src${++k}`;
  fs.cpSync(SRC, d, { recursive: true });
  mut(d);
  return d;
}

// keccak vectors and declared topic recomputation
check("keccak256 vectors: '' and Transfer(address,address,uint256)",
  keccak256Hex("") === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" && keccak256Hex("Transfer(address,address,uint256)") === "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  "known vectors", { empty: keccak256Hex(""), transfer: keccak256Hex("Transfer(address,address,uint256)") });
check("keccak256 of declared signatures equals the user-supplied topic0 pins",
  `0x${keccak256Hex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")}` === "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" && `0x${keccak256Hex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")}` === "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "equal", "computed");
check("vendored source files match the pinned sha256 (incl. invalid checkpoint HTML)",
  Object.values(PIN.files).every((f) => srcBefore[f.file] === f.sha256) && Object.keys(srcBefore).length === 4, Object.fromEntries(Object.values(PIN.files).map((f) => [f.file, f.sha256])), srcBefore);

// valid compile
const ok = withSpec(specText);
const m = ok.out;
const fsById = Object.fromEntries((m?.filtersets ?? []).map((x) => [x.id, x]));
const pm = fsById["poolmanager.initialize_swap"];
const fac = fsById["o1.factories.raw_all_topics"];
const SIX = ["0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64", "0xa52ad458ce0282a971ecc71c051a32f28946bb9f", "0x1de58a6769526a03a504d9d59b8757cd8097dc57", "0xff70918ef17a2d74d683a8297813b177bafad1f4", "0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc", "0xb9e5910043353717af54d8dd34b6ee57ffe49c35"];
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((x) => `${JSON.stringify(x)}:${canon(v[x])}`).join(",")}}` : JSON.stringify(v));
check("valid synthetic spec compiles: exit 0, exactly 2 filtersets", ok.rc === 0 && ok.stderr === "" && m?.filtersets?.length === 2 && pm !== undefined && fac !== undefined, { rc: 0, filtersets: 2 }, { rc: ok.rc, filtersets: m?.filtersets?.length, stderr: ok.stderr });
check("PoolManager filter: one address, topic0 OR [Swap, Initialize] (sorted), no other topic positions",
  canon(pm?.filter) === canon({ address: ["0x498581ff718922c3f8e6a244956af099b2652b2b"], topics: [["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"]] }),
  "address+[[swap,initialize]]", pm?.filter);
check("PoolManager declaration provenance: constants.py l.79 address, l.236-237 Initialize, l.240-241 Swap, md l.84,133",
  pm?.declaration?.address?.constantsLine === 79 && canon(pm?.declaration?.Initialize?.lines) === "[236,237]" && canon(pm?.declaration?.Swap?.lines) === "[240,241]" && canon(pm?.declaration?.address?.productionContractsMdLines) === "[84,133]", "as stated", pm?.declaration);
check("factories filter: exactly the six census rows (sorted), no topics key (all topics), no pool list",
  canon(fac?.filter) === canon({ address: [...SIX].sort() }), [...SIX].sort(), fac?.filter);
check("row 6 supportGap absent_from_production_contracts_md; rows 1-5 found in md; every row binding UNKNOWN",
  fac?.rows?.length === 6 && fac.rows[5].supportGap === "absent_from_production_contracts_md" && fac.rows.slice(0, 5).every((r) => r.supportGap === null && r.productionContractsMdLines.length > 0) && fac.rows.every((r) => r.binding === "UNKNOWN"),
  "row6 gap only", fac?.rows?.map((r) => ({ row: r.row, lines: r.productionContractsMdLines, gap: r.supportGap })));
check("status: binding UNKNOWN, sourceAdmission NOT_ESTABLISHED, delivery/latency NOT_MEASURED; lanes NOT_RUN",
  canon(m?.status) === canon({ binding: "UNKNOWN", sourceAdmission: "NOT_ESTABLISHED", delivery: "NOT_MEASURED", latency: "NOT_MEASURED" }) && /^NOT_RUN/.test(m?.comparison?.lanes?.direct) && /^NOT_RUN/.test(m?.comparison?.lanes?.native),
  "as stated", { status: m?.status, lanes: m?.comparison?.lanes });
check("comparison carries caller window and caps verbatim; no volume estimate field",
  m?.comparison?.window?.durationS === 3600 && m?.comparison?.caps?.maxRawEvents === 1000 && m?.comparison?.caps?.maxBytes === 1000000 && !/expected_?scale|estimat(ed|e_)/i.test(Object.keys(m?.comparison ?? {}).join(",")),
  { durationS: 3600, maxRawEvents: 1000, maxBytes: 1000000 }, { window: m?.comparison?.window, caps: m?.comparison?.caps });
check("checkpoint HTML recorded as INVALID evidence with its sha; gaps listed",
  m?.sources?.files?.some((f) => f.key === "suitesCheckpoint" && f.sha256 === "d019f01a9132cd93da42c11646066f476a65e45ee8ccdab68f1ae12e2123612f" && /INVALID/.test(f.role)) && m?.gaps?.length === 4,
  "INVALID + 4 gaps", { gaps: m?.gaps });
const body = { ...m }; delete body.manifestSha256;
check("filterSha256 and manifestSha256 recompute from canonical JSON",
  pm?.filterSha256 === sha(canon(pm?.filter)) && fac?.filterSha256 === sha(canon(fac?.filter)) && m?.manifestSha256 === sha(canon(body)), "match", { pm: pm?.filterSha256, fac: fac?.filterSha256, manifest: m?.manifestSha256 });
const again = withSpec(specText);
const perm = base();
perm.factories.reverse();
const permText = `{"caps":${JSON.stringify(perm.caps)},"window":${JSON.stringify(perm.window)},\n "factories":${JSON.stringify(perm.factories)},"poolManager":{"topics":{"Swap":"${perm.poolManager.topics.Swap}","Initialize":"${perm.poolManager.topics.Initialize}"},"address":"${perm.poolManager.address}"},"sourcePin":${JSON.stringify(perm.sourcePin)},"schema":"${perm.schema}"}`;
const p2 = withSpec(permText);
check("deterministic: rerun byte-identical; key order, whitespace and factory order permuted -> byte-identical manifest",
  again.stdout === ok.stdout && p2.stdout === ok.stdout && ok.stdout.endsWith("\n"), "identical", { rerunSame: again.stdout === ok.stdout, permutedSame: p2.stdout === ok.stdout });

// refusals
const R = [];
const ref = (name, r, reason) => R.push({ name, rc: r.rc, refused: r.out?.refused, reason, stderr: r.stderr, lines: r.stdout.split("\n").length });
const mut = (f) => { const s = base(); f(s); return s; };
ref("malformed JSON", withSpec("{"), "json_malformed");
ref("trailing data", withSpec(`${specText} x`), "json_malformed");
ref("invalid UTF-8", withSpec(Buffer.from([0x7b, 0xff, 0x7d]).toString("latin1")), "json_malformed");
ref("duplicate key caps", withSpec(specText.replace(/\n}\s*$/, ',\n  "caps": { "maxRawEvents": 5, "maxBytes": 5 }\n}\n')), "json_duplicate_key");
ref("__proto__ key", withSpec(specText.replace('"schema"', '"__proto__": {}, "schema"')), "json_forbidden_key");
ref("unknown top-level field", withSpec(mut((s) => { s.expectedVolume = 1; })), "spec_unknown_field");
ref("missing window", withSpec(mut((s) => { delete s.window; })), "spec_missing_field");
ref("wrong schema", withSpec(mut((s) => { s.schema = "filter-manifest-input/0"; })), "spec_schema_mismatch");
ref("other source commit", withSpec(mut((s) => { s.sourcePin.commit = "bd853e281ebf0f65de246f8720e71f9b1369bbd8"; })), "source_pin_mismatch");
ref("PoolManager address checksum-case", withSpec(mut((s) => { s.poolManager.address = "0x498581fF718922c3f8e6A244956aF099B2652b2b"; })), "address_malformed");
ref("PoolManager other address", withSpec(mut((s) => { s.poolManager.address = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; })), "pool_manager_mismatch");
ref("Initialize topic wrong (ModifyLiquidity topic0)", withSpec(mut((s) => { s.poolManager.topics.Initialize = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"; })), "topic_mismatch");
ref("Initialize/Swap swapped", withSpec(mut((s) => { const t = s.poolManager.topics; [t.Initialize, t.Swap] = [t.Swap, t.Initialize]; })), "topic_mismatch");
ref("topic 63 hex", withSpec(mut((s) => { s.poolManager.topics.Swap = s.poolManager.topics.Swap.slice(0, -1); })), "topic_malformed");
ref("extra topic key", withSpec(mut((s) => { s.poolManager.topics.Donate = "0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb"; })), "spec_unknown_field");
ref("missing suite row 6 (5 factories)", withSpec(mut((s) => { s.factories.pop(); })), "missing_suite_row");
ref("no factories", withSpec(mut((s) => { s.factories = []; })), "missing_suite_row");
ref("7 factories (row 1 twice)", withSpec(mut((s) => { s.factories.push({ ...s.factories[0] }); })), "factory_row_duplicate");
ref("row 6 given row 1 address", withSpec(mut((s) => { s.factories[5].address = s.factories[0].address; })), "factory_address_duplicate");
ref("row 7", withSpec(mut((s) => { s.factories[5].row = 7; })), "factory_row_invalid");
ref("row as string", withSpec(mut((s) => { s.factories[0].row = "1"; })), "factory_row_invalid");
ref("row 3 wrong address (hook address)", withSpec(mut((s) => { s.factories[2].address = "0xbca7774615c74b7991a111f1c7b2d0efea61aacc"; })), "factory_mismatch");
ref("factories not array", withSpec(mut((s) => { s.factories = { 1: s.factories[0] }; })), "spec_malformed");
ref("factory extra field", withSpec(mut((s) => { s.factories[0].pools = []; })), "spec_unknown_field");
ref("window to == from", withSpec(mut((s) => { s.window.toUtc = s.window.fromUtc; s.window.durationS = 0; })), "window_invalid");
ref("window to before from", withSpec(mut((s) => { [s.window.fromUtc, s.window.toUtc] = [s.window.toUtc, s.window.fromUtc]; })), "window_invalid");
ref("window durationS mismatch", withSpec(mut((s) => { s.window.durationS = 3601; })), "window_invalid");
ref("window fractional durationS", withSpec(mut((s) => { s.window.durationS = 3600.5; })), "window_invalid");
ref("window non-Z offset", withSpec(mut((s) => { s.window.fromUtc = "2000-01-01T00:00:00+00:00"; })), "window_invalid");
ref("window fractional seconds", withSpec(mut((s) => { s.window.fromUtc = "2000-01-01T00:00:00.000Z"; })), "window_invalid");
ref("window calendar 2000-02-30", withSpec(mut((s) => { s.window.fromUtc = "2000-02-30T00:00:00Z"; })), "window_invalid");
ref("window missing durationS", withSpec(mut((s) => { delete s.window.durationS; })), "spec_missing_field");
ref("cap 0", withSpec(mut((s) => { s.caps.maxRawEvents = 0; })), "cap_invalid");
ref("cap negative", withSpec(mut((s) => { s.caps.maxBytes = -1; })), "cap_invalid");
ref("cap fractional", withSpec(mut((s) => { s.caps.maxBytes = 1.5; })), "cap_invalid");
ref("cap string", withSpec(mut((s) => { s.caps.maxRawEvents = "1000"; })), "cap_invalid");
ref("cap above 2^53-1", withSpec(mut((s) => { s.caps.maxBytes = 2 ** 53; })), "cap_invalid");
ref("cap missing maxBytes", withSpec(mut((s) => { delete s.caps.maxBytes; })), "spec_missing_field");
const sp = `${W}/good.json`; fs.writeFileSync(sp, specText);
ref("census one byte altered", run(["--spec", sp, "--sources", srcCopy((d) => { const f = `${d}/o1-census-contract-20261010.json`; const b = fs.readFileSync(f); b[100] ^= 1; fs.writeFileSync(f, b); })]), "source_hash_mismatch");
ref("constants.py missing", run(["--spec", sp, "--sources", srcCopy((d) => fs.rmSync(`${d}/constants.py`))]), "source_constants_missing");
ref("checkpoint HTML replaced by valid JSON", run(["--spec", sp, "--sources", srcCopy((d) => fs.writeFileSync(`${d}/launch-contract-suites.checkpoint-html.INVALID`, "{\"schemaVersion\":1}"))]), "source_hash_mismatch");
ref("production-contracts md missing", run(["--spec", sp, "--sources", srcCopy((d) => fs.rmSync(`${d}/production-contracts.md`))]), "source_productionContractsMd_missing");
ref("census is a symlink", run(["--spec", sp, "--sources", srcCopy((d) => { fs.renameSync(`${d}/o1-census-contract-20261010.json`, `${d}/c.json`); fs.symlinkSync("c.json", `${d}/o1-census-contract-20261010.json`); })]), "source_census_is_symlink");
fs.symlinkSync("good.json", `${W}/link.json`);
ref("spec is a symlink", run(["--spec", `${W}/link.json`]), "spec_is_symlink");
ref("spec missing", run(["--spec", `${W}/absent.json`]), "spec_missing");
ref("no arguments", run([]), "usage");
ref("duplicate --spec", run(["--spec", sp, "--spec", sp]), "usage_duplicate_argument");
ref("unknown argument", run(["--spec", sp, "--rpc", "x"]), "usage");
for (const x of R) check(`refuse ${x.name}: exit 2 ${x.reason}`, x.rc === 2 && x.refused === x.reason && x.stderr === "" && x.lines === 2, { rc: 2, refused: x.reason }, { rc: x.rc, refused: x.refused, stderr: x.stderr });

// static: offline, no clock, no writes, checkpoint never parsed
const code = fs.readFileSync("compile.mjs", "utf8") + fs.readFileSync("keccak.mjs", "utf8");
const banned = ["node:net", "node:http", "node:https", "node:dns", "node:child_process", "node:worker_threads", "fetch(", "WebSocket", "Date.now", "new Date()", "performance", "hrtime", "writeFile", "appendFile", "rmSync", "unlink", "rename", "truncate", "mkdir", "cpSync", "symlinkSync", "src.suitesCheckpoint"];
const hits = banned.filter((b) => code.includes(b));
check("static: no network/process/clock/write APIs; checkpoint bytes only hashed (src.suitesCheckpoint never read)", hits.length === 0, [], hits);
const srcAfter = hashDir(SRC);
check("vendored sources and fixture unchanged by the run", canon(srcAfter) === canon(srcBefore) && sha(fs.readFileSync("fixtures/spec.synthetic.json")) === fixtureBefore, srcBefore, srcAfter);

fs.rmSync(W, { recursive: true, force: true });
fs.writeFileSync("evidence/results.json", `${JSON.stringify({ note: "synthetic acceptance cases only; not delivery, latency, completeness or source-admission evidence", pass, fail, results }, null, 2)}\n`);
console.log(`${pass} PASS, ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;

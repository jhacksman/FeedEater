#!/usr/bin/env node
// Offline subscription-filter manifest compiler. Reads only pinned retained source files and one caller spec;
// writes nothing; no network, RPC, subscription, clock or process calls. See README.md.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak256Hex } from "./keccak.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIN = Object.freeze({
  repo: "jhacksman/aromer",
  commit: "5669951760682d1046d109a3f489b61f770cf0c2",
  files: Object.freeze({
    census: { file: "o1-census-contract-20261010.json", repoPath: "docs/realignment/o1-census-contract-20261010.json", sha256: "efda199ea09fabf1f8250ea5a15fb611e36bb088fc4e07ba8004132b8142cff8", role: "canonical six-row factory allowlist (factories rows 1-6)" },
    constants: { file: "constants.py", repoPath: "aromer/core/constants.py", sha256: "b7d7801149635e65592e0e10159c9dc23f0c0ebb30a8c717f88f00e286a07391", role: "declared topic pin (l.236-241) and PoolManager address (l.79)" },
    productionContractsMd: { file: "production-contracts.md", repoPath: "docs/realignment/evidence/o1-attr4-2026-10-10/docs_o1_exchange_launchpad_reference_production-contracts_md", sha256: "b0f53ce4c745407aac8bb42aadc43450e36ffa204c0cf37f8128efd1eff4e4fc", role: "supporting retained docs snapshot (address occurrence only)" },
    suitesCheckpoint: { file: "launch-contract-suites.checkpoint-html.INVALID", repoPath: "docs/realignment/evidence/o1-attr4-2026-10-10/launch_o1_exchange_launch-contract-suites_json", sha256: "d019f01a9132cd93da42c11646066f476a65e45ee8ccdab68f1ae12e2123612f", role: "INVALID evidence: HTTP 429 Vercel Security Checkpoint HTML; hashed only, never parsed" },
  }),
  topicLines: Object.freeze([236, 241]),
  poolManagerLine: 79,
});
export const INPUT_SCHEMA = "filter-manifest-input/1";
export const OUTPUT_SCHEMA = "filter-manifest/1";

export class Refusal extends Error {
  constructor(reason, detail = {}) { super(reason); this.reason = reason; this.detail = detail; }
}
const refuse = (reason, detail) => { throw new Refusal(reason, detail); };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// Strict JSON: refuses duplicate keys, __proto__, trailing data and invalid UTF-8.
export function strictParse(buf, where) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { refuse("json_malformed", { where, m: "utf8" }); }
  let i = 0;
  const STR = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const LIT = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const fail = (m) => refuse("json_malformed", { where, at: i, m });
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const tok = (re) => { re.lastIndex = i; const m = re.exec(text); if (m === null) return null; i = re.lastIndex; return JSON.parse(m[0]); };
  const val = (depth) => {
    if (depth > 64) fail("depth");
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o = {}; ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("key");
        const k = tok(STR); if (k === null) fail("key");
        if (k === "__proto__") refuse("json_forbidden_key", { where, key: k });
        if (Object.hasOwn(o, k)) refuse("json_duplicate_key", { where, key: k });
        ws(); if (text[i] !== ":") fail("colon"); i++;
        o[k] = val(depth + 1); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("object");
      }
    }
    if (c === "[") {
      i++; const a = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) { a.push(val(depth + 1)); ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; } fail("array"); }
    }
    const v = c === '"' ? tok(STR) : tok(LIT);
    if (v === null) fail("value");
    return v;
  };
  const v = val(0); ws();
  if (i !== text.length) fail("trailing");
  return v;
}

function readFileNoFollow(p, what) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { refuse(e.code === "ENOENT" ? `${what}_missing` : e.code === "ELOOP" ? `${what}_is_symlink` : `${what}_open_${e.code}`, { path: p }); }
  try {
    if (!fs.fstatSync(fd).isFile()) refuse(`${what}_not_regular_file`, { path: p });
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function loadSources(dir) {
  const out = {};
  for (const [key, f] of Object.entries(PIN.files)) {
    const buf = readFileNoFollow(path.join(dir, f.file), `source_${key}`);
    const h = sha256(buf);
    if (h !== f.sha256) refuse("source_hash_mismatch", { source: key, expected: f.sha256, actual: h });
    out[key] = buf;
  }
  return out;
}

const ADDR = /^0x[0-9a-f]{40}$/;
const TOPIC = /^0x[0-9a-f]{64}$/;

export function deriveFactories(buf) {
  const d = strictParse(buf, "census");
  const f = d?.factories;
  if (f === null || typeof f !== "object" || Array.isArray(f)) refuse("census_factories_invalid", {});
  const keys = Object.keys(f).sort();
  if (canonical(keys) !== canonical(["1", "2", "3", "4", "5", "6"])) refuse("census_factories_invalid", { keys });
  return keys.map((k) => {
    const r = f[k];
    if (r === null || typeof r !== "object" || r.row !== Number(k) || typeof r.factory !== "string" || !ADDR.test(r.factory)) refuse("census_factories_invalid", { row: k });
    return { row: r.row, address: r.factory, census: `factories.${k}.factory` };
  });
}

export function deriveTopics(buf) {
  const lines = buf.toString("utf8").split("\n");
  const [a, b] = PIN.topicLines;
  const block = lines.slice(a - 1, b);
  const OPEN = /^\s*\("(v4_[a-z_]+)", "([A-Za-z][A-Za-z0-9]*\([a-z0-9,]*\))",\s*$/;
  const HEX = /^\s*"([0-9a-f]{64})", "V4 PoolManager"\),\s*$/;
  const decl = {};
  for (let j = 0; j < block.length; j += 2) {
    const o = OPEN.exec(block[j] ?? "");
    const h = HEX.exec(block[j + 1] ?? "");
    if (o === null || h === null) refuse("topic_declaration_unparseable", { line: a + j });
    const k = keccak256Hex(o[2]);
    if (k !== h[1]) refuse("topic_declaration_keccak_mismatch", { line: a + j, signature: o[2], declared: h[1], keccak256: k });
    decl[o[1]] = { signature: o[2], topic0: `0x${h[1]}`, lines: [a + j, a + j + 1] };
  }
  const I = decl.v4_initialize;
  const S = decl.v4_swap;
  if (I === undefined || S === undefined || !I.signature.startsWith("Initialize(") || !S.signature.startsWith("Swap(")) refuse("topic_declaration_missing", { found: Object.keys(decl) });
  return { Initialize: I, Swap: S };
}

export function derivePoolManager(constantsBuf, mdBuf) {
  const line = constantsBuf.toString("utf8").split("\n")[PIN.poolManagerLine - 1] ?? "";
  const m = /^UNISWAP_V4_POOL_MANAGER = _c\("Uniswap V4 PoolManager", "(0x[0-9a-fA-F]{40})",\s*$/.exec(line);
  if (m === null) refuse("pool_manager_declaration_unparseable", { line: PIN.poolManagerLine });
  const address = m[1].toLowerCase();
  return { address, constantsLine: PIN.poolManagerLine, productionContractsMdLines: mdLines(mdBuf, address) };
}

function mdLines(mdBuf, address) {
  const out = [];
  mdBuf.toString("utf8").split("\n").forEach((l, i) => { if (l.toLowerCase().includes(address)) out.push(i + 1); });
  return out;
}

function shape(o, keys, where) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) refuse("spec_malformed", { where, m: "not_object" });
  const have = Object.keys(o).sort();
  const want = [...keys].sort();
  const missing = want.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !want.includes(k));
  if (missing.length > 0) refuse("spec_missing_field", { where, missing });
  if (extra.length > 0) refuse("spec_unknown_field", { where, extra });
}

const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
function parseUtc(s, where) {
  const m = typeof s === "string" ? TS.exec(s) : null;
  if (m === null) refuse("window_invalid", { where, m: "format" });
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== se) refuse("window_invalid", { where, m: "calendar" });
  return ms;
}

export function validateSpec(spec, derived) {
  shape(spec, ["schema", "sourcePin", "poolManager", "factories", "window", "caps"], "spec");
  if (spec.schema !== INPUT_SCHEMA) refuse("spec_schema_mismatch", { expected: INPUT_SCHEMA });
  shape(spec.sourcePin, ["repo", "commit"], "sourcePin");
  if (spec.sourcePin.repo !== PIN.repo || spec.sourcePin.commit !== PIN.commit) refuse("source_pin_mismatch", { expected: { repo: PIN.repo, commit: PIN.commit } });

  shape(spec.poolManager, ["address", "topics"], "poolManager");
  if (typeof spec.poolManager.address !== "string" || !ADDR.test(spec.poolManager.address)) refuse("address_malformed", { where: "poolManager.address", m: "lowercase 0x + 40 hex" });
  if (spec.poolManager.address !== derived.poolManager.address) refuse("pool_manager_mismatch", { expected: derived.poolManager.address });
  shape(spec.poolManager.topics, ["Initialize", "Swap"], "poolManager.topics");
  for (const n of ["Initialize", "Swap"]) {
    const t = spec.poolManager.topics[n];
    if (typeof t !== "string" || !TOPIC.test(t)) refuse("topic_malformed", { where: n, m: "lowercase 0x + 64 hex" });
    if (t !== derived.topics[n].topic0) refuse("topic_mismatch", { where: n, expected: derived.topics[n].topic0 });
  }

  if (!Array.isArray(spec.factories)) refuse("spec_malformed", { where: "factories", m: "not_array" });
  const rows = new Set();
  const addrs = new Set();
  for (const [i, f] of spec.factories.entries()) {
    shape(f, ["row", "address"], `factories[${i}]`);
    if (!Number.isInteger(f.row) || f.row < 1 || f.row > 6) refuse("factory_row_invalid", { index: i });
    if (typeof f.address !== "string" || !ADDR.test(f.address)) refuse("address_malformed", { where: `factories[${i}].address`, m: "lowercase 0x + 40 hex" });
    if (rows.has(f.row)) refuse("factory_row_duplicate", { row: f.row });
    if (addrs.has(f.address)) refuse("factory_address_duplicate", { row: f.row });
    rows.add(f.row); addrs.add(f.address);
    const want = derived.factories[f.row - 1].address;
    if (f.address !== want) refuse("factory_mismatch", { row: f.row, expected: want });
  }
  const missing = [1, 2, 3, 4, 5, 6].filter((r) => !rows.has(r));
  if (missing.length > 0) refuse("missing_suite_row", { missing });

  shape(spec.window, ["fromUtc", "toUtc", "durationS"], "window");
  const a = parseUtc(spec.window.fromUtc, "fromUtc");
  const b = parseUtc(spec.window.toUtc, "toUtc");
  if (b <= a) refuse("window_invalid", { m: "toUtc_not_after_fromUtc" });
  if (!Number.isSafeInteger(spec.window.durationS) || spec.window.durationS !== (b - a) / 1000) refuse("window_invalid", { m: "durationS_mismatch", expected: (b - a) / 1000 });

  shape(spec.caps, ["maxRawEvents", "maxBytes"], "caps");
  for (const k of ["maxRawEvents", "maxBytes"]) if (!Number.isSafeInteger(spec.caps[k]) || spec.caps[k] < 1) refuse("cap_invalid", { cap: k });
}

export function compile(specBuf, sourcesDir) {
  const src = loadSources(sourcesDir);
  const derived = {
    factories: deriveFactories(src.census),
    topics: deriveTopics(src.constants),
    poolManager: derivePoolManager(src.constants, src.productionContractsMd),
  };
  const spec = strictParse(specBuf, "spec");
  validateSpec(spec, derived);

  const pmFilter = { address: [derived.poolManager.address], topics: [[derived.topics.Initialize.topic0, derived.topics.Swap.topic0].sort()] };
  const facFilter = { address: derived.factories.map((f) => f.address).sort() };
  const rows = derived.factories.map((f) => {
    const lines = mdLines(src.productionContractsMd, f.address);
    return { ...f, productionContractsMdLines: lines, supportGap: lines.length === 0 ? "absent_from_production_contracts_md" : null, binding: "UNKNOWN" };
  });
  const body = {
    schema: OUTPUT_SCHEMA,
    status: { binding: "UNKNOWN", sourceAdmission: "NOT_ESTABLISHED", delivery: "NOT_MEASURED", latency: "NOT_MEASURED" },
    sources: { repo: PIN.repo, commit: PIN.commit, files: Object.entries(PIN.files).map(([key, f]) => ({ key, repoPath: f.repoPath, file: f.file, sha256: f.sha256, role: f.role })) },
    filtersets: [
      { id: "poolmanager.initialize_swap", family: "poolmanager_topic0_or", filter: pmFilter, filterSha256: sha256(canonical(pmFilter)),
        declaration: { address: { constantsLine: derived.poolManager.constantsLine, productionContractsMdLines: derived.poolManager.productionContractsMdLines }, Initialize: derived.topics.Initialize, Swap: derived.topics.Swap } },
      { id: "o1.factories.raw_all_topics", family: "factories_raw_all_topics", filter: facFilter, filterSha256: sha256(canonical(facFilter)),
        topicsConstraint: "none: every log from these 6 addresses, no ABI/unknown-event exclusion, no pool list", rows },
    ],
    comparison: {
      rule: "direct and native observations are comparable only if both used byte-identical canonical filters (same filterSha256 per filterset), this window and these caps",
      window: { fromUtc: spec.window.fromUtc, toUtc: spec.window.toUtc, durationS: spec.window.durationS, owner: "root (caller-supplied; not validated against any clock)" },
      caps: { maxRawEvents: spec.caps.maxRawEvents, maxBytes: spec.caps.maxBytes, semantics: "caller-supplied stop limits per lane per filterset; not a volume estimate" },
      lanes: { direct: "NOT_RUN (root-owned)", native: "NOT_RUN (root-owned)" },
    },
    gaps: [
      "launch-contract-suites.json retained bytes are an HTTP 429 checkpoint HTML page: hashed as invalid evidence, never parsed",
      `factory row(s) ${rows.filter((r) => r.supportGap !== null).map((r) => r.row).join(",") || "none"} absent from the retained production-contracts md`,
      "topic0 pin is a retained declaration in constants.py, not a primary contract ABI; runtime binding not proven",
      "factory allowlist rows are retained census rows; on-chain binding UNKNOWN",
    ],
    notClaimed: "no subscription, RPC, node, network or clock use; no delivery, latency, completeness or source-admission evidence; no volume estimate",
  };
  const text = canonical(body);
  return `${canonical({ ...body, manifestSha256: sha256(text) })}\n`;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!["--spec", "--sources"].includes(k) || argv[i + 1] === undefined) refuse("usage", { usage: "node compile.mjs --spec <spec.json> [--sources <dir>]" });
    if (Object.hasOwn(args, k)) refuse("usage_duplicate_argument", { arg: k });
    args[k] = argv[i + 1];
  }
  if (args["--spec"] === undefined) refuse("usage", { usage: "node compile.mjs --spec <spec.json> [--sources <dir>]" });
  const specBuf = readFileNoFollow(args["--spec"], "spec");
  return compile(specBuf, args["--sources"] ?? path.join(HERE, "sources", "aromer-5669951"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stdout.write(`${canonical({ refused: e.reason, detail: e.detail })}\n`);
    process.exitCode = 2;
  }
}

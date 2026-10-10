// Offline acceptance for the portable capture kit. Builds from this checkout's local git objects, deploys a copy outside
// any git work tree, and runs the documented by-path commands from cwd=/ with synthetic declared inputs only.
// No transport anywhere: compose runs preflight only and capture/verify are never invoked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(HERE, "work");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const GIT = "/usr/bin/git";
const ROOT = spawnSync(GIT, ["rev-parse", "--show-toplevel"], { cwd: HERE }).stdout.toString().trim();
const GITDIR = path.resolve(ROOT, spawnSync(GIT, ["rev-parse", "--git-common-dir"], { cwd: ROOT }).stdout.toString().trim());
const show = (c, p) => spawnSync(GIT, ["show", `${c}:${p}`], { cwd: ROOT, maxBuffer: 1 << 28 }).stdout;
const COMPOSE_C1 = "7d06dde846d34cd62ffe51e669e29cc7d8d2f1a9";
const COMPOSE_FIRST = "7ee6ead759edfab38ba836d8eb6986dc9224e21d";
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W);
const T = fs.mkdtempSync(path.join(os.tmpdir(), "capture-kit-"));
const results = [];
const check = (name, ok, detail) => { results.push({ name, pass: !!ok }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)?.slice(0, 700)}`}\n`); };
let n = 0;
const FAULT = path.join(W, "fault.mjs");
fs.writeFileSync(FAULT, `import fs from "node:fs";
const [mode, target] = (process.env.KIT_FAULT ?? "").split(":");
const names = new Map(); const open = fs.openSync, write = fs.writeSync;
fs.openSync = (p, ...r) => { const fd = open(p, ...r); names.set(fd, String(p).split("/").pop()); return fd; };
fs.writeSync = (fd, buf, off, len, pos) => { const hit = target === undefined || names.get(fd) === target;
  if (hit && mode === "short") return write(fd, buf, off, Math.min(len, 7), pos);
  if (hit && mode === "eio") { const e = new Error("EIO"); e.code = "EIO"; throw e; }
  return write(fd, buf, off, len, pos); };
`);
const run = (script, args, { cwd = "/", env = {}, fault = null } = {}) => {
  const r = spawnSync(process.execPath, [...(fault ? ["--import", FAULT] : []), script, ...args], { cwd, env: fault ? { ...env, KIT_FAULT: fault } : env });
  let j = null; try { j = JSON.parse(r.stdout.toString()); } catch {}
  return { rc: r.status, j, err: r.stderr.toString() };
};
const BUILD = path.join(HERE, "build-kit.mjs"), CHECK = path.join(HERE, "check-kit.mjs");
const build = (out, { git = GIT, gitDir = GITDIR, fault = null, args = null } = {}) => ({ ...run(BUILD, args ?? ["--git", git, "--git-dir", gitDir, "--out", out], { fault }), out, exists: fs.existsSync(out) });
const checkKit = (k) => run(CHECK, ["--kit", k]);
const ls = (d) => { const o = []; const w = (r) => { for (const x of fs.readdirSync(path.join(d, r)).sort()) { const p = r ? `${r}/${x}` : x; fs.lstatSync(path.join(d, p)).isDirectory() ? w(p) : o.push(p); } }; w(""); return o; };
const same = (a, b) => { const la = ls(a), lb = ls(b); return la.join() === lb.join() && la.every((p) => Buffer.compare(fs.readFileSync(path.join(a, p)), fs.readFileSync(path.join(b, p))) === 0); };
const { FILES, COMMITS, KIT_PATHS, INDEX, SUMS } = await import("./kit.mjs");

// A. build from explicit local git objects
const K = path.join(W, "kit");
const A = build(K);
check("build: exit 0 BUILT, kitPersisted true, exactly 14 files (12 pinned + SHA256SUMS + KIT.json)", A.rc === 0 && A.j.status === "BUILT" && A.j.kitPersisted === true && ls(K).join() === KIT_PATHS.join(), A.j ?? A.err);
check("build: each of the 12 files equals `git show <commit>:<repoPath>` bytes and its pinned sha256 + blob id", FILES.every((f) => Buffer.compare(fs.readFileSync(path.join(K, f.path)), show(f.commit, f.repoPath)) === 0 && sha(fs.readFileSync(path.join(K, f.path))) === f.sha256 && spawnSync(GIT, ["rev-parse", `${f.commit}:${f.repoPath}`], { cwd: ROOT }).stdout.toString().trim() === f.blob));
check("build: every pinned commit resolves to its pinned tree in this repo", Object.entries(COMMITS).every(([c, v]) => spawnSync(GIT, ["rev-parse", `${c}^{tree}`], { cwd: ROOT }).stdout.toString().trim() === v.tree));
check("build: the six component shas equal compose C1 COMPONENTS pins; compose bytes equal 7d06dde; component bytes equal 7ee6ead's pins", (() => { const src = fs.readFileSync(path.join(K, "backfill-capture-compose/compose.mjs"), "utf8"); return FILES.filter((f) => !f.path.startsWith("backfill-capture-compose/") && !f.path.includes("/sources/")).every((f) => src.includes(f.sha256)) && Buffer.compare(fs.readFileSync(path.join(K, "backfill-capture-compose/compose.mjs")), show(COMPOSE_FIRST, "measurements/backfill-capture-compose/compose.mjs")) === 0; })());
check("build: stdout shas equal bytes on disk; KIT.json sha reported", KIT_PATHS.every((p) => A.j.files[p] === sha(fs.readFileSync(path.join(K, p)))) && A.j.kitJsonSha256 === sha(fs.readFileSync(path.join(K, INDEX))));
const A2 = build(path.join(W, "kit2"));
check("build: rebuild is byte-identical", A2.rc === 0 && same(K, A2.out));
check("build: no machine path in KIT.json or SHA256SUMS", ![INDEX, SUMS].some((p) => { const s = fs.readFileSync(path.join(K, p), "utf8"); return s.includes(ROOT) || s.includes(W) || s.includes(os.homedir()); }));
check("build: KIT.json inventory lists each file once with commit/tree/repoPath/blob/sha256/bytes", (() => { const j = JSON.parse(fs.readFileSync(path.join(K, INDEX))); return j.files.length === 12 && new Set(j.files.map((x) => x.path)).size === 12 && j.files.every((x) => COMMITS[x.sourceCommit].tree === x.sourceTree && x.mode === "100644") && j.sha256sums.sha256 === sha(fs.readFileSync(path.join(K, SUMS))) && j.transportExecuted === false; })());

// B. deploy outside any git work tree; offline by-path use from cwd=/
const D = path.join(T, "kit");
fs.cpSync(K, D, { recursive: true });
check("deploy: copy has no .git and is not inside a git work tree", !fs.existsSync(path.join(D, ".git")) && spawnSync(GIT, ["-C", D, "rev-parse", "--git-dir"], { env: { GIT_CEILING_DIRECTORIES: "/" } }).status !== 0);
const C0 = checkKit(D);
check("deploy: check-kit (empty env, cwd=/) -> KIT_VERIFIED 14 files, same KIT.json sha", C0.rc === 0 && C0.j.verdict === "KIT_VERIFIED" && C0.j.fileCount === 14 && C0.j.kitJsonSha256 === A.j.kitJsonSha256, C0.j);
const IDX = JSON.parse(fs.readFileSync(path.join(D, INDEX)));
const SHENV = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, KIT: D, KIT_TOOLS: HERE };
const nt = spawnSync("bash", ["-c", IDX.use.checkKitNoTools], { cwd: "/", env: SHENV });
check("deploy: KIT.json use.checkKitNoTools (sha256sum -c + exact count + no symlinks) exits 0", nt.status === 0, nt.stderr.toString());
const SPEC = path.join(T, "compose.synthetic.json");
fs.writeFileSync(SPEC, show(COMPOSE_C1, "measurements/backfill-capture-compose/fixtures/compose.synthetic.json"));
const OUT = path.join(T, "composed");
const cs = spawnSync("bash", ["-c", IDX.use.compose], { cwd: "/", env: { ...SHENV, ROOT_SPEC: SPEC, ROOT_COMPOSE_OUT: OUT } });
const csj = JSON.parse(cs.stdout.toString() || "null");
check("deploy: KIT.json use.compose (by path, cwd=/, no .git) -> exit 0 COMPOSED, handoffPersisted true, transportExecuted false", cs.status === 0 && csj?.status === "COMPOSED" && csj.handoffPersisted === true && csj.transportExecuted === false, csj ?? cs.stderr.toString());
const EV = "measurements/backfill-capture-compose/evidence/composed";
const OUTFILES = ["capture-spec.json", "contract.json", "filter-spec.json", "handoff.json", "manifest.json", "plan-spec.json", "plan.json", "verify-spec.template.json"];
check("deploy: all 8 composed files byte-identical to compose 7ee6ead/7d06dde evidence/composed (emitted hashes preserved)", fs.readdirSync(OUT).sort().join() === OUTFILES.join() && OUTFILES.every((f) => Buffer.compare(fs.readFileSync(path.join(OUT, f)), show(COMPOSE_FIRST, `${EV}/${f}`)) === 0 && Buffer.compare(show(COMPOSE_FIRST, `${EV}/${f}`), show(COMPOSE_C1, `${EV}/${f}`)) === 0));
const H = JSON.parse(fs.readFileSync(path.join(OUT, "handoff.json")));
const man = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json")));
const lanes = JSON.stringify(man);
check("deploy: manifest sha 3a5431c2 (42185f2 evidence); six-factory ALL-topics lane and Initialize/Swap OR retained", sha(fs.readFileSync(path.join(OUT, "manifest.json"))) === "3a5431c2e55a0a1f1b99d6c22b219febe47f2b0f5a10800abf8f80011484a527" && ["0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc", "0x1de58a6769526a03a504d9d59b8757cd8097dc57", "0xa52ad458ce0282a971ecc71c051a32f28946bb9f", "0xb9e5910043353717af54d8dd34b6ee57ffe49c35", "0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64", "0xff70918ef17a2d74d683a8297813b177bafad1f4"].every((a) => lanes.includes(a)) && lanes.includes("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f") && lanes.includes("0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"));
const hs = (cmd) => spawnSync("bash", ["-c", cmd], { cwd: OUT, env: { ...SHENV, COMPONENTS: D } });
check("deploy: handoff rebuildManifest with COMPONENTS=$KIT -> cmp exit 0", hs(H.commands.rebuildManifest).status === 0);
check("deploy: handoff rebuildPlan with COMPONENTS=$KIT -> cmp exit 0", hs(H.commands.rebuildPlan).status === 0);
const ck = hs(H.commands.checkContract); const ckj = JSON.parse(ck.stdout.toString() || "null");
check("deploy: handoff checkContract with COMPONENTS=$KIT -> CONTRACT_CONSISTENT 22/22, reportSha256 == handoff", ck.status === 0 && ckj?.verdict === "CONTRACT_CONSISTENT" && ckj.checks.length === 22 && ckj.reportSha256 === H.contract.reportSha256, ckj?.verdict);
const un = JSON.parse(fs.readFileSync(SPEC)); un.planInputs.head.blockHash = "UNRESOLVED_HEAD_HASH"; un.contract.subjects.backfill = null;
const UNSPEC = path.join(T, "unresolved.json"); fs.writeFileSync(UNSPEC, JSON.stringify(un));
const ur = spawnSync("bash", ["-c", IDX.use.compose], { cwd: "/", env: { ...SHENV, ROOT_SPEC: UNSPEC, ROOT_COMPOSE_OUT: path.join(T, "unresolved-out") } });
const urj = JSON.parse(ur.stdout.toString() || "null");
check("deploy: unresolved root inputs through the kit -> exit 2 root_inputs_unresolved (2 paths), no output", ur.status === 2 && urj?.refused === "root_inputs_unresolved" && urj.detail.paths.length === 2 && !fs.existsSync(path.join(T, "unresolved-out")), urj);
check("deploy: kit files unchanged after use (check-kit still KIT_VERIFIED)", checkKit(D).j?.verdict === "KIT_VERIFIED");

// C. offline check-kit refusals on mutated copies
const mk = (f) => { const d = path.join(T, `m${n++}`); fs.cpSync(K, d, { recursive: true }); f(d); return checkKit(d); };
const refusedAs = (r, reason, pred = () => true) => r.rc === 2 && r.j?.refused === reason && pred(r.j.detail);
check("check-kit: missing pinned file -> kit_inventory_mismatch missing", refusedAs(mk((d) => fs.rmSync(path.join(d, "backfill-plan/plan.mjs"))), "kit_inventory_mismatch", (x) => x.missing.join() === "backfill-plan/plan.mjs"));
check("check-kit: missing KIT.json (e.g. partial build) -> kit_inventory_mismatch", refusedAs(mk((d) => fs.rmSync(path.join(d, INDEX))), "kit_inventory_mismatch", (x) => x.missing.join() === INDEX));
check("check-kit: extra file (case-colliding Compile.mjs) -> kit_inventory_mismatch extra", refusedAs(mk((d) => fs.writeFileSync(path.join(d, "filter-manifest/Compile.mjs"), "x")), "kit_inventory_mismatch", (x) => x.extra.join() === "filter-manifest/Compile.mjs"));
check("check-kit: extra .git directory -> kit_inventory_mismatch extra", refusedAs(mk((d) => { fs.mkdirSync(path.join(d, ".git")); fs.writeFileSync(path.join(d, ".git/HEAD"), "ref"); }), "kit_inventory_mismatch", (x) => x.extra.join() === ".git/HEAD"));
check("check-kit: one dirty byte in capture.mjs -> kit_file_mismatch", refusedAs(mk((d) => { const p = path.join(d, "backfill-receipt-capture/capture.mjs"); const b = fs.readFileSync(p); b[100] ^= 1; fs.writeFileSync(p, b); }), "kit_file_mismatch", (x) => x.path === "backfill-receipt-capture/capture.mjs"));
check("check-kit: dirty source declaration constants.py -> kit_file_mismatch", refusedAs(mk((d) => fs.appendFileSync(path.join(d, "filter-manifest/sources/aromer-5669951/constants.py"), "\n")), "kit_file_mismatch"));
check("check-kit: modified KIT.json / SHA256SUMS -> kit_file_mismatch", refusedAs(mk((d) => fs.appendFileSync(path.join(d, INDEX), " ")), "kit_file_mismatch", (x) => x.path === INDEX) && refusedAs(mk((d) => fs.appendFileSync(path.join(d, SUMS), "\n")), "kit_file_mismatch", (x) => x.path === SUMS));
check("check-kit: pinned file replaced by a symlink to identical bytes -> kit_symlink", refusedAs(mk((d) => { const p = path.join(d, "backfill-plan/plan.mjs"); fs.rmSync(p); fs.symlinkSync(path.join(K, "backfill-plan/plan.mjs"), p); }), "kit_symlink"));
check("check-kit: sources directory replaced by a symlink -> kit_symlink", refusedAs(mk((d) => { const p = path.join(d, "filter-manifest/sources"); fs.rmSync(p, { recursive: true }); fs.symlinkSync(path.join(K, "filter-manifest/sources"), p); }), "kit_symlink"));
const KL = path.join(T, "kit-link"); fs.symlinkSync(K, KL);
check("check-kit: kit root is a symlink -> kit_symlink; missing kit -> kit_missing; bad CLI -> cli_usage", refusedAs(checkKit(KL), "kit_symlink") && refusedAs(checkKit(path.join(T, "nope")), "kit_missing") && refusedAs(run(CHECK, ["--kit"]), "cli_usage") && refusedAs(run(CHECK, ["--kit", K, "--extra", "x"]), "cli_usage"));
const dirty = (rel) => { const d = path.join(T, `d${n++}`); fs.cpSync(K, d, { recursive: true }); fs.appendFileSync(path.join(d, rel), "\n"); const r = spawnSync(process.execPath, [path.join(d, "backfill-capture-compose/compose.mjs"), "--spec", SPEC, "--components", d, "--out", path.join(d, "..", `o${n++}`)], { cwd: "/", env: {} }); return JSON.parse(r.stdout.toString() || "null"); };
const dc = dirty("filter-manifest/compile.mjs");
check("compose in a dirty kit (compile.mjs) refuses component_hash_mismatch before import", dc?.refused === "component_hash_mismatch" && dc.detail.component === "compile", dc);
const ds = dirty("filter-manifest/sources/aromer-5669951/constants.py");
check("compose in a dirty kit (constants.py) refuses via pinned compiler source_hash_mismatch", ds?.refused === "compile_refused" && JSON.stringify(ds.detail).includes("source_hash_mismatch"), ds);

// D. build refusals: no output created
const nb = (args) => { const out = path.join(W, `r${n++}`); const r = run(BUILD, args(out)); return { ...r, exists: fs.existsSync(out) }; };
const no = (r, reason) => r.rc === 2 && r.j?.refused === reason && !r.exists;
check("build CLI: missing --out, duplicate --git, unknown --fetch, empty value, relative --git -> refused, no output", no(nb(() => ["--git", GIT, "--git-dir", GITDIR]), "cli_missing_argument") && no(nb((o) => ["--git", GIT, "--git", GIT, "--git-dir", GITDIR, "--out", o]), "cli_duplicate_argument") && no(nb((o) => ["--git", GIT, "--git-dir", GITDIR, "--out", o, "--fetch", "origin"]), "cli_unknown_argument") && no(nb((o) => ["--git", "", "--git-dir", GITDIR, "--out", o]), "cli_missing_value") && no(nb((o) => ["--git", "git", "--git-dir", GITDIR, "--out", o]), "git_not_absolute"));
const EX = path.join(W, "exists"); fs.mkdirSync(EX);
const LP = path.join(W, "linkparent"); fs.symlinkSync(W, LP);
check("build --out: existing directory -> out_exists (left empty); symlinked parent -> out_parent_symlink; missing parent -> out_parent_missing", no({ ...run(BUILD, ["--git", GIT, "--git-dir", GITDIR, "--out", EX]), exists: false }, "out_exists") && fs.readdirSync(EX).length === 0 && no(build(path.join(LP, "k")), "out_parent_symlink") && no(build(path.join(W, "absent", "k")), "out_parent_missing"));
check("build --out: existing file and existing symlink -> out_exists", (() => { const f = path.join(W, "f"); fs.writeFileSync(f, ""); const l = path.join(W, "l"); fs.symlinkSync(path.join(W, "nowhere"), l); return run(BUILD, ["--git", GIT, "--git-dir", GITDIR, "--out", f]).j?.refused === "out_exists" && run(BUILD, ["--git", GIT, "--git-dir", GITDIR, "--out", l]).j?.refused === "out_exists" && !fs.existsSync(path.join(W, "nowhere")); })());
const EMPTY = path.join(W, "empty.git"); spawnSync(GIT, ["init", "-q", "--bare", EMPTY]);
check("build: git dir without the pinned objects -> object_missing, no output (never fetches)", no(build(path.join(W, `r${n++}`), { gitDir: EMPTY }), "object_missing"));
check("build: nonexistent git binary -> git_exec_failed, no output", no(build(path.join(W, `r${n++}`), { git: path.join(W, "no-git") }), "git_exec_failed"));
const ALT = path.join(W, "alt.git"); spawnSync(GIT, ["init", "-q", "--bare", ALT]);
fs.writeFileSync(path.join(ALT, "objects/info/alternates"), `${path.join(GITDIR, "objects")}\n`);
const compileBlob = FILES.find((f) => f.path === "filter-manifest/compile.mjs").blob;
const evil = spawnSync(GIT, ["--git-dir", ALT, "hash-object", "-w", "--stdin"], { input: "export const compile = () => 'evil';\n" }).stdout.toString().trim();
spawnSync(GIT, ["--git-dir", ALT, "replace", compileBlob, evil]);
const replaced = spawnSync(GIT, ["--git-dir", ALT, "cat-file", "blob", compileBlob]).stdout.toString();
const RB = build(path.join(W, `r${n++}`), { gitDir: ALT });
check("build: git replace ref on compile.mjs blob is ignored (--no-replace-objects): BUILT with pinned bytes", replaced.includes("evil") && RB.rc === 0 && same(K, RB.out), RB.j);
const fake = (target, mode) => { const p = path.join(W, `fakegit${n++}`); fs.writeFileSync(p, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const r = spawnSync(${JSON.stringify(GIT)}, process.argv.slice(2), { env: process.env, maxBuffer: 1 << 26 });
let out = r.stdout;
if (process.argv.includes(${JSON.stringify(target)})) { out = Buffer.from(out); ${mode === "flip" ? "out[out.length - 2] ^= 1;" : "out = out.subarray(0, out.length - 1);"} }
process.stdout.write(out); process.exitCode = r.status;
`); fs.chmodSync(p, 0o755); fs.renameSync(p, `${p}.cjs`); fs.writeFileSync(p, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${p}.cjs`)} "$@"\n`); fs.chmodSync(p, 0o755); return p; };
const FB = build(path.join(W, `r${n++}`), { git: fake(compileBlob, "flip") });
check("build: git returning a flipped byte for a pinned blob -> object_hash_mismatch, no output", no(FB, "object_hash_mismatch") && FB.j.detail.oid === compileBlob, FB.j);
const tree42 = COMMITS["42185f2170fb68e5d55b5e8507f480229f58b4df"].tree;
check("build: git returning a truncated pinned tree -> object_hash_mismatch, no output", no(build(path.join(W, `r${n++}`), { git: fake(tree42, "trunc") }), "object_hash_mismatch"));
check("build: git returning a corrupted pinned commit -> object_hash_mismatch, no output", no(build(path.join(W, `r${n++}`), { git: fake(COMPOSE_C1, "flip") }), "object_hash_mismatch"));

// E. write integrity and partial-output disclosure
const SW = build(path.join(W, `w${n++}`), { fault: "short" });
check("writes: every writeSync capped at 7 B -> BUILT, kit byte-identical to normal build", SW.rc === 0 && SW.j.status === "BUILT" && same(K, SW.out), SW.j);
const EI = build(path.join(W, `w${n++}`), { fault: `eio:${INDEX}` });
check("writes: EIO on final KIT.json -> exit 5 WRITE_FAILED, kitPersisted false, 13 persisted, zero-byte KIT.json disclosed", EI.rc === 5 && EI.j.status === "WRITE_FAILED" && EI.j.kitPersisted === false && EI.j.persisted.length === 13 && EI.j.writeFailure.file === INDEX && EI.j.writeFailure.bytesWritten === 0 && fs.statSync(path.join(EI.out, INDEX)).size === 0 && !(INDEX in EI.j.files), EI.j);
const EIc = checkKit(EI.out);
check("writes: check-kit on that WRITE_FAILED kit (KIT.json exists, zero bytes) -> refused kit_file_mismatch", refusedAs(EIc, "kit_file_mismatch", (x) => x.path === INDEX), EIc.j);
const EC = build(path.join(W, `w${n++}`), { fault: "eio:compose.mjs" });
check("writes: EIO on compose.mjs -> exit 5, persisted list stops before it, no SHA256SUMS/KIT.json", EC.rc === 5 && EC.j.writeFailure.file === "backfill-capture-compose/compose.mjs" && !fs.existsSync(path.join(EC.out, INDEX)) && !fs.existsSync(path.join(EC.out, SUMS)) && EC.j.persisted.every((p) => sha(fs.readFileSync(path.join(EC.out, p))) === EC.j.files[p]), EC.j);

// F. static
const bsrc = fs.readFileSync(BUILD, "utf8"), csrc = fs.readFileSync(CHECK, "utf8"), ksrc = fs.readFileSync(path.join(HERE, "kit.mjs"), "utf8");
check("static: build-kit has exactly one spawnSync (git cat-file, shell:false, literal env, --no-replace-objects), no process.env/fetch/clone/remote/http/net/clock", (bsrc.match(/spawnSync\(/g) ?? []).length === 1 && bsrc.includes('"--no-replace-objects", "--git-dir", gitDir, "cat-file"') && bsrc.includes("shell: false") && !/process\.env|"fetch"|"clone"|"remote"|node:https?|node:net|Date|performance/.test(bsrc));
check("static: check-kit and kit.mjs have no child_process, env, network, clock or writes", ![csrc, ksrc].some((s) => /child_process|process\.env|node:https?|node:net|Date|performance|writeFileSync|writeSync|openSync\([^)]*O_CREAT/.test(s)));
check("static: build-kit opens outputs only with O_EXCL|O_NOFOLLOW", (bsrc.match(/openSync\(/g) ?? []).length === 1 && bsrc.includes("O_EXCL | fs.constants.O_NOFOLLOW"));

fs.mkdirSync(path.join(HERE, "evidence"), { recursive: true });
fs.copyFileSync(path.join(K, INDEX), path.join(HERE, "evidence", INDEX));
fs.copyFileSync(path.join(K, SUMS), path.join(HERE, "evidence", SUMS));
fs.writeFileSync(path.join(HERE, "evidence/results.json"), `${JSON.stringify({ suite: "backfill-capture-kit", cases: results }, null, 2)}\n`);
fs.rmSync(T, { recursive: true, force: true });
fs.rmSync(W, { recursive: true, force: true });
const fail = results.filter((r) => !r.pass).length;
process.stdout.write(`${results.length - fail} PASS, ${fail} FAIL\n`);
process.exitCode = fail ? 1 : 0;

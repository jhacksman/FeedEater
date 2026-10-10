#!/usr/bin/env node
// Builds the portable pinned capture kit from explicit local git objects only. Every commit, tree and blob read is
// re-hashed here (sha1 over the raw object) and checked against the pins in kit.mjs, so the emitted bytes do not rely
// on git's own integrity. Never fetches, never reads the environment, never falls back to a default path.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { COMMITS, FILES, SUMS, INDEX, sha256, gitObjectId, renderSums, renderIndex } from "./kit.mjs";

class Refusal extends Error { constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; } }
class WriteFailure extends Error { constructor(file, stage, bytesWritten, code) { super(stage); Object.assign(this, { file, stage, bytesWritten, code }); } }
const refuse = (reason, detail = {}) => { throw new Refusal(reason, detail); };
const GIT_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0" });

function readObject(git, gitDir, type, oid) {
  const r = spawnSync(git, ["--no-replace-objects", "--git-dir", gitDir, "cat-file", type, oid], { env: GIT_ENV, shell: false, maxBuffer: 1 << 26 });
  if (r.error) refuse("git_exec_failed", { code: r.error.code ?? "error" });
  if (r.status !== 0) refuse("object_missing", { type, oid });
  const id = gitObjectId(type, r.stdout);
  if (id !== oid) refuse("object_hash_mismatch", { type, oid, actual: id });
  return r.stdout;
}

function commitTree(buf, oid) {
  const m = /^tree ([0-9a-f]{40})\n/.exec(buf.subarray(0, 46).toString("latin1"));
  if (!m) refuse("commit_malformed", { oid });
  return m[1];
}

function treeEntries(buf, oid) {
  const out = new Map();
  for (let i = 0; i < buf.length;) {
    const sp = buf.indexOf(0x20, i), nul = sp < 0 ? -1 : buf.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > buf.length) refuse("tree_malformed", { oid });
    const name = buf.subarray(sp + 1, nul).toString("utf8");
    if (out.has(name)) refuse("tree_duplicate_entry", { oid, name });
    out.set(name, { mode: buf.subarray(i, sp).toString("latin1"), oid: buf.subarray(nul + 1, nul + 21).toString("hex") });
    i = nul + 21;
  }
  return out;
}

export function resolveKit(git, gitDir) {
  const roots = {};
  for (const [commit, pin] of Object.entries(COMMITS)) {
    const tree = commitTree(readObject(git, gitDir, "commit", commit), commit);
    if (tree !== pin.tree) refuse("commit_tree_mismatch", { commit, expected: pin.tree, actual: tree });
    roots[commit] = tree;
  }
  const trees = new Map();
  const files = new Map();
  for (const f of FILES) {
    const parts = f.repoPath.split("/");
    let cur = roots[f.commit];
    for (let k = 0; k < parts.length; k++) {
      if (!trees.has(cur)) trees.set(cur, treeEntries(readObject(git, gitDir, "tree", cur), cur));
      const e = trees.get(cur).get(parts[k]);
      if (!e) refuse("path_missing_in_commit", { commit: f.commit, repoPath: f.repoPath });
      const want = k === parts.length - 1 ? "100644" : "40000";
      if (e.mode !== want) refuse("path_mode_mismatch", { commit: f.commit, repoPath: f.repoPath, expected: want, actual: e.mode });
      cur = e.oid;
    }
    if (cur !== f.blob) refuse("blob_pin_mismatch", { path: f.path, expected: f.blob, actual: cur });
    const buf = readObject(git, gitDir, "blob", cur);
    if (buf.length !== f.bytes || sha256(buf) !== f.sha256) refuse("blob_sha256_mismatch", { path: f.path, expected: f.sha256, actual: sha256(buf) });
    files.set(f.path, buf);
  }
  files.set(SUMS, renderSums());
  files.set(INDEX, renderIndex());
  return files;
}

function checkOut(out) {
  const abs = path.resolve(out);
  try { fs.lstatSync(abs); refuse("out_exists", {}); } catch (e) { if (e instanceof Refusal) throw e; if (e.code !== "ENOENT") refuse("out_stat_failed", { code: e.code }); }
  let p = path.parse(abs).root;
  for (const c of path.dirname(abs).split(path.sep).filter(Boolean)) {
    p = path.join(p, c);
    let s; try { s = fs.lstatSync(p); } catch { refuse("out_parent_missing", {}); }
    if (s.isSymbolicLink()) refuse("out_parent_symlink", {});
    if (!s.isDirectory()) refuse("out_parent_not_directory", {});
  }
  return abs;
}

function writeExclusive(file, name, buf) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); } catch (e) { throw new WriteFailure(name, "open", 0, e.code ?? "error"); }
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
    try { for (let r; got < back.length && (r = fs.readSync(fd, back, got, back.length - got, got)) > 0;) got += r; } catch (e) { throw new WriteFailure(name, "readback", off, e.code ?? "error"); }
    if (got !== buf.length || Buffer.compare(back.subarray(0, got), buf) !== 0) throw new WriteFailure(name, "readback_mismatch", off, null);
  } finally { fs.closeSync(fd); }
}

export function writeKit(out, files) {
  fs.mkdirSync(out, { mode: 0o700 });
  const dirs = new Set();
  const persisted = [];
  const order = [...FILES.map((x) => x.path), SUMS, INDEX];
  try {
    for (const name of order) {
      const parts = name.split("/");
      for (let k = 1; k < parts.length; k++) {
        const d = parts.slice(0, k).join("/");
        if (!dirs.has(d)) {
          try { fs.mkdirSync(path.join(out, d), { mode: 0o700 }); } catch (e) { throw new WriteFailure(name, "mkdir", 0, e.code ?? "error"); }
          dirs.add(d);
        }
      }
      writeExclusive(path.join(out, name), name, files.get(name));
      persisted.push(name);
    }
  } catch (e) {
    if (e instanceof WriteFailure) return { persisted, writeFailure: { file: e.file, stage: e.stage, bytesWritten: e.bytesWritten, code: e.code } };
    throw e;
  }
  return { persisted, writeFailure: null };
}

function parseArgs(argv) {
  const want = ["--git", "--git-dir", "--out"];
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!want.includes(k)) refuse("cli_unknown_argument", { arg: k });
    if (k in a) refuse("cli_duplicate_argument", { arg: k });
    if (i + 1 >= argv.length || argv[i + 1] === "") refuse("cli_missing_value", { arg: k });
    a[k] = argv[i + 1];
  }
  for (const k of want) if (!(k in a)) refuse("cli_missing_argument", { arg: k });
  if (!path.isAbsolute(a["--git"])) refuse("git_not_absolute", {});
  return a;
}

function main(argv) {
  const say = (o, code) => { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); process.exitCode = code; };
  try {
    const a = parseArgs(argv);
    const out = checkOut(a["--out"]);
    const files = resolveKit(a["--git"], path.resolve(a["--git-dir"]));
    const w = writeKit(out, files);
    const shas = Object.fromEntries([...files].filter(([n]) => w.persisted.includes(n)).map(([n, b]) => [n, sha256(b)]));
    if (w.writeFailure) return say({ status: "WRITE_FAILED", kitPersisted: false, persisted: w.persisted, files: shas, writeFailure: w.writeFailure, note: "incomplete kit: do not use, even if a KIT.json file exists" }, 5);
    say({ status: "BUILT", kitPersisted: true, fileCount: files.size, kitJsonSha256: sha256(files.get(INDEX)), files: shas, transportExecuted: false }, 0);
  } catch (e) {
    if (e instanceof Refusal) return say({ refused: e.reason, detail: e.detail }, 2);
    say({ error: "internal_error", message: String(e?.message ?? e) }, 4);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));

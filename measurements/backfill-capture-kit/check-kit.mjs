#!/usr/bin/env node
// Offline check of an assembled kit directory: exact inventory (no missing, extra, symlinked or non-regular entries),
// every file's bytes, sha256 and git blob id against the pins in kit.mjs, and KIT.json / SHA256SUMS byte-equal to
// their deterministic renders. No git, network, environment or writes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FILES, SUMS, INDEX, KIT_PATHS, sha256, gitObjectId, renderSums, renderIndex } from "./kit.mjs";

class Refusal extends Error { constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; } }
const refuse = (reason, detail = {}) => { throw new Refusal(reason, detail); };

function readNoFollow(p, rel) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { refuse(e.code === "ELOOP" ? "kit_symlink" : "kit_file_unreadable", { path: rel }); }
  try { if (!fs.fstatSync(fd).isFile()) refuse("kit_not_regular", { path: rel }); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

export function checkKit(dir) {
  const root = path.resolve(dir);
  let s; try { s = fs.lstatSync(root); } catch { refuse("kit_missing", {}); }
  if (s.isSymbolicLink()) refuse("kit_symlink", { path: "." });
  if (!s.isDirectory()) refuse("kit_not_directory", {});
  const found = [];
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(path.join(root, r));
      if (st.isSymbolicLink()) refuse("kit_symlink", { path: r });
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) found.push(r);
      else refuse("kit_not_regular", { path: r });
    }
  };
  walk("");
  const missing = KIT_PATHS.filter((p) => !found.includes(p));
  const extra = found.filter((p) => !KIT_PATHS.includes(p));
  if (missing.length || extra.length) refuse("kit_inventory_mismatch", { missing, extra });
  const files = {};
  for (const f of FILES) {
    const b = readNoFollow(path.join(root, f.path), f.path);
    if (b.length !== f.bytes || sha256(b) !== f.sha256 || gitObjectId("blob", b) !== f.blob) refuse("kit_file_mismatch", { path: f.path, expected: f.sha256, actual: sha256(b) });
    files[f.path] = f.sha256;
  }
  for (const [name, want] of [[SUMS, renderSums()], [INDEX, renderIndex()]]) {
    const b = readNoFollow(path.join(root, name), name);
    if (Buffer.compare(b, want) !== 0) refuse("kit_file_mismatch", { path: name, expected: sha256(want), actual: sha256(b) });
    files[name] = sha256(b);
  }
  return { verdict: "KIT_VERIFIED", fileCount: found.length, kitJsonSha256: files[INDEX], files };
}

function main(argv) {
  const say = (o, code) => { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); process.exitCode = code; };
  try {
    if (argv.length !== 2 || argv[0] !== "--kit" || argv[1] === "") refuse("cli_usage", { usage: "node check-kit.mjs --kit <dir>" });
    say(checkKit(argv[1]), 0);
  } catch (e) {
    if (e instanceof Refusal) return say({ refused: e.reason, detail: e.detail }, 2);
    say({ error: "internal_error", message: String(e?.message ?? e) }, 4);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));

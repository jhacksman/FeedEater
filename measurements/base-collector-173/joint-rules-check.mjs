#!/usr/bin/env node
// J13: checks joint-rules.json against git objects (offline). Each verbatim block's source lines at the
// pinned head must hash to the declared sha256 and appear contiguously, byte-identical, in the target file;
// joint-run.sh's diff against guard-run.sh@4df26b2 must change exactly the declared old lines.
// Prints one JSON object; exit 0 all ok, 1 otherwise.   node joint-rules-check.mjs [DIFF_OUT]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
const H = path.dirname(new URL(import.meta.url).pathname);
const rules = JSON.parse(fs.readFileSync(path.join(H, "joint-rules.json"), "utf8"));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const blob = (head, file) => execFileSync("git", ["-C", H, "show", `${head}:${file}`], { encoding: "utf8" });
const res = { blocks: [], jointRun: null, ok: true };
for (const b of rules.verbatim) {
  const src = blob(b.head, b.file).split("\n").slice(b.lines[0] - 1, b.lines[1]);
  const dst = fs.readFileSync(path.join(H, b.target), "utf8").split("\n");
  let at = -1;
  for (let i = 0; i + src.length <= dst.length && at < 0; i++) if (src.every((l, k) => dst[i + k] === l)) at = i + 1;
  const h = sha(`${src.join("\n")}\n`);
  const ok = at > 0 && h === b.sha256;
  res.blocks.push({ name: b.name, src: `${b.head.slice(0, 7)}:${path.basename(b.file)}:${b.lines.join("-")}`, sha256: h, declared: b.sha256, targetLines: at > 0 ? [at, at + src.length - 1] : null, ok });
  res.ok &&= ok;
}
const jr = rules.jointRun;
const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "jrc-")), "base");
fs.writeFileSync(tmp, blob(jr.head, jr.file));
const d = spawnSync("diff", [tmp, path.join(H, "joint-run.sh")], { encoding: "utf8" });
const u = spawnSync("diff", ["-u", tmp, path.join(H, "joint-run.sh")], { encoding: "utf8" }).stdout.replace(tmp, `${jr.head}:${jr.file}`);
fs.rmSync(path.dirname(tmp), { recursive: true });
const hunks = d.stdout.split("\n").filter((l) => /^[0-9]/.test(l)).map((l) => l.replace(/[acd].*$/, (x) => x[0]));
res.jointRun = { hunks: hunks.join(" "), declared: jr.changedOldLines, diffSha256: sha(u), ok: hunks.join(" ") === jr.changedOldLines };
res.ok &&= res.jointRun.ok;
if (process.argv[2]) fs.writeFileSync(process.argv[2], u);
process.stdout.write(`${JSON.stringify(res)}\n`);
process.exit(res.ok ? 0 : 1);

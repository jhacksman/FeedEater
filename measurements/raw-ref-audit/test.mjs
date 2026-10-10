// Offline tests for audit.mjs. Fixtures are produced at test time by the real frozen raw writer 94a0ae0 (extracted with
// `git show`, file sha256 checked) on its own seed-173 10,000-frame fixture. No network, node, broker or service.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";

const RAW = "94a0ae0e2a7e96c8ba21b3d609adbdfb156eb14d";
const PIN = { "fixture.mjs": "641dc4538f6bb33f358f532db07133342711b83c935e83a925877315cf9859fd", "tier0.mjs": "52978d89a1a4705c4c59e187d9a54a50605f1d7d29c9cd150d2e9e28cff36198", "writer.mjs": "7ae9bed2191731dc92b645d60ed49b6538262f8a1afc2f135c1967a71d62bc2b" };
const W = "work";
const ID = "a7c0ffee-0000-4000-8000-000000000173";
const hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fh = (p) => hex(fs.readFileSync(p));
let pass = 0, fail = 0;
const results = [];
const check = (name, ok, expected, actual) => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (expected !== undefined) results.push({ case: name, expected, actual, pass: !!ok }); };

fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(`${W}/raw94`, { recursive: true });
for (const [f, h] of Object.entries(PIN)) {
  const b = execFileSync("git", ["show", `${RAW}:measurements/raw-tier0-prototype/${f}`]);
  fs.writeFileSync(`${W}/raw94/${f}`, b);
  check(`raw94 ${f} extracted from ${RAW.slice(0, 7)} with pinned sha256`, hex(b) === h);
}
const { encodePipe } = await import(`./${W}/raw94/tier0.mjs`);
const { makeFrames } = await import(`./${W}/raw94/fixture.mjs`);

// Run the real writer: frames 1..9998 then, after ack 9998, frames 9999+10000 in one pipe write (one commit batch).
function writeSegment(seg, id, frames, epoch = 1) {
  return new Promise((res, rej) => {
    const w = spawn(process.execPath, [`${W}/raw94/writer.mjs`, "--segment", seg, "--segment-id", id, "--epoch", String(epoch)], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    const pipe = (fs_) => Buffer.concat(fs_.map((f) => encodePipe(Buffer.from(JSON.stringify(f.meta), "utf8"), f.raw)));
    const n = frames.length;
    let tailSent = n <= 2;
    w.stdout.on("data", (d) => {
      out += d;
      if (!tailSent && out.includes(`"seq":${n - 2},`)) { tailSent = true; w.stdin.end(pipe(frames.slice(n - 2))); }
    });
    w.on("exit", (c) => (c === 0 ? res(out) : rej(new Error(`writer exit ${c}`))));
    if (n <= 2) w.stdin.end(pipe(frames)); else w.stdin.write(pipe(frames.slice(0, n - 2)));
  });
}
const recoverWith94 = (seg, id) => spawnSync(process.execPath, [`${W}/raw94/writer.mjs`, "--segment", seg, "--segment-id", id, "--epoch", "2"], { input: Buffer.alloc(0), maxBuffer: 1 << 28 });

const frames = makeFrames(10000, 173);
const base = `${W}/base.seg`;
const ackText = await writeSegment(base, ID, frames);
fs.writeFileSync(`${W}/base.acks.jsonl`, ackText);
const baseJ = fs.readFileSync(`${base}.commit`);
const acks = ackText.trimEnd().split("\n").map((l) => JSON.parse(l)).filter((o) => o.type === "ack");
check("raw94 writer produced 10000 append acks", acks.length === 10000 && acks.every((a, i) => a.seq === i + 1 && a.via === "append"));
check(`commit journal has a last entry covering exactly 9999-10000 (${baseJ.length / 48} entries)`, baseJ.length % 48 === 0 && baseJ.readUInt32BE(baseJ.length - 48 + 12) === 10000 && baseJ.readUInt32BE(baseJ.length - 96 + 12) === 9998);

let k = 0;
function mk({ seg = base, journal = baseJ, ackBody = ackText } = {}) {
  const d = `${W}/c${++k}`; fs.mkdirSync(d);
  const s = `${d}/seg`; fs.copyFileSync(seg, s);
  fs.writeFileSync(`${s}.commit`, journal);
  fs.writeFileSync(`${d}/acks.jsonl`, ackBody);
  return { d, s, j: `${s}.commit`, a: `${d}/acks.jsonl` };
}
function runAudit(args) {
  const files = args.filter((_, i) => i % 2 === 1 && args[i - 1] !== "--full-refs");
  const before = files.map((f) => { try { return fh(f); } catch { return null; } });
  const r = spawnSync(process.execPath, ["audit.mjs", ...args], { maxBuffer: 1 << 28 });
  const after = files.map((f) => { try { return fh(f); } catch { return null; } });
  const out = JSON.parse(r.stdout.toString());
  const toolHashesMatch = out.readOnly === undefined || out.readOnly.inputs.every((x, i) => x.sha256Before === before[i] && x.sha256After === before[i]);
  return { rc: r.status, out, unchanged: before.every((h, i) => h === after[i]) && toolHashesMatch };
}
const A = (c, q = []) => runAudit(["--segment", c.s, "--journal", c.j, "--acks", c.a, ...q.flatMap((x) => ["--quarantine", x])]);
const sum = (o) => ({ RESOLVABLE: o.summary.RESOLVABLE, INVALIDATED: o.summary.INVALIDATED, UNKNOWN: o.summary.UNKNOWN, nonResolvable: o.nonResolvableSeqRanges, presence: o.presence, nonResolvableRefBytes: o.nonResolvableRefBytes });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineOf = (L, seq) => L.findIndex((l) => l.includes(`"type":"ack"`) && JSON.parse(l).seq === seq);
const allBytes = acks.reduce((s, a) => s + a.length, 0);
const lastTwoBytes = acks[9998].length + acks[9999].length;

{ // intact
  const c = mk(); const r = A(c);
  const exp = { rc: 0, RESOLVABLE: 10000, INVALIDATED: {}, UNKNOWN: {} };
  const act = { rc: r.rc, ...sum(r.out) };
  check("intact: 10000 RESOLVABLE, read-only", r.unchanged && r.rc === 0 && act.RESOLVABLE === 10000 && eq(act.INVALIDATED, {}) && eq(act.UNKNOWN, {}) && r.out.presence.refAccessible === 10000, exp, act);
}
for (const [name, jl, seqs, bytes] of [["last journal entry lost", baseJ.length - 48, [[9999, 10000]], lastTwoBytes], ["journal reduced to first entry only", 48, [[1, 10000]], allBytes]]) {
  const n = seqs[0][1] - seqs[0][0] + 1;
  const c = mk({ journal: baseJ.subarray(0, jl) }); const r = A(c);
  const exp = { rc: 0, INVALIDATED: { beyond_committed_end: n }, nonResolvable: seqs, refAccessible: 10000, bytesPreservedActive: 10000, nonResolvableRefBytes: bytes };
  const act = { rc: r.rc, ...sum(r.out) };
  check(`${name}, before recovery: ${n} INVALIDATED beyond_committed_end (${bytes} B), still accessible in active file`, r.unchanged && r.rc === 0 && eq(act.INVALIDATED, exp.INVALIDATED) && eq(act.nonResolvable, seqs) && act.presence.refAccessible === 10000 && act.presence.bytesPreservedActive === 10000 && act.nonResolvableRefBytes === bytes, exp, act);
  const rec = recoverWith94(c.s, ID);
  const qs = fs.readdirSync(c.d).filter((f) => f.startsWith("seg.quarantine-")).map((f) => `${c.d}/${f}`);
  const r2 = A(c, qs);
  const act2 = { writerRc: rec.status, quarantines: qs.map((q) => [q.split("/").pop(), fs.statSync(q).size]), rc: r2.rc, ...sum(r2.out) };
  const exp2 = { writerRc: 0, rc: 0, INVALIDATED: { beyond_eof: n }, nonResolvable: seqs, refAccessible: 10000 - n, bytesPreservedQuarantine: n, nonResolvableRefBytes: bytes };
  check(`${name}, after raw94 recovery (writer exit ${rec.status}): ${n} INVALIDATED beyond_eof, not accessible, bytes preserved in quarantine`, rec.status === 0 && r2.unchanged && r2.rc === 0 && eq(act2.INVALIDATED, exp2.INVALIDATED) && eq(act2.nonResolvable, seqs) && act2.presence.refAccessible === 10000 - n && act2.presence.bytesPreservedQuarantine === n && act2.presence.bytesNotFound === 0 && act2.nonResolvableRefBytes === bytes, exp2, act2);
}
{ // malformed / truncated ack journal
  const c = mk({ ackBody: ackText.replace("\n", "\n{bad\n") }); const r = A(c);
  check("malformed ack journal line: refused exit 2", r.rc === 2 && r.out.refused === "ack_journal_malformed_line" && r.unchanged, { rc: 2, refused: "ack_journal_malformed_line" }, { rc: r.rc, ...r.out });
  const c2 = mk({ ackBody: ackText.slice(0, ackText.length - 40) }); const r2 = A(c2);
  check("truncated ack journal final line: refused exit 2", r2.rc === 2 && r2.out.refused === "ack_journal_truncated_final_line" && r2.unchanged, { rc: 2, refused: "ack_journal_truncated_final_line" }, { rc: r2.rc, ...r2.out });
}
{ // truncated segment (cut inside record 5000)
  const c = mk(); fs.truncateSync(c.s, acks[4999].offset + 10); const r = A(c);
  const exp = { RESOLVABLE: 4999, INVALIDATED: { beyond_eof: 5001 }, nonResolvable: [[5000, 10000]], segmentShorterThanCommittedEnd: true };
  const act = { ...sum(r.out), segmentShorterThanCommittedEnd: r.out.journal.segmentShorterThanCommittedEnd };
  check("truncated segment: 4999 RESOLVABLE, 5001 INVALIDATED beyond_eof", r.rc === 0 && r.unchanged && act.RESOLVABLE === 4999 && eq(act.INVALIDATED, exp.INVALIDATED) && eq(act.nonResolvable, exp.nonResolvable) && act.segmentShorterThanCommittedEnd, exp, act);
}
{ // malformed segment: one raw byte of record 5000 flipped
  const c = mk(); const b = fs.readFileSync(c.s); b[acks[4999].rawOffset] ^= 0xff; fs.writeFileSync(c.s, b); const r = A(c);
  const exp = { RESOLVABLE: 9999, INVALIDATED: { record_sha_mismatch: 1 }, nonResolvable: [[5000, 5000]], bytesNotFound: 1 };
  const act = sum(r.out);
  check("corrupt record 5000: INVALIDATED record_sha_mismatch, bytes not found, others RESOLVABLE", r.rc === 0 && r.unchanged && act.RESOLVABLE === 9999 && eq(act.INVALIDATED, exp.INVALIDATED) && act.presence.bytesNotFound === 1, exp, act);
  const b2 = fs.readFileSync(c.s); b2[acks[6999].offset + 5] ^= 0x01; fs.writeFileSync(c.s, b2); const r2 = A(c);
  check("corrupt metaLen of record 7000 (in bounds): INVALIDATED framing_mismatch, later refs still RESOLVABLE", r2.rc === 0 && r2.out.summary.INVALIDATED.framing_mismatch === 1 && r2.out.summary.RESOLVABLE === 9998, { INVALIDATED: { record_sha_mismatch: 1, framing_mismatch: 1 }, RESOLVABLE: 9998 }, sum(r2.out));
}
{ // foreign identity: a different segment id written by raw94
  const fseg = `${W}/foreign.seg`;
  await writeSegment(fseg, "f0000000-0000-4000-8000-000000000999", makeFrames(10, 999));
  const c = mk({ seg: fseg, journal: fs.readFileSync(`${fseg}.commit`) }); const r = A(c);
  const exp = { INVALIDATED: { segment_identity_mismatch: 10000 }, journalOk: false };
  const act = { ...sum(r.out), journalOk: r.out.journal.ok, identity: r.out.segment.identity };
  check("foreign segment identity: 10000 INVALIDATED segment_identity_mismatch", r.rc === 0 && r.unchanged && eq(act.INVALIDATED, exp.INVALIDATED) && act.journalOk === false, exp, act);
}
{ // wrong raw sha in ack 77; wrong meta sha in ack 78
  const L = ackText.split("\n");
  const i77 = lineOf(L, 77), i78 = lineOf(L, 78);
  const o = JSON.parse(L[i77]); o.sha256 = "0".repeat(64); L[i77] = JSON.stringify(o);
  const p = JSON.parse(L[i78]); p.metaSha256 = "f".repeat(64); L[i78] = JSON.stringify(p);
  const c = mk({ ackBody: L.join("\n") }); const r = A(c);
  const exp = { INVALIDATED: { ack_raw_sha_mismatch: 1, ack_meta_sha_mismatch: 1 }, nonResolvable: [[77, 78]] };
  const act = sum(r.out);
  check("wrong raw sha (77) and wrong meta sha (78): INVALIDATED with exact reason", r.rc === 0 && r.unchanged && eq(act.INVALIDATED, exp.INVALIDATED) && eq(act.nonResolvable, exp.nonResolvable), exp, act);
}
{ // duplicate identical (same line again + recovery-style ack epoch 2) and conflicting (seq 20 offset+1)
  const L = ackText.trimEnd().split("\n");
  const i10 = lineOf(L, 10), i20 = lineOf(L, 20);
  const rec = { ...JSON.parse(L[i10]), via: "recovery", epoch: 2 };
  const conf = { ...JSON.parse(L[i20]), offset: JSON.parse(L[i20]).offset + 1 };
  const c = mk({ ackBody: [...L, L[i10], JSON.stringify(rec), JSON.stringify(conf)].join("\n") + "\n" }); const r = A(c);
  const exp = { RESOLVABLE: 9999, UNKNOWN: { conflicting_acks: 1 }, duplicateIdentical: 2, conflictingSeqs: 1, nonResolvable: [[20, 20]] };
  const act = { ...sum(r.out), duplicateIdentical: r.out.acks.duplicateIdentical, conflictingSeqs: r.out.acks.conflictingSeqs };
  check("duplicate identical acks counted (seq 10 RESOLVABLE); conflicting seq 20 UNKNOWN conflicting_acks", r.rc === 0 && r.unchanged && act.RESOLVABLE === 9999 && eq(act.UNKNOWN, exp.UNKNOWN) && act.duplicateIdentical === 2 && act.conflictingSeqs === 1 && eq(act.nonResolvable, [[20, 20]]), exp, act);
}
{ // corrupt journal entry -> commit proof unavailable
  const j = Buffer.from(baseJ); j[3 * 48 + 20] ^= 1;
  const c = mk({ journal: j }); const r = A(c);
  const exp = { UNKNOWN: { "journal_unverifiable:journal_bad_entry": 10000 }, refAccessible: 10000 };
  const act = sum(r.out);
  check("corrupt journal entry: 10000 UNKNOWN journal_unverifiable, bytes still accessible", r.rc === 0 && r.unchanged && eq(act.UNKNOWN, exp.UNKNOWN) && act.presence.refAccessible === 10000, exp, act);
  const c2 = mk({ journal: Buffer.concat([baseJ, Buffer.alloc(20, 7)]) }); const r2 = A(c2);
  check("partial trailing journal entry (20 B): reported, whole entries still prove 10000 RESOLVABLE", r2.rc === 0 && r2.out.summary.RESOLVABLE === 10000 && r2.out.journal.partialTailBytes === 20, { RESOLVABLE: 10000, partialTailBytes: 20 }, { RESOLVABLE: r2.out.summary.RESOLVABLE, partialTailBytes: r2.out.journal.partialTailBytes });
}
{ // refusals
  const c = mk(); const link = `${c.d}/link.seg`; fs.symlinkSync("seg", link);
  const r = runAudit(["--segment", link, "--journal", c.j, "--acks", c.a]);
  check("symlinked segment input: refused input_is_symlink", r.rc === 2 && r.out.refused === "input_is_symlink", { rc: 2, refused: "input_is_symlink" }, { rc: r.rc, ...r.out });
  const L = ackText.split("\n"); const i6 = lineOf(L, 6); L[i6] = JSON.stringify({ ...JSON.parse(L[i6]), segment_id: "other" });
  const c2 = mk({ ackBody: L.join("\n") }); const r2 = A(c2);
  check("mixed segment ids in ack journal: refused", r2.rc === 2 && r2.out.refused === "mixed_segment_ids", { rc: 2, refused: "mixed_segment_ids" }, { rc: r2.rc, refused: r2.out.refused });
  const r3 = runAudit(["--segment", c.s, "--acks", c.a]);
  check("missing --journal: refused missing_argument", r3.rc === 2 && r3.out.refused === "missing_argument", { rc: 2, refused: "missing_argument" }, { rc: r3.rc, refused: r3.out.refused });
  const r4 = runAudit(["--segment", c.s, "--journal", `${c.d}/nope`, "--acks", c.a]);
  check("absent journal file: refused input_open_ENOENT", r4.rc === 2 && r4.out.refused === "input_open_ENOENT", { rc: 2, refused: "input_open_ENOENT" }, { rc: r4.rc, refused: r4.out.refused });
  fs.writeFileSync(`${c.d}/x.quarantine-5-e1`, "x");
  const r5 = runAudit(["--segment", c.s, "--journal", c.j, "--acks", c.a, "--quarantine", `${c.d}/x.quarantine-5-e1`]);
  check("quarantine not named for the supplied segment: refused", r5.rc === 2 && r5.out.refused === "quarantine_not_for_segment", { rc: 2, refused: "quarantine_not_for_segment" }, { rc: r5.rc, refused: r5.out.refused });
}
{ // static: read-only, no payload output, no clock, no process/network
  const src = fs.readFileSync("audit.mjs", "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  const banned = /writeFileSync|appendFileSync|writeSync\(|truncateSync|ftruncate|unlink|rmSync|renameSync|O_WRONLY|O_RDWR|O_CREAT|child_process|node:net|node:http|fetch\(|Date\.|hrtime|performance|toString\("(hex|base64|latin1)"\)/;
  check(`static: imports only ${imports.join(",")}; no write/truncate/unlink/rename/spawn/network/clock or payload encoding calls`, eq(imports, ["node:fs", "node:crypto", "node:path"]) && !banned.test(src));
  const c = mk(); const r = runAudit(["--segment", c.s, "--journal", c.j, "--acks", c.a, "--full-refs"]);
  const outText = JSON.stringify(r.out);
  const leaks = frames.slice(0, 200).filter((f) => f.raw.length >= 16 && outText.includes(f.raw.toString("utf8"))).length;
  check("full-refs output contains no raw payload bytes (first 200 frames checked)", r.rc === 0 && leaks === 0 && r.out.refs.length === 10000);
}
fs.writeFileSync("evidence/results.json", `${JSON.stringify({ rawWriterCommit: RAW, fixture: "raw94 fixture.mjs makeFrames(10000,173)", allAckBytes: allBytes, results }, null, 2)}\n`);
console.log(`${pass} PASS, ${fail} FAIL`);
fs.rmSync(W, { recursive: true, force: true });
process.exitCode = fail === 0 ? 0 : 1;

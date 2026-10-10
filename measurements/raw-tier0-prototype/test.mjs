// Hermetic acceptance run. Synthetic frames, host timing only; no broker/node/network.
import fs from "node:fs";
import crypto from "node:crypto";
import { makeFrames, fixtureSha } from "./fixture.mjs";
import { run, alive } from "./producer.mjs";
import { readSegment, rawSha, encodePipe, encodeRecord } from "./tier0.mjs";
import { spawn, spawnSync } from "node:child_process";
import { tier1Line } from "./tier1.mjs";

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? "PASS" : "FAIL"} ${m}`); };
const W = "work";
const EV = "evidence";
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W, { recursive: true });
fs.mkdirSync(EV, { recursive: true });
const frames = makeFrames(10000, 173);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const summaries = {};
const keep = (name, r) => { const { _durations, _published, _acked, ...s } = r; void _published; void _acked; summaries[name] = s; return _durations; };
const seg = (name) => { const p = `${W}/${name}.seg`; fs.rmSync(p, { force: true }); return p; };
const partition = (lines) => Buffer.from(lines.map((l) => `${l}\n`).join(""), "utf8");

// 0. Static: offline primitives only.
for (const f of ["tier0.mjs", "tier1.mjs", "fixture.mjs", "writer.mjs", "producer.mjs"]) {
  const s = fs.readFileSync(f, "utf8");
  const im = [...s.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  ok(im.every((x) => ["node:fs", "node:crypto", "node:path", "node:url", "node:child_process", "node:perf_hooks", "./tier0.mjs", "./tier1.mjs"].includes(x)), `${f} imports ${im.join(",")}`);
  ok(!/node:(net|http|https|dgram|dns|tls)|process\.env|fetch\(|t_ingest:/.test(s), `${f}: no network/env/t_ingest value`);
}
ok(fixtureSha(frames) === fixtureSha(makeFrames(10000, 173)), `fixture deterministic sha ${fixtureSha(frames)}`);
const nonCanon = frames.filter((f) => { try { return JSON.stringify(JSON.parse(f.raw.toString("utf8"))) !== f.raw.toString("utf8"); } catch { return true; } }).length;
ok(nonCanon > 0, `${nonCanon} frames whose bytes differ from parse+re-serialize`);

// 1. Round trip, no stall.
const s1 = seg("roundtrip");
const r1 = await run(frames, { segment: s1 });
keep("roundtrip", r1);
ok(r1.lost === 0 && r1.acked === 10000 && r1.unackedPublished === 0, `roundtrip lost=${r1.lost} acked=${r1.acked}`);
ok(r1.rejected === 0 && r1.strayAcks === 0 && r1.unexplainedGaps === 0 && !r1.drainTimedOut && r1.writerFailed === null, "roundtrip: 0 rejected/stray acks, 0 unexplained gaps, no drain timeout or writer failure");
const buf1 = fs.readFileSync(s1);
const sc1 = readSegment(buf1);
ok(sc1.records.length === 10000 && sc1.tailBytes === 0, `segment ${sc1.records.length} records, tail ${sc1.tailBytes}`);
ok(sc1.records.every((r, i) => r.raw.equals(frames[i].raw)), "every Tier-0 raw byte-equal to the received frame");
ok(sc1.records.every((r, i) => JSON.stringify(r.meta) === JSON.stringify(frames[i].meta)), "every Tier-0 metadata equal to supplied metadata");
ok([...r1._acked.entries()].every(([s, a]) => a.via === "append" && a.segment_id === r1.segmentId && a.epoch === 1 && a.offset + a.length <= buf1.length && rawSha(buf1.subarray(a.rawOffset, a.rawOffset + a.rawLength)) === a.sha256 && a.sha256 === rawSha(frames[s - 1].raw)), "every ack file/offset/sha resolves to the received bytes");

// 2. Deleted Tier-1 partition re-decoded from Tier-0, byte-identical.
const p = `${W}/tier1-partition.jsonl`;
fs.writeFileSync(p, partition(r1._published));
const shaA = sha(fs.readFileSync(p));
fs.rmSync(p);
fs.writeFileSync(p, partition(readSegment(fs.readFileSync(s1)).records.map((r) => tier1Line(r.raw))));
const shaB = sha(fs.readFileSync(p));
ok(shaA === shaB, `re-decoded Tier-1 partition byte-identical ${shaA}`);
summaries.redecode = { decisionPathSha: shaA, redecodedSha: shaB, identical: shaA === shaB, partitionBytes: fs.statSync(p).size };

// 3. Paired control vs writer stalled 2 s; every rep retained.
const reps = [];
for (let k = 0; k < 3; k++) {
  const arms = k % 2 === 0 ? ["control", "stalled"] : ["stalled", "control"];
  const res = {};
  for (const arm of arms) {
    const r = await run(frames, { segment: seg(`p99-${k}-${arm}`), ...(arm === "stalled" ? { stallAfterSeq: 2000, stallMs: 2000 } : {}) });
    const d = keep(`p99-rep${k}-${arm}`, r);
    fs.writeFileSync(`${EV}/p99-rep${k}-${arm}.json`, `${JSON.stringify({ rep: k, arm, order: arms, decisionNs: r.decisionNs, eventLoopDelayNs: r.eventLoopDelayNs, producerIo: r.producerIo, stall: r.stall, lost: r.lost, acked: r.acked, durationsNs: d })}\n`);
    res[arm] = r;
  }
  const c = res.control.decisionNs.p99;
  const s = res.stalled.decisionNs.p99;
  const bound = c + Math.max(1e6, 0.1 * c);
  reps.push({ rep: k, order: arms, controlP99Ns: c, stalledP99Ns: s, boundNs: bound, withinBound: s <= bound, stallMs: res.stalled.stall.ms, decisionsDuringStall: res.stalled.stall.decisionsDuringStall, controlEventLoopP99Ns: res.control.eventLoopDelayNs.p99, stalledEventLoopP99Ns: res.stalled.eventLoopDelayNs.p99 });
  ok(res.stalled.stall.observed && res.stalled.stall.ms >= 2000, `rep ${k}: writer stall observed ${res.stalled.stall.ms?.toFixed(1)} ms`);
  ok(res.stalled.stall.decisionsDuringStall > 0, `rep ${k}: ${res.stalled.stall.decisionsDuringStall} decisions completed while writer stalled`);
  ok(res.stalled.lost === 0 && res.stalled.acked === 10000 && res.control.acked === 10000, `rep ${k}: both arms 10000 acked, 0 lost`);
  console.log(`MEASURED rep ${k} (${arms.join(" then ")}): callback p99 control ${c} ns, stalled ${s} ns, bound ${bound} ns -> ${s <= bound ? "within" : "OUTSIDE"} max(1 ms, 10%); event-loop delay p99 control ${res.control.eventLoopDelayNs.p99} ns, stalled ${res.stalled.eventLoopDelayNs.p99} ns (reported, not bounded); producer ack+pipe ns control ${res.control.producerIo.ackHandlingNs + res.control.producerIo.pipeWriteNs}, stalled ${res.stalled.producerIo.ackHandlingNs + res.stalled.producerIo.pipeWriteNs}`);
}
summaries.p99 = reps;

// 4. Crash (SIGKILL) and restart.
const s4 = seg("crash");
const r4 = await run(frames, { segment: s4, crashAtSeq: 3000 });
keep("crash", r4);
const sc4 = readSegment(fs.readFileSync(s4));
ok(r4.writerStarts === 2 && r4.exits.some((e) => e.sig === "SIGKILL"), `crash: writer SIGKILLed and restarted (${r4.writerStarts} starts)`);
ok(r4.acked === 10000 && r4.lost === 0 && sc4.records.length === 10000 && sc4.records.every((r, i) => r.meta.seq === i + 1 && r.raw.equals(frames[i].raw)), "crash: every seq exactly once, in order, byte-equal");

// 5. Torn tail.
const s5 = seg("torn");
const r5 = await run(frames, { segment: s5, crashAtSeq: 3000, tear: true });
keep("torn", r5);
const sc5 = readSegment(fs.readFileSync(s5));
const qz = r5.recovered[1]?.quarantine;
ok(r5.recovered.length === 2 && qz !== null && qz !== undefined && qz.bytes > 0 && /^torn_/.test(qz.tailReason), `torn: proven torn final write ${qz?.bytes} B (${qz?.tailReason}) quarantined at offset ${qz?.offset}`);
ok(qz && fs.existsSync(qz.file) && sha(fs.readFileSync(qz.file)) === qz.sha256 && fs.statSync(qz.file).size === qz.bytes, "torn: quarantine file holds exactly the cut bytes (sha matches)");
ok(r5.acked === 10000 && sc5.records.length === 10000 && sc5.tailBytes === 0 && sc5.records.every((r, i) => r.raw.equals(frames[i].raw)), "torn: final segment 10000 valid records");

// 6. Overflow: small queue + 2 s stall.
const s6 = seg("overflow");
const r6 = await run(frames, { segment: s6, queueCap: 256, stallAfterSeq: 1000, stallMs: 2000 });
keep("overflow", r6);
const sc6 = readSegment(fs.readFileSync(s6));
const lostSet = new Set(r6.lostRanges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, j) => a + j)));
const durable = sc6.records.map((r) => r.meta.seq);
ok(r6.lost > 0 && lostSet.size === r6.lost, `overflow: ${r6.lost} lost in ${r6.lostRanges.length} ranges`);
ok(durable.length + r6.lost === 10000 && durable.every((s) => !lostSet.has(s)) && r6.acked === durable.length, "overflow: durable + lost = published; no lost seq in Tier-0; acked = durable");
ok(sha(partition(sc6.records.map((r) => tier1Line(r.raw)))) === sha(partition(r6._published.filter((_, i) => !lostSet.has(i + 1)))), "overflow: re-decode equals decision-path Tier-1 for durable seqs");
summaries.overflow.coverage = { published: 10000, durable: durable.length, lost: r6.lost, lostRanges: r6.lostRanges, complete: false };

// 7. Owned cleanup: writer ignoring TERM, stuck in a 10 s stall, aborted.
const r7 = await run(frames.slice(0, 2000), { segment: seg("abort"), stallAfterSeq: 10, stallMs: 10000, ignoreTerm: true, abortAfterMs: 500 });
keep("abort", r7);
ok(r7.aborted && r7.cleanup.term && r7.cleanup.kill && r7.exits.some((e) => e.sig === "SIGKILL"), "abort: TERM then KILL escalation");
ok(r7.unackedPublished > 0, `abort: ${r7.unackedPublished} published records never acked (no raw_ref; not compliant)`);
// 8. Falsification of A7 8af9d42 counterexamples and related corruption/identity cases. Writer run directly.
const writerOnce = (segPath, id, input = Buffer.alloc(0)) => {
  const p = spawnSync(process.execPath, ["writer.mjs", "--segment", segPath, "--segment-id", id, "--epoch", "9"], { input });
  return { status: p.status, msgs: p.stdout.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
};
const fileSha = (f) => sha(fs.readFileSync(f));
const qFiles = (f) => fs.readdirSync(W).filter((x) => x.startsWith(`${f.split("/").pop()}.quarantine`));
{ // 3 small records, corrupted middle body -> refuse, bytes unchanged, valid suffix kept
  const f = seg("small3");
  const r = await run(frames.slice(0, 3).map((x) => ({ ...x, raw: Buffer.from(`f${x.seq}`) })), { segment: f });
  const sc = readSegment(fs.readFileSync(f));
  const b = fs.readFileSync(f); b[sc.records[1].rawOffset] ^= 1; fs.writeFileSync(f, b);
  const before = fileSha(f); const size = b.length;
  const w = writerOnce(f, r.segmentId);
  const ref = w.msgs.find((m) => m.type === "refused");
  ok(w.status === 3 && ref?.reason === "corrupt_segment" && ref.tailReason === "bad_sha" && fileSha(f) === before && fs.statSync(f).size === size && qFiles(f).length === 0,
    `A7 small3 corrupt middle (${size} B): refused ${ref?.reason}/${ref?.tailReason} exit ${w.status}, bytes unchanged, no quarantine`);
}
{ // record 5000 of a 10,000-record segment corrupted
  const f = `${W}/mid5000.seg`; fs.copyFileSync(s1, f);
  const b = fs.readFileSync(f); b[readSegment(b).records[4999].rawOffset] ^= 1; fs.writeFileSync(f, b);
  const before = fileSha(f);
  const w = writerOnce(f, r1.segmentId);
  ok(w.status === 3 && w.msgs.find((m) => m.type === "refused")?.tailReason === "bad_sha" && fileSha(f) === before && w.msgs.every((m) => m.type !== "ack"), "A7 P1 corrupt record 5000: refused, all 10,000 records' bytes kept, no acks");
}
for (const [name, bytes] of [["bad-magic-tail", Buffer.from("xyz")], ["bad-length-tail", Buffer.concat([Buffer.from("T0R1", "latin1"), Buffer.from([0xff, 0xff, 0xff, 0xff])])]]) {
  const f = `${W}/${name}.seg`; fs.copyFileSync(s1, f); fs.appendFileSync(f, bytes);
  const before = fileSha(f);
  const w = writerOnce(f, r1.segmentId);
  ok(w.status === 3 && fileSha(f) === before && qFiles(f).length === 0, `${name}: not a proven torn write -> refused ${w.msgs.find((m) => m.type === "refused")?.tailReason}, unchanged`);
}
{ // foreign regular file, symlink to a 13-byte foreign file, identity mismatch
  const f = `${W}/foreign.txt`; fs.writeFileSync(f, "operator notes, not a segment\n".repeat(100));
  const before = fileSha(f);
  const w = writerOnce(f, r1.segmentId);
  ok(w.status === 3 && w.msgs[0].reason === "foreign_file" && fileSha(f) === before, `A7 P2a foreign file: refused ${w.msgs[0].reason}, ${fs.statSync(f).size} B unchanged`);
  fs.writeFileSync(`${W}/target13.txt`, "13 bytes here");
  fs.symlinkSync("target13.txt", `${W}/link.seg`);
  const w2 = writerOnce(`${W}/link.seg`, r1.segmentId);
  ok(w2.status === 3 && w2.msgs[0].reason === "segment_is_symlink" && fs.readFileSync(`${W}/target13.txt`, "utf8") === "13 bytes here", "A7 symlink segment -> 13 B foreign target: refused segment_is_symlink, target unchanged");
  const g = `${W}/other-id.seg`; fs.copyFileSync(s1, g); const gb = fileSha(g);
  const w3 = writerOnce(g, crypto.randomUUID());
  ok(w3.status === 3 && w3.msgs[0].reason === "segment_identity_mismatch" && fileSha(g) === gb, "segment_id mismatch: refused, unchanged");
}
{ // producer on a foreign-id segment: explicit refusal, no timeout misattribution
  const f = `${W}/p4.seg`; fs.copyFileSync(s1, f); const before = fileSha(f);
  const t0 = Date.now();
  const r = await run(frames.slice(0, 200), { segment: f, drainTimeoutMs: 3000 });
  keep("falsify-p4-foreign-id", r);
  ok(r.writerFailed?.refusal?.reason === "segment_identity_mismatch" && !r.drainTimedOut && r.acked === 0 && r.unackedPublished === 200 && fileSha(f) === before && Date.now() - t0 < 3000,
    `A7 P4 rerun on existing segment with a new id: writerFailed ${r.writerFailed?.refusal?.reason}, ${Date.now() - t0} ms, 0 acked, segment unchanged`);
}
{ // seed 999 frames, same segment_id, against the seed 173 segment
  const f = `${W}/p4b.seg`; fs.copyFileSync(s1, f); const before = fileSha(f);
  const other = makeFrames(200, 999);
  const r = await run(other, { segment: f, segmentId: r1.segmentId, drainTimeoutMs: 3000 });
  keep("falsify-p4b-seed999", r);
  const wrong = [...r._acked.entries()].filter(([s, a]) => a.sha256 !== rawSha(other[s - 1].raw)).length;
  ok(wrong === 0 && r.acked === 0 && r.rejected === 200 && !r.drainTimedOut && fileSha(f) === before,
    `A7 P4b seed-999 vs seed-173 segment: ${r.acked} acked, ${wrong} wrong-sha accepted, ${r.rejected} rejected ${JSON.stringify(r.rejectedReasons)}, segment unchanged`);
}
{ // same id, identical frames re-sent: explicit dup_identical/recovery acks against durable offsets
  const f = `${W}/same.seg`; fs.copyFileSync(s1, f); const before = fileSha(f);
  const r = await run(frames.slice(0, 200), { segment: f, segmentId: r1.segmentId, drainTimeoutMs: 3000 });
  keep("falsify-same-id-identical", r);
  ok(r.acked === 200 && r.rejected === 0 && !r.drainTimedOut && [...r._acked.values()].every((a) => a.offset === r1._acked.get(1 + [...r._acked.values()].indexOf(a)).offset) && fileSha(f) === before,
    `identical re-send on own segment: 200 acked at original offsets ${JSON.stringify(r.ackedVia)}, segment unchanged`);
}
{ // seqs 1,5,3 straight to the writer
  const f = seg("gap");
  const m = (x) => Buffer.from(JSON.stringify({ seq: x }));
  const w = writerOnce(f, crypto.randomUUID(), Buffer.concat([encodePipe(m(1), Buffer.from("a")), encodePipe(m(5), Buffer.from("b")), encodePipe(m(3), Buffer.from("c"))]));
  const t = w.msgs.map((x) => x.type + (x.seq ? `:${x.seq}` : x.from ? `:${x.from}-${x.to}` : "") + (x.reason ? `(${x.reason})` : ""));
  ok(t.includes("gap:2-4") && t.includes("rejected:3(out_of_order)") && readSegment(fs.readFileSync(f)).records.map((r) => r.meta.seq).join() === "1,5", `A7 P6 seqs 1,5,3: ${t.join(",")}`);
}
{ // overflow gaps are explained by producer lost ranges
  ok(summaries.overflow.writerGaps.length > 0 && summaries.overflow.unexplainedGaps === 0, `overflow: writer reported gaps ${JSON.stringify(summaries.overflow.writerGaps)}, all inside producer lost ranges`);
}
{ // foreign process with writer.mjs in argv is not touched by owned cleanup
  const decoy = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "writer.mjs", "--segment", `${W}/abort2.seg`], { stdio: "ignore" });
  const r = await run(frames.slice(0, 2000), { segment: seg("abort2"), stallAfterSeq: 10, stallMs: 10000, ignoreTerm: true, abortAfterMs: 500 });
  keep("falsify-decoy", r);
  ok(alive(decoy.pid) && r.survivors.length === 0 && r.cleanup.kill, `A7 P5 foreign decoy pid alive (not owned, not signalled); owned survivors ${r.survivors.length}`);
  decoy.kill("SIGKILL");
}

const allPids = Object.values(summaries).flatMap((s) => s.pids ?? []);
ok(allPids.length >= 11 && allPids.every((x) => !alive(x)), `no owned writer survives (${allPids.length} pids checked)`);

fs.writeFileSync(`${EV}/summary.json`, `${JSON.stringify({ fixtureSha: fixtureSha(frames), frames: frames.length, summaries }, null, 2)}\n`);
fs.rmSync(W, { recursive: true, force: true });
console.log(`${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);

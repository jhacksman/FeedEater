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
const writerOnce = (segPath, id, input = Buffer.alloc(0), extra = []) => {
  const p = spawnSync(process.execPath, ["writer.mjs", "--segment", segPath, "--segment-id", id, "--epoch", "9", ...extra], { input, maxBuffer: 1 << 28 });
  return { status: p.status, msgs: p.stdout.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
};
const fileSha = (f) => sha(fs.readFileSync(f));
const cpSeg = (a, b) => { fs.copyFileSync(a, b); fs.copyFileSync(`${a}.commit`, `${b}.commit`); };
const pairSha = (f) => `${sha(fs.readFileSync(f))}:${fs.existsSync(`${f}.commit`) ? sha(fs.readFileSync(`${f}.commit`)) : "-"}`;
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
  const f = `${W}/mid5000.seg`; cpSeg(s1, f);
  const b = fs.readFileSync(f); b[readSegment(b).records[4999].rawOffset] ^= 1; fs.writeFileSync(f, b);
  const before = fileSha(f);
  const w = writerOnce(f, r1.segmentId);
  ok(w.status === 3 && w.msgs.find((m) => m.type === "refused")?.tailReason === "bad_sha" && fileSha(f) === before && w.msgs.every((m) => m.type !== "ack"), "A7 P1 corrupt record 5000: refused, all 10,000 records' bytes kept, no acks");
}
for (const [name, bytes] of [["bad-magic-tail", Buffer.from("xyz")], ["bad-length-tail", Buffer.concat([Buffer.from("T0R1", "latin1"), Buffer.from([0xff, 0xff, 0xff, 0xff])])]]) {
  const f = `${W}/${name}.seg`; cpSeg(s1, f); fs.appendFileSync(f, bytes);
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
  const g = `${W}/other-id.seg`; cpSeg(s1, g); const gb = fileSha(g);
  const w3 = writerOnce(g, crypto.randomUUID());
  ok(w3.status === 3 && w3.msgs[0].reason === "segment_identity_mismatch" && fileSha(g) === gb, "segment_id mismatch: refused, unchanged");
}
{ // producer on a foreign-id segment: explicit refusal, no timeout misattribution
  const f = `${W}/p4.seg`; cpSeg(s1, f); const before = fileSha(f);
  const t0 = Date.now();
  const r = await run(frames.slice(0, 200), { segment: f, drainTimeoutMs: 3000 });
  keep("falsify-p4-foreign-id", r);
  ok(r.writerFailed?.refusal?.reason === "segment_identity_mismatch" && !r.drainTimedOut && r.acked === 0 && r.unackedPublished === 200 && fileSha(f) === before && Date.now() - t0 < 3000,
    `A7 P4 rerun on existing segment with a new id: writerFailed ${r.writerFailed?.refusal?.reason}, ${Date.now() - t0} ms, 0 acked, segment unchanged`);
}
{ // seed 999 frames, same segment_id, against the seed 173 segment
  const f = `${W}/p4b.seg`; cpSeg(s1, f); const before = fileSha(f);
  const other = makeFrames(200, 999);
  const r = await run(other, { segment: f, segmentId: r1.segmentId, drainTimeoutMs: 3000 });
  keep("falsify-p4b-seed999", r);
  const wrong = [...r._acked.entries()].filter(([s, a]) => a.sha256 !== rawSha(other[s - 1].raw)).length;
  ok(wrong === 0 && r.acked === 0 && r.rejected === 200 && !r.drainTimedOut && fileSha(f) === before,
    `A7 P4b seed-999 vs seed-173 segment: ${r.acked} acked, ${wrong} wrong-sha accepted, ${r.rejected} rejected ${JSON.stringify(r.rejectedReasons)}, segment unchanged`);
}
{ // same id, identical frames re-sent: explicit dup_identical/recovery acks against durable offsets
  const f = `${W}/same.seg`; cpSeg(s1, f); const before = fileSha(f);
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

// 9. Correction 2: committed-end recovery contract (A7 8cc61d3 new HIGH and related cases).
const lenField = (r, which) => (which === "meta" ? r.offset + 4 : r.rawOffset - 4);
const refusedUnchanged = (label, f, w, before, extraOk = true) => {
  const ref = w.msgs.find((m) => m.type === "refused");
  ok(w.status === 3 && ref !== undefined && pairSha(f) === before && qFiles(f).length === 0 && w.msgs.every((m) => m.type !== "ack") && extraOk,
    `${label}: refused ${ref?.reason}${ref?.region ? `/${ref.region}` : ""}${ref?.tailReason ? `/${ref.tailReason}` : ""} exit ${w.status}, segment+journal unchanged, no quarantine, no acks`);
  return ref;
};
{ // A7 8cc61d3: header + three small records, middle rawLen 3 -> 1000 (below MAX_RAW)
  const f = seg("c2small3");
  const r = await run(frames.slice(0, 3).map((x) => ({ ...x, raw: Buffer.from(`f${x.seq}`) })), { segment: f });
  const b = fs.readFileSync(f); const sc = readSegment(b);
  b.writeUInt32BE(1000, lenField(sc.records[1], "raw")); fs.writeFileSync(f, b);
  const before = pairSha(f);
  const ref = refusedUnchanged(`A7 8cc61d3 small3 (${b.length} B) middle rawLen 3->1000`, f, writerOnce(f, r.segmentId), before);
  ok(ref?.region === "committed" && fs.statSync(f).size === b.length, `A7 8cc61d3: refused in committed region, active file still ${fs.statSync(f).size} B (no records lost)`);
}
for (const [label, idx, which, v] of [["middle", 4999, "raw", 15 << 20], ["A7 probe 9990", 9989, "raw", 15 << 20], ["middle", 4999, "meta", 60000], ["near-end", 9998, "raw", 1000],
  ["near-end", 9998, "meta", 1], ["final", 9999, "raw", 15 << 20], ["final", 9999, "meta", 60000], ["final", 9999, "raw", 1]]) {
  const f = `${W}/c2len-${idx}-${which}-${v}.seg`; cpSeg(s1, f);
  const b = fs.readFileSync(f); b.writeUInt32BE(v, lenField(readSegment(b).records[idx], which)); fs.writeFileSync(f, b);
  refusedUnchanged(`${label} record ${idx + 1} ${which}Len -> ${v}`, f, writerOnce(f, r1.segmentId), pairSha(f));
}
{ // interrupted append states through the producer
  for (const fault of ["crash-mid-append", "crash-before-commit", "crash-before-ack"]) {
    const f = seg(`c2-${fault}`);
    const fr = frames.slice(0, 4000);
    const r = await run(fr, { segment: f, writerFault: fault, writerFaultAtSeq: 3000 });
    keep(`c2-${fault}`, r);
    const sc = readSegment(fs.readFileSync(f));
    const q = r.recovered[1]?.quarantine;
    const seqOk = sc.records.length === 4000 && sc.records.every((x, k) => x.meta.seq === k + 1 && x.raw.equals(fr[k].raw)) && sc.tailBytes === 0;
    const qOk = fault === "crash-before-ack" ? q === null && (r.ackedVia.recovery ?? 0) > 0
      : q !== null && q !== undefined && fs.existsSync(q.file) && sha(fs.readFileSync(q.file)) === q.sha256 && (fault === "crash-mid-append" ? /^torn_/.test(q.tailReason) : q.uncommittedCompleteRecords > 0);
    ok(r.writerStarts === 2 && r.exits[0].code === 7 && seqOk && qOk && r.acked === 4000 && r.rejected === 0 && !r.drainTimedOut,
      `${fault} at seq 3000: restart, every seq once in order byte-equal, 4000 acked; quarantine ${q ? `${q.bytes} B ${q.tailReason ?? "complete"} uncommittedComplete=${q.uncommittedCompleteRecords}` : "none"}; recovery acks ${r.ackedVia.recovery ?? 0}`);
  }
}
{ // uncommitted region: complete records after C
  const id = crypto.randomUUID();
  const m = (x) => Buffer.from(JSON.stringify({ seq: x }));
  const mk = (name) => { const f = seg(name); writerOnce(f, id, Buffer.concat([1, 2].map((x) => encodePipe(m(x), Buffer.from(`r${x}`)))));
    const w = writerOnce(f, id, Buffer.concat([3, 4].map((x) => encodePipe(m(x), Buffer.from(`r${x}`)))), ["--fault", "crash-before-commit", "--fault-at-seq", "3"]);
    return { f, w }; };
  const a = mk("c2unc-a");
  const b = fs.readFileSync(a.f); const sc = readSegment(b);
  b.writeUInt32BE(1000, lenField(sc.records[3], "raw")); fs.writeFileSync(a.f, b);
  const tail = b.subarray(sc.records[2].offset);
  const wa = writerOnce(a.f, id);
  const qa = wa.msgs.find((x) => x.type === "recovered")?.quarantine;
  ok(a.w.status === 7 && wa.status === 0 && qa?.offset === sc.records[2].offset && qa.sha256 === sha(tail) && readSegment(fs.readFileSync(a.f)).records.length === 2 && wa.msgs.filter((x) => x.type === "ack").length === 2,
    `uncommitted final record rawLen->1000 after C: never acked, so cut after exact quarantine (${qa?.bytes} B, sha matches original bytes); 2 committed records kept and recovery-acked`);
  const c = mk("c2unc-b");
  const cb = fs.readFileSync(c.f); cb.writeUInt32BE(1, lenField(readSegment(cb).records[2], "raw")); fs.writeFileSync(c.f, cb);
  refusedUnchanged("uncommitted record 3 rawLen->1 (framing not a proven partial)", c.f, writerOnce(c.f, id), pairSha(c.f));
}
{ // quarantine and directory-fsync failures refuse before truncation
  const mkTorn = (name) => { const f = `${W}/${name}.seg`; cpSeg(s1, f); fs.appendFileSync(f, encodeRecord(Buffer.from('{"seq":10001}'), Buffer.from("x".repeat(100))).subarray(0, 60)); return f; };
  const f1 = mkTorn("c2-qfail");
  refusedUnchanged("quarantine write failure (injected)", f1, writerOnce(f1, r1.segmentId, Buffer.alloc(0), ["--fault", "fail-quarantine"]), pairSha(f1));
  const f2 = mkTorn("c2-qexists");
  const C = fs.statSync(s1).size;
  fs.writeFileSync(`${f2}.quarantine-${C}-e9`, "pre-existing");
  const b2 = pairSha(f2);
  const w2 = writerOnce(f2, r1.segmentId);
  ok(w2.status === 3 && w2.msgs[0].reason === "quarantine_failed" && w2.msgs[0].code === "EEXIST" && pairSha(f2) === b2 && fs.readFileSync(`${f2}.quarantine-${C}-e9`, "utf8") === "pre-existing",
    "quarantine file already exists: refused quarantine_failed/EEXIST, segment+journal and existing file unchanged");
  const f3 = mkTorn("c2-dirfail");
  const b3 = pairSha(f3);
  const w3 = writerOnce(f3, r1.segmentId, Buffer.alloc(0), ["--fault", "fail-dir-fsync"]);
  ok(w3.status === 3 && w3.msgs[0].reason === "quarantine_failed" && w3.msgs[0].code === "EIO_INJECTED" && pairSha(f3) === b3,
    "directory fsync failure after quarantine write (injected): refused, segment+journal unchanged (partial quarantine copy may remain)");
  const f4 = mkTorn("c2-torn-ok");
  const w4 = writerOnce(f4, r1.segmentId);
  const q4 = w4.msgs.find((x) => x.type === "recovered")?.quarantine;
  ok(w4.status === 0 && q4?.offset === C && q4.bytes === 60 && fs.statSync(f4).size === C && q4.tailReason === "torn_body", `genuine partial final append after C: 60 B quarantined (${q4?.tailReason}), active file back to C`);
}
{ // journal integrity
  const f = `${W}/c2-jmissing.seg`; fs.copyFileSync(s1, f); const b = sha(fs.readFileSync(f));
  const w = writerOnce(f, r1.segmentId);
  ok(w.status === 3 && w.msgs[0].reason === "journal_missing" && sha(fs.readFileSync(f)) === b, "journal missing: refused journal_missing, segment unchanged");
  const g = `${W}/c2-jlink.seg`; fs.copyFileSync(s1, g); fs.symlinkSync("c2-jmissing.seg", `${g}.commit`);
  ok(writerOnce(g, r1.segmentId).msgs[0].reason === "journal_is_symlink", "journal symlink: refused journal_is_symlink");
  const h = `${W}/c2-jbad.seg`; cpSeg(s1, h); const jb = fs.readFileSync(`${h}.commit`); jb[48 * 5 + 20] ^= 1; fs.writeFileSync(`${h}.commit`, jb);
  refusedUnchanged("journal entry 6 corrupted", h, writerOnce(h, r1.segmentId), pairSha(h));
  const k = `${W}/c2-jtorn.seg`; cpSeg(s1, k); fs.appendFileSync(`${k}.commit`, Buffer.alloc(20, 7));
  const wk = writerOnce(k, r1.segmentId); const rk = wk.msgs.find((x) => x.type === "recovered");
  ok(wk.status === 0 && rk?.journalQuarantine?.bytes === 20 && rk.records === 10000 && fs.statSync(`${k}.commit`).size % 48 === 0, "journal partial final entry (20 B): quarantined, journal truncated to whole entries, 10000 records kept");
}
{ // raw bytes containing record-looking content
  const fr = frames.slice(0, 50).map((x, k) => ({ ...x, raw: Buffer.concat([Buffer.from("T0R1T0H1T0C1"), encodeRecord(Buffer.from(`{"seq":${k + 9}}`), Buffer.from("fake")), x.raw]) }));
  const f = seg("c2lookalike");
  const r = await run(fr, { segment: f, crashAtSeq: 25, tear: true });
  const sc = readSegment(fs.readFileSync(f));
  ok(r.acked === 50 && sc.records.length === 50 && sc.records.every((x, k) => x.raw.equals(fr[k].raw)), "raw bytes containing T0R1/T0H1/T0C1 and an embedded encoded record: crash+tear recovery keeps all 50, byte-equal");
}

const allPids = Object.values(summaries).flatMap((s) => s.pids ?? []);
ok(allPids.length >= 11 && allPids.every((x) => !alive(x)), `no owned writer survives (${allPids.length} pids checked)`);

fs.writeFileSync(`${EV}/summary.json`, `${JSON.stringify({ fixtureSha: fixtureSha(frames), frames: frames.length, summaries }, null, 2)}\n`);
fs.rmSync(W, { recursive: true, force: true });
console.log(`${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);

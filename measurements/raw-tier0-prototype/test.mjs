// Hermetic acceptance run. Synthetic frames, host timing only; no broker/node/network.
import fs from "node:fs";
import crypto from "node:crypto";
import { makeFrames, fixtureSha } from "./fixture.mjs";
import { run, alive } from "./producer.mjs";
import { scan, rawSha } from "./tier0.mjs";
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
  ok(im.every((x) => ["node:fs", "node:crypto", "node:path", "node:url", "node:child_process", "./tier0.mjs", "./tier1.mjs"].includes(x)), `${f} imports ${im.join(",")}`);
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
ok(r1.ackStatViolations === 0, "every ack arrived with offset+length inside the file");
const buf1 = fs.readFileSync(s1);
const sc1 = scan(buf1);
ok(sc1.records.length === 10000 && sc1.tailBytes === 0, `segment ${sc1.records.length} records, tail ${sc1.tailBytes}`);
ok(sc1.records.every((r, i) => r.raw.equals(frames[i].raw)), "every Tier-0 raw byte-equal to the received frame");
ok(sc1.records.every((r, i) => JSON.stringify(r.meta) === JSON.stringify(frames[i].meta)), "every Tier-0 metadata equal to supplied metadata");
ok([...r1._acked.entries()].every(([s, a]) => a.via === "append" && rawSha(buf1.subarray(a.rawOffset, a.rawOffset + a.rawLength)) === a.sha256 && a.sha256 === rawSha(frames[s - 1].raw)), "every ack file/offset/sha resolves to the received bytes");

// 2. Deleted Tier-1 partition re-decoded from Tier-0, byte-identical.
const p = `${W}/tier1-partition.jsonl`;
fs.writeFileSync(p, partition(r1._published));
const shaA = sha(fs.readFileSync(p));
fs.rmSync(p);
fs.writeFileSync(p, partition(scan(fs.readFileSync(s1)).records.map((r) => tier1Line(r.raw))));
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
    fs.writeFileSync(`${EV}/p99-rep${k}-${arm}.json`, `${JSON.stringify({ rep: k, arm, order: arms, decisionNs: r.decisionNs, stall: r.stall, lost: r.lost, acked: r.acked, durationsNs: d })}\n`);
    res[arm] = r;
  }
  const c = res.control.decisionNs.p99;
  const s = res.stalled.decisionNs.p99;
  const bound = c + Math.max(1e6, 0.1 * c);
  reps.push({ rep: k, order: arms, controlP99Ns: c, stalledP99Ns: s, boundNs: bound, withinBound: s <= bound, stallMs: res.stalled.stall.ms, decisionsDuringStall: res.stalled.stall.decisionsDuringStall });
  ok(res.stalled.stall.observed && res.stalled.stall.ms >= 2000, `rep ${k}: writer stall observed ${res.stalled.stall.ms?.toFixed(1)} ms`);
  ok(res.stalled.stall.decisionsDuringStall > 0, `rep ${k}: ${res.stalled.stall.decisionsDuringStall} decisions completed while writer stalled`);
  ok(res.stalled.lost === 0 && res.stalled.acked === 10000 && res.control.acked === 10000, `rep ${k}: both arms 10000 acked, 0 lost`);
  console.log(`MEASURED rep ${k} (${arms.join(" then ")}): control p99 ${c} ns, stalled p99 ${s} ns, bound ${bound} ns -> ${s <= bound ? "within" : "OUTSIDE"} max(1 ms, 10%)`);
}
summaries.p99 = reps;

// 4. Crash (SIGKILL) and restart.
const s4 = seg("crash");
const r4 = await run(frames, { segment: s4, crashAtSeq: 3000 });
keep("crash", r4);
const sc4 = scan(fs.readFileSync(s4));
ok(r4.writerStarts === 2 && r4.exits.some((e) => e.sig === "SIGKILL"), `crash: writer SIGKILLed and restarted (${r4.writerStarts} starts)`);
ok(r4.acked === 10000 && r4.lost === 0 && sc4.records.length === 10000 && sc4.records.every((r, i) => r.meta.seq === i + 1 && r.raw.equals(frames[i].raw)), "crash: every seq exactly once, in order, byte-equal");

// 5. Torn tail.
const s5 = seg("torn");
const r5 = await run(frames, { segment: s5, crashAtSeq: 3000, tear: true });
keep("torn", r5);
const sc5 = scan(fs.readFileSync(s5));
ok(r5.recovered.length === 2 && r5.recovered[1].truncatedTailBytes > 0 && r5.recovered[1].tailReason !== null, `torn: recovery truncated ${r5.recovered[1]?.truncatedTailBytes} bytes (${r5.recovered[1]?.tailReason})`);
ok(r5.acked === 10000 && sc5.records.length === 10000 && sc5.tailBytes === 0 && sc5.records.every((r, i) => r.raw.equals(frames[i].raw)), "torn: final segment 10000 valid records");

// 6. Overflow: small queue + 2 s stall.
const s6 = seg("overflow");
const r6 = await run(frames, { segment: s6, queueCap: 256, stallAfterSeq: 1000, stallMs: 2000 });
keep("overflow", r6);
const sc6 = scan(fs.readFileSync(s6));
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
const allPids = Object.values(summaries).flatMap((s) => s.pids ?? []);
ok(allPids.length >= 11 && allPids.every((x) => !alive(x)), `no owned writer survives (${allPids.length} pids checked)`);

fs.writeFileSync(`${EV}/summary.json`, `${JSON.stringify({ fixtureSha: fixtureSha(frames), frames: frames.length, summaries }, null, 2)}\n`);
fs.rmSync(W, { recursive: true, force: true });
console.log(`${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);

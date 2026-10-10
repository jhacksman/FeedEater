// Producer: synchronous decision callback (decode -> in-memory publish -> bounded offer). Never awaits writer I/O.
// Ack handling and pipe writes run on the same event loop between callbacks; their time is accounted separately.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { encodePipe, encodeRecord, rawSha } from "./tier0.mjs";
import { tier1Line } from "./tier1.mjs";

const WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), "writer.mjs");
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pct = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const now = () => process.hrtime.bigint();

export function run(frames, o) {
  const opt = { queueCap: 16384, queueBytesCap: 64 << 20, retain: 16384, stallAfterSeq: 0, stallMs: 0, crashAtSeq: 0, tear: false,
    perTick: 2, ignoreTerm: false, abortAfterMs: 0, termGraceMs: 1000, drainTimeoutMs: 60000, segmentId: crypto.randomUUID(), ...o };
  const segId = opt.segmentId;
  const n = frames.length;
  const queue = [];
  let qBytes = 0;
  const inflight = new Map();
  const acked = new Map();
  const rejected = new Map();
  const lostRanges = [];
  const writerGaps = [];
  let lost = 0;
  let strayAcks = 0;
  const published = new Array(n);
  const durations = new Array(n);
  const decisionAt = new Array(n);
  const pids = [];
  const exits = [];
  const recovered = [];
  const refusals = [];
  const io = { ackHandlingNs: 0n, pipeWriteNs: 0n, ackMessages: 0 };
  let writer = null;
  let writable = false;
  let starts = 0;
  let onWriterExit = null;
  let pumpScheduled = false;
  let stopping = false;
  let writerFailed = null;
  let stallStart = null;
  let stallEnd = null;
  let endMsg = null;
  const cleanup = { term: false, kill: false };
  const eld = monitorEventLoopDelay({ resolution: 1 });

  return new Promise((resolve) => {
    const reject = (seq, reason, detail) => {
      inflight.delete(seq);
      const r = rejected.get(seq) ?? { seq, reasons: [] };
      r.reasons.push({ reason, ...detail });
      rejected.set(seq, r);
    };
    function onMsg(m, epoch) {
      if (m.type === "recovered") {
        recovered.push(m);
        const re = [...inflight.entries()].sort((a, b) => a[0] - b[0]);
        inflight.clear();
        const items = re.map(([seq, v]) => ({ seq, ...v }));
        queue.unshift(...items);
        for (const it of items) qBytes += it.raw.length;
        writable = true;
        pump();
      } else if (m.type === "ack") {
        io.ackMessages++;
        const r = inflight.get(m.seq);
        if (r === undefined) { if (!acked.has(m.seq) && !rejected.has(m.seq)) strayAcks++; return; }
        const why = m.segment_id !== segId ? "segment_id" : m.epoch !== epoch ? "epoch" : m.sha256 !== r.sha256 ? "raw_sha256" : m.metaSha256 !== r.metaSha256 ? "meta_sha256"
          : !(Number.isInteger(m.offset) && Number.isInteger(m.rawOffset) && m.rawLength === r.raw.length) ? "offsets" : null;
        if (why !== null) { reject(m.seq, `ack_mismatch_${why}`, { via: m.via }); return; }
        acked.set(m.seq, { segment_id: m.segment_id, epoch: m.epoch, file: m.file, offset: m.offset, length: m.length, rawOffset: m.rawOffset, rawLength: m.rawLength, sha256: m.sha256, metaSha256: m.metaSha256, via: m.via });
        inflight.delete(m.seq);
      } else if (m.type === "conflict") {
        reject(m.seq, "writer_conflict", { durableSha256: m.durableSha256, offeredSha256: m.offeredSha256 });
      } else if (m.type === "rejected") {
        if (Number.isInteger(m.seq)) reject(m.seq, `writer_${m.reason}`, {});
      } else if (m.type === "gap") writerGaps.push([m.from, m.to]);
      else if (m.type === "refused") refusals.push(m);
      else if (m.type === "stall") stallStart = now();
      else if (m.type === "stall_end") stallEnd = now();
      else if (m.type === "end") endMsg = m;
    }
    function startWriter() {
      starts++;
      const epoch = starts;
      const args = [WRITER, "--segment", opt.segment, "--segment-id", segId, "--epoch", String(epoch)];
      if (opt.stallMs > 0 && epoch === 1) args.push("--stall-after-seq", String(opt.stallAfterSeq), "--stall-ms", String(opt.stallMs));
      if (opt.writerFault && epoch === 1) { args.push("--fault", opt.writerFault, "--fault-at-seq", String(opt.writerFaultAtSeq)); onWriterExit = () => setTimeout(startWriter, 20); }
      if (opt.ignoreTerm) args.push("--ignore-term", "1");
      const c = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
      pids.push(c.pid);
      writer = c;
      writable = false;
      let buf = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (d) => {
        const t0 = now();
        buf += d;
        let k;
        while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); onMsg(JSON.parse(line), epoch); }
        io.ackHandlingNs += now() - t0;
      });
      c.stdin.on("error", () => {});
      c.on("exit", (code, sig) => {
        exits.push({ pid: c.pid, epoch, code, sig });
        if (writer !== c) return;
        writer = null;
        writable = false;
        if (onWriterExit) { const f = onWriterExit; onWriterExit = null; f(); } else if (!stopping) writerFailed = { epoch, code, sig, refusal: refusals[refusals.length - 1] ?? null };
      });
    }
    function pump() {
      if (writer === null || !writable) return;
      const t0 = now();
      while (queue.length > 0 && inflight.size < opt.retain) {
        const r = queue.shift();
        qBytes -= r.raw.length;
        inflight.set(r.seq, { metaBuf: r.metaBuf, raw: r.raw, sha256: r.sha256 ?? rawSha(r.raw), metaSha256: r.metaSha256 ?? rawSha(r.metaBuf) });
        if (!writer.stdin.write(encodePipe(r.metaBuf, r.raw))) {
          writable = false;
          const c = writer;
          c.stdin.once("drain", () => { if (writer === c) { writable = true; pump(); } });
          break;
        }
      }
      io.pipeWriteNs += now() - t0;
    }
    function offer(seq, metaBuf, raw) {
      if (queue.length >= opt.queueCap || qBytes + raw.length > opt.queueBytesCap) {
        lost++;
        const last = lostRanges[lostRanges.length - 1];
        if (last !== undefined && last[1] === seq - 1) last[1] = seq; else lostRanges.push([seq, seq]);
        return false;
      }
      queue.push({ seq, metaBuf, raw });
      qBytes += raw.length;
      if (!pumpScheduled) { pumpScheduled = true; setImmediate(() => { pumpScheduled = false; pump(); }); }
      return true;
    }
    function decision(i) {
      const f = frames[i];
      const t0 = now();
      published[i] = tier1Line(f.raw);
      offer(f.seq, Buffer.from(JSON.stringify(f.meta), "utf8"), f.raw);
      const t1 = now();
      durations[i] = Number(t1 - t0);
      decisionAt[i] = t1;
    }
    function crash() {
      onWriterExit = () => {
        if (opt.tear) {
          const nxt = [...inflight.entries()].sort((a, b) => a[0] - b[0])[0] ?? [0, { metaBuf: Buffer.from('{"seq":0}'), raw: Buffer.from("x") }];
          const rec = encodeRecord(nxt[1].metaBuf, nxt[1].raw);
          fs.appendFileSync(opt.segment, rec.subarray(0, Math.floor(rec.length / 2)));
        }
        setTimeout(startWriter, 20);
      };
      writer.kill("SIGKILL");
    }
    async function stopWriter(c, endInput) {
      stopping = true;
      if (c === null) return;
      if (endInput) c.stdin.end();
      const exited = () => exits.some((e) => e.pid === c.pid);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let t = 0; t < opt.termGraceMs && !exited(); t += 10) await wait(10);
      if (!exited()) { cleanup.term = true; c.kill("SIGTERM"); for (let t = 0; t < 1000 && !exited(); t += 10) await wait(10); }
      if (!exited()) { cleanup.kill = true; c.kill("SIGKILL"); for (let t = 0; t < 2000 && !exited(); t += 10) await wait(10); }
    }
    async function finish(aborted) {
      let drainTimedOut = false;
      if (aborted) await stopWriter(writer, false);
      else {
        const t0 = Date.now();
        while ((queue.length > 0 || inflight.size > 0 || writer === null) && writerFailed === null) {
          if (Date.now() - t0 >= opt.drainTimeoutMs) { drainTimedOut = true; break; }
          await new Promise((r) => setTimeout(r, 10));
        }
        await stopWriter(writer, true);
      }
      eld.disable();
      const sorted = [...durations].filter((x) => x !== undefined).sort((a, b) => a - b);
      let during = 0;
      if (stallStart !== null && stallEnd !== null) for (const t of decisionAt) if (t !== undefined && t >= stallStart && t <= stallEnd) during++;
      const lostSet = new Set(lostRanges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, j) => a + j)));
      const unexplainedGaps = writerGaps.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, j) => a + j)).filter((s) => !lostSet.has(s));
      const nPub = published.filter((x) => x !== undefined).length;
      const reasons = {};
      for (const r of rejected.values()) for (const x of r.reasons) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
      const via = {};
      for (const a of acked.values()) via[a.via] = (via[a.via] ?? 0) + 1;
      resolve({
        n, segmentId: segId, published: nPub, enqueued: n - lost, lost, lostRanges, writerGaps, unexplainedGaps: unexplainedGaps.length,
        acked: acked.size, ackedVia: via, rejected: rejected.size, rejectedReasons: reasons, strayAcks,
        unackedPublished: nPub - acked.size - lost, stillInflightOrQueued: inflight.size + queue.length,
        writerStarts: starts, recovered, refusals, writerFailed, drainTimedOut, exits, pids, survivors: pids.filter(alive), endMsg, aborted, cleanup,
        stall: { observed: stallStart !== null && stallEnd !== null, ms: stallStart !== null && stallEnd !== null ? Number(stallEnd - stallStart) / 1e6 : null, decisionsDuringStall: during },
        decisionNs: { p50: pct(sorted, 0.5), p99: pct(sorted, 0.99), max: sorted[sorted.length - 1] },
        producerIo: { ackHandlingNs: Number(io.ackHandlingNs), pipeWriteNs: Number(io.pipeWriteNs), ackMessages: io.ackMessages },
        eventLoopDelayNs: { p50: eld.percentile(50), p99: eld.percentile(99), max: eld.max },
        _durations: durations, _published: published, _acked: acked, _rejected: rejected,
      });
    }
    eld.enable();
    startWriter();
    let i = 0;
    let aborted = false;
    if (opt.abortAfterMs > 0) setTimeout(() => { aborted = true; }, opt.abortAfterMs);
    function tick() {
      if (aborted) return void finish(true);
      for (let k = 0; k < opt.perTick && i < n; k++) {
        decision(i);
        i++;
        if (opt.crashAtSeq > 0 && frames[i - 1].seq === opt.crashAtSeq) crash();
      }
      if (i < n) setTimeout(tick, 1);
      else if (opt.abortAfterMs > 0) { const w = () => (aborted ? finish(true) : setTimeout(w, 10)); w(); }
      else void finish(false);
    }
    setTimeout(tick, 50);
  });
}

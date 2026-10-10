// Producer: synchronous decision callback (decode -> in-memory publish -> bounded offer). Never awaits writer I/O.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePipe, encodeRecord } from "./tier0.mjs";
import { tier1Line } from "./tier1.mjs";

const WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), "writer.mjs");
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pct = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

export function run(frames, o) {
  const opt = { queueCap: 16384, queueBytesCap: 64 << 20, retain: 16384, stallAfterSeq: 0, stallMs: 0, crashAtSeq: 0, tear: false,
    perTick: 2, ignoreTerm: false, abortAfterMs: 0, termGraceMs: 1000, drainTimeoutMs: 60000, ...o };
  const n = frames.length;
  const queue = [];
  let qBytes = 0;
  const inflight = new Map();
  const acked = new Map();
  const lostRanges = [];
  let lost = 0;
  const published = new Array(n);
  const durations = new Array(n);
  const decisionAt = new Array(n);
  const pids = [];
  const exits = [];
  const recovered = [];
  const log = [];
  let ackStatViolations = 0;
  let writer = null;
  let writable = false;
  let starts = 0;
  let onWriterExit = null;
  let pumpScheduled = false;
  let stallStart = null;
  let stallEnd = null;
  let endMsg = null;
  const cleanup = { term: false, kill: false };

  return new Promise((resolve) => {
    function onMsg(m) {
      if (m.type === "recovered") {
        recovered.push(m);
        const re = [...inflight.entries()].filter(([s]) => s > m.lastSeq).sort((a, b) => a[0] - b[0]);
        for (const [s] of re) inflight.delete(s);
        const items = re.map(([seq, v]) => ({ seq, ...v }));
        queue.unshift(...items);
        for (const it of items) qBytes += it.raw.length;
        writable = true;
        pump();
      } else if (m.type === "ack") {
        if (inflight.has(m.seq)) {
          if (fs.statSync(m.file).size < m.offset + m.length) ackStatViolations++;
          const { metaBuf, raw, ...rest } = inflight.get(m.seq);
          void metaBuf; void raw; void rest;
          acked.set(m.seq, { file: m.file, offset: m.offset, length: m.length, rawOffset: m.rawOffset, rawLength: m.rawLength, sha256: m.sha256, via: m.via });
          inflight.delete(m.seq);
        }
      } else if (m.type === "stall") stallStart = process.hrtime.bigint();
      else if (m.type === "stall_end") stallEnd = process.hrtime.bigint();
      else if (m.type === "end") endMsg = m;
      log.push(m.type === "ack" ? null : m);
    }
    function startWriter() {
      const args = [WRITER, "--segment", opt.segment];
      if (opt.stallMs > 0 && starts === 0) args.push("--stall-after-seq", String(opt.stallAfterSeq), "--stall-ms", String(opt.stallMs));
      if (opt.ignoreTerm) args.push("--ignore-term", "1");
      const c = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
      starts++;
      pids.push(c.pid);
      writer = c;
      writable = false;
      let buf = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (d) => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); onMsg(JSON.parse(line)); } });
      c.stdin.on("error", () => {});
      c.on("exit", (code, sig) => {
        exits.push({ pid: c.pid, code, sig });
        if (writer === c) { writer = null; writable = false; if (onWriterExit) { const f = onWriterExit; onWriterExit = null; f(); } }
      });
    }
    function pump() {
      if (writer === null || !writable) return;
      while (queue.length > 0 && inflight.size < opt.retain) {
        const r = queue.shift();
        qBytes -= r.raw.length;
        inflight.set(r.seq, { metaBuf: r.metaBuf, raw: r.raw });
        if (!writer.stdin.write(encodePipe(r.metaBuf, r.raw))) {
          writable = false;
          const c = writer;
          c.stdin.once("drain", () => { if (writer === c) { writable = true; pump(); } });
          return;
        }
      }
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
      const t0 = process.hrtime.bigint();
      published[i] = tier1Line(f.raw);
      offer(f.seq, Buffer.from(JSON.stringify(f.meta), "utf8"), f.raw);
      const t1 = process.hrtime.bigint();
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
      if (c === null) return;
      if (endInput) c.stdin.end();
      const exited = () => exits.some((e) => e.pid === c.pid);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let t = 0; t < opt.termGraceMs && !exited(); t += 10) await wait(10);
      if (!exited()) { cleanup.term = true; c.kill("SIGTERM"); for (let t = 0; t < 1000 && !exited(); t += 10) await wait(10); }
      if (!exited()) { cleanup.kill = true; c.kill("SIGKILL"); for (let t = 0; t < 2000 && !exited(); t += 10) await wait(10); }
    }
    async function finish(aborted) {
      if (aborted) await stopWriter(writer, false);
      else {
        const t0 = Date.now();
        while ((queue.length > 0 || inflight.size > 0 || writer === null) && Date.now() - t0 < opt.drainTimeoutMs) await new Promise((r) => setTimeout(r, 10));
        await stopWriter(writer, true);
      }
      const sorted = [...durations].filter((x) => x !== undefined).sort((a, b) => a - b);
      let during = 0;
      if (stallStart !== null && stallEnd !== null) for (const t of decisionAt) if (t !== undefined && t >= stallStart && t <= stallEnd) during++;
      resolve({
        n, published: published.filter((x) => x !== undefined).length, enqueued: n - lost, lost, lostRanges,
        acked: acked.size, unackedPublished: published.filter((x) => x !== undefined).length - acked.size - lost,
        ackStatViolations, writerStarts: starts, recovered, exits, pids, survivors: pids.filter(alive), endMsg, aborted, cleanup,
        stall: { observed: stallStart !== null && stallEnd !== null, ms: stallStart !== null && stallEnd !== null ? Number(stallEnd - stallStart) / 1e6 : null, decisionsDuringStall: during },
        decisionNs: { p50: pct(sorted, 0.5), p99: pct(sorted, 0.99), max: sorted[sorted.length - 1] },
        _durations: durations, _published: published, _acked: acked,
      });
    }
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

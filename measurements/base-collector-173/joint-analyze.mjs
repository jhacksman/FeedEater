#!/usr/bin/env node
// Reads one verify-joint.sh case directory (raw evidence only) and prints one JSON object: latch, decisions
// after the latch seq recomputed from joint.jsonl, both censuses, fake-upstream/toy counts, pre-latch
// in-flight bytes and controller timings.   node joint-analyze.mjs CASE_DIR
import fs from "node:fs";
import path from "node:path";
const C = process.argv[2];
const rd = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const lines = (p) => (rd(p) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const j = (p) => (rd(p) === null ? null : JSON.parse(rd(p)));
const g = path.join(C, "g");
const log = lines(path.join(g, "joint.jsonl"));
const sum = j(path.join(g, "joint.summary.json"));
const stop = j(path.join(g, "JOINT.STOP"));
const run = j(path.join(g, "joint-run.json"));
const cdirs = fs.existsSync(path.join(C, "c")) ? fs.readdirSync(path.join(C, "c")).filter((d) => d.startsWith("jc-")) : [];
const toy = cdirs.length === 1 ? lines(path.join(C, "c", cdirs[0], "toy.jsonl")) : [];
const fh = lines(path.join(C, "http.up.jsonl"));
const fw = lines(path.join(C, "ws.up.jsonl"));
const seqOk = log.every((e, i) => e.seq === i + 1);
const latches = log.filter((e) => e.ev === "latch");
const L = latches[0] ?? null;
const after = (pred) => (L === null ? null : log.filter((e) => e.seq > L.seq && pred(e)).length);
const isWs = (d) => (e) => e.ev === "ws_forward" && e.dir === d;
const sig = toy.find((e) => e.ev === "signal") ?? null;
const out = {
  rc: run?.rc ?? null,
  reason: run?.reason ?? null,
  seqContiguous: seqOk,
  latchCount: latches.length,
  latch: L && { seq: L.seq, transport: L.transport, reason: L.reason, hrNs: L.hrNs, preLatch: L.preLatch },
  stopFileMatchesLog: stop !== null && L !== null && stop.seq === L.seq && stop.hrNs === L.hrNs,
  decisionsAfterLatch: {
    httpAdmit: after((e) => e.ev === "http_admit"),
    httpForward: after((e) => e.ev === "http_forward"),
    wsUp: after(isWs("up")),
    wsDown: after(isWs("down")),
  },
  decisionsBeforeLatch: {
    httpAdmit: log.filter((e) => e.ev === "http_admit").length,
    httpForward: log.filter((e) => e.ev === "http_forward").length,
    wsUp: log.filter(isWs("up")).length,
    wsDown: log.filter(isWs("down")).length,
  },
  guardCounters: sum?.decisions ?? null,
  reconciled: sum?.reconciled ?? null,
  allReconciled: sum?.allReconciled ?? null,
  http: sum && { received: sum.http.received, admitted: sum.http.admitted, refused: sum.http.refused, refusedReasons: sum.http.refusedReasons, forwarded: sum.http.forwarded, completed: sum.http.completed, dropped: sum.http.dropped, upstreamErrors: sum.http.upstreamErrors, respondedAfterLatch: sum.http.respondedAfterLatch, inflightAtExit: sum.http.inflightAtExit },
  ws: sum && { accepted: sum.ws.connectionsAccepted, received: sum.ws.received, admitted: sum.ws.admitted, refused: sum.ws.refused, refusedReasons: sum.ws.refusedReasons, dropped: sum.ws.dropped, droppedReasons: sum.ws.droppedReasons, forwarded: sum.ws.forwarded, sendErrors: sum.ws.sendErrors, inflightAtExit: sum.ws.inflightAtExit },
  fakeHttpReceived: fh.length,
  fakeWsReceived: fw.filter((e) => e.ev === "recv").length,
  fakeWsConnections: fw.filter((e) => e.ev === "connection").length,
  toyWsMessages: toy.filter((e) => e.ev === "ws_msg").length,
  toyHttpResponses: toy.filter((e) => e.ev === "http_resp").length,
  // forward decisions taken before the latch whose bytes were not observed at the far end (kernel/socket
  // buffers torn down at close); these are pre-latch decisions, not post-latch forwarding.
  preLatchUndelivered: {
    wsUp: log.filter(isWs("up")).length - fw.filter((e) => e.ev === "recv").length,
    wsDown: log.filter(isWs("down")).length - toy.filter((e) => e.ev === "ws_msg").length,
  },
  toySignalAfterLatchNs: sig && L ? (BigInt(sig.hrNs) - BigInt(L.hrNs)).toString() : null,
  trapToLatchNs: run?.trapToLatchNs ?? null,
  guardStoppedBeforeClientTerm: run && run.clientTermMs !== null ? run.guardStoppedMs <= run.clientTermMs : null,
  clientKilled: run?.clientKilled ?? null,
  ownership: run?.ownership ?? null,
  survivors: run?.survivors ?? null,
  clientRegistries: cdirs.length,
};
process.stdout.write(`${JSON.stringify(out)}\n`);

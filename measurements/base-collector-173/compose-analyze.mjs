#!/usr/bin/env node
// compose-drill.sh helper: reduce one case directory to counts and stop times (no payloads).
//   node compose-analyze.mjs CASE_DIR
import fs from "node:fs";
import path from "node:path";
const C = process.argv[2];
const rd = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const J = (p) => {
  const s = rd(p);
  return s === null ? null : JSON.parse(s);
};
const L = (p) => (rd(p) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cc = fs.readdirSync(path.join(C, "c")).filter((d) => d.startsWith("cc-"));
const W = cc.length === 1 ? path.join(C, "c", cc[0]) : null;
const hj = L(path.join(C, "g", "guard.jsonl"));
const hstop = J(path.join(C, "g", "guard.STOP"));
const hs = J(path.join(C, "g", "guard.summary.json"));
const wj = W ? L(path.join(W, "wsg", "ws-guard.jsonl")) : [];
const wstop = W ? J(path.join(W, "wsg", "ws-guard.STOP")) : null;
const ws = W ? J(path.join(W, "wsg", "ws-guard.summary.json")) : null;
const toy = W ? L(path.join(W, "toy.jsonl")) : [];
const wup = L(path.join(C, "ws.up.jsonl"));
const B = (x) => (x === undefined || x === null ? null : BigInt(x));
const httpStopNs = B(hstop?.hrNs ?? hj.find((e) => e.ev === "shutdown")?.hrNs);
const wsStopNs = B(wstop?.hrNs);
const cnt = (evs, kind, f = () => true) => evs.filter((e) => e.ev === kind && f(e)).length;
const after = (evs, t, kind) => (t === null ? null : cnt(evs, kind, (e) => BigInt(e.hrNs) > t));
const firstStop = httpStopNs === null && wsStopNs === null ? null : wsStopNs === null || (httpStopNs !== null && httpStopNs <= wsStopNs) ? "http" : "ws";
const statuses = {};
for (const e of toy) if (e.ev === "http_resp") statuses[e.status] = (statuses[e.status] ?? 0) + 1;
const { methods, upstream, ...httpSummary } = hs ?? {};
const out = {
  case: path.basename(C).replace(/^c-/, ""),
  clientRegistries: cc.length,
  guardRun: J(path.join(C, "g", "guard-run.json")),
  http: hs === null ? null : { ...httpSummary, upstreamReceived: L(path.join(C, "http.up.jsonl")).length, stopFile: hstop !== null },
  ws: ws === null ? null : { ...ws, forwardedUp: cnt(wj, "forward", (e) => e.dir === "up"), forwardedDown: cnt(wj, "forward", (e) => e.dir === "down"), upstreamRecv: cnt(wup, "recv"), upstreamSent: cnt(wup, "sent"), toyWsMsgs: cnt(toy, "ws_msg") },
  firstStop,
  stopGapMs: httpStopNs !== null && wsStopNs !== null ? Number(wsStopNs - httpStopNs) / 1e6 : null,
  httpAdmittedAfterWsStop: firstStop === "ws" ? after(hj, wsStopNs, "admit") : null,
  wsForwardedAfterHttpStop: firstStop === "http" ? after(wj, httpStopNs, "forward") : null,
  toyHttpStatuses: statuses,
  toySignal: toy.find((e) => e.ev === "signal") ?? null,
};
process.stdout.write(`${JSON.stringify(out)}\n`);

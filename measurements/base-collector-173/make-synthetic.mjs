// Builds the SYNTHETIC fixture set under synthetic/ (or --out DIR) by driving the #173 dist
// `Measurement` exactly as `main measure` does. Semantic probes only; not measurements.
// usage: node make-synthetic.mjs [--out DIR]   (needs modules/base-collector/dist built at 5206f90)
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.resolve(here, "../../modules/base-collector/dist/index.js");
const { Measurement, loadSettings, filterDigest, buildFilters, hookSuites, TOPIC_INITIALIZE, TOPIC_SWAP, POOL_MANAGER, O1_SUITES } = await import(dist);
const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(here, "synthetic");

const cfg = loadSettings({ BASE_COLLECTOR_WS_URL: "ws://10.9.11.68:8546", BASE_COLLECTOR_HTTP_URL: "http://10.9.11.68:8545", BASE_COLLECTOR_NATS_URL: "nats://127.0.0.1:14222" });
const DIGEST = filterDigest(cfg);
const S = 1_000_000_000n;
const MS = 1_000_000n;
const US = 1_000n;
const T0 = 5_000_000n * S; // warmup_start on the synthetic host clock
const W0 = T0 + 30n * S;
const W1 = W0 + 300n * S;
const T1 = W1 + 30n * S;
const HEAD0 = 5000;
const headAt = (t) => HEAD0 + Number((t - W0) / (2n * S));
const P = "feedeater.base_collector";
const suite = O1_SUITES.find((s) => s.name === "base-mainnet-launchpad-v4-minimal");
const w = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const hx = (n) => `0x${n.toString(16)}`;
const BH = `0x${"b1".repeat(32)}`;
const BH2 = `0x${"b2".repeat(32)}`;
const TX = `0x${"7a".repeat(32)}`;
const POOL = `0x${"11".repeat(32)}`;
const OTHER_POOL = `0x${"22".repeat(32)}`;
const EVENT_BLOCK = 5010;

const initLog = { address: POOL_MANAGER, topics: [TOPIC_INITIALIZE, POOL, `0x${w("01")}`, `0x${w("02")}`], data: `0x${w("bb8")}${w("3c")}${w(suite.hook)}${w("1000000000000000000000000")}${w("0")}` };
const swapData = `0x${w("1")}${w("2")}${w("1000000000000000000000000")}${w("3")}${w("0")}${w("bb8")}`;
const swapLog = { address: POOL_MANAGER, topics: [TOPIC_SWAP, POOL, `0x${w("03")}`], data: swapData };
const factoryLog = { address: suite.factory, topics: [`0x${"f0".repeat(32)}`], data: "0x" };
const otherSwap = { address: POOL_MANAGER, topics: [TOPIC_SWAP, OTHER_POOL, `0x${w("04")}`], data: swapData };

// Direct observations: [log, block, blockHash, logIndex, removed, kind, t].
const EVENTS = [
  [initLog, EVENT_BLOCK, BH, 0, false, "initialize", W0 + 1n * S],
  [swapLog, EVENT_BLOCK, BH, 1, false, "swap", W0 + 1n * S + 1n * MS],
  [factoryLog, EVENT_BLOCK, BH, 2, false, "factory", W0 + 1n * S + 2n * MS],
  [swapLog, EVENT_BLOCK, BH, 1, true, "swap", W0 + 3n * S],
  [otherSwap, EVENT_BLOCK + 100, BH2, 0, false, "swap", W0 + 201n * S],
];
const raw = ([l, b, bh, li, removed]) => ({ ...l, blockNumber: hx(b), blockHash: bh, transactionHash: TX, transactionIndex: "0x0", logIndex: hx(li), removed });

function status(t, over = {}) {
  return {
    v: 1, type: "status", epoch: 1, atMs: Number(t / MS), connected: true, reconciled: true, filterDigest: DIGEST,
    headBlock: headAt(t), verifiedBlock: headAt(t) - 10, trackedSinceBlock: 4990, trackedPools: t >= W0 + 1n * S ? 1 : 0,
    coverage: { complete: true, undeliveredBlocks: [], droppedPools: 0, recentDropped: [], swapsForDroppedPools: 0, untrackedSwaps: 0, pendingSwapsDropped: 0, backfillTruncatedBlocks: 0 },
    counters: { connects: 1 },
    persistence: { state: "ok", lastHeartbeatMs: Number(t / MS) - 2000, contiguousBlock: headAt(t) - 10, startBoundary: 4990, gaps: 0 },
    ...over,
  };
}
const heartbeat = (t) => ({ v: 1, type: "persister", atMs: Number(t / MS), contiguousBlock: headAt(t) - 10, startBoundary: 4990, queued: 0, droppedOverflow: 0, lastFlushOkMs: Number(t / MS), lastError: null, gapBlocks: [], gapCount: 0 });
const every5s = (offsetS) => {
  const out = [];
  for (let t = T0 + BigInt(offsetS * 1000) * MS; t < T1; t += 5n * S) out.push(t);
  return out;
};

const PM_CHECKSUMMED = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const ENV = "BASE_COLLECTOR_WS_URL=ws://10.9.11.68:8546\nBASE_COLLECTOR_HTTP_URL=http://10.9.11.68:8545\nBASE_COLLECTOR_NATS_URL=nats://127.0.0.1:14222\nBASE_COLLECTOR_STATUS_INTERVAL_MS=5000\nBASE_COLLECTOR_PERSIST_HEARTBEAT_MS=5000\n";
// Logs the direct capture saw but the measure process did not (A7: extra in-window Initialize).
const EXTRA_INIT = [{ ...initLog, topics: [TOPIC_INITIALIZE, `0x${"33".repeat(32)}`, `0x${w("01")}`, `0x${w("02")}`] }, EVENT_BLOCK + 50, `0x${"b3".repeat(32)}`, 0, false, "initialize", W0 + 101n * S];

function build(name, { statusTimes, heartbeatTimes, extraStatuses = [], wsLossAt = null, kinds = null, directOnly = [], checksum = false, deadCapture = false, acks = [1, 2] }) {
  const m = new Measurement(cfg, []);
  const marks = [];
  const nats = [];
  const direct = [];
  let seq = 0;
  const bus = (subject, payload, t) => {
    nats.push({ type: "msg", hrNs: (t + 50n * US).toString(), wallMs: 0, subject, payload: JSON.stringify(payload) });
    try {
      m.recordBus(subject, payload, t);
    } catch {
      // main.ts: `catch { // ignore non-JSON }` swallows a recordBus throw the same way
    }
  };
  for (const e of EVENTS) {
    const [, b, bh, li, removed, kind, t] = e;
    if (wsLossAt !== null && t >= wsLossAt) continue;
    if (kinds !== null && !kinds(e)) continue;
    const r = raw(e);
    m.recordDirect(r, t);
    direct.push({ type: "log", hrNs: (t + 30n * US).toString(), wallMs: 0, ...r });
    const tracked = kind !== "swap" || r.topics[1] === POOL;
    if (!tracked) continue;
    seq += 1;
    const rec = {
      v: 1, type: "log", id: `${bh}:${li}`, kind, path: "live", realtime: true, recovery: null, removed, epoch: 1, seq,
      blockNumber: b, blockHash: bh, txHash: TX, txIndex: 0, logIndex: li, address: r.address, topics: r.topics, data: r.data,
      decoded: kind === "factory" ? { topic0: r.topics[0] } : { poolId: POOL, ...(kind === "initialize" ? { hooks: suite.hook } : {}) },
      suite: kind === "swap" ? null : suite.name, receivedAtMs: Number(t / MS),
    };
    bus(removed ? `${P}.removed.${kind}` : `${P}.${kind}`, rec, t + 800n * US);
  }
  const ctl = [
    ...statusTimes.map((t) => [t, `${P}.ctl.status`, status(t)]),
    ...extraStatuses.map(([t, p]) => [t, `${P}.ctl.status`, p]),
    ...heartbeatTimes.map((t) => [t, `${P}.ctl.persister`, heartbeat(t)]),
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [t, subject, p] of ctl) bus(subject, p, t);
  for (const e of directOnly) direct.push({ type: "log", hrNs: (e[6] + 30n * US).toString(), wallMs: 0, ...raw(e) });
  nats.sort((a, b) => (BigInt(a.hrNs) < BigInt(b.hrNs) ? -1 : 1));
  const headSeen = (t) => (wsLossAt !== null && t > wsLossAt ? headAt(wsLossAt) : headAt(t));
  marks.push({ phase: "warmup_start", atNs: T0.toString(), headBlock: headAt(T0) });
  marks.push({ phase: "window_start", atNs: W0.toString(), headBlock: headSeen(W0) });
  if (wsLossAt !== null) marks.push({ phase: "direct_ws_closed", atNs: wsLossAt.toString(), headBlock: headAt(wsLossAt) });
  marks.push({ phase: "window_end", atNs: W1.toString(), headBlock: headSeen(W1) });
  marks.push({ phase: "teardown_end", atNs: T1.toString(), headBlock: headSeen(T1) });
  if (wsLossAt !== null) direct.push({ type: "direct_ws_closed", hrNs: (wsLossAt + 30n * US).toString(), wallMs: 0 });
  const fromBlock = headSeen(W0) + 1;
  const toBlock = headSeen(W1);
  const report = {
    tool: "base-collector measure (SYNTHETIC fixture from make-synthetic.mjs; not a measurement)",
    clock: "process.hrtime.bigint (single process; ns from an arbitrary per-process origin; marks are the phase boundaries)",
    settings: { warmupS: 30, windowS: 300, teardownS: 30, poolsFromCheckpoint: null, hooks: [...hookSuites(cfg).keys()] },
    marks,
    ...m.report(fromBlock, toBlock, { startNs: W0, endNs: W1 }),
  };
  const host = "synthetic-host";
  const meta = (tool, extra) => ({ type: "meta", phase: "start", tool, clock: "process.hrtime.bigint", hrNs: (T0 - 10n * S).toString(), wallMs: 0, host, platform: "synthetic", node: "synthetic", ...extra });
  const stop = { type: "meta", phase: "stop", hrNs: (T1 + 10n * S).toString(), wallMs: 0 };
  const cs = (x) => (checksum && typeof x === "string" && x.toLowerCase() === POOL_MANAGER.toLowerCase() ? PM_CHECKSUMMED : x);
  const metaFilters = buildFilters(cfg).map((f) => ({ ...f, address: f.address.map(cs) }));
  const ackRows = acks.map((id) => ({ type: "ack", hrNs: (T0 - 9n * S + BigInt(id) * MS).toString(), wallMs: 0, id, result: `0x5ub${id}` }));
  const directMeta = meta("capture-direct", { wsUrl: cfg.wsUrl, filterDigest: DIGEST, filters: metaFilters });
  const directBody = deadCapture
    ? [{ type: "direct_ws_closed", hrNs: (BigInt(directMeta.hrNs) + 1n).toString(), wallMs: 0 }]
    : [...ackRows, ...direct.map((r) => (r.type === "log" ? { ...r, address: cs(r.address) } : r))].sort((a, b) => (BigInt(a.hrNs) < BigInt(b.hrNs) ? -1 : 1));
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "measure.json"), `${JSON.stringify(report, null, 2)}\n`);
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "nats.jsonl"), jsonl([meta("capture-nats", { subject: `${P}.>` }), ...nats, stop]));
  fs.writeFileSync(path.join(dir, "direct.jsonl"), jsonl([directMeta, ...directBody, stop]));
  fs.writeFileSync(path.join(dir, "base-collector.env"), ENV);
  process.stdout.write(`${name}: sourceValidationWindow=${report.scope.sourceValidationWindow} dat011.pass=${report.dat011.pass} notCovered=[${report.scope.notCovered}]\n`);
}

const dense = { statusTimes: every5s(1), heartbeatTimes: every5s(3) };
build("control", dense);
// Positive: capture filters and log addresses in EIP-55 checksum case; the checker normalizes.
build("checksummed-filter", { ...dense, checksum: true });
// Codex/A7 G1 pattern (their window was 30 min; 5 min here keeps the set small): statusIntervalMs 5000,
// good statuses at 0 s and 10 s, one heartbeat at 10 s, nothing else in the window.
build("g1", { statusTimes: [W0, W0 + 10n * S], heartbeatTimes: [W0 + 10n * S] });
// A connected:false status without `persistence`: recordBus throws and main drops it as non-JSON.
const badT = W0 + 100n * S + 500n * MS;
build("malformed-status", { ...dense, extraStatuses: [[badT, { v: 1, type: "status", epoch: 1, atMs: Number(badT / MS), connected: false, filterDigest: DIGEST, headBlock: headAt(badT) }]] });
// Direct node socket lost 150 s into the window; measure only appends a mark and its head stops.
build("ws-loss", { ...dense, wsLossAt: W0 + 150n * S });
// A clean, dense window in which no factory log and no reorg removal occur (the usual case).
build("factory-reorg-not-observed", { ...dense, kinds: (e) => e[5] !== "factory" && e[4] === false });
// A7 reproductions at 3026725 (all returned NO_REJECT_FOUND/0 there):
// an in-window Initialize on the direct capture that the report never counted;
build("extra-direct-initialize", { ...dense, directOnly: [EXTRA_INIT] });
// the direct capture socket closed 1 ns after capture start (before warmup), no ACKs and no logs;
build("direct-ws-closed-before-warmup", { ...dense, deadCapture: true });
// only the PoolManager filter subscription was acknowledged.
build("direct-filter-ack-missing", { ...dense, acks: [1] });

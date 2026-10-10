import fs from "node:fs/promises";

import { connect, type NatsConnection } from "nats";
import pg from "pg";
import WebSocket from "ws";

import type { BaseCollectorSettings } from "../settings.js";
import { FileCheckpointStore } from "./checkpoint.js";
import { Collector } from "./collector.js";
import { loadSettings } from "./config.js";
import { hexToNumber } from "./decode.js";
import { Measurement } from "./measure.js";
import { Persister } from "./persister.js";
import { PgStore } from "./pgStore.js";
import { isRecord, stderrLogger, type Bus, type WsFactory } from "./ports.js";
import { PacedHttpRpc } from "./rpc.js";
import { ALL, buildFilters, decodeJson, hookSuites } from "./subjects.js";
import type { RawLog } from "./types.js";

function rawText(d: WebSocket.RawData): string {
  if (Buffer.isBuffer(d)) return d.toString("utf8");
  if (Array.isArray(d)) return Buffer.concat(d).toString("utf8");
  return Buffer.from(d).toString("utf8");
}

const wsFactory: WsFactory = (url, h) => {
  const s = new WebSocket(url);
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    h.onClose(reason);
  };
  s.on("open", () => h.onOpen());
  s.on("message", (d) => h.onMessage(rawText(d)));
  s.on("close", (code, reason) => close(`close ${code} ${reason.toString()}`));
  s.on("error", (e) => close(`error ${e.message}`));
  return { send: (t) => s.send(t), close: () => s.terminate() };
};

async function natsBus(url: string, name: string): Promise<{ nc: NatsConnection; bus: Bus }> {
  const nc = await connect({ servers: url, name, maxReconnectAttempts: -1, reconnectTimeWait: 500 });
  const bus: Bus = {
    publish: (subject, data) => nc.publish(subject, data),
    subscribe: (subject, onMessage) => {
      nc.subscribe(subject, {
        callback: (err, m) => {
          if (err !== null) stderrLogger("error", "nats subscription error", { subject, error: err.message });
          else onMessage(m.data, m.subject);
        },
      });
    },
  };
  return { nc, bus };
}

function onSignal(stop: () => Promise<void>): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void stop().then(() => process.exit(0));
    });
  }
}

async function runCollect(cfg: BaseCollectorSettings): Promise<void> {
  if (cfg.stateDir === null) throw new Error("BASE_COLLECTOR_STATE_DIR is required for collect");
  const { nc, bus } = await natsBus(cfg.natsUrl, "base-collector");
  const collector = new Collector(cfg, {
    bus,
    rpc: new PacedHttpRpc(cfg.httpUrl, cfg.rpcMinIntervalMs, cfg.rpcTimeoutMs),
    ws: wsFactory,
    checkpoints: new FileCheckpointStore(cfg.stateDir),
  });
  await collector.start();
  onSignal(async () => {
    await collector.stop();
    await nc.drain();
  });
}

async function runPersist(cfg: BaseCollectorSettings): Promise<void> {
  if (cfg.databaseUrl === null) throw new Error("BASE_COLLECTOR_DATABASE_URL is required for persist");
  const { nc, bus } = await natsBus(cfg.natsUrl, "base-collector-persister");
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
  const persister = new Persister(cfg, new PgStore(pool), bus);
  await persister.start();
  onSignal(async () => {
    await persister.stop();
    await nc.drain();
    await pool.end();
  });
}

function flag(args: string[], name: string, dflt?: string): string {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v !== undefined) return v;
  if (dflt !== undefined) return dflt;
  throw new Error(`--${name} is required`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One process, one clock: a direct node subscription with the collector's exact filters plus a
 * NATS subscription on every collector subject. Phases: warmup (not scored), window (events scored by
 * block range, status/heartbeat samples by the window_start..window_end clock marks), teardown (late
 * deliveries for window blocks still collected; teardown samples never count toward window scope).
 */
async function runMeasure(cfg: BaseCollectorSettings, args: string[]): Promise<void> {
  const warmupS = Number(flag(args, "warmup-s", "60"));
  const windowS = Number(flag(args, "window-s", "600"));
  const teardownS = Number(flag(args, "teardown-s", "30"));
  const out = flag(args, "out");
  const poolsFrom = args.includes("--pools-from-checkpoint") ? flag(args, "pools-from-checkpoint") : null;
  let initialPools: string[] = [];
  if (poolsFrom !== null) {
    const cp = JSON.parse(await fs.readFile(poolsFrom, "utf8")) as { pools: Array<{ poolId: string }> };
    initialPools = cp.pools.map((p) => p.poolId);
  }
  const m = new Measurement(cfg, initialPools);
  const marks: Array<{ phase: string; atNs: string; headBlock: number | null }> = [];
  let head: number | null = null;

  const { nc, bus } = await natsBus(cfg.natsUrl, "base-collector-measure");
  bus.subscribe(ALL, (data, subject) => {
    const t = process.hrtime.bigint();
    try {
      m.recordBus(subject, decodeJson(data), t);
    } catch {
      // ignore non-JSON
    }
  });

  const ws = new WebSocket(cfg.wsUrl);
  const subs = new Map<string, "logs" | "heads">();
  const reqKind = new Map<number, "logs" | "heads">();
  ws.on("message", (d) => {
    const t = process.hrtime.bigint();
    const msg: unknown = JSON.parse(rawText(d));
    if (!isRecord(msg)) return;
    if (typeof msg.id === "number" && typeof msg.result === "string") {
      const k = reqKind.get(msg.id);
      if (k !== undefined) subs.set(msg.result, k);
      return;
    }
    if (msg.method !== "eth_subscription" || !isRecord(msg.params)) return;
    const k = subs.get(String(msg.params.subscription));
    if (k === "logs") m.recordDirect(msg.params.result as RawLog, t);
    else if (k === "heads" && isRecord(msg.params.result) && typeof msg.params.result.number === "string") {
      head = hexToNumber(msg.params.result.number);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let id = 1;
  for (const f of buildFilters(cfg)) {
    reqKind.set(id, "logs");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "eth_subscribe", params: ["logs", f] }));
  }
  reqKind.set(id, "heads");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "eth_subscribe", params: ["newHeads"] }));
  ws.on("close", () => marks.push({ phase: "direct_ws_closed", atNs: process.hrtime.bigint().toString(), headBlock: head }));

  const mark = (phase: string): bigint => {
    const atNs = process.hrtime.bigint();
    marks.push({ phase, atNs: atNs.toString(), headBlock: head });
    stderrLogger("info", `measure ${phase}`, { headBlock: head });
    return atNs;
  };
  mark("warmup_start");
  await sleep(warmupS * 1000);
  const startNs = mark("window_start");
  const fromBlock = (head ?? 0) + 1;
  await sleep(windowS * 1000);
  const toBlock = head ?? fromBlock;
  const endNs = mark("window_end");
  await sleep(teardownS * 1000);
  mark("teardown_end");
  ws.terminate();
  await nc.drain();

  const report = {
    tool: "base-collector measure",
    clock: "process.hrtime.bigint (single process; ns from an arbitrary per-process origin; marks are the phase boundaries)",
    settings: { warmupS, windowS, teardownS, poolsFromCheckpoint: poolsFrom, hooks: [...hookSuites(cfg).keys()] },
    marks,
    ...m.report(fromBlock, toBlock, { startNs, endNs }),
  };
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out, window: report.window, liveDeliveryPct: report.liveDeliveryPct, duplicateLivePublishes: report.duplicateLivePublishes, backfillOnLiveSubjects: report.backfillOnLiveSubjects, addedLatencyMs: report.addedLatencyMs, byKind: report.byKind, scope: report.scope, dat011: report.dat011 })}\n`);
}

/** Compare persisted state over a block range with the node's canonical eth_getLogs. */
async function runVerifyPersist(cfg: BaseCollectorSettings, args: string[]): Promise<void> {
  if (cfg.databaseUrl === null) throw new Error("BASE_COLLECTOR_DATABASE_URL is required for verify-persist");
  const fromBlock = Number(flag(args, "from-block"));
  const toBlock = Number(flag(args, "to-block"));
  const rpc = new PacedHttpRpc(cfg.httpUrl, cfg.rpcMinIntervalMs, cfg.rpcTimeoutMs);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1 });
  const store = new PgStore(pool);
  const pools = await store.trackedPoolIds();
  for (const p of cfg.extraPoolIds) pools.add(p);
  const canonical = new Set<string>();
  for (let s = fromBlock; s <= toBlock; s += cfg.backfillChunkBlocks) {
    const e = Math.min(toBlock, s + cfg.backfillChunkBlocks - 1);
    for (const f of buildFilters(cfg)) {
      const logs = (await rpc.call("eth_getLogs", [{ ...f, fromBlock: `0x${s.toString(16)}`, toBlock: `0x${e.toString(16)}` }])) as RawLog[];
      for (const l of logs) {
        const isSwap = l.address.toLowerCase() === cfg.poolManager && l.topics.length === 3;
        if (isSwap && !pools.has(l.topics[1]?.toLowerCase() ?? "")) continue;
        canonical.add(`${l.blockHash.toLowerCase()}:${hexToNumber(l.logIndex)}`);
      }
    }
  }
  const rows = await store.range(fromBlock, toBlock);
  const active = new Set(rows.filter((r) => !r.removed).map((r) => r.id));
  const removed = new Set(rows.filter((r) => r.removed).map((r) => r.id));
  const missing = [...canonical].filter((id) => !active.has(id));
  const result = {
    fromBlock,
    toBlock,
    canonical: canonical.size,
    storedActive: active.size,
    missing: missing.length,
    missingButStoredRemoved: missing.filter((id) => removed.has(id)).length,
    activeNotCanonical: [...active].filter((id) => !canonical.has(id)).length,
    sampleMissing: missing.slice(0, 20),
    rpcCalls: rpc.calls,
  };
  await pool.end();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadSettings(process.env);
  if (cmd === "collect") return runCollect(cfg);
  if (cmd === "persist") return runPersist(cfg);
  if (cmd === "measure") return runMeasure(cfg, args);
  if (cmd === "verify-persist") return runVerifyPersist(cfg, args);
  throw new Error("usage: main.js collect | persist | measure --out FILE [--warmup-s N --window-s N --teardown-s N --pools-from-checkpoint FILE] | verify-persist --from-block N --to-block N");
}

main().catch((e: unknown) => {
  stderrLogger("error", "fatal", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});

import { AbiCoder } from "ethers";

import { BaseCollectorSettingsSchema, type BaseCollectorSettings, type BaseCollectorSettingsInput } from "../../settings.js";
import { MemoryCheckpointStore } from "../checkpoint.js";
import { Collector } from "../collector.js";
import { O1_SUITES, POOL_MANAGER, TOPIC_INITIALIZE, TOPIC_SWAP } from "../constants.js";
import type { Bus, Clock, HttpRpc, Logger, WsFactory, WsHandlers } from "../ports.js";
import { decodeJson } from "../subjects.js";
import type { RawLog } from "../types.js";

const abi = AbiCoder.defaultAbiCoder();

export const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
export const hx = (n: number) => `0x${n.toString(16)}`;
export const blockHash = (n: number, fork = "a") => pad(`${fork}${n.toString(16)}`);
export const poolId = (n: number) => pad(`p${n}`.replace("p", "f"));
export const o1Hook = O1_SUITES[5]!.hook;
export const otherHook = "0x000000000000000000000000000000000000beef";

export function cfg(over: Partial<BaseCollectorSettingsInput> = {}): BaseCollectorSettings {
  return BaseCollectorSettingsSchema.parse({ wsUrl: "ws://node:8546", httpUrl: "http://node:8545", natsUrl: "nats://bus:4222", ...over });
}

type LogOpts = { block: number; logIndex: number; fork?: string; removed?: boolean; tx?: number };

function base(o: LogOpts, address: string, topics: string[], data: string): RawLog {
  return {
    address,
    topics,
    data,
    blockNumber: hx(o.block),
    blockHash: blockHash(o.block, o.fork),
    transactionHash: pad(`7${o.tx ?? o.logIndex}`),
    transactionIndex: hx(o.tx ?? 0),
    logIndex: hx(o.logIndex),
    removed: o.removed ?? false,
  };
}

export function initLog(o: LogOpts & { pool: string; hooks?: string }): RawLog {
  const data = abi.encode(["uint24", "int24", "address", "uint160", "int24"], [10000, 200, o.hooks ?? o1Hook, 2n ** 96n, -887200]);
  const c0 = pad("4200000000000000000000000000000000000006");
  const c1 = pad("00000000000000000000000000000000000000c1");
  return base(o, POOL_MANAGER, [TOPIC_INITIALIZE, o.pool, c0, c1], data);
}

export function swapLog(o: LogOpts & { pool: string }): RawLog {
  const data = abi.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [-5n * 10n ** 17n, 123456789n, 2n ** 96n, 10n ** 18n, -100, 10000]);
  return base(o, POOL_MANAGER, [TOPIC_SWAP, o.pool, pad("00000000000000000000000000000000000000aa")], data);
}

export function factoryLog(o: LogOpts & { factory: string }): RawLog {
  return base(o, o.factory, [pad("e1"), pad("00000000000000000000000000000000000000bb")], "0x");
}

function matches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export type Published = { subject: string; payload: Record<string, unknown> };

/** Core-NATS fake: synchronous fan-out, no durability, no replay to late subscribers. */
export class FakeBus implements Bus {
  readonly published: Published[] = [];
  private readonly subs: Array<{ pattern: string; cb: (d: Uint8Array, s: string) => void }> = [];
  offline = false;

  publish(subject: string, data: Uint8Array): void {
    this.published.push({ subject, payload: decodeJson(data) as Record<string, unknown> });
    if (this.offline) return;
    for (const s of [...this.subs]) if (matches(s.pattern, subject)) s.cb(data, subject);
  }

  subscribe(subject: string, onMessage: (d: Uint8Array, s: string) => void): void {
    this.subs.push({ pattern: subject, cb: onMessage });
  }

  unsubscribeAll(): void {
    this.subs.length = 0;
  }

  logs(): Published[] {
    return this.published.filter((p) => p.payload.type === "log");
  }

  subjects(): string[] {
    return this.logs().map((p) => p.subject);
  }
}

/** eth_blockNumber / eth_getLogs over an in-memory canonical chain. */
export class FakeRpc implements HttpRpc {
  head = 0;
  chain: RawLog[] = [];
  calls: Array<{ method: string; params: unknown[] }> = [];
  gate: Promise<void> | null = null;
  reverse = false;

  async call(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.gate !== null) await this.gate;
    if (method === "eth_blockNumber") return hx(this.head);
    if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
    const f = params[0] as { address: string[]; topics?: string[][]; fromBlock: string; toBlock: string };
    const from = Number.parseInt(f.fromBlock, 16);
    const to = Number.parseInt(f.toBlock, 16);
    const out = this.chain.filter((l) => {
      const b = Number.parseInt(l.blockNumber, 16);
      if (b < from || b > to || !f.address.includes(l.address.toLowerCase())) return false;
      const t0 = f.topics?.[0];
      return t0 === undefined || t0.includes(l.topics[0] ?? "");
    });
    return this.reverse ? out.reverse() : out;
  }
}

export class FakeWs {
  handlers: WsHandlers | null = null;
  sent: Array<{ id: number; method: string; params: unknown[] }> = [];
  opened = 0;
  private nextSub = 1;
  logsSubs: string[] = [];
  headsSub = "";

  readonly factory: WsFactory = (_url, h) => {
    this.handlers = h;
    this.logsSubs = [];
    this.opened += 1;
    queueMicrotask(() => h.onOpen());
    return {
      send: (text) => {
        const req = JSON.parse(text) as { id: number; method: string; params: unknown[] };
        this.sent.push(req);
        const sub = `0xsub${this.nextSub++}`;
        if (req.params[0] === "newHeads") this.headsSub = sub;
        else this.logsSubs.push(sub);
        queueMicrotask(() => h.onMessage(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: sub })));
      },
      close: () => undefined,
    };
  };

  /** Deliver a subscription notification synchronously, as the ws client does. */
  log(log: RawLog): void {
    const sub = log.address.toLowerCase() === POOL_MANAGER ? this.logsSubs[0] : this.logsSubs[1];
    this.handlers!.onMessage(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: sub, result: log } }));
  }

  head(n: number, fork = "a"): void {
    this.handlers!.onMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: this.headsSub, result: { number: hx(n), hash: blockHash(n, fork) } } }),
    );
  }

  drop(): void {
    this.handlers!.onClose("test drop");
  }
}

export class ManualClock implements Clock {
  constructor(public t = 1_800_000_000_000) {}
  nowMs(): number {
    return this.t;
  }
}

export const quiet: Logger = () => undefined;

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

export type Rig = { c: Collector; bus: FakeBus; rpc: FakeRpc; ws: FakeWs; clock: ManualClock; cps: MemoryCheckpointStore; settings: BaseCollectorSettings };

export function rig(over: Partial<BaseCollectorSettingsInput> = {}, cps = new MemoryCheckpointStore()): Rig {
  const settings = cfg({ reconnectBaseMs: 1, reconnectMaxMs: 1, statusIntervalMs: 60_000, ...over });
  const bus = new FakeBus();
  const rpc = new FakeRpc();
  const ws = new FakeWs();
  const clock = new ManualClock();
  const c = new Collector(settings, { bus, rpc, ws: ws.factory, checkpoints: cps, clock, log: quiet });
  return { c, bus, rpc, ws, clock, cps, settings };
}

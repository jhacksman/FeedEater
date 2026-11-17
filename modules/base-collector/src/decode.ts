import { TOPIC_INITIALIZE, TOPIC_SWAP } from "./constants.js";
import type { DecodedInitialize, DecodedSwap, EventKind, Decoded, RawLog } from "./types.js";

const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

function word(data: string, i: number): string {
  return data.slice(2 + 64 * i, 2 + 64 * (i + 1));
}

function uint(w: string): bigint {
  return BigInt(`0x${w}`);
}

function int(w: string): bigint {
  const v = uint(w);
  return v >= TWO_255 ? v - TWO_256 : v;
}

function addressFromWord(w: string): string {
  return `0x${w.slice(24)}`.toLowerCase();
}

function addressFromTopic(t: string): string {
  return `0x${t.slice(26)}`.toLowerCase();
}

function hasWords(data: string, n: number): boolean {
  return data.length === 2 + 64 * n;
}

export function hexToNumber(h: string): number {
  const n = Number.parseInt(h, 16);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid quantity ${h}`);
  return n;
}

export function decodeInitialize(topics: string[], data: string): DecodedInitialize | null {
  const [, id, c0, c1] = topics;
  if (topics.length !== 4 || id === undefined || c0 === undefined || c1 === undefined || !hasWords(data, 5)) return null;
  return {
    poolId: id.toLowerCase(),
    currency0: addressFromTopic(c0),
    currency1: addressFromTopic(c1),
    fee: Number(uint(word(data, 0))),
    tickSpacing: Number(int(word(data, 1))),
    hooks: addressFromWord(word(data, 2)),
    sqrtPriceX96: uint(word(data, 3)).toString(),
    tick: Number(int(word(data, 4))),
  };
}

export function decodeSwap(topics: string[], data: string): DecodedSwap | null {
  const [, id, sender] = topics;
  if (topics.length !== 3 || id === undefined || sender === undefined || !hasWords(data, 6)) return null;
  return {
    poolId: id.toLowerCase(),
    sender: addressFromTopic(sender),
    amount0: int(word(data, 0)).toString(),
    amount1: int(word(data, 1)).toString(),
    sqrtPriceX96: uint(word(data, 2)).toString(),
    liquidity: uint(word(data, 3)).toString(),
    tick: Number(int(word(data, 4))),
    fee: Number(uint(word(data, 5))),
  };
}

export type Classified = { kind: EventKind; decoded: Decoded | null; suite: string | null };

/**
 * Classifies a raw log against the configured filter. Returns `null` for a log outside the filter.
 * A PoolManager Initialize/Swap that does not decode keeps its raw fields with `decoded: null`.
 */
export function classify(log: RawLog, poolManager: string, factories: ReadonlyMap<string, string>): Classified | null {
  const address = log.address.toLowerCase();
  const topic0 = log.topics[0]?.toLowerCase() ?? null;
  if (address === poolManager) {
    if (topic0 === TOPIC_INITIALIZE) return { kind: "initialize", decoded: decodeInitialize(log.topics, log.data), suite: null };
    if (topic0 === TOPIC_SWAP) return { kind: "swap", decoded: decodeSwap(log.topics, log.data), suite: null };
    return null;
  }
  const suite = factories.get(address);
  if (suite !== undefined) return { kind: "factory", decoded: { topic0 }, suite };
  return null;
}

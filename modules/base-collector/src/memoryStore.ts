import { newer, type PersistStore } from "./persister.js";
import { sealDigest } from "./subjects.js";
import type { LogRecord, SealRecord } from "./types.js";

export type StoredLog = {
  id: string;
  blockNumber: number;
  blockHash: string;
  kind: LogRecord["kind"];
  removed: boolean;
  stateSource: "live" | "backfill" | "seal";
  epoch: number;
  seq: number;
  firstPath: LogRecord["path"];
  firstRealtime: boolean;
  transitions: number;
};

export type StoredTransition = { id: string; epoch: number; seq: number; removed: boolean; source: string };

/** In-process PersistStore with the same semantics as PgStore. Used by the fixtures. */
export class MemoryStore implements PersistStore {
  readonly logs = new Map<string, StoredLog>();
  readonly history: StoredTransition[] = [];
  readonly seals = new Map<number, SealRecord & { matched: boolean }>();
  contiguous: number | null = null;
  failWrites = false;

  async init(): Promise<number | null> {
    return this.contiguous;
  }

  async writeLogs(records: readonly LogRecord[]): Promise<void> {
    if (this.failWrites) throw new Error("database unavailable");
    for (const r of records) {
      if (!this.history.some((h) => h.id === r.id && h.epoch === r.epoch && h.seq === r.seq)) {
        this.history.push({ id: r.id, epoch: r.epoch, seq: r.seq, removed: r.removed, source: r.path });
      }
      const row = this.logs.get(r.id);
      if (row === undefined) {
        this.logs.set(r.id, {
          id: r.id,
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          kind: r.kind,
          removed: r.removed,
          stateSource: r.path,
          epoch: r.epoch,
          seq: r.seq,
          firstPath: r.path,
          firstRealtime: r.realtime,
          transitions: 1,
        });
      } else if (newer(r, row)) {
        if (row.removed !== r.removed) row.transitions += 1;
        row.removed = r.removed;
        row.stateSource = r.path;
        row.epoch = r.epoch;
        row.seq = r.seq;
      }
    }
  }

  async applySeal(seal: SealRecord): Promise<boolean> {
    if (this.failWrites) throw new Error("database unavailable");
    for (const row of this.logs.values()) {
      if (row.blockNumber !== seal.blockNumber || row.removed || !newer(seal, row)) continue;
      const orphan = seal.blockHash === null ? seal.count === 0 : row.blockHash !== seal.blockHash;
      if (!orphan) continue;
      row.removed = true;
      row.stateSource = "seal";
      row.epoch = seal.epoch;
      row.seq = seal.seq;
      row.transitions += 1;
      this.history.push({ id: row.id, epoch: seal.epoch, seq: seal.seq, removed: true, source: "seal" });
    }
    const active = [...this.logs.values()].filter((r) => r.blockNumber === seal.blockNumber && !r.removed).map((r) => r.id);
    const matched = active.length === seal.count && sealDigest(active) === seal.digest;
    const prev = this.seals.get(seal.blockNumber);
    if (prev === undefined || newer(seal, prev)) this.seals.set(seal.blockNumber, { ...seal, matched });
    return matched;
  }

  async saveContiguous(block: number): Promise<void> {
    if (this.failWrites) throw new Error("database unavailable");
    this.contiguous = block;
  }
}

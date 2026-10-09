import type { LogRecord } from "./types.js";

type Entry = { active: boolean; blockHash: string; record: LogRecord | null };

export type Transition = "changed" | "duplicate";

/**
 * Bounded per-identity state (`blockHash:logIndex` -> active/removed). A repeated observation of
 * the current state is a duplicate; removed -> active and active -> removed are both transitions.
 * Identities are retained per block number and pruned only below the confirmed floor.
 */
export class IdentityLedger {
  private readonly byBlock = new Map<number, Map<string, Entry>>();
  private readonly blockOf = new Map<string, number>();

  get size(): number {
    return this.blockOf.size;
  }

  private entry(id: string): Entry | undefined {
    const b = this.blockOf.get(id);
    return b === undefined ? undefined : this.byBlock.get(b)?.get(id);
  }

  state(id: string): boolean | undefined {
    return this.entry(id)?.active;
  }

  record(id: string): LogRecord | null {
    return this.entry(id)?.record ?? null;
  }

  transition(id: string, blockNumber: number, blockHash: string, active: boolean): Transition {
    const e = this.entry(id);
    if (e !== undefined) {
      if (e.active === active) return "duplicate";
      e.active = active;
      return "changed";
    }
    let m = this.byBlock.get(blockNumber);
    if (m === undefined) {
      m = new Map();
      this.byBlock.set(blockNumber, m);
    }
    m.set(id, { active, blockHash, record: null });
    this.blockOf.set(id, blockNumber);
    return "changed";
  }

  remember(rec: LogRecord): void {
    const e = this.entry(rec.id);
    if (e !== undefined) e.record = rec;
  }

  /** Active identities of a block number with their block hashes. */
  active(blockNumber: number): Array<{ id: string; blockHash: string }> {
    const out: Array<{ id: string; blockHash: string }> = [];
    for (const [id, e] of this.byBlock.get(blockNumber) ?? []) if (e.active) out.push({ id, blockHash: e.blockHash });
    return out;
  }

  pruneBelow(floor: number): void {
    for (const b of [...this.byBlock.keys()]) {
      if (b >= floor) continue;
      for (const id of this.byBlock.get(b)?.keys() ?? []) this.blockOf.delete(id);
      this.byBlock.delete(b);
    }
  }
}

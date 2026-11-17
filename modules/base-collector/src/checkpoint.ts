import fs from "node:fs/promises";
import path from "node:path";

import type { TrackedPool } from "./tracker.js";

/**
 * The collector's realtime-recovery checkpoint. `verifiedBlock` is the highest block such that
 * every block from the session start up to it was sealed (contiguous, `confirmBlocks` deep); it is
 * never the max block seen. Reconnect replays from `verifiedBlock + 1 - overlapBlocks`.
 */
export type Checkpoint = {
  version: 1;
  filterDigest: string;
  epoch: number;
  verifiedBlock: number | null;
  trackedSinceBlock: number | null;
  pools: TrackedPool[];
};

export interface CheckpointStore {
  load(): Promise<Checkpoint | null>;
  save(cp: Checkpoint): Promise<void>;
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "checkpoint.json");
  }

  async load(): Promise<Checkpoint | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const cp = JSON.parse(raw) as Checkpoint;
    if (cp.version !== 1) throw new Error(`unsupported checkpoint version in ${this.file}`);
    return cp;
  }

  async save(cp: Checkpoint): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cp));
    await fs.rename(tmp, this.file);
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  constructor(public value: Checkpoint | null = null) {}

  async load(): Promise<Checkpoint | null> {
    return this.value === null ? null : (JSON.parse(JSON.stringify(this.value)) as Checkpoint);
  }

  async save(cp: Checkpoint): Promise<void> {
    this.value = JSON.parse(JSON.stringify(cp)) as Checkpoint;
  }
}

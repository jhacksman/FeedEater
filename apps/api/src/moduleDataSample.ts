import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const SCHEMA_VERSION = "1.0.0";

interface StoredSample {
  data: Record<string, unknown>;
  timestamp: number;
}

export class DataSampleStore {
  private samples = new Map<string, StoredSample>();

  record(module: string, data: Record<string, unknown>, timestamp?: number): void {
    this.samples.set(module, {
      data,
      timestamp: timestamp ?? Date.now(),
    });
  }

  get(module: string): StoredSample | null {
    return this.samples.get(module) ?? null;
  }

  clear(): void {
    this.samples.clear();
  }
}

interface DataSampleDeps {
  sampleStore: DataSampleStore;
  nowFn?: () => number;
}

export function getModuleDataSample({ sampleStore, nowFn }: DataSampleDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const sample = sampleStore.get(name);

    if (!sample) {
      res.status(204).end();
      return;
    }

    const now = nowFn?.() ?? Date.now();

    res.json({
      module: name,
      sample: sample.data,
      sampled_at: new Date(sample.timestamp).toISOString(),
      schema_version: SCHEMA_VERSION,
    });
  };
}

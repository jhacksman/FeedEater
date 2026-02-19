import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const STALE_THRESHOLD_SECONDS = 60;

interface DataTypeState {
  last_received_at: string;
  timestamp: number;
}

export class DataFreshnessStore {
  private state = new Map<string, Map<string, DataTypeState>>();

  record(module: string, dataType: string, timestamp?: number): void {
    let moduleMap = this.state.get(module);
    if (!moduleMap) {
      moduleMap = new Map();
      this.state.set(module, moduleMap);
    }
    const ts = timestamp ?? Date.now();
    moduleMap.set(dataType, {
      last_received_at: new Date(ts).toISOString(),
      timestamp: ts,
    });
  }

  getDataTypes(module: string): Map<string, DataTypeState> | null {
    return this.state.get(module) ?? null;
  }

  clear(): void {
    this.state.clear();
  }
}

interface DataFreshnessDeps {
  freshnessStore: DataFreshnessStore;
  nowFn?: () => number;
}

export function getModuleDataFreshness({ freshnessStore, nowFn }: DataFreshnessDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const moduleData = freshnessStore.getDataTypes(name);

    const dataTypes: Record<string, { last_received_at: string | null; age_seconds: number; is_stale: boolean }> = {};

    if (moduleData) {
      for (const [type, state] of moduleData) {
        const ageSeconds = Math.floor((now - state.timestamp) / 1000);
        dataTypes[type] = {
          last_received_at: state.last_received_at,
          age_seconds: ageSeconds,
          is_stale: ageSeconds > STALE_THRESHOLD_SECONDS,
        };
      }
    }

    res.json({
      module: name,
      data_types: dataTypes,
      checked_at: new Date(now).toISOString(),
    });
  };
}

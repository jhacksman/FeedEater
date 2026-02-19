import type { Request, Response } from "express";

interface StorageState {
  db_size_mb: number;
  db_path: string | null;
  oldest_record_at: string | null;
  newest_record_at: string | null;
  total_records: number;
  records_per_module: Record<string, number>;
  estimated_daily_growth_mb: number;
}

export class StorageStore {
  private state: StorageState = {
    db_size_mb: 0,
    db_path: null,
    oldest_record_at: null,
    newest_record_at: null,
    total_records: 0,
    records_per_module: {},
    estimated_daily_growth_mb: 0,
  };

  update(partial: Partial<StorageState>): void {
    Object.assign(this.state, partial);
  }

  recordInsert(module: string, timestamp?: string): void {
    this.state.total_records += 1;
    this.state.records_per_module[module] = (this.state.records_per_module[module] ?? 0) + 1;
    const ts = timestamp ?? new Date().toISOString();
    if (!this.state.oldest_record_at || ts < this.state.oldest_record_at) {
      this.state.oldest_record_at = ts;
    }
    if (!this.state.newest_record_at || ts > this.state.newest_record_at) {
      this.state.newest_record_at = ts;
    }
  }

  getState(): StorageState {
    return {
      ...this.state,
      records_per_module: { ...this.state.records_per_module },
    };
  }

  clear(): void {
    this.state = {
      db_size_mb: 0,
      db_path: null,
      oldest_record_at: null,
      newest_record_at: null,
      total_records: 0,
      records_per_module: {},
      estimated_daily_growth_mb: 0,
    };
  }
}

interface StorageDeps {
  storageStore: StorageStore;
  nowFn?: () => number;
}

export function getSystemStorage({ storageStore, nowFn }: StorageDeps) {
  return (_req: Request, res: Response): void => {
    const now = nowFn?.() ?? Date.now();
    const state = storageStore.getState();

    res.json({
      ...state,
      checked_at: new Date(now).toISOString(),
    });
  };
}

import type { Request, Response } from "express";

type Severity = "info" | "warning" | "critical";

interface AlertRecord {
  alert_id: string;
  module_name: string;
  severity: Severity;
  message: string;
  created_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export class AlertHistoryStore {
  private records: AlertRecord[] = [];
  private nextId = 1;

  record(
    module_name: string,
    severity: Severity,
    message: string,
    opts?: { resolved_at?: string; acknowledged_at?: string; acknowledged_by?: string; created_at?: string },
  ): AlertRecord {
    const entry: AlertRecord = {
      alert_id: `ah-${this.nextId++}`,
      module_name,
      severity,
      message,
      created_at: opts?.created_at ?? new Date().toISOString(),
      resolved_at: opts?.resolved_at ?? null,
      acknowledged_at: opts?.acknowledged_at ?? null,
      acknowledged_by: opts?.acknowledged_by ?? null,
    };
    this.records.push(entry);
    return entry;
  }

  markResolved(alertId: string, resolvedAt?: string): boolean {
    const rec = this.records.find((r) => r.alert_id === alertId);
    if (!rec) return false;
    rec.resolved_at = resolvedAt ?? new Date().toISOString();
    return true;
  }

  markAcknowledged(alertId: string, by?: string, at?: string): boolean {
    const rec = this.records.find((r) => r.alert_id === alertId);
    if (!rec) return false;
    rec.acknowledged_at = at ?? new Date().toISOString();
    rec.acknowledged_by = by ?? null;
    return true;
  }

  all(): AlertRecord[] {
    return this.records;
  }

  clear(): void {
    this.records = [];
    this.nextId = 1;
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface AlertHistoryDeps {
  store: AlertHistoryStore;
}

export function getAlertHistory({ store }: AlertHistoryDeps) {
  return (_req: Request, res: Response): void => {
    const rawLimit = _req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), MAX_LIMIT);
      }
    }

    const rawOffset = _req.query.offset;
    let offset = 0;
    if (rawOffset !== undefined) {
      const parsed = Number(rawOffset);
      if (Number.isFinite(parsed) && parsed >= 0) {
        offset = Math.floor(parsed);
      }
    }

    const moduleFilter = typeof _req.query.module === "string" ? _req.query.module : null;
    const severityFilter = typeof _req.query.severity === "string" ? _req.query.severity : null;

    let records = store.all();

    if (moduleFilter) {
      records = records.filter((r) => r.module_name === moduleFilter);
    }

    if (severityFilter) {
      records = records.filter((r) => r.severity === severityFilter);
    }

    const sorted = records.slice().sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);

    res.json({
      alerts: page,
      total,
      limit,
      offset,
    });
  };
}

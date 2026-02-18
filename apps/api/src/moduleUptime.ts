import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ModuleUptimeData {
  startedAt: number;
  restartCount: number;
  lastRestartAt: number | null;
}

export class UptimeStore {
  private modules = new Map<string, ModuleUptimeData>();

  recordStart(module: string): void {
    const existing = this.modules.get(module);
    if (existing) {
      existing.restartCount += 1;
      existing.lastRestartAt = existing.startedAt;
      existing.startedAt = Date.now();
    } else {
      this.modules.set(module, {
        startedAt: Date.now(),
        restartCount: 0,
        lastRestartAt: null,
      });
    }
  }

  getData(module: string): ModuleUptimeData | undefined {
    return this.modules.get(module);
  }

  clear(): void {
    this.modules.clear();
  }
}

function formatHuman(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push("0m");
  return parts.join(" ");
}

interface UptimeDeps {
  uptimeStore: UptimeStore;
  nowFn?: () => number;
}

export function getModuleUptime({ uptimeStore, nowFn }: UptimeDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const data = uptimeStore.getData(name);

    if (!data) {
      res.json({
        module: name,
        uptime_seconds: 0,
        uptime_human: "0s",
        started_at: null,
        restart_count: 0,
        last_restart_at: null,
        status: "unknown",
      });
      return;
    }

    const uptimeSeconds = Math.floor((now - data.startedAt) / 1000);

    res.json({
      module: name,
      uptime_seconds: uptimeSeconds,
      uptime_human: formatHuman(uptimeSeconds),
      started_at: new Date(data.startedAt).toISOString(),
      restart_count: data.restartCount,
      last_restart_at: data.lastRestartAt ? new Date(data.lastRestartAt).toISOString() : null,
      status: "running",
    });
  };
}

import type { Request, Response } from "express";
import type { NatsConnection } from "nats";
import type { PrismaClient } from "@prisma/client";

type ModuleStatus = "healthy" | "stale" | "offline";
type WarmState = "warm" | "warming_up" | "stopped";

const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;

interface ModuleEntry {
  lastMessageAt: string | null;
  messageCount: number;
  reconnectCount: number;
}

export class LiveStatusStore {
  private modules = new Map<string, ModuleEntry>();
  private startedAt = Date.now();

  recordMessage(moduleName: string): void {
    const existing = this.modules.get(moduleName);
    this.modules.set(moduleName, {
      lastMessageAt: new Date().toISOString(),
      messageCount: (existing?.messageCount ?? 0) + 1,
      reconnectCount: existing?.reconnectCount ?? 0,
    });
  }

  recordReconnect(moduleName: string): void {
    const existing = this.modules.get(moduleName);
    this.modules.set(moduleName, {
      lastMessageAt: existing?.lastMessageAt ?? null,
      messageCount: existing?.messageCount ?? 0,
      reconnectCount: (existing?.reconnectCount ?? 0) + 1,
    });
  }

  getModuleStatus(moduleName: string): ModuleStatus {
    const entry = this.modules.get(moduleName);
    if (!entry || !entry.lastMessageAt) return "offline";
    const elapsed = Date.now() - new Date(entry.lastMessageAt).getTime();
    if (elapsed > OFFLINE_THRESHOLD_MS) return "offline";
    if (elapsed > STALE_THRESHOLD_MS) return "stale";
    return "healthy";
  }

  getWarmState(moduleName: string): WarmState {
    const entry = this.modules.get(moduleName);
    if (!entry) return "stopped";
    return entry.messageCount > 0 ? "warm" : "warming_up";
  }

  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  getAllModules(): Array<{
    name: string;
    status: ModuleStatus;
    warmState: WarmState;
    last_message_at: string | null;
    message_count: number;
    reconnect_count: number;
  }> {
    const result: Array<{
      name: string;
      status: ModuleStatus;
      warmState: WarmState;
      last_message_at: string | null;
      message_count: number;
      reconnect_count: number;
    }> = [];
    for (const [name, entry] of this.modules) {
      result.push({
        name,
        status: this.getModuleStatus(name),
        warmState: this.getWarmState(name),
        last_message_at: entry.lastMessageAt,
        message_count: entry.messageCount,
        reconnect_count: entry.reconnectCount,
      });
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }
}

interface StatusDeps {
  store: LiveStatusStore;
  getNatsConn: () => Promise<NatsConnection>;
  prisma: PrismaClient;
}

export function getStatus({ store, getNatsConn, prisma }: StatusDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    let natsConnected = false;
    try {
      const nc = await getNatsConn();
      natsConnected = !nc.isClosed();
    } catch {
      natsConnected = false;
    }

    let postgresConnected = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      postgresConnected = true;
    } catch {
      postgresConnected = false;
    }

    res.json({
      uptime_seconds: store.getUptimeSeconds(),
      modules: store.getAllModules(),
      nats_connected: natsConnected,
      postgres_connected: postgresConnected,
      timestamp: new Date().toISOString(),
    });
  };
}

import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const RATE_WINDOW_MS = 5 * 60 * 1000;

interface ModuleData {
  startedAt: number;
  totalMessages: number;
  totalErrors: number;
  messageTimes: number[];
  errorTimes: number[];
  latencySamples: number[];
  lastMessageAt: string | null;
}

export class ModuleMetricsStore {
  private modules = new Map<string, ModuleData>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  recordMessage(module: string, latencyMs?: number): void {
    const now = this.nowFn();
    const data = this.getOrCreate(module, now);
    data.totalMessages += 1;
    data.messageTimes.push(now);
    data.lastMessageAt = new Date(now).toISOString();
    if (latencyMs !== undefined && latencyMs >= 0) {
      data.latencySamples.push(latencyMs);
    }
  }

  recordError(module: string): void {
    const now = this.nowFn();
    const data = this.getOrCreate(module, now);
    data.totalErrors += 1;
    data.errorTimes.push(now);
  }

  recordStart(module: string): void {
    const now = this.nowFn();
    const data = this.getOrCreate(module, now);
    data.startedAt = now;
  }

  getMetrics(module: string): {
    message_rate: number;
    error_rate: number;
    uptime_seconds: number;
    total_messages: number;
    total_errors: number;
    avg_latency_ms: number | null;
    last_message_at: string | null;
  } | null {
    const data = this.modules.get(module);
    if (!data) return null;

    const now = this.nowFn();
    const windowStart = now - RATE_WINDOW_MS;

    const recentMessages = data.messageTimes.filter((t) => t >= windowStart);
    const recentErrors = data.errorTimes.filter((t) => t >= windowStart);

    const windowMinutes = RATE_WINDOW_MS / 60_000;
    const messageRate = +(recentMessages.length / windowMinutes).toFixed(2);
    const errorRate = +(recentErrors.length / windowMinutes).toFixed(2);

    const uptimeSeconds = Math.floor((now - data.startedAt) / 1000);

    let avgLatency: number | null = null;
    if (data.latencySamples.length > 0) {
      const sum = data.latencySamples.reduce((a, b) => a + b, 0);
      avgLatency = +(sum / data.latencySamples.length).toFixed(2);
    }

    return {
      message_rate: messageRate,
      error_rate: errorRate,
      uptime_seconds: uptimeSeconds,
      total_messages: data.totalMessages,
      total_errors: data.totalErrors,
      avg_latency_ms: avgLatency,
      last_message_at: data.lastMessageAt,
    };
  }

  getMessageTimes(module: string): number[] {
    const data = this.modules.get(module);
    if (!data) return [];
    return data.messageTimes;
  }

  getModuleNames(): string[] {
    return [...this.modules.keys()];
  }

  getLatencySamples(module: string, _windowMs?: number): number[] {
    const data = this.modules.get(module);
    if (!data) return [];
    return data.latencySamples;
  }

  private getOrCreate(module: string, now: number): ModuleData {
    let data = this.modules.get(module);
    if (!data) {
      data = {
        startedAt: now,
        totalMessages: 0,
        totalErrors: 0,
        messageTimes: [],
        errorTimes: [],
        latencySamples: [],
        lastMessageAt: null,
      };
      this.modules.set(module, data);
    }
    return data;
  }
}

interface MetricsDeps {
  metricsStore: ModuleMetricsStore;
}

export function getModuleMetrics({ metricsStore }: MetricsDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const metrics = metricsStore.getMetrics(name);
    if (!metrics) {
      res.json({
        module: name,
        message_rate: 0,
        error_rate: 0,
        uptime_seconds: 0,
        total_messages: 0,
        total_errors: 0,
        avg_latency_ms: null,
        last_message_at: null,
      });
      return;
    }

    res.json({ module: name, ...metrics });
  };
}

import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ModulePipelineData {
  messagesIn: number;
  messagesOut: number;
  messagesDropped: number;
  processingTimes: number[];
  backpressureEvents: number;
  lastProcessedAt: string | null;
}

export class PipelineStatsStore {
  private modules = new Map<string, ModulePipelineData>();

  recordIn(module: string): void {
    const data = this.getOrCreate(module);
    data.messagesIn += 1;
  }

  recordOut(module: string, processingTimeMs?: number): void {
    const data = this.getOrCreate(module);
    data.messagesOut += 1;
    data.lastProcessedAt = new Date().toISOString();
    if (processingTimeMs !== undefined && processingTimeMs >= 0) {
      data.processingTimes.push(processingTimeMs);
    }
  }

  recordDrop(module: string): void {
    const data = this.getOrCreate(module);
    data.messagesDropped += 1;
  }

  recordBackpressure(module: string): void {
    const data = this.getOrCreate(module);
    data.backpressureEvents += 1;
  }

  getStats(module: string): {
    messages_in: number;
    messages_out: number;
    messages_dropped: number;
    processing_time_avg_ms: number | null;
    backpressure_events: number;
    last_processed_at: string | null;
  } | null {
    const data = this.modules.get(module);
    if (!data) return null;

    let avgMs: number | null = null;
    if (data.processingTimes.length > 0) {
      const sum = data.processingTimes.reduce((a, b) => a + b, 0);
      avgMs = +(sum / data.processingTimes.length).toFixed(2);
    }

    return {
      messages_in: data.messagesIn,
      messages_out: data.messagesOut,
      messages_dropped: data.messagesDropped,
      processing_time_avg_ms: avgMs,
      backpressure_events: data.backpressureEvents,
      last_processed_at: data.lastProcessedAt,
    };
  }

  reset(module: string): boolean {
    return this.modules.delete(module);
  }

  private getOrCreate(module: string): ModulePipelineData {
    let data = this.modules.get(module);
    if (!data) {
      data = {
        messagesIn: 0,
        messagesOut: 0,
        messagesDropped: 0,
        processingTimes: [],
        backpressureEvents: 0,
        lastProcessedAt: null,
      };
      this.modules.set(module, data);
    }
    return data;
  }
}

interface PipelineStatsDeps {
  pipelineStore: PipelineStatsStore;
}

export function getModulePipelineStats({ pipelineStore }: PipelineStatsDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const stats = pipelineStore.getStats(name);
    if (!stats) {
      res.json({
        module: name,
        messages_in: 0,
        messages_out: 0,
        messages_dropped: 0,
        processing_time_avg_ms: null,
        backpressure_events: 0,
        last_processed_at: null,
      });
      return;
    }

    res.json({ module: name, ...stats });
  };
}

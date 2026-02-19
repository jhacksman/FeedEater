import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const DEFAULT_WINDOW_SECONDS = 60;

interface BandwidthSample {
  module: string;
  bytesIn: number;
  bytesOut: number;
  timestamp: number;
}

export class BandwidthStore {
  private samples: BandwidthSample[] = [];

  record(module: string, bytesIn: number, bytesOut: number, timestamp?: number): void {
    this.samples.push({
      module,
      bytesIn,
      bytesOut,
      timestamp: timestamp ?? Date.now(),
    });
  }

  getSamples(windowStart: number): BandwidthSample[] {
    return this.samples.filter((s) => s.timestamp >= windowStart);
  }

  clear(): void {
    this.samples = [];
  }

  prune(before: number): void {
    this.samples = this.samples.filter((s) => s.timestamp >= before);
  }
}

interface SystemBandwidthDeps {
  bandwidthStore: BandwidthStore;
  nowFn?: () => number;
}

export function getSystemBandwidth({ bandwidthStore, nowFn }: SystemBandwidthDeps) {
  return (_req: Request, res: Response): void => {
    const now = nowFn?.() ?? Date.now();
    const windowMs = DEFAULT_WINDOW_SECONDS * 1000;
    const windowStart = now - windowMs;

    const recent = bandwidthStore.getSamples(windowStart);

    let totalBytesIn = 0;
    let totalBytesOut = 0;
    let totalMessages = 0;

    const perModule = new Map<string, { bytesIn: number; bytesOut: number; count: number }>();

    for (const s of recent) {
      totalBytesIn += s.bytesIn;
      totalBytesOut += s.bytesOut;
      totalMessages += 1;

      let entry = perModule.get(s.module);
      if (!entry) {
        entry = { bytesIn: 0, bytesOut: 0, count: 0 };
        perModule.set(s.module, entry);
      }
      entry.bytesIn += s.bytesIn;
      entry.bytesOut += s.bytesOut;
      entry.count += 1;
    }

    const inBps = +(totalBytesIn / DEFAULT_WINDOW_SECONDS).toFixed(2);
    const outBps = +(totalBytesOut / DEFAULT_WINDOW_SECONDS).toFixed(2);
    const totalMessagesSec = +(totalMessages / DEFAULT_WINDOW_SECONDS).toFixed(4);

    const modules: Record<string, { in_bps: number; out_bps: number }> = {};
    for (const name of [...KNOWN_MODULES]) {
      const entry = perModule.get(name);
      if (entry) {
        modules[name] = {
          in_bps: +(entry.bytesIn / DEFAULT_WINDOW_SECONDS).toFixed(2),
          out_bps: +(entry.bytesOut / DEFAULT_WINDOW_SECONDS).toFixed(2),
        };
      } else {
        modules[name] = { in_bps: 0, out_bps: 0 };
      }
    }

    res.json({
      system: {
        in_bps: inBps,
        out_bps: outBps,
        total_messages_sec: totalMessagesSec,
      },
      modules,
      sampled_at: new Date(now).toISOString(),
    });
  };
}

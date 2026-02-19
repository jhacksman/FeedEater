import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface RawMessage {
  received_at: number;
  raw_data: unknown;
  size_bytes: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_BUFFER = 500;

export class RawFeedStore {
  private buffers = new Map<string, RawMessage[]>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  record(module: string, raw_data: unknown): void {
    const now = this.nowFn();
    let buffer = this.buffers.get(module);
    if (!buffer) {
      buffer = [];
      this.buffers.set(module, buffer);
    }
    const serialized = JSON.stringify(raw_data);
    buffer.push({ received_at: now, raw_data, size_bytes: Buffer.byteLength(serialized, "utf8") });
    if (buffer.length > MAX_BUFFER) buffer.shift();
  }

  getMessages(module: string, limit: number, since?: number): { messages: RawMessage[]; total: number } {
    const buffer = this.buffers.get(module);
    if (!buffer) return { messages: [], total: 0 };
    let filtered = buffer;
    if (since !== undefined) {
      filtered = buffer.filter((m) => m.received_at >= since);
    }
    const total = filtered.length;
    const clamped = Math.min(limit, filtered.length);
    const messages = filtered.slice(-clamped);
    return { messages, total };
  }
}

interface RawFeedDeps {
  rawFeedStore: RawFeedStore;
  nowFn?: () => number;
}

export function getModuleRawFeed({ rawFeedStore, nowFn }: RawFeedDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    let since: number | undefined;
    if (req.query.since !== undefined) {
      const ts = Date.parse(String(req.query.since));
      if (Number.isNaN(ts)) {
        res.status(400).json({ error: "since must be a valid ISO timestamp" });
        return;
      }
      since = ts;
    }

    const { messages, total } = rawFeedStore.getMessages(name, limit, since);

    res.json({
      module: name,
      messages: messages.map((m) => ({
        received_at: new Date(m.received_at).toISOString(),
        raw_data: m.raw_data,
        size_bytes: m.size_bytes,
      })),
      total,
    });
  };
}

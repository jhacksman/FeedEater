import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface SnapshotMessage {
  timestamp: number;
  subject: string;
  data: unknown;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_BUFFER = 100;

export class SnapshotStore {
  private buffers = new Map<string, SnapshotMessage[]>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  record(module: string, subject: string, data: unknown): void {
    const now = this.nowFn();
    let buffer = this.buffers.get(module);
    if (!buffer) {
      buffer = [];
      this.buffers.set(module, buffer);
    }
    buffer.push({ timestamp: now, subject, data });
    if (buffer.length > MAX_BUFFER) buffer.shift();
  }

  getMessages(module: string, limit: number): SnapshotMessage[] {
    const buffer = this.buffers.get(module);
    if (!buffer) return [];
    const clamped = Math.min(limit, buffer.length);
    return buffer.slice(-clamped);
  }

  getSubject(module: string): string {
    return `feedeater.${module}.messageCreated`;
  }
}

interface SnapshotDeps {
  snapshotStore: SnapshotStore;
  nowFn?: () => number;
}

export function getModuleSnapshot({ snapshotStore, nowFn }: SnapshotDeps) {
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

    const now = nowFn?.() ?? Date.now();
    const messages = snapshotStore.getMessages(name, limit);
    const subject = snapshotStore.getSubject(name);

    res.json({
      module: name,
      subject,
      snapshot_at: new Date(now).toISOString(),
      count: messages.length,
      messages: messages.map((m) => ({
        timestamp: new Date(m.timestamp).toISOString(),
        data: m.data,
      })),
    });
  };
}

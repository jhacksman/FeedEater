import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

const DEFAULT_LINES = 50;
const MAX_LINES = 500;
const MAX_BUFFER_SIZE = 1000;

export class ModuleLogStore {
  private buffers = new Map<string, LogEntry[]>();

  record(module: string, level: LogEntry["level"], message: string): void {
    let buf = this.buffers.get(module);
    if (!buf) {
      buf = [];
      this.buffers.set(module, buf);
    }
    buf.push({ timestamp: new Date().toISOString(), level, message });
    if (buf.length > MAX_BUFFER_SIZE) {
      buf.splice(0, buf.length - MAX_BUFFER_SIZE);
    }
  }

  tail(module: string, lines: number): LogEntry[] {
    const buf = this.buffers.get(module);
    if (!buf || buf.length === 0) return [];
    const n = Math.min(lines, buf.length);
    return buf.slice(-n);
  }

  totalLines(module: string): number {
    return this.buffers.get(module)?.length ?? 0;
  }

  clear(): void {
    this.buffers.clear();
  }
}

interface ModuleLogsDeps {
  logStore: ModuleLogStore;
}

export function getModuleLogs({ logStore }: ModuleLogsDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const rawLines = req.query.lines;
    let lines = DEFAULT_LINES;
    if (rawLines !== undefined) {
      const parsed = Number(rawLines);
      if (!Number.isFinite(parsed) || parsed < 1) {
        res.status(400).json({ error: "lines must be a positive integer" });
        return;
      }
      lines = Math.min(Math.floor(parsed), MAX_LINES);
    }

    const entries = logStore.tail(name, lines);
    const total = logStore.totalLines(name);

    const result: {
      module: string;
      lines: LogEntry[];
      total_lines: number;
      note?: string;
    } = {
      module: name,
      lines: entries,
      total_lines: total,
    };

    if (entries.length === 0) {
      result.note = "No log data available for this module";
    }

    res.json(result);
  };
}

import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const MAX_STACK_LENGTH = 2000;

interface ErrorRecord {
  error_message: string;
  error_type: string;
  stack_trace: string | null;
  occurred_at: number;
  context: Record<string, unknown>;
}

export class LastErrorStore {
  private errors = new Map<string, ErrorRecord>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  record(module: string, error: Error, context?: Record<string, unknown>): void {
    const stack = error.stack ?? null;
    this.errors.set(module, {
      error_message: error.message,
      error_type: error.constructor.name ?? "Error",
      stack_trace: stack && stack.length > MAX_STACK_LENGTH ? stack.slice(0, MAX_STACK_LENGTH) : stack,
      occurred_at: this.nowFn(),
      context: context ?? {},
    });
  }

  get(module: string): ErrorRecord | null {
    return this.errors.get(module) ?? null;
  }
}

interface LastErrorDeps {
  lastErrorStore: LastErrorStore;
}

export function getModuleLastError({ lastErrorStore }: LastErrorDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const record = lastErrorStore.get(name);

    if (!record) {
      res.json({ module: name, error: null });
      return;
    }

    res.json({
      module: name,
      error_message: record.error_message,
      error_type: record.error_type,
      stack_trace: record.stack_trace,
      occurred_at: new Date(record.occurred_at).toISOString(),
      context: record.context,
    });
  };
}

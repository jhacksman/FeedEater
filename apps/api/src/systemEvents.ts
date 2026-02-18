import type { Request, Response } from "express";

type EventType = "start" | "stop" | "restart" | "error" | "config_change";
type EventSeverity = "info" | "warn" | "error";

interface SystemEvent {
  timestamp: string;
  type: EventType;
  module: string | null;
  message: string;
  severity: EventSeverity;
}

const MAX_EVENTS = 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const VALID_TYPES = new Set<string>(["start", "stop", "restart", "error", "config_change"]);

export class SystemEventStore {
  private events: SystemEvent[] = [];

  record(type: EventType, message: string, severity: EventSeverity, module?: string): SystemEvent {
    const event: SystemEvent = {
      timestamp: new Date().toISOString(),
      type,
      module: module ?? null,
      message,
      severity,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    return event;
  }

  recordWithTimestamp(type: EventType, message: string, severity: EventSeverity, timestamp: string, module?: string): SystemEvent {
    const event: SystemEvent = {
      timestamp,
      type,
      module: module ?? null,
      message,
      severity,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    return event;
  }

  all(): SystemEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }
}

interface SystemEventsDeps {
  eventStore: SystemEventStore;
}

export function getSystemEvents({ eventStore }: SystemEventsDeps) {
  return (_req: Request, res: Response): void => {
    const rawLimit = _req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), MAX_LIMIT);
      }
    }

    const typeFilter = typeof _req.query.type === "string" ? _req.query.type : null;

    let events = eventStore.all();

    if (typeFilter && VALID_TYPES.has(typeFilter)) {
      events = events.filter((e) => e.type === typeFilter);
    }

    const sorted = events.slice().sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const page = sorted.slice(0, limit);

    res.json({
      events: page,
      total: sorted.length,
      limit,
    });
  };
}

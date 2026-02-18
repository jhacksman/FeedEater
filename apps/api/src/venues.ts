import type { Request, Response } from "express";

type VenueType = "cex" | "dex" | "prediction";
type VenueStatus = "active" | "inactive" | "error";

interface VenueDef {
  name: string;
  type: VenueType;
  module: string;
}

const VENUE_DEFS: VenueDef[] = [
  { name: "binance", type: "cex", module: "binance" },
  { name: "coinbase", type: "cex", module: "coinbase" },
  { name: "bybit", type: "cex", module: "bybit" },
  { name: "gemini", type: "cex", module: "gemini" },
  { name: "bitstamp", type: "cex", module: "bitstamp" },
  { name: "okx", type: "cex", module: "okx" },
  { name: "uniswap-base", type: "dex", module: "uniswap-base" },
  { name: "aerodrome-base", type: "dex", module: "aerodrome-base" },
  { name: "kalshi", type: "prediction", module: "kalshi" },
  { name: "polymarket", type: "prediction", module: "polymarket" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

interface MessageRecord {
  lastMessageAt: string | null;
  timestamps: number[];
  hasError: boolean;
}

export class VenueStore {
  private data = new Map<string, MessageRecord>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  recordMessage(module: string): void {
    const now = this.nowFn();
    const rec = this.getOrCreate(module);
    rec.lastMessageAt = new Date(now).toISOString();
    rec.timestamps.push(now);
  }

  recordError(module: string): void {
    const rec = this.getOrCreate(module);
    rec.hasError = true;
  }

  clearError(module: string): void {
    const rec = this.data.get(module);
    if (rec) rec.hasError = false;
  }

  getVenueData(module: string): { lastMessageAt: string | null; messageCount24h: number; hasError: boolean } {
    const rec = this.data.get(module);
    if (!rec) return { lastMessageAt: null, messageCount24h: 0, hasError: false };

    const now = this.nowFn();
    const cutoff = now - DAY_MS;
    const count24h = rec.timestamps.filter((t) => t >= cutoff).length;

    return {
      lastMessageAt: rec.lastMessageAt,
      messageCount24h: count24h,
      hasError: rec.hasError,
    };
  }

  private getOrCreate(module: string): MessageRecord {
    let rec = this.data.get(module);
    if (!rec) {
      rec = { lastMessageAt: null, timestamps: [], hasError: false };
      this.data.set(module, rec);
    }
    return rec;
  }
}

interface VenueDeps {
  venueStore: VenueStore;
  disabledModules: Set<string>;
}

export function getVenues({ venueStore, disabledModules }: VenueDeps) {
  return (_req: Request, res: Response): void => {
    const venues = VENUE_DEFS.map((def) => {
      const data = venueStore.getVenueData(def.module);

      let status: VenueStatus;
      if (data.hasError) {
        status = "error";
      } else if (disabledModules.has(def.module) || data.lastMessageAt === null) {
        status = "inactive";
      } else {
        status = "active";
      }

      return {
        name: def.name,
        type: def.type,
        status,
        module: def.module,
        last_message_at: data.lastMessageAt,
        message_count_24h: data.messageCount24h,
      };
    });

    res.json({ venues });
  };
}

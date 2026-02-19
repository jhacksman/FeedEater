import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const VALID_LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

export class RuntimeConfig {
  logLevel: LogLevel;
  rateLimitDefaults: { window_ms: number; max_requests: number };

  constructor(logLevel?: LogLevel, rateLimitDefaults?: { window_ms: number; max_requests: number }) {
    this.logLevel = logLevel ?? "info";
    this.rateLimitDefaults = rateLimitDefaults ?? { window_ms: 60_000, max_requests: 100 };
  }
}

interface SystemConfigDeps {
  runtimeConfig: RuntimeConfig;
  natsUrl: string;
  postgresEnabled: boolean;
  apiPort: number;
  version: string;
}

export function getSystemConfig({ runtimeConfig, natsUrl, postgresEnabled, apiPort, version }: SystemConfigDeps) {
  return (_req: Request, res: Response): void => {
    res.json({
      nats_url: natsUrl,
      postgres_enabled: postgresEnabled,
      api_port: apiPort,
      rate_limit_defaults: runtimeConfig.rateLimitDefaults,
      log_level: runtimeConfig.logLevel,
      module_count: KNOWN_MODULES.size,
      version,
    });
  };
}

export function patchSystemConfig({ runtimeConfig }: { runtimeConfig: RuntimeConfig }) {
  return (req: Request, res: Response): void => {
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }

    const updates: string[] = [];

    if ("log_level" in body) {
      const level = body.log_level;
      if (typeof level !== "string" || !VALID_LOG_LEVELS.has(level)) {
        res.status(400).json({ error: `Invalid log_level. Must be one of: debug, info, warn, error` });
        return;
      }
      runtimeConfig.logLevel = level as LogLevel;
      updates.push("log_level");
    }

    if ("rate_limit_defaults" in body) {
      const rl = body.rate_limit_defaults;
      if (
        !rl ||
        typeof rl !== "object" ||
        typeof (rl as Record<string, unknown>).window_ms !== "number" ||
        typeof (rl as Record<string, unknown>).max_requests !== "number" ||
        (rl as Record<string, unknown>).window_ms as number <= 0 ||
        (rl as Record<string, unknown>).max_requests as number <= 0
      ) {
        res.status(400).json({ error: "rate_limit_defaults must have positive window_ms and max_requests" });
        return;
      }
      runtimeConfig.rateLimitDefaults = {
        window_ms: (rl as Record<string, unknown>).window_ms as number,
        max_requests: (rl as Record<string, unknown>).max_requests as number,
      };
      updates.push("rate_limit_defaults");
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No valid fields to update. Supported: log_level, rate_limit_defaults" });
      return;
    }

    res.json({
      updated: updates,
      log_level: runtimeConfig.logLevel,
      rate_limit_defaults: runtimeConfig.rateLimitDefaults,
    });
  };
}

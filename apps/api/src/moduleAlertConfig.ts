import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

type Severity = "info" | "warning" | "critical";
type Channel = "webhook" | "email" | "slack";

interface AlertConfig {
  enabled: boolean;
  error_rate_threshold: number;
  latency_threshold_ms: number;
  reconnect_threshold: number;
  severity: Severity;
  cooldown_seconds: number;
  channels: Channel[];
}

const DEFAULT_CONFIG: AlertConfig = {
  enabled: true,
  error_rate_threshold: 0.05,
  latency_threshold_ms: 5000,
  reconnect_threshold: 3,
  severity: "warning",
  cooldown_seconds: 300,
  channels: ["webhook"],
};

export class AlertConfigStore {
  private configs = new Map<string, AlertConfig>();

  get(module: string): AlertConfig {
    const stored = this.configs.get(module);
    if (stored) return { ...stored, channels: [...stored.channels] };
    return { ...DEFAULT_CONFIG, channels: [...DEFAULT_CONFIG.channels] };
  }

  update(module: string, patch: Partial<AlertConfig>): AlertConfig {
    const current = this.get(module);
    const updated = { ...current, ...patch };
    if (patch.channels) updated.channels = [...patch.channels];
    this.configs.set(module, updated);
    return { ...updated, channels: [...updated.channels] };
  }
}

interface AlertConfigDeps {
  configStore: AlertConfigStore;
}

const VALID_SEVERITIES = new Set<string>(["info", "warning", "critical"]);
const VALID_CHANNELS = new Set<string>(["webhook", "email", "slack"]);

export function getModuleAlertConfig({ configStore }: AlertConfigDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const config = configStore.get(name);

    res.json({
      module: name,
      ...config,
    });
  };
}

export function patchModuleAlertConfig({ configStore }: AlertConfigDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }

    const patch: Partial<AlertConfig> = {};

    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      patch.enabled = body.enabled;
    }

    if ("error_rate_threshold" in body) {
      if (typeof body.error_rate_threshold !== "number" || body.error_rate_threshold < 0 || body.error_rate_threshold > 1) {
        res.status(400).json({ error: "error_rate_threshold must be a number between 0 and 1" });
        return;
      }
      patch.error_rate_threshold = body.error_rate_threshold;
    }

    if ("latency_threshold_ms" in body) {
      if (typeof body.latency_threshold_ms !== "number" || body.latency_threshold_ms < 0) {
        res.status(400).json({ error: "latency_threshold_ms must be a non-negative number" });
        return;
      }
      patch.latency_threshold_ms = body.latency_threshold_ms;
    }

    if ("reconnect_threshold" in body) {
      if (typeof body.reconnect_threshold !== "number" || !Number.isInteger(body.reconnect_threshold) || body.reconnect_threshold < 0) {
        res.status(400).json({ error: "reconnect_threshold must be a non-negative integer" });
        return;
      }
      patch.reconnect_threshold = body.reconnect_threshold;
    }

    if ("severity" in body) {
      if (typeof body.severity !== "string" || !VALID_SEVERITIES.has(body.severity)) {
        res.status(400).json({ error: "severity must be one of: info, warning, critical" });
        return;
      }
      patch.severity = body.severity as Severity;
    }

    if ("cooldown_seconds" in body) {
      if (typeof body.cooldown_seconds !== "number" || !Number.isInteger(body.cooldown_seconds) || body.cooldown_seconds < 0) {
        res.status(400).json({ error: "cooldown_seconds must be a non-negative integer" });
        return;
      }
      patch.cooldown_seconds = body.cooldown_seconds;
    }

    if ("channels" in body) {
      if (!Array.isArray(body.channels) || body.channels.some((c: unknown) => typeof c !== "string" || !VALID_CHANNELS.has(c as string))) {
        res.status(400).json({ error: "channels must be an array of: webhook, email, slack" });
        return;
      }
      patch.channels = body.channels as Channel[];
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const updated = configStore.update(name, patch);

    res.json({
      module: name,
      ...updated,
    });
  };
}

import type { NextFunction, Request, Response } from "express";
import type { ApiKeyDb } from "../apiKeys.js";
import type { UsageTracker } from "../usageTracker.js";

const OPEN_PATHS = ["/api/health/modules", "/api/docs", "/metrics"];

let _dynamicKeyDb: ApiKeyDb | null = null;
let _usageTracker: UsageTracker | null = null;

export function setDynamicKeyDb(db: ApiKeyDb): void {
  _dynamicKeyDb = db;
}

export function setUsageTracker(tracker: UsageTracker): void {
  _usageTracker = tracker;
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    next();
    return;
  }

  if (OPEN_PATHS.includes(req.path)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (token === apiKey) {
    next();
    return;
  }

  if (_dynamicKeyDb) {
    const keyId = _dynamicKeyDb.validateAndGetId(token);
    if (keyId) {
      if (_usageTracker) {
        try { _usageTracker.recordRequest(keyId); } catch {}
      }
      next();
      return;
    }
  }

  res.status(401).json({ error: "Invalid API key" });
}

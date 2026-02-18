import type { NextFunction, Request, Response } from "express";

const FREE_LIMIT = 10;
const STANDARD_LIMIT = 100;
const WINDOW_MS = 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket, limit: number, now: number): void {
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  const refillAmount = (elapsed / WINDOW_MS) * limit;
  bucket.tokens = Math.min(limit, bucket.tokens + refillAmount);
  bucket.lastRefill = now;
}

function getBucketKey(req: Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return `key:${authHeader.slice(7)}`;
  }
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip ?? "unknown";
  return `ip:${ip}`;
}

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = getBucketKey(req);
  const hasApiKey = key.startsWith("key:");
  const limit = hasApiKey ? STANDARD_LIMIT : FREE_LIMIT;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit, lastRefill: now };
    buckets.set(key, bucket);
  }

  refill(bucket, limit, now);

  res.setHeader("X-RateLimit-Limit", String(limit));

  if (bucket.tokens < 1) {
    const retryAfter = Math.ceil(((1 - bucket.tokens) / limit) * (WINDOW_MS / 1000));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too Many Requests" });
    return;
  }

  bucket.tokens -= 1;
  res.setHeader("X-RateLimit-Remaining", String(Math.floor(bucket.tokens)));

  next();
}

export function _resetBuckets(): void {
  buckets.clear();
}

export { FREE_LIMIT, STANDARD_LIMIT, WINDOW_MS, buckets };

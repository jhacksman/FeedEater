import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface SystemInfoDeps {
  startedAt: number;
  versionOverride?: string;
}

export function getSystemInfo({ startedAt, versionOverride }: SystemInfoDeps) {
  const version = versionOverride ?? loadVersion();

  return (_req: Request, res: Response): void => {
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

    res.json({
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime_seconds: uptimeSeconds,
      started_at: new Date(startedAt).toISOString(),
      version,
      memory: {
        rss_mb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        heap_used_mb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        heap_total_mb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      },
    });
  };
}

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

interface SystemVersionDeps {
  startedAt: number;
  versionOverride?: string;
  buildTime?: string;
  gitSha?: string;
}

export function getSystemVersion({ startedAt, versionOverride, buildTime, gitSha }: SystemVersionDeps) {
  const version = versionOverride ?? loadVersion();

  return (_req: Request, res: Response): void => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

    res.json({
      version,
      build_time: buildTime ?? null,
      git_sha: gitSha ?? null,
      node_version: process.version,
      uptime_seconds: uptimeSeconds,
    });
  };
}

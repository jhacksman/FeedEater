import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface Dependency {
  name: string;
  type: "npm" | "env" | "service";
  status: "satisfied" | "missing" | "unknown";
  version?: string;
  required_version?: string;
}

interface ModuleDef {
  envVars: string[];
  services: Array<{ name: string; envKey?: string }>;
}

const MODULE_DEFS: Record<string, ModuleDef> = {
  binance: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  coinbase: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  bybit: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  gemini: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  bitstamp: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  okx: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  kalshi: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  polymarket: {
    envVars: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }],
  },
  "aerodrome-base": {
    envVars: ["NATS_URL", "DATABASE_URL"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }, { name: "base-rpc" }],
  },
  "uniswap-base": {
    envVars: ["NATS_URL", "DATABASE_URL"],
    services: [{ name: "nats", envKey: "NATS_URL" }, { name: "postgres", envKey: "DATABASE_URL" }, { name: "base-rpc" }],
  },
};

function readPackageJson(modulesDir: string, moduleName: string): Record<string, string> | null {
  const pkgPath = join(modulesDir, moduleName, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return pkg.dependencies ?? null;
  } catch {
    return null;
  }
}

function resolveInstalledVersion(modulesDir: string, moduleName: string, pkgName: string): string | undefined {
  const candidates = [
    join(modulesDir, moduleName, "node_modules", pkgName, "package.json"),
    join(modulesDir, "..", "node_modules", pkgName, "package.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      const pkg = JSON.parse(raw) as { version?: string };
      return pkg.version;
    } catch {
      continue;
    }
  }
  return undefined;
}

interface DependenciesDeps {
  modulesDir: string;
  envOverride?: Record<string, string | undefined>;
}

export function getModuleDependencies({ modulesDir, envOverride }: DependenciesDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({
        error: `Unknown module: ${name}. Valid modules: ${[...KNOWN_MODULES].join(", ")}`,
      });
      return;
    }

    const def = MODULE_DEFS[name];
    const env = envOverride ?? process.env;
    const dependencies: Dependency[] = [];

    const npmDeps = readPackageJson(modulesDir, name);
    if (npmDeps) {
      for (const [pkg, requiredVersion] of Object.entries(npmDeps)) {
        const installedVersion = resolveInstalledVersion(modulesDir, name, pkg);
        dependencies.push({
          name: pkg,
          type: "npm",
          status: installedVersion ? "satisfied" : "unknown",
          version: installedVersion,
          required_version: requiredVersion,
        });
      }
    }

    if (def) {
      for (const envVar of def.envVars) {
        dependencies.push({
          name: envVar,
          type: "env",
          status: env[envVar] ? "satisfied" : "missing",
        });
      }

      for (const svc of def.services) {
        let status: "satisfied" | "missing" | "unknown" = "unknown";
        if (svc.envKey && env[svc.envKey]) {
          status = "satisfied";
        } else if (svc.envKey && !env[svc.envKey]) {
          status = "missing";
        }
        dependencies.push({
          name: svc.name,
          type: "service",
          status,
        });
      }
    }

    const satisfied = dependencies.filter((d) => d.status === "satisfied").length;
    const missing = dependencies.filter((d) => d.status === "missing").length;
    const unknown = dependencies.filter((d) => d.status === "unknown").length;

    res.json({
      module: name,
      dependencies,
      summary: { total: dependencies.length, satisfied, missing, unknown },
    });
  };
}

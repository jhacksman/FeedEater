import type { Request, Response } from "express";

type DependencyStatus = "healthy" | "degraded" | "down";

interface DependencyResult {
  name: string;
  status: DependencyStatus;
  latency_ms: number | null;
  last_checked_at: string;
}

export interface DependencyChecker {
  name: string;
  check: () => Promise<{ status: DependencyStatus; latency_ms: number | null }>;
}

interface SystemDependenciesDeps {
  checkers: DependencyChecker[];
}

export function getSystemDependencies({ checkers }: SystemDependenciesDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const results: DependencyResult[] = [];

    for (const checker of checkers) {
      try {
        const result = await checker.check();
        results.push({
          name: checker.name,
          status: result.status,
          latency_ms: result.latency_ms,
          last_checked_at: new Date().toISOString(),
        });
      } catch {
        results.push({
          name: checker.name,
          status: "down",
          latency_ms: null,
          last_checked_at: new Date().toISOString(),
        });
      }
    }

    const allHealthy = results.every((r) => r.status === "healthy");
    const anyDown = results.some((r) => r.status === "down");

    res.json({
      overall: anyDown ? "degraded" : allHealthy ? "healthy" : "degraded",
      dependencies: results,
    });
  };
}

export function makeNatsChecker(getNatsConn: () => Promise<{ isClosed: () => boolean; flush: () => Promise<void> }>): DependencyChecker {
  return {
    name: "nats",
    async check() {
      const start = Date.now();
      try {
        const nc = await getNatsConn();
        if (nc.isClosed()) {
          return { status: "down", latency_ms: Date.now() - start };
        }
        await nc.flush();
        const latency = Date.now() - start;
        return { status: latency > 500 ? "degraded" : "healthy", latency_ms: latency };
      } catch {
        return { status: "down", latency_ms: Date.now() - start };
      }
    },
  };
}

export function makePostgresChecker(queryFn: () => Promise<unknown>): DependencyChecker {
  return {
    name: "postgres",
    async check() {
      const start = Date.now();
      try {
        await queryFn();
        const latency = Date.now() - start;
        return { status: latency > 1000 ? "degraded" : "healthy", latency_ms: latency };
      } catch {
        return { status: "down", latency_ms: Date.now() - start };
      }
    },
  };
}

export function makeRedisChecker(pingFn?: () => Promise<string>): DependencyChecker {
  return {
    name: "redis",
    async check() {
      if (!pingFn) {
        return { status: "down", latency_ms: null };
      }
      const start = Date.now();
      try {
        await pingFn();
        const latency = Date.now() - start;
        return { status: latency > 500 ? "degraded" : "healthy", latency_ms: latency };
      } catch {
        return { status: "down", latency_ms: Date.now() - start };
      }
    },
  };
}

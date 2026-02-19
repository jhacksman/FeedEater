import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

type CircuitState = "open" | "closed" | "half-open";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RECOVERY_TIMEOUT_SECONDS = 30;

interface CircuitBreakerState {
  state: CircuitState;
  trip_count: number;
  last_tripped_at: string | null;
  last_recovered_at: string | null;
  failure_threshold: number;
  recovery_timeout_seconds: number;
}

export class CircuitBreakerStore {
  private breakers = new Map<string, CircuitBreakerState>();

  configure(
    module: string,
    failureThreshold?: number,
    recoveryTimeoutSeconds?: number,
  ): void {
    if (!this.breakers.has(module)) {
      this.breakers.set(module, {
        state: "closed",
        trip_count: 0,
        last_tripped_at: null,
        last_recovered_at: null,
        failure_threshold: failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
        recovery_timeout_seconds: recoveryTimeoutSeconds ?? DEFAULT_RECOVERY_TIMEOUT_SECONDS,
      });
    }
  }

  trip(module: string, timestamp?: string): void {
    const cb = this.breakers.get(module);
    if (!cb) return;
    cb.state = "open";
    cb.trip_count += 1;
    cb.last_tripped_at = timestamp ?? new Date().toISOString();
  }

  halfOpen(module: string): void {
    const cb = this.breakers.get(module);
    if (!cb) return;
    cb.state = "half-open";
  }

  recover(module: string, timestamp?: string): void {
    const cb = this.breakers.get(module);
    if (!cb) return;
    cb.state = "closed";
    cb.last_recovered_at = timestamp ?? new Date().toISOString();
  }

  get(module: string): CircuitBreakerState | null {
    return this.breakers.get(module) ?? null;
  }

  clear(): void {
    this.breakers.clear();
  }
}

interface CircuitBreakerDeps {
  circuitStore: CircuitBreakerStore;
}

export function getModuleCircuitBreaker({ circuitStore }: CircuitBreakerDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const cb = circuitStore.get(name);

    if (!cb) {
      res.json({ module: name, circuit_breaker: null });
      return;
    }

    res.json({
      module: name,
      circuit_breaker: {
        state: cb.state,
        trip_count: cb.trip_count,
        last_tripped_at: cb.last_tripped_at,
        last_recovered_at: cb.last_recovered_at,
        failure_threshold: cb.failure_threshold,
        recovery_timeout_seconds: cb.recovery_timeout_seconds,
      },
    });
  };
}

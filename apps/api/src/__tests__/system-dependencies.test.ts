import { describe, it, expect } from "vitest";
import { getSystemDependencies, makeNatsChecker, makePostgresChecker, makeRedisChecker } from "../systemDependencies.js";
import type { DependencyChecker } from "../systemDependencies.js";

function makeReq() {
  return {} as any;
}

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { body = data; },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

function fakeChecker(name: string, status: "healthy" | "degraded" | "down", latency_ms: number | null = 5): DependencyChecker {
  return {
    name,
    async check() {
      return { status, latency_ms };
    },
  };
}

function failingChecker(name: string): DependencyChecker {
  return {
    name,
    async check() {
      throw new Error("connection refused");
    },
  };
}

describe("GET /api/system/dependencies handler", () => {
  it("returns all healthy when every checker is healthy", async () => {
    const handler = getSystemDependencies({
      checkers: [
        fakeChecker("nats", "healthy", 2),
        fakeChecker("postgres", "healthy", 10),
        fakeChecker("redis", "healthy", 1),
      ],
    });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(body.overall).toBe("healthy");
    expect(body.dependencies).toHaveLength(3);
    expect(body.dependencies[0].name).toBe("nats");
    expect(body.dependencies[0].status).toBe("healthy");
    expect(body.dependencies[0].latency_ms).toBe(2);
    expect(body.dependencies[0].last_checked_at).toBeDefined();
  });

  it("returns degraded overall when one dependency is degraded", async () => {
    const handler = getSystemDependencies({
      checkers: [
        fakeChecker("nats", "healthy", 2),
        fakeChecker("postgres", "degraded", 1500),
        fakeChecker("redis", "healthy", 1),
      ],
    });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    expect(getBody().overall).toBe("degraded");
  });

  it("returns degraded overall when one dependency is down", async () => {
    const handler = getSystemDependencies({
      checkers: [
        fakeChecker("nats", "healthy", 2),
        fakeChecker("postgres", "healthy", 10),
        fakeChecker("redis", "down", null),
      ],
    });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    expect(getBody().overall).toBe("degraded");
  });

  it("marks checker as down when it throws", async () => {
    const handler = getSystemDependencies({
      checkers: [
        fakeChecker("nats", "healthy", 2),
        failingChecker("postgres"),
        fakeChecker("redis", "healthy", 1),
      ],
    });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const pg = getBody().dependencies.find((d: any) => d.name === "postgres");
    expect(pg.status).toBe("down");
    expect(pg.latency_ms).toBeNull();
    expect(getBody().overall).toBe("degraded");
  });

  it("returns all down when every checker fails", async () => {
    const handler = getSystemDependencies({
      checkers: [
        failingChecker("nats"),
        failingChecker("postgres"),
        failingChecker("redis"),
      ],
    });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    expect(getBody().overall).toBe("degraded");
    getBody().dependencies.forEach((d: any) => {
      expect(d.status).toBe("down");
    });
  });

  it("returns empty dependencies with no checkers", async () => {
    const handler = getSystemDependencies({ checkers: [] });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    expect(getBody().overall).toBe("healthy");
    expect(getBody().dependencies).toEqual([]);
  });

  it("includes all required fields per dependency", async () => {
    const handler = getSystemDependencies({
      checkers: [fakeChecker("nats", "healthy", 3)],
    });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const dep = getBody().dependencies[0];
    expect(dep).toHaveProperty("name");
    expect(dep).toHaveProperty("status");
    expect(dep).toHaveProperty("latency_ms");
    expect(dep).toHaveProperty("last_checked_at");
  });
});

describe("makeNatsChecker", () => {
  it("returns healthy when connection is open and flush succeeds", async () => {
    const checker = makeNatsChecker(async () => ({
      isClosed: () => false,
      flush: async () => {},
    }));
    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns down when connection is closed", async () => {
    const checker = makeNatsChecker(async () => ({
      isClosed: () => true,
      flush: async () => {},
    }));
    const result = await checker.check();
    expect(result.status).toBe("down");
  });

  it("returns down when getNatsConn throws", async () => {
    const checker = makeNatsChecker(async () => {
      throw new Error("no connection");
    });
    const result = await checker.check();
    expect(result.status).toBe("down");
  });
});

describe("makePostgresChecker", () => {
  it("returns healthy when query succeeds fast", async () => {
    const checker = makePostgresChecker(async () => [{ "?column?": 1 }]);
    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns down when query throws", async () => {
    const checker = makePostgresChecker(async () => {
      throw new Error("connection refused");
    });
    const result = await checker.check();
    expect(result.status).toBe("down");
  });
});

describe("makeRedisChecker", () => {
  it("returns down when no pingFn provided", async () => {
    const checker = makeRedisChecker();
    const result = await checker.check();
    expect(result.status).toBe("down");
    expect(result.latency_ms).toBeNull();
  });

  it("returns healthy when ping succeeds", async () => {
    const checker = makeRedisChecker(async () => "PONG");
    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns down when ping throws", async () => {
    const checker = makeRedisChecker(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await checker.check();
    expect(result.status).toBe("down");
  });
});

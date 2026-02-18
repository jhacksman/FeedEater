import { describe, it, expect } from "vitest";
import { getHealthCheck } from "../healthCheck.js";
import { ModuleHealthStore } from "../moduleHealth.js";

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res as any;
}

function makeNatsConn(closed: boolean) {
  return async () => ({ isClosed: () => closed }) as any;
}

function makeFailingNatsConn() {
  return async () => { throw new Error("NATS unreachable"); };
}

describe("GET /api/health", () => {
  it("returns 200 with correct shape when healthy", async () => {
    const store = new ModuleHealthStore();
    store.recordMessage("binance");

    const handler = getHealthCheck({
      getNatsConn: makeNatsConn(false),
      moduleHealthStore: store,
      startedAt: Date.now() - 5000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.0.0");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.checks.nats).toBe("ok");
    expect(body.checks.modules).toEqual({ total: 1, running: 1, stopped: 0 });
  });

  it("returns 503 when NATS is down", async () => {
    const store = new ModuleHealthStore();
    store.recordMessage("binance");

    const handler = getHealthCheck({
      getNatsConn: makeNatsConn(true),
      moduleHealthStore: store,
      startedAt: Date.now() - 1000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    const body = res.body as any;
    expect(body.status).toBe("error");
    expect(body.checks.nats).toBe("error");
  });

  it("returns 503 when NATS connection throws", async () => {
    const store = new ModuleHealthStore();
    store.recordMessage("binance");

    const handler = getHealthCheck({
      getNatsConn: makeFailingNatsConn(),
      moduleHealthStore: store,
      startedAt: Date.now() - 1000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    const body = res.body as any;
    expect(body.status).toBe("error");
    expect(body.checks.nats).toBe("error");
  });

  it("has correct response shape", async () => {
    const store = new ModuleHealthStore();
    const handler = getHealthCheck({
      getNatsConn: makeNatsConn(false),
      moduleHealthStore: store,
      startedAt: Date.now() - 2000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    const body = res.body as any;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("nats");
    expect(body.checks).toHaveProperty("modules");
    expect(body.checks.modules).toHaveProperty("total");
    expect(body.checks.modules).toHaveProperty("running");
    expect(body.checks.modules).toHaveProperty("stopped");
  });

  it("uptime is greater than 0", async () => {
    const store = new ModuleHealthStore();
    const handler = getHealthCheck({
      getNatsConn: makeNatsConn(false),
      moduleHealthStore: store,
      startedAt: Date.now() - 3000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    const body = res.body as any;
    expect(body.uptime).toBeGreaterThan(0);
  });

  it("counts running and stopped modules correctly", async () => {
    const store = new ModuleHealthStore();
    store.recordMessage("binance");
    store.recordMessage("coinbase");

    const handler = getHealthCheck({
      getNatsConn: makeNatsConn(false),
      moduleHealthStore: store,
      startedAt: Date.now() - 1000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    const body = res.body as any;
    expect(body.checks.modules.total).toBe(2);
    expect(body.checks.modules.running).toBe(2);
    expect(body.checks.modules.stopped).toBe(0);
  });

  it("returns 200 with zero modules (no modules registered yet)", async () => {
    const store = new ModuleHealthStore();
    const handler = getHealthCheck({
      getNatsConn: makeNatsConn(false),
      moduleHealthStore: store,
      startedAt: Date.now() - 1000,
    });

    const req = {} as any;
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.status).toBe("ok");
    expect(body.checks.modules.total).toBe(0);
  });
});

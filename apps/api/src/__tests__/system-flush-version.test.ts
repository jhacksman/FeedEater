import { describe, it, expect, beforeEach } from "vitest";
import { postSystemFlush } from "../systemFlush.js";
import { getSystemVersion } from "../systemVersion.js";

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

function makeMockMetricsStore() {
  const resetErrorsCalls: string[] = [];
  const resetThroughputCalls: string[] = [];
  return {
    resetErrors(name: string) { resetErrorsCalls.push(name); },
    resetThroughput(name: string) { resetThroughputCalls.push(name); },
    resetErrorsCalls,
    resetThroughputCalls,
  } as any;
}

function makeMockReconnectStore() {
  const resetModuleCalls: string[] = [];
  return {
    resetModule(name: string) { resetModuleCalls.push(name); },
    resetModuleCalls,
  } as any;
}

describe("POST /api/system/flush", () => {
  let metricsStore: ReturnType<typeof makeMockMetricsStore>;
  let reconnectStore: ReturnType<typeof makeMockReconnectStore>;

  beforeEach(() => {
    metricsStore = makeMockMetricsStore();
    reconnectStore = makeMockReconnectStore();
  });

  it("returns success: true", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().success).toBe(true);
  });

  it("returns flushed_modules as array", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(Array.isArray(getBody().flushed_modules)).toBe(true);
    expect(getBody().flushed_modules.length).toBeGreaterThan(0);
  });

  it("returns count matching flushed_modules length", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().count).toBe(getBody().flushed_modules.length);
  });

  it("returns flushed_at as ISO timestamp", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const d = new Date(getBody().flushed_at);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it("uses nowFn override when provided", () => {
    const fixedTime = new Date("2026-03-01T00:00:00Z").getTime();
    const handler = postSystemFlush({ metricsStore, reconnectStore, nowFn: () => fixedTime });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().flushed_at).toBe("2026-03-01T00:00:00.000Z");
  });

  it("calls resetErrors for every known module", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const modules = getBody().flushed_modules as string[];
    for (const mod of modules) {
      expect(metricsStore.resetErrorsCalls).toContain(mod);
    }
  });

  it("calls resetThroughput for every known module", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const modules = getBody().flushed_modules as string[];
    for (const mod of modules) {
      expect(metricsStore.resetThroughputCalls).toContain(mod);
    }
  });

  it("calls reconnectStore.resetModule for every known module", () => {
    const handler = postSystemFlush({ metricsStore, reconnectStore });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const modules = getBody().flushed_modules as string[];
    for (const mod of modules) {
      expect(reconnectStore.resetModuleCalls).toContain(mod);
    }
  });

  it("calls clear on extra stores when provided", () => {
    let cleared = false;
    const extraStore = { clear() { cleared = true; } };
    const handler = postSystemFlush({ metricsStore, reconnectStore, extraStores: [extraStore] });
    const { res } = makeRes();
    handler(makeReq(), res);
    expect(cleared).toBe(true);
  });
});

describe("GET /api/system/version", () => {
  const startedAt = Date.now() - 60_000;

  it("returns all expected fields", () => {
    const handler = getSystemVersion({ startedAt });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("build_time");
    expect(body).toHaveProperty("git_sha");
    expect(body).toHaveProperty("node_version");
    expect(body).toHaveProperty("uptime_seconds");
  });

  it("returns node_version matching process.version", () => {
    const handler = getSystemVersion({ startedAt });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().node_version).toBe(process.version);
  });

  it("returns uptime_seconds as positive number", () => {
    const handler = getSystemVersion({ startedAt });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().uptime_seconds).toBeGreaterThan(0);
  });

  it("uses versionOverride when provided", () => {
    const handler = getSystemVersion({ startedAt, versionOverride: "2.5.0" });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().version).toBe("2.5.0");
  });

  it("returns build_time when provided", () => {
    const handler = getSystemVersion({ startedAt, buildTime: "2026-02-15T12:00:00Z" });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().build_time).toBe("2026-02-15T12:00:00Z");
  });

  it("returns git_sha when provided", () => {
    const handler = getSystemVersion({ startedAt, gitSha: "abc1234" });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().git_sha).toBe("abc1234");
  });

  it("returns null for build_time and git_sha when not provided", () => {
    const handler = getSystemVersion({ startedAt });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().build_time).toBeNull();
    expect(getBody().git_sha).toBeNull();
  });
});

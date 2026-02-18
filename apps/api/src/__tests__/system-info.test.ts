import { describe, it, expect } from "vitest";
import { getSystemInfo } from "../systemInfo.js";

function makeReq() {
  return {} as any;
}

function makeRes() {
  let body: any;
  const res = {
    json(data: any) { body = data; },
  } as any;
  return { res, getBody: () => body };
}

const STARTED_AT = Date.now() - 60_000;

describe("GET /api/system/info", () => {
  const handler = getSystemInfo({ startedAt: STARTED_AT, versionOverride: "0.0.1" });

  it("returns correct response shape", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("node_version");
    expect(body).toHaveProperty("platform");
    expect(body).toHaveProperty("arch");
    expect(body).toHaveProperty("pid");
    expect(body).toHaveProperty("uptime_seconds");
    expect(body).toHaveProperty("started_at");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("memory");
  });

  it("node_version starts with v", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().node_version).toMatch(/^v\d+/);
  });

  it("platform is a non-empty string", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(typeof getBody().platform).toBe("string");
    expect(getBody().platform.length).toBeGreaterThan(0);
  });

  it("arch is a non-empty string", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(typeof getBody().arch).toBe("string");
    expect(getBody().arch.length).toBeGreaterThan(0);
  });

  it("pid is a positive integer", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(Number.isInteger(getBody().pid)).toBe(true);
    expect(getBody().pid).toBeGreaterThan(0);
  });

  it("uptime_seconds is a non-negative number", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it("started_at is a valid ISO timestamp", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const d = new Date(getBody().started_at);
    expect(d.toISOString()).toBe(getBody().started_at);
  });

  it("version matches override", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().version).toBe("0.0.1");
  });

  it("memory has rss_mb, heap_used_mb, heap_total_mb", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const mem = getBody().memory;
    expect(mem).toHaveProperty("rss_mb");
    expect(mem).toHaveProperty("heap_used_mb");
    expect(mem).toHaveProperty("heap_total_mb");
  });

  it("memory values are positive numbers", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const mem = getBody().memory;
    expect(mem.rss_mb).toBeGreaterThan(0);
    expect(mem.heap_used_mb).toBeGreaterThan(0);
    expect(mem.heap_total_mb).toBeGreaterThan(0);
  });

  it("heap_used_mb <= heap_total_mb", () => {
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const mem = getBody().memory;
    expect(mem.heap_used_mb).toBeLessThanOrEqual(mem.heap_total_mb);
  });

  it("uptime_seconds reflects startedAt offset", () => {
    const recentStart = Date.now() - 5000;
    const h = getSystemInfo({ startedAt: recentStart, versionOverride: "0.0.1" });
    const { res, getBody } = makeRes();
    h(makeReq(), res);
    expect(getBody().uptime_seconds).toBeGreaterThanOrEqual(4);
    expect(getBody().uptime_seconds).toBeLessThan(30);
  });
});

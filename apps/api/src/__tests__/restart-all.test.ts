import { describe, it, expect, vi, beforeEach } from "vitest";
import { postRestartAll } from "../restartAll.js";

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { if (statusCode === 200 && !body) { body = data; } else { body = data; } },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

function makeReq(auth?: string) {
  return { headers: { authorization: auth } } as any;
}

describe("POST /api/modules/restart-all", () => {
  let publishFn: ReturnType<typeof vi.fn>;
  let getNatsConn: () => Promise<any>;
  let sc: any;
  let disabledModules: Set<string>;

  beforeEach(() => {
    publishFn = vi.fn();
    getNatsConn = async () => ({ publish: publishFn });
    sc = { encode: (s: string) => Buffer.from(s) };
    disabledModules = new Set();
  });

  it("restarts all 10 modules when none are disabled", async () => {
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(body.restarted).toHaveLength(10);
    expect(body.failed).toHaveLength(0);
    expect(body.total).toBe(10);
  });

  it("publishes NATS restart message for each enabled module", async () => {
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(publishFn).toHaveBeenCalledTimes(10);
    for (const call of publishFn.mock.calls) {
      expect(call[0]).toMatch(/^feedeater\.control\.restart\./);
    }
  });

  it("skips disabled modules", async () => {
    disabledModules.add("binance");
    disabledModules.add("coinbase");
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(body.restarted).toHaveLength(8);
    expect(body.restarted).not.toContain("binance");
    expect(body.restarted).not.toContain("coinbase");
    expect(body.total).toBe(8);
  });

  it("returns empty arrays when all modules are disabled", async () => {
    const allModules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    for (const m of allModules) disabledModules.add(m);
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ restarted: [], failed: [], total: 0 });
  });

  it("returns 500 with partial results on NATS failure", async () => {
    let callCount = 0;
    const failingPublish = vi.fn(() => {
      callCount++;
      if (callCount === 3) throw new Error("NATS connection lost");
    });
    getNatsConn = async () => ({ publish: failingPublish });

    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(getStatus()).toBe(500);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].reason).toBe("NATS connection lost");
    expect(body.restarted.length + body.failed.length).toBe(body.total);
  });

  it("includes failure reason in failed array", async () => {
    getNatsConn = async () => { throw new Error("Connection refused"); };
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(body.failed.length).toBeGreaterThan(0);
    for (const f of body.failed) {
      expect(f).toHaveProperty("name");
      expect(f).toHaveProperty("reason");
      expect(f.reason).toBe("Connection refused");
    }
  });

  it("all fail returns 500 with all in failed array", async () => {
    getNatsConn = async () => { throw new Error("NATS down"); };
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(), res);
    expect(getStatus()).toBe(500);
    const body = getBody();
    expect(body.restarted).toHaveLength(0);
    expect(body.failed).toHaveLength(10);
    expect(body.total).toBe(10);
  });

  it("returns 200 when all succeed", async () => {
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getStatus } = makeRes();
    await handler(makeReq(), res);
    expect(getStatus()).toBe(200);
  });

  it("response shape has restarted, failed, and total", async () => {
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("restarted");
    expect(body).toHaveProperty("failed");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.restarted)).toBe(true);
    expect(Array.isArray(body.failed)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("restarted array contains only strings", async () => {
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    for (const name of getBody().restarted) {
      expect(typeof name).toBe("string");
    }
  });

  it("failed array items have name and reason strings", async () => {
    getNatsConn = async () => { throw new Error("timeout"); };
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    for (const f of getBody().failed) {
      expect(typeof f.name).toBe("string");
      expect(typeof f.reason).toBe("string");
    }
  });

  it("total equals restarted + failed count", async () => {
    let callCount = 0;
    const sometimesFail = vi.fn(() => {
      callCount++;
      if (callCount % 4 === 0) throw new Error("intermittent");
    });
    getNatsConn = async () => ({ publish: sometimesFail });

    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res, getBody } = makeRes();
    await handler(makeReq(), res);
    const body = getBody();
    expect(body.total).toBe(body.restarted.length + body.failed.length);
  });

  it("publishes correct NATS subject per module", async () => {
    disabledModules = new Set(["coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"]);
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(publishFn.mock.calls[0][0]).toBe("feedeater.control.restart.binance");
  });

  it("payload includes requestedBy from auth header", async () => {
    disabledModules = new Set(["coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"]);
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res } = makeRes();
    await handler(makeReq("Bearer test-key"), res);
    const encoded = publishFn.mock.calls[0][1];
    const payload = JSON.parse(Buffer.from(encoded).toString());
    expect(payload.requestedBy).toBe("api-key-user");
    expect(payload.module).toBe("binance");
    expect(payload.timestamp).toBeDefined();
  });

  it("payload uses anonymous when no auth header", async () => {
    disabledModules = new Set(["coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"]);
    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res } = makeRes();
    await handler(makeReq(), res);
    const encoded = publishFn.mock.calls[0][1];
    const payload = JSON.parse(Buffer.from(encoded).toString());
    expect(payload.requestedBy).toBe("anonymous");
  });

  it("restarts sequentially, not in parallel", async () => {
    const order: string[] = [];
    const seqPublish = vi.fn(async (subject: string) => {
      order.push(subject);
    });
    getNatsConn = async () => ({ publish: seqPublish });

    const handler = postRestartAll({ getNatsConn, sc, disabledModules });
    const { res } = makeRes();
    await handler(makeReq(), res);
    expect(order).toHaveLength(10);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).not.toBe(order[i - 1]);
    }
  });
});

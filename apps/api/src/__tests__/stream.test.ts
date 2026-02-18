import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getStream } from "../stream.js";
import type { Codec } from "nats";

const CEX_MODULES = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx"];

function makeRes() {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    status: (code: number) => { statusCode = code; return res; },
    setHeader: (k: string, v: string) => { headers[k] = v; },
    flushHeaders: vi.fn(),
    write: (data: string) => { chunks.push(data); return true; },
    end: vi.fn(),
    json: vi.fn((data: any) => { chunks.push(JSON.stringify(data)); }),
    on: vi.fn(),
  } as any;
  return { res, statusCode: () => statusCode, headers, chunks };
}

function makeReq(query: Record<string, string> = {}) {
  const closeHandlers: Array<() => void> = [];
  const req = {
    query,
    on: (event: string, handler: () => void) => {
      if (event === "close") closeHandlers.push(handler);
    },
  } as any;
  return { req, triggerClose: () => closeHandlers.forEach((h) => h()) };
}

function makeSc(): Codec<string> {
  return {
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (d: Uint8Array) => new TextDecoder().decode(d),
  } as Codec<string>;
}

interface MockSub {
  messages: Array<{ subject: string; data: Uint8Array }>;
  unsubscribed: boolean;
  resolve: (() => void) | null;
  push(subject: string, data: unknown): void;
  done(): void;
}

function makeMockNats() {
  const subs: MockSub[] = [];
  let subscribedSubject = "";

  const nc = {
    subscribe: (subject: string) => {
      subscribedSubject = subject;
      const sub: MockSub = {
        messages: [],
        unsubscribed: false,
        resolve: null,
        push(subject: string, data: unknown) {
          this.messages.push({
            subject,
            data: new TextEncoder().encode(JSON.stringify(data)),
          });
          if (this.resolve) this.resolve();
        },
        done() {
          this.unsubscribed = true;
          if (this.resolve) this.resolve();
        },
        unsubscribe() {
          this.unsubscribed = true;
        },
        [Symbol.asyncIterator]() {
          const self = this;
          let idx = 0;
          return {
            async next() {
              while (idx >= self.messages.length && !self.unsubscribed) {
                await new Promise<void>((r) => { self.resolve = r; });
              }
              if (self.unsubscribed && idx >= self.messages.length) {
                return { done: true as const, value: undefined };
              }
              return { done: false as const, value: self.messages[idx++] };
            },
          };
        },
      };
      subs.push(sub);
      return sub;
    },
    isClosed: () => false,
  } as any;

  return { nc, subs, getSubject: () => subscribedSubject };
}

describe("GET /api/stream — SSE trade stream", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sets correct SSE headers", async () => {
    const { nc, subs } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req } = makeReq();
    const { res, statusCode, headers } = makeRes();

    const p = handler(req, res);
    await vi.advanceTimersByTimeAsync(0);
    subs[0]?.done();
    await p;

    expect(statusCode()).toBe(200);
    expect(headers["Content-Type"]).toBe("text/event-stream");
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(headers["Connection"]).toBe("keep-alive");
  });

  it("streams trade events in SSE format", async () => {
    const { nc, subs } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req, triggerClose } = makeReq({ module: "binance" });
    const { res, chunks } = makeRes();

    const p = handler(req, res);
    await vi.advanceTimersByTimeAsync(0);

    subs[0]?.push("feedeater.binance.tradeExecuted", { price: "100" });
    await vi.advanceTimersByTimeAsync(0);

    triggerClose();
    subs[0]?.done();
    await p;

    const joined = chunks.join("");
    expect(joined).toContain("event: trade\n");
    expect(joined).toContain("data: ");
    expect(joined).toContain('"feedeater.binance.tradeExecuted"');
    expect(joined).toContain('"price":"100"');
  });

  it("sends heartbeat every 30 seconds", async () => {
    const { nc, subs } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req, triggerClose } = makeReq();
    const { res, chunks } = makeRes();

    const p = handler(req, res);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    triggerClose();
    subs[0]?.done();
    await p;

    const heartbeats = chunks.filter((c) => c.includes(": keepalive\n"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
  });

  it("cleans up NATS subscription on client disconnect", async () => {
    const { nc, subs } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req, triggerClose } = makeReq({ module: "bybit" });
    const { res } = makeRes();

    const p = handler(req, res);
    await vi.advanceTimersByTimeAsync(0);

    triggerClose();
    subs[0]?.done();
    await p;

    expect(subs[0]?.unsubscribed).toBe(true);
  });

  it("subscribes to specific module subject when module param provided", async () => {
    const { nc, subs, getSubject } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req, triggerClose } = makeReq({ module: "coinbase" });
    const { res } = makeRes();

    const p = handler(req, res);
    await vi.advanceTimersByTimeAsync(0);

    expect(getSubject()).toBe("feedeater.coinbase.tradeExecuted");

    triggerClose();
    subs[0]?.done();
    await p;
  });

  it("subscribes to wildcard subject when no module param", async () => {
    const { nc, subs, getSubject } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req, triggerClose } = makeReq();
    const { res } = makeRes();

    const p = handler(req, res);
    await vi.advanceTimersByTimeAsync(0);

    expect(getSubject()).toBe("feedeater.*.tradeExecuted");

    triggerClose();
    subs[0]?.done();
    await p;
  });

  it("returns 400 for unknown module", async () => {
    const { nc } = makeMockNats();
    const handler = getStream({
      getNatsConn: () => Promise.resolve(nc),
      sc: makeSc(),
    });
    const { req } = makeReq({ module: "unknown_exchange" });
    const { res, statusCode } = makeRes();

    await handler(req, res);

    expect(statusCode()).toBe(400);
    expect(res.json).toHaveBeenCalled();
  });
});

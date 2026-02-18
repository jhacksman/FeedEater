import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeMocks() {
  const logs: string[] = [];
  const sc = { encode: (s: string) => new TextEncoder().encode(s) };
  const nats = {
    publish: vi.fn().mockImplementation((_subj: string, data: Uint8Array) => {
      try { logs.push(new TextDecoder().decode(data)); } catch {}
    }),
  };
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  const settings = {
    enabled: true,
    apiUrl: "wss://127.0.0.1:9999",
    restApiUrl: "https://127.0.0.1:9999",
    whaleThreshold: 50000,
    watchedPairs: '["BTC-USDT"]',
    candleIntervalSeconds: 60,
    contextPrompt: "",
    contextPromptFallback: "",
  };
  const opts = { apiBaseUrl: "http://localhost:3000", internalToken: "test", contextTopK: 5, embedDim: 4096 };
  return { logs, sc, nats, db, settings, opts };
}

describe("OKX WebSocket Reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should have reconnect properties initialized", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, opts } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);
    expect(ingestor["reconnectAttempts"]).toBe(0);
    expect(ingestor["reconnectDelay"]).toBe(1000);
    expect(ingestor["maxReconnectDelay"]).toBe(30000);
    expect(ingestor["ws"]).toBeNull();
  });

  it("should cap reconnect attempts at 10", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, opts, logs } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);

    ingestor["isRunning"] = true;
    ingestor["reconnectAttempts"] = 10;
    ingestor["scheduleReconnect"]();

    const hasExhausted = logs.some((l) => l.includes("exhausted"));
    expect(hasExhausted).toBe(true);
  });

  it("should not reconnect when isRunning is false", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, opts, logs } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);

    ingestor["isRunning"] = false;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]();

    const hasReconnectLog = logs.some((l) => l.includes("reconnecting"));
    expect(hasReconnectLog).toBe(false);
  });

  it("should increment reconnectAttempts on each scheduleReconnect call", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, opts } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);

    ingestor["isRunning"] = true;
    ingestor["reconnectAttempts"] = 0;

    ingestor["scheduleReconnect"]();
    expect(ingestor["reconnectAttempts"]).toBe(1);

    ingestor["scheduleReconnect"]();
    expect(ingestor["reconnectAttempts"]).toBe(2);
  });

  it("should log at warn level during reconnection", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, opts, logs } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);

    ingestor["isRunning"] = true;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]();

    const warnLogs = logs.filter((l) => l.includes('"level":"warn"'));
    expect(warnLogs.length).toBeGreaterThan(0);
    expect(warnLogs.some((l) => l.includes("reconnecting in 1000ms"))).toBe(true);
  });

  it("should use exponential backoff delay for reconnection", async () => {
    const mod = await import("../ingest.js");
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { settings, db, nats, sc, opts } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);

    ingestor["isRunning"] = true;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]();

    const calls = setTimeoutSpy.mock.calls;
    const reconnectCall = calls.find((c) => c[1] === 1000);
    expect(reconnectCall).toBeDefined();

    setTimeoutSpy.mockRestore();
  });

  it("should emit reconnecting event via NATS", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, opts, logs } = makeMocks();
    const ingestor = new (mod as any).OkxIngestor(settings, db, nats, sc, opts);

    ingestor["isRunning"] = true;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]();

    const reconnectingEvent = logs.some((l) => l.includes('"module":"okx"') && l.includes('"attempt":1'));
    expect(reconnectingEvent).toBe(true);
  });
});

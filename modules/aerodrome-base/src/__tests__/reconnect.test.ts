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
    rpcUrl: "ws://127.0.0.1:9999",
    watchedPools: "[]",
    whaleThreshold: 50000,
  };
  return { logs, sc, nats, db, settings };
}

describe("Aerodrome Base WebSocket Reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should have reconnect properties initialized", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc } = makeMocks();
    const ingestor = new (mod as any).AerodromeBaseIngestor(settings, db, nats, sc);
    expect(ingestor["reconnectAttempts"]).toBe(0);
    expect(ingestor["activeProvider"]).toBeNull();
    expect(ingestor["healthCheckTimer"]).toBeNull();
  });

  it("should cap reconnect attempts at 10", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, logs } = makeMocks();
    const ingestor = new (mod as any).AerodromeBaseIngestor(settings, db, nats, sc);

    ingestor["isStreaming"] = true;
    ingestor["reconnectAttempts"] = 10;
    ingestor["scheduleReconnect"]([]);

    const hasExhausted = logs.some((l) => l.includes("exhausted"));
    expect(hasExhausted).toBe(true);
  });

  it("should not reconnect when isStreaming is false", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, logs } = makeMocks();
    const ingestor = new (mod as any).AerodromeBaseIngestor(settings, db, nats, sc);

    ingestor["isStreaming"] = false;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]([]);

    const hasReconnectLog = logs.some((l) => l.includes("reconnecting"));
    expect(hasReconnectLog).toBe(false);
  });

  it("should increment reconnectAttempts on each scheduleReconnect call", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc } = makeMocks();
    const ingestor = new (mod as any).AerodromeBaseIngestor(settings, db, nats, sc);

    ingestor["isStreaming"] = true;
    ingestor["reconnectAttempts"] = 0;

    ingestor["scheduleReconnect"]([]);
    expect(ingestor["reconnectAttempts"]).toBe(1);

    ingestor["scheduleReconnect"]([]);
    expect(ingestor["reconnectAttempts"]).toBe(2);
  });

  it("should log at warn level during reconnection", async () => {
    const mod = await import("../ingest.js");
    const { settings, db, nats, sc, logs } = makeMocks();
    const ingestor = new (mod as any).AerodromeBaseIngestor(settings, db, nats, sc);

    ingestor["isStreaming"] = true;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]([]);

    const warnLogs = logs.filter((l) => l.includes('"level":"warn"'));
    expect(warnLogs.length).toBeGreaterThan(0);
    expect(warnLogs.some((l) => l.includes("reconnecting in 5000ms"))).toBe(true);
  });

  it("should use 5000ms delay for reconnection", async () => {
    const mod = await import("../ingest.js");
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { settings, db, nats, sc } = makeMocks();
    const ingestor = new (mod as any).AerodromeBaseIngestor(settings, db, nats, sc);

    ingestor["isStreaming"] = true;
    ingestor["reconnectAttempts"] = 0;
    ingestor["scheduleReconnect"]([]);

    const calls = setTimeoutSpy.mock.calls;
    const reconnectCall = calls.find((c) => c[1] === 5000);
    expect(reconnectCall).toBeDefined();

    setTimeoutSpy.mockRestore();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { insertEvent } from "../db.js";

describe("insertEvent", () => {
  let pool: any;
  let queryResults: { rows: { id: number }[] };

  beforeEach(() => {
    queryResults = { rows: [{ id: 1 }] };
    pool = {
      query: vi.fn().mockResolvedValue(queryResults),
    };
  });

  it("inserts subject and JSON-stringified payload", async () => {
    const id = await insertEvent(pool, {
      subject: "feedeater.uniswap-base.messageCreated",
      payload: { price: 1234.56 },
    });

    expect(id).toBe(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO raw_events"),
      ["feedeater.uniswap-base.messageCreated", '{"price":1234.56}']
    );
  });

  it("handles string payload", async () => {
    queryResults.rows = [{ id: 42 }];
    const id = await insertEvent(pool, {
      subject: "feedeater.test.messageCreated",
      payload: { raw: "not json" },
    });

    expect(id).toBe(42);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO raw_events"),
      ["feedeater.test.messageCreated", '{"raw":"not json"}']
    );
  });

  it("propagates query errors", async () => {
    pool.query.mockRejectedValue(new Error("connection refused"));

    await expect(
      insertEvent(pool, { subject: "feedeater.x.y", payload: {} })
    ).rejects.toThrow("connection refused");
  });

  it("handles nested payload objects", async () => {
    const payload = {
      trade: { pair: "ETH/USDC", amount: 1.5 },
      metadata: { source: "uniswap" },
    };

    await insertEvent(pool, {
      subject: "feedeater.uniswap-base.messageCreated",
      payload,
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO raw_events"),
      [
        "feedeater.uniswap-base.messageCreated",
        JSON.stringify(payload),
      ]
    );
  });

  it("handles null payload", async () => {
    await insertEvent(pool, {
      subject: "feedeater.test.ping",
      payload: null,
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO raw_events"),
      ["feedeater.test.ping", "null"]
    );
  });
});

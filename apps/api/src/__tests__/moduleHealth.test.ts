import { describe, it, expect, beforeEach, vi } from "vitest";
import { ModuleHealthStore, getModuleHealth } from "../moduleHealth.js";

describe("ModuleHealthStore", () => {
  let store: ModuleHealthStore;

  beforeEach(() => {
    store = new ModuleHealthStore();
  });

  it("returns empty array when no messages recorded", () => {
    expect(store.getAll()).toEqual([]);
  });

  it("returns 'offline' for unknown module", () => {
    expect(store.getStatus("unknown-module")).toBe("offline");
  });

  it("returns 'healthy' after recording a message", () => {
    store.recordMessage("discord");
    expect(store.getStatus("discord")).toBe("healthy");
  });

  it("increments messageCount on each recordMessage", () => {
    store.recordMessage("slack");
    store.recordMessage("slack");
    store.recordMessage("slack");

    const all = store.getAll();
    const slack = all.find((m) => m.module === "slack");
    expect(slack?.messageCount).toBe(3);
  });

  it("sets lastMessage to an ISO timestamp", () => {
    store.recordMessage("hackernews");
    const all = store.getAll();
    const hn = all.find((m) => m.module === "hackernews");
    expect(hn?.lastMessage).toBeTruthy();
    expect(new Date(hn!.lastMessage!).toISOString()).toBe(hn!.lastMessage);
  });

  it("returns 'stale' when last message is >5 minutes ago", () => {
    store.recordMessage("bluesky");
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    vi.spyOn(store as any, "entries", "get").mockReturnValue(
      new Map([["bluesky", { lastMessage: sixMinutesAgo, messageCount: 1 }]])
    );
    expect(store.getStatus("bluesky")).toBe("stale");
  });

  it("returns 'offline' when last message is >30 minutes ago", () => {
    store.recordMessage("twitch");
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    vi.spyOn(store as any, "entries", "get").mockReturnValue(
      new Map([["twitch", { lastMessage: thirtyOneMinutesAgo, messageCount: 5 }]])
    );
    expect(store.getStatus("twitch")).toBe("offline");
  });

  it("returns modules sorted alphabetically", () => {
    store.recordMessage("twitch");
    store.recordMessage("bluesky");
    store.recordMessage("discord");
    const all = store.getAll();
    expect(all.map((m) => m.module)).toEqual(["bluesky", "discord", "twitch"]);
  });

  it("getAll returns correct shape for each module", () => {
    store.recordMessage("github");
    const all = store.getAll();
    expect(all).toHaveLength(1);
    const entry = all[0]!;
    expect(entry).toHaveProperty("module", "github");
    expect(entry).toHaveProperty("lastMessage");
    expect(entry).toHaveProperty("messageCount", 1);
    expect(entry).toHaveProperty("status", "healthy");
  });

  it("tracks multiple modules independently", () => {
    store.recordMessage("slack");
    store.recordMessage("slack");
    store.recordMessage("discord");

    const all = store.getAll();
    const slack = all.find((m) => m.module === "slack");
    const discord = all.find((m) => m.module === "discord");

    expect(slack?.messageCount).toBe(2);
    expect(discord?.messageCount).toBe(1);
  });
});

describe("GET /api/health/modules", () => {
  it("returns 200 with ok:true and modules array", async () => {
    const store = new ModuleHealthStore();
    store.recordMessage("uniswap-base");
    const handler = getModuleHealth(store);

    const req = {} as any;
    let statusCode = 200;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    await handler(req, res);

    expect(statusCode).toBe(200);
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("modules");
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.modules).toHaveLength(1);
    expect(body.modules[0]).toHaveProperty("module", "uniswap-base");
  });
});

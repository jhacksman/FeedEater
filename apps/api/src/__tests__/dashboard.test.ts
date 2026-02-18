import { describe, it, expect } from "vitest";
import { getDashboard } from "../dashboard.js";

describe("GET /", () => {
  it("returns 200 with Content-Type text/html", () => {
    const req = {} as any;
    const headers: Record<string, string> = {};
    let body = "";
    const res = {
      setHeader: (key: string, value: string) => { headers[key] = value; },
      send: (data: string) => { body = data; },
    } as any;

    getDashboard(req, res);

    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("FeedEater");
    expect(body).toContain("/api/health/modules");
    expect(body).toContain("setInterval");
  });
});

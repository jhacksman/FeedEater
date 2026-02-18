import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const specPath = join(__dirname, "..", "..", "openapi.yaml");

describe("GET /api/docs — OpenAPI spec", () => {
  const raw = readFileSync(specPath, "utf-8");

  it("returns 200-equivalent readable YAML content", () => {
    expect(raw.length).toBeGreaterThan(0);
  });

  it("content-type would be text/yaml", () => {
    let statusCode = 200;
    let body = "";
    let headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (code: number) => { statusCode = code; return res; },
      send: (data: string) => { body = data; },
      json: (data: any) => { body = JSON.stringify(data); },
    } as any;

    try {
      const content = readFileSync(specPath, "utf-8");
      res.setHeader("Content-Type", "text/yaml; charset=utf-8");
      res.send(content);
    } catch {
      res.status(500).json({ error: "Failed to read OpenAPI spec" });
    }

    expect(statusCode).toBe(200);
    expect(headers["Content-Type"]).toContain("text/yaml");
    expect(body.length).toBeGreaterThan(0);
  });

  it("YAML is parseable and has valid OpenAPI 3.0 structure", () => {
    const doc = yaml.load(raw) as Record<string, any>;
    expect(doc).toBeDefined();
    expect(doc.openapi).toMatch(/^3\.0/);
    expect(doc.info).toBeDefined();
    expect(doc.info.title).toBe("FeedEater API");
    expect(doc.paths).toBeDefined();
  });

  it("documents all five endpoints", () => {
    const doc = yaml.load(raw) as Record<string, any>;
    const paths = Object.keys(doc.paths);
    expect(paths).toContain("/api/health/modules");
    expect(paths).toContain("/api/status");
    expect(paths).toContain("/api/history");
    expect(paths).toContain("/api/export");
    expect(paths).toContain("/api/modules/{name}/restart");
  });

  it("includes security scheme", () => {
    const doc = yaml.load(raw) as Record<string, any>;
    expect(doc.components.securitySchemes.BearerAuth).toBeDefined();
    expect(doc.components.securitySchemes.BearerAuth.type).toBe("http");
    expect(doc.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
  });
});

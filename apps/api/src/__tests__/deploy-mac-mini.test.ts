import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { resolve } from "path";

const SCRIPT_PATH = resolve(__dirname, "../../../../scripts/deploy-mac-mini.sh");

describe("deploy-mac-mini.sh", () => {
  it("has correct shebang line", () => {
    const content = readFileSync(SCRIPT_PATH, "utf-8");
    expect(content.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  it("is executable", () => {
    const stat = statSync(SCRIPT_PATH);
    const ownerExecute = (stat.mode & 0o100) !== 0;
    expect(ownerExecute).toBe(true);
  });

  it("contains all required deployment steps", () => {
    const content = readFileSync(SCRIPT_PATH, "utf-8");
    expect(content).toContain("git pull origin main");
    expect(content).toContain("docker compose pull");
    expect(content).toContain("docker compose up -d --remove-orphans");
    expect(content).toContain("sleep 10");
    expect(content).toContain("check-modules.sh\" --live");
  });

  it("exits 1 on module health failure", () => {
    const content = readFileSync(SCRIPT_PATH, "utf-8");
    expect(content).toContain("exit 1");
  });

  it("exits 0 on success", () => {
    const content = readFileSync(SCRIPT_PATH, "utf-8");
    expect(content).toContain("exit 0");
  });
});

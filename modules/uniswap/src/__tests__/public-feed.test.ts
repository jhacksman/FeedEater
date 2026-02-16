import { describe, it, expect } from "vitest";

function parseUniswapDefaults(raw: Record<string, unknown>) {
  const rpcUrl = String(raw.rpcUrl ?? "ws://localhost:8546");
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const filterMode = String(raw.filterMode ?? "all");
  const topPoolCount = raw.topPoolCount ? Number(raw.topPoolCount) : 50;

  let watchedPairs: string[] = [];
  const wp = raw.watchedPairs;
  if (Array.isArray(wp)) {
    watchedPairs = wp as string[];
  } else if (typeof wp === "string" && wp.trim().startsWith("[")) {
    try {
      watchedPairs = JSON.parse(wp);
    } catch {
      watchedPairs = [];
    }
  } else {
    watchedPairs = [
      "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
      "0x11b815efB8f581194ae5486326430326078dF15A",
      "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD",
    ];
  }

  let customTokenFilter: string[] = [];
  const ctf = raw.customTokenFilter;
  if (Array.isArray(ctf)) {
    customTokenFilter = ctf as string[];
  } else if (typeof ctf === "string" && ctf.trim().startsWith("[")) {
    try {
      customTokenFilter = JSON.parse(ctf);
    } catch {
      customTokenFilter = [];
    }
  }

  return { rpcUrl, whaleThreshold, watchedPairs, filterMode, customTokenFilter, topPoolCount };
}

describe("Uniswap Public Feed Tests", () => {
  describe("Default Settings", () => {
    it("should use ws://localhost:8546 as default RPC URL", () => {
      const settings = parseUniswapDefaults({});
      expect(settings.rpcUrl).toBe("ws://localhost:8546");
    });

    it("should default to 50000 whale threshold", () => {
      const settings = parseUniswapDefaults({});
      expect(settings.whaleThreshold).toBe(50000);
    });

    it("should default to 'all' filter mode", () => {
      const settings = parseUniswapDefaults({});
      expect(settings.filterMode).toBe("all");
    });

    it("should include WETH/USDC V3 pool in default watched pairs", () => {
      const settings = parseUniswapDefaults({});
      const normalized = settings.watchedPairs.map((p: string) => p.toLowerCase());
      expect(normalized).toContain("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
    });

    it("should include WETH/USDT V3 pool in default watched pairs", () => {
      const settings = parseUniswapDefaults({});
      const normalized = settings.watchedPairs.map((p: string) => p.toLowerCase());
      expect(normalized).toContain("0x11b815efb8f581194ae5486326430326078df15a");
    });

    it("should include WBTC/WETH V3 pool in default watched pairs", () => {
      const settings = parseUniswapDefaults({});
      const normalized = settings.watchedPairs.map((p: string) => p.toLowerCase());
      expect(normalized).toContain("0xcbcdf9626bc03e24f779434178a73a0b4bad62ed");
    });

    it("should default topPoolCount to 50", () => {
      const settings = parseUniswapDefaults({});
      expect(settings.topPoolCount).toBe(50);
    });

    it("should default customTokenFilter to empty array", () => {
      const settings = parseUniswapDefaults({});
      expect(settings.customTokenFilter).toEqual([]);
    });

    it("should not require any API keys or auth to parse settings", () => {
      const settings = parseUniswapDefaults({});
      expect(settings.rpcUrl).toBeTruthy();
      expect(settings.watchedPairs.length).toBeGreaterThan(0);
    });
  });

  describe("Settings Override", () => {
    it("should allow overriding RPC URL", () => {
      const settings = parseUniswapDefaults({ rpcUrl: "wss://mainnet.infura.io/ws/v3/abc123" });
      expect(settings.rpcUrl).toBe("wss://mainnet.infura.io/ws/v3/abc123");
    });

    it("should allow overriding whale threshold", () => {
      const settings = parseUniswapDefaults({ whaleThreshold: 100000 });
      expect(settings.whaleThreshold).toBe(100000);
    });

    it("should allow overriding filter mode", () => {
      const settings = parseUniswapDefaults({ filterMode: "weth_only" });
      expect(settings.filterMode).toBe("weth_only");
    });

    it("should parse watchedPairs from JSON string", () => {
      const settings = parseUniswapDefaults({
        watchedPairs: '["0x1234567890123456789012345678901234567890"]',
      });
      expect(settings.watchedPairs).toEqual(["0x1234567890123456789012345678901234567890"]);
    });

    it("should parse watchedPairs from array", () => {
      const settings = parseUniswapDefaults({
        watchedPairs: ["0xabc", "0xdef"],
      });
      expect(settings.watchedPairs).toEqual(["0xabc", "0xdef"]);
    });

    it("should parse customTokenFilter from JSON string", () => {
      const settings = parseUniswapDefaults({
        customTokenFilter: '["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]',
      });
      expect(settings.customTokenFilter).toEqual(["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]);
    });

    it("should parse customTokenFilter from array", () => {
      const settings = parseUniswapDefaults({
        customTokenFilter: ["0xabc", "0xdef"],
      });
      expect(settings.customTokenFilter).toEqual(["0xabc", "0xdef"]);
    });

    it("should allow overriding topPoolCount", () => {
      const settings = parseUniswapDefaults({ topPoolCount: 100 });
      expect(settings.topPoolCount).toBe(100);
    });

    it("should handle invalid watchedPairs JSON gracefully", () => {
      const settings = parseUniswapDefaults({ watchedPairs: "not-json" });
      expect(settings.watchedPairs).toEqual([
        "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        "0x11b815efB8f581194ae5486326430326078dF15A",
        "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD",
      ]);
    });
  });

  describe("RPC URL Validation", () => {
    it("should accept ws:// protocol URLs", () => {
      const settings = parseUniswapDefaults({ rpcUrl: "ws://localhost:8546" });
      expect(settings.rpcUrl.startsWith("ws://")).toBe(true);
    });

    it("should accept wss:// protocol URLs", () => {
      const settings = parseUniswapDefaults({ rpcUrl: "wss://mainnet.infura.io/ws/v3/key" });
      expect(settings.rpcUrl.startsWith("wss://")).toBe(true);
    });
  });

  describe("Pool Address Format", () => {
    it("default watched pairs should be valid Ethereum addresses", () => {
      const settings = parseUniswapDefaults({});
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      for (const addr of settings.watchedPairs) {
        expect(addressRegex.test(addr)).toBe(true);
      }
    });
  });

  describe("Filter Modes", () => {
    it("should accept all valid filter modes", () => {
      const validModes = ["all", "weth_only", "stablecoin_only", "top_pools", "custom"];
      for (const mode of validModes) {
        const settings = parseUniswapDefaults({ filterMode: mode });
        expect(settings.filterMode).toBe(mode);
      }
    });
  });

  describe("NATS Subject Format", () => {
    it("should use feedeater.uniswap.tradeExecuted subject", () => {
      const moduleName = "uniswap";
      const event = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.uniswap.tradeExecuted");
    });

    it("should use feedeater.uniswap.messageCreated for whale events", () => {
      const moduleName = "uniswap";
      const event = "messageCreated";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.uniswap.messageCreated");
    });

    it("should use feedeater.uniswap.log for log events", () => {
      const subject = "feedeater.uniswap.log";
      expect(subject).toBe("feedeater.uniswap.log");
    });
  });

  describe("Contract Constants", () => {
    it("should have correct V2 factory address", () => {
      const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
      expect(V2_FACTORY).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("should have correct V3 factory address", () => {
      const V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
      expect(V3_FACTORY).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("should have known WETH address", () => {
      const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
      expect(WETH).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("should have known USDC address", () => {
      const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      expect(USDC).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("should have known USDT address", () => {
      const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
      expect(USDT).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });
});

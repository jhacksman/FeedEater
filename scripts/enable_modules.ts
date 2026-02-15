#!/usr/bin/env npx tsx
/**
 * FeedEater Module Enablement Script
 *
 * Connects to the FeedEater API and enables all financial modules with
 * appropriate settings from environment variables.
 *
 * Usage:
 *   npx tsx scripts/enable_modules.ts
 *   npx tsx scripts/enable_modules.ts --api http://localhost:4000
 *   npx tsx scripts/enable_modules.ts --dry-run
 *
 * Environment variables (all optional — defaults from module.json used if unset):
 *   COINBASE_WS_URL          Coinbase WebSocket API URL
 *   KRAKEN_WS_URL            Kraken WebSocket API URL
 *   BINANCE_WS_URL           Binance WebSocket API URL
 *   KALSHI_API_KEY            Kalshi API key
 *   KALSHI_API_SECRET         Kalshi API secret
 *   ETH_RPC_WS_URL            Ethereum L1 WebSocket RPC (for uniswap)
 *   ARBITRUM_RPC_WS_URL       Arbitrum WebSocket RPC (for arbitrum-dex)
 *   POLYGON_RPC_WS_URL        Polygon WebSocket RPC (for polygon-dex)
 */

const DEFAULT_API_URL = process.env.FEEDEATER_API_URL || "http://localhost:4000";

interface ModuleConfig {
  name: string;
  settings: Record<string, { value: string; isSecret?: boolean }>;
}

const FINANCIAL_MODULES: ModuleConfig[] = [
  {
    name: "coinbase",
    settings: {
      enabled: { value: "true" },
      ...(process.env.COINBASE_WS_URL
        ? { apiUrl: { value: process.env.COINBASE_WS_URL } }
        : {}),
    },
  },
  {
    name: "kraken",
    settings: {
      enabled: { value: "true" },
      ...(process.env.KRAKEN_WS_URL
        ? { apiUrl: { value: process.env.KRAKEN_WS_URL } }
        : {}),
    },
  },
  {
    name: "binance",
    settings: {
      enabled: { value: "true" },
      ...(process.env.BINANCE_WS_URL
        ? { apiUrl: { value: process.env.BINANCE_WS_URL } }
        : {}),
    },
  },
  {
    name: "kalshi",
    settings: {
      enabled: { value: "true" },
      ...(process.env.KALSHI_API_KEY
        ? { apiKey: { value: process.env.KALSHI_API_KEY, isSecret: true } }
        : {}),
      ...(process.env.KALSHI_API_SECRET
        ? { apiSecret: { value: process.env.KALSHI_API_SECRET, isSecret: true } }
        : {}),
    },
  },
  {
    name: "polymarket",
    settings: {
      enabled: { value: "true" },
      collectAllTrades: { value: "true" },
    },
  },
  {
    name: "uniswap",
    settings: {
      enabled: { value: "true" },
      ...(process.env.ETH_RPC_WS_URL
        ? { rpcUrl: { value: process.env.ETH_RPC_WS_URL } }
        : {}),
    },
  },
  {
    name: "arbitrum-dex",
    settings: {
      enabled: { value: "true" },
      ...(process.env.ARBITRUM_RPC_WS_URL
        ? { rpcUrl: { value: process.env.ARBITRUM_RPC_WS_URL } }
        : {}),
    },
  },
  {
    name: "polygon-dex",
    settings: {
      enabled: { value: "true" },
      ...(process.env.POLYGON_RPC_WS_URL
        ? { rpcUrl: { value: process.env.POLYGON_RPC_WS_URL } }
        : {}),
    },
  },
];

function parseArgs(): { apiUrl: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let apiUrl = DEFAULT_API_URL;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api" && args[i + 1]) {
      apiUrl = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
FeedEater Module Enablement Script

Usage:
  npx tsx scripts/enable_modules.ts [options]

Options:
  --api <url>    FeedEater API URL (default: http://localhost:4000)
  --dry-run      Show what would be configured without making changes
  --help, -h     Show this help message

Environment variables:
  FEEDEATER_API_URL      API base URL (alternative to --api)
  COINBASE_WS_URL        Coinbase WebSocket URL
  KRAKEN_WS_URL          Kraken WebSocket URL
  BINANCE_WS_URL         Binance WebSocket URL
  KALSHI_API_KEY         Kalshi API key (stored as secret)
  KALSHI_API_SECRET      Kalshi API secret (stored as secret)
  ETH_RPC_WS_URL         Ethereum L1 WebSocket RPC (uniswap)
  ARBITRUM_RPC_WS_URL    Arbitrum WebSocket RPC (arbitrum-dex)
  POLYGON_RPC_WS_URL     Polygon WebSocket RPC (polygon-dex)
`);
      process.exit(0);
    }
  }

  return { apiUrl, dryRun };
}

async function checkApiHealth(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function getModules(apiUrl: string): Promise<Array<{ name: string }>> {
  const res = await fetch(`${apiUrl}/api/modules`);
  if (!res.ok) throw new Error(`GET /api/modules failed: ${res.status}`);
  const body = (await res.json()) as { modules: Array<{ name: string }> };
  return body.modules;
}

async function putSetting(
  apiUrl: string,
  moduleName: string,
  key: string,
  value: string,
  isSecret: boolean
): Promise<void> {
  const res = await fetch(`${apiUrl}/api/settings/${moduleName}/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, isSecret }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT /api/settings/${moduleName}/${key} failed (${res.status}): ${text}`);
  }
}

async function getSettings(
  apiUrl: string,
  moduleName: string
): Promise<Array<{ key: string; isSecret: boolean; value: string | null }>> {
  const res = await fetch(`${apiUrl}/api/settings/${moduleName}`);
  if (!res.ok) throw new Error(`GET /api/settings/${moduleName} failed: ${res.status}`);
  const body = (await res.json()) as {
    settings: Array<{ key: string; isSecret: boolean; value: string | null }>;
  };
  return body.settings;
}

const COL = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

async function main(): Promise<void> {
  const { apiUrl, dryRun } = parseArgs();

  console.log("");
  console.log(`${COL.bold}=== FeedEater Module Enablement ===${COL.reset}`);
  console.log(`API:      ${apiUrl}`);
  console.log(`Dry run:  ${dryRun}`);
  console.log("");

  if (!dryRun) {
    console.log("Checking API health...");
    const healthy = await checkApiHealth(apiUrl);
    if (!healthy) {
      console.error(`${COL.red}API is not reachable at ${apiUrl}${COL.reset}`);
      console.error("Start FeedEater first: make up");
      process.exitCode = 1;
      return;
    }
    console.log(`${COL.green}API healthy${COL.reset}`);
    console.log("");

    console.log("Discovering registered modules...");
    const registeredModules = await getModules(apiUrl);
    const registeredNames = new Set(registeredModules.map((m) => m.name));
    console.log(`Found ${registeredModules.length} modules: ${registeredModules.map((m) => m.name).join(", ")}`);
    console.log("");

    for (const mod of FINANCIAL_MODULES) {
      if (!registeredNames.has(mod.name)) {
        console.log(
          `${COL.yellow}SKIP${COL.reset} ${mod.name} — not registered in API (module may not be installed)`
        );
        continue;
      }

      console.log(`${COL.bold}${mod.name}${COL.reset}`);

      for (const [key, setting] of Object.entries(mod.settings)) {
        try {
          await putSetting(apiUrl, mod.name, key, setting.value, setting.isSecret ?? false);
          const display = setting.isSecret ? "****" : setting.value;
          console.log(`  ${COL.green}SET${COL.reset} ${key} = ${display}`);
        } catch (err) {
          console.log(
            `  ${COL.red}ERR${COL.reset} ${key}: ${err instanceof Error ? err.message : err}`
          );
        }
      }

      const currentSettings = await getSettings(apiUrl, mod.name);
      const enabledSetting = currentSettings.find((s) => s.key === "enabled");
      const isEnabled = enabledSetting?.value === "true";
      console.log(
        `  Status: ${isEnabled ? `${COL.green}enabled${COL.reset}` : `${COL.red}not enabled${COL.reset}`}`
      );
      console.log("");
    }
  } else {
    console.log(`${COL.yellow}DRY RUN — no API calls will be made${COL.reset}`);
    console.log("");

    for (const mod of FINANCIAL_MODULES) {
      console.log(`${COL.bold}${mod.name}${COL.reset}`);
      for (const [key, setting] of Object.entries(mod.settings)) {
        const display = setting.isSecret ? "****" : setting.value;
        console.log(`  ${COL.dim}SET${COL.reset} ${key} = ${display}`);
      }
      console.log("");
    }
  }

  console.log("---");
  console.log(
    `${COL.bold}Configured ${FINANCIAL_MODULES.length} modules${COL.reset}`
  );
  if (dryRun) {
    console.log(`${COL.yellow}(dry run — re-run without --dry-run to apply)${COL.reset}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});

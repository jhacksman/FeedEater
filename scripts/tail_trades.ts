#!/usr/bin/env npx tsx
/**
 * FeedEater Trade Event Tail
 *
 * Connects to NATS and subscribes to tradeExecuted and messageCreated events
 * across all modules. Prints each event with key fields and counts events
 * per module per minute. After a configurable duration (default 60s), prints
 * a summary of which modules produced data and which did not.
 *
 * Usage:
 *   npx tsx scripts/tail_trades.ts
 *   npx tsx scripts/tail_trades.ts --url nats://localhost:4222
 *   npx tsx scripts/tail_trades.ts --duration 120
 *   npx tsx scripts/tail_trades.ts --follow
 */

import { connect, StringCodec } from "nats";
import type { NatsConnection, Subscription } from "nats";

const DEFAULT_NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const DEFAULT_DURATION_SEC = 60;

const SUBJECTS = [
  "feedeater.*.tradeExecuted",
  "feedeater.*.messageCreated",
];

const EXPECTED_MODULES = [
  "coinbase",
  "kraken",
  "binance",
  "kalshi",
  "polymarket",
  "uniswap",
  "arbitrum-dex",
  "polygon-dex",
];

function parseArgs(): { url: string; durationSec: number; follow: boolean } {
  const args = process.argv.slice(2);
  let url = DEFAULT_NATS_URL;
  let durationSec = DEFAULT_DURATION_SEC;
  let follow = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--duration" && args[i + 1]) {
      durationSec = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--follow" || args[i] === "-f") {
      follow = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
FeedEater Trade Event Tail

Usage:
  npx tsx scripts/tail_trades.ts [options]

Options:
  --url <nats-url>     NATS server URL (default: nats://localhost:4222)
  --duration <secs>    Run for N seconds then print summary (default: 60)
  --follow, -f         Run indefinitely (ignore --duration)
  --help, -h           Show this help message

Subscriptions:
  - feedeater.*.tradeExecuted
  - feedeater.*.messageCreated

Environment:
  NATS_URL             NATS server URL (alternative to --url)
`);
      process.exit(0);
    }
  }

  return { url, durationSec, follow };
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

interface ModuleStats {
  tradeExecuted: number;
  messageCreated: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
}

function createModuleStats(): ModuleStats {
  return { tradeExecuted: 0, messageCreated: 0, firstSeen: null, lastSeen: null };
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function formatTradeEvent(module: string, data: Record<string, unknown>): string {
  const symbol = data.symbol ?? "?";
  const side = typeof data.side === "string" ? data.side.toUpperCase() : "?";
  const price = typeof data.price === "number" ? data.price.toFixed(2) : "?";
  const size = typeof data.size === "number" ? data.size.toFixed(4) : "?";
  const notional =
    typeof data.notional_usd === "number"
      ? `$${data.notional_usd.toFixed(2)}`
      : "?";
  return `${module.padEnd(14)} TRADE  ${symbol} ${side} ${size} @ ${price} (${notional})`;
}

function formatMessageEvent(module: string, data: Record<string, unknown>): string {
  const msg = data.message as Record<string, unknown> | undefined;
  if (msg) {
    const text = typeof msg.Message === "string" ? msg.Message.slice(0, 80) : "?";
    return `${module.padEnd(14)} MSG    ${text}${text.length >= 80 ? "..." : ""}`;
  }
  return `${module.padEnd(14)} MSG    ${JSON.stringify(data).slice(0, 80)}`;
}

function printSummary(
  stats: Map<string, ModuleStats>,
  startTime: Date,
  endTime: Date
): void {
  const elapsed = (endTime.getTime() - startTime.getTime()) / 1000;
  const totalTrades = Array.from(stats.values()).reduce(
    (sum, s) => sum + s.tradeExecuted,
    0
  );
  const totalMessages = Array.from(stats.values()).reduce(
    (sum, s) => sum + s.messageCreated,
    0
  );

  console.log("");
  console.log(
    `${COL.bold}=== FeedEater Trade Tail Summary (${elapsed.toFixed(0)}s) ===${COL.reset}`
  );
  console.log("");
  console.log(
    `${"Module".padEnd(14)} ${"Trades".padStart(8)} ${"Messages".padStart(10)} ${"Rate/min".padStart(10)}  Status`
  );
  console.log("-".repeat(64));

  for (const moduleName of EXPECTED_MODULES) {
    const s = stats.get(moduleName);
    const trades = s?.tradeExecuted ?? 0;
    const messages = s?.messageCreated ?? 0;
    const total = trades + messages;
    const ratePerMin = elapsed > 0 ? ((total / elapsed) * 60).toFixed(1) : "0.0";

    let status: string;
    if (total > 0) {
      status = `${COL.green}producing${COL.reset}`;
    } else {
      status = `${COL.red}silent${COL.reset}`;
    }

    console.log(
      `${moduleName.padEnd(14)} ${String(trades).padStart(8)} ${String(messages).padStart(10)} ${ratePerMin.padStart(10)}  ${status}`
    );
  }

  const otherModules = Array.from(stats.keys()).filter(
    (m) => !EXPECTED_MODULES.includes(m)
  );
  for (const moduleName of otherModules) {
    const s = stats.get(moduleName)!;
    const total = s.tradeExecuted + s.messageCreated;
    const ratePerMin = elapsed > 0 ? ((total / elapsed) * 60).toFixed(1) : "0.0";
    console.log(
      `${moduleName.padEnd(14)} ${String(s.tradeExecuted).padStart(8)} ${String(s.messageCreated).padStart(10)} ${ratePerMin.padStart(10)}  ${COL.cyan}other${COL.reset}`
    );
  }

  console.log("-".repeat(64));
  console.log(
    `${"TOTAL".padEnd(14)} ${String(totalTrades).padStart(8)} ${String(totalMessages).padStart(10)} ${elapsed > 0 ? (((totalTrades + totalMessages) / elapsed) * 60).toFixed(1).padStart(10) : "0.0".padStart(10)}`
  );

  const producing = EXPECTED_MODULES.filter(
    (m) => {
      const s = stats.get(m);
      return s && (s.tradeExecuted > 0 || s.messageCreated > 0);
    }
  );
  const silent = EXPECTED_MODULES.filter(
    (m) => !producing.includes(m)
  );

  console.log("");
  if (producing.length > 0) {
    console.log(
      `${COL.green}Producing (${producing.length}):${COL.reset} ${producing.join(", ")}`
    );
  }
  if (silent.length > 0) {
    console.log(
      `${COL.red}Silent (${silent.length}):${COL.reset} ${silent.join(", ")}`
    );
  }
  console.log("");
}

function printMinuteRates(
  stats: Map<string, ModuleStats>,
  startTime: Date
): void {
  const elapsed = (Date.now() - startTime.getTime()) / 1000;
  const active = Array.from(stats.entries())
    .filter(([, s]) => s.tradeExecuted > 0 || s.messageCreated > 0)
    .map(([name, s]) => {
      const total = s.tradeExecuted + s.messageCreated;
      const rate = elapsed > 0 ? ((total / elapsed) * 60).toFixed(1) : "0.0";
      return `${name}:${rate}/min`;
    });
  if (active.length > 0) {
    console.log(
      `${COL.dim}[${formatTimestamp(new Date())}] Rates: ${active.join("  ")}${COL.reset}`
    );
  }
}

async function main(): Promise<void> {
  const { url, durationSec, follow } = parseArgs();
  const sc = StringCodec();
  const stats = new Map<string, ModuleStats>();
  const startTime = new Date();
  let nc: NatsConnection | null = null;
  const subscriptions: Subscription[] = [];

  console.log("");
  console.log(`${COL.bold}=== FeedEater Trade Tail ===${COL.reset}`);
  console.log(`NATS:     ${url}`);
  console.log(`Duration: ${follow ? "indefinite (--follow)" : `${durationSec}s`}`);
  console.log(`Subjects: ${SUBJECTS.join(", ")}`);
  console.log("");

  const shutdown = async (printReport: boolean): Promise<void> => {
    if (printReport) {
      printSummary(stats, startTime, new Date());
    }

    for (const sub of subscriptions) {
      try {
        sub.unsubscribe();
      } catch {
      }
    }

    if (nc) {
      try {
        await nc.drain();
        await nc.close();
      } catch {
      }
    }
  };

  process.on("SIGINT", async () => {
    console.log("\n\nInterrupted.");
    await shutdown(true);
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown(true);
    process.exit(0);
  });

  try {
    console.log("Connecting to NATS...");
    nc = await connect({
      servers: url,
      reconnect: true,
      maxReconnectAttempts: 10,
      reconnectTimeWait: 2000,
    });
    console.log(`${COL.green}Connected${COL.reset}`);
    console.log("");

    for (const subject of SUBJECTS) {
      const sub = nc.subscribe(subject);
      subscriptions.push(sub);

      (async () => {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
            const parts = msg.subject.split(".");
            const moduleName = parts[1] || "unknown";
            const eventType = parts[2] || "unknown";

            if (!stats.has(moduleName)) {
              stats.set(moduleName, createModuleStats());
            }
            const moduleStats = stats.get(moduleName)!;
            const now = new Date();

            if (!moduleStats.firstSeen) moduleStats.firstSeen = now;
            moduleStats.lastSeen = now;

            let line: string;
            if (eventType === "tradeExecuted") {
              moduleStats.tradeExecuted++;
              line = formatTradeEvent(moduleName, data);
            } else if (eventType === "messageCreated") {
              moduleStats.messageCreated++;
              line = formatMessageEvent(moduleName, data);
            } else {
              line = `${moduleName.padEnd(14)} ${eventType.padEnd(6)} ${JSON.stringify(data).slice(0, 80)}`;
            }

            console.log(`[${formatTimestamp(now)}] ${line}`);
          } catch (err) {
            console.error(`Parse error: ${err}`);
          }
        }
      })();
    }

    console.log("Listening for events...");
    console.log("");

    const rateInterval = setInterval(() => {
      printMinuteRates(stats, startTime);
    }, 15_000);

    if (!follow) {
      await new Promise<void>((resolve) => setTimeout(resolve, durationSec * 1000));
      clearInterval(rateInterval);
      await shutdown(true);
    } else {
      await new Promise<void>(() => {
        // runs indefinitely until SIGINT/SIGTERM
      });
      clearInterval(rateInterval);
    }
  } catch (err) {
    console.error(`${COL.red}Failed to connect to NATS: ${err}${COL.reset}`);
    console.error("Start NATS first or check the URL.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});

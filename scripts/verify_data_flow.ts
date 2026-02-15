#!/usr/bin/env npx ts-node
/**
 * FeedEater Data Flow Verifier
 *
 * Connects to NATS and subscribes to FeedEater event subjects.
 * Prints events as they arrive for live monitoring.
 *
 * Usage:
 *   npx ts-node scripts/verify_data_flow.ts
 *   npx ts-node scripts/verify_data_flow.ts --url nats://localhost:4222
 *   npx ts-node scripts/verify_data_flow.ts --subjects "feedeater.coinbase.*"
 */

import { connect, StringCodec, NatsConnection, Subscription } from "nats";

// Configuration
const DEFAULT_NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const DEFAULT_SUBJECTS = [
  "feedeater.*.tradeExecuted",
  "feedeater.*.messageCreated",
];

// Parse command line arguments
function parseArgs(): { url: string; subjects: string[] } {
  const args = process.argv.slice(2);
  let url = DEFAULT_NATS_URL;
  let subjects = DEFAULT_SUBJECTS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--subjects" && args[i + 1]) {
      subjects = args[i + 1].split(",").map((s) => s.trim());
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
FeedEater Data Flow Verifier

Usage:
  npx ts-node scripts/verify_data_flow.ts [options]

Options:
  --url <nats-url>       NATS server URL (default: nats://localhost:4222)
  --subjects <subjects>  Comma-separated NATS subjects to subscribe to
  --help, -h             Show this help message

Default subjects:
  - feedeater.*.tradeExecuted
  - feedeater.*.messageCreated

Examples:
  npx ts-node scripts/verify_data_flow.ts
  npx ts-node scripts/verify_data_flow.ts --url nats://nats:4222
  npx ts-node scripts/verify_data_flow.ts --subjects "feedeater.coinbase.*,feedeater.polymarket.*"
`);
      process.exit(0);
    }
  }

  return { url, subjects };
}

// Format timestamp
function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

// Format event for display
function formatEvent(subject: string, data: unknown): string {
  const timestamp = formatTimestamp(new Date());
  const parts = subject.split(".");
  const module = parts[1] || "unknown";
  const eventType = parts[2] || "unknown";

  let summary = "";
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;

    // Format based on event type
    if (eventType === "tradeExecuted") {
      const source = obj.source || module;
      const symbol = obj.symbol || "?";
      const side = obj.side || "?";
      const price = typeof obj.price === "number" ? obj.price.toFixed(2) : "?";
      const size = typeof obj.size === "number" ? obj.size.toFixed(4) : "?";
      const notional =
        typeof obj.notional_usd === "number"
          ? `$${obj.notional_usd.toFixed(2)}`
          : "?";
      summary = `${source} ${symbol} ${side.toUpperCase()} ${size} @ ${price} (${notional})`;
    } else if (eventType === "messageCreated") {
      const message = obj.message as Record<string, unknown> | undefined;
      if (message) {
        const content =
          typeof message.content === "string"
            ? message.content.slice(0, 80)
            : "?";
        const source = message.source || module;
        summary = `${source}: ${content}${content.length >= 80 ? "..." : ""}`;
      } else {
        summary = JSON.stringify(data).slice(0, 100);
      }
    } else {
      summary = JSON.stringify(data).slice(0, 100);
    }
  } else {
    summary = String(data).slice(0, 100);
  }

  return `[${timestamp}] ${eventType.padEnd(16)} | ${summary}`;
}

// Stats tracking
interface Stats {
  messagesReceived: number;
  bySubject: Record<string, number>;
  byModule: Record<string, number>;
  errors: number;
  startTime: Date;
}

function createStats(): Stats {
  return {
    messagesReceived: 0,
    bySubject: {},
    byModule: {},
    errors: 0,
    startTime: new Date(),
  };
}

function printStats(stats: Stats): void {
  const elapsed = (Date.now() - stats.startTime.getTime()) / 1000;
  const rate = stats.messagesReceived / elapsed;

  console.log("\n--- Statistics ---");
  console.log(`Total messages: ${stats.messagesReceived}`);
  console.log(`Elapsed time: ${elapsed.toFixed(1)}s`);
  console.log(`Rate: ${rate.toFixed(2)} msg/s`);
  console.log(`Errors: ${stats.errors}`);

  if (Object.keys(stats.byModule).length > 0) {
    console.log("\nBy module:");
    for (const [module, count] of Object.entries(stats.byModule).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${module}: ${count}`);
    }
  }

  if (Object.keys(stats.bySubject).length > 0) {
    console.log("\nBy event type:");
    for (const [subject, count] of Object.entries(stats.bySubject).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${subject}: ${count}`);
    }
  }
}

async function main(): Promise<void> {
  const { url, subjects } = parseArgs();
  const sc = StringCodec();
  const stats = createStats();
  let nc: NatsConnection | null = null;
  const subscriptions: Subscription[] = [];

  console.log("==============================================");
  console.log("     FeedEater Data Flow Verifier");
  console.log("==============================================");
  console.log("");
  console.log(`NATS URL: ${url}`);
  console.log(`Subjects: ${subjects.join(", ")}`);
  console.log("");
  console.log("Press Ctrl+C to stop and show statistics.");
  console.log("");
  console.log("----------------------------------------------");
  console.log("");

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("\n\nShutting down...");

    // Unsubscribe from all subjects
    for (const sub of subscriptions) {
      try {
        sub.unsubscribe();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Print final stats
    printStats(stats);

    // Close NATS connection
    if (nc) {
      try {
        await nc.drain();
        await nc.close();
      } catch {
        // Ignore errors during shutdown
      }
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    // Connect to NATS
    console.log("Connecting to NATS...");
    nc = await connect({
      servers: url,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    console.log("Connected to NATS");
    console.log("");

    // Subscribe to each subject
    for (const subject of subjects) {
      console.log(`Subscribing to: ${subject}`);
      const sub = nc.subscribe(subject);
      subscriptions.push(sub);

      // Process messages asynchronously
      (async () => {
        for await (const msg of sub) {
          try {
            const data = JSON.parse(sc.decode(msg.data));
            stats.messagesReceived++;

            // Track by subject pattern
            const parts = msg.subject.split(".");
            const eventType = parts[2] || "unknown";
            stats.bySubject[eventType] = (stats.bySubject[eventType] || 0) + 1;

            // Track by module
            const module = parts[1] || "unknown";
            stats.byModule[module] = (stats.byModule[module] || 0) + 1;

            // Print formatted event
            console.log(formatEvent(msg.subject, data));
          } catch (err) {
            stats.errors++;
            console.error(`Error processing message: ${err}`);
          }
        }
      })();
    }

    console.log("");
    console.log("Listening for events...");
    console.log("");

    // Keep the process running
    await new Promise(() => {
      // This promise never resolves - we wait for SIGINT/SIGTERM
    });
  } catch (err) {
    console.error(`Failed to connect to NATS: ${err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});

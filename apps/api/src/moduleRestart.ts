import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";

const KNOWN_MODULES = new Set([
  "binance",
  "coinbase",
  "bybit",
  "gemini",
  "bitstamp",
  "okx",
  "kalshi",
  "polymarket",
  "aerodrome-base",
  "uniswap-base",
]);

interface RestartDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
}

export function postModuleRestart({ getNatsConn, sc }: RestartDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(400).json({
        error: `Unknown module: ${name}. Valid modules: ${[...KNOWN_MODULES].join(", ")}`,
      });
      return;
    }

    const payload = {
      module: name,
      timestamp: new Date().toISOString(),
      requestedBy: req.headers.authorization
        ? "api-key-user"
        : "anonymous",
    };

    try {
      const nc = await getNatsConn();
      nc.publish(
        `feedeater.control.restart.${name}`,
        sc.encode(JSON.stringify(payload)),
      );
      res.json({ ok: true, module: name, message: `Restart signal sent for ${name}` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "NATS publish failed";
      res.status(500).json({ error: message });
    }
  };
}

export { KNOWN_MODULES };

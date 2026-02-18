import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";

const HEARTBEAT_MS = 30_000;

export interface StreamDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
}

export function getStream({ getNatsConn, sc }: StreamDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const moduleParam = req.query.module as string | undefined;

    if (moduleParam && !KNOWN_MODULES.has(moduleParam)) {
      res.status(400).json({
        error: `Unknown module: ${moduleParam}. Valid modules: ${[...KNOWN_MODULES].join(", ")}`,
      });
      return;
    }

    const subject = moduleParam
      ? `feedeater.${moduleParam}.tradeExecuted`
      : "feedeater.*.tradeExecuted";

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const keepalive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, HEARTBEAT_MS);

    let nc: NatsConnection;
    try {
      nc = await getNatsConn();
    } catch (err) {
      clearInterval(keepalive);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "NATS connection failed" })}\n\n`);
      res.end();
      return;
    }

    const sub = nc.subscribe(subject);

    let closed = false;
    req.on("close", () => {
      closed = true;
      clearInterval(keepalive);
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
    });

    (async () => {
      try {
        for await (const m of sub) {
          if (closed) break;

          let data: unknown = null;
          try {
            data = JSON.parse(sc.decode(m.data));
          } catch {
            data = { parseError: true };
          }

          const payload = {
            subject: m.subject,
            receivedAt: new Date().toISOString(),
            data,
          };

          res.write("event: trade\n");
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch {
        // client disconnected
      } finally {
        clearInterval(keepalive);
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    })();
  };
}

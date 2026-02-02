import type { Request, Response } from "express";
import type { NatsConnection, StringCodec } from "nats";
import { ContextUpdatedEventSchema } from "@feedeater/core";
import { prisma } from "@feedeater/db";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeKeyPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

export function getContextsHistory(req: Request, res: Response) {
  return (async () => {
    try {
      const sinceMinutesRaw = req.query.sinceMinutes;
      const limitRaw = req.query.limit;
      const moduleRaw = req.query.module;
      const qRaw = req.query.q;

      const sinceMinutes = clamp(Number(sinceMinutesRaw ?? 60), 0, 60 * 24 * 30);
      const limit = clamp(Number(limitRaw ?? 200), 1, 500);
      const moduleFilter = typeof moduleRaw === "string" ? moduleRaw.trim() : "";
      const q = typeof qRaw === "string" ? qRaw.trim() : "";

      const since = new Date(Date.now() - sinceMinutes * 60_000);
      const rows = await prisma.busContext.findMany({
        where: {
          ...(sinceMinutes > 0 ? { updatedAt: { gte: since } } : {}),
          ...(moduleFilter ? { ownerModule: moduleFilter } : {}),
          ...(q
            ? {
                OR: [
                  { summaryShort: { contains: q, mode: "insensitive" } },
                  { summaryLong: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: limit,
        include: { _count: { select: { messages: true } } },
      });

      res.json({
        ok: true,
        sinceMinutes,
        limit,
        items: rows.map((r) => ({
          id: r.id,
          ownerModule: r.ownerModule,
          sourceKey: r.sourceKey,
          summaryShort: r.summaryShort,
          summaryLong: r.summaryLong,
          keyPoints: normalizeKeyPoints(r.keyPoints),
          version: r.version,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          messageCount: r._count?.messages ?? 0,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
}

export function getContextMessages(req: Request, res: Response) {
  return (async () => {
    try {
      const contextIdRaw = req.query.contextId;
      const ownerModuleRaw = req.query.ownerModule;
      const sourceKeyRaw = req.query.sourceKey;

      const contextId = typeof contextIdRaw === "string" ? contextIdRaw.trim() : "";
      const ownerModule = typeof ownerModuleRaw === "string" ? ownerModuleRaw.trim() : "";
      const sourceKey = typeof sourceKeyRaw === "string" ? sourceKeyRaw.trim() : "";

      let context = null as null | {
        id: string;
        ownerModule: string;
        sourceKey: string;
        summaryShort: string;
        summaryLong: string;
        keyPoints: unknown;
        version: number;
        createdAt: Date;
        updatedAt: Date;
      };

      if (contextId) {
        context = await prisma.busContext.findUnique({ where: { id: contextId } });
      } else if (ownerModule && sourceKey) {
        context = await prisma.busContext.findUnique({
          where: { ownerModule_sourceKey: { ownerModule, sourceKey } },
        });
      }

      if (!context) {
        res.status(404).json({ ok: false, error: "Context not found" });
        return;
      }

      const rows = await prisma.busContextMessage.findMany({
        where: { contextId: context.id },
        include: {
          message: {
            select: {
              id: true,
              createdAt: true,
              rawJson: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      res.json({
        ok: true,
        context: {
          id: context.id,
          ownerModule: context.ownerModule,
          sourceKey: context.sourceKey,
          summaryShort: context.summaryShort,
          summaryLong: context.summaryLong,
          keyPoints: normalizeKeyPoints(context.keyPoints),
          version: context.version,
          createdAt: context.createdAt.toISOString(),
          updatedAt: context.updatedAt.toISOString(),
        },
        messages: rows.map((r) => ({
          id: r.message.id,
          createdAt: r.message.createdAt.toISOString(),
          raw: r.message.rawJson,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
}

export function getContextsStream(params: { getNatsConn: () => Promise<NatsConnection>; sc: StringCodec }) {
  return async (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const keepalive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 15000);

    const nc = await params.getNatsConn();
    const sub = nc.subscribe("feedeater.*.contextUpdated");

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
            data = JSON.parse(params.sc.decode(m.data));
          } catch {
            data = { parseError: true };
          }

          const parsed = ContextUpdatedEventSchema.safeParse(data);
          if (!parsed.success) continue;
          const ctx = parsed.data.context;
          if (!ctx.ownerModule || !ctx.sourceKey) continue;

          const record = await prisma.busContext.findUnique({
            where: { ownerModule_sourceKey: { ownerModule: ctx.ownerModule, sourceKey: ctx.sourceKey } },
            include: { _count: { select: { messages: true } } },
          });
          if (!record) continue;

          const payload = {
            subject: m.subject,
            receivedAt: new Date().toISOString(),
            messageId: parsed.data.messageId ?? null,
            context: {
              id: record.id,
              ownerModule: record.ownerModule,
              sourceKey: record.sourceKey,
              summaryShort: record.summaryShort,
              summaryLong: record.summaryLong,
              keyPoints: normalizeKeyPoints(record.keyPoints),
              version: record.version,
              createdAt: record.createdAt.toISOString(),
              updatedAt: record.updatedAt.toISOString(),
              messageCount: record._count?.messages ?? 0,
            },
          };

          res.write("event: context\n");
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch {
        // ignore
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

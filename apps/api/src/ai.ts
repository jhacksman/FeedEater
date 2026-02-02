import type { Request, Response } from "express";
import { prisma } from "@feedeater/db";

function requireInternalAuth(req: Request): void {
  const expected = process.env.FEED_INTERNAL_TOKEN;
  if (!expected) throw new Error("Missing required env var: FEED_INTERNAL_TOKEN");

  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || token !== expected) {
    const err = new Error("Unauthorized");
    (err as any).statusCode = 401;
    throw err;
  }
}

async function getSystemSettings(): Promise<Record<string, string | null>> {
  const rows = await prisma.setting.findMany({ where: { module: "system" } });
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getAiDefaults(settings: Record<string, string | null>) {
  const baseUrl = String(settings.ollama_base_url ?? process.env.OLLAMA_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const summaryModel = String(settings.ollama_summary_model ?? process.env.OLLAMA_SUMMARY_MODEL ?? "llama3.1:8b").trim();
  const embedModel = String(settings.ollama_embed_model ?? process.env.OLLAMA_EMBED_MODEL ?? "llama3.1:8b").trim();
  const embedDimRaw = settings.ollama_embed_dim ?? process.env.OLLAMA_EMBED_DIM ?? "4096";
  const embedDim = Number.isFinite(Number(embedDimRaw)) ? Number(embedDimRaw) : 4096;
  return { baseUrl, summaryModel, embedModel, embedDim };
}

export function postAiSummary() {
  return async (req: Request, res: Response) => {
    try {
      requireInternalAuth(req);
      const body = (req.body ?? {}) as { prompt?: unknown; system?: unknown; format?: unknown };
      if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
        res.status(400).json({ error: "prompt must be a non-empty string" });
        return;
      }

      const settings = await getSystemSettings();
      const cfg = getAiDefaults(settings);
      if (!cfg.baseUrl) {
        res.status(400).json({ error: "ollama_base_url is not configured" });
        return;
      }

      const system = typeof body.system === "string" && body.system.trim().length > 0 ? body.system.trim() : undefined;
      const format =
        typeof body.format === "string" && body.format.trim().length > 0 ? body.format.trim() : undefined;

      const ollamaRes = await fetch(`${cfg.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: cfg.summaryModel,
          ...(system ? { system } : {}),
          prompt: body.prompt,
          ...(format ? { format } : {}),
          stream: false,
        }),
      });
      if (!ollamaRes.ok) throw new Error(`ollama generate failed (${ollamaRes.status})`);
      const data = (await ollamaRes.json()) as { response?: string; eval_count?: number; eval_duration?: number };
      if (!data.response) throw new Error("missing ollama response");

      const tokenRate =
        typeof data.eval_count === "number" && typeof data.eval_duration === "number" && data.eval_duration > 0
          ? data.eval_count / (data.eval_duration / 1_000_000_000)
          : null;

      res.json({
        response: data.response,
        token_rate: tokenRate,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function postAiEmbedding() {
  return async (req: Request, res: Response) => {
    try {
      requireInternalAuth(req);
      const body = (req.body ?? {}) as { text?: unknown };
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        res.status(400).json({ error: "text must be a non-empty string" });
        return;
      }

      const settings = await getSystemSettings();
      const cfg = getAiDefaults(settings);
      if (!cfg.baseUrl) {
        res.status(400).json({ error: "ollama_base_url is not configured" });
        return;
      }

      const ollamaRes = await fetch(`${cfg.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.embedModel, prompt: body.text }),
      });
      if (!ollamaRes.ok) throw new Error(`ollama embeddings failed (${ollamaRes.status})`);
      const data = (await ollamaRes.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error("empty embedding");
      }

      res.json({ embedding: data.embedding, dim: cfg.embedDim });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function getAiTags() {
  return async (req: Request, res: Response) => {
    try {
      requireInternalAuth(req);
      const settings = await getSystemSettings();
      const cfg = getAiDefaults(settings);
      if (!cfg.baseUrl) {
        res.status(400).json({ error: "ollama_base_url is not configured" });
        return;
      }

      const ollamaRes = await fetch(`${cfg.baseUrl}/api/tags`);
      if (!ollamaRes.ok) throw new Error(`ollama tags failed (${ollamaRes.status})`);
      const data = (await ollamaRes.json()) as unknown;
      res.json({ ok: true, tags: data });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}


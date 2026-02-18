import type { Request, Response } from "express";

export class AcknowledgedAlerts {
  private acked = new Map<string, { acknowledged_at: string; acknowledged_by: string | null }>();

  private makeKey(module: string, type: string): string {
    return `${module}:${type}`;
  }

  acknowledge(module: string, type: string, by?: string): void {
    this.acked.set(this.makeKey(module, type), {
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: by ?? null,
    });
  }

  isAcknowledged(module: string, type: string): boolean {
    return this.acked.has(this.makeKey(module, type));
  }

  getAck(module: string, type: string) {
    return this.acked.get(this.makeKey(module, type)) ?? null;
  }

  remove(module: string, type: string): boolean {
    return this.acked.delete(this.makeKey(module, type));
  }

  listAll() {
    const result: Array<{ module: string; type: string; acknowledged_at: string; acknowledged_by: string | null }> = [];
    for (const [key, val] of this.acked) {
      const [module, type] = key.split(":");
      result.push({ module, type, ...val });
    }
    return result;
  }

  clear(): void {
    this.acked.clear();
  }
}

interface AckDeps {
  store: AcknowledgedAlerts;
}

export function postAcknowledgeAlert({ store }: AckDeps) {
  return (req: Request, res: Response): void => {
    const { module, type, acknowledged_by } = req.body ?? {};

    if (!module || typeof module !== "string") {
      res.status(400).json({ error: "module is required" });
      return;
    }

    if (!type || typeof type !== "string") {
      res.status(400).json({ error: "type is required (stale, disconnected, disabled, error)" });
      return;
    }

    const validTypes = ["stale", "disconnected", "disabled", "error"];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: `Invalid alert type: ${type}. Must be one of: ${validTypes.join(", ")}` });
      return;
    }

    store.acknowledge(module, type, acknowledged_by);

    res.json({
      success: true,
      module,
      type,
      acknowledged_at: store.getAck(module, type)?.acknowledged_at,
      acknowledged_by: store.getAck(module, type)?.acknowledged_by ?? null,
    });
  };
}

export function listAcknowledgedAlerts({ store }: AckDeps) {
  return (_req: Request, res: Response): void => {
    const acknowledged = store.listAll();
    res.json({
      acknowledged,
      count: acknowledged.length,
    });
  };
}

export function deleteAcknowledgedAlert({ store }: AckDeps) {
  return (req: Request, res: Response): void => {
    const { module, type } = req.body ?? {};

    if (!module || typeof module !== "string") {
      res.status(400).json({ error: "module is required" });
      return;
    }

    if (!type || typeof type !== "string") {
      res.status(400).json({ error: "type is required" });
      return;
    }

    const removed = store.remove(module, type);

    if (!removed) {
      res.status(404).json({ error: `No acknowledged alert found for ${module}:${type}` });
      return;
    }

    res.json({ success: true, module, type });
  };
}

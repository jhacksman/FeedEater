import { isRecord, type HttpRpc } from "./ports.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Paced JSON-RPC over the node's HTTP endpoint: one call at a time, at least `minIntervalMs` apart. */
export class PacedHttpRpc implements HttpRpc {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  private nextId = 1;
  calls = 0;

  constructor(
    private readonly url: string,
    private readonly minIntervalMs: number,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    if (!/^https?:\/\//.test(url)) throw new Error(`HTTP RPC url must be http(s): ${url}`);
  }

  call(method: string, params: unknown[]): Promise<unknown> {
    const run = this.chain.then(() => this.send(method, params));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send(method: string, params: unknown[]): Promise<unknown> {
    const wait = this.lastAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
    this.calls += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = await res.json();
      if (!isRecord(body)) throw new Error(`${method}: malformed response`);
      if (isRecord(body.error)) throw new Error(`${method}: ${String(body.error.message)}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

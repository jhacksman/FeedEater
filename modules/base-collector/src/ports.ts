/** Core-NATS-shaped bus. Publication is synchronous (buffered by the client); nothing is assumed durable. */
export type Bus = {
  publish(subject: string, data: Uint8Array): void;
  subscribe(subject: string, onMessage: (data: Uint8Array, subject: string) => void): void;
};

export type HttpRpc = { call(method: string, params: unknown[]): Promise<unknown> };

export type WsHandlers = { onOpen(): void; onMessage(text: string): void; onClose(reason: string): void };
export type WsLike = { send(text: string): void; close(): void };
export type WsFactory = (url: string, handlers: WsHandlers) => WsLike;

export type Clock = { nowMs(): number };
export const systemClock: Clock = { nowMs: () => Date.now() };

export type Logger = (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
export const stderrLogger: Logger = (level, message, meta) => {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...meta })}\n`);
};

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

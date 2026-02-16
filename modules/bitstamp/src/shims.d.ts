declare var process: any;

declare module "pg" {
  export type PoolClient = any;
  export class Pool {
    constructor(opts: any);
    query(sql: string, params?: any[]): Promise<any>;
    connect(): Promise<any>;
  }
}

declare module "uuid" {
  export function v5(name: string, namespace: string): string;
}

declare module "nats" {
  export type NatsConnection = any;
  export type StringCodec = any;
}

declare module "ws" {
  export default class WebSocket {
    constructor(url: string);
    on(event: string, handler: (...args: any[]) => void): void;
    send(data: string): void;
    close(): void;
    readyState: number;
    static OPEN: number;
    static CLOSED: number;
  }
}

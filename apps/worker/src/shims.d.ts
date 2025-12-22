// Local dev shim: this repo may be opened without `node_modules` installed.
// Minimal types to keep TS strict mode workable in-editor.

declare var process: any;

declare module "bullmq" {
  export class Queue {
    constructor(name: string, opts: any);
    add(name: string, data: any, opts?: any): Promise<any>;
  }
  export class Worker {
    constructor(name: string, processor: any, opts: any);
    on(event: string, cb: any): any;
  }
}

declare module "ioredis" {
  export default class IORedis {
    constructor(url: string, opts?: any);
  }
}

declare module "nats" {
  export type NatsConnection = any;
  export type StringCodec = any;
  export function connect(opts: any): Promise<any>;
  export function StringCodec(): any;
}

declare module "pg" {
  export class Pool {
    constructor(opts: any);
    connect(): Promise<any>;
    query(sql: string, params?: any[]): Promise<any>;
  }
}



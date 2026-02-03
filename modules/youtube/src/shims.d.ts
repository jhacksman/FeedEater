// Local dev shim: this repo may be opened without `node_modules` installed.
// Minimal type shims to keep editor/typecheck usable; real types come from installed deps.
declare var process: any;

declare module "fast-xml-parser" {
  export class XMLParser {
    constructor(opts?: any);
    parse(xml: string): any;
  }
}

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

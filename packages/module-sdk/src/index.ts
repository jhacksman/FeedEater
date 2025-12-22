export type QueueLike = {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
};

export type DbLike = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<unknown>; release(): void }>;
};

export type NatsLike = {
  publish(subject: string, data: Uint8Array): void;
  subscribe(subject: string): AsyncIterable<{ data: Uint8Array }>;
};

export type StringCodecLike = {
  encode(s: string): Uint8Array;
  decode(b: Uint8Array): string;
};

export type ModuleRuntimeContext = {
  moduleName: string;
  modulesDir: string;
  db: DbLike;
  nats: NatsLike;
  sc: StringCodecLike;
  getQueue(queueName: string): QueueLike;
  fetchInternalSettings(moduleName: string): Promise<Record<string, unknown>>;
};

export type ModuleJobHandler = (params: {
  ctx: ModuleRuntimeContext;
  job: { name: string; data: any; id?: string | number };
}) => Promise<void>;

export type ModuleRuntime = {
  moduleName: string;
  /**
   * Queue name -> job name -> handler
   */
  handlers: Record<string, Record<string, ModuleJobHandler>>;
};



import { z } from "zod";

import { O1_SUITES, POOL_MANAGER } from "./src/constants.js";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address")
  .transform((s) => s.toLowerCase());
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex id")
  .transform((s) => s.toLowerCase());
const count = (dflt: number, min = 0) => z.number().int().min(min).default(dflt);

export const BaseCollectorSettingsSchema = z
  .object({
    /** Node WebSocket endpoint for eth_subscribe (e.g. ws://10.9.11.68:8546). */
    wsUrl: z.string().regex(/^wss?:\/\//, "wsUrl must be ws:// or wss://"),
    /** Node HTTP endpoint for eth_blockNumber/eth_getLogs (e.g. http://10.9.11.68:8545). Never derived from wsUrl. */
    httpUrl: z.string().regex(/^https?:\/\//, "httpUrl must be http:// or https://"),
    natsUrl: z.string().min(1),
    databaseUrl: z.string().min(1).nullable().default(null),
    stateDir: z.string().min(1).nullable().default(null),
    /** First start only (no checkpoint): backfill from this block. Default: the node head at connect. */
    startBlock: z.number().int().min(0).nullable().default(null),
    poolManager: address.default(POOL_MANAGER),
    suites: z
      .array(z.object({ name: z.string().min(1), factory: address, hook: address, firstBlock: z.number().int().min(0) }))
      .min(1)
      .default(O1_SUITES.map((s) => ({ ...s }))),
    extraHooks: z.array(address).default([]),
    extraPoolIds: z.array(bytes32).default([]),
    /** Depth at which a block is sealed and the reconnect checkpoint advances. */
    confirmBlocks: count(10, 1),
    /** Blocks below the checkpoint replayed on every reconnect. */
    overlapBlocks: count(64, 1),
    backfillChunkBlocks: count(500, 1),
    /** Longest reconnect backfill; older blocks are skipped and reported as truncated coverage. */
    maxBackfillBlocks: count(43_200, 1),
    /** Longest range served per persister recover request. */
    maxRecoverBlocks: count(2_000, 1),
    /** Identity ledger retention below the checkpoint (live dedupe window). */
    retainBlocks: count(4_096, 1),
    maxTrackedPools: count(100_000, 1),
    /** 0 disables idle eviction. */
    poolIdleBlocks: count(0),
    maxPendingSwaps: count(20_000),
    rpcMinIntervalMs: count(100),
    rpcTimeoutMs: count(15_000, 1),
    reconnectBaseMs: count(500, 1),
    reconnectMaxMs: count(30_000, 1),
    statusIntervalMs: count(5_000, 100),
    checkpointIntervalMs: count(2_000, 100),
    persisterTimeoutMs: count(15_000, 100),
    /** Publications per second above which an alert is counted; nothing is dropped. */
    rateAlertPerSec: count(2_000, 1),
    persistBatchSize: count(500, 1),
    persistFlushMs: count(200, 1),
    persistMaxQueue: count(200_000, 1),
    persistHeartbeatMs: count(5_000, 100),
    persistRecoverIntervalMs: count(30_000, 100),
    persistRecoverOverlapBlocks: count(64),
    /** Seals missing this many blocks below the newest seal count as gaps. */
    persistMissingSealGraceBlocks: count(30, 1),
  })
  .superRefine((s, ctx) => {
    if (s.retainBlocks <= s.overlapBlocks + s.confirmBlocks) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retainBlocks"], message: "retainBlocks must exceed overlapBlocks + confirmBlocks" });
    }
    const ws = new URL(s.wsUrl);
    const http = new URL(s.httpUrl);
    if (ws.host === http.host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpUrl"],
        message: "httpUrl has the same host:port as wsUrl; configure the node's separate HTTP endpoint explicitly",
      });
    }
    const factories = new Set(s.suites.map((x) => x.factory));
    if (factories.size !== s.suites.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["suites"], message: "duplicate suite factory" });
    }
  });

export type BaseCollectorSettings = z.infer<typeof BaseCollectorSettingsSchema>;
export type BaseCollectorSettingsInput = z.input<typeof BaseCollectorSettingsSchema>;

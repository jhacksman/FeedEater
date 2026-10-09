export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
};

export type EventKind = "initialize" | "swap" | "factory";

/** `live` records come from the persistent subscription; everything else is `backfill`. */
export type DeliveryPath = "live" | "backfill";

/** Why a record is on a backfill subject. `null` only for live records. */
export type Recovery = "reconnect" | "persister" | "stale" | "pending_swap" | "publish_retry" | null;

export type DecodedInitialize = {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  sqrtPriceX96: string;
  tick: number;
};

export type DecodedSwap = {
  poolId: string;
  sender: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
};

export type DecodedFactory = { topic0: string | null };

export type Decoded = DecodedInitialize | DecodedSwap | DecodedFactory;

/**
 * One state observation of a log identity (`blockHash:logIndex`). `removed: true` and a later
 * `removed: false` of the same identity are distinct state transitions, ordered by (epoch, seq).
 */
export type LogRecord = {
  v: 1;
  type: "log";
  id: string;
  kind: EventKind;
  path: DeliveryPath;
  realtime: boolean;
  recovery: Recovery;
  removed: boolean;
  epoch: number;
  seq: number;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
  decoded: Decoded | null;
  suite: string | null;
  receivedAtMs: number;
};

/**
 * The collector's canonical view of one block once it is `confirmBlocks` deep: the number and
 * digest of active published identities. The persister compares it with what it stored.
 */
export type SealRecord = {
  v: 1;
  type: "seal";
  epoch: number;
  seq: number;
  path: DeliveryPath;
  recovery: Recovery;
  blockNumber: number;
  blockHash: string | null;
  count: number;
  digest: string;
};

export type DroppedPool = { poolId: string; reason: "max_tracked" | "idle"; atBlock: number };

export type CollectorStatus = {
  v: 1;
  type: "status";
  epoch: number;
  atMs: number;
  connected: boolean;
  reconciled: boolean;
  filterDigest: string;
  headBlock: number | null;
  verifiedBlock: number | null;
  trackedSinceBlock: number | null;
  trackedPools: number;
  coverage: {
    complete: boolean;
    droppedPools: number;
    recentDropped: DroppedPool[];
    swapsForDroppedPools: number;
    untrackedSwaps: number;
    pendingSwapsDropped: number;
    backfillTruncatedBlocks: number;
    undeliveredBlocks: number[];
  };
  counters: Record<string, number>;
  persistence: {
    state: "ok" | "missing" | "unknown";
    lastHeartbeatMs: number | null;
    contiguousBlock: number | null;
    startBoundary: number | null;
    gaps: number;
  };
};

export type RecoverRequest = {
  v: 1;
  type: "recover";
  requestId: string;
  fromBlock: number;
  toBlock: number | null;
  reason: string;
};

export type PersisterHeartbeat = {
  v: 1;
  type: "persister";
  atMs: number;
  contiguousBlock: number | null;
  startBoundary: number | null;
  queued: number;
  droppedOverflow: number;
  lastFlushOkMs: number | null;
  lastError: string | null;
  gapBlocks: number[];
  gapCount: number;
};

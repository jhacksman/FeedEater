import type pg from "pg";

import { newer, type PersistStore } from "./persister.js";
import { sealDigest } from "./subjects.js";
import type { LogRecord, SealRecord } from "./types.js";

const S = "mod_base_collector";

export const SCHEMA_SQL = [
  `CREATE SCHEMA IF NOT EXISTS ${S}`,
  `CREATE TABLE IF NOT EXISTS ${S}.logs (
    id text PRIMARY KEY,
    block_hash text NOT NULL,
    log_index integer NOT NULL,
    block_number bigint NOT NULL,
    kind text NOT NULL,
    address text NOT NULL,
    tx_hash text NOT NULL,
    tx_index integer NOT NULL,
    topics jsonb NOT NULL,
    data text NOT NULL,
    decoded jsonb,
    suite text,
    removed boolean NOT NULL,
    state_source text NOT NULL,
    epoch bigint NOT NULL,
    seq bigint NOT NULL,
    first_path text NOT NULL,
    first_realtime boolean NOT NULL,
    first_received_at_ms bigint NOT NULL,
    transitions integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS logs_block_number_idx ON ${S}.logs (block_number)`,
  `CREATE TABLE IF NOT EXISTS ${S}.log_transitions (
    id text NOT NULL,
    epoch bigint NOT NULL,
    seq bigint NOT NULL,
    removed boolean NOT NULL,
    source text NOT NULL,
    recovery text,
    received_at_ms bigint,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, epoch, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS ${S}.seals (
    block_number bigint PRIMARY KEY,
    block_hash text,
    count integer NOT NULL,
    digest text NOT NULL,
    matched boolean NOT NULL,
    epoch bigint NOT NULL,
    seq bigint NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS ${S}.persist_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
];

/** Highest (epoch, seq) observation per identity; Postgres cannot update one row twice per statement. */
export function latestPerId(records: readonly LogRecord[]): LogRecord[] {
  const m = new Map<string, LogRecord>();
  for (const r of records) {
    const prev = m.get(r.id);
    if (prev === undefined || newer(r, prev)) m.set(r.id, r);
  }
  return [...m.values()];
}

export class PgStore implements PersistStore {
  constructor(private readonly pool: pg.Pool) {}

  async init(): Promise<number | null> {
    for (const sql of SCHEMA_SQL) await this.pool.query(sql);
    const res = await this.pool.query<{ value: { block: number } }>(`SELECT value FROM ${S}.persist_state WHERE key = 'contiguous'`);
    return res.rows[0]?.value.block ?? null;
  }

  async writeLogs(records: readonly LogRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${S}.log_transitions (id, epoch, seq, removed, source, recovery, received_at_ms)
         SELECT x.id, x.epoch, x.seq, x.removed, x.path, x.recovery, x."receivedAtMs"
         FROM jsonb_to_recordset($1::jsonb) AS x(id text, epoch bigint, seq bigint, removed boolean, path text, recovery text, "receivedAtMs" bigint)
         ON CONFLICT (id, epoch, seq) DO NOTHING`,
        [JSON.stringify(records)],
      );
      await client.query(
        `INSERT INTO ${S}.logs (id, block_hash, log_index, block_number, kind, address, tx_hash, tx_index, topics, data, decoded, suite,
                                removed, state_source, epoch, seq, first_path, first_realtime, first_received_at_ms)
         SELECT x.id, x."blockHash", x."logIndex", x."blockNumber", x.kind, x.address, x."txHash", x."txIndex", x.topics, x.data, x.decoded, x.suite,
                x.removed, x.path, x.epoch, x.seq, x.path, x.realtime, x."receivedAtMs"
         FROM jsonb_to_recordset($1::jsonb) AS x(id text, "blockHash" text, "logIndex" integer, "blockNumber" bigint, kind text, address text,
              "txHash" text, "txIndex" integer, topics jsonb, data text, decoded jsonb, suite text, removed boolean, path text,
              epoch bigint, seq bigint, realtime boolean, "receivedAtMs" bigint)
         ON CONFLICT (id) DO UPDATE SET
           removed = EXCLUDED.removed,
           state_source = EXCLUDED.state_source,
           epoch = EXCLUDED.epoch,
           seq = EXCLUDED.seq,
           transitions = ${S}.logs.transitions + CASE WHEN ${S}.logs.removed <> EXCLUDED.removed THEN 1 ELSE 0 END,
           updated_at = now()
         WHERE (EXCLUDED.epoch, EXCLUDED.seq) > (${S}.logs.epoch, ${S}.logs.seq)`,
        [JSON.stringify(latestPerId(records))],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async applySeal(seal: SealRecord): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orphaned = await client.query<{ id: string }>(
        `UPDATE ${S}.logs SET removed = true, state_source = 'seal', epoch = $3, seq = $4,
                transitions = transitions + 1, updated_at = now()
         WHERE block_number = $1 AND NOT removed AND (epoch, seq) < ($3::bigint, $4::bigint)
           AND (($2::text IS NULL AND $5::integer = 0) OR ($2::text IS NOT NULL AND block_hash <> $2::text))
         RETURNING id`,
        [seal.blockNumber, seal.blockHash, seal.epoch, seal.seq, seal.count],
      );
      for (const row of orphaned.rows) {
        await client.query(
          `INSERT INTO ${S}.log_transitions (id, epoch, seq, removed, source) VALUES ($1, $2, $3, true, 'seal') ON CONFLICT DO NOTHING`,
          [row.id, seal.epoch, seal.seq],
        );
      }
      const active = await client.query<{ id: string }>(`SELECT id FROM ${S}.logs WHERE block_number = $1 AND NOT removed`, [seal.blockNumber]);
      const ids = active.rows.map((r) => r.id);
      const matched = ids.length === seal.count && sealDigest(ids) === seal.digest;
      await client.query(
        `INSERT INTO ${S}.seals (block_number, block_hash, count, digest, matched, epoch, seq) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash, count = EXCLUDED.count, digest = EXCLUDED.digest,
           matched = EXCLUDED.matched, epoch = EXCLUDED.epoch, seq = EXCLUDED.seq, checked_at = now()
         WHERE (EXCLUDED.epoch, EXCLUDED.seq) >= (${S}.seals.epoch, ${S}.seals.seq)`,
        [seal.blockNumber, seal.blockHash, seal.count, seal.digest, matched, seal.epoch, seal.seq],
      );
      await client.query("COMMIT");
      return matched;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async saveContiguous(block: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${S}.persist_state (key, value) VALUES ('contiguous', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ block })],
    );
  }

  /** Active and removed identities stored for a block range (verify-persist). */
  async range(fromBlock: number, toBlock: number): Promise<Array<{ id: string; removed: boolean; kind: string; poolId: string | null }>> {
    const res = await this.pool.query<{ id: string; removed: boolean; kind: string; pool_id: string | null }>(
      `SELECT id, removed, kind, topics->>1 AS pool_id FROM ${S}.logs WHERE block_number BETWEEN $1 AND $2`,
      [fromBlock, toBlock],
    );
    return res.rows.map((r) => ({ id: r.id, removed: r.removed, kind: r.kind, poolId: r.pool_id }));
  }

  async trackedPoolIds(): Promise<Set<string>> {
    const res = await this.pool.query<{ pool_id: string }>(
      `SELECT DISTINCT decoded->>'poolId' AS pool_id FROM ${S}.logs WHERE kind = 'initialize' AND suite IS NOT NULL AND NOT removed`,
    );
    return new Set(res.rows.map((r) => r.pool_id));
  }
}

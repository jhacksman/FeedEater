import pg from "pg";

export interface RawEvent {
  subject: string;
  payload: unknown;
}

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function ensureTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id SERIAL PRIMARY KEY,
      subject TEXT NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_raw_events_subject ON raw_events (subject)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_raw_events_received_at ON raw_events (received_at)`
  );
}

export async function insertEvent(
  pool: pg.Pool,
  event: RawEvent
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO raw_events (subject, payload) VALUES ($1, $2) RETURNING id`,
    [event.subject, JSON.stringify(event.payload)]
  );
  return result.rows[0]!.id;
}

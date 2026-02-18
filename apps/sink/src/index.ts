import { connect, StringCodec } from "nats";
import { createPool, ensureTable, insertEvent } from "./db.js";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://feedeater:feedeater@localhost:5432/feedeater";
const SUBJECT = process.env.SINK_SUBJECT ?? "feedeater.>";

const sc = StringCodec();
const pool = createPool(DATABASE_URL);

async function main() {
  await ensureTable(pool);
  console.log("[sink] raw_events table ready");

  const nc = await connect({ servers: NATS_URL });
  console.log(`[sink] connected to NATS at ${NATS_URL}`);

  const sub = nc.subscribe(SUBJECT);
  console.log(`[sink] subscribed to ${SUBJECT}`);

  for await (const msg of sub) {
    let payload: unknown;
    try {
      payload = JSON.parse(sc.decode(msg.data));
    } catch {
      payload = { raw: sc.decode(msg.data) };
    }

    try {
      await insertEvent(pool, { subject: msg.subject, payload });
    } catch (err) {
      console.error("[sink] insert failed:", err);
    }
  }

  await nc.closed();
  await pool.end();
}

main().catch((err) => {
  console.error("[sink] fatal:", err);
  process.exit(1);
});

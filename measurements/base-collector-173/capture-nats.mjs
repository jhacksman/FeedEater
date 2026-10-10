// Raw capture of every collector NATS subject, timestamped with process.hrtime.bigint() (the same
// host clock measure uses). Run on the measure host; start before measure, stop after it exits.
// usage: FE=/path/to/checkout BASE_COLLECTOR_NATS_URL=... node capture-nats.mjs OUT.jsonl
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(`${process.env.FE}/modules/base-collector/package.json`);
const { connect } = require("nats");
const out = fs.createWriteStream(process.argv[2], { flags: "wx" });
const line = (o) => out.write(`${JSON.stringify(o)}\n`);
const nc = await connect({ servers: process.env.BASE_COLLECTOR_NATS_URL, name: "base-collector-capture" });
const subject = "feedeater.base_collector.>";
line({ type: "meta", phase: "start", tool: "capture-nats", clock: "process.hrtime.bigint", hrNs: process.hrtime.bigint().toString(), wallMs: Date.now(), host: os.hostname(), platform: process.platform, node: process.version, subject });
const dec = new TextDecoder();
let stopping = false;
nc.subscribe(subject, {
  callback: (err, m) => {
    const hrNs = process.hrtime.bigint().toString();
    if (stopping) return;
    if (err) line({ type: "error", hrNs, wallMs: Date.now(), error: err.message });
    else line({ type: "msg", hrNs, wallMs: Date.now(), subject: m.subject, payload: dec.decode(m.data) });
  },
});
for (const s of ["SIGINT", "SIGTERM"]) {
  process.once(s, async () => {
    stopping = true;
    await nc.drain();
    line({ type: "meta", phase: "stop", hrNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
    out.end(() => process.exit(0));
  });
}

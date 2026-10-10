// Predeclared, bounded history input for one scratch run. Refuses unless exactly one input is
// declared; never defaults to latest-history discovery. No node calls: the head comes from
// preflight.json.
//
//   FE173_INPUT=checkpoint FE173_CHECKPOINT=<Codex-provided checkpoint.json>
//       version 1, filterDigest equal to this run's digest, verifiedBlock <= head, and replay span
//       head - max(verifiedBlock + 1 - overlap, trackedSinceBlock) + 1 <= MAX_SPAN_BLOCKS.
//   FE173_INPUT=discovery FE173_DISCOVERY_BLOCKS=<1..MAX_SPAN_BLOCKS>
//       START_BLOCK = head - N + 1: only o1 pools whose Initialize is in those N blocks are tracked.
//
// Both modes pin RPC_MIN_INTERVAL_MS, MAX_BACKFILL_BLOCKS (MAX_SPAN_BLOCKS + 100 for head drift; it
// also caps every later reconnect replay, truncation reported as incomplete coverage) and
// MAX_RECOVER_BLOCKS. The preflight must be fresh and at most PREFLIGHT_MAX_AGE_S old.
// usage: node plan-inputs.mjs --preflight preflight.json --out-env inputs.env --out-budget budget.json
// exit 0 = planned, 3 = refused, 2 = usage
import fs from "node:fs";
import path from "node:path";

const MAX_SPAN_BLOCKS = 1800; // ~1 h of Base blocks; raising it means a new reviewed commit
const MAX_BACKFILL_BLOCKS = MAX_SPAN_BLOCKS + 100; // head drift between preflight and collector start
const PREFLIGHT_MAX_AGE_S = 120;
const RPC_MIN_INTERVAL_MS = 250;
const CHUNK_BLOCKS = 500;
const MAX_RECOVER_BLOCKS = 500;
const FILTERS = 2;

const here = path.dirname(new URL(import.meta.url).pathname);
const FE = process.env.FE ?? path.resolve(here, "../..");
const { loadSettings, filterDigest } = await import(`${FE}/modules/base-collector/dist/index.js`);
const a = process.argv.slice(2);
const opt = (k) => {
  const i = a.indexOf(`--${k}`);
  return i >= 0 ? a[i + 1] : undefined;
};
const pf = opt("preflight");
const outEnv = opt("out-env");
const outBudget = opt("out-budget");
if (!pf || !outEnv || !outBudget) {
  process.stderr.write("usage: node plan-inputs.mjs --preflight F --out-env F --out-budget F\n");
  process.exit(2);
}
const refuse = (why) => {
  process.stderr.write(`plan-inputs: REFUSED: ${why}\n`);
  process.exit(3);
};
const pre = JSON.parse(fs.readFileSync(pf, "utf8"));
if (pre.fresh !== true || !Number.isSafeInteger(pre.head)) refuse("preflight is not fresh");
const preAgeS = (Date.now() - (pre.http?.at(-1)?.atMs ?? 0)) / 1000;
if (preAgeS > PREFLIGHT_MAX_AGE_S) refuse(`preflight is ${Math.round(preAgeS)} s old (max ${PREFLIGHT_MAX_AGE_S})`);
const head = pre.head;
const cfg = loadSettings(process.env);
const digest = filterDigest(cfg);
const calls = (blocks) => FILTERS * Math.ceil(blocks / CHUNK_BLOCKS);
const env = {
  BASE_COLLECTOR_RPC_MIN_INTERVAL_MS: RPC_MIN_INTERVAL_MS,
  BASE_COLLECTOR_BACKFILL_CHUNK_BLOCKS: CHUNK_BLOCKS,
  BASE_COLLECTOR_MAX_BACKFILL_BLOCKS: MAX_BACKFILL_BLOCKS,
  BASE_COLLECTOR_MAX_RECOVER_BLOCKS: MAX_RECOVER_BLOCKS,
  BASE_COLLECTOR_PERSIST_START_BLOCK: head,
};
const mode = process.env.FE173_INPUT;
let input;
if (mode === "discovery") {
  const nBlocks = Number(process.env.FE173_DISCOVERY_BLOCKS);
  if (!Number.isSafeInteger(nBlocks) || nBlocks < 1 || nBlocks > MAX_SPAN_BLOCKS) refuse(`FE173_DISCOVERY_BLOCKS must be an integer in 1..${MAX_SPAN_BLOCKS}`);
  if (process.env.FE173_CHECKPOINT) refuse("declare exactly one input (discovery and checkpoint both set)");
  env.BASE_COLLECTOR_START_BLOCK = head - nBlocks + 1;
  input = { mode, fromBlock: head - nBlocks + 1, toBlock: head, replayBlocks: nBlocks, note: "tracks only o1 pools initialized in this range; older pools are untracked" };
} else if (mode === "checkpoint") {
  const f = process.env.FE173_CHECKPOINT;
  if (!f || !fs.existsSync(f)) refuse("FE173_CHECKPOINT must name an existing Codex-provided checkpoint.json");
  if (process.env.FE173_DISCOVERY_BLOCKS) refuse("declare exactly one input (discovery and checkpoint both set)");
  const cp = JSON.parse(fs.readFileSync(f, "utf8"));
  if (cp.version !== 1) refuse("checkpoint version is not 1");
  if (cp.filterDigest !== digest) refuse(`checkpoint filterDigest ${cp.filterDigest} != run digest ${digest}`);
  if (!Number.isSafeInteger(cp.verifiedBlock)) refuse("checkpoint verifiedBlock is not a block number");
  if (cp.verifiedBlock > head) refuse(`checkpoint verifiedBlock ${cp.verifiedBlock} is above head ${head}`);
  if (!Array.isArray(cp.pools)) refuse("checkpoint pools is not an array");
  const from = Math.max(cp.verifiedBlock + 1 - cfg.overlapBlocks, cp.trackedSinceBlock ?? 0);
  const span = head - from + 1;
  if (span > MAX_SPAN_BLOCKS) refuse(`checkpoint replay span ${span} blocks exceeds ${MAX_SPAN_BLOCKS}; ask Codex for a fresher checkpoint`);
  input = { mode, checkpoint: f, fromBlock: from, toBlock: head, replayBlocks: span, pools: cp.pools.length };
} else {
  refuse("no input prerequisite declared: set FE173_INPUT=checkpoint with FE173_CHECKPOINT, or FE173_INPUT=discovery with FE173_DISCOVERY_BLOCKS");
}
const budget = {
  tool: "plan-inputs",
  head,
  filterDigest: digest,
  input,
  cadence: { rpcMinIntervalMs: RPC_MIN_INTERVAL_MS, chunkBlocks: CHUNK_BLOCKS, filters: FILTERS },
  httpCalls: {
    preflight: pre.calls?.http ?? 2,
    initialReplay: 1 + calls(input.replayBlocks),
    perCollectorReconnectMax: 1 + calls(MAX_BACKFILL_BLOCKS),
    perPersisterRecoverRequestMax: calls(MAX_RECOVER_BLOCKS),
    perHeadPublishRetryMax: calls(MAX_RECOVER_BLOCKS),
    verifyPersistPer1000Blocks: calls(1000),
  },
  stopIf: ["collect.log shows repeated publish_retry or reconnect loops", "collect.log 'reconnect backfill truncated'"],
};
fs.writeFileSync(outEnv, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
fs.writeFileSync(outBudget, `${JSON.stringify(budget, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ input, initialReplayCalls: budget.httpCalls.initialReplay })}\n`);

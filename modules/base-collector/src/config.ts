import { BaseCollectorSettingsSchema, type BaseCollectorSettings } from "../settings.js";

const NUMERIC_KEYS = [
  "startBlock",
  "confirmBlocks",
  "overlapBlocks",
  "backfillChunkBlocks",
  "maxBackfillBlocks",
  "maxRecoverBlocks",
  "retainBlocks",
  "maxTrackedPools",
  "poolIdleBlocks",
  "maxPendingSwaps",
  "rpcMinIntervalMs",
  "rpcTimeoutMs",
  "reconnectBaseMs",
  "reconnectMaxMs",
  "statusIntervalMs",
  "checkpointIntervalMs",
  "persisterTimeoutMs",
  "rateAlertPerSec",
  "persistBatchSize",
  "persistFlushMs",
  "persistMaxQueue",
  "persistHeartbeatMs",
  "persistRecoverIntervalMs",
  "persistRecoverOverlapBlocks",
  "persistMissingSealGraceBlocks",
] as const;

const STRING_KEYS = ["wsUrl", "httpUrl", "natsUrl", "databaseUrl", "stateDir", "poolManager"] as const;
const LIST_KEYS = ["extraHooks", "extraPoolIds"] as const;

/** `wsUrl` -> `BASE_COLLECTOR_WS_URL` */
export function envName(key: string): string {
  return `BASE_COLLECTOR_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

export function loadSettings(env: NodeJS.ProcessEnv): BaseCollectorSettings {
  const raw: Record<string, unknown> = {};
  for (const k of STRING_KEYS) {
    const v = env[envName(k)];
    if (v !== undefined && v !== "") raw[k] = v;
  }
  for (const k of NUMERIC_KEYS) {
    const v = env[envName(k)];
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${envName(k)} is not a number: ${v}`);
    raw[k] = n;
  }
  for (const k of LIST_KEYS) {
    const v = env[envName(k)];
    if (v !== undefined && v !== "") raw[k] = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  const suites = env[envName("suitesJson")];
  if (suites !== undefined && suites !== "") raw.suites = JSON.parse(suites) as unknown;
  const parsed = BaseCollectorSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${envName(String(i.path[0] ?? ""))}: ${i.message}`).join("; ");
    throw new Error(`invalid base-collector settings: ${issues}`);
  }
  return parsed.data;
}

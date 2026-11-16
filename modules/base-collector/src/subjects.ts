import { createHash } from "node:crypto";

import { SUBJECT_PREFIX as P, TOPIC_INITIALIZE, TOPIC_SWAP } from "./constants.js";
import type { DeliveryPath, EventKind } from "./types.js";
import type { BaseCollectorSettings } from "../settings.js";

export const LIVE_LOG_SUBJECTS = [`${P}.initialize`, `${P}.swap`, `${P}.factory`, `${P}.removed.*`] as const;
export const BACKFILL_WILDCARD = `${P}.backfill.>`;
export const SEAL_LIVE = `${P}.seal`;
export const SEAL_BACKFILL = `${P}.backfill.seal`;
export const STATUS = `${P}.ctl.status`;
export const RECOVER = `${P}.ctl.recover`;
export const PERSISTER = `${P}.ctl.persister`;
export const ALL = `${P}.>`;

/** Live subjects carry only records first observed on the persistent subscription. */
export function logSubject(kind: EventKind, path: DeliveryPath, removed: boolean): string {
  const base = path === "live" ? P : `${P}.backfill`;
  return removed ? `${base}.removed.${kind}` : `${base}.${kind}`;
}

export function isLiveLogSubject(subject: string): boolean {
  return (
    subject === `${P}.initialize` ||
    subject === `${P}.swap` ||
    subject === `${P}.factory` ||
    subject.startsWith(`${P}.removed.`)
  );
}

export type LogFilter = { address: string[]; topics?: string[][] };

/** The node-side filters. Shared verbatim by the collector and the measurement harness. */
export function buildFilters(s: Pick<BaseCollectorSettings, "poolManager" | "suites">): LogFilter[] {
  return [
    { address: [s.poolManager], topics: [[TOPIC_INITIALIZE, TOPIC_SWAP]] },
    { address: s.suites.map((x) => x.factory).sort() },
  ];
}

export function hookSuites(s: Pick<BaseCollectorSettings, "suites" | "extraHooks">): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const h of s.extraHooks) m.set(h, null);
  for (const x of s.suites) m.set(x.hook, x.name);
  return m;
}

export function filterDigest(s: Pick<BaseCollectorSettings, "poolManager" | "suites" | "extraHooks" | "extraPoolIds">): string {
  const spec = {
    filters: buildFilters(s),
    hooks: [...hookSuites(s).keys()].sort(),
    extraPoolIds: [...s.extraPoolIds].sort(),
  };
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

export function sealDigest(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const encodeJson = (x: unknown): Uint8Array => encoder.encode(JSON.stringify(x));
export const decodeJson = (b: Uint8Array): unknown => JSON.parse(decoder.decode(b)) as unknown;

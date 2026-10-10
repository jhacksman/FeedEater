// Deterministic Tier-1 decode: a pure function of (raw bytes, registry version, decoder version).
export const DECODER_VERSION = "synthetic-dec/1";
export const REGISTRY_VERSION = "synthetic-reg/1";

const canon = (v) =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
    : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
      : JSON.stringify(v);

export function decode(raw, registryVersion = REGISTRY_VERSION, decoderVersion = DECODER_VERSION) {
  let m;
  try { m = JSON.parse(raw.toString("utf8")); } catch { return { dec: decoderVersion, reg: registryVersion, status: "undecodable", bytes: raw.length }; }
  const r = m?.params?.result;
  if (m?.method !== "eth_subscription" || r === undefined || r === null) return { dec: decoderVersion, reg: registryVersion, status: "not_a_log" };
  return {
    dec: decoderVersion, reg: registryVersion, status: "log",
    subscription: String(m.params.subscription).toLowerCase(),
    address: String(r.address).toLowerCase(), topics: r.topics.map((t) => String(t).toLowerCase()), data: String(r.data).toLowerCase(),
    blockNumber: Number.parseInt(r.blockNumber, 16), blockHash: String(r.blockHash).toLowerCase(),
    txHash: String(r.transactionHash).toLowerCase(), logIndex: Number.parseInt(r.logIndex, 16), removed: r.removed === true,
  };
}

export const tier1Line = (raw) => canon(decode(raw));

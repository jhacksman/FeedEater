export enum EventType {
  PROTOCOL_HACK = "protocol_hack",
  WHALE_TRANSFER = "whale_transfer",
  GOVERNANCE_VOTE = "governance_vote",
  GOVERNANCE_PROPOSAL = "governance_proposal",
  GOVERNANCE_EXECUTION = "governance_execution",
  TOKEN_LISTING = "token_listing",
  TOKEN_DELISTING = "token_delisting",
  LIQUIDATION = "liquidation",
  LIQUIDATION_CASCADE = "liquidation_cascade",
  CONTRACT_DEPLOYMENT = "contract_deployment",
  BRIDGE_DEPOSIT = "bridge_deposit",
  BRIDGE_WITHDRAWAL = "bridge_withdrawal",
  STABLECOIN_DEPEG = "stablecoin_depeg",
  PRICE_MOVEMENT = "price_movement",
  ELECTION = "election",
  REGULATION = "regulation",
  UNKNOWN = "unknown",
}

export enum Severity {
  CRITICAL = "critical",
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
  INFO = "info",
}

export type EventClassification = {
  eventType: EventType;
  severity: Severity;
  confidence: number;
  valueUsd?: number;
  affectedProtocol?: string;
  affectedToken?: string;
  sourceChain?: string;
  destinationChain?: string;
  metadata: Record<string, unknown>;
};

export const KNOWN_EXCHANGES: Record<string, string> = {
  "0x28C6c06298d514Db089934071355E5743bf21d60": "Binance",
  "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549": "Binance",
  "0xDFd5293D8e347dFe59E90eFd55b2956a1343963d": "Binance",
  "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3": "Coinbase",
  "0x503828976D22510aad0201ac7EC88293211D23Da": "Coinbase",
  "0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43": "Coinbase",
  "0x267be1C1D684F78cb4F6a176C4911b741E4Ffdc0": "Kraken",
};

export const KNOWN_LENDING: Record<string, string> = {
  "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2": "Aave V3",
  "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9": "Aave V2",
  "0xc3d688B66703497DAA19211EEdff47f25384cdc3": "Compound V3",
  "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B": "Compound V2",
};

export const KNOWN_BRIDGES: Record<string, string> = {
  "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a": "Arbitrum Bridge",
  "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1": "Optimism Bridge",
  "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77": "Polygon Bridge",
  "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B": "Wormhole",
  "0x8731d54E9D02c286767d56ac03e8037C07e01e98": "Stargate",
};

export const KNOWN_STABLECOINS: Record<string, string> = {
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": "USDT",
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC",
  "0x6B175474E89094C44Da98b954EescdeCB5": "DAI",
  "0x853d955aCEf822Db058eb8505911ED77F175b99e": "FRAX",
  "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0": "LUSD",
};

export const TICKER_TO_ASSET: Record<string, { symbol: string; venues: string[] }> = {
  KXBTCD: { symbol: "BTC/USD", venues: ["coinbase", "binance", "kraken", "uniswap"] },
  KXBTC: { symbol: "BTC/USD", venues: ["coinbase", "binance", "kraken", "uniswap"] },
  KXETHD: { symbol: "ETH/USD", venues: ["coinbase", "binance", "kraken", "uniswap"] },
  KXETH: { symbol: "ETH/USD", venues: ["coinbase", "binance", "kraken", "uniswap"] },
  KXSOLD: { symbol: "SOL/USD", venues: ["coinbase", "binance", "kraken", "raydium"] },
  KXSOL: { symbol: "SOL/USD", venues: ["coinbase", "binance", "kraken", "raydium"] },
  BTC: { symbol: "BTC/USD", venues: ["coinbase", "binance", "kraken", "uniswap"] },
  ETH: { symbol: "ETH/USD", venues: ["coinbase", "binance", "kraken", "uniswap"] },
  SOL: { symbol: "SOL/USD", venues: ["coinbase", "binance", "kraken", "raydium"] },
};

export const CATEGORY_KEYWORDS: Record<string, EventType> = {
  hack: EventType.PROTOCOL_HACK,
  exploit: EventType.PROTOCOL_HACK,
  breach: EventType.PROTOCOL_HACK,
  whale: EventType.WHALE_TRANSFER,
  governance: EventType.GOVERNANCE_VOTE,
  vote: EventType.GOVERNANCE_VOTE,
  proposal: EventType.GOVERNANCE_PROPOSAL,
  listing: EventType.TOKEN_LISTING,
  delist: EventType.TOKEN_DELISTING,
  liquidat: EventType.LIQUIDATION,
  bridge: EventType.BRIDGE_DEPOSIT,
  depeg: EventType.STABLECOIN_DEPEG,
  price: EventType.PRICE_MOVEMENT,
  election: EventType.ELECTION,
  regulat: EventType.REGULATION,
  sec: EventType.REGULATION,
  fed: EventType.PRICE_MOVEMENT,
  inflation: EventType.PRICE_MOVEMENT,
  rate: EventType.PRICE_MOVEMENT,
};

export function classifyMarketText(text: string): EventClassification {
  const lower = text.toLowerCase();

  for (const [keyword, eventType] of Object.entries(CATEGORY_KEYWORDS)) {
    if (lower.includes(keyword)) {
      return {
        eventType,
        severity: Severity.MEDIUM,
        confidence: 0.7,
        metadata: { matchedKeyword: keyword },
      };
    }
  }

  return {
    eventType: EventType.UNKNOWN,
    severity: Severity.INFO,
    confidence: 0.0,
    metadata: {},
  };
}

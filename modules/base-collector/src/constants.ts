export const SUBJECT_PREFIX = "feedeater.base_collector";

/** Uniswap v4 PoolManager on Base. */
export const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";

/** keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)") */
export const TOPIC_INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
/** keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)") */
export const TOPIC_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

export type O1Suite = {
  name: string;
  factory: string;
  hook: string;
  firstBlock: number;
};

/**
 * The six published o1 launch suites on Base, from DefiLlama dimension-adapters
 * fees/o1-launchpad/config.ts. Attribution is owned by A3 (first report #336, review pending);
 * these are defaults and can be replaced through settings.
 */
export const O1_SUITES: readonly O1Suite[] = [
  {
    name: "base-mainnet-block-v1",
    factory: "0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64",
    hook: "0xa068cf4c52abdd3479145c4b3cbd8e3d71542a44",
    firstBlock: 48364845,
  },
  {
    name: "base-mainnet-timestamp-v2",
    factory: "0xa52ad458ce0282a971ecc71c051a32f28946bb9f",
    hook: "0x985c14baa2a18316ffda0aefb3a632fadfca2acc",
    firstBlock: 48451098,
  },
  {
    name: "base-mainnet-rwa-timestamp-v3",
    factory: "0x1de58a6769526a03a504d9d59b8757cd8097dc57",
    hook: "0xbca7774615c74b7991a111f1c7b2d0efea61aacc",
    firstBlock: 49121014,
  },
  {
    name: "base-mainnet-rwa-timestamp-v4",
    factory: "0xff70918ef17a2d74d683a8297813b177bafad1f4",
    hook: "0x3b2b979df21036cee51b8debb13100e2cb8deacc",
    firstBlock: 50137081,
  },
  {
    name: "base-mainnet-launchpad-v4-minimal-pre-atomic",
    factory: "0xb9e5910043353717af54d8dd34b6ee57ffe49c35",
    hook: "0xdda9bc41e324ef379e774ae1f7b062d23ea8aacc",
    firstBlock: 50505676,
  },
  {
    name: "base-mainnet-launchpad-v4-minimal",
    factory: "0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc",
    hook: "0x1f91c998e7c2f4b690d75bdbf6502bdcd6e02acc",
    firstBlock: 50579785,
  },
];

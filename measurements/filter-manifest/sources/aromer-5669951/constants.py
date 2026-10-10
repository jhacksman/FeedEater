"""Verified Base mainnet constants: tokens, factories, quoters, routers, oracle feeds, predeploys, event topics.

Every address carries its primary source and how it was verified. "probe" means the read-only architect probe
of 2026-10-04 (docs/replay/evidence/probe_*.py and *.out.json): factory()/WETH()/poolManager() equality and a
successful quote or call on the owner's node.

Event signatures are vendored from the owner's archive tool (origin:
/Volumes/T7SHIELD/PROJECT_AROMER/aromer-data/tools/aromer_archive/events.py, which pins them to the protocols' interface
sources). Topic0 values are recomputed with keccak at import time and asserted, so a typo fails loudly.
"""
from __future__ import annotations

from dataclasses import dataclass

from .canonical import keccak256
from .ids import CHAIN_ID_BASE, AssetUid, PoolUid, Venue, asset_uid, pool_uid, to_address


@dataclass(frozen=True, slots=True)
class ContractRef:
    name: str
    address: bytes
    source: str
    verified: str


def _c(name: str, address: str, source: str, verified: str) -> ContractRef:
    return ContractRef(name, to_address(address), source, verified)


# ---------------------------------------------------------------------------------------------- tokens (IDN-005)
@dataclass(frozen=True, slots=True)
class KnownToken:
    symbol: str  # display only
    address: bytes
    decimals: int
    uid: AssetUid
    note: str


def _t(symbol: str, address: str, decimals: int, note: str) -> KnownToken:
    a = to_address(address)
    return KnownToken(symbol, a, decimals, asset_uid(a), note)


USDC = _t("USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "Circle native USDC; the numeraire (RSK-101)")
USDBC = _t("USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 6, "bridged USDC; a different asset from USDC")
USDT = _t("USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6, "bridged USDT")
DAI = _t("DAI", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18, "bridged DAI")
WETH = _t("WETH", "0x4200000000000000000000000000000000000006", 18, "OP-stack WETH9 predeploy; 1:1 wrap of native ETH")
CBETH = _t("cbETH", "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", 18,
           "bridged (L2 standard bridge); exchangeRate() reverts on Base; rate via Chainlink feed")
WSTETH = _t("wstETH", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", 18, "bridged wstETH; rate via Chainlink feed")
CBBTC = _t("cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8, "Coinbase BTC")
WBTC = _t("WBTC", "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", 8, "thin")
AERO = _t("AERO", "0x940181a94A35A4569E4529A3CDfB74e38FD98631", 18, "Aerodrome token")
VIRTUAL = _t("VIRTUAL", "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", 18, "issuer not confirmed")
EURC = _t("EURC", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", 6, "issuer not confirmed")

KNOWN_TOKENS: tuple[KnownToken, ...] = (USDC, USDBC, USDT, DAI, WETH, CBETH, WSTETH, CBBTC, WBTC, AERO, VIRTUAL, EURC)
KNOWN_TOKENS_BY_UID: dict[AssetUid, KnownToken] = {t.uid: t for t in KNOWN_TOKENS}
NATIVE_ETH: AssetUid = asset_uid(None)

# The 8 tokens whose Transfer logs are in the archive dataset erc20_transfers (aromer_archive/tokens.py).
ARCHIVED_TRANSFER_TOKENS: frozenset[AssetUid] = frozenset(
    t.uid for t in (USDC, WETH, CBBTC, AERO, USDT, CBETH, EURC, VIRTUAL)
)

# Asset tiers (s07 RSK-103). Tier B = any other token that passes screening; X = everything else.
TIER_S_ASSETS: frozenset[AssetUid] = frozenset({USDC.uid})
TIER_A_ASSETS: frozenset[AssetUid] = frozenset({WETH.uid, CBBTC.uid, CBETH.uid, WSTETH.uid})
ETH_BETA_GROUP: frozenset[AssetUid] = frozenset({WETH.uid, CBETH.uid, WSTETH.uid})  # RSK-201

# ---------------------------------------------------------------------------------------------- venues (IDN-008)
UNISWAP_V2_FACTORY = _c("Uniswap V2 Factory", "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
                        "uniswap-v2-deployments.mdx (BNL sources)", "archive verify_factories; router factory() probe")
UNISWAP_V3_FACTORY = _c("Uniswap V3 Factory", "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
                        "uniswap-v3-base-deployments.mdx", "BNL pool_factories.json; quoter factory() probe")
UNISWAP_V4_POOL_MANAGER = _c("Uniswap V4 PoolManager", "0x498581fF718922c3f8e6A244956aF099B2652b2b",
                             "uniswap-v4-deployments.mdx (Base: 8453)", "v4 quoter poolManager() probe")
AERODROME_V2_FACTORY = _c("Aerodrome v2 PoolFactory", "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
                          "aerodrome-contracts-README.md", "router defaultFactory() probe")
SLIPSTREAM_FACTORY_INITIAL = _c("Slipstream CLFactory (initial)", "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
                                "aerodrome-slipstream-README.md", "quoter factory() probe")
SLIPSTREAM_FACTORY_GAUGECAPS = _c("Slipstream CLFactory (gauge caps)", "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a",
                                  "aerodrome-slipstream-README.md", "quoter factory() probe")
SLIPSTREAM_FACTORY_GAUGESV3 = _c("Slipstream CLFactory (gauges v3)", "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
                                 "aerodrome-slipstream-README.md", "quoter factory() probe")

FACTORY_VENUES: dict[bytes, Venue] = {
    UNISWAP_V2_FACTORY.address: Venue.UNISWAP_V2,
    UNISWAP_V3_FACTORY.address: Venue.UNISWAP_V3,
    AERODROME_V2_FACTORY.address: Venue.AERODROME_V2,
    SLIPSTREAM_FACTORY_INITIAL.address: Venue.AERODROME_SLIPSTREAM,
    SLIPSTREAM_FACTORY_GAUGECAPS.address: Venue.AERODROME_SLIPSTREAM,
    SLIPSTREAM_FACTORY_GAUGESV3.address: Venue.AERODROME_SLIPSTREAM,
}

# ---------------------------------------------------------------------------------------------- quoters
UNISWAP_V3_QUOTER_V2 = _c("Uniswap V3 QuoterV2", "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
                          "uniswap-v3-base-deployments.mdx", "probe: factory()==V3 factory; BNL quotes")
UNISWAP_V4_QUOTER = _c("Uniswap V4 Quoter", "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
                       "uniswap-v4-deployments.mdx (Base)", "probe: poolManager()==PoolManager; BNL quotes")
UNISWAP_V4_STATE_VIEW = _c("Uniswap V4 StateView", "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
                           "uniswap-v4-deployments.mdx (Base)", "S5C quote ladder (getLiquidity)")
UNISWAP_V4_POSITION_MANAGER = _c("Uniswap V4 PositionManager", "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
                                 "uniswap-v4-deployments.mdx (Base)", "not probed (poolKeys used by C1)")
SLIPSTREAM_QUOTER_INITIAL = _c("Slipstream QuoterV2 (initial)", "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
                               "aerodrome-slipstream-README.md", "probe: factory()==initial; quotes ts100/50/1 ok")
SLIPSTREAM_QUOTER_GAUGECAPS = _c("Slipstream Quoter (gauge caps)", "0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C",
                                 "aerodrome-slipstream-README.md", "probe: factory()==gaugecaps; quote ts50 ok")
SLIPSTREAM_QUOTER_GAUGESV3 = _c("Slipstream Quoter (gauges v3)", "0x514c8B5f54112481E28028F1166Bd78501089259",
                                "aerodrome-slipstream-README.md", "probe: factory()==gaugesv3; quotes ts50/1 ok")
AERODROME_V2_ROUTER = _c("Aerodrome v2 Router", "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
                         "aerodrome-contracts-README.md", "probe: defaultFactory()==v2 factory, weth()==WETH")
UNISWAP_V2_ROUTER02 = _c("Uniswap V2 Router02", "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
                         "uniswap-v2-deployments.mdx (Base)", "probe: factory()==V2 factory, WETH()==WETH")

# Quoter used for each factory (Slipstream quoters only quote pools of their own factory).
QUOTER_FOR_FACTORY: dict[bytes, ContractRef] = {
    UNISWAP_V3_FACTORY.address: UNISWAP_V3_QUOTER_V2,
    SLIPSTREAM_FACTORY_INITIAL.address: SLIPSTREAM_QUOTER_INITIAL,
    SLIPSTREAM_FACTORY_GAUGECAPS.address: SLIPSTREAM_QUOTER_GAUGECAPS,
    SLIPSTREAM_FACTORY_GAUGESV3.address: SLIPSTREAM_QUOTER_GAUGESV3,
    AERODROME_V2_FACTORY.address: AERODROME_V2_ROUTER,  # getAmountsOut
    UNISWAP_V2_FACTORY.address: UNISWAP_V2_ROUTER02,  # getAmountsOut
}

# ---------------------------------------------------------------------------------------------- routers (sell-sim, calldata size)
UNISWAP_V3_SWAP_ROUTER02 = _c("Uniswap SwapRouter02", "0x2626664c2603336E57B271c5C0b26F421741e481",
                              "uniswap-v3-base-deployments.mdx", "probe: factory()==V3, WETH9()==WETH")
SLIPSTREAM_SWAP_ROUTER_INITIAL = _c("Slipstream SwapRouter (initial)", "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
                                    "aerodrome-slipstream-README.md", "probe: factory()==initial, WETH9()==WETH")
SLIPSTREAM_SWAP_ROUTER_GAUGECAPS = _c("Slipstream SwapRouter (gauge caps)", "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D",
                                      "aerodrome-slipstream-README.md", "probe: factory()==gaugecaps, WETH9()==WETH")
SLIPSTREAM_SWAP_ROUTER_GAUGESV3 = _c("Slipstream SwapRouter (gauges v3)", "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
                                     "aerodrome-slipstream-README.md", "probe: factory()==gaugesv3, WETH9()==WETH")
UNISWAP_UNIVERSAL_ROUTER = _c("Uniswap UniversalRouter", "0x6fF5693b99212Da76ad316178A184AB56D299b43",
                              "uniswap-v3/v4 deployments (Base)", "not probed; v4 routes are out of v1 scope")

ROUTER_FOR_FACTORY: dict[bytes, ContractRef] = {
    UNISWAP_V3_FACTORY.address: UNISWAP_V3_SWAP_ROUTER02,
    SLIPSTREAM_FACTORY_INITIAL.address: SLIPSTREAM_SWAP_ROUTER_INITIAL,
    SLIPSTREAM_FACTORY_GAUGECAPS.address: SLIPSTREAM_SWAP_ROUTER_GAUGECAPS,
    SLIPSTREAM_FACTORY_GAUGESV3.address: SLIPSTREAM_SWAP_ROUTER_GAUGESV3,
    AERODROME_V2_FACTORY.address: AERODROME_V2_ROUTER,
    UNISWAP_V2_FACTORY.address: UNISWAP_V2_ROUTER02,
}

# ---------------------------------------------------------------------------------------------- predeploys and oracle feeds
GAS_PRICE_ORACLE = _c("OP GasPriceOracle predeploy", "0x420000000000000000000000000000000000000F",
                      "OP-stack predeploy", "probe: version 1.6.0, isFjord/isIsthmus/isJovian true, getL1FeeUpperBound ok")
L2_STANDARD_BRIDGE = _c("L2StandardBridge predeploy", "0x4200000000000000000000000000000000000010",
                        "OP-stack predeploy", "cbETH.bridge() (s01 probe)")
FEED_CBETH_ETH_EXCHANGE_RATE = _c(
    "Chainlink cbETH-ETH Exchange Rate (proxy)", "0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04",
    "Chainlink feed directory feeds-ethereum-mainnet-base-1.json (fetched 2026-10-04): 18 decimals, "
    "heartbeat 86400 s, deviation 0.5%; aggregator 0x4c78deA223b013511E40B2a08282631A47C53CDE",
    "probe: description()=='cbETH-ETH Exchange Rate', latestRoundData ok at 52,000,000",
)
FEED_WSTETH_STETH_EXCHANGE_RATE = _c(
    "Chainlink wstETH-stETH Exchange Rate (proxy)", "0xB88BAc61a4Ca37C43a3725912B1f472c9A5bc061",
    "Chainlink feed directory feeds-ethereum-mainnet-base-1.json (fetched 2026-10-04): 18 decimals, "
    "heartbeat 86400 s, deviation 1e-7; aggregator 0x1e536d8f053feaB16c65861B7A3462b5b5AcD3A2",
    "probe: description()=='wstETH-stETH Exchange Rate', latestRoundData ok at 52,000,000",
)
# Market-price feeds: NOT fundamentals; never use them as an LST reference rate.
FEED_CBETH_ETH_MARKET = _c("Chainlink CBETH / ETH (market price)", "0x806b4Ac04501c29769051e42783cF04dCE41440b",
                           "Chainlink feed directory", "s01 probe description()=='CBETH / ETH'")
FEED_WSTETH_ETH_MARKET = _c("Chainlink WSTETH / ETH (market price)", "0x43a5C292A453A3bF3606fa856197f09D7B74251a",
                            "Chainlink feed directory", "not probed")

# LST fundamentals for S1 (s02 IDN-006 LST_RATE; relation hops are recorded with every observation).
LST_REFERENCE_FEEDS: dict[AssetUid, tuple[ContractRef, tuple[str, ...]]] = {
    CBETH.uid: (FEED_CBETH_ETH_EXCHANGE_RATE, ("LST_RATE:cbETH->ETH(chainlink exchange rate)", "WRAP_1TO1:ETH->WETH")),
    WSTETH.uid: (FEED_WSTETH_STETH_EXCHANGE_RATE,
                 ("LST_RATE:wstETH->stETH(chainlink exchange rate)", "ASSUMPTION:stETH==ETH", "WRAP_1TO1:ETH->WETH")),
}

# Reference WETH/USDC pool for valuing gas and WETH (deepest 5 bp pool; BNL quote pool; s01 vol pool).
REFERENCE_WETH_USDC_POOL: PoolUid = pool_uid(Venue.UNISWAP_V3, address="0xd0b53d9277642d899df5c87a3966a349a798f224")

# Uniswap V2 pairs charge a fixed 0.30% (UniswapV2Pair.swap: balance*1000 - amountIn*3); the only static fee
# outside the V3 tiers. Aerodrome v2 fees are per pool and changeable (PoolFactory.getFee), Slipstream fees are
# dynamic per swap: both come from the swap logs (PoolState), never from a registry read (FL-3).
UNISWAP_V2_FEE_PPM = 3_000


# ---------------------------------------------------------------------------------------------- proxy screens (RSK-304d)
def _eip1967_slot(label: str, expected: str) -> int:
    slot = int.from_bytes(keccak256(label.encode("ascii")), "big") - 1
    if slot != int(expected, 16):
        raise AssertionError(f"EIP-1967 slot mismatch for {label}")
    return slot


EIP1967_IMPLEMENTATION_SLOT = _eip1967_slot("eip1967.proxy.implementation",
                                            "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")
EIP1967_ADMIN_SLOT = _eip1967_slot("eip1967.proxy.admin",
                                   "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103")
EIP1967_BEACON_SLOT = _eip1967_slot("eip1967.proxy.beacon",
                                    "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50")
EIP1967_SLOTS: tuple[int, ...] = (EIP1967_IMPLEMENTATION_SLOT, EIP1967_ADMIN_SLOT, EIP1967_BEACON_SLOT)

# ---------------------------------------------------------------------------------------------- event topics
@dataclass(frozen=True, slots=True)
class EventSig:
    name: str
    signature: str
    topic0: bytes
    emitter: str


_EVENT_TABLE: tuple[tuple[str, str, str, str], ...] = (
    # name, canonical signature, expected topic0 (hex), emitter description
    ("univ2_swap", "Swap(address,uint256,uint256,uint256,uint256,address)",
     "d78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", "V2 pairs"),
    ("v2_mint", "Mint(address,uint256,uint256)",
     "4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f", "V2 pairs + Aerodrome v2 pools"),
    ("univ2_burn", "Burn(address,uint256,uint256,address)",
     "dccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496", "V2 pairs"),
    ("univ2_sync", "Sync(uint112,uint112)",
     "1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1", "V2 pairs"),
    ("univ2_pair_created", "PairCreated(address,address,address,uint256)",
     "0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9", "V2 factories"),
    ("v3_swap", "Swap(address,address,int256,int256,uint160,uint128,int24)",
     "c42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", "V3 + Slipstream CL pools"),
    ("v3_mint", "Mint(address,address,int24,int24,uint128,uint256,uint256)",
     "7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde", "V3 + Slipstream CL pools"),
    ("v3_burn", "Burn(address,int24,int24,uint128,uint256,uint256)",
     "0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c", "V3 + Slipstream CL pools"),
    ("v3_initialize", "Initialize(uint160,int24)",
     "98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95", "V3 + Slipstream CL pools"),
    ("univ3_pool_created", "PoolCreated(address,address,uint24,int24,address)",
     "783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118", "V3 factories"),
    ("v4_initialize", "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
     "dd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", "V4 PoolManager"),
    ("v4_modify_liquidity", "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
     "f208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", "V4 PoolManager"),
    ("v4_swap", "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
     "40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "V4 PoolManager"),
    ("v4_donate", "Donate(bytes32,address,uint256,uint256)",
     "29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb", "V4 PoolManager"),
    ("aero_v2_swap", "Swap(address,address,uint256,uint256,uint256,uint256)",
     "b3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b", "Aerodrome v2 pools"),
    ("aero_v2_burn", "Burn(address,address,uint256,uint256)",
     "5d624aa9c148153ab3446c1b154f660ee7701e549fe9b62dab7171b1c80e6fa2", "Aerodrome v2 pools"),
    ("aero_v2_sync", "Sync(uint256,uint256)",
     "cf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a", "Aerodrome v2 pools"),
    ("aero_v2_pool_created", "PoolCreated(address,address,bool,address,uint256)",
     "2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e", "Aerodrome v2 PoolFactory"),
    ("aero_cl_pool_created", "PoolCreated(address,address,int24,address)",
     "ab0d57f0df537bb25e80245ef7748fa62353808c54d6e528a9dd20887aed9ac2", "Slipstream CL factories"),
    ("erc20_transfer", "Transfer(address,address,uint256)",
     "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "ERC-20 tokens (dataset erc20_transfers)"),
)


def _build_events() -> dict[str, EventSig]:
    out: dict[str, EventSig] = {}
    for name, sig, expected, emitter in _EVENT_TABLE:
        t = keccak256(sig.encode("ascii"))
        if t.hex() != expected:
            raise AssertionError(f"topic0 mismatch for {name}: computed {t.hex()} literal {expected}")
        out[name] = EventSig(name, sig, t, emitter)
    return out


EVENTS: dict[str, EventSig] = _build_events()
TOPIC0_TO_EVENT: dict[bytes, str] = {e.topic0: e.name for e in EVENTS.values()}
DEX_EVENT_NAMES: tuple[str, ...] = tuple(n for n in EVENTS if n != "erc20_transfer")
POOL_CREATION_EVENTS: frozenset[str] = frozenset(
    {"univ2_pair_created", "univ3_pool_created", "aero_v2_pool_created", "aero_cl_pool_created", "v4_initialize"}
)
SWAP_EVENTS: frozenset[str] = frozenset({"univ2_swap", "v3_swap", "v4_swap", "aero_v2_swap"})

assert CHAIN_ID_BASE == 8453

> ## Documentation Index
> Fetch the complete documentation index at: https://docs.o1.exchange/llms.txt
> Use this file to discover all available pages before exploring further.

# Production contracts

> Current and historical launch contracts, staking contracts, market readiness, Uniswap v4 dependencies, paired assets, and chain-specific token dependencies.

This page lists o1 Launchpad contracts on Base, Robinhood Chain, Monad, Arc, BSC and X Layer, historical suites for earlier tokens, and staking contracts on Base and Robinhood. It also lists the Launchpad of Launchpads contracts on Base and Robinhood.

The Standard suites on Base, Robinhood, Monad, Arc, BSC and X Layer use the `launchpad-v4-minimal` contract family and the same launch, fee, creator-rights, permanent-liquidity, and optional atomic Dev Buy model. The chain-specific token step is the main implementation difference: Base creates and validates a native B20 token, while Robinhood, Monad, Arc, BSC and X Layer create a fixed-supply ERC-20 through a dedicated token deployer. Arc's adapter handles native and ERC-20 USDC funding.

Base Standard and Robinhood contract bindings were verified on September 2, 2026. **Registered quotes on both current Standard and Tax factories across all six chains were refreshed on October 1, 2026**; see the [verification blocks](/launchpad/reference/live-configuration#verification-history). Runtime, router, staking and other configuration evidence retain their own dates below.

<Warning>
  Always confirm the chain ID and active factory before signing. The same-looking address on another chain is not interchangeable.
</Warning>

## Base mainnet

Chain ID `8453`. View the network on [Basescan](https://basescan.org).

<span id="shared-crypto-paired-and-stock-paired-launch-contracts" />

### Standard crypto-paired and stock-paired launch contracts

| Contract | Address |
| - | - |
| Launch factory | [`0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC`](https://basescan.org/address/0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC) |
| Launch hook | [`0x1f91c998e7c2F4b690D75BDBf6502BDcD6e02AcC`](https://basescan.org/address/0x1f91c998e7c2F4b690D75BDBf6502BDcD6e02AcC) |
| Fee escrow | [`0xB3F11a3fb06A88059b7F7F423Ec0Dda506356866`](https://basescan.org/address/0xB3F11a3fb06A88059b7F7F423Ec0Dda506356866) |
| Announcement registry | [`0xAB1243C97a37361115d5Cef7666bf49AD2Fb6BAa`](https://basescan.org/address/0xAB1243C97a37361115d5Cef7666bf49AD2Fb6BAa) |
| B20 Launch Token Validator | [`0x653886f66824E677a5E34c9Cdf8E198519f62A4d`](https://basescan.org/address/0x653886f66824E677a5E34c9Cdf8E198519f62A4d) |
| Launch-buy adapter | [`0xdAaF9B2C5014c5EdD608060Ed92D62529E37aABC`](https://basescan.org/address/0xdAaF9B2C5014c5EdD608060Ed92D62529E37aABC) |
| SwapX router proxy | [`0xC3aCE43169bbF51752B1603067F91eF60f8A662A`](https://basescan.org/address/0xC3aCE43169bbF51752B1603067F91eF60f8A662A) |

This factory has **66 registered quotes: 15 crypto assets and 51 Stock Tokens**, verified at Base block **52,020,531** on October 1, 2026. Creation was enabled with a 0.001 ETH native launch fee and configuration version `17`. The September 10 fee-policy read recorded a 20-second anti-snipe window and creator/platform/referrer components of 50/30/20 bps. The listed SwapX adapter handles optional atomic Dev Buy. See the [stock list](/launchpad/create/stock-paired-launches#base-stock-token-catalog) and [Standard quote data](/launchpad/reference/production-deployments.json).

### Base Tax contracts

**Suite:** `base-mainnet-tax-token-v2` · **Token:** ERC-20 · **First block:** `51,776,790`

Base Tax supports crypto and stock pairs alongside Standard, with a **0.001 ETH** launch fee. Trading taxes include protocol fees, and holder dividends accrue automatically. Contract runtime identities and bindings were verified at **Base block 51,779,077 on September 25, 2026**. See [Tax configuration](/launchpad/reference/live-configuration#base-tax-suite) for the settings.

| Contract | Address |
| - | - |
| Launch factory | [`0x53C59d8d335681d58F564cF62073fA3C57cF81ee`](https://basescan.org/address/0x53C59d8d335681d58F564cF62073fA3C57cF81ee) |
| Tax hook | [`0x9C7155D7216454D9d894F792c8B5C564F2c66AcC`](https://basescan.org/address/0x9C7155D7216454D9d894F792c8B5C564F2c66AcC) |
| Fee escrow | [`0xFae34Bd1311b37d315bF412cc1a4e441F07f4517`](https://basescan.org/address/0xFae34Bd1311b37d315bF412cc1a4e441F07f4517) |
| Token deployer | [`0xBEcbA599C8bd5373ba9C680eA4B3AfFC5C7a4311`](https://basescan.org/address/0xBEcbA599C8bd5373ba9C680eA4B3AfFC5C7a4311) |
| Dividend deployer | [`0xD69aE39E360E6C71780629fb826BdCeeE3a456Ca`](https://basescan.org/address/0xD69aE39E360E6C71780629fb826BdCeeE3a456Ca) |
| Dividend implementation | [`0x9058CEF57492541512bE650B683c31dB1Bcf2a5F`](https://basescan.org/address/0x9058CEF57492541512bE650B683c31dB1Bcf2a5F) |
| Fixed Dividend claim helper | [`0x196C682446F823Ed0078352EF376ac8e94c36E21`](https://basescan.org/address/0x196C682446F823Ed0078352EF376ac8e94c36E21) |
| Operations library | [`0x88F9fb0256D8493D1060C8a29C2ABB4841159422`](https://basescan.org/address/0x88F9fb0256D8493D1060C8a29C2ABB4841159422) |
| Validation helper | [`0x08daA0eCa69a9B1E295e234Fc7C3A9c5020a378c`](https://basescan.org/address/0x08daA0eCa69a9B1E295e234Fc7C3A9c5020a378c) |
| Announcement registry | [`0xBe3eE12329751f1A02aD01584a0E7Ff60589559d`](https://basescan.org/address/0xBe3eE12329751f1A02aD01584a0E7Ff60589559d) |
| Launch-buy adapter | [`0xd9992A49ea2e5801ef3EF6c5C1462711961315FC`](https://basescan.org/address/0xd9992A49ea2e5801ef3EF6c5C1462711961315FC) |

The adapter is bound to this Factory/Hook and uses the existing Base SwapX router listed above. The Standard adapter cannot be substituted. The PoolManager is shared with the Base deployment below. WETH is `0x4200000000000000000000000000000000000006`.

Dividend clones bind to the fixed helper and their own launched token. Use `dividendOf(token)` to resolve a clone rather than calling the implementation for a holder balance. Shared governance addresses do not make Standard and Tax contract bindings interchangeable.

See [Tax settings](/launchpad/reference/live-configuration#base-tax-suite), [Tax contract integration](/launchpad/integration/tax-tokens) and the [configuration data](/launchpad/reference/base-tax-suite.json).

<span id="base-wsto-contracts" />

### Base \$O launch contracts

**Suite:** `base-mainnet-wsto-burn-v1` · **Version:** `wsto-burn-v1` · **Launched token:** ERC-20 · **First block:** `52,196,234`

**\$O launches** use these separate contracts and pair with wstO. There is no FeeEscrow, Dividend clone, creation fee or anti-sniping surcharge. The external wstO vault/token is the quote, not the launched token.

| Contract | Address |
| - | - |
| Launch factory | [`0xAC7Bd3254d7182a32ae3Ce7Fcd0ab86c88fcD91F`](https://basescan.org/address/0xAC7Bd3254d7182a32ae3Ce7Fcd0ab86c88fcD91F) |
| Launch hook | [`0xAa4B4fABf41754E759338778e6031A156EeA6aCc`](https://basescan.org/address/0xAa4B4fABf41754E759338778e6031A156EeA6aCc) |
| Settlement reserve | [`0xAd3A34371e1cB658F8b9a71Ee9526f768dB7E5A5`](https://basescan.org/address/0xAd3A34371e1cB658F8b9a71Ee9526f768dB7E5A5) |
| Token deployer | [`0x37D2D622DF1F446d2a98eC446814C787Ef6bd224`](https://basescan.org/address/0x37D2D622DF1F446d2a98eC446814C787Ef6bd224) |
| Announcement registry | [`0x102C2455dA81E8C040a8b196E6038fF7Eaf66b9D`](https://basescan.org/address/0x102C2455dA81E8C040a8b196E6038fF7Eaf66b9D) |
| Attached Dev Buy adapter | [`0x48cF602b7556A79D69CC7A5a3768c64beC482113`](https://basescan.org/address/0x48cF602b7556A79D69CC7A5a3768c64beC482113) |
| wstO vault / quote token | [`0x80C6BAE89B636c6Ee96FE8F198c0D6926C2C91df`](https://basescan.org/address/0x80C6BAE89B636c6Ee96FE8F198c0D6926C2C91df) |
| Underlying \$O | [`0x182FA643E5f29d5EcA75e7b9CF9336A3fe4620b2`](https://basescan.org/address/0x182FA643E5f29d5EcA75e7b9CF9336A3fe4620b2) |

The suite uses Base's shared PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b` and SwapX proxy `0xC3aCE43169bbF51752B1603067F91eF60f8A662A`. The attached adapter is `WstOUsdcNativeLaunchBuyAdapter`, supporting ETH acquisition through USDC and the vault, plus a direct held-quote buy.

Bindings and runtime hashes were read at **Base block 52,247,777 on October 6, 2026**. Both Factory and Hook referenced the listed adapter, creation was enabled, and wstO was registered. The shared router implementation was `0x8B36252c30347E484D5c76E2Ad0319416dec53D0`; a proxy address alone does not freeze its implementation.

The Factory owner and creator admin are `0x5519a8Cc7211F483e19ff8d50A3B0c892701044D`; the restricted price updater is `0x8BF6eb1EaA9bE34a068c56945a36a23520705F29`. The reserve follows this Factory owner. There is no platform or treasury fee recipient for \$O launches.

See [\$O launch configuration](/launchpad/reference/live-configuration#base-wsto-suite), [integration](/launchpad/integration/wsto) and the [machine-readable snapshot](/launchpad/reference/base-wsto-suite.json). \$O launches are supported on Base and [Robinhood](#robinhood-wsto-contracts). Simulate the complete route for the requested trade amount.

<span id="base-launchpad-contracts" />

### Base Launchpad of Launchpads contracts

**Suite:** `base-mainnet-pads-20261006` · **Token:** ERC-20 · **First block:** `52,233,994`

The registry `PadRegistry` links each [launchpad](/launchpad/launchpads/overview) to its \$O launch token and its vault. The registry starts at block `52,297,014`, and its parent suite is `base-mainnet-wsto-burn-v1`. Tokens launched on a launchpad use the child Tax suite. The snapshot records the bindings and runtime hashes at **Base block 52,397,241 on October 9, 2026**. Sourcify lists verified source for each contract in this table. See [Launchpad of Launchpads configuration](/launchpad/reference/live-configuration#base-launchpad-suite) and the [configuration data](/launchpad/reference/base-launchpad-suite.json).

| Contract | Address |
| - | - |
| Launchpad registry | [`0x012618AC6281A6795aF3047D9dd4D771Bef3f9Ee`](https://basescan.org/address/0x012618AC6281A6795aF3047D9dd4D771Bef3f9Ee) |
| Vault implementation, version 1 | [`0xa9A584d4E1c06020Fb857277Ed2157BF1b8DBe26`](https://basescan.org/address/0xa9A584d4E1c06020Fb857277Ed2157BF1b8DBe26) |
| wstO suite reader (registry suite 1) | [`0x23489603CE43D6b136B905Ef23CB83998d4231BB`](https://basescan.org/address/0x23489603CE43D6b136B905Ef23CB83998d4231BB) |
| Tax suite reader (registry suite 2) | [`0xAd715D6C8143CeFDeE0825a32a2AF450f0804A58`](https://basescan.org/address/0xAd715D6C8143CeFDeE0825a32a2AF450f0804A58) |
| Child launch factory | [`0xfF6ff1DFa6938707Db8dD78D7E74999e8177126f`](https://basescan.org/address/0xfF6ff1DFa6938707Db8dD78D7E74999e8177126f) |
| Child Tax hook | [`0xFe97d6f3f59Ec48f2953c702e55e0ca199392aCC`](https://basescan.org/address/0xFe97d6f3f59Ec48f2953c702e55e0ca199392aCC) |
| Child fee escrow | [`0x4Bf2F5636778ce67C545fD26de46CFe5402d0152`](https://basescan.org/address/0x4Bf2F5636778ce67C545fD26de46CFe5402d0152) |
| Child launch-buy adapter | [`0x94feEeD31cE8903b15D14C888F88ea03cecDfcF6`](https://basescan.org/address/0x94feEeD31cE8903b15D14C888F88ea03cecDfcF6) |
| Child announcement registry | [`0x2B92658A146bA63072b46da51d682b3B8379c9CD`](https://basescan.org/address/0x2B92658A146bA63072b46da51d682b3B8379c9CD) |
| Child Dividend claim helper | [`0xE570103160Eff74b8770e5a50bA30Be1Da083CF9`](https://basescan.org/address/0xE570103160Eff74b8770e5a50bA30Be1Da083CF9) |

Each launchpad vault is a clone of the vault implementation. `predictVault(slug, owner)` returns its address before registration. Resolve a registered vault with `pads(slugHash)` or the `PadRegistered` event. Do not call the implementation for launchpad state.

The child factory is a Tax factory with the launch consent check. Use its own bindings and quote list. A token from the Base Tax v2 factory above cannot join a launchpad. The PoolManager is shared with the Base deployment below.

An earlier registry, `0xCECD96A422f14670493cfF072385811C6fA805a7`, is paused. The application does not use it.

### Base B20 protocol contracts

| Contract | Address |
| - | - |
| B20 Factory | [`0xB20f000000000000000000000000000000000000`](https://basescan.org/address/0xB20f000000000000000000000000000000000000) |
| Activation Registry | [`0x8453000000000000000000000000000000000001`](https://basescan.org/address/0x8453000000000000000000000000000000000001) |
| Policy Registry | [`0x8453000000000000000000000000000000000002`](https://basescan.org/address/0x8453000000000000000000000000000000000002) |

The factory checks activation of `keccak256("base.b20_asset")` before every B20 launch.

### Uniswap and paired assets

| Contract | Address |
| - | - |
| v4 PoolManager | [`0x498581fF718922c3f8e6A244956aF099B2652b2b`](https://basescan.org/address/0x498581fF718922c3f8e6A244956aF099B2652b2b) |
| v4 Quoter | [`0x0d5e0F971ED27FBfF6c2837bf31316121532048D`](https://basescan.org/address/0x0d5e0F971ED27FBfF6c2837bf31316121532048D) |
| v4 StateView | [`0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71`](https://basescan.org/address/0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71) |
| Universal Router | [`0x6fF5693b99212Da76ad316178A184AB56D299b43`](https://basescan.org/address/0x6fF5693b99212Da76ad316178A184AB56D299b43) |
| Permit2 | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://basescan.org/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| Native ETH | `0x0000000000000000000000000000000000000000` |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |

The [Standard snapshot](/launchpad/reference/production-deployments.json) lists ETH, USDC, eight Coinbase crypto quotes, Venice Token (VVV), AERO, MORPHO, Basecat and BLUECHIP with their addresses, decimals, starting ticks and revisions. The 51 registered stocks are in [`base-stock-quotes.json`](/launchpad/reference/base-stock-quotes.json). Valvoline also uses the symbol VVV; it is a separate stock address, not Venice Token. Base Tax has the same registered assets and its own [tick/revision snapshot](/launchpad/reference/base-tax-suite.json).

## Robinhood Chain

Chain ID `4663`. View the network on [RH-scan](https://rh-scan.com).

### Robinhood Standard launch contracts

| Contract | Address |
| - | - |
| Launch factory | [`0xcE9C48cFa068947f77738c81Be406B53338E5B0d`](https://rh-scan.com/address/0xcE9C48cFa068947f77738c81Be406B53338E5B0d) |
| Launch hook | [`0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc`](https://rh-scan.com/address/0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc) |
| Fee escrow | [`0xc5444b417a04a7E1b9C1E327c7D499803c14E5EF`](https://rh-scan.com/address/0xc5444b417a04a7E1b9C1E327c7D499803c14E5EF) |
| Token deployer | [`0xf86dfDb678D8E5d932100Ef479A59fa65a82a5Eb`](https://rh-scan.com/address/0xf86dfDb678D8E5d932100Ef479A59fa65a82a5Eb) |
| Announcement registry | [`0x19C4c024Aca11e4A3d47792C69C80c8f4E596b23`](https://rh-scan.com/address/0x19C4c024Aca11e4A3d47792C69C80c8f4E596b23) |
| Launch-buy adapter | [`0xF9804FeAB2F9b16EDE0Cd92E5C6e75C5cf64462f`](https://rh-scan.com/address/0xF9804FeAB2F9b16EDE0Cd92E5C6e75C5cf64462f) |
| SwapX router proxy | [`0x05cDAE36e0CB8Ba1D16BECfe92B9BFd1FE861a93`](https://rh-scan.com/address/0x05cDAE36e0CB8Ba1D16BECfe92B9BFd1FE861a93) |

At block **76,895,370** on October 1, 2026, this factory had ETH, USDG and all 194 listed Robinhood Stock Tokens registered, creation enabled, a 0.001 ETH launch fee for every quote and configuration version `14`. Its separately dated fee-policy snapshot records a 20-second anti-snipe window and base fee components of creator 50 bps, platform 30 bps and referrer 20 bps. The launch-buy adapter uses the listed SwapX router proxy for the optional atomic Dev Buy. See [Stock-paired launches](/launchpad/create/stock-paired-launches) for every stock address and [verification history](/launchpad/reference/live-configuration#verification-history) for the scope of each check.

### Robinhood Tax contracts

**Suite:** `robinhood-mainnet-tax-token-v2` · **Token:** ERC-20 · **First block:** `73,128,178`

Robinhood Tax uses the same inclusive-tax and automatic Dividend accrual model as Base Tax v2, with its own contracts. Tax launches are enabled with a **0.001 ETH** creation fee and the shared governance roles. Standard launches are unchanged. See [Tax configuration](/launchpad/reference/live-configuration#robinhood-tax-suite) for settings and dated observations.

| Contract | Address |
| - | - |
| Launch factory | [`0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`](https://robinhoodchain.blockscout.com/address/0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A) |
| Tax hook | [`0xe05521566199A3Ba8D8721C0e44E96018EB1EaCc`](https://robinhoodchain.blockscout.com/address/0xe05521566199A3Ba8D8721C0e44E96018EB1EaCc) |
| Fee escrow | [`0x1Dede99A17e1C7775541d73B675470Ba4BeE0318`](https://robinhoodchain.blockscout.com/address/0x1Dede99A17e1C7775541d73B675470Ba4BeE0318) |
| Token deployer | [`0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94`](https://robinhoodchain.blockscout.com/address/0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94) |
| Dividend deployer | [`0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f`](https://robinhoodchain.blockscout.com/address/0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f) |
| Dividend implementation | [`0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f`](https://robinhoodchain.blockscout.com/address/0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f) |
| Fixed Dividend claim helper | [`0x1b056e998211FfB67Ba26A1b5B82316536F42857`](https://robinhoodchain.blockscout.com/address/0x1b056e998211FfB67Ba26A1b5B82316536F42857) |
| Operations library | [`0x88F9fb0256D8493D1060C8a29C2ABB4841159422`](https://robinhoodchain.blockscout.com/address/0x88F9fb0256D8493D1060C8a29C2ABB4841159422) |
| Validation helper | [`0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8`](https://robinhoodchain.blockscout.com/address/0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8) |
| Announcement registry | [`0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4`](https://robinhoodchain.blockscout.com/address/0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4) |
| Launch-buy adapter | [`0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B`](https://robinhoodchain.blockscout.com/address/0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B) |

The bound adapter reuses the Robinhood SwapX router `0x05cDAE36e0CB8Ba1D16BECfe92B9BFd1FE861a93`. The Standard adapter cannot be substituted. The shared PoolManager is `0x8366a39CC670B4001A1121B8F6A443A643e40951`; wrapped ETH is `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. Use these Robinhood dependencies, not Base WETH or a same-address contract on another chain.

Resolve each token's Dividend clone with `dividendOf(token)` and use this suite's fixed claim helper. An explorer link does not assert that source publication is complete. See [Robinhood Tax settings](/launchpad/reference/live-configuration#robinhood-tax-suite), [contract integration](/launchpad/integration/tax-tokens) and the [configuration data](/launchpad/reference/robinhood-tax-suite.json).

<span id="robinhood-wsto-contracts" />

### Robinhood \$O launch contracts

**Suite:** `robinhood-mainnet-wsto-burn-v1` · **Version:** `wsto-burn-v1` · **Launched token:** ERC-20 · **First block:** `81,837,838`

Robinhood \$O launches use the same burn-only model as Base, with a separate Hook and local wstO vault. There is no FeeEscrow, Dividend clone, creation fee or anti-sniping surcharge.

| Contract | Address |
| - | - |
| Launch factory | [`0xAC7Bd3254d7182a32ae3Ce7Fcd0ab86c88fcD91F`](https://robinhoodchain.blockscout.com/address/0xAC7Bd3254d7182a32ae3Ce7Fcd0ab86c88fcD91F) |
| Launch Hook | [`0x96268D6832BF2c552Bb30c5fd6ea92228D816acc`](https://robinhoodchain.blockscout.com/address/0x96268D6832BF2c552Bb30c5fd6ea92228D816acc) |
| Settlement reserve | [`0xAd3A34371e1cB658F8b9a71Ee9526f768dB7E5A5`](https://robinhoodchain.blockscout.com/address/0xAd3A34371e1cB658F8b9a71Ee9526f768dB7E5A5) |
| Token deployer | [`0x37D2D622DF1F446d2a98eC446814C787Ef6bd224`](https://robinhoodchain.blockscout.com/address/0x37D2D622DF1F446d2a98eC446814C787Ef6bd224) |
| Announcement registry | [`0x102C2455dA81E8C040a8b196E6038fF7Eaf66b9D`](https://robinhoodchain.blockscout.com/address/0x102C2455dA81E8C040a8b196E6038fF7Eaf66b9D) |
| Launch-buy adapter (`WstORobinhoodV4LaunchBuyAdapter`) | [`0x93d8C7f339f986F522C89e4196F803F82CCFD736`](https://robinhoodchain.blockscout.com/address/0x93d8C7f339f986F522C89e4196F803F82CCFD736) |
| wstO vault / quote token | [`0xE92bD1C05E4E308792003C8205127A6FA662b4D4`](https://robinhoodchain.blockscout.com/address/0xE92bD1C05E4E308792003C8205127A6FA662b4D4) |
| Underlying \$O | [`0x500A02a20B0B0A3F3efCCFc0559543F5743bd1C4`](https://robinhoodchain.blockscout.com/address/0x500A02a20B0B0A3F3efCCFc0559543F5743bd1C4) |
| SwapX router proxy | [`0x05cDAE36e0CB8Ba1D16BECfe92B9BFd1FE861a93`](https://robinhoodchain.blockscout.com/address/0x05cDAE36e0CB8Ba1D16BECfe92B9BFd1FE861a93) |
| Uniswap v4 PoolManager | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |

Bindings and runtime hashes were read at **Robinhood block 83,108,272 on October 8, 2026**. Both Factory and Hook pointed to the listed adapter; creation was enabled and wstO was registered. The router implementation was `0x48196884B18692d11767128603446DB076Dc96DA`. Read current Factory roles and configuration before preparing an administrative or launch transaction; a proxy address does not freeze its implementation.

Native Dev Buy follows ETH → USDG → \$O → vault deposit → wstO → launch pool. The adapter also admits held wstO. Token-page and API trading support ETH, USDG, \$O and wstO, with complete-route simulation at the requested size. The reserve follows the current Factory owner and cannot withdraw the permanently locked launch position.

See [Robinhood \$O settings](/launchpad/reference/live-configuration#robinhood-wsto-suite), [integration](/launchpad/integration/wsto) and the [configuration snapshot](/launchpad/reference/robinhood-wsto-suite.json) for the vault, acquisition pool keys, runtime identities and dated configuration.

<span id="robinhood-launchpad-contracts" />

### Robinhood Launchpad of Launchpads contracts

**Suite:** `robinhood-mainnet-pads-20261009` · **Token:** ERC-20 · **First block:** `83,656,230`

The Robinhood registry `PadRegistry` uses the same contract source as the Base registry. It starts at block `83,657,082`, and its parent suite is `robinhood-mainnet-wsto-burn-v1`. It has its own launchpads, vaults and URLs. The snapshot records the bindings at **Robinhood block 84,498,331 on October 9, 2026**. The runtime hashes match the deployment record. Sourcify lists verified source for each contract in this table. See [Launchpad of Launchpads configuration](/launchpad/reference/live-configuration#robinhood-launchpad-suite) and the [configuration data](/launchpad/reference/robinhood-launchpad-suite.json).

| Contract | Address |
| - | - |
| Launchpad registry | [`0x4bFaD5f1f58805A201B98BCaCF5faf1aB8093B5F`](https://robinhoodchain.blockscout.com/address/0x4bFaD5f1f58805A201B98BCaCF5faf1aB8093B5F) |
| Vault implementation, version 1 | [`0xA7766Bde73c471a88a8713E206b9085bD06944ea`](https://robinhoodchain.blockscout.com/address/0xA7766Bde73c471a88a8713E206b9085bD06944ea) |
| wstO suite reader (registry suite 1) | [`0x6B2d8233E8071B2Fc0E1993740E565e0C7222c30`](https://robinhoodchain.blockscout.com/address/0x6B2d8233E8071B2Fc0E1993740E565e0C7222c30) |
| Tax suite reader (registry suite 2) | [`0xe2F1242C07E898517C9d33ad2Fa15AC39E3A337e`](https://robinhoodchain.blockscout.com/address/0xe2F1242C07E898517C9d33ad2Fa15AC39E3A337e) |
| Child launch factory | [`0xfF6ff1DFa6938707Db8dD78D7E74999e8177126f`](https://robinhoodchain.blockscout.com/address/0xfF6ff1DFa6938707Db8dD78D7E74999e8177126f) |
| Child Tax hook | [`0xA72Db329ad404Afc85E07dfbF125Be9f977f2acc`](https://robinhoodchain.blockscout.com/address/0xA72Db329ad404Afc85E07dfbF125Be9f977f2acc) |
| Child fee escrow | [`0x4Bf2F5636778ce67C545fD26de46CFe5402d0152`](https://robinhoodchain.blockscout.com/address/0x4Bf2F5636778ce67C545fD26de46CFe5402d0152) |
| Child launch-buy adapter | [`0x94feEeD31cE8903b15D14C888F88ea03cecDfcF6`](https://robinhoodchain.blockscout.com/address/0x94feEeD31cE8903b15D14C888F88ea03cecDfcF6) |
| Child token deployer | [`0xc0F6125755C140f54CF346D1915164F0eFafB462`](https://robinhoodchain.blockscout.com/address/0xc0F6125755C140f54CF346D1915164F0eFafB462) |
| Child announcement registry | [`0x2B92658A146bA63072b46da51d682b3B8379c9CD`](https://robinhoodchain.blockscout.com/address/0x2B92658A146bA63072b46da51d682b3B8379c9CD) |
| Child Dividend claim helper | [`0xE570103160Eff74b8770e5a50bA30Be1Da083CF9`](https://robinhoodchain.blockscout.com/address/0xE570103160Eff74b8770e5a50bA30Be1Da083CF9) |

Several child addresses equal the Base child addresses, because the same deployer used the same nonces. They are separate contracts on separate chains. The child hook differs.

The Robinhood SwapX router approves the child hook, so child tokens can trade through the o1 trade panel.

### Uniswap and paired assets

| Contract | Address |
| - | - |
| v4 PoolManager | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://rh-scan.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |
| v4 Quoter | [`0x8dc178efb8111bb0973dd9d722ebeff267c98f94`](https://rh-scan.com/address/0x8dc178efb8111bb0973dd9d722ebeff267c98f94) |
| v4 StateView | [`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`](https://rh-scan.com/address/0xf3334192d15450cdd385c8b70e03f9a6bd9e673b) |
| Universal Router | [`0x8876789976decbfcbbbe364623c63652db8c0904`](https://rh-scan.com/address/0x8876789976decbfcbbbe364623c63652db8c0904) |
| Permit2 | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://rh-scan.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| Native ETH | `0x0000000000000000000000000000000000000000` |
| USDG | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://rh-scan.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) |

## Monad mainnet

Chain ID `143`. Native currency is **MON**, represented by the zero address; WMON is its routing wrapper, while WETH is a separate ERC-20 paired asset.

Monad launches support MON, USDC and WETH as paired assets. See [Live configuration](/launchpad/reference/live-configuration#monad-snapshot) for factory settings.

### Crypto-paired launch contracts

| Contract | Address |
| - | - |
| Launch factory | [`0x99C09A90feED8D5e57A19A8C1F103AE29BA5b5b7`](https://monadscan.com/address/0x99C09A90feED8D5e57A19A8C1F103AE29BA5b5b7) |
| Launch hook | [`0x8AeA397f75d046fEAF43D2897548f3A18FD92acC`](https://monadscan.com/address/0x8AeA397f75d046fEAF43D2897548f3A18FD92acC) |
| Fee escrow | [`0x27BC99240f2c3895Cb91663932D97A29DdD99A93`](https://monadscan.com/address/0x27BC99240f2c3895Cb91663932D97A29DdD99A93) |
| Token deployer | [`0x409EFa96C1c97f0eEC05E530446ad11B84305978`](https://monadscan.com/address/0x409EFa96C1c97f0eEC05E530446ad11B84305978) |
| Announcement registry | [`0xB6E0E2e1C3a7edF66858fE7ef401B5fE26E1B597`](https://monadscan.com/address/0xB6E0E2e1C3a7edF66858fE7ef401B5fE26E1B597) |
| Launch-buy adapter | [`0x6961e2F542B4ba40D364fC2B0430230e643Af17E`](https://monadscan.com/address/0x6961e2F542B4ba40D364fC2B0430230e643Af17E) |

The suite `monad-mainnet-launchpad-v4-minimal` starts at block `102181199`. It supports the standard crypto route only. The native creation fee is **100 MON**. No staking deployment or new-suite vesting is configured.

### Monad Tax contracts

**Suite:** `monad-mainnet-tax-token-v2` · **Token:** ERC-20 · **First block:** `108,602,560`

Monad Tax uses the same inclusive-tax and automatic Dividend accrual model as Base Tax v2, with its own contracts. Tax launches are enabled with a **100 MON** creation fee and the shared governance roles. Standard launches are unchanged. See [Tax configuration](/launchpad/reference/live-configuration#monad-tax-suite) for settings and dated observations.

| Contract | Address |
| - | - |
| Launch factory | [`0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`](https://monadvision.com/address/0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A) |
| Tax hook | [`0x2ac294ffa4A1F3cA188DfBc60F19D8c16a10EACc`](https://monadvision.com/address/0x2ac294ffa4A1F3cA188DfBc60F19D8c16a10EACc) |
| Fee escrow | [`0x1Dede99A17e1C7775541d73B675470Ba4BeE0318`](https://monadvision.com/address/0x1Dede99A17e1C7775541d73B675470Ba4BeE0318) |
| Token deployer | [`0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94`](https://monadvision.com/address/0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94) |
| Dividend deployer | [`0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f`](https://monadvision.com/address/0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f) |
| Dividend implementation | [`0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f`](https://monadvision.com/address/0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f) |
| Fixed Dividend claim helper | [`0x1b056e998211FfB67Ba26A1b5B82316536F42857`](https://monadvision.com/address/0x1b056e998211FfB67Ba26A1b5B82316536F42857) |
| Operations library | [`0x88F9fb0256D8493D1060C8a29C2ABB4841159422`](https://monadvision.com/address/0x88F9fb0256D8493D1060C8a29C2ABB4841159422) |
| Validation helper | [`0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8`](https://monadvision.com/address/0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8) |
| Announcement registry | [`0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4`](https://monadvision.com/address/0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4) |
| Launch-buy adapter | [`0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B`](https://monadvision.com/address/0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B) |

The bound adapter reuses the Monad SwapX router `0x5911212c0aB0c2C1796D1EB48c750b6820E35dc7`. The Standard adapter cannot be substituted. The shared PoolManager is `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e`; WMON is `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`. Use these Monad dependencies, not Base WETH or a same-address contract on another chain.

Resolve each token's Dividend clone with `dividendOf(token)` and use this suite's fixed claim helper. Saved MonadVision Sourcify submissions returned exact matches for all 11 Tax contracts. The [router review](#swapx-router-upgrade-review) supersedes the earlier native-balance blocker for its tested routes; hosted wallet acceptance remains separate. See [Monad Tax settings](/launchpad/reference/live-configuration#monad-tax-suite), [contract integration](/launchpad/integration/tax-tokens) and the [configuration data](/launchpad/reference/monad-tax-suite.json).

### Uniswap and paired assets

| Contract | Address |
| - | - |
| v4 PoolManager | [`0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e`](https://monadscan.com/address/0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e) |
| v4 Quoter | [`0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891`](https://monadscan.com/address/0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891) |
| v4 StateView | [`0x77395F3b2E73aE90843717371294fa97cC419D64`](https://monadscan.com/address/0x77395F3b2E73aE90843717371294fa97cC419D64) |
| Universal Router | [`0x0D97Dc33264bfC1c226207428A79b26757fb9dc3`](https://monadscan.com/address/0x0D97Dc33264bfC1c226207428A79b26757fb9dc3) |
| Permit2 | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://monadscan.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| SwapX router proxy | [`0x5911212c0aB0c2C1796D1EB48c750b6820E35dc7`](https://monadscan.com/address/0x5911212c0aB0c2C1796D1EB48c750b6820E35dc7) |
| WMON (routing only) | [`0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`](https://monadscan.com/address/0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A) |
| MON (18 decimals) | [`0x0000000000000000000000000000000000000000`](https://monadscan.com/address/0x0000000000000000000000000000000000000000) |
| USDC (6 decimals) | [`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`](https://monadscan.com/address/0x754704Bc059F8C67012fEd69BC8A327a5aafb603) |
| WETH (18 decimals) | [`0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242`](https://monadscan.com/address/0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242) |

The developer-buy adapter accepts native MON funding, configured Uniswap/Pancake V3 pools and permitted hook-free external ERC-20 V4 pools. The app compares direct routes and, for WETH pairs, a USDC bridge using the reviewed USDC/WETH V4 key. This is bounded route discovery, not every pool on Monad. Aerodrome and external hooked pools are excluded. The final launch pool uses the launch hook. Token-page users can use MON or the paired asset; the public API prepares paired-asset swaps only.

Monad uses the [shared owner, creator-admin, treasury and updater addresses](#governance-and-fee-recipient). See [Live configuration](/launchpad/reference/live-configuration#monad-snapshot) for the dated onchain settings and [Security and audit](/launchpad/security) for audit scope.

## Arc mainnet

Chain ID `5042`. View the network on [Arc Explorer](https://explorer.arc.io).

### Launch contracts

| Contract | Address |
| - | - |
| Launch factory | [`0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605`](https://explorer.arc.io/address/0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605) |
| Launch hook | [`0x20EEad6db6b3d0a4491E9073119DD0EBFF166AcC`](https://explorer.arc.io/address/0x20EEad6db6b3d0a4491E9073119DD0EBFF166AcC) |
| Fee escrow | [`0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f`](https://explorer.arc.io/address/0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f) |
| Token deployer | [`0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4`](https://explorer.arc.io/address/0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4) |
| Announcement registry | [`0xD4942511A1587Ac3F1F0f4097e18D4BCEe73d753`](https://explorer.arc.io/address/0xD4942511A1587Ac3F1F0f4097e18D4BCEe73d753) |
| Launch-buy adapter | [`0xacA9150b1ecAeddEf5cF6a24f12b060049Cec06f`](https://explorer.arc.io/address/0xacA9150b1ecAeddEf5cF6a24f12b060049Cec06f) |
| SwapX router proxy | [`0x528154f6DE668988A2DD1B4db96F470716d0493B`](https://explorer.arc.io/address/0x528154f6DE668988A2DD1B4db96F470716d0493B) |

Launch creation was enabled with **USDC and cirBTC registered** and a **2 native USDC** creation fee at the October 1, 2026 readback. The attached launch-buy adapter uses the listed SwapX router for optional atomic Dev Buy. The suite `arc-mainnet-launchpad-v4-minimal` starts at block `20147782`. Supply, permanent liquidity and the normal 1% fee split follow the same model as Base and Robinhood. Arc Standard launches created after the September 15, 2026 fee update have **0% anti-sniping surcharge**; the stored 1-second window adds no extra fee. Earlier pools retain their original settings. See [Live configuration](/launchpad/reference/live-configuration#arc-mainnet) for the dated settings.

### Arc Tax contracts

**Suite:** `arc-mainnet-tax-token-v2` · **Token:** ERC-20 · **First block:** `23,152,966`

Arc Tax uses the same inclusive-tax and automatic Dividend accrual model, with its own contracts and Arc-specific reward payments. Tax launches are enabled with a **2 native USDC** creation fee and the shared governance roles. Standard launches are unchanged. See [Tax configuration](/launchpad/reference/live-configuration#arc-tax-suite) for settings and dated observations.

| Contract | Address / source |
| - | - |
| Launch factory | [`0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`](https://repo.sourcify.dev/5042/0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A) |
| Tax hook | [`0x7a3D518f9278f32E5D11D931C3B726831E6D6ACc`](https://repo.sourcify.dev/5042/0x7a3D518f9278f32E5D11D931C3B726831E6D6ACc) |
| Fee escrow | [`0x1Dede99A17e1C7775541d73B675470Ba4BeE0318`](https://repo.sourcify.dev/5042/0x1Dede99A17e1C7775541d73B675470Ba4BeE0318) |
| Token deployer | [`0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94`](https://repo.sourcify.dev/5042/0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94) |
| Dividend deployer | [`0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f`](https://repo.sourcify.dev/5042/0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f) |
| Dividend implementation | [`0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f`](https://repo.sourcify.dev/5042/0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f) |
| Fixed Dividend claim helper | [`0x1b056e998211FfB67Ba26A1b5B82316536F42857`](https://repo.sourcify.dev/5042/0x1b056e998211FfB67Ba26A1b5B82316536F42857) |
| Operations library | [`0x03f1d87f5f731442ddff36b74e365814c832a63d`](https://repo.sourcify.dev/5042/0x03f1d87f5f731442ddff36b74e365814c832a63d) |
| Validation helper | [`0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8`](https://repo.sourcify.dev/5042/0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8) |
| Announcement registry | [`0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4`](https://repo.sourcify.dev/5042/0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4) |
| Launch-buy adapter | [`0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B`](https://repo.sourcify.dev/5042/0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B) |

The Dividend implementation is **ArcTaxDividend**. It shares the claim ABI and accounting model but pays the fixed ERC-20 reward token for either unwrap preference. USDC rewards use six decimals over Arc's shared native balance, with no wrapper call. cirBTC uses eight decimals.

The Tax adapter reuses SwapX proxy `0x528154f6DE668988A2DD1B4db96F470716d0493B` and PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`. USDC is `0x3600000000000000000000000000000000000000`; cirBTC is `0x171a4217b86a807a64eb94757db6849fb4bdbaa0`. The Standard adapter cannot substitute for the Tax adapter's immutable Factory/Hook binding.

Saved evidence records exact Sourcify creation/runtime matches for all 11 contracts. Explorer badges are separate from source matches. Arc-node nonbroadcast simulations cover both quotes, native/ERC-20-funded Dev Buy, sells, direct/helper claims and rollback. Ordinary Foundry forks cannot emulate Arc's USDC blocklist precompile; these are node simulations, not hosted wallet acceptance or independent certification of the Arc specialization.

See [Arc Tax settings](/launchpad/reference/live-configuration#arc-tax-suite), [currency integration](/launchpad/integration/tax-tokens#arc-currency-and-claims) and the [snapshot](/launchpad/reference/arc-tax-suite.json).

### Uniswap v4 and paired assets

| Contract | Address |
| - | - |
| v4 PoolManager | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://explorer.arc.io/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |
| v4 Quoter | [`0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`](https://explorer.arc.io/address/0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94) |
| v4 StateView | [`0xF3334192D15450CdD385c8B70e03f9A6bD9E673b`](https://explorer.arc.io/address/0xF3334192D15450CdD385c8B70e03f9A6bD9E673b) |
| ERC-20 USDC (6 decimals) | [`0x3600000000000000000000000000000000000000`](https://explorer.arc.io/address/0x3600000000000000000000000000000000000000) |
| cirBTC (8 decimals) | [`0x171a4217b86a807a64eb94757db6849fb4bdbaa0`](https://explorer.arc.io/address/0x171a4217b86a807a64eb94757db6849fb4bdbaa0) |

Native USDC uses 18-decimal units for gas and the launch fee. ERC-20 USDC uses six decimals for the pool quote, trading and fee claims. Both interfaces share one balance. See [Arc's USDC guidance](https://docs.arc.io/arc/tutorials/porting-contracts-to-arc) and the [Arc adapter flow](/launchpad/architecture/contracts#arc-deployment).

The adapter permits pools from V3 factory [`0xf0db7b58379503491d857dB50AC9ece64c653918`](https://explorer.arc.io/address/0xf0db7b58379503491d857dB50AC9ece64c653918) and eligible hook-free V4 pools through the listed PoolManager. PancakeSwap and Aerodrome are not configured. Each external pool must satisfy the adapter's 5% fee cap; the final hop must use the exact o1 launch pool.

Both current Arc factories had cirBTC registered at block **23,614,087** on October 1, 2026. Recheck the selected factory before creation. cirBTC-paired fees and claims use eight-decimal cirBTC; native gas and creation fees still use USDC. See [Arc quote configuration](/launchpad/reference/live-configuration#arc-mainnet) for catalog and snapshot details.

Arc's launch configuration uses the same [owner, creator admin, treasury and price updater](/launchpad/reference/production-contracts#governance-and-fee-recipient) as Base and Robinhood.

## BSC mainnet

Chain ID `56`. Native BNB pays gas and the launch fee. The suite supports crypto-paired and stock-paired launch creation. Read the factory before preparing a transaction.

<span id="shared-crypto-paired-and-stock-paired-launch-contracts-2" />

### BSC Standard launch contracts

| Contract | Address |
| - | - |
| Launch factory | [`0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605`](https://bscscan.com/address/0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605) |
| Launch hook | [`0xF0117680Ce319B8af64580002052eca29CC62aCc`](https://bscscan.com/address/0xF0117680Ce319B8af64580002052eca29CC62aCc) |
| Fee escrow | [`0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f`](https://bscscan.com/address/0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f) |
| Token deployer | [`0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4`](https://bscscan.com/address/0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4) |
| Announcement registry | [`0xD4942511A1587Ac3F1F0f4097e18D4BCEe73d753`](https://bscscan.com/address/0xD4942511A1587Ac3F1F0f4097e18D4BCEe73d753) |
| Launch-buy adapter | [`0xd94981D2Cac1aBFa9561Fd3F6c0E54357e13E47d`](https://bscscan.com/address/0xd94981D2Cac1aBFa9561Fd3F6c0E54357e13E47d) |
| SwapX router proxy | [`0x61bb995D27142eF2593837516CdEC4EcC13dF248`](https://bscscan.com/address/0x61bb995D27142eF2593837516CdEC4EcC13dF248) |

The suite `bsc-mainnet-launchpad-v4-minimal` begins at block `122026636` and serves both standard and stock-paired creation. It creates immutable ERC-20 tokens with the same permanent-liquidity and creator-fee model as the other ERC-20 suites. Its selected-for-creation registry flag identifies the suite; it does not override the onchain creation switch.

### BSC Tax contracts

**Suite:** `bsc-mainnet-tax-token-v2` · **Token:** ERC-20 · **First block:** `124,192,180`

BSC Tax uses the same inclusive-tax and automatic Dividend accrual model as Base Tax v2, with its own contracts. Tax launches are enabled with a **0.003 BNB** creation fee and the shared governance roles. Standard launches are unchanged. See [Tax configuration](/launchpad/reference/live-configuration#bsc-tax-suite) for settings and dated observations.

| Contract | Address |
| - | - |
| Launch factory | [`0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`](https://bscscan.com/address/0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A) |
| Tax hook | [`0x993fFbbcc174763FC1B1041D3ae73d71a1632acC`](https://bscscan.com/address/0x993fFbbcc174763FC1B1041D3ae73d71a1632acC) |
| Fee escrow | [`0x1Dede99A17e1C7775541d73B675470Ba4BeE0318`](https://bscscan.com/address/0x1Dede99A17e1C7775541d73B675470Ba4BeE0318) |
| Token deployer | [`0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94`](https://bscscan.com/address/0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94) |
| Dividend deployer | [`0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f`](https://bscscan.com/address/0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f) |
| Dividend implementation | [`0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f`](https://bscscan.com/address/0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f) |
| Fixed Dividend claim helper | [`0x1b056e998211FfB67Ba26A1b5B82316536F42857`](https://bscscan.com/address/0x1b056e998211FfB67Ba26A1b5B82316536F42857) |
| Operations library | [`0x88F9fb0256D8493D1060C8a29C2ABB4841159422`](https://bscscan.com/address/0x88F9fb0256D8493D1060C8a29C2ABB4841159422) |
| Validation helper | [`0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8`](https://bscscan.com/address/0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8) |
| Announcement registry | [`0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4`](https://bscscan.com/address/0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4) |
| Launch-buy adapter | [`0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B`](https://bscscan.com/address/0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B) |

The bound adapter reuses the BSC SwapX router `0x61bb995D27142eF2593837516CdEC4EcC13dF248`. The Standard adapter cannot be substituted. The shared PoolManager is `0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF`; WBNB is `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`. Use these BSC dependencies, not Base WETH or a same-address contract on another chain.

Resolve each token's Dividend clone with `dividendOf(token)` and use this suite's fixed claim helper. Saved verification evidence confirms exact source publication for all 11 Tax contracts. The external SwapX router has since upgraded; full source/ABI verification of its current implementation is not established by the earlier publication evidence. See the [router review](#swapx-router-upgrade-review). See [BSC Tax settings](/launchpad/reference/live-configuration#bsc-tax-suite), [contract integration](/launchpad/integration/tax-tokens) and the [configuration data](/launchpad/reference/bsc-tax-suite.json).

### Uniswap and paired assets

| Contract | Address |
| - | - |
| v4 PoolManager | [`0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF`](https://bscscan.com/address/0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF) |
| v4 Quoter | [`0x9f75dd27d6664c475b90e105573e550ff69437b0`](https://bscscan.com/address/0x9f75dd27d6664c475b90e105573e550ff69437b0) |
| v4 StateView | [`0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4`](https://bscscan.com/address/0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4) |
| Native BNB (18 decimals) | `0x0000000000000000000000000000000000000000` |
| USDC (18 decimals) | [`0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`](https://bscscan.com/address/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d) |
| WBNB (routing only) | [`0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`](https://bscscan.com/address/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c) |

All 21 registered bStocks also use 18 decimals. See the [stock catalog](/launchpad/create/stock-paired-launches#bsc-bstock-catalog) and [BSC configuration](/launchpad/reference/live-configuration#bsc-mainnet). BSC uses the shared owner, creator-admin, treasury and updater addresses in the governance reference; read current authority onchain before administrative calls.

## X Layer mainnet

Chain ID `196`. Native **OKB** pays gas and the **0.02 OKB** launch fee. Creation is enabled. The Factory uses the shared governance addresses below. Read the factory for current settings before preparing transactions.

<span id="crypto-paired-launch-contracts-2" />

### X Layer Standard launch contracts

| Contract | Address |
| - | - |
| Launch factory | [`0x17D9218F0Ad1Baa187CDFA50677ff3196Bbf9c36`](https://xlayerscan.com/address/0x17D9218F0Ad1Baa187CDFA50677ff3196Bbf9c36) |
| Launch hook | [`0x5cd79B9C231ccA5d26F2494D3466CB7495Df2aCc`](https://xlayerscan.com/address/0x5cd79B9C231ccA5d26F2494D3466CB7495Df2aCc) |
| Fee escrow | [`0x30F53E4FD6581fCEd90a910159Fb075DD502636B`](https://xlayerscan.com/address/0x30F53E4FD6581fCEd90a910159Fb075DD502636B) |
| Token deployer | [`0xDABd35464801Be390d4Cb12B2E50BA00c0Ea12d8`](https://xlayerscan.com/address/0xDABd35464801Be390d4Cb12B2E50BA00c0Ea12d8) |
| Announcement registry | [`0x6985Bc4CDD87a0B514aaBEDb2e5dd76Da0409360`](https://xlayerscan.com/address/0x6985Bc4CDD87a0B514aaBEDb2e5dd76Da0409360) |
| Launch-buy adapter | [`0x533cb00bEC3b2C1e2c905B5E4112486deE0735fD`](https://xlayerscan.com/address/0x533cb00bEC3b2C1e2c905B5E4112486deE0735fD) |
| SwapX router proxy | [`0x37DfD6117fcf065eda0B55D8547A78F8B2221987`](https://xlayerscan.com/address/0x37DfD6117fcf065eda0B55D8547A78F8B2221987) |

The `xlayer-mainnet-launchpad-v4-minimal` suite starts at block `70827259`. It uses the same immutable ERC-20, one-billion-token, permanent-liquidity and 1% base-fee model. Quotes include native OKB, USDC, xETH and 45 wrapped stock tokens. Crypto and stock launches share this factory. Atomic Dev Buy uses the SwapX adapter; staking is not configured.

<span id="xlayer-tax-contracts" />

### X Layer Tax contracts

**Suite:** `xlayer-mainnet-tax-token-v2` · **Token:** ERC-20 · **First block:** `71,792,691`

X Layer Tax uses the same inclusive-tax and automatic Dividend accrual model as Base Tax v2, with its own contracts. Tax launches are enabled with a **0.02 OKB** creation fee and the shared governance roles. Standard launches are unchanged. See [Tax configuration](/launchpad/reference/live-configuration#xlayer-tax-suite) for settings and dated observations.

| Contract | Address |
| - | - |
| Launch factory | [`0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`](https://xlayerscan.com/address/0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A) |
| Tax hook | [`0xb15927F5605B232CdC57B97FD221bc584032aAcc`](https://xlayerscan.com/address/0xb15927F5605B232CdC57B97FD221bc584032aAcc) |
| Fee escrow | [`0x1Dede99A17e1C7775541d73B675470Ba4BeE0318`](https://xlayerscan.com/address/0x1Dede99A17e1C7775541d73B675470Ba4BeE0318) |
| Token deployer | [`0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94`](https://xlayerscan.com/address/0x0598EB4bD64E0dA829a4A82EfAeae2EE019AEC94) |
| Dividend deployer | [`0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f`](https://xlayerscan.com/address/0x2202fd7fEA1986C22Fa7417D82CdAc435150d17f) |
| Dividend implementation | [`0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f`](https://xlayerscan.com/address/0x3E20211A9372f27a6fd89CD0E81aD242d34a0a1f) |
| Fixed Dividend claim helper | [`0x1b056e998211FfB67Ba26A1b5B82316536F42857`](https://xlayerscan.com/address/0x1b056e998211FfB67Ba26A1b5B82316536F42857) |
| Operations library | [`0x88F9fb0256D8493D1060C8a29C2ABB4841159422`](https://xlayerscan.com/address/0x88F9fb0256D8493D1060C8a29C2ABB4841159422) |
| Validation helper | [`0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8`](https://xlayerscan.com/address/0x6bD93cEf0A71a1c4Df1595e880A3F1843aB738E8) |
| Announcement registry | [`0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4`](https://xlayerscan.com/address/0x11f1D9d0c3107bde23124e39D3935Bc8d4f904D4) |
| Launch-buy adapter | [`0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B`](https://xlayerscan.com/address/0x955a5FF14e38Af1Dc99E4836c0464BbaC5abb80B) |

The bound adapter reuses the X Layer SwapX router `0x37DfD6117fcf065eda0B55D8547A78F8B2221987`. The Standard adapter cannot be substituted. The shared PoolManager is `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`; WOKB is `0xe538905cf8410324e03A5A23C1c177a474D59b2b`. Use these X Layer dependencies, not Base WETH or a same-address contract on another chain.

Resolve each token's Dividend clone with `dividendOf(token)` and use this suite's fixed claim helper. Saved XLayerScan readbacks report full source verification for all 11 Tax contracts. The upgraded router and updated application admit both minimal-v4 and Tax Hooks. See the [router review](#swapx-router-upgrade-review) for the scoped fork evidence and remaining hosted acceptance. See [X Layer Tax settings](/launchpad/reference/live-configuration#xlayer-tax-suite), [contract integration](/launchpad/integration/tax-tokens) and the [configuration data](/launchpad/reference/xlayer-tax-suite.json).

### Uniswap and paired assets

| Contract | Address |
| - | - |
| v4 PoolManager | [`0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`](https://xlayerscan.com/address/0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32) |
| v4 Quoter | [`0x8928074ca1b241d8ec02815881c1af11e8bc5219`](https://xlayerscan.com/address/0x8928074ca1b241d8ec02815881c1af11e8bc5219) |
| v4 StateView | [`0x76fd297e2d437cd7f76d50f01afe6160f86e9990`](https://xlayerscan.com/address/0x76fd297e2d437cd7f76d50f01afe6160f86e9990) |
| Uniswap v3 factory | [`0x4B2ab38DBF28D31D467aA8993f6c2585981D6804`](https://xlayerscan.com/address/0x4B2ab38DBF28D31D467aA8993f6c2585981D6804) |
| WOKB (routing and pricing) | [`0xe538905cf8410324e03A5A23C1c177a474D59b2b`](https://xlayerscan.com/address/0xe538905cf8410324e03A5A23C1c177a474D59b2b) |
| Native OKB (18 decimals) | `0x0000000000000000000000000000000000000000` |

OKB and WOKB are separate balances. Native buys use transaction value; token sells approve the listed SwapX proxy. X Layer uses the standard eight-field deadline interface, not BSC's ten-field router ABI. See [configuration](/launchpad/reference/live-configuration#x-layer-mainnet) and [direct integration](/launchpad/integration/direct#x-layer-amounts-and-routing).

### X Layer quote catalog

X Layer supports native OKB, USDC, xETH and 45 registered wrapped stocks. Both factories use the same 0.02 OKB creation fee for every paired asset.

| Crypto quote | Address | Decimals | Standard starting tick | Tax starting tick |
| - | - | -: | -: | -: |
| OKB | `0x0000000000000000000000000000000000000000` | 18 | -172200 | -171400 |
| USDC | [`0xB6CEceAB302E2E4948951eE7843FC24E92933061`](https://xlayerscan.com/address/0xB6CEceAB302E2E4948951eE7843FC24E92933061) | 6 | -400600 | -400600 |
| xETH | [`0xE7B000003A45145decf8a28FC755aD5eC5EA025A`](https://xlayerscan.com/address/0xE7B000003A45145decf8a28FC755aD5eC5EA025A) | 18 | -203200 | -203000 |

See [Stock-paired launches](/launchpad/create/stock-paired-launches#x-layer-stock-token-catalog) for the 45 stock quotes and the [machine-readable catalog](/launchpad/reference/xlayer-stock-quotes.json) for Standard starting ticks and revisions. The [Tax snapshot](/launchpad/reference/xlayer-tax-suite.json) has its independent values. The table above was read at block **72,040,413** on October 1, 2026.

## Historical launch suites

<Warning>
  Historical factories are not selected by the current o1 interface for new creation, but tokens and pools created through them remain valid o1 Launchpad markets. Indexers and recovery tooling must retain the original identities. Public support follows each suite's application mode; index-only Tax v1 is not exposed for public transaction preparation. Do not classify an o1 token using only the current factory.
</Warning>

The machine-readable [`launch-contract-suites.json`](/launchpad/reference/launch-contract-suites.json) registry contains the current and historical suite topology for Base, Robinhood, Monad, Arc, BSC and X Layer. Resolve a launch by its chain ID and originating factory, then use that suite's hook, fee escrow, vesting vault, announcement registry, contract version, and first block. The `historical` label means the suite is no longer selected for new creation by the platform. It does not assert that direct calls to every legacy factory are disabled onchain.

### Base historical suites

<AccordionGroup>
  <Accordion title="Tax v1: historical, creation disabled">
    **Suite ID:** `base-mainnet-tax-token-v1` · **First block:** `51,657,963` · **Public support:** unavailable

    This deployment is not the public Tax creation or transaction-preparation route. Creation was disabled at Base block 51,779,077. Its existing records and contract identities remain available for indexing and direct holder/operator recovery. Never substitute v2 contracts for a v1 token.

    | Contract | Address |
    | - | - |
    | Factory | [`0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`](https://basescan.org/address/0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A) |
    | Tax Hook | [`0x0F519cB7C904063914c9440CbA55dEEBeb0e6ACc`](https://basescan.org/address/0x0F519cB7C904063914c9440CbA55dEEBeb0e6ACc) |
    | FeeEscrow | [`0x1Dede99A17e1C7775541d73B675470Ba4BeE0318`](https://basescan.org/address/0x1Dede99A17e1C7775541d73B675470Ba4BeE0318) |
    | Fixed Dividend claim helper | [`0x1b056e998211FfB67Ba26A1b5B82316536F42857`](https://basescan.org/address/0x1b056e998211FfB67Ba26A1b5B82316536F42857) |

    The [historical snapshot](/launchpad/reference/historical/base-tax-suite-v1.json) retains the remaining addresses and dated settings. Its Dividend accounting is allocation-time; use the matching historical ABI when reading its events or making direct recovery calls.
  </Accordion>

  <Accordion title="Legacy block suite v1">
    **Suite ID:** `base-mainnet-block-v1` · **Contract version:** `legacy-block-v1` · **Creation route:** Standard · **First indexed block:** `48,364,845`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0xe3Ab924c72463c1Ac8d1d8352EE640b89eB1EA64`](https://basescan.org/address/0xe3Ab924c72463c1Ac8d1d8352EE640b89eB1EA64) |
    | Launch Hook | [`0xA068Cf4c52aBDd3479145c4B3cBD8E3d71542a44`](https://basescan.org/address/0xA068Cf4c52aBDd3479145c4B3cBD8E3d71542a44) |
    | Fee Escrow | [`0xabE87e4af23dAFad0A170Aa900d574c03D904597`](https://basescan.org/address/0xabE87e4af23dAFad0A170Aa900d574c03D904597) |
    | Vesting Vault | [`0xD6c4721eC7c0aAc8B57B3eA2a9698e288371E30e`](https://basescan.org/address/0xD6c4721eC7c0aAc8B57B3eA2a9698e288371E30e) |
    | Announcement Registry | [`0xa6Bb57ABD6d26cF862e6AAb84f2BcD51210a060E`](https://basescan.org/address/0xa6Bb57ABD6d26cF862e6AAb84f2BcD51210a060E) |
  </Accordion>

  <Accordion title="Timestamp suite v2">
    **Suite ID:** `base-mainnet-timestamp-v2` · **Contract version:** `quote-timestamp-v2` · **Creation route:** Standard · **First indexed block:** `48,451,098`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0xa52ad458cE0282a971ecC71C051A32f28946bb9F`](https://basescan.org/address/0xa52ad458cE0282a971ecC71C051A32f28946bb9F) |
    | Launch Hook | [`0x985C14BAa2a18316ffdA0aeFB3a632fAdfcA2AcC`](https://basescan.org/address/0x985C14BAa2a18316ffdA0aeFB3a632fAdfcA2AcC) |
    | Fee Escrow | [`0xa2cBD9065cec93c443CAFb0837A62800EE7C4A84`](https://basescan.org/address/0xa2cBD9065cec93c443CAFb0837A62800EE7C4A84) |
    | Vesting Vault | [`0x3beeA54dB87A632A5FAF20dB6765D3af94c81b31`](https://basescan.org/address/0x3beeA54dB87A632A5FAF20dB6765D3af94c81b31) |
    | Announcement Registry | [`0xABDcBE060724b9BEf5A2daad017d9eA3Ed72DE28`](https://basescan.org/address/0xABDcBE060724b9BEf5A2daad017d9eA3Ed72DE28) |
  </Accordion>

  <Accordion title="Managed stock suite v3">
    **Suite ID:** `base-mainnet-rwa-timestamp-v3` · **Contract version:** `rwa-quote-updater-v3` · **Creation route:** Stock-paired · **First indexed block:** `49,121,014`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0x1dE58A6769526a03a504d9d59B8757CD8097Dc57`](https://basescan.org/address/0x1dE58A6769526a03a504d9d59B8757CD8097Dc57) |
    | Launch Hook | [`0xbCA7774615c74b7991a111f1C7b2D0eFeA61AAcc`](https://basescan.org/address/0xbCA7774615c74b7991a111f1C7b2D0eFeA61AAcc) |
    | Fee Escrow | [`0xCF9ed8f4145eac9059Bcd83227eEb8591FaC0A9a`](https://basescan.org/address/0xCF9ed8f4145eac9059Bcd83227eEb8591FaC0A9a) |
    | Vesting Vault | [`0x6Ad89089E3ff684F875722D75e5CF24499aa7F35`](https://basescan.org/address/0x6Ad89089E3ff684F875722D75e5CF24499aa7F35) |
    | Announcement Registry | [`0x4fA46c840dF1d11b20750C08390f7daBfe0e1CCa`](https://basescan.org/address/0x4fA46c840dF1d11b20750C08390f7daBfe0e1CCa) |
  </Accordion>

  <Accordion title="Managed stock suite v4">
    **Suite ID:** `base-mainnet-rwa-timestamp-v4` · **Contract version:** `rwa-quote-updater-v3` · **Creation route:** Stock-paired · **First indexed block:** `50,137,081`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4`](https://basescan.org/address/0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4) |
    | Launch Hook | [`0x3b2b979DF21036CEe51B8debB13100e2CB8DeaCC`](https://basescan.org/address/0x3b2b979DF21036CEe51B8debB13100e2CB8DeaCC) |
    | Fee Escrow | [`0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f`](https://basescan.org/address/0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f) |
    | Vesting Vault | [`0x9Ab963FB1De707a36a9f843c9E6eF596C9DCa2f3`](https://basescan.org/address/0x9Ab963FB1De707a36a9f843c9E6eF596C9DCa2f3) |
    | Announcement Registry | [`0x7CE9C6D4d0DcE30895E5e35798954947071029c0`](https://basescan.org/address/0x7CE9C6D4d0DcE30895E5e35798954947071029c0) |
  </Accordion>
</AccordionGroup>

### Robinhood historical suites

<AccordionGroup>
  <Accordion title="Legacy block suite v1">
    **Suite ID:** `robinhood-block-v1` · **Contract version:** `legacy-block-v1` · **Creation route:** Standard · **First indexed block:** `2,131,131`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0x8B40fc20c405d47D725c9723D056a1c6f62BBccf`](https://rh-scan.com/address/0x8B40fc20c405d47D725c9723D056a1c6f62BBccf) |
    | Launch Hook | [`0xe960E6C80C74cFDF03c91E7AF4e1F5f53f096a44`](https://rh-scan.com/address/0xe960E6C80C74cFDF03c91E7AF4e1F5f53f096a44) |
    | Fee Escrow | [`0xF5681c4C0dC0c2e32C9d127b3cc0Fc992B584553`](https://rh-scan.com/address/0xF5681c4C0dC0c2e32C9d127b3cc0Fc992B584553) |
    | Vesting Vault | [`0x9e70276922aCC214C468ad4699eA73206b8BA286`](https://rh-scan.com/address/0x9e70276922aCC214C468ad4699eA73206b8BA286) |
    | Announcement Registry | [`0x6bA99e83EC4925D55A32cA48C693F04d02C16758`](https://rh-scan.com/address/0x6bA99e83EC4925D55A32cA48C693F04d02C16758) |
  </Accordion>

  <Accordion title="Legacy block suite v2">
    **Suite ID:** `robinhood-block-v2` · **Contract version:** `legacy-block-v1` · **Creation route:** Standard · **First indexed block:** `4,415,287`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0x76f0923Ac4dF0A079A10F628A7bcE6426CCd344A`](https://rh-scan.com/address/0x76f0923Ac4dF0A079A10F628A7bcE6426CCd344A) |
    | Launch Hook | [`0xca4b035a5DBFa2a00fC5dcb08fD1c5A22d0eAA44`](https://rh-scan.com/address/0xca4b035a5DBFa2a00fC5dcb08fD1c5A22d0eAA44) |
    | Fee Escrow | [`0x00D5701a92794c3744428B62646E7bC4e77A0A9A`](https://rh-scan.com/address/0x00D5701a92794c3744428B62646E7bC4e77A0A9A) |
    | Vesting Vault | [`0x121962Ebf01a2E7e8f0e81792e90B8F222D29016`](https://rh-scan.com/address/0x121962Ebf01a2E7e8f0e81792e90B8F222D29016) |
    | Announcement Registry | [`0xF28620D32DB0856d60c3F95536FCa36D0B35fcF0`](https://rh-scan.com/address/0xF28620D32DB0856d60c3F95536FCa36D0B35fcF0) |
  </Accordion>

  <Accordion title="Timestamp suite v3">
    **Suite ID:** `robinhood-timestamp-v3` · **Contract version:** `quote-timestamp-v2` · **Creation route:** Standard · **First indexed block:** `6,131,279`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0x411F21283D3E492BC395027329e08f9F4F560Ba5`](https://rh-scan.com/address/0x411F21283D3E492BC395027329e08f9F4F560Ba5) |
    | Launch Hook | [`0x441F773B3bb1Ed4c6457D0528624112e43C02acc`](https://rh-scan.com/address/0x441F773B3bb1Ed4c6457D0528624112e43C02acc) |
    | Fee Escrow | [`0x32f7a9A05bD62487D085Ad494e14Ec42543e19d2`](https://rh-scan.com/address/0x32f7a9A05bD62487D085Ad494e14Ec42543e19d2) |
    | Vesting Vault | [`0x6bdAAe32F36da5896533fdAD5b7A72a2541063BE`](https://rh-scan.com/address/0x6bdAAe32F36da5896533fdAD5b7A72a2541063BE) |
    | Announcement Registry | [`0x163f3A09278918bDdaf74cF2a4178F6369a9a3c1`](https://rh-scan.com/address/0x163f3A09278918bDdaf74cF2a4178F6369a9a3c1) |
  </Accordion>

  <Accordion title="Managed stock suite v4">
    **Suite ID:** `robinhood-rwa-timestamp-v4` · **Contract version:** `rwa-quote-updater-v3` · **Creation route:** Stock-paired · **First indexed block:** `18,487,505`

    | Contract | Address |
    | - | - |
    | Launch Factory | [`0xe64AC4113848BBC1a6dDE1A6D1da96720A36F297`](https://rh-scan.com/address/0xe64AC4113848BBC1a6dDE1A6D1da96720A36F297) |
    | Launch Hook | [`0x778b0c4EeA7D35D66513B587bA87FC9084b0EaCC`](https://rh-scan.com/address/0x778b0c4EeA7D35D66513B587bA87FC9084b0EaCC) |
    | Fee Escrow | [`0x4f2b1cDa8748CD64C56039bf5E2e54bC13D4A3d7`](https://rh-scan.com/address/0x4f2b1cDa8748CD64C56039bf5E2e54bC13D4A3d7) |
    | Vesting Vault | [`0xCF9ed8f4145eac9059Bcd83227eEb8591FaC0A9a`](https://rh-scan.com/address/0xCF9ed8f4145eac9059Bcd83227eEb8591FaC0A9a) |
    | Announcement Registry | [`0x6a95911db04219674323AA0137c3377523c0E29F`](https://rh-scan.com/address/0x6a95911db04219674323AA0137c3377523c0E29F) |
  </Accordion>
</AccordionGroup>

<Info>
  The current Base, Robinhood, Monad, Arc, BSC and X Layer suites are listed earlier on this page and are also included in the machine-readable registry. Historical suite contracts continue to govern their own launches, fee claims, vesting, and announcements where those capabilities exist.
</Info>

### Historical Monad suite

The previous `monad-mainnet-timestamp-v1` suite remains authoritative for its existing tokens. Its first block is `94019515`; it is not selected for new creation.

| Contract | Address |
| - | - |
| factory | [`0x54668d06C538c44Fa08558283497a1B6685AF596`](https://monadscan.com/address/0x54668d06C538c44Fa08558283497a1B6685AF596) |
| hook | [`0xF281561d2f667f9277d3b4D8553EffEE81206Acc`](https://monadscan.com/address/0xF281561d2f667f9277d3b4D8553EffEE81206Acc) |
| feeEscrow | [`0xD1F7FAC02b2A6af030cf7e9B23B7E9b7ffe31595`](https://monadscan.com/address/0xD1F7FAC02b2A6af030cf7e9B23B7E9b7ffe31595) |
| vestingVault | [`0x4e46C7f10A15eb1B98d70A7df0C9aDA8a00648E1`](https://monadscan.com/address/0x4e46C7f10A15eb1B98d70A7df0C9aDA8a00648E1) |
| announcementRegistry | [`0xD65A370D8D224DD33706d71A46A4f8c365Fc4b16`](https://monadscan.com/address/0xD65A370D8D224DD33706d71A46A4f8c365Fc4b16) |

Use this suite's original ABI and addresses for its fees, vesting and announcements.

## Staking

The staking contract is deployed at the same address on Base and Robinhood. Vault state, balances, and claims remain independent on each chain.

| Chain | Contract | Address |
| - | - | - |
| Base mainnet (`8453`) | Staking contract | [`0x6f25a9e1e677616c1bF7ab54b470b0c82839Adb4`](https://basescan.org/address/0x6f25a9e1e677616c1bF7ab54b470b0c82839Adb4) |
| Robinhood Chain (`4663`) | Staking contract | [`0x6f25a9e1e677616c1bF7ab54b470b0c82839Adb4`](https://rh-scan.com/address/0x6f25a9e1e677616c1bF7ab54b470b0c82839Adb4) |

The following mutable staking configuration is the same on both networks and was verified onchain on **August 19, 2026**:

| Setting | Value |
| - | - |
| One-time protocol fee | 50% of the complete reward budget (`5000` bps) |
| Fee recipient | `0xDB781755E8fFaD2d6CBa99a9FAd06C1c79587957` |
| Contract owner | `0xDB781755E8fFaD2d6CBa99a9FAd06C1c79587957` |

The fee is added to the vault's reward budget and paid in the selected reward currency when the vault is created. The owner can update the fee rate and recipient for future vault creation, up to the contract's 100% hard cap. If the configuration changes between review and submission, creation stops so the creator can review the updated amount. Fee changes cannot alter an existing vault, withdraw its accounted principal or rewards, or affect participant claims.

There is one separately deployed staking contract on each supported chain. Individual vaults are records inside that contract, not separate deployments. See the [staking guide](/launchpad/staking/overview) for the complete user flow.

## Governance and fee recipient

The shared governance addresses below are the release configuration for Standard, Tax and \$O launches. Read the selected Factory's current roles before relying on authority; chain-specific dated observations remain in each configuration snapshot. The platform treasury receives Standard/Tax fees only; \$O launches have no treasury allocation. See [Live configuration](/launchpad/reference/live-configuration) for chain-specific settings and verification dates.

<CardGroup cols={1}>
  <Card title="Governance owner and creator admin" icon="shield">
    `0x5519a8Cc7211F483e19ff8d50A3B0c892701044D`

    [Base explorer](https://basescan.org/address/0x5519a8Cc7211F483e19ff8d50A3B0c892701044D) · [Robinhood explorer](https://rh-scan.com/address/0x5519a8Cc7211F483e19ff8d50A3B0c892701044D) · [Monad explorer](https://monadscan.com/address/0x5519a8Cc7211F483e19ff8d50A3B0c892701044D) · [Arc explorer](https://explorer.arc.io/address/0x5519a8Cc7211F483e19ff8d50A3B0c892701044D) · [BSC explorer](https://bscscan.com/address/0x5519a8Cc7211F483e19ff8d50A3B0c892701044D) · [X Layer explorer](https://xlayerscan.com/address/0x5519a8Cc7211F483e19ff8d50A3B0c892701044D)
  </Card>

  <Card title="Platform and protocol treasury" icon="wallet">
    `0x1cAa1962428382106Eb3f29B9719bdF797621C90`

    [Base explorer](https://basescan.org/address/0x1cAa1962428382106Eb3f29B9719bdF797621C90) · [Robinhood explorer](https://rh-scan.com/address/0x1cAa1962428382106Eb3f29B9719bdF797621C90) · [Monad explorer](https://monadscan.com/address/0x1cAa1962428382106Eb3f29B9719bdF797621C90) · [Arc explorer](https://explorer.arc.io/address/0x1cAa1962428382106Eb3f29B9719bdF797621C90) · [BSC explorer](https://bscscan.com/address/0x1cAa1962428382106Eb3f29B9719bdF797621C90) · [X Layer explorer](https://xlayerscan.com/address/0x1cAa1962428382106Eb3f29B9719bdF797621C90)
  </Card>

  <Card title="Restricted opening-price updater" icon="chart-line">
    `0x8BF6eb1EaA9bE34a068c56945a36a23520705F29`

    [Base explorer](https://basescan.org/address/0x8BF6eb1EaA9bE34a068c56945a36a23520705F29) · [Robinhood explorer](https://rh-scan.com/address/0x8BF6eb1EaA9bE34a068c56945a36a23520705F29) · [Monad explorer](https://monadscan.com/address/0x8BF6eb1EaA9bE34a068c56945a36a23520705F29) · [Arc explorer](https://explorer.arc.io/address/0x8BF6eb1EaA9bE34a068c56945a36a23520705F29) · [BSC explorer](https://bscscan.com/address/0x8BF6eb1EaA9bE34a068c56945a36a23520705F29) · [X Layer explorer](https://xlayerscan.com/address/0x8BF6eb1EaA9bE34a068c56945a36a23520705F29)
  </Card>
</CardGroup>

The current owner controls configuration for future launches, and the creator admin may immediately reassign creator rights without gaining token or liquidity custody. The treasury receives the Standard platform share or the Tax protocol share, plus the configured native launch fee for its suite. The restricted price updater can change only the opening frame of an already registered quote for future launches. These roles cannot change fixed token supply or remove launch liquidity. Each Tax suite has its own factory and explicit Dividend administration described in [Configuration and governance](/launchpad/architecture/deployment-governance#tax-policy-and-dividend-administration).

## Verification links

Address links open chain explorers or verified source records. Base's native B20 addresses are also defined in the [Base B20 specification](https://docs.base.org/base-chain/specs/upgrades/beryl/b20). The [official Uniswap v4 deployment list](https://developers.uniswap.org/docs/protocols/v4/deployments) is a reference for networks it lists; the chain-specific addresses above identify the dependencies used by each o1 deployment.

See the [machine-readable deployment snapshot](/launchpad/reference/production-deployments.json) for normalized contract addresses and current launch configuration values. The staking deployment and its dated live fee configuration are listed above.

## SwapX router upgrade review

PR [#552](https://github.com/o1exchange/o1-launch/pull/552) updates the application to match the router implementations recorded on September 28, 2026. Router proxy and deployed adapter addresses are unchanged. Each Standard or Tax suite retains its own immutable adapter; call the proxy, not the implementation address.

| Chain | Implementation | Last recorded verification block |
| - | - | -: |
| Base | `0xf7eefa263c4ba61cd48db3ece3635e6d644208bd` | 51,890,305 |
| Robinhood | `0xea1b7a2c740c1f77d7f8b9d71bc632517fbf8d91` | 74,513,628 |
| BSC | `0x2495b2563d1c0835eb611e4d2817f10c185b2c52` | 124,461,369 |
| Monad | `0x0922aa41e2464b5c629add39f5be306931578943` | 108,656,782 |
| X Layer | `0x9127db0b3841fbd76eec3cf297ac47592fe2fd80` | 71,800,935 |

These are the implementation identities in the repository's dated [five-chain review](https://github.com/o1exchange/o1-launch/blob/main/docs/TAX_TOKEN_MULTICHAIN_DEPLOYMENT.md#five-chain-swapx-upgrade-review-28-september-2026), not a fresh live read by this documentation update. Robinhood's implementation is unchanged by this PR. The recorded router owner is `0xfF72996FBEDb56d0A3D5295d26eB358f8EC57ca8`; all five were unpaused with zero router fee. Router control is separate from factory governance.

Both Robinhood and X Layer suite Hooks were approved. X Layer's updated application admits minimal-v4 and Tax v2 through an explicit Hook allowlist; unknown Hooks remain rejected. The other checked routers do not expose the same approval getter. This does not imply unrestricted authorization.

The maintained fork evidence exercises the real router and PoolManager, launch simulation, minimum-output rollback, fee accounting and subsequent sells. Monad covers MON and MON-funded USDC/WETH; X Layer covers OKB and OKB-funded USDT. Clean and one-wei pre-existing-native cases passed. The Base/BSC/Robinhood evidence is reused only where implementation hashes match. Earlier minimal-v4-only and native-donation blockers are superseded for these implementations and tested routes.

This is not exhaustive stock-route, arbitrary ERC-20-donation or hosted wallet acceptance. Full source and ABI provenance for the upgraded implementations remains unverified in that review; historical full ABI artifacts do not prove the current implementation's complete interface. Retain chain-specific execution tuples and final simulation. Use the listed route bindings and simulate the complete transaction for the requested amount.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
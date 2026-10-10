# filter-manifest (standalone, offline)

This tool compiles exact subscription-filter manifests for root direct/native measurements. It compiles **filters only**.
- It makes no subscriptions and no RPC, node, network, explorer or deploy calls.
- It reads no clock and writes no files; the manifest goes to stdout.
- It is not delivery, latency, completeness or source-admission evidence.

## Source pin

The pin is `jhacksman/aromer` immutable `main` `5669951760682d1046d109a3f489b61f770cf0c2`. The retained bytes are vendored under `sources/aromer-5669951/`, and every one is sha256-checked on each run.

| key | aromer path | sha256 | use |
|---|---|---|---|
| census | `docs/realignment/o1-census-contract-20261010.json` | `efda199e…42cff8` | `factories` rows 1–6, the canonical six-row allowlist |
| constants | `aromer/core/constants.py` | `b7d78011…a07391` | l.236–241 is the declared Initialize/Swap topic pin; l.79 is the PoolManager address |
| productionContractsMd | `docs/realignment/evidence/o1-attr4-2026-10-10/docs_o1_exchange_launchpad_reference_production-contracts_md` | `b0f53ce4…efd1eff4e4fc` | supporting address occurrence only; row 6 is absent |
| suitesCheckpoint | `docs/realignment/evidence/o1-attr4-2026-10-10/launch_o1_exchange_launch-contract-suites_json` | `d019f01a…e2123612f` | **INVALID evidence**: an HTTP 429 Vercel checkpoint HTML page. It is hashed only and never parsed. |

## Derivation

- *Topics:*
  - Each declared signature at constants l.236–241 must have keccak256 (implemented in `keccak.mjs`) equal to its declared hex.
  - That gives Initialize `0xdd466e67…6438` and Swap `0x40e9cecb…112f`.
- *PoolManager:* `0x498581ff718922c3f8e6a244956af099b2652b2b`, from constants l.79. It also appears at md l.84 and l.133.
- *Factories:* census `factories."1".."6".factory`, with exactly 6 rows.

## Filtersets

- `poolmanager.initialize_swap`: `{address:[PoolManager], topics:[[Swap, Initialize]]}`, meaning topic0 is either one.
- `o1.factories.raw_all_topics`: `{address:[six, sorted]}`.
  - It has no `topics` key, so all topics match.
  - There is no ABI or unknown-event exclusion and no pool list.

Each filter is canonical JSON with sorted keys and lowercase addresses. It carries a `filterSha256`, and the whole manifest carries a `manifestSha256`.

The `comparison` section states that a direct and a native run are comparable only if they used the same `filterSha256` per filterset, the same window and the same caps. Both lanes are `NOT_RUN`, because the root owns them.

## CLI

`node compile.mjs --spec <spec.json> [--sources <dir>]`

- Exit 0 prints the manifest.
- Exit 2 prints `{"refused":<reason>,"detail":…}`.

## Input schema `filter-manifest-input/1`

Every field is required and unknown fields are refused. Duplicate JSON keys, `__proto__` and invalid UTF-8 are also refused.

```json
{ "schema": "filter-manifest-input/1",
  "sourcePin": { "repo": "jhacksman/aromer", "commit": "5669951760682d1046d109a3f489b61f770cf0c2" },
  "poolManager": { "address": "0x…40 lowercase hex", "topics": { "Initialize": "0x…64", "Swap": "0x…64" } },
  "factories": [ { "row": 1, "address": "0x…" }, … six rows 1–6, any order ],
  "window": { "fromUtc": "YYYY-MM-DDTHH:MM:SSZ", "toUtc": "…Z", "durationS": <int = toUtc − fromUtc> },
  "caps": { "maxRawEvents": <int ≥ 1>, "maxBytes": <int ≥ 1> } }
```

Every caller value must equal the derived value; the compiler never fills one in. Refusal reasons:
- *Source:* `source_pin_mismatch`, `source_hash_mismatch`, `source_<key>_missing` and `source_<key>_is_symlink`.
- *PoolManager:* `pool_manager_mismatch`.
- *Topics:* `topic_malformed`, `topic_mismatch`, `topic_declaration_*`.
- *Factories:* `missing_suite_row`, `factory_row_invalid`, `factory_row_duplicate`, `factory_address_duplicate` and `factory_mismatch`.
- *Spec shape and JSON:* `address_malformed`, `spec_missing_field`, `spec_unknown_field`, `spec_malformed`, `json_malformed`, `json_duplicate_key` and `json_forbidden_key`.
- *Window and caps:* `window_invalid` and `cap_invalid`.

The window and caps are recorded verbatim.
- The window is not checked against any clock; the root owns the valid window.
- The caps are stop limits, not a volume estimate.

## Tests

`node test.mjs > test.out` runs synthetic acceptance cases only. `fixtures/spec.synthetic.json` uses a placeholder window from 2000-01-01T00:00:00Z to 01:00:00Z and synthetic caps.
- The output is deterministic, with no timing.
- `evidence/results.json` holds expected vs actual for every case.
- `evidence/manifest.synthetic.json` is the compiled synthetic manifest.

## Limits

- *Binding:* `UNKNOWN`, and source admission is `NOT_ESTABLISHED`.
  - The topic pin is a retained declaration in constants.py, not a primary contract ABI.
  - The factory rows are retained census rows; their on-chain binding isn't proven.
  - Row 6 is absent from the retained production-contracts md.
- *Filter semantics:* the filter is an `eth_subscribe("logs")`/`eth_getLogs`-shaped object.
  - It has no chain id, because the pinned sources don't state one as a filter field.
  - Removed/reorg handling and Q2 identity are out of scope.
- *Address case:* addresses must be lowercase. EIP-55 checksums aren't verified.

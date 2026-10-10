# Native-run preflight validator — contract (`native-preflight-input/1` → `native-preflight-result/1`)

Offline preparation component. `node preflight.mjs <operator-input.json>` reads one operator-supplied JSON file and
nothing else: no network, no node/RPC/WS, no process start/stop, no service, no deploy, no environment, no wall clock.
It does not modify or depend on #173 `5206f90`, the HTTP/WS guards, joint guard `54ba98a`, audit `419346d` or the owner
proposal `1c51981`; it only names their pins.

**Readiness is not admission.** `READY` means every required proof was supplied and is mutually consistent. It is not
DAT-SRC-011 admission, performance or latency evidence. Run outcomes are refused as input: any key named `results`,
`outcome(s)`, `latency`, `dat_src_011`/`datSrc011`, `admission`, `performance` or `pass` at any depth → exit 2.

Exit: `0` READY · `1` NOT_READY · `2` malformed/refused input. Each prerequisite is `known`, `missing` or `invalid`
with reasons. `null`, `""`, `unknown`, `tbd`, `todo`, `?`, `n/a`, `none`, `null` are **missing**, never defaulted.

| Prerequisite | `known` requires | `invalid` when |
|---|---|---|
| `pins` | collector, nativePath, reference: 40-hex `commit` + `tree`, 64-hex `manifestSha256` | malformed; a docs-only head (`d7719e5`, `419346d`, `1c51981`) used as source |
| `filters` | both arms: 64-hex `digest`, explicit non-empty `address` arrays (lowercase), topics without null/wildcard | arms differ (canonical JSON or digest); extra filter keys |
| `window` | both arms: decimal int64-ns `startNs` < `endNs`, `clock: "mono_ns"` | arms differ; non-decimal; end ≤ start |
| `clock` | both arms: `host_id`, lowercase-uuid `boot_id`, `unit: "ns"`, measured `clock_uncert_ms` | different host or boot; unit ≠ ns |
| `provenance` | DAT-PRV-002: `source_id`, `capture_source` (enum), endpoint, `client_version`, decoder/registry versions, `license_class`, `partition`; `rawWriter{location, pin, ackBinding:["id","epoch","seq"]}` | enum violation; `raw_ref` or `t_ingest` pre-supplied (they exist only after the Tier-0 writer ack, DAT-PRV-001/003) |
| `caps` | finite positive `reconnect`, `wsMessages`, `wsBytes`, `backfillBlocks`; `enforcedInSource: true`; `enforcementPin` = collector pin | non-integer; pin ≠ collector pin |
| `freshness` | `source: "operator_supplied"`; `asOfUtc`; `maxAgeS`, `maxEvidenceAgeS`; HTTP `{observedAtUtc, head, ageS}`; WS `{observedAtUtc, heads ≥ 2 consecutive, ageS}`; `recovery: "complete"` | age > `maxAgeS`; evidence older than `maxEvidenceAgeS` vs `asOfUtc` or after it; WS head gap/regression; `recovery: "partial"` |
| `defect:M1`, `M2`, `provenance`, `inSourceCaps` | explicit `state: "resolved"`, `pin` = collector pin, non-empty `oracle` ids, `reviewRef` | resolved claimed on a pin with the defect recorded; pin ≠ run pin |
| `defect:jointIntegration` | same, with `pin` = nativePath pin | same |

`unresolved` and an absent flag are **missing**. Built-in known-defect pins override operator claims:
`5206f90` (M1, M2, provenance, inSourceCaps — audit `419346d`) and `54ba98a` (jointIntegration — fake-loopback only,
unwired). Freshness is checked only against the operator's `asOfUtc`; the validator never reads a clock, so the
operator is responsible for supplying a truthful `asOfUtc`.

## Fixtures (`fixtures/`, hermetic) and `test.mjs`

| Fixture | Expected |
|---|---|
| `current-419-173-54` | NOT_READY: real pins `5206f90`/`54ba98a` with Codex's 05:35:41Z/05:36:21Z fresh-node observation (freshness `known`); pins (no #173 MANIFEST), window, clock, provenance, caps and all five defect flags `missing` |
| `claim-resolved-on-173` | NOT_READY: operator claims M1 resolved at `5206f90` → `invalid` |
| `corrected-full` | READY: **synthetic** pins `aaaa…`/`bbbb…`/`cccc…`/`dddd…` (not real heads); proves the READY path only |
| `stale` | freshness `invalid` (evidence 66 min old, head age 30 s) |
| `partial-recovery` | freshness `invalid` (recovery partial, WS head gap) |
| `mismatched-filters` | filters `invalid` (reference drops one factory, digest differs) |
| `mismatched-clock` | clock + window `invalid` (other boot_id, `ms`, window end differs) |
| `unknown-proof` | provenance + defect:M2 `missing` (`client_version: "unknown"`, writer location null, M2 flag absent) |
| `forbidden-outcome` | exit 2: `dat_src_011` outcome supplied |

`node test.mjs` runs all fixtures through the CLI, checks exit codes, verdicts, every expected status, a reason on each
non-`known` item, READY ⇒ all known, and statically that `preflight.mjs` imports only `node:fs` and uses no
fetch/require/env/spawn/exec/WebSocket/`Date.now`. Output kept in `test.out`.

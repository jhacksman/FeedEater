# Native-run preflight validator: contract (correction 1 of `2b3cead`)

Offline. `node preflight.mjs <operator-input.json>` reads one JSON file. It does not touch the network, a broker, the node, processes, the environment or the clock (statically checked in `test.mjs`).

Exit codes: 0 = `READY`, 1 = `NOT_READY`, 2 = refused (malformed input, wrong schema, outcome keys, or self-attested registry/owner keys).

`READY` is **not** DAT-SRC-011 admission, performance or latency evidence. It validates no run outcome, and it makes no claim about Aromer processing unless `claimScope` includes `aromer_measurement`.

## Fail-closed bindings
- **Reviewed registry, built in:** `REVIEWED` lists the reviewed `{commit, tree, manifestSha256, resolves[]}` entries for the roles `collector`, `nativePath`, `reference` and `rawWriter`.
  - It is **empty** at this commit, because no reviewed corrected source exists. The CLI therefore cannot print `READY`.
  - An entry can only be added by a reviewed commit to `preflight.mjs`. Input cannot extend the registry: keys such as `reviewedPins`, `registry`, `ownerRecords` or `waiver` are refused with exit 2.
- **Pin status:**
  - A pin that is not in the registry for its role is `missing`, whatever its hex value or `reviewRef`.
  - Commit, tree or MANIFEST mismatching the registry entry is `invalid`.
  - A pin in the denied table is `invalid` for the affected roles:
    - `5206f90`: frozen #173 with M1, M2, provenance and caps recorded;
    - `54ba98a`: fake-loopback only, unwired;
    - `56fde238`: fork main; FeedEater Base-module output is never a source of record;
    - the audit and proposal heads (docs only): `d7719e5`, `419346d`, `b9dd122`, `1c51981`, `861bb80`.
- **Defect flags** M1, M2, provenance, inSourceCaps and jointIntegration:
  - `resolved` is `known` only when the registry entry for the run pin lists that defect in its `resolves`.
  - `resolved` without that backing is `invalid`.
  - `unresolved` or an absent flag is `missing`.
- **Spec questions** (proposal `861bb80`, audit `b9dd122`): these stay `missing` until a built-in `OWNER_RECORDS` entry exists. There is no waiver path.
  - `spec:Q1`: `raw_ref`/`t_ingest` vs the writer ack.
  - `spec:Q2`: the natural key.

## Prerequisites
| id | known only when |
|---|---|
| claimScope | non-empty subset of `native_collector_run`, `aromer_measurement`, and it includes `native_collector_run` |
| pins | collector, nativePath and reference each match a reviewed registry entry (above) |
| filters | each arm equals the canonical PoolManager `0x4985…2b2b` Initialize+Swap filter plus the six-factory address filter, ignoring order; no null wildcards; both 64-hex digests equal. Arms that match each other but differ from the canonical set are `invalid`. The digest is not recomputed. |
| window | both arms use `clock: "mono_ns"`, with decimal int64 `startNs`/`endNs`, a duration in [60 min, 24 h], and identical windows |
| clock | same `host_id` and `boot_id` (uuid), `unit: "ns"`, and a measured `clock_uncert_ms` in [0, 1000] on both arms |
| provenance | the DAT-PRV-002 strings are present and non-placeholder, and `capture_source` is in the enum. `raw_ref`/`t_ingest` must not be supplied (`invalid` if they are). `rawWriter.pin` is a reviewed `rawWriter` entry (DAT-PRV-001 writer). |
| caps | `reconnect`, `wsMessages`, `wsBytes` and `backfillBlocks` are finite positive integers, `enforcedInSource: true`, and `enforcementPin` equals the collector pin |
| freshness | `source: "operator_supplied"`; `asOfUtc` and every `observedAtUtc` are calendar-valid ISO-8601 UTC times (`Z`, years 2020–2100). `maxAgeS` is in (0, 10] and `maxEvidenceAgeS` in (0, 600]. Both the HTTP and WS heads are within `maxAgeS`, and both observations are no older than `maxEvidenceAgeS` before `asOfUtc` and not after it. WS needs at least 2 consecutive heads. The last WS head minus the HTTP head must be within ±3 of the time between the two observations divided by 2 s. `recovery: "complete"`; `partial` is `invalid`. |
| aromer | only when `aromer_measurement` is claimed: the Aromer observation is fresh (`feedState: "up"`, age ≤ `maxAgeS`) |
| spec:Q1, spec:Q2 | an owner record exists (above) |
| defect:* | as above |

Aromer processing is always reported in `aromerProcessing` as one of `NOT_SUPPLIED`, `BLOCKED_STALE`, `INVALID_OR_INCOMPLETE` or `FRESH_OBSERVATION`. A stale Aromer observation blocks an Aromer measurement claim. It does not block a native-collector-run claim scoped separately, and it is never reported as transport readiness.

## Never
- Missing or unknown values are never turned into `known`. All of these count as missing: `unknown`, `pending`, `placeholder`, `tbd`, `unresolved`, `n/a`, an empty string, `null`, and repeated-character hex.
- Run outcomes are never accepted. Keys are normalized (lowercase, alphanumerics only) at every depth; `result(s)`, `outcome(s)`, `latency*`, `p99*`, `dat_src_011*`, `admission`/`admitted`, `performance`, `pass(ed)`, `success`, `verdict` and `ready` are refused.

## Fixtures and tests
- `gen-fixtures.py` regenerates `fixtures/*.json` deterministically. Synthetic pins are sha1 hashes of labels, not real heads.
- `fixtures/SYNTHETIC-REGISTRY.test-only.json.txt` is read only by `test.mjs`, in-process. The CLI never reads it.
- `test.mjs`:
  - static checks;
  - date checks;
  - the CLI matrix: every fixture is `NOT_READY` or refused under the shipped registry;
  - the in-process matrix: under the synthetic registry, `corrected-full` is `READY` and each mutation alone yields exactly its declared non-known prerequisites.
- `current-0547` holds the supplied 05:47:11Z HTTP head 52410942 (age 0.72 s), the 05:36 WS heads and the Aromer observation (PID 18507, head 52318772, age 184340.7 s, `feed_down`). It is `NOT_READY` because:
  - the pins are denied;
  - window, clock, provenance and caps are missing;
  - at `asOfUtc` 05:47:20Z the WS evidence is stale;
  - Q1/Q2 and all defects are unresolved.

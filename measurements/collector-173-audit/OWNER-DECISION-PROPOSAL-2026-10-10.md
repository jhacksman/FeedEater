# Owner-decision proposal: frozen #173 `5206f90` and unwired joint guard `54ba98a` (2026-10-10)

Docs + inert JSON (`owner-decision-oracle-2026-10-10.json`) only. No implementation, and **no implementation approval is
requested by this document**. Reviewable without T7: every reference is a git object in jhacksman/FeedEater or jhacksman/aromer.
Pins (immutable, preserved whole): #173 `5206f9035ad1c057d78990b294941221e936f895`; joint guard `54ba98a98bce1eb307852861deb394ef196638ae`
(MANIFEST 385 files); audit rev 1 `d7719e533f170222bbe3a8548090e8c9e579d42b`, rev 2 `419346d7f774118b66cb786397ea015709280345`
(diff = `git diff d7719e5 419346d`); spec aromer main `68da3589baa8dbc8cdee538facd342a4969b1a96` `docs/spec/v1/SPEC-v1.md`
l.1075–1093 (DAT-PRV-001..004), l.1116–1127 (DAT-TIM-001/002). Source paths are under `modules/base-collector/` at `5206f90`.

## 1. Four separable scopes (each a separate candidate if retained; none implies another)

**S1 — M1 status-silence / time window (measurement harness only).** Functions: `Measurement.recordBus`
(`src/measure.ts:130`) appends statuses/heartbeats; `Measurement.report` (`src/measure.ts:175`) selects in-window samples
(l.236–238) and sets `persistence = ok_every_sample` when `states.ok > 0 && heartbeats > 0` (l.262–269). No maximum
inter-sample gap and no coverage of `[window_start, window_end]` by samples. Expected vs observed (Codex repro,
aromer `6da930b` `docs/realignment/O1-INPUT-CHECKPOINT-2026-10-10.md:62-68`): 30-min window, statuses at 0/10 s,
heartbeat at 10 s, matched Initialize/Swap at 1 s → expected **refuse** (1,790 s without status); observed source
validation + DAT-SRC-011 pass. Smallest scope: a declared `maxStatusGapMs` / `maxHeartbeatGapMs` including the gaps
window_start→first and last→window_end; any gap over the bound → `status_silence` in `notCovered`, dat011 false.

**S2 — M2 malformed status fail-closed (harness only).** `recordBus` reads `st.persistence.state` unguarded
(`src/measure.ts:135`); the bus callback in `src/main.ts:126-132` wraps it in `try { … } catch { /* ignore non-JSON */ }`,
so a status without `persistence` throws and vanishes. Expected: counted as `malformed_status`, persistence becomes
**explicit unresolved** (`unresolved_observed`, never `ok`/`not_observed`), window not validated. Smallest scope: schema
check in `recordBus` + a counted parse-failure path in the `main.ts` callback; no silent catch.

**S3 — DAT-PRV-002 provenance on `LogRecord` (collector).** Record type `src/types.ts:51-73`, built in `Collector.ingest`
(`src/collector.ts:322`, l.363–384), published by `Collector.publish` (l.398, sync `bus.publish` l.401) from
`Collector.handleMessage` (l.288, l.302). Missing V1 `source_id`, V3 endpoint/`client_version`, V4 `decoder_version`/
`registry_version`, V5 `raw_ref`, V6 license classes, V8 `partition`; partial V2 (`path/realtime/recovery`, not the
`capture_source` enum) and V7 (`receivedAtMs` wall ms only). Honest seam: DAT-PRV-001 requires a raw Tier-0 append
before decoding by a **separate writer behind a bounded queue**, and DAT-PRV-003 forbids awaited I/O before publish.
Therefore `raw_ref` (file, offset, sha256) and `t_ingest` (durable append) **cannot be known at publish time** on this
path; they must arrive later as a writer acknowledgement keyed to the record (`id`, `epoch`, `seq`) and stay
`unresolved` until then. No candidate may fill them with predicted or placeholder values. Fields knowable before publish
without I/O: `source_id`, `capture_source`, endpoint (configured), `client_version` (read once at connect, outside the
message path), decoder/registry versions, `partition`, `t_recv_wall_ns` + `t_recv_mono_ns` + `boot_id` + `host_id`
(int64 ns per DAT-TIM-002), `t_publish` (mono ns, set immediately before `bus.publish`), `t_event` from
`blockTimestamp` when the node supplies it (else `ts_source` absent → unresolved), `clock_offset_est_ms` /
`clock_uncert_ms` (unknown unless measured; never 0 by default), license class (`unknown` until declared).

**S4 — C6/C7 caps and joint-guard integration.** Collector: `Collector.onOpen` resets `reconnectAttempt` (l.225, l.236)
before `reconcile` (l.537; backfill cap only truncates, l.550–554); `Collector.onDisconnect` schedules unbounded retries
(l.247, l.257–260); no WS message/byte/cumulative-backfill counter anywhere in `src/`. Joint guard `54ba98a`
`measurements/base-collector-173/joint-guard.mjs`: `decide` l.195, `stopAll` l.199 (latch l.201), HTTP `hHandle` l.236 /
`pump` l.281 / `forward` l.288, WS `wsAdmit` l.404 / `wsSend` l.411; `joint-run.sh` relays TERM/INT before client grace.
Integration (not done) = run-native wiring + one counted hop on **both** arms or neither.

## 2. Options per scope (owner chooses; no open-ended loop)

| Option | Meaning | Gate |
|---|---|---|
| R — retain one bounded new candidate | one new branch from the stated pin, ≤ 2 correction rounds, then freeze | Codex/A7 whole review on the oracle cases below before any further scope |
| P — park | pinned heads stay immutable; scope recorded as open blocker; no work | none |
| A — reassign | another lane/agent takes the scope from the same pins and oracle | same oracle; this lane stops |

Defaults are not proposed. S1+S2 are harness-only and independent of S3/S4. S4 integration depends on S1/S2 (a guarded
run measured by a defective harness proves nothing). S3 is independent of S1/S2/S4 but changes the record schema
consumed by the persister (`src/persister.ts`) and measure; that coupling is part of S3's review.

## 3. Timing and evidence classes (must not be conflated)

* **Fake joint macOS 139/139 PASS** (`54ba98a`): fake-loopback decision ordering only — zero post-latch admission/forward
  decisions, reconciled censuses, owned cleanup. Not latency, not node, not admission.
* **Harness "added latency"** (`src/measure.ts` `recordDirect` l.110 vs `recordBus` l.130, both `hrtime` in the measure
  process): bus receipt minus direct receipt on one host. It includes collector receive, publish and NATS delivery; it
  is **not** the collector's own `t_publish − t_recv` (neither clock is on `LogRecord` today).
* **Complete reference window**: DAT-SRC-011 (a) needs 60 min of a raw reference subscriber on the same node with
  every window block covered; S1 is the precondition for asserting coverage.
* **Actual native / Thor DAT-SRC-011**: none exists for #173. Nothing in this lane produces one without S1+S2 and an
  owner-approved native run; even then admission also needs DAT-PRV-002 (b), i.e. S3.

## 4. Minimum integration steps if all four are retained (order fixed, each gated)

1. S1+S2 candidate (harness) → oracle O1–O6 → review → freeze.
2. S3 candidate (collector record + writer ack seam) → oracle O7–O11 → review → freeze.
3. S4a collector in-source caps (O12–O14) → review → freeze. S4b run-native wiring of the joint guard on both arms
   (O15–O16) → review → freeze.
4. Owner-approved native run. Missing native inputs today: fresh node head (node heads stale), a declared window,
   reference-subscriber host binding, `client_version` capture, license class declaration, writer (Tier-0) location.

## 5. Oracle (inert; exact cases in the JSON)

O1 1,790 s silence → refuse; O2 gap at window start / end → refuse; O3 every gap ≤ bound → covered (control);
O4 status lacking `persistence` → `unresolved_observed`, counted, not validated; O5 non-JSON → counted, not swallowed;
O6 unresolved then ok → stays unresolved; O7 every pre-publish field present on 100 % of fixture records;
O8 `raw_ref`/`t_ingest` absent until writer ack, then exactly the acked values; O9 writer stalled → publish not delayed,
fields unresolved; O10 int64-ns clocks identical under three `TZ`; O11 no awaited I/O between receive and publish
(static + trace); O12 reconnect N+1 → STOP; O13 WS message/byte cap → STOP; O14 cumulative backfill cap → STOP;
O15 first stop → 0 post-latch HTTP and WS decisions (as `54ba98a`); O16 hop on both arms, its overhead reported
separately from DAT-SRC-011.

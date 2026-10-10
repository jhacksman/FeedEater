# Joint admission/STOP interface proposal (evidence-only, 2026-10-10, parent af53a874)

This is a proposal only. Nothing is implemented. It makes no edits to 4df26b2, f694290 or #173 5206f90,
it does not rerun the drill, and it makes no node, service, latency or admission claim. It is derived
from the `af53a874` reproductions in `COMPOSE-DRILL.md`. The machine-readable form is
`joint-stop-contract.json` (inert).

## Reproduced failure (af53a874)
- Gap 1: after the first HTTP stop, WS kept forwarding: 22, 12, 306 and 456 frames, over 0.27, 0.16,
  3.2 and 4.7 s.
- Gap 2: after the first WS stop, HTTP kept admitting: 4 and 5 requests, over 0.26 and 0.24 s.
- Gap 3: `guard-run.json` has no WS reason and no WS census.

## Interfaces pinned at the frozen heads
| Head | File:lines | Behaviour that causes the gap |
|---|---|---|
| 4df26b2 | guard-run.sh:123 | starts only `rpc-guard.mjs`; no second guard and no shared STOP |
| 4df26b2 | guard-run.sh:139,143 | the loop watches only `$RUN/guard.STOP` and the client PID |
| 4df26b2 | guard-run.sh:107,111 | `outcome` stops only `$GPID`, then `stop_client` (grace); WS forwarding continues during the grace |
| 4df26b2 | guard-run.sh:119 | the `guard-run.json` schema has no transport, census or second-guard fields |
| 4df26b2 | guard-run.sh:134 | the client gets only `FE173_GUARD_URL`/`BASE_COLLECTOR_HTTP_URL` |
| 4df26b2 | rpc-guard.mjs:140,170,195-207,300-301 | its latch (`guard.STOP`, `halt`, `pump`, signals) lives only in its own process |
| f694290 | ws-guard.mjs:74-77,104,157-225,261-262 | its latch (`stopReason`, `ws-guard.STOP`, admit/forward checks, signals) lives only in its own process |
| 4df26b2 | lib-run.sh:61-63 | `fe_cleanup` stops PIDs in reverse registration order, so ws-guard stops after the client |

## Minimal shared state
One latch per run, set exactly once:
`{stopped, reason, transport: http|ws|signal|controller, seq, hrNs}`.

1. Every admission or forward decision on either transport, in either direction, reads the latch
   synchronously in the same code path. That covers HTTP admit, the paced send, WS frame admit and
   WS send.
2. Setting the latch is the first stop. Before the latch can be observed:
   - no new HTTP request is admitted and no queued HTTP request is sent;
   - no WS frame is admitted or forwarded.

   After it is set: both listeners close, queued HTTP requests get an explicit 503 and are counted
   as dropped, queued WS frames are dropped and counted, and WS connections close with 1008.
   `JOINT.STOP` is written.
3. One clock and one ordering: a single `process.hrtime.bigint()` and one global `seq`. Every decision
   is logged with its `seq` in one exclusive JSONL file.
4. The census reconciles in one summary.
   - HTTP: `received = admitted + refused`, `admitted = forwarded + dropped`,
     `forwarded = completed + upstreamErrors + inflightAtExit`.
   - WS: `received = admitted + refused + dropped`, `admitted = forwarded + sendErrors + inflightAtExit`.
   - Also `firstStop` and `decisionsAfterStop{http,ws}`.
5. Owned shutdown: the controller signals the client (with its grace) only after `JOINT.STOP` exists.
   Then the existing PID + `lstart` and container-label verification applies, with 13/14 overriding.

## Single process vs cross-process: can zero post-stop forwarding be guaranteed?
- **Single-process shared gate: yes, for decisions.**
  - Node runs every admit and forward callback to completion on one event loop. If the latch is set
    synchronously inside the callback that detects the first error, cap or signal, every later
    callback sees it. So a decision with `seq` greater than the stop `seq` is impossible by
    construction, and it is checkable exactly from the log by `seq`, not by time.
  - Not covered: bytes already handed to the kernel by a `send`/`write` before the latch. Those are
    counted as forwarded before the stop, or as in flight at exit. They are not post-stop decisions.
  - An external signal latches when its handler runs. Traffic before that is pre-stop by definition.
    The interval from the controller receiving the signal to the latch is reported, not hidden.
- **Cross-process signalling: no.** This covers STOP files, signals, pipes and per-frame file checks.
  - Each process holds its own latch. Between process A latching and process B observing it, B can
    decide.
  - The observation lag depends on OS scheduling and has no hard upper bound. af53a874 measured
    0.16–4.7 s through the controller and 0.24–0.26 s through polling.
  - Even a stat of a shared file before every decision leaves a check-then-act race: A latches after
    B's check but before B's send.
  - Zero is only achievable by making every decision acquire a cross-process lock that A also holds
    while latching. That serializes both transports, and Node has no native `flock`. In effect it
    reintroduces a single admission authority.
  - No tolerance is proposed for this option, so it cannot meet "zero after first stop".

## Smallest separate new component (proposed, not built)
- `joint-guard.mjs`: one loopback process with two listeners, HTTP and WS, and one latch, one `seq`
  and one summary.
  - The admission rules are copied from rpc-guard@4df26b2 and ws-guard@f694290: allowlists, caps,
    pacing, timeout, bounded quantities, filters, frame, byte, message, duration and connection caps,
    and no reconnect.
  - Those two files cannot be imported: they are CLIs with top-level side effects. The copies would be
    pinned by sha256 provenance and a reviewed diff.
- `joint-run.sh`: guard-run.sh@4df26b2 with only lines 123 (guard command), 139/143 (`JOINT.STOP`),
  134 (export both URLs) and 119 (joint census fields) changed. The diff would be pinned against
  4df26b2.
- The frozen candidates stay unchanged and remain the reference for both admission rule sets.

## Predeclared finite fake-loopback acceptance cases (for a future milestone)
Pass criteria for every case:
- `decisionsAfterStop.http = decisionsAfterStop.ws = 0`, checked by `seq`;
- both censuses reconciled;
- one `firstStop`;
- no registered PID still running;
- the decoys untouched.

| Case | Setup | Expected |
|---|---|---|
| J1 | HTTP disallowed method, WS streaming every 20 ms | firstStop http, exit 10 |
| J2 | HTTP request N+1 over the cap | firstStop http, exit 10 |
| J3 | WS message cap | firstStop ws, exit 10 |
| J4 | WS duration cap | firstStop ws, exit 10 |
| J5 | WS oversize frame | firstStop ws, exit 10 |
| J6 | WS upstream close | firstStop ws, exit 10 |
| J7 | 20 concurrent HTTP requests and 3 WS connections at the stop | all queued work dropped and reconciled |
| J8 | External TERM at 3 s, client exits promptly | 143 |
| J9 | External TERM at 3 s, client exits 3 s later | 143 |
| J10 | External TERM at 3 s, client ignores TERM | 13 |
| J11 | External INT | 130 |
| J12 | Reused-PID registry line and foreign decoy | untouched |
| J13 | Provenance | copied-rule sha256 and the joint-run.sh diff match the pinned declaration |

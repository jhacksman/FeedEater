# Joint HTTP + WS admission guard (prototype, preparation only, 2026-10-10, parent 4006b724)

First implementation of the component proposed in `JOINT-STOP-PROPOSAL.md`. Loopback only. It is not wired
into `run-native.sh`, the collector or any deployment, and nothing here is latency, readiness or DAT-SRC-011
admission evidence. 4df26b2, f694290, af53a874 and #173 5206f90 are unchanged (checked by J13).

## Files
- `joint-guard.mjs`: one process with an HTTP JSON-RPC listener and a WS listener on 127.0.0.1, one latch,
  one `process.hrtime.bigint()` clock and one `seq` over every event in `joint.jsonl`.
- `joint-run.sh`: `guard-run.sh@4df26b2` with only the declared hunks changed (`joint-rules.json`,
  `joint-evidence/joint-rules.diff`). WS options come from `JOINT_WS_ARGS`; the client also gets `FE173_WS_URL`.
- `joint-rules.json` + `joint-rules-check.mjs`: verbatim rule blocks (rpc-guard 88-134 and 183-201; ws-guard
  54, 61, 63 and 130-151) pinned by head, line range and sha256; adapted rules listed with source lines.
- `verify-joint.sh`, `joint-client.sh`, `joint-toy.mjs`, `joint-analyze.mjs`: the J1-J13 fake-loopback cases.
- `joint-verify.out` (stdout) and `joint-evidence/` (every case's raw .json/.jsonl/stdout/stderr and registries).

## Behaviour
- HTTP rules, caps, pacing and bounded BigInt quantities are those of rpc-guard@4df26b2; WS filters, caps,
  frame limit, duration and no upstream reconnect are those of ws-guard@f694290. Every option is required.
- New: `--max-preopen-frames N` (1..1024) caps frames queued per WS connection before its upstream opens;
  frame N+1 is refused (`preopen_cap`) and latches.
- The first HTTP refusal, WS refusal/cap/close/error, duration cap or TERM/INT sets the latch
  `{transport, reason, hrNs, seq, preLatch}`. HTTP admit, HTTP send and WS forward each check it
  synchronously in the callback that decides, so no decision can carry a seq above the latch seq. Then
  `JOINT.STOP` is written, both listeners close, queued HTTP requests get 503, queued WS frames are dropped
  and WS connections close 1008. Pre-latch in-flight work gets up to 2 s, then `joint.summary.json`.
- `preLatch` reports work already decided at the latch: HTTP in flight/queued, WS sends in flight and their
  bytes, `ws` userspace `bufferedAmount`, pre-open frames. Bytes inside kernel socket buffers cannot be read
  from Node; the analyzer reports them indirectly as pre-latch forward decisions not seen at the far end
  (`preLatchUndelivered`). They are pre-latch decisions, not post-latch forwarding.
- `joint-run.sh`: the TERM/INT trap records `trapNs` on the same monotonic clock and relays that signal to the
  guard at once; the loop then stops the guard (waits for its exit), and only then TERMs the client, honours
  `GRACE_S`, verifies PID + `lstart` and container labels, and exits 143/130, or 13/14.
  `joint-run.json` adds `trapNs`, `trapToLatchNs` and the latch.

## Results (`joint-verify.out`: 139/139 PASS, exit 0; Linux, node 24.19.0, one run)
| Case | Exit | First latch | HTTP adm/fwd/dropped | WS adm/fwd/dropped |
|---|---|---|---|---|
| J1 disallowed method | 10 | http/method_not_allowed | 7/5/2 | 92/92/0 |
| J2 request 21 over cap 20 | 10 | http/cap_exceeded | 20/12/8 | 243/243/0 |
| J3 WS message cap 60 | 10 | ws/messages_cap | 5/3/2 | 60/60/0 |
| J4 WS duration 2 s | 10 | ws/duration_cap | 60/36/24 | 707/707/0 |
| J5 2048-byte frame, cap 1024 | 10 | ws/frame_too_large | 0/0/0 | 4/4/0 |
| J6 WS upstream close 1.5 s | 10 | ws/upstream_closed | 50/30/20 | 583/583/0 |
| J7 20 HTTP burst, 3 WS pre-open | 10 | ws/preopen_cap | 20/1/19 | 0/0/17 |
| J8 TERM 3 s, prompt | 143 | signal/signal_TERM | 95/56/39 | 1110/1110/0 |
| J9 TERM 3 s, exits 3 s later | 143 | signal/signal_TERM | 92/55/37 | 1077/1077/0 |
| J10 TERM 3 s, ignores, grace 5 s | 13 | signal/signal_TERM | 94/56/38 | 1110/1110/0 |
| J11 INT 3 s | 130 | signal/signal_INT | 95/57/38 | 1113/1113/0 |

- Every case: exactly one latch, contiguous seq, 0 HTTP admit, 0 HTTP forward, 0 WS up and 0 WS down
  decisions after the latch seq (recomputed from `joint.jsonl`); both censuses reconciled; fake HTTP upstream
  received = HTTP forwarded; `preLatchUndelivered` 0/0; the guard stopped before the client was signalled;
  no registered PID left running.
- J7: at the latch 1 HTTP request was in flight (it completed and was answered) and 19 were queued (all 503).
- J8-J11 `trapToLatchNs` 17.6-17.8 ms. It starts when the trap runs, not at kernel delivery: bash runs a
  trap only after the current foreground command (`sleep 0.1` or a `node` call) returns, and the trap's own
  `node` timestamp call is inside the interval. Neither part is bounded here.
- J10: the TERM-ignoring toy is reported and stopped as an owned survivor (exit 13).
- J12: the unregistered decoy and the reused-PID line planted in all 11 client registries were untouched.
- J13: verbatim blocks match their pinned sha256; `joint-run.sh` changes exactly the declared hunks;
  assembled 4df26b2/f694290 bytes match their MANIFESTs; frozen files and `modules/` are byte-equal.

## Limits
- Prototype on fake loopback only; the toy client is not the collector. Linux only; macOS not run.
- Zero post-latch decisions holds within this one process. Responses to pre-latch HTTP forwards still reach
  the client after the latch (`respondedAfterLatch`).
- The controller polls client and guard every 0.1 s; trap delivery delay is not measured.
- Container survivor handling is unchanged from 4df26b2 but no container case was run (no Docker here).
- Interposing the guard adds an unmeasured userspace hop; it must never be hidden in a DAT-SRC-011 result.

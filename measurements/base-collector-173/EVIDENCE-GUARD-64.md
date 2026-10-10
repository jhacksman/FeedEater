# Evidence for the first guard correction batch on 64db8f6 (evidence only; no source change)

Head under review: `64db8f6` (guard), plan `b290de5`. #173 `5206f90` source stays frozen. Reproduced
offline on Linux, node 24.19.0, with `FE173_TEST_ROOT=<abs dir> ./repro-guard-64.sh`. That writes only
under `mktemp -d "$FE173_TEST_ROOT/fe173-repro64.XXXXXX"`, uses `fake-upstream.mjs` on 127.0.0.1, and
signals only PIDs it registered (PID + `ps lstart`). Full output: `repro-guard-64.out`.

## A. Nested cleanup under guard-run.sh

Setup: `guard-run.sh G <fake> 0 0 1000 500 2 -- inner.sh`. The synthetic client `inner.sh` sources
`lib-run.sh` with its own registry, `fe_start`s 3 children and loops on `sleep 5` like `run-native.sh`.
Its EXIT trap is `fe_cleanup`, which stops children in reverse order with `fe_stop_pid`: TERM, 10 s,
then KILL. At the 2 s deadline the outer `fe_stop_pid` sends TERM to the client and KILLs it if it is
still owned 10 s later.

| Children on TERM | guard-run | inner TERM handled | outcome |
| --- | --- | --- | --- |
| exit at once | 11, 5.6 s | +5.2 s (deferred until `sleep 5` returned) | cleanup ends +5.3 s, 0 of 3 survive |
| exit 3 s after TERM | 11, 12.3 s | +5.2 s | child3 and child2 stopped serially (3 s each); child1 got TERM at +11.5 s; outer KILL hits inner at about +12.2 s; **1 of 3 survive** (reparented to PID 1) |
| ignore TERM | 11, 12.7 s | +5.2 s | inner was still waiting on child3 when it was KILLed; **3 of 3 survive** |

guard-run's exit code (11) and `guard-run.json` do not show the survivors. An unregistered decoy
process was left untouched in every case. The repro then KILLs the survivors using its own registry
(PID + lstart), leaving 0.

Inner cleanup budget for `run-native.sh` as written:
- trap latency up to the longest foreground sleep (5 s in `fe_wait_until`);
- up to 10.5 s for each registered live PID (capnats, capdirect, persist, collect, measure, verify,
  plus the restarted persist/collect in r2/r3: up to 8 entries);
- `docker rm -f` for 2 containers.

Worst case is about 5 + 8 × 10.5 + 2 × 10 ≈ 110 s, against an outer grace of 10 s.

Minimal remedies, touching only the guard or controller:
1. **Declared outer grace.** Add `GRACE_S` to `guard-run.sh` (TERM, wait up to `GRACE_S`, then KILL).
   It must be at least the inner worst case: 120 s for `run-native.sh`, and at least 3 × 10.5 + 5 s for
   this repro. Record the TERM/exit/KILL times in `guard-run.json`.
2. **Owned post-KILL sweep.**
   - If the client is still owned after the grace, KILL it. Then read the client's registry and stop
     each PID whose lstart still matches the recorded one (the `fe_owned` rule), and remove containers
     labelled with the client's RUNID.
   - For `run-native.sh` the registry is `$FE173_ROOT/fe173-*-<mode>-<client pid>/registry`: RUNID ends
     in `$$`, which equals the PID guard-run recorded. A pattern that matches zero or several
     directories must fail closed.
   - Alternatively, the client declares its registry path in a file that guard-run reads (contract
     change).
3. **Distinct exit code.** Any registered PID or labelled container still present after the sweep makes
   guard-run exit 13 (`owned_survivors`), with the list in `guard-run.json`. It is never reported as
   10, 11 or a client code.
4. **Stop the guard first.** On deadline or STOP, stop the guard before signalling the client. The
   guard currently keeps admitting requests (up to its cap) while the client cleans up after a
   deadline.
5. Not chosen: process-group kill (`setsid` is absent on macOS, and it does not reach containers).

Budgets to declare per run: `DEADLINE_S` (section 3 of RUN-PLAN-64), plus `GRACE_S` ≥ 120 s, plus a
sweep of ≤ 10.5 s per surviving PID. Total controller wall time ≤ `DEADLINE_S + GRACE_S + sweep`.

## B. getLogs span check (`rpc-guard.mjs`)

`span = Number(BigInt(toBlock)) - Number(BigInt(fromBlock)) + 1` loses precision above 2^53. A
quantity longer than about 256 hex digits becomes `Infinity`, so `NaN` passes both `span < 1` and
`span > max`. All cases below use `--max-log-span 500`, one fresh guard each:

| fromBlock .. toBlock | true span | guard span | result | fake upstream received |
| --- | --- | --- | --- | --- |
| 0x1 .. 0x1f5 | 501 | 501 | refused `logs_span_exceeded` | 0 |
| 2^53 .. 2^53+500 | 501 | 501 | refused | 0 |
| **2^62 .. 2^62+511** | 512 | 1 | **forwarded** | 1 |
| **2^62+511 .. 2^62 (reversed)** | -510 | 1 | **forwarded** | 1 |
| **2^1100 .. 2^1100+1000 (278 hex chars)** | 1001 | NaN | **forwarded** | 1 |

Each is one admitted, counted request, so the cap still holds, but the span and order invariants are
bypassed. Remedy: compare as BigInt (`to >= from`, `to - from + 1n <= BigInt(max)`), and cap every
quantity, including the `eth_getBlockByNumber` argument, at ≤ 16 hex digits or a declared maximum
block, before computing anything.

## C. Pacing floor (A7 finding, recorded for the same batch)

`nowMs()` floors `hrtime` to whole milliseconds for both `lastSendMs` and the wait. A forward can
therefore happen up to 1 ms early (A7: a 49.78 ms gap at 50 ms pacing on Linux). Remedy: keep
`lastSendNs` as a BigInt, wait until `now >= lastSendNs + minIntervalMs × 1e6`, checking again after
the timer, and compare in ns in `verify-guard.sh`.

No correction is made here. One combined first guard correction batch follows A7's full review.

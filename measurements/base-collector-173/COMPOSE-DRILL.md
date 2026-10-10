# Composition drill: HTTP guard/controller 4df26b2 + WS proxy f694290 (evidence only, 2026-10-10)

Preparation evidence on fake loopback only. It made no real node, network, Docker, NATS, Postgres, T7,
production, deploy, run-native, collector or evaluator calls or changes. It is not latency, admission
or readiness evidence. No proxy hop is inserted into any DAT-SRC-011 comparison. The components were
not repaired.

## Driver

`FE173_TEST_ROOT=<abs dir> ./compose-drill.sh` runs the drill once. Output is in `compose-drill.out`
(Linux 6.8, node v24.19.0, ws 8.19.0). The run used this commit's files before they were committed;
the drill head line therefore reads 4df26b2.

- `compose-assemble.sh REPO DEST` reads `rpc-guard.mjs`, `guard-run.sh`, `lib-run.sh` and
  `fake-upstream.mjs` from 4df26b2, and `ws-guard.mjs`, `fake-ws-upstream.mjs`,
  `ws-contract-2026-10-10.json` and `lib-run.sh` from f694290. It reads them with `git cat-file`, so
  never from a working tree. It checks:
  - the pinned commit and tree;
  - the sha256 of the pinned `MANIFEST.sha256`;
  - each file's sha256 against its head's MANIFEST;
  - that `lib-run.sh` is identical in both heads.

  It writes `ASSEMBLED.sha256` and `provenance.json`; the latter also records the `ws` package
  version and tree hash, which come from `node_modules` and are not git objects. `--verify DEST`
  re-hashes the assembled files.
- It refuses with exit 3 on:
  - dirty or untracked component paths;
  - an unpinned HTTP or WS head;
  - a non-empty destination;
  - a missing WS commit (single-branch clone);
  - changed assembled bytes.

  Each refusal was checked on scratch clones.
- The assembled `guard-run.sh` (HTTP cap 1000, pacing 50 ms, timeout 2000 ms) runs
  `compose-client.sh` as its client. That wrapper has its own `lib-run.sh` registry. It starts the
  assembled `ws-guard.mjs` (allowed filters from the contract plus newHeads) and then
  `toy-client.mjs`:
  - HTTP `eth_blockNumber` every 30 ms through rpc-guard;
  - one WS connection subscribing to logs filter 0 and newHeads, with no reconnect.

  The wrapper exits 21 when ws-guard exits. On TERM it exits through `fe_cleanup`, which stops the
  toy first, then ws-guard.
- Each case gets fresh fake HTTP and WS upstreams. The WS upstream sends notifications every 20 ms
  per subscription.
- A foreign `sleep 300` decoy is left unregistered. Its PID is also planted in each client registry
  with a wrong start time.

## Results: 41 PASS, 0 FAIL, 8 GAP

Every case passed these checks:
- guard-run's exit equals the `rc` in `guard-run.json`;
- rpc-guard's summary is reconciled and its forwarded count equals the fake HTTP upstream's count;
- ws-guard's summary is reconciled and its forwarded-up count equals the fake WS upstream's
  received count;
- no registered PID is still running with its recorded start time;
- the decoy is untouched and the assembled bytes are unchanged afterwards.

| Case | guard-run | HTTP admitted/forwarded/dropped | WS received/admitted/forwarded/dropped/refused | First stop | Other side kept running |
|---|---|---|---|---|---|
| http_stop (disallowed method after 5×200) | 10 guard_stop | 7/5/2 | 48/48/48/0/0, ws-guard signal_TERM | HTTP | 22 WS frames forwarded, 273.6 ms |
| ws_message_cap 60 | 21 client_exit | 23/17/6 | 62/60/60/1/1, messages_cap exit 10 | WS | 4 HTTP admitted, 262.8 ms |
| ws_duration_cap 2 s | 21 client_exit | 65/41/24 | 184/184/184/0/0, duration_cap exit 10 | WS | 5 HTTP admitted, 241.5 ms |
| external TERM at 3 s, prompt, grace 20 | 143 external_TERM, verified, 0 survivors | 89/54/35 | 282/282/282/0/0 | HTTP (guard-run stopped rpc-guard first) | 12 WS frames, 157.7 ms |
| external TERM, toy exits 3 s after TERM | 143, clientKilled false, 0 survivors | 90/54/36 | 578/578/578/0/0 | HTTP | 306 WS frames, 3247.1 ms |
| external TERM, toy ignores TERM, grace 5 | 13, clientKilled true, survivors wsguard+toy (stopped) | 89/54/35 | 724/724/724/0/0 | HTTP | 456 WS frames, 4655.7 ms |

## Composition gaps (expected vs actual, not repaired)

1. **An HTTP stop does not stop WS admission** (5 cases).
   - Expected: no WS frames forwarded after the first STOP.
   - Actual: 12 to 456 frames, over 158 ms to 4.7 s.
   - Cause: guard-run stops only rpc-guard. ws-guard keeps forwarding until the client's own cleanup
     reaches it, which happens after the toy exits, or until guard-run's survivor sweep reaches it
     when the client ignores TERM.
   - Interfaces: `guard-run.sh` steps 1–2 (one guard, no stop channel to a second guard); the client
     contract (CMD gets only `FE173_GUARD_URL`); `lib-run.sh` `fe_cleanup` reverse-registration order.
2. **A WS STOP does not stop HTTP admission** (2 cases).
   - Expected: no HTTP admissions after the WS STOP.
   - Actual: 4 and 5 admitted, over 263 ms and 241 ms.
   - Cause: ws-guard exits 10. The wrapper notices on its 0.1 s poll, then stops the toy and exits 21.
     guard-run notices on its 0.1 s poll, then stops rpc-guard.
   - Interfaces: guard-run watches only `guard.STOP` and its client. `ws-guard.STOP` and ws-guard's
     exit code are not observed.
3. **guard-run.json has no WS outcome** (2 cases).
   - Actual: the WS cap appears only as `reason: client_exit, rc: 21`, and 21 is the drill wrapper's
     own convention.
   - Conversely, after an HTTP-first stop, ws-guard's summary records `signal_TERM` with no reference
     to the cause.
   - Interfaces: the `guard-run.json` schema and exit codes; the ws-guard summary `stopReason`.

Other observations:
- `clientExit` is recorded as 1 when the wrapper is stopped through its TERM trap. This was not
  investigated.
- The drill's own wrapper polls every 0.1 s. A run-native-style `sleep 5` loop would widen gaps 1–2.

## Limits

- The drill ran once, on Linux only; macOS was not run.
- `process.hrtime.bigint()` is compared across processes, assuming one system monotonic clock on
  the host.
- The toy client is not the collector, and the gap sizes depend on its rates.
- WS ping/pong frames are not counted.
- None of this measures the overhead of the proxy hop.

# ws-guard: loopback WS counting/stop proxy (preparation only, 2026-10-10)

Standalone preparation component, parent `c899530`. It is not wired into `run-native.sh`, the collector
or measure, has never connected to a real node, and is not latency or DAT-SRC-011 admission evidence.
Files: `ws-guard.mjs`, `fake-ws-upstream.mjs`, `verify-ws-guard.sh`, raw output `ws-guard-verify.out`.

## Usage

```
node ws-guard.mjs --run-dir <abs existing dir> --upstream ws://HOST:PORT[/path] --filters <json array>
  [--allow-new-heads] --max-concurrent N --max-connections N --max-messages N --max-bytes N
  --max-frame-bytes N --max-duration-s N
```

- *Inputs:*
  - Every cap is required, must be an integer of at least 1 and is bounded.
  - The upstream must be plain `ws://`, with no credentials, query or fragment.
  - The filter file is the allowed log-filter set, for example `filters` from `ws-contract-2026-10-10.json`.
  - Anything invalid exits 2 and writes nothing.
- *Listening:* `127.0.0.1` only, on an ephemeral port. `DIR/ws-guard.ready.json` gives `{url,pid}`.
- *Exits:* 10 after a cap or error STOP; 0 after TERM/INT. Either way the summary is written first. In-flight
  sends get at most 2 s; any still pending are recorded as `inflightAtExit`.

## Behaviour

- *Connections:*
  - Each accepted client connection gets exactly one upstream connection.
  - An upstream close or error is a STOP. There is no automatic upstream reconnect.
  - `--max-connections` counts connections over the guard's lifetime. The reconnect budget is therefore
    `max-connections` minus the number of planned clients.
- *Client→upstream frames:*
  - A frame must be one JSON-RPC 2.0 text object: `eth_subscribe ["newHeads"]` (only with
    `--allow-new-heads`), `eth_subscribe ["logs", F]` where F, lowercased, equals an allowed filter, or
    `eth_unsubscribe [id]`.
  - Anything else is refused and STOPs, before anything is forwarded: malformed, batch, binary, extra
    fields, another method, another filter or `fromBlock`.
  - Each subscribe is recorded with its filter index before it is forwarded.
  - Frames that arrive while the upstream is still connecting are queued. If STOP comes first they are
    dropped and counted.
- *Counting and forwarding:*
  - Every frame, in both directions, is counted and checked against the total message and byte caps
    before it is forwarded.
  - Frames are forwarded byte for byte.
  - Frames larger than `--max-frame-bytes` are rejected by the `ws` library (`maxPayload`) on both sides
    and counted as received and refused (`frame_too_large`).
- *STOP:*
  - The first refusal, cap, duration, upstream close/error, send error or signal writes `ws-guard.STOP`,
    closes the listener and closes every owned connection with 1008.
  - Summary invariants: received = admitted + refused + dropped; admitted = forwarded + sendErrors +
    inflightAtExit.
- *Diagnostics:* `ws-guard.jsonl` (monotonic `hrNs`) records event types, connection ids, direction, byte
  lengths and filter indexes. It contains no payload, and of the upstream only `host:port`.

## Offline evidence

Linux, node 24.19.0, ws 8.19.0, fake upstream on 127.0.0.1: `FE173_TEST_ROOT=<abs> ./verify-ws-guard.sh`
passes 37 checks, exit 0 (`ws-guard-verify.out`). The checks cover:
- *Config:* 8 invalid configurations exit 2 with no files written.
- *Forwarding:* both filters (one with a checksummed address) and `newHeads` are forwarded with
  identical sha256 in both directions, 15 frames reconciled, and no payload in diagnostics.
- *Connections:*
  - 3 simultaneous clients within the cap;
  - a concurrent cap of 2 with 3 clients: STOP, at most 2 upstream connections;
  - a total of 2 connections: the third STOPs, 2 upstream connections.
- *Caps:*
  - frame cap: the oversize frame is never delivered;
  - message cap of 5: exactly 5 forwarded, exit 10;
  - byte cap;
  - duration cap at 1 s.
- *Refusals:* 9 malformed or disallowed frame kinds, with 0 frames reaching the upstream.
- *STOP and signals:*
  - pre-admitted frames at TERM: 3 dropped, 0 forwarded;
  - upstream close: exit 10, still 1 upstream connection after 1 s, client closed 1008;
  - SIGINT exits within 2.5 s.
- *Cleanup:* owned cleanup through `lib-run.sh` stops the guard and fake and leaves an unregistered decoy
  untouched.

## Limits

- *The proxy adds a network hop.* Interposing it on either arm adds a userspace hop whose latency and
  jitter have not been measured. It would have to be measured separately (for example
  direct-vs-guarded on the same host and clock) and reported next to any DAT-SRC-011 result, never
  folded into or hidden in it. Putting it on only the native arm biases the direct-vs-native comparison.
- *Not wired in:* `run-native.sh` has no binding. Each arm reads `BASE_COLLECTOR_WS_URL`, so how the arms
  map to guards (one shared guard or one per arm) would be a Codex decision.
- *What the caps count:* the message and byte caps cover all connections and both directions; there are
  no per-connection caps. WS ping/pong control frames are not counted.
- *After STOP:*
  - The listener is closed, so the collector's reconnect loop gets a local connection refusal.
  - Those attempts are not counted. They keep failing locally until the controller stops the collector.
- *Testing:* Linux only, not tested on macOS. Every count and limit here was measured offline against the
  fake.

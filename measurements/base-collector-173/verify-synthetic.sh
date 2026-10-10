#!/usr/bin/env bash
# Checks check-report.mjs against the committed synthetic bytes.
#   ./verify-synthetic.sh          checker output + exit code per case must equal expected-check.json / expected-exit
#   ./verify-synthetic.sh --regen  also rebuild the fixtures from the 5206f90 dist and require identical bytes
set -u
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
CASES="control checksummed-filter g1 malformed-status ws-loss factory-reorg-not-observed extra-direct-initialize direct-ws-closed-before-warmup direct-filter-ack-missing"
if [ "${1:-}" = "--regen" ]; then
  node make-synthetic.mjs --out "$tmp/regen" >/dev/null || { echo "FAIL regen"; exit 1; }
  for c in $CASES; do
    for f in measure.json nats.jsonl direct.jsonl base-collector.env; do
      if cmp -s "synthetic/$c/$f" "$tmp/regen/$c/$f"; then echo "PASS regen $c/$f"; else echo "FAIL regen $c/$f"; fail=1; fi
    done
  done
fi
for c in $CASES; do
  d=synthetic/$c
  node check-report.mjs "$d/measure.json" --nats-capture "$d/nats.jsonl" --direct-capture "$d/direct.jsonl" --env "$d/base-collector.env" >"$tmp/$c.json"
  code=$?
  if cmp -s "$tmp/$c.json" "$d/expected-check.json" && [ "$code" = "$(cat "$d/expected-exit")" ]; then
    echo "PASS check $c (exit $code, verdict $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).verdict)' "$tmp/$c.json"))"
  else
    echo "FAIL check $c (exit $code)"; diff "$d/expected-check.json" "$tmp/$c.json" | head -20; fail=1
  fi
done
# Interval binding: invalid, missing or unrecorded claims must exit 2 (usage), never verdict 0/1.
d=synthetic/g1
printf 'BASE_COLLECTOR_STATUS_INTERVAL_MS=abc\n' | cat "$d/base-collector.env" - >"$tmp/bad.env"
i2() { # label args...
  local label=$1
  shift
  node check-report.mjs "$d/measure.json" --nats-capture "$d/nats.jsonl" --direct-capture "$d/direct.jsonl" "$@" >/dev/null 2>"$tmp/i2.err"
  local code=$?
  if [ "$code" = 2 ]; then echo "PASS interval $label (exit 2: $(cat "$tmp/i2.err"))"; else echo "FAIL interval $label (exit $code, want 2)"; fail=1; fi
}
i2 "--env missing"
i2 "--status-interval-ms x" --env "$d/base-collector.env" --status-interval-ms x --heartbeat-ms x
i2 "--status-interval-ms with no value" --env "$d/base-collector.env" --status-interval-ms
i2 "claimed 1000000 vs recorded 5000" --env "$d/base-collector.env" --status-interval-ms 1000000 --heartbeat-ms 1000000
i2 "recorded interval invalid" --env "$tmp/bad.env"
i2 "--env unreadable" --env "$tmp/none.env"
exit $fail

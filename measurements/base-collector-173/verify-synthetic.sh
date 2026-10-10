#!/usr/bin/env bash
# Checks check-report.mjs against the committed synthetic bytes.
#   ./verify-synthetic.sh          checker output + exit code per case must equal expected-check.json / expected-exit
#   ./verify-synthetic.sh --regen  also rebuild the fixtures from the 5206f90 dist and require identical bytes
set -u
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
CASES="control g1 malformed-status ws-loss factory-reorg-not-observed"
if [ "${1:-}" = "--regen" ]; then
  node make-synthetic.mjs --out "$tmp/regen" >/dev/null || { echo "FAIL regen"; exit 1; }
  for c in $CASES; do
    for f in measure.json nats.jsonl direct.jsonl; do
      if cmp -s "synthetic/$c/$f" "$tmp/regen/$c/$f"; then echo "PASS regen $c/$f"; else echo "FAIL regen $c/$f"; fail=1; fi
    done
  done
fi
for c in $CASES; do
  d=synthetic/$c
  node check-report.mjs "$d/measure.json" --nats-capture "$d/nats.jsonl" --direct-capture "$d/direct.jsonl" >"$tmp/$c.json"
  code=$?
  if cmp -s "$tmp/$c.json" "$d/expected-check.json" && [ "$code" = "$(cat "$d/expected-exit")" ]; then
    echo "PASS check $c (exit $code, verdict $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).verdict)' "$tmp/$c.json"))"
  else
    echo "FAIL check $c (exit $code)"; diff "$d/expected-check.json" "$tmp/$c.json" | head -20; fail=1
  fi
done
exit $fail

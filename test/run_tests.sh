#!/usr/bin/env bash
# Full check. Uses the synthetic fixture, plus any real logs you pass in.
#   bash test/run_tests.sh [real1.bin real2.bin ...]
# Needs: node 18+, python3, pip install pymavlink (and playwright for test/ui_test.py)
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

python3 test/make_fixture.py test/fixture.bin > /dev/null
echo "=== engine tests"
node --test test/engine.test.js 2>&1 | grep -E "^# (pass|fail)"

check() {   # check LOG PRESET [extra verify args]
  local log=$1 preset=$2; shift 2
  local out="$TMP/$(basename "${log%.*}")_${preset}.bin"
  node cli/styx.js --preset "$preset" --out "$TMP" "$log" > /dev/null
  node cli/styx.js --preset "$preset" --explain "$log" > "$TMP/expect.json"
  if python3 test/verify.py "$log" "$out" "$TMP/expect.json" "$@" > "$TMP/verify.txt" 2>/dev/null; then
    echo "  $preset: PASS ($(grep 'leak scan' "$TMP/verify.txt" | sed 's/^ *leak scan: //'))"
  else
    echo "  $preset: FAIL"; cat "$TMP/verify.txt"; exit 1
  fi
}

for LOG in test/fixture.bin "$@"; do
  echo "=== $LOG"
  for P in customer customer-plus gps-vendor partner; do check "$LOG" "$P" --secret CubeOrange; done
  if [ "$LOG" != test/fixture.bin ]; then
    python3 test/make_hostile.py "$LOG" "$TMP/hostile.bin" > /dev/null
    echo "  hostile copy (second GPS, second battery, junk with secret text):"
    for P in customer customer-plus; do check "$TMP/hostile.bin" "$P" --secret SECRET; done
  fi
done
echo "ALL PASS"

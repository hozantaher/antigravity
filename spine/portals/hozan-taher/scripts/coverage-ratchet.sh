#!/usr/bin/env bash
# coverage-ratchet.sh — enforce per-package coverage floors, ratchet only upward.
#
# Usage:
#   scripts/coverage-ratchet.sh <service-name> <coverage.out>
#
# Reads baselines from scripts/coverage-floors.json
# Fails if total coverage < floor for the service.
# On success, if total > floor, suggests floor update (prints new floor).

set -euo pipefail

SERVICE="${1:-}"
PROFILE="${2:-coverage.out}"

if [[ -z "$SERVICE" ]]; then
  echo "usage: $0 <service-name> [coverage.out]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOORS_FILE="${SCRIPT_DIR}/coverage-floors.json"

if [[ ! -f "$FLOORS_FILE" ]]; then
  echo "ERROR: $FLOORS_FILE missing" >&2
  exit 3
fi

if [[ ! -f "$PROFILE" ]]; then
  echo "ERROR: coverage profile $PROFILE missing" >&2
  exit 3
fi

TOTAL=$(go tool cover -func="$PROFILE" | awk '/^total:/ {gsub("%","",$3); print $3}')
FLOOR=$(python3 -c "import json,sys; d=json.load(open('$FLOORS_FILE')); print(d.get('$SERVICE', {}).get('total', 0))")

echo "service=$SERVICE total=${TOTAL}% floor=${FLOOR}%"

PASS=$(python3 -c "print(1 if float('${TOTAL}') >= float('${FLOOR}') else 0)")
if [[ "$PASS" != "1" ]]; then
  echo "::error::${SERVICE} coverage ${TOTAL}% below floor ${FLOOR}%" >&2
  exit 1
fi

# Ratchet hint
DELTA=$(python3 -c "print(round(float('${TOTAL}') - float('${FLOOR}'), 2))")
RAISE=$(python3 -c "print(1 if float('${DELTA}') >= 3 else 0)")
if [[ "$RAISE" == "1" ]]; then
  echo "::notice::${SERVICE} coverage ${TOTAL}% is ${DELTA}pp above floor ${FLOOR}% — consider raising floor"
fi

exit 0

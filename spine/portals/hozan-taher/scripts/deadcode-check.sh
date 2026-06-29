#!/usr/bin/env bash
# scripts/deadcode-check.sh — AC1 dead-code audit ratchet
#
# Runs `deadcode -test ./...` against every Go module in services/ and
# fails if the total count of unreachable non-test production functions
# exceeds the locked baseline.
#
# Usage:
#   ./scripts/deadcode-check.sh            # enforce baseline
#   ./scripts/deadcode-check.sh --update   # print new count for baseline update
#
# Baseline is the count AFTER the AC1 cleanup (2026-05-07).
# Known remaining items are false positives or planned-but-unintegrated APIs:
#   - features/acquisition/contacts/ares: RefreshLoop/tickARES/refreshSync — planned
#     integration; no main.go in contacts yet (KT-A10 roadmap)
#   - features/platform/common/envconfig: MustValidate/MustHave — cross-module
#     false positive; called from features/platform/operator-practice (separate module)
#   - features/platform/common/refreshcron: Unlock — cross-module false positive;
#     called from features/acquisition/contacts/ares/refresh.go
#   - features/compliance/privacy-gateway/mail: ResolverGateway.ListByActor — interface
#     implementation (satisfies AuditTail interface)
#
# Per HARD RULE memory feedback_deadcode_test_flag: MUST use -test flag.
# Without -test, count is ~10× higher (test helpers inflate results).

set -euo pipefail

DEADCODE="${DEADCODE:-$(which deadcode 2>/dev/null || echo "")}"
if [ -z "$DEADCODE" ]; then
  echo "ERROR: deadcode not found. Install: go install golang.org/x/tools/cmd/deadcode@latest" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
SERVICES_DIR="$REPO_ROOT/services"

# Baseline: count of unreachable production (non-test-file) items after AC1 cleanup.
# Lower this when you remove more dead code.
BASELINE=7

# Modules to scan (all Go modules in services/).
MODULES=$(find "$SERVICES_DIR" -name "go.mod" -not -path "*/vendor/*" | xargs -I{} dirname {} | sort)

total=0
output=""

for mod in $MODULES; do
  mod_name="$(basename "$mod")"
  # Run deadcode -test, filter to non-test-file lines only.
  result=$(cd "$mod" && "$DEADCODE" -test ./... 2>/dev/null \
    | grep -v "_test.go:" \
    | grep "unreachable func:" || true)
  if [ -n "$result" ]; then
    count=$(echo "$result" | wc -l | tr -d ' ')
    output="${output}=== $mod_name ===\n${result}\n"
    total=$((total + count))
  fi
done

if [ "${1:-}" = "--update" ]; then
  echo "Current dead-code count (non-test): $total"
  echo "Set BASELINE=$total in this script to lock the new baseline."
  exit 0
fi

echo "Dead-code audit (non-test): $total items (baseline $BASELINE)"

if [ "$total" -gt "$BASELINE" ]; then
  echo "FAIL: dead-code count $total exceeds baseline $BASELINE"
  echo ""
  printf "%b" "$output"
  echo ""
  echo "Fix: remove the dead code, then run with --update to lower the baseline."
  exit 1
fi

if [ "$total" -lt "$BASELINE" ]; then
  echo "NOTICE: count dropped ($total < $BASELINE). Run --update and lower BASELINE."
fi

echo "OK"

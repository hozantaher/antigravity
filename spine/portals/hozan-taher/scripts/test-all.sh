#!/usr/bin/env bash
# Canonical test runner for hozan-taher monorepo.
# One command runs every test suite + audit + smoke. Progressbar + summary.
#
# Usage:
#   bash scripts/test-all.sh                       # everything
#   bash scripts/test-all.sh --filter=go           # only Go suites
#   bash scripts/test-all.sh --filter=js           # only JS/TS test scripts
#   bash scripts/test-all.sh --filter=audit        # only audit scripts
#   bash scripts/test-all.sh --filter=smoke        # only smoke shell scripts
#   bash scripts/test-all.sh --filter=mutation     # only mutation testing (slow)
#   bash scripts/test-all.sh --filter=area/relay   # everything matching area
#   bash scripts/test-all.sh --skip-mutation       # exclude mutation
#   bash scripts/test-all.sh --skip-smoke          # exclude smoke (need live env)
#
# Exit codes:
#   0  all pass
#   1  one or more failed
#   2  one or more timed out
#   3  argument error
#
# Excludes by default: tools:hallucination-baseline (writes baseline),
# tools:explain (maintenance helper), tools:shadow / tools:snapshot
# (capture-only). test:explain-gate is REAL and gates separately.

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
GO=${GO:-/opt/homebrew/bin/go}
PNPM=${PNPM:-/opt/homebrew/bin/pnpm}
LOGDIR="${LOGDIR:-/tmp/hozan-tests-$$}"
mkdir -p "$LOGDIR"

# Parse args
FILTER=""
SKIP_MUTATION=false
SKIP_SMOKE=false
for arg in "$@"; do
  case "$arg" in
    --filter=*) FILTER="${arg#--filter=}" ;;
    --skip-mutation) SKIP_MUTATION=true ;;
    --skip-smoke) SKIP_SMOKE=true ;;
    --help|-h)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# *//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Run with --help for usage."
      exit 3
      ;;
  esac
done

# label|kind|area|dir|cmd|timeout_seconds
SUITES=(
  # --- Go workspace ---
  "go:relay|go|relay|features/outreach/relay|$GO test -timeout 240s -count=1 ./...|300"
  "go:privacy-gateway|go|privacy-gateway|features/compliance/privacy-gateway|$GO test -timeout 240s -count=1 ./...|300"
  "go:mailboxes|go|mailboxes|features/outreach/mailboxes|$GO test -timeout 240s -count=1 ./...|300"
  "go:contacts|go|contacts|features/acquisition/contacts|$GO test -timeout 240s -count=1 ./...|300"
  "go:campaigns|go|campaigns|features/outreach/campaigns|$GO test -timeout 360s -count=1 ./...|420"
  "go:inbox|go|inbox|features/inbound/inbox|$GO test -timeout 240s -count=1 ./...|300"
  "go:orchestrator|go|orchestrator|features/inbound/orchestrator|$GO test -timeout 360s -count=1 ./...|420"
  "go:common|go|common|features/platform/common|$GO test -timeout 240s -count=1 ./...|300"

  # --- JS/TS pnpm test scripts ---
  "js:dashboard:full|js|dashboard|features/platform/outreach-dashboard|$PNPM run test:full|900"
  "js:dashboard:contract|js|dashboard|features/platform/outreach-dashboard|$PNPM run test:contract|600"
  "js:dashboard:integration|js|dashboard|features/platform/outreach-dashboard|$PNPM run test:integration|600"
  "js:dashboard:coverage|js|dashboard|features/platform/outreach-dashboard|$PNPM run test:coverage|900"
  "js:dashboard:e2e|js|dashboard|features/platform/outreach-dashboard|$PNPM run e2e|1200"
  "js:mcp:unit|js|mcp|features/platform/mcp|$PNPM test|300"
  "js:mcp:e2e|js|mcp|features/platform/mcp|$PNPM run test:e2e|300"
  "js:worker|js|worker|features/platform/worker|$PNPM test|300"
  "js:scrapers|js|scrapers|features/acquisition/scrapers|$PNPM test|300"

  # --- audit / quality scripts ---
  "audit:bundle|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:bundle|300"
  "audit:security|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:security|300"
  "audit:linkage|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:linkage|300"
  "audit:density|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:density|180"
  "audit:hallucination|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:hallucination|600"
  "audit:lighthouse|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:lighthouse|900"
  "audit:flaky|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:flaky|600"
  "audit:fixture-drift|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:fixture-drift|300"
  "audit:load|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:load|600"
  "audit:inverted-fault|audit|dashboard|features/platform/outreach-dashboard|$PNPM run test:inverted-fault|900"

  # --- mutation testing (slow, opt-out via --skip-mutation) ---
  "mutation:dashboard|mutation|dashboard|features/platform/outreach-dashboard|$PNPM run test:mutation|3600"

  # --- smoke shell scripts (opt-out via --skip-smoke; need live env) ---
  "smoke:privacy-r3|smoke|privacy-gateway|.|bash services/smoke-privacy-r3.sh|180"
  "smoke:privacy-r6|smoke|privacy-gateway|.|bash services/smoke-privacy-r6.sh|180"
  # Excluded (reference deleted features/outreach/anti-trace-relay): r2, r4, r5, r7, all, restore.
  # See issue #63 in GH backlog.
)

# Filter suites
filtered=()
for spec in "${SUITES[@]}"; do
  IFS='|' read -r label kind area _dir _cmd _tmo <<<"$spec"
  if [ -n "$FILTER" ]; then
    case "$FILTER" in
      area/*) [ "$area" = "${FILTER#area/}" ] || continue ;;
      *) [ "$kind" = "$FILTER" ] || continue ;;
    esac
  fi
  if [ "$SKIP_MUTATION" = true ] && [ "$kind" = "mutation" ]; then continue; fi
  if [ "$SKIP_SMOKE" = true ] && [ "$kind" = "smoke" ]; then continue; fi
  filtered+=("$spec")
done

if [ ${#filtered[@]} -eq 0 ]; then
  echo "No suites match filter: ${FILTER:-(none)}"
  exit 3
fi

N=${#filtered[@]}
PASS=0; FAIL=0; TIMEOUT=0
START=$(date +%s)

bar() {
  local cur=$1 total=$2 width=20
  local filled=$(( cur * width / total ))
  local empty=$(( width - filled ))
  printf '|'
  [ "$filled" -gt 0 ] && printf '%0.s#' $(seq 1 $filled)
  [ "$empty" -gt 0 ]  && printf '%0.s.' $(seq 1 $empty)
  printf '|'
}

# Bash-only timeout: run command with deadline, return 124 on timeout.
run_with_timeout() {
  local tmo=$1; shift
  ( "$@" ) &
  local cmd_pid=$!
  ( sleep "$tmo"; kill -TERM "$cmd_pid" 2>/dev/null; sleep 5; kill -KILL "$cmd_pid" 2>/dev/null ) &
  local watch_pid=$!
  wait "$cmd_pid" 2>/dev/null
  local rc=$?
  kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
  if [ $rc -eq 143 ] || [ $rc -eq 137 ]; then return 124; fi
  return $rc
}

i=0
for spec in "${filtered[@]}"; do
  i=$((i+1))
  IFS='|' read -r label kind area dir cmd tmo <<<"$spec"
  log="$LOGDIR/${label//[:\/]/_}.log"
  printf '[%d/%d] %s START %-32s\n' "$i" "$N" "$(bar $((i-1)) $N)" "$label"
  t0=$(date +%s)
  run_with_timeout "$tmo" bash -c "cd '$ROOT/$dir' && $cmd" >"$log" 2>&1
  rc=$?
  t1=$(date +%s)
  dur=$((t1 - t0))
  if [ $rc -eq 0 ]; then
    PASS=$((PASS+1)); status="PASS"
  elif [ $rc -eq 124 ] || [ $rc -eq 137 ]; then
    TIMEOUT=$((TIMEOUT+1)); status="TIMEOUT"
  else
    FAIL=$((FAIL+1)); status="FAIL"
  fi
  printf '[%d/%d] %s %-7s %-32s %ds\n' "$i" "$N" "$(bar $i $N)" "$status" "$label" "$dur"
done

END=$(date +%s); TOTAL=$((END - START))
printf '\n=== SUMMARY === pass=%d fail=%d timeout=%d total=%d duration=%ds logs=%s\n' \
  "$PASS" "$FAIL" "$TIMEOUT" "$N" "$TOTAL" "$LOGDIR"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$TIMEOUT" -gt 0 ]; then exit 2; fi
exit 0

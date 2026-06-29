#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Smoke test for scripts/migrations/run.sh
# ════════════════════════════════════════════════════════════════════════
#
# No live DB. We stub psql via PATH override so each test run drives the
# runner through a controlled set of "applied" migrations + assertions
# on its exit code and stdout.
#
# Run:
#   scripts/migrations/run_test.sh
#
# Exit code 0 if all cases pass, 1 if any failed.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="$ROOT/scripts/migrations/run.sh"
TESTS_PASSED=0
TESTS_FAILED=0

red()   { printf "\033[31m%s\033[0m\n" "$1" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }

# ── psql stub ───────────────────────────────────────────────────────────
# Each test sets $STUB_APPLIED (newline-separated migration_ids) + optional
# $STUB_DRIFT_ID (forces sha mismatch on that id). The stub replies to the
# 4 query patterns the runner uses.
make_stub() {
  local stubdir="$1"
  mkdir -p "$stubdir"
  cat > "$stubdir/psql" <<'STUB'
#!/usr/bin/env bash
# Read the SQL from -c or -f or stdin.
SQL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) SQL="$2"; shift 2 ;;
    -f) SQL="$(cat "$2")"; shift 2 ;;
    *)  shift ;;
  esac
done
if [[ -z "$SQL" ]]; then SQL="$(cat)"; fi

# Bootstrap or migration body — return success silently.
if [[ "$SQL" == *"CREATE TABLE IF NOT EXISTS schema_migrations"* ]]; then
  exit 0
fi
# SELECT migration_id FROM schema_migrations ORDER BY migration_id
if [[ "$SQL" == *"SELECT migration_id FROM schema_migrations"* ]]; then
  printf '%s\n' ${STUB_APPLIED:-}
  exit 0
fi
# SELECT content_sha256 FROM schema_migrations WHERE migration_id='XXX'
if [[ "$SQL" == *"SELECT content_sha256 FROM schema_migrations"* ]]; then
  # Extract id from WHERE migration_id='X'
  id=$(echo "$SQL" | sed -n "s/.*migration_id='\([^']*\)'.*/\1/p")
  if [[ -n "${STUB_DRIFT_ID:-}" && "$id" == "${STUB_DRIFT_ID}" ]]; then
    echo "deadbeefdrift"
  else
    # Compute the real sha so non-drift-tests pass.
    realsha=$(sha256sum "$SCRIPT_DIR/${id}_"*.sql 2>/dev/null | head -1 | cut -d' ' -f1)
    echo "$realsha"
  fi
  exit 0
fi
# Apply migration (BEGIN; \i file; INSERT INTO schema_migrations; COMMIT)
if [[ "$SQL" == *"INSERT INTO schema_migrations"* || "$SQL" == *"BEGIN"* ]]; then
  exit 0
fi
exit 0
STUB
  chmod +x "$stubdir/psql"
}

# ── Test runner ─────────────────────────────────────────────────────────
run_case() {
  local name="$1"
  local expected_exit="$2"
  local expected_stdout_pattern="$3"
  shift 3
  local args=("$@")

  local stubdir
  stubdir=$(mktemp -d)
  make_stub "$stubdir"
  export PATH="$stubdir:$PATH"
  export SCRIPT_DIR="$ROOT/scripts/migrations"

  set +e
  output=$("$RUN_SH" "${args[@]}" 2>&1)
  actual_exit=$?
  set -e

  # Restore PATH (drop our stubdir).
  PATH="${PATH#$stubdir:}"
  rm -rf "$stubdir"

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    red "FAIL: $name — exit $actual_exit, expected $expected_exit"
    echo "    output: $output" | head -5
    TESTS_FAILED=$((TESTS_FAILED + 1))
    return
  fi
  if [[ -n "$expected_stdout_pattern" ]] && ! echo "$output" | grep -qE "$expected_stdout_pattern"; then
    red "FAIL: $name — stdout did not match: $expected_stdout_pattern"
    echo "    output: $output" | head -5
    TESTS_FAILED=$((TESTS_FAILED + 1))
    return
  fi
  green "PASS: $name"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

# ── Setup ────────────────────────────────────────────────────────────────
export DATABASE_URL="postgres://stub/stub"
export APPLIED_BY="smoke-test"

# ── Cases ───────────────────────────────────────────────────────────────

# Case 1: --help exits 0 with usage text.
run_case "--help prints usage" 0 "Usage" --help

# Case 2: missing DATABASE_URL → exit 1.
( unset DATABASE_URL
  set +e
  out=$("$RUN_SH" --dry-run 2>&1)
  rc=$?
  set -e
  if [[ "$rc" == "1" && "$out" == *"DATABASE_URL not set"* ]]; then
    green "PASS: missing DATABASE_URL → exit 1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    red "FAIL: missing DATABASE_URL — got exit $rc: $out"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
) || true

# Case 3: dry-run with all predecessors applied → lists pending.
# Currently the repo has 001..005 + 007 (006 is operator-driven, in repo).
# If applied=001..006, pending=007 → exit 0.
export STUB_APPLIED="001
002
003
004
005
006"
run_case "dry-run with full predecessors → lists 007" 0 "Pending: 007" --dry-run
unset STUB_APPLIED

# Case 4: empty applied + dry-run → chain validates (001 has no predecessor;
# each subsequent migration's predecessor is already in the same-run queue).
# All pending listed, exit 0.
export STUB_APPLIED=""
run_case "dry-run with empty applied → all pending, chain validates" 0 "Pending: 001 002 003 004 005 006 007" --dry-run
unset STUB_APPLIED

# Case 4b: --apply 003 with NOTHING applied → 002 not in queue → exit 3.
# Singleton apply gates strictly on predecessor.
export STUB_APPLIED=""
run_case "--apply 003 without predecessors → exit 3" 3 "predecessor" --apply 003
unset STUB_APPLIED

# Case 5: dry-run with all already applied → no pending.
export STUB_APPLIED="001
002
003
004
005
006
007"
run_case "all applied → no pending" 0 "No pending" --dry-run
unset STUB_APPLIED

# Case 6: drift detection — applied set claims 005 has a different sha.
export STUB_APPLIED="001
002
003
004
005
006
007"
export STUB_DRIFT_ID="005"
run_case "drift on 005 → exit 4" 4 "drift" --dry-run
unset STUB_APPLIED STUB_DRIFT_ID

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "── Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
if [[ "$TESTS_FAILED" -gt 0 ]]; then
  exit 1
fi
exit 0

#!/usr/bin/env bash
# scripts/migrations/check-integrity.test.sh
#
# Test suite for check-integrity.sh
#
# Prefix-uniqueness tests (default, tests 1–13):
#   1.  Empty directory
#   2.  Single file (no prefix)
#   3.  Single prefixed file
#   4.  Multiple files, no duplicates
#   5.  One duplicate prefix
#   6.  Multiple distinct duplicate prefixes
#   7.  Non-numeric filenames ignored
#   8.  Mixed: numeric + non-numeric
#   9.  Leading-zero prefixes handled correctly (000 vs 0 vs 00)
#  10.  File with 4-digit prefix is NOT matched as 3-digit (no false positives)
#  11.  Large directory (30+ files, no dups)
#  12.  Duplicate at start of range (000_a vs 000_b)
#  13.  Duplicate at end of range (099_a vs 099_b)
#
# Ledger-entry tests (--ledger flag, tests L1–L5):
#  L1. Missing INSERT → exit 2
#  L2. Has INSERT → exit 0
#  L3. Has LEDGER: EXEMPT comment → exit 0
#  L4. Both INSERT + EXEMPT → exit 0 (belt-and-suspenders OK)
#  L5. Non-prefixed files with no INSERT → exit 0 (non-prefixed are ignored)
#
# Usage:
#   bash check-integrity.test.sh          # run prefix tests only
#   bash check-integrity.test.sh --ledger # run ledger tests only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/check-integrity.sh"

LEDGER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --ledger) LEDGER_ONLY=1 ;;
  esac
done

pass=0
fail=0

run() {
  local label="$1"
  local dir="$2"
  local expect_exit="$3"   # 0 = expect success, 1 = expect failure
  local extra_args="${4:-}"

  actual_exit=0
  output=$(MIGRATIONS_DIR="$dir" bash "$CHECK" $extra_args 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expect_exit" ]]; then
    echo "PASS: $label"
    pass=$((pass + 1))
  else
    echo "FAIL: $label"
    echo "  expected exit=$expect_exit got exit=$actual_exit"
    echo "  output: $output"
    fail=$((fail + 1))
  fi
}

mk() {
  local dir
  dir=$(mktemp -d)
  echo "$dir"
}

touch_file() {
  local dir="$1"; shift
  for name in "$@"; do
    touch "$dir/$name"
  done
}

write_sql() {
  local path="$1"
  local content="$2"
  # Use python3 for reliable file writing (avoids printf -- issues on macOS)
  python3 -c "
import sys
path = sys.argv[1]
content = sys.argv[2]
with open(path, 'w') as f:
    f.write(content)
" "$path" "$content"
}

if [[ "$LEDGER_ONLY" -eq 1 ]]; then
  # ── Ledger-entry tests (--ledger) ────────────────────────────────────
  # These test the --strict mode of check-integrity.sh

  # ── Test L1: missing INSERT → exit 2 ────────────────────────────────
  d=$(mk)
  write_sql "$d/001_create_users.sql" "-- 001_create_users.sql
CREATE TABLE users (id SERIAL PRIMARY KEY);
"
  run "L1. missing INSERT → exit 2" "$d" 2 "--strict"
  rm -rf "$d"

  # ── Test L2: has INSERT INTO schema_migrations → exit 0 ─────────────
  d=$(mk)
  write_sql "$d/001_create_users.sql" "-- 001_create_users.sql
CREATE TABLE users (id SERIAL PRIMARY KEY);
INSERT INTO schema_migrations (version) VALUES ('001_create_users') ON CONFLICT DO NOTHING;
"
  run "L2. has INSERT INTO schema_migrations → exit 0" "$d" 0 "--strict"
  rm -rf "$d"

  # ── Test L3: has LEDGER: EXEMPT comment → exit 0 ────────────────────
  d=$(mk)
  write_sql "$d/002_old_migration.sql" "-- 002_old_migration.sql
CREATE TABLE old_stuff (id INT);
-- LEDGER: EXEMPT pre-schema_migrations-table era
"
  run "L3. has LEDGER: EXEMPT comment → exit 0" "$d" 0 "--strict"
  rm -rf "$d"

  # ── Test L4: both INSERT and EXEMPT → exit 0 (belt-and-suspenders) ──
  d=$(mk)
  write_sql "$d/003_belt_suspenders.sql" "-- 003_belt_suspenders.sql
CREATE TABLE x (id INT);
-- LEDGER: EXEMPT belt-and-suspenders
INSERT INTO schema_migrations (version) VALUES ('003_belt_suspenders') ON CONFLICT DO NOTHING;
"
  run "L4. both INSERT and EXEMPT present → exit 0" "$d" 0 "--strict"
  rm -rf "$d"

  # ── Test L5: non-prefixed files without INSERT → exit 0 ─────────────
  # Only files with a 3-digit numeric prefix are checked; README.sql etc are ignored
  d=$(mk)
  write_sql "$d/README.sql" "-- README.sql
-- This is not a migration
"
  write_sql "$d/schema.sql" "-- schema.sql
CREATE TABLE whatever (id INT);
"
  run "L5. non-prefixed files without INSERT → exit 0 (ignored)" "$d" 0 "--strict"
  rm -rf "$d"

  echo ""
  echo "Ledger results: $pass passed, $fail failed (total $((pass + fail)))"
  if [[ "$fail" -gt 0 ]]; then
    exit 1
  fi
  exit 0
fi

# ── Prefix-uniqueness tests (default) ────────────────────────────────

# ── Test 1: empty directory ─────────────────────────────────────────
d=$(mk)
run "1. empty directory → exit 0" "$d" 0
rm -rf "$d"

# ── Test 2: single file without numeric prefix ──────────────────────
d=$(mk)
touch_file "$d" "README.sql"
run "2. single non-prefixed file → exit 0" "$d" 0
rm -rf "$d"

# ── Test 3: single prefixed file ────────────────────────────────────
d=$(mk)
touch_file "$d" "001_init.sql"
run "3. single prefixed file → exit 0" "$d" 0
rm -rf "$d"

# ── Test 4: multiple files, no duplicates ───────────────────────────
d=$(mk)
touch_file "$d" "001_a.sql" "002_b.sql" "003_c.sql" "004_d.sql"
run "4. multiple files no duplicates → exit 0" "$d" 0
rm -rf "$d"

# ── Test 5: one duplicate prefix ────────────────────────────────────
d=$(mk)
touch_file "$d" "055_a.sql" "055_b.sql"
run "5. one duplicate prefix → exit 1" "$d" 1
rm -rf "$d"

# ── Test 6: multiple distinct duplicate prefixes ─────────────────────
d=$(mk)
touch_file "$d" "010_x.sql" "010_y.sql" "020_p.sql" "020_q.sql" "030_solo.sql"
run "6. two distinct duplicate prefixes → exit 1" "$d" 1
rm -rf "$d"

# ── Test 7: non-numeric filenames entirely ignored ───────────────────
d=$(mk)
touch_file "$d" "README.sql" "schema.sql" "seed-data.sql"
run "7. only non-numeric files → exit 0" "$d" 0
rm -rf "$d"

# ── Test 8: mixed numeric + non-numeric, no conflicts ───────────────
d=$(mk)
touch_file "$d" "001_a.sql" "schema.sql" "002_b.sql" "readme.sql"
run "8. mixed numeric+non-numeric no dups → exit 0" "$d" 0
rm -rf "$d"

# ── Test 9: 000 prefix is valid and distinct from unprefixed ─────────
d=$(mk)
touch_file "$d" "000_schema_migrations.sql" "001_init.sql"
run "9. 000 prefix valid, no conflict → exit 0" "$d" 0
rm -rf "$d"

# ── Test 10: 4-digit prefix does NOT match 3-digit regex ────────────
# "1000_foo.sql" should not match "100" vs "1000_bar.sql"
# Both start with 100 but the regex anchors at 3 digits exactly,
# so "1000_foo.sql" extracts "100" from "^[0-9]{3}" → WOULD collide.
# This test verifies the script actually catches that edge case.
d=$(mk)
touch_file "$d" "100_a.sql" "1000_b.sql"
# "1000_b.sql" → grep -oE '^[0-9]{3}' extracts "100" → duplicate with "100_a.sql"
run "10. 4-digit vs 3-digit shares 100 prefix → exit 1" "$d" 1
rm -rf "$d"

# ── Test 11: large directory (30 sequential files, no dups) ─────────
d=$(mk)
for i in $(seq -w 1 30); do
  touch "$d/${i}_migration.sql"
done
run "11. 30 sequential files no dups → exit 0" "$d" 0
rm -rf "$d"

# ── Test 12: duplicate at 000 (start of range) ──────────────────────
d=$(mk)
touch_file "$d" "000_schema_migrations.sql" "000_initial.sql"
run "12. duplicate prefix 000 → exit 1" "$d" 1
rm -rf "$d"

# ── Test 13: duplicate at 099 (end of range) ────────────────────────
d=$(mk)
touch_file "$d" "099_compat.sql" "099_compat_v2.sql"
run "13. duplicate prefix 099 → exit 1" "$d" 1
rm -rf "$d"

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "Results: $pass passed, $fail failed (total $((pass + fail)))"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
exit 0

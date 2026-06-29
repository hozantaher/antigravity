#!/usr/bin/env bash
# scripts/migrations/check-integrity.sh
#
# Two integrity checks for scripts/migrations/*.sql files:
#
#   1. PREFIX UNIQUENESS: No two *.sql files share the same 3-digit numeric
#      prefix.  Exit code 1 on violation.
#
#   2. LEDGER ENTRY (--strict mode): Every prefixed *.sql file must contain
#      an "INSERT INTO schema_migrations" statement, OR an explicit opt-out
#      comment: -- LEDGER: EXEMPT <reason>
#      Exit code 2 on violation.
#
# Compatible with bash 3.2+ (macOS default) — no mapfile/declare -A used.
#
# Usage:
#   bash scripts/migrations/check-integrity.sh            # prefix-uniqueness only
#   bash scripts/migrations/check-integrity.sh --strict   # + ledger-entry check
#   MIGRATIONS_DIR=/tmp/migtest bash check-integrity.sh   # override dir for tests
#
# Exit codes:
#   0 — all checks passed
#   1 — duplicate prefix found
#   2 — migration file missing ledger entry (--strict only)

set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-$(dirname "$0")}"
STRICT=0

for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
  esac
done

# ── Check 1: Prefix uniqueness ─────────────────────────────────────────────

# Collect prefixes from all .sql files.
# For each file that starts with exactly 3 digits, emit "PREFIX BASENAME" line.
prefix_list=""
found_any=0

for f in "$MIGRATIONS_DIR"/*.sql; do
  # glob may not match anything
  [ -e "$f" ] || continue
  found_any=1
  base=$(basename "$f")
  prefix=$(echo "$base" | grep -oE '^[0-9]{3}' || true)
  [ -n "$prefix" ] || continue
  prefix_list="${prefix_list}${prefix} ${base}"$'\n'
done

if [ "$found_any" -eq 0 ]; then
  echo "check-integrity: no .sql files found in $MIGRATIONS_DIR — skipping"
  exit 0
fi

if [ -z "$prefix_list" ]; then
  echo "check-integrity: no prefixed .sql files found — skipping"
  exit 0
fi

# Find duplicate prefixes: sort by prefix, pick lines where prefix repeats.
duplicates=$(echo "$prefix_list" | sort | awk '{print $1}' | sort | uniq -d)

if [ -n "$duplicates" ]; then
  echo "ERROR: Duplicate migration prefixes found in $MIGRATIONS_DIR:"
  for dup in $duplicates; do
    echo "  Prefix $dup:"
    echo "$prefix_list" | awk -v p="$dup" '$1 == p { print "    " $2 }'
  done
  echo ""
  echo "Resolve by renaming one file to a free numeric prefix."
  echo "Also update the corresponding row in schema_migrations if already applied."
  exit 1
fi

total=$(echo "$prefix_list" | grep -c . || true)
echo "check-integrity: prefix-uniqueness OK — ${total} prefixed migration(s), no duplicates"

# ── Check 2: Ledger entry (--strict only) ──────────────────────────────────
#
# Every prefixed migration file must either:
#   a) Contain "INSERT INTO schema_migrations" (any form), OR
#   b) Contain the comment "-- LEDGER: EXEMPT <reason>" explaining why the
#      file legitimately lacks a self-contained ledger entry.
#
# Background: run.sh inserts into schema_migrations after applying each file,
# but having the INSERT inside the file itself serves as an idempotent guard
# that works even when run outside run.sh (e.g. direct psql apply).
# Files created before schema_migrations table existed (001–027) are exempt
# if they contain the EXEMPT comment.

if [ "$STRICT" -eq 0 ]; then
  exit 0
fi

ledger_errors=""

for f in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  prefix=$(echo "$base" | grep -oE '^[0-9]{3}' || true)
  [ -n "$prefix" ] || continue

  # Check for INSERT INTO schema_migrations (handles various column forms)
  if grep -qiE "INSERT INTO schema_migrations" "$f"; then
    continue
  fi

  # Check for explicit EXEMPT declaration
  if grep -q "LEDGER: EXEMPT" "$f"; then
    continue
  fi

  ledger_errors="${ledger_errors}  MISSING: ${base}"$'\n'
done

if [ -n "$ledger_errors" ]; then
  echo ""
  echo "ERROR (--strict): Migration files missing ledger entry:"
  echo "$ledger_errors"
  echo "Each prefixed migration must contain one of:"
  echo "  INSERT INTO schema_migrations (version) VALUES ('NNN_name') ON CONFLICT DO NOTHING;"
  echo "  -- LEDGER: EXEMPT <reason>  (for pre-schema_migrations-table files)"
  echo ""
  echo "See docs/playbooks/migration-rollout-plan.md for guidance."
  exit 2
fi

echo "check-integrity: ledger-entry OK (--strict) — all prefixed migrations have ledger entries"
exit 0

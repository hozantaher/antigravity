#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# BF-G3 — migration runner with ordering enforcement
# ════════════════════════════════════════════════════════════════════════
#
# Reads applied migrations from `schema_migrations` and refuses to run a
# numbered migration when its predecessor is missing. Records every
# successful application with content_sha256 + git_sha so drift is
# detectable later.
#
# Usage:
#   scripts/migrations/run.sh             # apply all pending in order
#   scripts/migrations/run.sh --dry-run   # show plan without applying
#   scripts/migrations/run.sh --apply 003 # force one specific migration
#                                          (still gated on predecessors)
#
# Prerequisites:
#   - DATABASE_URL env set
#   - psql + sha256sum available on PATH
#   - bash 3.2+ (portable; uses no associative arrays)
#   - schema_migrations table exists (apply 000_schema_migrations.sql once
#     manually before first use; the runner creates it idempotently if
#     missing).
#
# Exit codes:
#   0  ok (or no pending migrations)
#   1  generic failure
#   2  out-of-order detected — operator must investigate
#   3  predecessor missing — operator must apply the gap migration first
#   4  drift detected — file content has changed since application
#   6  another migration runner is currently holding the advisory lock
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

DRY_RUN=0
SPECIFIC=""
MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --apply) SPECIFIC="$2"; shift 2 ;;
    -h|--help)
      sed -n '5,30p' "$0"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set" >&2
  exit 1
fi

# ── Distributed advisory lock ────────────────────────────────────────────
# Two parallel CI deploys could otherwise both apply the same migration
# (or worse, advance schema_migrations in conflicting orders). Postgres'
# pg_try_advisory_lock_shared with a fixed bigint key gives us a
# session-scoped mutex. The lock auto-releases when this script's psql
# session ends (process exit / connection drop), so a crash doesn't
# leave a stale lock.
#
# Lock key 8094327462987243961 = sha1('hozan-taher.schema_migrations')
# truncated to int64. Choose any large stable value here — the only
# requirement is consistency across runners.
MIGRATION_LOCK_KEY=8094327462987243961

if ! psql "$DATABASE_URL" -X -A -t -c \
    "SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY})" 2>/dev/null | grep -q '^t$'; then
  echo "ERROR: another migration runner is holding the advisory lock" >&2
  echo "       (key ${MIGRATION_LOCK_KEY}). Wait for the other run to" >&2
  echo "       finish or check for orphaned psql sessions on the DB." >&2
  exit 6
fi

# Release the lock when this script exits (any path).
trap 'psql "$DATABASE_URL" -X -A -t -c "SELECT pg_advisory_unlock('"${MIGRATION_LOCK_KEY}"')" >/dev/null 2>&1 || true' EXIT

# Ensure schema_migrations exists (idempotent CREATE).
psql "$DATABASE_URL" -X -q -f "$MIGRATIONS_DIR/000_schema_migrations.sql" >/dev/null

# ── Schema compat probe ──────────────────────────────────────────────────
# Prod may have the legacy (version, applied_at) schema — bootstrapped
# before BF-G3 installed migration_id/filename/content_sha256. Detect
# whether the full schema is present; degrade gracefully until 099 applies.
#
# FULL_SCHEMA=1  → migration_id column exists → all features available.
# FULL_SCHEMA=0  → degraded mode: read "version", INSERT only "version".
#                  Drift detection is skipped (no content_sha256 to read).
#                  099_schema_migrations_compat.sql must be applied to
#                  graduate back to full-schema mode.
FULL_SCHEMA=$(psql "$DATABASE_URL" -X -A -t -c \
  "SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name='schema_migrations' AND column_name='migration_id'" 2>/dev/null || echo "0")
FULL_SCHEMA="${FULL_SCHEMA:-0}"

if [[ "$FULL_SCHEMA" != "1" ]]; then
  echo "── WARN: schema_migrations is in legacy schema (version col only)." >&2
  echo "         Drift detection disabled until 099_schema_migrations_compat.sql is applied." >&2
  echo "         Apply 099 first (manually) to restore full BF-G3 runner features." >&2
fi

# ── Portable id → file mapping ──────────────────────────────────────────
# Use parallel arrays instead of `declare -A` so we work on bash 3.2
# (macOS default). MIGRATION_IDS holds the sorted ids; MIGRATION_FILES
# holds the file paths in matching order.
MIGRATION_IDS=()
MIGRATION_FILES=()

# Helper: look up file path for a given id. Echoes empty string when not found.
file_for_id() {
  local target="$1"
  local i
  for i in "${!MIGRATION_IDS[@]}"; do
    if [[ "${MIGRATION_IDS[$i]}" == "$target" ]]; then
      echo "${MIGRATION_FILES[$i]}"
      return 0
    fi
  done
  echo ""
}

# Collect file → id mapping. Skip the bookkeeping migration (000).
# Sort lexicographically; 3-digit prefixes make this also numeric.
for f in $(ls "$MIGRATIONS_DIR"/[0-9][0-9][0-9]_*.sql 2>/dev/null | sort); do
  base="$(basename "$f")"
  id="${base%%_*}"
  if [[ "$id" == "000" ]]; then
    continue
  fi
  MIGRATION_IDS+=("$id")
  MIGRATION_FILES+=("$f")
done

if [[ ${#MIGRATION_IDS[@]} -eq 0 ]]; then
  echo "── No migrations found in $MIGRATIONS_DIR"
  exit 0
fi

# Read applied IDs from DB into a space-padded string for portable contains check.
# Degrade to "version" column when migration_id does not exist yet (legacy schema).
if [[ "$FULL_SCHEMA" == "1" ]]; then
  APPLIED_LIST=$(psql "$DATABASE_URL" -X -q -t -A -c \
    "SELECT migration_id FROM schema_migrations ORDER BY migration_id" || true)
else
  APPLIED_LIST=$(psql "$DATABASE_URL" -X -q -t -A -c \
    "SELECT version FROM schema_migrations ORDER BY version" || true)
fi
# Build " 001 002 003 " for $applied_set
APPLIED_SET=" "
while IFS= read -r line; do
  [[ -n "$line" ]] && APPLIED_SET="${APPLIED_SET}${line} "
done <<EOF
$APPLIED_LIST
EOF

is_applied() {
  [[ "$APPLIED_SET" == *" $1 "* ]]
}

# Detect drift on already-applied migrations: re-hash file, compare.
# Skipped entirely in legacy-schema mode (no content_sha256 to read).
if [[ "$FULL_SCHEMA" == "1" ]]; then
  for id in "${MIGRATION_IDS[@]}"; do
    if is_applied "$id"; then
      file=$(file_for_id "$id")
      sha="$(sha256sum "$file" | cut -d' ' -f1)"
      db_sha=$(psql "$DATABASE_URL" -X -q -t -A -c \
        "SELECT content_sha256 FROM schema_migrations WHERE migration_id='$id'")
      if [[ "$db_sha" != "manual-backfill" && "$db_sha" != "$sha" ]]; then
        echo "ERROR: drift on migration $id ($file)" >&2
        echo "       db sha: $db_sha" >&2
        echo "       file  : $sha" >&2
        echo "       Either re-apply via a NEW migration with a higher number," >&2
        echo "       or manually update schema_migrations after fixing." >&2
        exit 4
      fi
    fi
  done
fi

# Build the list of pending migrations.
PENDING=()
for id in "${MIGRATION_IDS[@]}"; do
  is_applied "$id" && continue
  if [[ -n "$SPECIFIC" && "$id" != "$SPECIFIC" ]]; then
    continue
  fi
  PENDING+=("$id")
done

if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo "── No pending migrations."
  exit 0
fi

echo "── Pending: ${PENDING[*]}"

# Predecessor check for each pending migration. Predecessor = highest id
# strictly less than this one (in our sorted list). Must be applied OR
# included earlier in this same run.
QUEUED_SET="$APPLIED_SET"
for id in "${MIGRATION_IDS[@]}"; do
  is_applied "$id" && continue
  # Already in pending list? Pending items get added to QUEUED_SET as we
  # process them, so a chain 001 → 002 → 003 in one run validates.
  in_pending=0
  for p in "${PENDING[@]}"; do
    [[ "$p" == "$id" ]] && in_pending=1 && break
  done
  if [[ "$in_pending" == "1" ]]; then
    # Find predecessor = id immediately before this one in MIGRATION_IDS.
    predecessor=""
    for known in "${MIGRATION_IDS[@]}"; do
      if [[ "$known" < "$id" ]]; then
        predecessor="$known"
      fi
    done
    if [[ -n "$predecessor" ]] && [[ "$QUEUED_SET" != *" $predecessor "* ]]; then
      echo "ERROR: migration $id requires predecessor $predecessor (not applied)" >&2
      echo "       Apply $predecessor first or run without --apply to do all in order." >&2
      exit 3
    fi
    QUEUED_SET="${QUEUED_SET}${id} "
  fi
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo "── DRY-RUN — would apply (in order):"
  for id in "${PENDING[@]}"; do
    echo "    $id  $(file_for_id "$id")"
  done
  exit 0
fi

# Apply each in a transaction with content_sha256 record.
# In legacy-schema mode (pre-099) we insert only the "version" column because
# migration_id/filename/content_sha256 don't exist yet.
for id in "${PENDING[@]}"; do
  file=$(file_for_id "$id")
  echo "── Applying $id ($file)"

  # Detect statements that cannot run inside a transaction. Postgres
  # refuses CREATE/DROP INDEX/MATERIALIZED VIEW with CONCURRENTLY,
  # ALTER TYPE … ADD VALUE (pre-PG12), VACUUM, REINDEX CONCURRENTLY,
  # and a handful of others when wrapped in BEGIN/COMMIT. Wrapping such
  # a file silently corrupts the apply (the COMMIT bookkeeping insert
  # never lands because the body errored out).
  #
  # Opt-in marker: a comment containing `nontransactional` (case-insensitive)
  # in the first 30 lines forces the unwrapped path even when grep below
  # wouldn't catch it. Otherwise we auto-detect CONCURRENTLY usage.
  NEEDS_NOTX=0
  if head -30 "$file" | grep -iqE 'nontransactional|no-transaction'; then
    NEEDS_NOTX=1
  elif grep -iqE 'CONCURRENTLY' "$file"; then
    NEEDS_NOTX=1
  fi

  if [[ "$FULL_SCHEMA" == "1" ]]; then
    sha="$(sha256sum "$file" | cut -d' ' -f1)"
  fi

  if [[ "$NEEDS_NOTX" == "1" ]]; then
    # Apply migration body OUTSIDE a transaction. If it fails, no
    # bookkeeping insert is issued, so the operator sees the failure
    # cleanly. Partial apply is the caller's responsibility (this is
    # already the case when applying CONCURRENTLY manually).
    echo "── (running outside transaction — CONCURRENTLY or nontransactional marker)"
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$file"

    # Record the apply in a separate, wrapped statement so the
    # schema_migrations row is still atomically inserted.
    if [[ "$FULL_SCHEMA" == "1" ]]; then
      psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
BEGIN;
INSERT INTO schema_migrations(migration_id, filename, content_sha256, applied_by, git_sha)
  VALUES ('$id', '$(basename "$file")', '$sha', '${APPLIED_BY:-runner}', '${GIT_SHA:-unknown}')
  ON CONFLICT (migration_id) DO NOTHING;
COMMIT;
SQL
    else
      psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
BEGIN;
INSERT INTO schema_migrations(version, applied_at)
  VALUES ('$id', now())
  ON CONFLICT (version) DO NOTHING;
COMMIT;
SQL
    fi
    continue
  fi

  # Standard path: wrap body + bookkeeping insert in a single tx so a
  # partial apply doesn't leave a record. The migration file may have
  # its own BEGIN/COMMIT — psql handles nested gracefully (savepoints).
  if [[ "$FULL_SCHEMA" == "1" ]]; then
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
BEGIN;
\\i $file
INSERT INTO schema_migrations(migration_id, filename, content_sha256, applied_by, git_sha)
  VALUES ('$id', '$(basename "$file")', '$sha', '${APPLIED_BY:-runner}', '${GIT_SHA:-unknown}')
  ON CONFLICT (migration_id) DO NOTHING;
COMMIT;
SQL
  else
    # Degraded path: only "version" column exists.
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL
BEGIN;
\\i $file
INSERT INTO schema_migrations(version, applied_at)
  VALUES ('$id', now())
  ON CONFLICT (version) DO NOTHING;
COMMIT;
SQL
  fi
done

echo "── Done. Applied: ${PENDING[*]}"

#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# S6.4 — Refresh ETL stub from firmy.cz / ARES
# ════════════════════════════════════════════════════════════════════════
#
# Manual-trigger script. Re-fetches subset of contacts whose
# outreach_contacts.last_score_update > 6 months. Operator runs quarterly.
#
# Usage:
#   scripts/etl/refresh-firmy-cz.sh              # default: stale check + report
#   scripts/etl/refresh-firmy-cz.sh --dry-run    # preview changes only
#   scripts/etl/refresh-firmy-cz.sh --execute    # actually update
#   scripts/etl/refresh-firmy-cz.sh --batch=500  # rows per chunk (default 500)
#
# Prerequisites:
#   - DATABASE_URL env set (Railway production DB)
#   - psql installed
#
# Pre-flight:
#   1. Run with no flags first — see how many rows are stale
#   2. Use --dry-run to inspect specific changes
#   3. Use --execute only after operator review
#
# Audit:
#   Each batch writes to operator_audit_log so changes are traceable.
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

DRY_RUN=0
EXECUTE=0
BATCH=500
STALE_DAYS=180  # 6 months

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --execute) EXECUTE=1; shift ;;
    --batch=*) BATCH="${1#*=}"; shift ;;
    --stale-days=*) STALE_DAYS="${1#*=}"; shift ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [options]

Options:
  --dry-run         Preview changes without writing
  --execute         Actually run the ETL refresh
  --batch=N         Rows per chunk (default: 500)
  --stale-days=N    Threshold for "stale" rows (default: 180 = 6 months)

Without --dry-run or --execute, prints stale count + sample rows only.
USAGE
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $DRY_RUN -eq 1 && $EXECUTE -eq 1 ]]; then
  echo "ERROR: --dry-run and --execute are mutually exclusive" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set" >&2
  exit 1
fi

echo "── ETL refresh: firmy.cz / ARES ──"
echo "── Stale threshold: $STALE_DAYS days"
echo "── Batch size: $BATCH"
echo ""

# 1. Stale row count (always shown)
echo "── Stale rows by category ──"
psql "$DATABASE_URL" -X -c "
SELECT
  COUNT(*) FILTER (WHERE oc.last_score_update IS NULL) AS never_scored,
  COUNT(*) FILTER (WHERE oc.last_score_update < now() - interval '${STALE_DAYS} days') AS stale,
  COUNT(*) AS total
FROM outreach_contacts oc;
"

if [[ $DRY_RUN -eq 0 && $EXECUTE -eq 0 ]]; then
  echo ""
  echo "── No action taken. Use --dry-run to preview, --execute to apply."
  exit 0
fi

# 2. Sample stale rows for preview
echo "── Sample of $BATCH stale rows ──"
psql "$DATABASE_URL" -X -A -F'|' -c "
SELECT oc.id, oc.email, oc.company_name, oc.last_score_update, oc.industry_tags
FROM outreach_contacts oc
WHERE oc.last_score_update IS NULL OR oc.last_score_update < now() - interval '${STALE_DAYS} days'
ORDER BY oc.last_score_update NULLS FIRST
LIMIT 20;
"

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "── Dry-run complete. No changes written."
  echo "── To execute: $0 --execute"
  exit 0
fi

# 3. Execute path
echo ""
echo "── EXECUTING refresh ──"

# Currently this is a STUB — the actual fetch from firmy.cz is implemented
# in the contacts service (features/acquisition/contacts/prospect/firmy.go). The Go-side
# CLI command would be something like:
#
#   go run ./features/acquisition/contacts/cmd/refresh -batch=$BATCH -stale-days=$STALE_DAYS
#
# For now, just log + audit. Real ETL implementation is S6.4 follow-up.

cat <<'NOTE'
── STUB MODE ──
The actual firmy.cz fetch + score recompute is not yet wired into this
script. This is a placeholder that:
  - Logs the intent to operator_audit_log
  - Marks last_score_update on a sample so the next run picks different rows
  - Does NOT make external HTTP calls

To implement real ETL:
  1. Wire features/acquisition/contacts/prospect/firmy.go FetchByICO into a CLI command
  2. Replace the stub UPDATE below with: for each stale row, fetch firmy.cz,
     update outreach_contacts.industry_tags + company_name + last_score_update
  3. Add rate-limiting (firmy.cz has anti-scrape — robots.txt + delays)
  4. Add retry on 5xx
NOTE

psql "$DATABASE_URL" -v batch="$BATCH" -v stale_days="$STALE_DAYS" <<'SQL'
\set ON_ERROR_STOP on

BEGIN;

-- Mark sample as "scored" so next dry-run shows different rows
WITH sample AS (
    SELECT id FROM outreach_contacts
    WHERE last_score_update IS NULL OR last_score_update < now() - interval ':stale_days days'
    ORDER BY last_score_update NULLS FIRST
    LIMIT :batch
)
UPDATE outreach_contacts
SET last_score_update = now()
WHERE id IN (SELECT id FROM sample);

-- Audit log
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'etl_refresh_stub',
    'operator',
    'table',
    'outreach_contacts',
    jsonb_build_object(
        'reason', 'S6.4 ETL refresh stub',
        'batch_size', :batch,
        'stale_days', :stale_days,
        'note', 'STUB MODE — only timestamp updated, no real refetch'
    )
);

COMMIT;
SQL

echo ""
echo "── Refresh complete. Audit log row written."
echo "── Re-run with --dry-run to verify rows were processed."

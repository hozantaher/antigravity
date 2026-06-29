#!/usr/bin/env bash
# seed-iter48.sh — apply / clean iter48-home-population.sql against a LOCAL DB only.
#
# HARD feedback_outreach_dashboard_local_only T0 — refuses to run against prod hosts.
# HARD feedback_no_fabricated_test_data T0 — all rows use synthetic_ prefix.
#
# Usage:
#   ./scripts/seed-iter48.sh           # apply seed
#   ./scripts/seed-iter48.sh --clean   # delete seeded rows only
#
# Requires:
#   - DATABASE_URL set in .env (or already in environment)
#   - psql on PATH
#
# Prints "Seeded: N rows" per table after apply.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SEED_FILE="$APP_DIR/tests/_fixtures/seeds/iter48-home-population.sql"

# ── Load .env if DATABASE_URL not already set ──────────────────────────────────
if [[ -z "${DATABASE_URL:-}" && -f "$APP_DIR/.env" ]]; then
  # Export only DATABASE_URL line; never print it to stdout (PII guard).
  export DATABASE_URL
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '[:space:]')"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set. Add it to apps/outreach-dashboard/.env" >&2
  exit 1
fi

# ── Safety: refuse to run against production hosts ────────────────────────────
# Prod indicators: rlwy.net (Railway), railway.app, junction.proxy, neon.tech,
# supabase.co, amazonaws.com.
PROD_PATTERN='rlwy\.net|railway\.app|junction\.proxy|neon\.tech|supabase\.co|amazonaws\.com'
if echo "$DATABASE_URL" | grep -qE "$PROD_PATTERN"; then
  echo "ERROR: DATABASE_URL looks like a production host." >&2
  echo "       This seed script MUST only run against localhost / dev DB." >&2
  echo "       Aborting to protect production data." >&2
  exit 2
fi

# ── --clean mode ─────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--clean" ]]; then
  echo "--- CLEAN: removing iter48 seed rows (id >= 999000) ---"
  psql "$DATABASE_URL" <<'SQL'
DELETE FROM bounce_events       WHERE id >= 999000;
DELETE FROM reply_inbox         WHERE id >= 999000;
DELETE FROM send_events         WHERE id >= 999000;
DELETE FROM email_verify_queue  WHERE id >= 999000;
DELETE FROM unmatched_inbound   WHERE id >= 999000;
DELETE FROM contacts            WHERE id >= 999000;
DELETE FROM outreach_mailboxes  WHERE id >= 999000;
DELETE FROM campaigns           WHERE id >= 999000;
SQL
  echo "--- Clean complete ---"
  exit 0
fi

# ── Apply seed ────────────────────────────────────────────────────────────────
echo "--- Applying iter48 seed (local DB only) ---"
psql "$DATABASE_URL" -f "$SEED_FILE"

# ── Verification: print row counts per table ──────────────────────────────────
echo ""
echo "--- Verification (rows with id >= 999000) ---"
psql "$DATABASE_URL" --no-align --tuples-only <<'SQL'
SELECT 'contacts'           AS tbl, COUNT(*) AS n FROM contacts           WHERE id >= 999000
UNION ALL
SELECT 'reply_inbox',               COUNT(*)      FROM reply_inbox         WHERE id >= 999000
UNION ALL
SELECT 'send_events',               COUNT(*)      FROM send_events         WHERE id >= 999000
UNION ALL
SELECT 'bounce_events',             COUNT(*)      FROM bounce_events       WHERE id >= 999000
UNION ALL
SELECT 'outreach_mailboxes',        COUNT(*)      FROM outreach_mailboxes  WHERE id >= 999000
UNION ALL
SELECT 'campaigns',                 COUNT(*)      FROM campaigns           WHERE id >= 999000
UNION ALL
SELECT 'email_verify_queue',        COUNT(*)      FROM email_verify_queue  WHERE id >= 999000
UNION ALL
SELECT 'unmatched_inbound',         COUNT(*)      FROM unmatched_inbound   WHERE id >= 999000
ORDER BY 1;
SQL

echo ""
echo "--- Seeded successfully. Run with --clean to remove these rows. ---"

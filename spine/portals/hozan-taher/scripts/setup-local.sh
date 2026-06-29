#!/usr/bin/env bash
# setup-local.sh — one-shot local dev database setup for outreach-dashboard
#
# What it does:
#   1. Starts outreach-db (port 5433) and firmy-db (port 5434) via docker compose
#   2. Waits for both postgres instances to accept connections
#   3. Runs all outreach DB migrations (001_outreach_schema → 007_audit_log_values)
#   4. Seeds the firmy DB (schema + 20 test firms)
#   5. Seeds the outreach DB (contacts, threads, messages, companies, score_history, audit_log)
#   6. Optional: sync firmy tables from Railway production (when SYNC_FIRMY_FROM_PROD=1)
#
# After this script: cd features/platform/outreach-dashboard && pnpm dev
set -euo pipefail

# Ensure homebrew binaries (docker, psql) are on PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGS="$ROOT/modules/outreach/internal/db/migrations"

OUTREACH_HOST=localhost
OUTREACH_PORT=5433
OUTREACH_USER=outreach
OUTREACH_PASS=outreach
OUTREACH_DB=outreach
OUTREACH_DSN="postgresql://$OUTREACH_USER:$OUTREACH_PASS@$OUTREACH_HOST:$OUTREACH_PORT/$OUTREACH_DB"

FIRMY_HOST=localhost
FIRMY_PORT=5434
FIRMY_USER=firmy
FIRMY_PASS=firmy
FIRMY_DB=firmy

psql_outreach() {
  PGPASSWORD="$OUTREACH_PASS" psql -h "$OUTREACH_HOST" -p "$OUTREACH_PORT" \
    -U "$OUTREACH_USER" -d "$OUTREACH_DB" -v ON_ERROR_STOP=1 "$@"
}

psql_firmy() {
  PGPASSWORD="$FIRMY_PASS" psql -h "$FIRMY_HOST" -p "$FIRMY_PORT" \
    -U "$FIRMY_USER" -d "$FIRMY_DB" -v ON_ERROR_STOP=1 "$@"
}

# ── 1. Start containers ───────────────────────────────────────────────
echo "=== 1. Starting docker compose services ==="
cd "$ROOT"
docker compose -f infra/docker/docker-compose.yml up -d outreach-db firmy-db

# ── 2. Wait for postgres ──────────────────────────────────────────────
echo "=== 2. Waiting for databases (up to 30s) ==="
for i in $(seq 1 30); do
  outreach_ok=false
  firmy_ok=false
  PGPASSWORD="$OUTREACH_PASS" psql -h "$OUTREACH_HOST" -p "$OUTREACH_PORT" \
    -U "$OUTREACH_USER" -d "$OUTREACH_DB" -c "SELECT 1" >/dev/null 2>&1 && outreach_ok=true
  PGPASSWORD="$FIRMY_PASS" psql -h "$FIRMY_HOST" -p "$FIRMY_PORT" \
    -U "$FIRMY_USER" -d "$FIRMY_DB" -c "SELECT 1" >/dev/null 2>&1 && firmy_ok=true
  if $outreach_ok && $firmy_ok; then
    echo "  Both databases ready (attempt $i)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: databases did not become ready after 30 seconds"
    exit 1
  fi
  sleep 1
done

# ── 3. Outreach DB migrations ─────────────────────────────────────────
echo "=== 3. Running outreach migrations ==="
for sql in \
  "$MIGS/001_contacts.sql" \
  "$MIGS/002_campaigns.sql" \
  "$MIGS/003_events.sql" \
  "$MIGS/001_outreach_schema.sql" \
  "$MIGS/002_complaint_rate.sql" \
  "$MIGS/004_audit_log.sql" \
  "$MIGS/005_score_history.sql" \
  "$MIGS/006_companies.sql" \
  "$MIGS/007_audit_log_values.sql"
do
  echo "  $(basename "$sql")"
  psql_outreach -f "$sql" -q
done

# ── 4. Firmy DB setup ─────────────────────────────────────────────────
echo "=== 4. Seeding firmy DB (schema + 20 firms) ==="
psql_firmy -f "$ROOT/scripts/seed-firmy-local.sql" -q

# ── 5. Outreach DB seed ───────────────────────────────────────────────
echo "=== 5. Seeding outreach DB (contacts, threads, companies, audit) ==="
psql_outreach -f "$ROOT/scripts/seed-dashboard.sql" -q

# ── 6. Optional sync from production ───────────────────────────────────
if [ "${SYNC_FIRMY_FROM_PROD:-0}" = "1" ]; then
  echo "=== 6. Syncing firmy DB from Railway production ==="
  echo "  Mode: ${SYNC_MODE:-incremental}"
  SOURCE_DSN="${SOURCE_DSN:-}" \
  TARGET_DSN="postgresql://$FIRMY_USER:$FIRMY_PASS@$FIRMY_HOST:$FIRMY_PORT/$FIRMY_DB" \
  SYNC_MODE="${SYNC_MODE:-incremental}" \
  "$ROOT/scripts/sync-firmy-from-prod.sh"
fi

# ── Done ──────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Local setup complete!                                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  outreach-db  →  $OUTREACH_DSN"
echo "  firmy-db     →  postgresql://$FIRMY_USER:$FIRMY_PASS@$FIRMY_HOST:$FIRMY_PORT/$FIRMY_DB"
echo ""
echo "  Start dashboard:"
echo "    cd features/platform/outreach-dashboard && pnpm dev"
echo ""
echo "  Setup + prod sync (firmy tables):"
echo "    SYNC_FIRMY_FROM_PROD=1 SOURCE_DSN='postgresql://...proxy.rlwy.net:PORT/railway' ./scripts/setup-local.sh"
echo ""
echo "  Stop databases:"
echo "    docker compose -f infra/docker/docker-compose.yml stop outreach-db firmy-db"

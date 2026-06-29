#!/usr/bin/env bash
# rollback-launch.sh — operator helper for Day 1 launch rollback.
#
# Usage:
#   scripts/launch/rollback-launch.sh                # interactive (asks)
#   scripts/launch/rollback-launch.sh --reason "X"   # batch (with reason)
#   scripts/launch/rollback-launch.sh --dry-run      # SQL preview only
#
# What it does (idempotent — safe to run twice):
#   1. UPDATE campaigns SET status='paused' WHERE id=1 AND status='active'.
#   2. INSERT operator_audit_log row recording the rollback + reason.
#   3. (Optional, opt-in via --close-relay) POST relay /v1/drain to flush
#      in-flight envelopes; defaults OFF because flush-in-flight is
#      destructive.
#   4. Emits a Sentry breadcrumb via the BFF /api/sentry/breadcrumb endpoint
#      if BFF is reachable.
#
# Reads DATABASE_URL from features/platform/outreach-dashboard/.env (same as
# verify-launch.mjs). HARD RULE memory feedback_no_pii_in_commands:
# DO NOT pass a DSN inline; the script reads it from .env.
#
# Exit codes:
#   0 — rollback completed (or already paused)
#   1 — DB or audit failed; investigate manually
#   2 — invocation error (no DB env, missing .env)

set -euo pipefail

REASON=""
DRY_RUN=0
CLOSE_RELAY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)        shift; REASON="${1:-}"; shift || true ;;
    --reason=*)      REASON="${1#--reason=}"; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --close-relay)   CLOSE_RELAY=1; shift ;;
    -h|--help)
      head -n 24 "$0" | tail -n 23
      exit 0
      ;;
    *) shift ;;
  esac
done

# ── Locate .env ─────────────────────────────────────────────────────────
HERE=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE="$HERE/features/platform/outreach-dashboard/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ .env not found at $ENV_FILE — cannot read DATABASE_URL" >&2
  exit 2
fi

# Source DATABASE_URL (only). Ignore other vars to limit blast radius.
DB_URL=$(grep -E '^(DATABASE_URL|OUTREACH_DATABASE_URL)=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
if [ -z "$DB_URL" ]; then
  echo "✗ DATABASE_URL missing in $ENV_FILE" >&2
  exit 2
fi
# Strip optional surrounding quotes
DB_URL=${DB_URL#\"}
DB_URL=${DB_URL%\"}

if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql not installed — install postgres client" >&2
  exit 2
fi

# ── Reason prompt ───────────────────────────────────────────────────────
if [ -z "$REASON" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    REASON="(dry-run preview)"
  else
    read -r -p "Rollback reason (≤200 chars): " REASON
  fi
fi
if [ ${#REASON} -gt 200 ]; then
  echo "✗ Reason too long (${#REASON} chars, max 200)" >&2
  exit 2
fi

# ── SQL ─────────────────────────────────────────────────────────────────
SQL=$(cat <<EOF
DO \$\$
DECLARE
  v_was_active boolean;
BEGIN
  SELECT (status = 'active') INTO v_was_active FROM campaigns WHERE id = 1;
  IF v_was_active THEN
    UPDATE campaigns SET status = 'paused', updated_at = now() WHERE id = 1;
    RAISE NOTICE 'campaign 1 paused';
  ELSE
    RAISE NOTICE 'campaign 1 not active — no-op (idempotent)';
  END IF;

  INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
  VALUES (
    'campaign_rollback',
    'rollback-launch.sh',
    'campaign',
    '1',
    jsonb_build_object('reason', \$1::text, 'was_active', v_was_active, 'ts', now()),
    now()
  );
END \$\$;
EOF
)

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "Dry run — would run against \$DATABASE_URL:"
  echo "─────────────────────────────────────────────────────────────────"
  echo "$SQL" | sed "s|\$1::text|'$REASON'|"
  echo "─────────────────────────────────────────────────────────────────"
  exit 0
fi

# ── Execute ─────────────────────────────────────────────────────────────
echo ""
echo "→ Rolling back campaign 1. Reason: $REASON"
if ! PSQL_OUT=$(echo "$SQL" | PGPASSWORD="" psql "$DB_URL" -v reason="$REASON" -t -A -X -c "$(echo "$SQL" | sed "s|\$1::text|'$(printf '%s' "$REASON" | sed "s/'/''/g")'|")" 2>&1); then
  echo "✗ psql failed:" >&2
  echo "$PSQL_OUT" >&2
  exit 1
fi
echo "✓ rollback executed"
echo "$PSQL_OUT" | grep -i NOTICE || true

# ── Optional: relay drain ──────────────────────────────────────────────
if [ "$CLOSE_RELAY" -eq 1 ]; then
  RELAY="${ANTI_TRACE_RELAY_URL:-${ANTI_TRACE_URL:-}}"
  TOKEN="${ANTI_TRACE_RELAY_TOKEN:-${ANTI_TRACE_TOKEN:-}}"
  if [ -n "$RELAY" ] && [ -n "$TOKEN" ]; then
    echo "→ Draining anti-trace-relay queue (--close-relay)"
    curl -s -X POST -H "Authorization: Bearer $TOKEN" "${RELAY%/}/v1/drain" >/dev/null \
      && echo "✓ relay drain requested" \
      || echo "⚠ relay drain failed (non-fatal)"
  else
    echo "⚠ --close-relay requested but ANTI_TRACE_RELAY_URL/TOKEN unset"
  fi
fi

# ── Sentry breadcrumb (best-effort) ────────────────────────────────────
BFF="${BFF_BASE_URL:-http://localhost:18001}"
if curl -sf -m 2 "$BFF/api/health/system" >/dev/null 2>&1; then
  curl -sf -X POST -H 'content-type: application/json' \
    -d "{\"category\":\"launch.rollback\",\"message\":\"campaign 1 rollback: $REASON\",\"level\":\"warning\"}" \
    "$BFF/api/sentry/breadcrumb" >/dev/null 2>&1 \
    && echo "✓ Sentry breadcrumb emitted" \
    || echo "⚠ Sentry breadcrumb endpoint not available (non-fatal)"
fi

echo ""
echo "Rollback complete. Next steps:"
echo "  1. Verify in /mailboxes UI — campaign 1 LaunchStatsRow should hide (status=paused)."
echo "  2. Investigate root cause (Sentry, /api/health/system, IMAP harvest)."
echo "  3. Document in docs/audits/2026-05-05-launch-observation-log.md → Rollback section."
echo "  4. To resume: UPDATE campaigns SET status='active' WHERE id=1; (operator only)"

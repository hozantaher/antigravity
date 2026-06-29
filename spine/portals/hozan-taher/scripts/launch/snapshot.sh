#!/usr/bin/env bash
# snapshot.sh — capture pre/post launch state for diff.
#
# Two modes:
#   --pre   write snapshot to docs/audits/2026-05-05-launch-pre.json
#   --post  write snapshot to docs/audits/2026-05-05-launch-post-T+<NN>m.json
#   --diff  print human-readable diff between latest pre and most recent post
#
# All snapshots are JSON, redacted of any PII (no email addresses, no passwords,
# no DSNs). Captures only aggregate counts + statuses.
#
# Reads DATABASE_URL from features/platform/outreach-dashboard/.env per memory
# feedback_no_pii_in_commands.

set -euo pipefail

MODE=""
T_LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pre)        MODE=pre; shift ;;
    --post)       MODE=post; shift ;;
    --post=*)     MODE=post; T_LABEL="${1#--post=}"; shift ;;
    --diff)       MODE=diff; shift ;;
    -h|--help)
      head -n 14 "$0" | tail -n 13
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Usage: $0 --pre | --post[=T+15m] | --diff" >&2
  exit 2
fi

HERE=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE="$HERE/features/platform/outreach-dashboard/.env"
AUDIT_DIR="$HERE/docs/audits"
mkdir -p "$AUDIT_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ .env not found at $ENV_FILE" >&2
  exit 2
fi
DB_URL=$(grep -E '^(DATABASE_URL|OUTREACH_DATABASE_URL)=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
DB_URL=${DB_URL#\"}; DB_URL=${DB_URL%\"}
if [ -z "$DB_URL" ]; then
  echo "✗ DATABASE_URL missing in $ENV_FILE" >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql not installed" >&2
  exit 2
fi

snapshot_query() {
  psql "$DB_URL" -t -A -X -c "
    SELECT json_build_object(
      'taken_at', now(),
      'tz', current_setting('TIMEZONE'),
      'campaign', (
        SELECT json_build_object('id', id, 'name', name, 'status', status, 'updated_at', updated_at)
        FROM campaigns WHERE id = 1
      ),
      'cohort', (
        SELECT json_build_object(
          'total',     COUNT(*),
          'active',    COUNT(*) FILTER (WHERE status IN ('pending','in_sequence')),
          'completed', COUNT(*) FILTER (WHERE status='completed'),
          'at_step0',  COUNT(*) FILTER (WHERE current_step=0),
          'at_step1',  COUNT(*) FILTER (WHERE current_step=1),
          'at_step2',  COUNT(*) FILTER (WHERE current_step=2)
        ) FROM campaign_contacts WHERE campaign_id = 1
      ),
      'sends', (
        SELECT json_build_object(
          'total_24h',      COUNT(*) FILTER (WHERE sent_at > now() - interval '24 hours'),
          'sent_24h',       COUNT(*) FILTER (WHERE status='sent'    AND sent_at > now() - interval '24 hours'),
          'bounced_24h',    COUNT(*) FILTER (WHERE status='bounced' AND sent_at > now() - interval '24 hours'),
          'suppressed_24h', COUNT(*) FILTER (WHERE status='suppressed' AND sent_at > now() - interval '24 hours'),
          'last_send_at',   MAX(sent_at)
        ) FROM send_events WHERE campaign_id = 1
      ),
      'mailboxes', (
        SELECT json_agg(json_build_object(
          'id', id,
          'status', status,
          'consecutive_bounces', consecutive_bounces,
          'total_sent', total_sent,
          'total_bounced', total_bounced,
          'last_send_at', last_send_at
        ))
        FROM outreach_mailboxes
      )
    )
  "
}

case "$MODE" in
  pre)
    OUT="$AUDIT_DIR/2026-05-05-launch-pre.json"
    echo "→ Capturing PRE-launch snapshot to $OUT"
    snapshot_query > "$OUT"
    if [ ! -s "$OUT" ]; then
      echo "✗ Snapshot empty — DB query failed?" >&2
      exit 1
    fi
    echo "✓ wrote $(wc -c < "$OUT") bytes"
    ;;
  post)
    LABEL=${T_LABEL:-T+0}
    OUT="$AUDIT_DIR/2026-05-05-launch-post-${LABEL}.json"
    echo "→ Capturing POST-launch snapshot ($LABEL) to $OUT"
    snapshot_query > "$OUT"
    if [ ! -s "$OUT" ]; then
      echo "✗ Snapshot empty — DB query failed?" >&2
      exit 1
    fi
    echo "✓ wrote $(wc -c < "$OUT") bytes"
    ;;
  diff)
    PRE="$AUDIT_DIR/2026-05-05-launch-pre.json"
    if [ ! -f "$PRE" ]; then
      echo "✗ No pre-snapshot at $PRE — run --pre first." >&2
      exit 1
    fi
    POST=$(ls -t "$AUDIT_DIR"/2026-05-05-launch-post-*.json 2>/dev/null | head -n1)
    if [ -z "$POST" ]; then
      echo "✗ No post-snapshot in $AUDIT_DIR" >&2
      exit 1
    fi
    echo "Diff: $(basename "$PRE") → $(basename "$POST")"
    echo "─────────────────────────────────────────────────────────────────────"
    if command -v jq >/dev/null 2>&1; then
      jq --argfile a "$PRE" --argfile b "$POST" -n '
        def keys_of: (.[0] | keys) + (.[1] | keys) | unique;
        {
          campaign: { from: $a.campaign, to: $b.campaign },
          cohort_delta: ([$a.cohort, $b.cohort] | keys_of) | map({ key: ., from: ($a.cohort[.] // null), to: ($b.cohort[.] // null) }),
          sends_delta: ([$a.sends, $b.sends] | keys_of) | map({ key: ., from: ($a.sends[.] // null), to: ($b.sends[.] // null) })
        }
      '
    else
      echo "(jq not installed — printing raw files)"
      echo ""
      echo "PRE: $PRE"
      cat "$PRE"
      echo ""
      echo "POST: $POST"
      cat "$POST"
    fi
    ;;
esac

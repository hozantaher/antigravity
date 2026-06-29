#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Learning loop — extract operator overrides from ai_suggestion_audit
# ════════════════════════════════════════════════════════════════════════
#
# Per ADR-006 §D5 (self-learning loop přes prompt-tuning, ne fine-tune):
#   1. Operator overrides v UI insertují row do `ai_suggestion_audit`
#      s operator_action ∈ {edited, rejected} a final_output (NULL pro
#      rejected, jinak text actually sent).
#   2. Quarterly cadence: tento script vyextrahuje top-N override events
#      pro down-stream prompt tuning (build-few-shot.sh).
#
# Výstup: JSONL na stdout (1 row per override), schema:
#   {
#     "id":              <bigint>,
#     "thread_id":       <bigint or null>,
#     "ai_suggestion":   "<original AI návrh>",
#     "final_output":    "<operator's edit, or null when rejected>",
#     "operator_action": "edited|rejected",
#     "thread_context":  "<details->>'thread_context' or empty>",
#     "occurred_at":     "<ISO 8601 timestamp>"
#   }
#
# Použití:
#   DATABASE_URL=postgres://... \
#       scripts/learning/extract-overrides.sh \
#       --since "90 days" \
#       --limit 50 \
#       > overrides.jsonl
#
# Volby:
#   --since <interval>   Postgres interval (default: "90 days")
#   --limit <n>          Max rows (default: 50)
#   --include-approved   Také zahrnout approved rows (default: jen edited+rejected)
#   --dry-run            Ukáž SQL, ale nespouštěj
#
# Hard rules:
#   - Per memory rule feedback_no_speculation: filtruje výhradně dle
#     dokumentovaných operator_action hodnot (viz migration 020).
#   - Per memory rule feedback_no_external_services: žádný cloud upload —
#     výstup pouze na stdout, operator si ho stáhne lokálně.
#
# Exit codes:
#   0  ok (může být 0 rows pokud žádné overrides)
#   1  generic failure
#   2  required env var missing
#   3  invalid argument
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

SINCE="90 days"
LIMIT=50
INCLUDE_APPROVED=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --include-approved) INCLUDE_APPROVED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,45p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 3
      ;;
  esac
done

# Validate --limit is a positive integer.
if ! [[ "$LIMIT" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --limit must be a positive integer (got: $LIMIT)" >&2
  exit 3
fi

# Build action filter. Per migration 020 the column allows
# {pending, approved, edited, rejected}; pending rows are unreviewed
# drafts and never count as overrides.
if [[ "$INCLUDE_APPROVED" == "1" ]]; then
  ACTION_FILTER="operator_action IN ('approved','edited','rejected')"
else
  ACTION_FILTER="operator_action IN ('edited','rejected')"
fi

# SQL: emit one JSON object per row. We use jsonb_build_object so the
# output is well-formed and stdout can be piped straight into jq.
read -r -d '' SQL <<SQL || true
SELECT jsonb_build_object(
    'id',              id,
    'thread_id',       thread_id,
    'ai_suggestion',   ai_suggestion,
    'final_output',    final_output,
    'operator_action', operator_action,
    'thread_context',  COALESCE(details->>'thread_context', ''),
    'occurred_at',     to_char(occurred_at AT TIME ZONE 'UTC',
                               'YYYY-MM-DD"T"HH24:MI:SS"Z"')
)::text
FROM ai_suggestion_audit
WHERE ${ACTION_FILTER}
  AND occurred_at >= now() - interval '${SINCE}'
ORDER BY occurred_at DESC
LIMIT ${LIMIT};
SQL

if [[ "$DRY_RUN" == "1" ]]; then
  echo "── DRY-RUN — would execute:"
  echo "$SQL"
  exit 0
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set" >&2
  exit 2
fi

# psql -A -t = unaligned, tuples-only → one row per line, no header.
# -X = ignore .psqlrc so output is reproducible.
psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$SQL"

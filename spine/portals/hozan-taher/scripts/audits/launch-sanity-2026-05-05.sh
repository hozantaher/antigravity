#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# launch-sanity-2026-05-05.sh — pre-launch sanity sweep for MVP campaign 1
# ════════════════════════════════════════════════════════════════════════
#
# Run BEFORE 07:00 launch on 2026-05-05. Verifies every component the
# launch depends on. Exit 0 = ready to launch. Exit 1 = at least one
# blocker. Exit code matches `scripts/deploy/preflight.sh` convention.
#
# 13 checks across 5 axes:
#
#   1. Mailbox state (3 checks)    — active count, password presence, circuits
#   2. Campaign 1 state (3 checks) — paused, sequence config, enrollment
#   3. Templates (2 checks)        — disk presence, GDPR footer
#   4. Suppression + contacts (2)  — counts, contact pool
#   5. Relay state (3 checks)      — queue, pool, recent SMTP fails
#
# HARD RULE feedback_no_pii_in_commands: credentials sourced only from
# env, mailbox addresses redacted as mb1@<redacted> in stdout.
#
# Usage:
#
#   scripts/audits/launch-sanity-2026-05-05.sh             # exit 1 if any check fails
#   scripts/audits/launch-sanity-2026-05-05.sh --verbose   # full SQL output
#   scripts/audits/launch-sanity-2026-05-05.sh --json      # machine-readable
#
# Required env (from features/platform/outreach-dashboard/.env or operator export):
#   DATABASE_URL
#   ANTI_TRACE_RELAY_URL
#   ANTI_TRACE_RELAY_TOKEN

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Load env from .env if not in shell
if [[ -z "${DATABASE_URL:-}" ]] && [[ -f "${REPO_ROOT}/features/platform/outreach-dashboard/.env" ]]; then
  set -a
  source "${REPO_ROOT}/features/platform/outreach-dashboard/.env"
  set +a
fi

VERBOSE=0
JSON_MODE=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --json)       JSON_MODE=1 ;;
    --help|-h)    grep '^# ' "$0" | sed 's/^# //'; exit 0 ;;
  esac
done

: "${DATABASE_URL:?missing DATABASE_URL}"
: "${ANTI_TRACE_RELAY_URL:?missing ANTI_TRACE_RELAY_URL}"
: "${ANTI_TRACE_RELAY_TOKEN:?missing ANTI_TRACE_RELAY_TOKEN}"

declare -a RESULTS=()
declare -a BLOCKERS=()

# Helper: record check result
# args: name, status (PASS/FAIL/WARN), detail
record() {
  local name="$1"
  local status="$2"
  local detail="$3"
  RESULTS+=("$name|$status|$detail")
  if [[ "$status" == "FAIL" ]]; then
    BLOCKERS+=("$name: $detail")
  fi
}

# ────────────────────────────────────────────────────────────────────────
# Axis 1 — Mailbox state (3 checks)
# ────────────────────────────────────────────────────────────────────────

# Check 1.1 — active mailbox count ≥4
COUNT=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM outreach_mailboxes WHERE status='active';")
if [[ "$COUNT" -ge 4 ]]; then
  record "1.1 active mailboxes" "PASS" "$COUNT active (≥4 required)"
else
  record "1.1 active mailboxes" "FAIL" "only $COUNT active (need ≥4)"
fi

# Check 1.2 — all active mailboxes have non-empty password
NO_PWD=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM outreach_mailboxes WHERE status='active' AND length(password)=0;")
if [[ "$NO_PWD" == "0" ]]; then
  record "1.2 mailbox passwords" "PASS" "0 active mailboxes missing password"
else
  record "1.2 mailbox passwords" "FAIL" "$NO_PWD active mailboxes have empty password"
fi

# Check 1.3 — no open circuits
OPEN_CIRCUITS=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM outreach_mailboxes WHERE status='active' AND circuit_opened_at IS NOT NULL;")
if [[ "$OPEN_CIRCUITS" == "0" ]]; then
  record "1.3 mailbox circuits" "PASS" "0 open circuits on active mailboxes"
else
  record "1.3 mailbox circuits" "FAIL" "$OPEN_CIRCUITS active mailboxes have open circuit_opened_at"
fi

# ────────────────────────────────────────────────────────────────────────
# Axis 2 — Campaign 1 state (3 checks)
# ────────────────────────────────────────────────────────────────────────

# Check 2.1 — campaign 1 exists + status='paused'
CAMP_STATUS=$(psql "$DATABASE_URL" -At -c "SELECT status FROM campaigns WHERE id=1;" || echo "MISSING")
if [[ "$CAMP_STATUS" == "paused" ]]; then
  record "2.1 campaign 1 status" "PASS" "campaign 1 status='paused' (correct pre-launch)"
elif [[ "$CAMP_STATUS" == "active" ]]; then
  record "2.1 campaign 1 status" "WARN" "campaign 1 already 'active' — already launched?"
else
  record "2.1 campaign 1 status" "FAIL" "campaign 1 status='$CAMP_STATUS' (expected 'paused')"
fi

# Check 2.2 — sequence_config has 3 steps with valid template names
SEQ=$(psql "$DATABASE_URL" -At -c "SELECT jsonb_array_length(sequence_config) FROM campaigns WHERE id=1;" || echo "0")
if [[ "$SEQ" -ge 3 ]]; then
  record "2.2 sequence config" "PASS" "$SEQ sequence steps configured"
else
  record "2.2 sequence config" "FAIL" "only $SEQ sequence steps (expected ≥3)"
fi

# Check 2.3 — enrolled contacts ≥100
ENROLLED=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM campaign_contacts WHERE campaign_id=1 AND status IN ('pending','in_sequence');")
if [[ "$ENROLLED" -ge 100 ]]; then
  record "2.3 contact enrollment" "PASS" "$ENROLLED contacts enrolled (≥100 required for MVP)"
else
  record "2.3 contact enrollment" "FAIL" "only $ENROLLED contacts enrolled (need ≥100)"
fi

# ────────────────────────────────────────────────────────────────────────
# Axis 3 — Templates (2 checks)
# ────────────────────────────────────────────────────────────────────────

# Check 3.1 — sequence-referenced templates exist on disk
TPL_NAMES=$(psql "$DATABASE_URL" -At -c "SELECT string_agg(elem->>'template', ' ') FROM campaigns, jsonb_array_elements(sequence_config) AS elem WHERE id=1;")
MISSING_TPL=""
for tpl in $TPL_NAMES; do
  if [[ ! -f "${REPO_ROOT}/modules/outreach/configs/templates/${tpl}.tmpl" ]]; then
    MISSING_TPL+="${tpl} "
  fi
done
if [[ -z "$MISSING_TPL" ]]; then
  record "3.1 template files" "PASS" "all sequence templates present in modules/outreach/configs/templates/"
else
  record "3.1 template files" "FAIL" "missing on disk: ${MISSING_TPL}"
fi

# Check 3.2 — initial template has GDPR footer
INTRO_TPL="${REPO_ROOT}/modules/outreach/configs/templates/intro_machinery.tmpl"
if [[ -f "$INTRO_TPL" ]] && grep -q "{{.UnsubURL}}" "$INTRO_TPL" && grep -q "Garaaage" "$INTRO_TPL" && grep -q "IČO 23219700" "$INTRO_TPL"; then
  record "3.2 GDPR footer" "PASS" "intro_machinery.tmpl contains UnsubURL + Garaaage + IČO 23219700"
else
  record "3.2 GDPR footer" "FAIL" "intro_machinery.tmpl missing UnsubURL or Garaaage identity"
fi

# Check 3.3 — Day 1 eligible cohort count (mirrors runner.go:160 query).
# Pending audit 2026-05-04: 7 contacts at step 0 / pending / next_send_at
# NULL — eligible immediately. 193 at step 2 / in_sequence with
# next_send_at IN FUTURE — waiting for follow-up cadence, not eligible
# Day 1. Operator should confirm 7-envelope Day 1 cohort is intentional
# (it implies most of the 200 enrolled contacts received intro + first
# follow-up in earlier test runs and are now mid-sequence).
DAY1_COHORT=$(psql "$DATABASE_URL" -At -c "
SELECT count(*)
FROM campaign_contacts cc
JOIN contacts c ON c.id = cc.contact_id
WHERE cc.campaign_id = 1
  AND cc.status IN ('pending', 'in_sequence')
  AND (cc.next_send_at IS NULL OR cc.next_send_at <= now())
  AND c.status NOT IN ('bounced','blacklisted','invalid','unsubscribed','opted_out','human_handoff','paused_human','completed_no_reply','retention_expired');
")
if [[ "$DAY1_COHORT" -ge 50 ]]; then
  record "3.3 Day 1 cohort" "PASS" "$DAY1_COHORT contacts eligible for Day 1 send (≥50)"
elif [[ "$DAY1_COHORT" -ge 1 ]]; then
  record "3.3 Day 1 cohort" "WARN" "only $DAY1_COHORT contacts eligible Day 1 — confirm intentional vs broken cohort filter"
else
  record "3.3 Day 1 cohort" "FAIL" "0 contacts eligible Day 1 — runner will idle"
fi

# ────────────────────────────────────────────────────────────────────────
# Axis 4 — Suppression + contacts (2 checks)
# ────────────────────────────────────────────────────────────────────────

# Check 4.1 — suppression tables present + non-zero
SUP_COUNT=$(psql "$DATABASE_URL" -At -c "SELECT (SELECT count(*) FROM outreach_suppressions) + (SELECT count(*) FROM suppression_list);")
if [[ "$SUP_COUNT" -ge 1 ]]; then
  record "4.1 suppression tables" "PASS" "$SUP_COUNT total suppression entries"
else
  record "4.1 suppression tables" "WARN" "0 suppression entries — first launch may be OK"
fi

# Check 4.2 — contact pool non-empty
CONTACT_COUNT=$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM contacts WHERE status='valid' AND email IS NOT NULL;")
if [[ "$CONTACT_COUNT" -ge 100 ]]; then
  record "4.2 contact pool" "PASS" "$CONTACT_COUNT contacts available for enrollment"
else
  record "4.2 contact pool" "FAIL" "only $CONTACT_COUNT valid contacts"
fi

# ────────────────────────────────────────────────────────────────────────
# Axis 5 — Relay state (3 checks)
# ────────────────────────────────────────────────────────────────────────

# Check 5.1 — relay reachable + not behind
RELAY_STATUS=$(curl -sS --max-time 10 "${ANTI_TRACE_RELAY_URL}/v1/status" \
  -H "Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN}" 2>/dev/null || echo '{"queue_depth":-1}')
QUEUE=$(echo "$RELAY_STATUS" | jq -r '.queue_depth // -1')
if [[ "$QUEUE" == "-1" ]]; then
  record "5.1 relay reachable" "FAIL" "relay HTTP error or unreachable"
elif [[ "$QUEUE" -le 5 ]]; then
  record "5.1 relay reachable" "PASS" "relay queue_depth=$QUEUE (drained or near-empty)"
else
  record "5.1 relay reachable" "WARN" "relay queue_depth=$QUEUE — drain backlog"
fi

# Check 5.2 — Mullvad pool has ≥1 active endpoint AND none silently failing
# (`active_endpoints` counts non-quarantined, but the pool quarantine threshold
# can let a broken endpoint stay "active" while consecutive_fail keeps
# resetting between snapshot windows. Need per-endpoint fail audit too.)
POOL=$(curl -sS --max-time 10 "${ANTI_TRACE_RELAY_URL}/v1/proxy-pool" \
  -H "Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN}" 2>/dev/null || echo '{"active_endpoints":0,"endpoints":[]}')
ACTIVE=$(echo "$POOL" | jq -r '.active_endpoints // 0')
SIZE=$(echo "$POOL" | jq -r '.pool_size // 0')
# Endpoint with ok_count=0 AND fail_count>5 = effectively dead even if quarantined=false.
DEAD_LABELS=$(echo "$POOL" | jq -r '.endpoints[]? | select((.ok_count // 0) == 0 and (.fail_count // 0) > 5) | .label' | tr '\n' ',' | sed 's/,$//')
if [[ "$ACTIVE" -lt 1 ]]; then
  record "5.2 Mullvad pool" "FAIL" "0 active endpoints — no egress path"
elif [[ -n "$DEAD_LABELS" ]]; then
  record "5.2 Mullvad pool" "WARN" "$ACTIVE/$SIZE active but [$DEAD_LABELS] silently failing (ok=0, fail>5) — Phase 1.3 restart"
elif [[ "$ACTIVE" == "$SIZE" ]]; then
  record "5.2 Mullvad pool" "PASS" "$ACTIVE/$SIZE endpoints active + none silently failing"
else
  record "5.2 Mullvad pool" "WARN" "$ACTIVE/$SIZE active (some quarantined — degraded)"
fi

# Check 5.3 — recent send_events have low fail rate
RECENT_FAIL_RATE=$(psql "$DATABASE_URL" -At -c "
SELECT COALESCE(
  ROUND(100.0 * count(*) FILTER (WHERE status IN ('bounced','failed')) / NULLIF(count(*), 0)),
  0
) FROM send_events WHERE sent_at > now() - interval '6 hours';
")
if [[ "$RECENT_FAIL_RATE" -le 20 ]]; then
  record "5.3 recent fail rate" "PASS" "${RECENT_FAIL_RATE}% in last 6h (≤20% acceptable)"
else
  record "5.3 recent fail rate" "WARN" "${RECENT_FAIL_RATE}% fail rate in last 6h — investigate"
fi

# ────────────────────────────────────────────────────────────────────────
# Output
# ────────────────────────────────────────────────────────────────────────

if [[ "$JSON_MODE" -eq 1 ]]; then
  printf '{"checks":['
  first=1
  for r in "${RESULTS[@]}"; do
    [[ "$first" -eq 0 ]] && printf ','
    first=0
    IFS='|' read -r name status detail <<< "$r"
    printf '{"name":"%s","status":"%s","detail":"%s"}' "$name" "$status" "$(echo "$detail" | sed 's/"/\\"/g')"
  done
  printf '],"blockers":%d,"ok":%s}\n' "${#BLOCKERS[@]}" "$([[ ${#BLOCKERS[@]} -eq 0 ]] && echo true || echo false)"
else
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo "  Launch sanity sweep — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "═══════════════════════════════════════════════════════════════════"
  printf "%-30s | %-6s | %s\n" "Check" "Status" "Detail"
  echo "─────────────────────────────────┴────────┴────────────────────────"
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r name status detail <<< "$r"
    printf "%-30s | %-6s | %s\n" "$name" "$status" "$detail"
  done
  echo "═══════════════════════════════════════════════════════════════════"
  echo ""
  if [[ ${#BLOCKERS[@]} -eq 0 ]]; then
    echo "✓ ALL CHECKS PASS — ready for 07:00 launch"
    echo ""
    echo "Next: docs/playbooks/MVP-LAUNCH-2026-05-05.md Phase 3 (06:00–07:00)"
  else
    echo "✗ ${#BLOCKERS[@]} BLOCKER(S) — DO NOT LAUNCH"
    echo ""
    for b in "${BLOCKERS[@]}"; do
      echo "  · $b"
    done
    echo ""
    echo "Resolve blockers, then re-run this script."
    exit 1
  fi
fi

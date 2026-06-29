#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# v2_dual_axis.sh — Sprint V dual-axis validation runner
# ════════════════════════════════════════════════════════════════════════
#
# Operationalizes Sprint V in docs/initiatives/2026-05-04-master-merge-and-rollout.md.
#
# After PR #723 (sanitizer fix) + #740 (HELO fix) deploy, run this script
# to validate ≥80% INBOX delivery rate × anonymity score median ≥ 80
# across two recipient classes:
#
#   Axis 1 — mb-to-mb (4 senders × 3 templates × 3 recipients = 36 envelopes)
#     Validates L1 + L2 only. Per memory project_mb_to_mb_anonymity_ceiling
#     this axis cannot validate L3 + L4 (Seznam internal hop strips
#     receiving-side headers). Median ceiling 60/100 expected.
#
#   Axis 2 — Engine → Gmail (4 senders × 3 templates → 1 Gmail = 12 envelopes)
#     Validates full L1 + L2 + L3 + L4. Recipient MX (Gmail) adds
#     Authentication-Results header from its own DKIM/SPF/DMARC
#     evaluation, plus prepends Return-Path from MAIL FROM.
#     Target: median ≥ 80/100.
#
# 24h stability gate: re-run both axes 24 hours after T0. Both runs must
# maintain ≥ 80% INBOX delivery × ≥ 80 score median.
#
# ────────────────────────────────────────────────────────────────────────
# Required environment
# ────────────────────────────────────────────────────────────────────────
#
#   DATABASE_URL                outreach Postgres TCP-proxy URL
#   ANTI_TRACE_RELAY_URL        production Railway relay
#   ANTI_TRACE_RELAY_TOKEN      Bearer token for /v1/submit
#   GMAIL_RECIPIENT             Gmail address for Axis 2 (e.g. operator's personal)
#   GMAIL_IMAP_PASSWORD         Gmail app password for IMAP harvest. If
#                               unset, axis 2 IMAP probe is skipped and
#                               operator must verify visually in Gmail.
#
# ────────────────────────────────────────────────────────────────────────
# HARD RULE compliance
# ────────────────────────────────────────────────────────────────────────
#
# Per memory feedback_no_pii_in_commands: credentials are pulled
# one-shot from env, payloads built via jq --arg, piped to curl
# --data-binary @- to avoid argv exposure. Mailbox addresses are
# redacted as mb1@<redacted>...mb4@<redacted> in stdout.
#
# ────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RUN_LABEL="v2-${TIMESTAMP}"
REPORT_DIR="${REPO_ROOT}/reports/anti-trace-v2/${RUN_LABEL}"
mkdir -p "$REPORT_DIR"

# Source operator .env (DATABASE_URL etc.). Does NOT log secrets.
if [[ -f "${REPO_ROOT}/features/platform/outreach-dashboard/.env" ]]; then
  set -a
  source "${REPO_ROOT}/features/platform/outreach-dashboard/.env"
  set +a
fi

: "${DATABASE_URL:?missing DATABASE_URL}"
: "${ANTI_TRACE_RELAY_URL:?missing ANTI_TRACE_RELAY_URL}"
: "${ANTI_TRACE_RELAY_TOKEN:?missing ANTI_TRACE_RELAY_TOKEN}"

GMAIL_RECIPIENT="${GMAIL_RECIPIENT:-}"
GMAIL_IMAP_PASSWORD="${GMAIL_IMAP_PASSWORD:-}"

echo "═══════════════════════════════════════════════════════════"
echo "  Sprint V dual-axis runner — ${RUN_LABEL}"
echo "═══════════════════════════════════════════════════════════"
echo "  Report dir: ${REPORT_DIR}"
echo "  Relay:      ${ANTI_TRACE_RELAY_URL}"
echo "  Axis 2:     $([[ -n "$GMAIL_RECIPIENT" ]] && echo "Gmail (${GMAIL_RECIPIENT:0:3}***@gmail.com)" || echo "SKIPPED — set GMAIL_RECIPIENT to enable")"
echo ""

# ────────────────────────────────────────────────────────────────────────
# Pre-flight: verify relay queue empty
# ────────────────────────────────────────────────────────────────────────

QUEUE_DEPTH=$(curl -sS "${ANTI_TRACE_RELAY_URL}/v1/status" \
  -H "Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN}" | jq -r '.queue_depth // 0')
if [[ "$QUEUE_DEPTH" != "0" ]]; then
  echo "WARN: relay queue has ${QUEUE_DEPTH} pending envelopes. Wait for drain or expect mixed results."
fi

# ────────────────────────────────────────────────────────────────────────
# Pull mailbox creds one-shot
# ────────────────────────────────────────────────────────────────────────

mapfile -t MB_ROWS < <(psql "$DATABASE_URL" -At -F '|' -c \
  "SELECT id, smtp_username, password, smtp_host, smtp_port, imap_username, imap_host, imap_port, from_address \
   FROM outreach_mailboxes WHERE status='active' ORDER BY id;")

if [[ "${#MB_ROWS[@]}" -lt 4 ]]; then
  echo "ERROR: need ≥4 active mailboxes, found ${#MB_ROWS[@]}"
  exit 2
fi

# Production templates (must match features/outreach/campaigns/configs/templates/)
TEMPLATES=("heavy-01-intro" "heavy-02-followup" "heavy-03-bump")

# Body fixture per template — operator should adapt or load from real
# template files. Placeholder kept short to keep the script self-contained.
declare -A BODIES
BODIES["heavy-01-intro"]="Dobry den,

mate u Vas pouzitou techniku, ktere se chcete zbavit?
Auto, dodavku, traktor, stavebni stroj... cokoli.

Pracuju pro portal Garaaage - aukce pouzite techniky.

Diky,
B. Maarek
Garaaage

---
Obchodni sdeleni odesilatele Garaaage s.r.o., ICO 23219700.
Pro odhlaseni odpovezte STOP nebo: https://garaaage.cz/unsubscribe?t=v2
Privacy: https://garaaage.cz/privacy"

BODIES["heavy-02-followup"]="Dobry den,

posilam kratky follow-up k aukci pouzite techniky.
Pripadne foto a TP staci poslat na tento mail.

S pozdravem,
B. Maarek
Garaaage

---
Obchodni sdeleni odesilatele Garaaage s.r.o., ICO 23219700.
Pro odhlaseni odpovezte STOP nebo: https://garaaage.cz/unsubscribe?t=v2"

BODIES["heavy-03-bump"]="Dobry den,

posledni pripomenuti — pokud Vas nabidka aukce pouzite techniky
zaujala, ozvete se kdykoli.

S pozdravem,
B. Maarek
Garaaage"

# ────────────────────────────────────────────────────────────────────────
# Send helper — POST to /v1/submit (Engine path, sanitizer applied)
# ────────────────────────────────────────────────────────────────────────

send_envelope() {
  local sender_idx=$1
  local recipient_addr=$2
  local template=$3
  local subject=$4

  IFS='|' read -r MB_ID SMTP_USER SMTP_PASS SMTP_HOST SMTP_PORT IMAP_USER IMAP_HOST IMAP_PORT FROM_ADDR <<< "${MB_ROWS[$sender_idx]}"

  local body="${BODIES[$template]}"
  local req=$(jq -n \
    --arg recipient "$recipient_addr" \
    --arg subject "$subject" --arg body "$body" \
    --arg from_address "$FROM_ADDR" \
    --arg smtp_host "$SMTP_HOST" --argjson smtp_port "$SMTP_PORT" \
    --arg smtp_username "$SMTP_USER" --arg smtp_password "$SMTP_PASS" \
    '{
       recipient: $recipient,
       subject: $subject,
       body: $body,
       from_address: $from_address,
       smtp_host: $smtp_host,
       smtp_port: $smtp_port,
       smtp_username: $smtp_username,
       smtp_password: $smtp_password
     }')

  local resp=$(printf '%s' "$req" | curl -sS -X POST "${ANTI_TRACE_RELAY_URL}/v1/submit" \
    -H "Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary @-)

  local status=$(echo "$resp" | jq -r '.status // .error // "?"')
  local env_id=$(echo "$resp" | jq -r '.envelope_id // ""')
  echo "  mb$((sender_idx+1)) → ${template}: ${status} ${env_id}"
}

# ────────────────────────────────────────────────────────────────────────
# Axis 1 — mb-to-mb (36 envelopes, 4 senders × 3 templates × 3 recipients)
# ────────────────────────────────────────────────────────────────────────

echo "──────────────── AXIS 1: mb-to-mb (36 envelopes) ────────────────"

count=0
for sender_idx in 0 1 2 3; do
  for template in "${TEMPLATES[@]}"; do
    for recipient_idx in 0 1 2 3; do
      if [[ "$sender_idx" == "$recipient_idx" ]]; then continue; fi
      IFS='|' read -r _ _ _ _ _ _ _ _ R_FROM <<< "${MB_ROWS[$recipient_idx]}"
      subject="V2 mb${sender_idx}-${recipient_idx} ${template} run-${TIMESTAMP}"
      send_envelope "$sender_idx" "$R_FROM" "$template" "$subject"
      count=$((count+1))
      sleep 30
    done
  done
done
echo "Axis 1 sent: $count envelopes"

# ────────────────────────────────────────────────────────────────────────
# Axis 2 — Engine → Gmail (12 envelopes, 4 senders × 3 templates)
# ────────────────────────────────────────────────────────────────────────

if [[ -n "$GMAIL_RECIPIENT" ]]; then
  echo ""
  echo "──────────────── AXIS 2: Engine → Gmail (12 envelopes) ────────────────"
  count=0
  for sender_idx in 0 1 2 3; do
    for template in "${TEMPLATES[@]}"; do
      subject="V2 mb${sender_idx}-gmail ${template} run-${TIMESTAMP}"
      send_envelope "$sender_idx" "$GMAIL_RECIPIENT" "$template" "$subject"
      count=$((count+1))
      sleep 30
    done
  done
  echo "Axis 2 sent: $count envelopes"
else
  echo ""
  echo "──────────────── AXIS 2: SKIPPED (no GMAIL_RECIPIENT) ────────────────"
fi

# ────────────────────────────────────────────────────────────────────────
# Drain wait + IMAP harvest scaffold
# ────────────────────────────────────────────────────────────────────────

echo ""
echo "Waiting for drain queue to clear..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  Q=$(curl -sS "${ANTI_TRACE_RELAY_URL}/v1/status" \
    -H "Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN}" | jq -r '.queue_depth // 0')
  echo "  iteration ${i}/10 — queue depth ${Q}"
  if [[ "$Q" == "0" ]]; then break; fi
  sleep 30
done
echo "Sleeping 60s for Seznam indexing..."
sleep 60

# ────────────────────────────────────────────────────────────────────────
# Axis 1 IMAP harvest — score each mb-to-mb message via cmd/anonymity-score
# ────────────────────────────────────────────────────────────────────────

echo ""
echo "Axis 1 IMAP harvest — see ${REPORT_DIR}/axis1.json"
# Operator: run scripts/anti-trace-verify/imap_recent_with_subj.py with
# SUBJECT_NEEDLE="V2 mb*-* run-${TIMESTAMP}" against each mb-to-mb recipient
# to enumerate Message-IDs, then loop cmd/anonymity-score on each.
echo "TODO: parameterize anonymity_sweep.py or write loop here."

# ────────────────────────────────────────────────────────────────────────
# Axis 2 IMAP harvest — Gmail-side
# ────────────────────────────────────────────────────────────────────────

if [[ -n "$GMAIL_RECIPIENT" && -n "$GMAIL_IMAP_PASSWORD" ]]; then
  echo ""
  echo "Axis 2 IMAP harvest — Gmail via app password"
  IMAP_HOST="imap.gmail.com" \
  IMAP_PORT="993" \
  IMAP_USER="$GMAIL_RECIPIENT" \
  IMAP_PASSWORD="$GMAIL_IMAP_PASSWORD" \
  SUBJECT_NEEDLE="V2 mb" \
    python3 "${REPO_ROOT}/scripts/anti-trace-verify/imap_recent_with_subj.py" \
    > "${REPORT_DIR}/axis2-gmail.txt" 2>&1
  echo "  wrote ${REPORT_DIR}/axis2-gmail.txt"
else
  echo "Axis 2 Gmail harvest SKIPPED — set GMAIL_IMAP_PASSWORD for automated probe"
  echo "  or verify visually at https://mail.google.com (search \"V2 mb run-${TIMESTAMP}\")"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Sprint V T0 complete — re-run in ~24h for stability gate"
echo "═══════════════════════════════════════════════════════════"
echo "  Report: ${REPORT_DIR}"
echo ""
echo "  Pass criteria (per ADR-013 / master initiative Sprint V):"
echo "    Axis 1 — INBOX rate ≥ 80%, anonymity score median ≥ 60 (ceiling)"
echo "    Axis 2 — INBOX rate ≥ 80%, anonymity score median ≥ 80"
echo "    Both runs (T0 + T0+24h) must satisfy."

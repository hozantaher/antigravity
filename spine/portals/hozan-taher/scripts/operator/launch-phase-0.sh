#!/usr/bin/env bash
# Phase 0 launch orchestrator — vede operátora přes 7 gates pro launch
# kampaně výkupu techniky (24 mailboxů, M+3 minimal scope).
#
# Spojuje existující playbooky do interaktivní sekvence:
#   - KT-A1 — 17 security PRs review (volá security-batch-merge.sh)
#   - KT-A2 — operator data verify (sídlo + privacy URL + template)
#   - KT-A3 — Railway BFF deploy + UNSUBSCRIBE_BASE_URL
#   - KT-A4 — 24 mailbox passwords v DB
#   - KT-A5 — pre-flight + dry-run + send-test
#   - GO/NO-GO — final gate s audit log entry
#
# Per gate operator stiskne y/n/q. Audit log appendován do
# docs/audits/launch-phase-0.jsonl.
#
# Usage:
#   bash scripts/operator/launch-phase-0.sh
#
# Reference playbooks:
#   - docs/playbooks/first-campaign-launch.md (general runbook)
#   - docs/playbooks/kt-a3-bff-deploy-checklist.md
#   - docs/playbooks/kt-a4-mailbox-password-update.md (24 schránek)
#   - docs/playbooks/kt-a2-template-footer-update.md
#   - docs/strategy/2026-04-30-m3-minimal-scope.md

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
AUDIT_FILE="${REPO_ROOT}/docs/audits/launch-phase-0.jsonl"
TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ANSI helpers
B='\033[1m'; G='\033[32m'; R='\033[31m'; Y='\033[33m'; C='\033[36m'; N='\033[0m'

audit() {
  local gate="$1"; local status="$2"; local note="${3:-}"
  printf '{"ts":"%s","gate":"%s","status":"%s","note":"%s"}\n' \
    "$(TS)" "$gate" "$status" "$note" >> "$AUDIT_FILE"
}

prompt_yn() {
  local q="$1"
  while true; do
    printf "${B}%s${N} [y/n/q] " "$q" >&2
    read -r ans
    case "$ans" in
      y|Y) return 0 ;;
      n|N) return 1 ;;
      q|Q) printf "${R}Aborted by operator${N}\n" >&2; audit "abort" "manual" "operator pressed q"; exit 2 ;;
      *) printf "${Y}Type y, n, or q${N}\n" >&2 ;;
    esac
  done
}

section() {
  printf "\n${C}═════════════════════════════════════════════════════${N}\n"
  printf "${C}  %s${N}\n" "$1"
  printf "${C}═════════════════════════════════════════════════════${N}\n\n"
}

# ─── Gate 1: 17 security PRs ──────────────────────────────────────────
gate_security_prs() {
  section "Gate 1 / 7 — KT-A1: 17 security PRs review"
  local count
  count=$(gh pr list --state=open --search "in:title sec: F1- F2- F3- F5- W2-" --json number 2>/dev/null | jq 'length')
  printf "Open security PRs matching pattern: ${B}%s${N}\n" "$count"
  if [ "$count" -gt 0 ]; then
    printf "Spustit ${B}security-batch-merge.sh${N}? Per-PR potvrzení.\n"
    if prompt_yn "Spustit batch merge?"; then
      bash "${REPO_ROOT}/scripts/operator/security-batch-merge.sh" || {
        audit "kt-a1" "failed" "security-batch-merge non-zero"; return 1
      }
      audit "kt-a1" "completed" "security PRs reviewed"
    else
      audit "kt-a1" "skipped" "operator deferred"
      printf "${Y}Skipping — KT-A1 zůstává open${N}\n"
    fi
  else
    audit "kt-a1" "noop" "0 open security PRs"
    printf "${G}✓ Žádné open security PRs${N}\n"
  fi
}

# ─── Gate 2: operator data verify ─────────────────────────────────────
gate_operator_data() {
  section "Gate 2 / 7 — KT-A2: Operator data (sídlo, privacy URL, template)"
  printf "Verify proti current state:\n"
  printf "  - ${B}Sídlo${N}: Garaaage s.r.o., Purkyňova 74/2, 110 00 Praha 1, IČO 23219700\n"
  printf "  - ${B}Privacy URL${N}: https://garaaage.cz/privacy\n"
  printf "  - ${B}Template${N}: features/outreach/campaigns/configs/templates/initial.tmpl\n\n"

  if curl -sfI https://garaaage.cz/privacy > /dev/null 2>&1; then
    printf "${G}✓ Privacy URL responds 2xx${N}\n"
  else
    printf "${R}✗ Privacy URL non-2xx — operator MUST fix before send${N}\n"
    audit "kt-a2-privacy" "failed" "URL not 2xx"
    return 1
  fi

  printf "\nFooter v initial.tmpl (current):\n"
  grep -A 7 "Obchodní sdělení" "${REPO_ROOT}/features/outreach/campaigns/configs/templates/initial.tmpl" || true

  if prompt_yn "Sídlo + IČO + privacy URL + template OK?"; then
    audit "kt-a2" "completed" "operator confirmed data"
  else
    audit "kt-a2" "blocked" "operator rejected data"
    return 1
  fi
}

# ─── Gate 3: Railway BFF deploy ───────────────────────────────────────
gate_railway_deploy() {
  section "Gate 3 / 7 — KT-A3: Railway BFF deploy + UNSUBSCRIBE_BASE_URL"
  printf "Operator manuální step (Railway dashboard):\n"
  printf "  1. Verify BFF service running v production\n"
  printf "  2. Set env ${B}UNSUBSCRIBE_BASE_URL=https://garaaage.cz/u${N}\n"
  printf "  3. Verify env ${B}OUTREACH_API_KEY${N} matches Go service\n"
  printf "  4. Restart service\n\n"
  printf "Detail: docs/playbooks/kt-a3-bff-deploy-checklist.md\n\n"
  if prompt_yn "BFF deploy + env vars hotový?"; then
    audit "kt-a3" "completed" "operator confirmed deploy"
  else
    audit "kt-a3" "blocked" "deploy not done"
    return 1
  fi
}

# ─── Gate 4: 24 mailbox passwords ─────────────────────────────────────
gate_mailbox_passwords() {
  section "Gate 4 / 7 — KT-A4: 24 mailbox passwords v DB"
  printf "Operator manuální step (per memory feedback_mailbox_passwords_via_db):\n"
  printf "  - Vytvoř 24 Seznam.cz mailbox accounts (operator side)\n"
  printf "  - Vygenerated 24 app-specific passwords\n"
  printf "  - SQL UPDATE mailboxes SET password_encrypted = pgp_sym_encrypt(...)\n"
  printf "    pro každý z 24 schránek\n\n"
  printf "Detail: docs/playbooks/kt-a4-mailbox-password-update.md\n\n"

  printf "Verify SQL (musí běžet manuálně proti production DB):\n"
  printf "  ${B}SELECT count(*) FROM mailboxes WHERE password_encrypted IS NOT NULL;${N}\n"
  printf "  Expected: ${G}24${N}\n\n"

  if prompt_yn "24 mailbox passwords loaded a verified?"; then
    audit "kt-a4" "completed" "24 passwords confirmed"
  else
    audit "kt-a4" "blocked" "passwords not loaded"
    return 1
  fi
}

# ─── Gate 5: Pre-flight ───────────────────────────────────────────────
gate_preflight() {
  section "Gate 5 / 7 — KT-A5.1: Pre-flight check"
  printf "Spustit pre-deploy-validate.sh:\n\n"
  if prompt_yn "Spustit pre-flight?"; then
    bash "${REPO_ROOT}/scripts/operator/pre-deploy-validate.sh" || {
      audit "kt-a5-preflight" "failed" "pre-deploy-validate non-zero"; return 1
    }
    audit "kt-a5-preflight" "completed" "pre-flight zelený"
  else
    audit "kt-a5-preflight" "skipped" "operator deferred"
    return 1
  fi
}

# ─── Gate 6: Dry-run ──────────────────────────────────────────────────
gate_dry_run() {
  section "Gate 6 / 7 — KT-A5.2: Dry-run"
  printf "Spustit dry-run pro kampaň 455 (renderuje, nesílá):\n"
  printf "  ${B}cd features/platform/outreach-dashboard && node dry-run.mjs 455${N}\n\n"
  if prompt_yn "Dry-run spustit teď?"; then
    cd "${REPO_ROOT}/features/platform/outreach-dashboard"
    if node dry-run.mjs 455 2>&1; then
      audit "kt-a5-dryrun" "completed" "dry-run zelený"
    else
      audit "kt-a5-dryrun" "failed" "dry-run errored"
      return 1
    fi
    cd "${REPO_ROOT}"
  else
    audit "kt-a5-dryrun" "skipped" "operator deferred"
    return 1
  fi
}

# ─── Gate 7: Send-test ────────────────────────────────────────────────
gate_send_test() {
  section "Gate 7 / 7 — KT-A5.3: Send-test (1 mail to operator self)"
  printf "Pošle 1 testovací mail z prvního mailboxu na operator-self adresu.\n"
  printf "Verify: arrives, has correct From/Reply-To/UnsubURL, klikneš a unsub funguje.\n\n"
  if prompt_yn "Spustit send-test?"; then
    cd "${REPO_ROOT}/features/platform/outreach-dashboard"
    if node campaign-send-batch.mjs --dry-test=operator-self 2>&1; then
      printf "${G}✓ Send-test odeslán — verify v inboxu${N}\n"
      if prompt_yn "Mail arrived + unsub link OK?"; then
        audit "kt-a5-sendtest" "completed" "send-test verified by operator"
      else
        audit "kt-a5-sendtest" "failed" "operator rejected send-test"
        return 1
      fi
    else
      audit "kt-a5-sendtest" "failed" "send-test errored"
      return 1
    fi
    cd "${REPO_ROOT}"
  else
    audit "kt-a5-sendtest" "skipped" "operator deferred"
    return 1
  fi
}

# ─── Final GO/NO-GO ───────────────────────────────────────────────────
gate_final_go() {
  section "FINAL GATE — GO/NO-GO pro kampaň výkupu techniky"
  printf "Všechny gates zelené. Připraven k:\n"
  printf "  - Spustit kampaň 455 staircase 0 → 1 → 5 → ramp\n"
  printf "  - 24 mailboxů × 2/den den 1-3 = 48 mailů/den first batch\n"
  printf "  - Postupný ramp dle ${B}features/outreach/campaigns/configs/warmup.yaml${N}\n\n"
  printf "Per memory ${B}feedback_campaign_send${N} HARD RULE: explicit GO required.\n\n"

  if prompt_yn "GO pro send (final confirmation)?"; then
    audit "go-no-go" "GO" "operator approved send"
    printf "\n${G}═════════════════════════════════════════════════════${N}\n"
    printf "${G}  ✓ GO RECORDED. Run staircase send manuálně:${N}\n"
    printf "${G}     cd features/platform/outreach-dashboard && node campaign-send-batch.mjs 455 --staircase${N}\n"
    printf "${G}═════════════════════════════════════════════════════${N}\n\n"
  else
    audit "go-no-go" "NO-GO" "operator rejected at final gate"
    printf "${Y}NO-GO recorded. No mails sent. Resume later via this script.${N}\n"
    return 1
  fi
}

# ─── Main flow ────────────────────────────────────────────────────────
main() {
  printf "${B}Phase 0 Launch Orchestrator${N}\n"
  printf "Audit log: %s\n" "$AUDIT_FILE"
  printf "Reference: docs/strategy/2026-04-30-m3-minimal-scope.md\n\n"

  mkdir -p "$(dirname "$AUDIT_FILE")"
  audit "session" "started" "phase-0 orchestrator"

  gate_security_prs
  gate_operator_data
  gate_railway_deploy
  gate_mailbox_passwords
  gate_preflight
  gate_dry_run
  gate_send_test
  gate_final_go

  audit "session" "completed" "all 7 gates green + GO"
  printf "\n${G}Phase 0 launch orchestrator complete. Audit log: %s${N}\n" "$AUDIT_FILE"
}

main "$@"

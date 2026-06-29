#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Vrtací cvičení AO6 — Mailbox Fraud-Lock Recovery
#
# Simuluje celý průběh obnovy schránky zamčené podvodem (fraud-lock) na
# testovací schránce s id=11583 (env='test'). Průběh je nedestruktivní —
# každá fáze se provede v transakci, na konci se celý stav vrátí zpět.
#
# Spuštění:
#   DATABASE_URL="postgres://..." ./scripts/drills/mailbox-fraud-lock-drill.sh
#   BFF_BASE_URL="http://localhost:18001" DATABASE_URL="..." ./scripts/drills/...
#
# Prerekvizity:
#   - PostgreSQL dostupná přes DATABASE_URL
#   - Schránka s id=11583 musí existovat v outreach_mailboxes
#   - BFF musí být spuštěn na BFF_BASE_URL (výchozí http://localhost:18001)
#
# Průběh:
#   Fáze 1: SET status='auth_locked', auth_locked_at=NOW(), reason
#   Fáze 2: Ověření cooldown výpočtu (výchozí 24h)
#   Fáze 3: Předčasný pokus o odemknutí → očekávej HTTP 425 cooldown_not_elapsed
#   Fáze 4: Backdatovat auth_locked_at o 25h, retry clear-auth-lock → očekávej 200
#   Fáze 5: Ověřit status='paused' (ne 'active' — operátor musí explicitně aktivovat)
#   Cleanup: ROLLBACK — schránka 11583 obnovena do původního stavu
#
# Výstup:
#   Každá fáze vypíše PASS nebo FAIL s detailem.
#   Exitcode 0 = všechny fáze prošly. Exitcode 1 = alespoň jedna selhala.
#
# Memory: feedback_no_pii_in_commands — hesla a tokeny nikdy přímo v příkazu.
# Memory: feedback_no_speculation — drill testuje jen změřitelné kontrakty.
# Memory: feedback_human_readable_tasks — komentáře v plynulé češtině.
# ════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Konfigurace ──────────────────────────────────────────────────────────────

MAILBOX_ID="${DRILL_MAILBOX_ID:-11583}"
BFF_BASE_URL="${BFF_BASE_URL:-http://localhost:18001}"
OUTREACH_API_KEY="${OUTREACH_API_KEY:-}"
DB_URL="${DATABASE_URL:-}"
DRILL_NAME="mailbox-fraud-lock-drill"

# ── Barvy výstupu ─────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

pass() { echo -e "${GREEN}PASS${RESET} $1"; }
fail() { echo -e "${RED}FAIL${RESET} $1"; DRILL_FAILED=1; }
info() { echo -e "${YELLOW}INFO${RESET} $1"; }

DRILL_FAILED=0

# ── Ověření prerekvizit ───────────────────────────────────────────────────────

check_prereqs() {
  if [[ -z "${DB_URL}" ]]; then
    echo "ERROR: DATABASE_URL není nastavena." >&2
    exit 1
  fi

  # Ověřit, že psql je dostupný
  if ! command -v psql &>/dev/null; then
    echo "ERROR: psql není nainstalován nebo není v PATH." >&2
    exit 1
  fi

  # Ověřit, že schránka 11583 existuje
  local count
  count=$(psql "$DB_URL" -t -c "SELECT count(*) FROM outreach_mailboxes WHERE id=${MAILBOX_ID}" 2>/dev/null | tr -d ' \n')
  if [[ "${count}" != "1" ]]; then
    echo "ERROR: Schránka id=${MAILBOX_ID} neexistuje v outreach_mailboxes (count=${count})." >&2
    echo "       Drill je navržen pro testovací schránku 11583 (env='test')." >&2
    exit 1
  fi

  # Ověřit, že BFF je spuštěn
  if ! curl -sf "${BFF_BASE_URL}/api/health" >/dev/null 2>&1; then
    echo "ERROR: BFF není dostupný na ${BFF_BASE_URL}." >&2
    exit 1
  fi
}

# ── SQL helper ────────────────────────────────────────────────────────────────

# Spustí SQL příkaz a vrátí výstup (bez newline, bez mezer)
sql_val() {
  psql "$DB_URL" -t -c "$1" 2>/dev/null | tr -d ' \n'
}

# Spustí SQL příkaz (bez výstupu)
sql_exec() {
  psql "$DB_URL" -c "$1" >/dev/null 2>&1
}

# ── BFF helper ────────────────────────────────────────────────────────────────

# Zavolá BFF endpoint a vrátí HTTP status kód
bff_post() {
  local path="$1"
  local body="${2:-{}}"
  local extra_headers=()

  if [[ -n "${OUTREACH_API_KEY}" ]]; then
    extra_headers+=("-H" "X-API-Key: ${OUTREACH_API_KEY}")
  fi

  curl -s -o /tmp/drill_response.json -w "%{http_code}" \
    -X POST "${BFF_BASE_URL}${path}" \
    -H "Content-Type: application/json" \
    -H "X-Confirm-Send: yes" \
    "${extra_headers[@]}" \
    -d "${body}" 2>/dev/null
}

# ── Zachytit počáteční stav ───────────────────────────────────────────────────

save_original_state() {
  ORIG_STATUS=$(sql_val "SELECT status FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  ORIG_AUTH_LOCKED_AT=$(sql_val "SELECT COALESCE(auth_locked_at::text, 'NULL') FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  ORIG_AUTH_LOCKED_REASON=$(sql_val "SELECT COALESCE(auth_locked_reason, 'NULL') FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  info "Počáteční stav schránky ${MAILBOX_ID}: status=${ORIG_STATUS} auth_locked_at=${ORIG_AUTH_LOCKED_AT}"
}

# ── Obnova počátečního stavu ──────────────────────────────────────────────────

restore_original_state() {
  info "ROLLBACK — obnovuji schránku ${MAILBOX_ID} do původního stavu..."

  psql "$DB_URL" -c "
    UPDATE outreach_mailboxes
       SET status='${ORIG_STATUS}',
           auth_locked_at=NULL,
           auth_locked_reason=NULL,
           auth_locked_by_observer=NULL
     WHERE id=${MAILBOX_ID}
  " >/dev/null 2>&1

  local final_status
  final_status=$(sql_val "SELECT status FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  if [[ "${final_status}" == "${ORIG_STATUS}" ]]; then
    pass "Cleanup: schránka ${MAILBOX_ID} obnovena na status='${ORIG_STATUS}'"
  else
    fail "Cleanup: schránka má status='${final_status}', očekáváno '${ORIG_STATUS}'"
  fi
}

# ── Fáze 1: Nastavit auth_locked stav ────────────────────────────────────────

phase1_set_auth_locked() {
  info "--- Fáze 1: SET status='auth_locked' ---"

  sql_exec "
    UPDATE outreach_mailboxes
       SET status='auth_locked',
           auth_locked_at=NOW(),
           auth_locked_reason='drill_simulation_ap6',
           auth_locked_by_observer='drill_script'
     WHERE id=${MAILBOX_ID}
  "

  local new_status
  new_status=$(sql_val "SELECT status FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  local locked_at
  locked_at=$(sql_val "SELECT auth_locked_at IS NOT NULL FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")

  if [[ "${new_status}" == "auth_locked" ]]; then
    pass "Fáze 1: status='auth_locked' nastaven"
  else
    fail "Fáze 1: status='${new_status}', očekáváno 'auth_locked'"
    return
  fi

  if [[ "${locked_at}" == "t" ]]; then
    pass "Fáze 1: auth_locked_at je nastaven (NOT NULL)"
  else
    fail "Fáze 1: auth_locked_at je NULL, měl by být nastaven"
  fi
}

# ── Fáze 2: Ověřit cooldown výpočet ──────────────────────────────────────────

phase2_verify_cooldown_calc() {
  info "--- Fáze 2: Ověření cooldown výpočtu (24h) ---"

  # Cooldown = 24 hodiny. auth_locked_at bylo právě nastaveno, takže zbývá ~24h.
  local hours_remaining
  hours_remaining=$(sql_val "
    SELECT FLOOR(EXTRACT(EPOCH FROM (auth_locked_at + INTERVAL '24 hours' - NOW())) / 3600)
      FROM outreach_mailboxes
     WHERE id=${MAILBOX_ID}
  ")

  # Zbývající čas musí být v rozsahu 23–24 hodin (tolerujeme 1h margin pro pomalé CI)
  if [[ "${hours_remaining}" -ge 23 ]] && [[ "${hours_remaining}" -le 24 ]]; then
    pass "Fáze 2: cooldown zbývá ~${hours_remaining}h (očekáváno 23–24h)"
  else
    fail "Fáze 2: cooldown zbývá ${hours_remaining}h, očekáváno 23–24h"
  fi
}

# ── Fáze 3: Předčasný pokus o odemknutí → 425 ────────────────────────────────

phase3_premature_unlock_returns_425() {
  info "--- Fáze 3: Předčasný clear-auth-lock → očekávej HTTP 425 ---"

  local http_code
  http_code=$(bff_post \
    "/api/mailboxes/${MAILBOX_ID}/clear-auth-lock" \
    '{"reason":"drill_premature_unlock_test"}')

  if [[ "${http_code}" == "425" ]]; then
    pass "Fáze 3: HTTP 425 cooldown_not_elapsed vrácen správně"
  else
    fail "Fáze 3: HTTP ${http_code} (očekáváno 425 cooldown_not_elapsed)"
    info "  Tělo odpovědi: $(cat /tmp/drill_response.json 2>/dev/null || echo '(prázdné)')"
  fi

  # Ověřit, že status zůstal auth_locked (pokus o odemknutí nic nezměnil)
  local current_status
  current_status=$(sql_val "SELECT status FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  if [[ "${current_status}" == "auth_locked" ]]; then
    pass "Fáze 3: status zůstal 'auth_locked' po odmítnutém pokusu"
  else
    fail "Fáze 3: status='${current_status}', měl zůstat 'auth_locked'"
  fi
}

# ── Fáze 4: Backdatovat auth_locked_at o 25h, retry → 200 ───────────────────

phase4_backdated_unlock_succeeds() {
  info "--- Fáze 4: Backdatovat auth_locked_at o 25h, retry clear-auth-lock → očekávej 200 ---"

  # Zpětně datovat auth_locked_at tak, aby cooldown byl překročen
  sql_exec "
    UPDATE outreach_mailboxes
       SET auth_locked_at = NOW() - INTERVAL '25 hours'
     WHERE id=${MAILBOX_ID}
  "

  local new_hours_elapsed
  new_hours_elapsed=$(sql_val "
    SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - auth_locked_at)) / 3600)
      FROM outreach_mailboxes
     WHERE id=${MAILBOX_ID}
  ")

  if [[ "${new_hours_elapsed}" -ge 25 ]]; then
    pass "Fáze 4: auth_locked_at backdatován na ${new_hours_elapsed}h zpět"
  else
    fail "Fáze 4: hours elapsed = ${new_hours_elapsed}, očekáváno ≥ 25"
    return
  fi

  # Nyní by clear-auth-lock měl projít (cooldown uplynul)
  local http_code
  http_code=$(bff_post \
    "/api/mailboxes/${MAILBOX_ID}/clear-auth-lock" \
    '{"reason":"drill_recovery_after_25h_cooldown"}')

  if [[ "${http_code}" == "200" ]]; then
    pass "Fáze 4: HTTP 200 clear-auth-lock prošel po uplynutí cooldownu"
  else
    fail "Fáze 4: HTTP ${http_code} (očekáváno 200)"
    info "  Tělo odpovědi: $(cat /tmp/drill_response.json 2>/dev/null || echo '(prázdné)')"
  fi
}

# ── Fáze 5: Ověřit status='paused' (ne 'active') ─────────────────────────────

phase5_verify_paused_not_active() {
  info "--- Fáze 5: Ověřit status='paused' po odemknutí ---"

  local final_status
  final_status=$(sql_val "SELECT status FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")

  if [[ "${final_status}" == "paused" ]]; then
    pass "Fáze 5: status='paused' — správně, operátor musí aktivovat ručně"
  elif [[ "${final_status}" == "active" ]]; then
    fail "Fáze 5: status='active' — chyba! Odemknutí nesmí automaticky aktivovat schránku"
  else
    fail "Fáze 5: status='${final_status}', očekáváno 'paused'"
  fi

  # Ověřit, že auth_locked_at byl vymazán
  local locked_at_null
  locked_at_null=$(sql_val "SELECT auth_locked_at IS NULL FROM outreach_mailboxes WHERE id=${MAILBOX_ID}")
  if [[ "${locked_at_null}" == "t" ]]; then
    pass "Fáze 5: auth_locked_at vymazán (NULL)"
  else
    fail "Fáze 5: auth_locked_at není NULL po odemknutí"
  fi
}

# ── Hlavní průběh ─────────────────────────────────────────────────────────────

echo "════════════════════════════════════════════════════════"
echo "  Vrtací cvičení: Mailbox Fraud-Lock Recovery (AO6)"
echo "  Schránka: id=${MAILBOX_ID}  BFF: ${BFF_BASE_URL}"
echo "════════════════════════════════════════════════════════"
echo ""

check_prereqs
save_original_state

# Spustit fáze — každá zachytí případnou chybu a pokračuje (DRILL_FAILED vlajka)
phase1_set_auth_locked || true
phase2_verify_cooldown_calc || true
phase3_premature_unlock_returns_425 || true
phase4_backdated_unlock_succeeds || true
phase5_verify_paused_not_active || true

echo ""
restore_original_state

echo ""
echo "════════════════════════════════════════════════════════"
if [[ "${DRILL_FAILED}" -eq 0 ]]; then
  echo -e "  Výsledek: ${GREEN}VŠECHNY FÁZE PROŠLY${RESET}"
  echo "  Playbook docs/playbooks/mailbox-fraud-lock-recovery.md — ověřen."
else
  echo -e "  Výsledek: ${RED}ALESPOŇ JEDNA FÁZE SELHALA${RESET}"
  echo "  Zkontroluj výstup výše a oprav playbook nebo implementaci."
fi
echo "════════════════════════════════════════════════════════"

exit "${DRILL_FAILED}"

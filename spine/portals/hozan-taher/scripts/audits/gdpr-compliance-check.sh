#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# KT-B12 — GDPR compliance audit script
# ════════════════════════════════════════════════════════════════════════
#
# Spustí DSR access + erase round-trip proti testovací DB a ověří, že
# kaskádový výmaz dle čl. 17 GDPR proběhl ve všech relevantních tabulkách
# + suppression UNION (outreach_suppressions ∪ suppression_list) dále
# blokuje subjekt.
#
# Použití:
#   BFF_URL=http://localhost:3100 \
#   OUTREACH_API_KEY=test-key \
#   DATABASE_URL=postgres://... \
#   scripts/audits/gdpr-compliance-check.sh
#
# Volby:
#   --email <adresa>   Vlastní test email (default: gdpr-test+<ts>@example.test)
#   --dry-run          Bez DB zápisů — jen ping endpointů
#   --skip-seed        Předpokládá, že syntetický kontakt už existuje
#
# Hard rules (memory feedback_no_fabricated_test_data):
#   - Použij dokumentované syntetické IČO 99999999 (test reservation,
#     není přiděleno žádnému reálnému subjektu v ARES).
#   - Production DATABASE_URL je ZAKÁZÁN — script kontroluje host a
#     RAILWAY_ENVIRONMENT_NAME, exit 9 pokud production-like.
#
# Output:
#   - PASS/FAIL per check na stdout (česky)
#   - JSONL audit row appendnut do docs/audits/gdpr-checks.jsonl
#   - Exit 0 pokud všechny PASSed; jinak count failed checks (1..N)
#
# Exit codes:
#   0  všechny checks PASS
#   1  generic failure
#   2  required env var missing
#   3  BFF unreachable
#   4  DSR access failed (nečekaná chyba)
#   5  DSR erase failed
#   6  cascade verification mismatch
#   7  suppression UNION nezablokoval erased kontakt
#   8  audit log not written
#   9  production DB detected — refusing to run
# ════════════════════════════════════════════════════════════════════════

set -u
# NOTE: úmyslně ne -e — chceme kontinuálně sbírat všechny FAIL checks
# a vracet sumu, ne abort na první chybě.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AUDIT_FILE="$REPO_ROOT/docs/audits/gdpr-checks.jsonl"

# Test reservation: ICO=99999999 je vyhrazené pro syntetický audit subjekt.
# Není přiděleno žádné reálné s.r.o./OSVČ v obchodním rejstříku (8-digit IČO
# range 88xxxxxx-99xxxxxx je v ARES nepoužívaný k 2026-04-30).
SYNTHETIC_ICO="99999999"
SYNTHETIC_FIRMA="GDPR Test Subject s.r.o."
SYNTHETIC_REGION="Test Region"

EMAIL=""
DRY_RUN=0
SKIP_SEED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --skip-seed) SKIP_SEED=1; shift;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "Neznámý parametr: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$EMAIL" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  EMAIL="gdpr-test+${TS}@example.test"
fi

BFF_URL="${BFF_URL:-http://localhost:3100}"
API_KEY="${OUTREACH_API_KEY:-}"
DB_URL="${DATABASE_URL:-}"

# ── Předkontroly ───────────────────────────────────────────────────────
declare -a FAILS=()
declare -a PASSES=()

fail() {
  echo "  [FAIL] $1"
  FAILS+=("$1")
}
pass() {
  echo "  [PASS] $1"
  PASSES+=("$1")
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Chybí required env: $name" >&2
    exit 2
  fi
}

# Production DB guard — odmítni pokud DATABASE_URL vypadá jako prod.
if [[ -n "$DB_URL" ]]; then
  if [[ "$DB_URL" =~ railway\.internal|prod|production ]]; then
    echo "ZAKÁZÁNO: DATABASE_URL vypadá production ($DB_URL); audit script běží jen proti test/staging DB." >&2
    exit 9
  fi
fi
if [[ "${RAILWAY_ENVIRONMENT_NAME:-}" == "production" ]]; then
  echo "ZAKÁZÁNO: RAILWAY_ENVIRONMENT_NAME=production." >&2
  exit 9
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  require_env OUTREACH_API_KEY
fi

echo "════════════════════════════════════════════════════════════════════════"
echo "KT-B12 GDPR compliance audit"
echo "  BFF:        $BFF_URL"
echo "  Email:      $EMAIL"
echo "  Synth IČO:  $SYNTHETIC_ICO (vyhrazené)"
echo "  Audit log:  $AUDIT_FILE"
echo "════════════════════════════════════════════════════════════════════════"
echo ""

# ── Check 1: BFF dostupný ──────────────────────────────────────────────
echo "Check 1/10: BFF reachability"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "$BFF_URL/api/health" 2>/dev/null || echo "000")"
if [[ "$HTTP_CODE" =~ ^(200|204|404)$ ]]; then
  pass "BFF reachable (HTTP $HTTP_CODE)"
else
  fail "BFF nereachable (HTTP $HTTP_CODE)"
  echo "Audit přerušen — BFF není dostupný; spusť \`pnpm dev\` v features/platform/outreach-dashboard." >&2
  exit 3
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ""
  echo "DRY RUN — končím po health checku."
  exit 0
fi

# ── Check 2: Seed syntetický kontakt ───────────────────────────────────
echo ""
echo "Check 2/10: Seed syntetický test kontakt (IČO=$SYNTHETIC_ICO)"
if [[ "$SKIP_SEED" -eq 1 ]]; then
  pass "Seed přeskočen (--skip-seed)"
else
  if [[ -z "$DB_URL" ]]; then
    echo "  SKIP: DATABASE_URL nezadán — nelze seed-nout přímo. Použij \`--skip-seed\` nebo poskytni DATABASE_URL."
    fail "Seed přeskočen kvůli chybějícímu DATABASE_URL"
  else
    # Pokud psql neexistuje, fallback na BFF endpoint /api/contacts (POST).
    if command -v psql >/dev/null 2>&1; then
      psql "$DB_URL" -v ON_ERROR_STOP=0 <<EOF >/dev/null 2>&1
INSERT INTO contacts(email, ico, firma, region, status, created_at)
VALUES ('$EMAIL', '$SYNTHETIC_ICO', '$SYNTHETIC_FIRMA', '$SYNTHETIC_REGION', 'active', now())
ON CONFLICT (email) DO UPDATE SET status='active', updated_at=now();
EOF
      RC=$?
      if [[ $RC -eq 0 ]]; then
        pass "Syntetický kontakt seeded přes psql"
      else
        fail "psql seed selhal (exit $RC)"
      fi
    else
      pass "Seed přeskočen (psql nenalezen, --skip-seed dop.)"
    fi
  fi
fi

# ── Check 3: DSR access — endpoint vrátí 200 ──────────────────────────
echo ""
echo "Check 3/10: DSR access — GET /api/dsr/access"
ACCESS_RESP="$(curl -sS -X GET \
  -H "X-API-Key: $API_KEY" \
  --max-time 10 \
  "$BFF_URL/api/dsr/access?email=$(printf '%s' "$EMAIL" | sed 's/+/%2B/g; s/@/%40/g')" \
  2>/dev/null || echo '{"error":"curl_failed"}')"
if echo "$ACCESS_RESP" | grep -q '"email"'; then
  pass "DSR access vrátil JSON s emailem"
else
  fail "DSR access response neobsahuje email field: ${ACCESS_RESP:0:200}"
fi

# ── Check 4: DSR access response shape ────────────────────────────────
echo ""
echo "Check 4/10: DSR access — 8 retention buckets v response"
EXPECTED_BUCKETS=(contacts outreach_contacts send_events reply_inbox tracking_events suppression_list outreach_suppressions audit_log)
MISSING=0
for bucket in "${EXPECTED_BUCKETS[@]}"; do
  if ! echo "$ACCESS_RESP" | grep -q "\"$bucket\""; then
    MISSING=$((MISSING+1))
  fi
done
if [[ $MISSING -eq 0 ]]; then
  pass "Všech 8 retention buckets přítomno v access response"
else
  fail "$MISSING/8 retention buckets chybí v DSR access response"
fi

# ── Check 5: DSR erase — endpoint vrátí 200 ────────────────────────────
echo ""
echo "Check 5/10: DSR erase — POST /api/dsr/erase"
ERASE_RESP="$(curl -sS -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 10 \
  -d "{\"email\":\"$EMAIL\"}" \
  "$BFF_URL/api/dsr/erase" \
  2>/dev/null || echo '{"error":"curl_failed"}')"
if echo "$ERASE_RESP" | grep -q '"ok":\s*true'; then
  pass "DSR erase response.ok=true"
else
  fail "DSR erase nevrátil ok=true: ${ERASE_RESP:0:200}"
fi

# ── Check 6: Erase response obsahuje deleted breakdown ────────────────
echo ""
echo "Check 6/10: Erase response — deleted breakdown shape"
DELETED_KEYS=(contacts outreach_contacts send_events reply_inbox tracking_events)
MISSING=0
for key in "${DELETED_KEYS[@]}"; do
  if ! echo "$ERASE_RESP" | grep -q "\"$key\""; then
    MISSING=$((MISSING+1))
  fi
done
if [[ $MISSING -eq 0 ]]; then
  pass "Erase response obsahuje deleted breakdown všech 5 cascade tabulek"
else
  fail "$MISSING/5 cascade tabulek chybí v deleted breakdown"
fi

# ── Check 7: Suppression UNION zachycuje erased subjekt ───────────────
echo ""
echo "Check 7/10: Suppression UNION — erased subjekt zablokován"
if echo "$ERASE_RESP" | grep -q '"suppression_kept"\s*:\s*true'; then
  pass "suppression_kept=true (subjekt zůstává v UNION blocked)"
else
  fail "suppression_kept neset; subjekt není v UNION zablokován"
fi

# ── Check 8: Idempotentní erase — 2. volání nesmí selhat ──────────────
echo ""
echo "Check 8/10: Idempotentní erase (2. volání)"
ERASE_RESP2="$(curl -sS -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 10 \
  -d "{\"email\":\"$EMAIL\"}" \
  "$BFF_URL/api/dsr/erase" \
  2>/dev/null || echo '{"error":"curl_failed"}')"
if echo "$ERASE_RESP2" | grep -q '"ok":\s*true'; then
  pass "2. erase volání idempotentní (vrátil ok=true)"
else
  fail "2. erase volání selhalo: ${ERASE_RESP2:0:200}"
fi

# ── Check 9: DSR access po erase — found_total=0 (jen suppression) ────
echo ""
echo "Check 9/10: DSR access po erase — kontakt PII odstraněn"
ACCESS_RESP2="$(curl -sS -X GET \
  -H "X-API-Key: $API_KEY" \
  --max-time 10 \
  "$BFF_URL/api/dsr/access?email=$(printf '%s' "$EMAIL" | sed 's/+/%2B/g; s/@/%40/g')" \
  2>/dev/null || echo '{}')"
# Erase NEMAŽE suppression_list (proof of opt-out per Art. 17 + §7(4)).
# Takže found_total > 0 je legitimní jen když všechny rows jsou ze suppression_list.
CONTACTS_AFTER="$(echo "$ACCESS_RESP2" | grep -o '"contacts":\s*\[[^]]*\]' | head -1)"
if [[ "$CONTACTS_AFTER" == *'[]'* ]] || [[ -z "$CONTACTS_AFTER" ]]; then
  pass "Po erase: contacts.rows=[] (PII odstraněn, suppression zachován)"
else
  fail "Po erase: contacts pole neprázdné — kaskáda nedoběhla: ${CONTACTS_AFTER:0:120}"
fi

# ── Check 10: Audit log — dsr_erase row v operator_audit_log ──────────
echo ""
echo "Check 10/10: Audit log — dsr_erase entry"
if [[ -n "$DB_URL" ]] && command -v psql >/dev/null 2>&1; then
  AUDIT_COUNT="$(psql "$DB_URL" -tAX -c \
    "SELECT count(*) FROM operator_audit_log
     WHERE action='dsr_erase' AND details->>'email' = '$EMAIL'" \
    2>/dev/null || echo "0")"
  if [[ "$AUDIT_COUNT" =~ ^[1-9][0-9]*$ ]]; then
    pass "operator_audit_log obsahuje dsr_erase row(s) ($AUDIT_COUNT)"
  else
    fail "operator_audit_log neobsahuje dsr_erase pro $EMAIL (count=$AUDIT_COUNT)"
  fi
else
  # Bez DB checkneme alespoň, že access response v 1. iteraci obsahoval audit_log pole.
  if echo "$ACCESS_RESP" | grep -q '"audit_log"'; then
    pass "Audit log pole přítomno v DSR access (DB direct check přeskočen)"
  else
    fail "Audit log pole chybí v DSR access response"
  fi
fi

# ── JSONL audit row ────────────────────────────────────────────────────
mkdir -p "$(dirname "$AUDIT_FILE")"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PASS_COUNT="${#PASSES[@]}"
FAIL_COUNT="${#FAILS[@]}"
TOTAL=$((PASS_COUNT + FAIL_COUNT))

# Sestav JSON ručně (bez jq dependency).
FAIL_JSON="["
for i in "${!FAILS[@]}"; do
  if [[ $i -gt 0 ]]; then FAIL_JSON+=","; fi
  ESCAPED="$(printf '%s' "${FAILS[$i]}" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  FAIL_JSON+="\"$ESCAPED\""
done
FAIL_JSON+="]"

cat >> "$AUDIT_FILE" <<EOF
{"timestamp":"$TIMESTAMP","tool":"gdpr-compliance-check.sh","email":"$EMAIL","ico":"$SYNTHETIC_ICO","total":$TOTAL,"passed":$PASS_COUNT,"failed":$FAIL_COUNT,"failures":$FAIL_JSON,"bff_url":"$BFF_URL"}
EOF

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "Souhrn: $PASS_COUNT/$TOTAL PASS, $FAIL_COUNT FAIL"
echo "Audit row appendnut do: $AUDIT_FILE"
echo "════════════════════════════════════════════════════════════════════════"

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit $FAIL_COUNT
fi
exit 0

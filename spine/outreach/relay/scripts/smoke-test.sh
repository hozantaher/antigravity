#!/bin/bash
# Smoke test for anti-trace-relay in record-only mode
# Usage: ./scripts/smoke-test.sh [base_url] [token]

set -euo pipefail

BASE="${1:-https://localhost:8090}"
TOKEN="${2:-$DEV_API_TOKEN}"
CURL="curl -sk"

echo "=== Anti-Trace Relay Smoke Test ==="
echo "Base: $BASE"
echo ""

# 1. Health check
echo "[1/7] Health check..."
HEALTH=$($CURL "$BASE/healthz")
echo "$HEALTH" | grep -q '"ok"' && echo "  PASS" || { echo "  FAIL: $HEALTH"; exit 1; }

# 2. Submit envelope
echo "[2/7] Submit envelope..."
SUBMIT=$($CURL -X POST "$BASE/v1/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"recipient":"test@example.com","subject":"Smoke test","body":"Hello from smoke test"}')
echo "$SUBMIT" | grep -q '"envelope_id"' && echo "  PASS: $SUBMIT" || { echo "  FAIL: $SUBMIT"; exit 1; }
ENV_ID=$(echo "$SUBMIT" | grep -o '"env_[^"]*"' | tr -d '"')

# 3. Check status
echo "[3/7] Check relay status..."
STATUS=$($CURL "$BASE/v1/status" -H "Authorization: Bearer $TOKEN")
echo "$STATUS" | grep -q '"pending_envelopes"' && echo "  PASS: $STATUS" || { echo "  FAIL: $STATUS"; exit 1; }

# 4. Check audit events
echo "[4/7] Check audit trail..."
AUDIT=$($CURL "$BASE/v1/audit-events" -H "Authorization: Bearer $TOKEN")
echo "$AUDIT" | grep -q '"intake_accepted"' && echo "  PASS: found intake_accepted event" || { echo "  FAIL: $AUDIT"; exit 1; }

# 5. Check audit has no content/IP
echo "[5/7] Verify audit minimality..."
if echo "$AUDIT" | grep -qi '"body\|"ip\|"email\|"content\|"address'; then
  echo "  FAIL: audit contains sensitive data!"
  exit 1
else
  echo "  PASS: no content/IP/email in audit"
fi

# 6. Check identities
echo "[6/7] Check identities..."
IDS=$($CURL "$BASE/v1/identities" -H "Authorization: Bearer $TOKEN")
echo "$IDS" | grep -q '"identities"' && echo "  PASS" || { echo "  FAIL: $IDS"; exit 1; }

# 7. Unauthorized access
echo "[7/7] Verify auth enforcement..."
UNAUTH=$($CURL -o /dev/null -w "%{http_code}" "$BASE/v1/submit" -X POST \
  -H "Content-Type: application/json" \
  -d '{"recipient":"a@b.com","body":"test"}')
[ "$UNAUTH" = "401" ] && echo "  PASS: unauthorized returns 401" || { echo "  FAIL: expected 401, got $UNAUTH"; exit 1; }

echo ""
echo "=== ALL SMOKE TESTS PASSED ==="

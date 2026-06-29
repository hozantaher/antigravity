#!/bin/bash
# R3 acceptance test — privacy-gateway record-only runtime end-to-end.
# Boots gateway on :8081, exercises alias + message + outbox flow, tears down.
# Exit 0 = full flow green, exit 1 = any step failed.

set -u
PORT=8081
BASE="http://127.0.0.1:$PORT"
TOKEN="dev-token"
DATA_DIR="$(mktemp -d -t pgw-r3-XXXXXX)"
LOG="$DATA_DIR/gateway.log"
FAIL=0

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "=== build gateway ==="
go build -o "$DATA_DIR/privacy-gateway" ./services/privacy-gateway/cmd/privacy-gateway || { echo "BUILD FAIL"; exit 1; }

echo "=== stale env file points to :8081 ==="
if grep -qE '^LISTEN_ADDR=:8080$' services/privacy-gateway/.env.local.record-only.test; then
  echo "STALE: .env.local.record-only.test still set to :8080"
  FAIL=1
fi

echo "=== LOCAL-RECORD-ONLY-RUN.md references :8081 ==="
if grep -q 'localhost:8080' services/privacy-gateway/LOCAL-RECORD-ONLY-RUN.md; then
  echo "STALE DOC: LOCAL-RECORD-ONLY-RUN.md still references :8080"
  FAIL=1
fi

echo "=== start gateway (record-only, :$PORT) ==="
LISTEN_ADDR=":$PORT" \
ALIAS_DOMAIN=test.local \
DATA_DIR="$DATA_DIR/data" \
DATA_ENCRYPTION_KEY_B64="L3r/Mn1I5wW5sfZBlJ0zzGU5yM1bl2HHQo1R1lIRu+k=" \
DELIVERY_MODE=record-only \
DEV_API_TOKEN="$TOKEN" \
DEV_USER_ID=user-dev \
DEV_TENANT_ID=tenant-dev \
DEV_USER_EMAIL=user@test.local \
  "$DATA_DIR/privacy-gateway" >"$LOG" 2>&1 &
PID=$!

echo "=== wait for /healthz (up to 10s) ==="
for i in $(seq 1 20); do
  if curl -sf "$BASE/healthz" >/dev/null; then
    echo "healthz OK after ${i}x250ms"
    break
  fi
  sleep 0.25
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "GATEWAY CRASHED"
    cat "$LOG"
    exit 1
  fi
done
curl -sf "$BASE/healthz" >/dev/null || { echo "healthz never became ready"; cat "$LOG"; FAIL=1; }

echo "=== POST /v1/aliases ==="
ALIAS_JSON=$(curl -s -X POST "$BASE/v1/aliases" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"r3-smoke"}')
ALIAS_ID=$(echo "$ALIAS_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
ALIAS_EMAIL=$(echo "$ALIAS_JSON" | sed -n 's/.*"email":"\([^"]*\)".*/\1/p')
if [ -z "$ALIAS_ID" ]; then
  echo "ALIAS CREATE FAIL: $ALIAS_JSON"
  FAIL=1
else
  echo "alias id=$ALIAS_ID email=$ALIAS_EMAIL"
fi

echo "=== POST /v1/messages (record-only) ==="
MSG_STATUS=$(curl -s -o /tmp/r3-msg.json -w '%{http_code}' -X POST "$BASE/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"alias_id\":\"$ALIAS_ID\",\"to\":[\"dest@example.test\"],\"subject\":\"R3 smoke\",\"text_body\":\"hello r3\"}")
if [ "$MSG_STATUS" != "202" ] && [ "$MSG_STATUS" != "200" ] && [ "$MSG_STATUS" != "201" ]; then
  echo "MESSAGE SEND FAIL status=$MSG_STATUS body=$(cat /tmp/r3-msg.json)"
  FAIL=1
else
  echo "message accepted status=$MSG_STATUS"
fi

echo "=== GET /v1/messages/outbox — record present ==="
OUTBOX=$(curl -s "$BASE/v1/messages/outbox" -H "Authorization: Bearer $TOKEN")
if ! echo "$OUTBOX" | grep -q 'R3 smoke'; then
  echo "OUTBOX MISSING MESSAGE: $OUTBOX"
  FAIL=1
else
  echo "outbox contains record"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: R3 record-only runtime end-to-end green on :$PORT"
else
  echo "FAIL: R3 runtime not complete."
  echo "--- gateway log ---"
  cat "$LOG"
  exit 1
fi

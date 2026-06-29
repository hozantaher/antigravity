#!/bin/bash
# End-to-end test: submit -> relay (deaddrop) -> receive
# Verifies the complete user flow with cryptographic roundtrip.
#
# Usage: bash scripts/e2e-test.sh
# Requires: TLS cert at /tmp/atr-cert.pem (or generates one)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RELAY_BIN="/tmp/atr-e2e-relay"
SUBMIT_BIN="/tmp/atr-e2e-submit"
RECEIVE_BIN="/tmp/atr-e2e-receive"
DATA_DIR="/tmp/atr-e2e-run"
CERT="/tmp/atr-cert.pem"
KEY="/tmp/atr-key.pem"
PORT=18199
PASSPHRASE="e2e-test-$(head -c 4 /dev/urandom | xxd -p)"
MESSAGE="E2E-TEST-$(date +%s): The quick brown fox jumps over the lazy dog."
RESULT=0

cleanup() {
  kill "$RELAY_PID" 2>/dev/null || true
  wait "$RELAY_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR"
  rm -f "$RELAY_BIN" "$SUBMIT_BIN" "$RECEIVE_BIN"
}
trap cleanup EXIT

echo "=== Anti-Trace Relay: E2E Test ==="
echo ""

# --- Build ---
echo "[1/7] Building binaries..."
go build -o "$RELAY_BIN" ./cmd/anti-trace-relay/
go build -ldflags "-s -w" -o "$SUBMIT_BIN" ./cmd/submit/
go build -ldflags "-s -w" -o "$RECEIVE_BIN" ./cmd/receive/
echo "  OK"

# --- Generate TLS cert if missing ---
if [ ! -f "$CERT" ]; then
  echo "[1.5] Generating TLS cert..."
  openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CERT" \
    -days 1 -nodes -subj "/CN=localhost" 2>/dev/null
fi

# --- Start relay ---
echo "[2/7] Starting relay (deaddrop mode, port $PORT)..."
DATA_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64) \
  VAULT_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64) \
  DEV_API_TOKEN=e2e-tok DEV_USER_ID=e2e DEV_TENANT_ID=e2e-tenant \
  TLS_CERT_FILE="$CERT" TLS_KEY_FILE="$KEY" \
  LISTEN_ADDR=":$PORT" DATA_DIR="$DATA_DIR" \
  DELIVERY_MODE=deaddrop TRANSPORT_MODE=lab \
  EMISSION_INTERVAL_SECONDS=1 MIX_POOL_MIN_SIZE=1 \
  "$RELAY_BIN" > /dev/null 2>&1 &
RELAY_PID=$!
sleep 2

# Health check
if ! curl -sk "https://localhost:$PORT/healthz" | grep -q '"ok"'; then
  echo "  FAIL: relay not healthy"
  exit 1
fi
echo "  OK (PID $RELAY_PID)"

# --- Derive recipient key ---
echo "[3/7] Deriving recipient key from passphrase..."
PUBKEY=$(echo "$PASSPHRASE" | INSECURE_TLS=true "$RECEIVE_BIN" --show-key 2>/dev/null)
if [ -z "$PUBKEY" ] || [ ${#PUBKEY} -ne 64 ]; then
  echo "  FAIL: invalid public key: '$PUBKEY'"
  exit 1
fi
echo "  OK ($PUBKEY)"

# --- Submit ---
echo "[4/7] Submitting message..."
SUBMIT_OUT=$(echo "$PASSPHRASE" | \
  RELAY_URL="https://localhost:$PORT" \
  RECIPIENT_KEY="$PUBKEY" \
  MESSAGE="$MESSAGE" \
  INSECURE_TLS=true \
  "$SUBMIT_BIN" 2>&1)
if echo "$SUBMIT_OUT" | grep -q "Submitted successfully"; then
  echo "  OK"
else
  echo "  FAIL: $SUBMIT_OUT"
  exit 1
fi

# --- Wait for emission ---
echo "[5/7] Waiting for constant-rate emission (2s)..."
sleep 2
echo "  OK"

# --- Receive (single call -- poll is destructive) ---
echo "[6/7] Receiving message..."
RECV_ALL=$(echo "$PASSPHRASE" | \
  RELAY_URL="https://localhost:$PORT" \
  INSECURE_TLS=true \
  "$RECEIVE_BIN" 2>&1)

if echo "$RECV_ALL" | grep -q "message(s) received"; then
  echo "  OK: messages found"
elif echo "$RECV_ALL" | grep -q "No messages"; then
  echo "  FAIL: no messages in dead drop"
  RESULT=1
else
  echo "  FAIL: unexpected output"
  echo "  Output: $RECV_ALL"
  RESULT=1
fi

# --- Verify content ---
echo "[7/7] Verifying content integrity..."
if echo "$RECV_ALL" | grep -qF "$MESSAGE"; then
  echo "  OK: content matches"
  echo ""
  echo "  Sent:     '$MESSAGE'"
  echo "  Received: '$(echo "$RECV_ALL" | grep -F "$MESSAGE")'"
else
  echo "  FAIL: message content not found in output"
  echo "  Sent:     '$MESSAGE'"
  echo "  Full output:"
  echo "$RECV_ALL"
  RESULT=1
fi

echo ""
if [ $RESULT -eq 0 ]; then
  echo "=== ALL E2E TESTS PASSED ==="
else
  echo "=== E2E TESTS FAILED ==="
fi

exit $RESULT

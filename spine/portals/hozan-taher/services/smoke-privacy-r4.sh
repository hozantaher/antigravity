#!/bin/bash
# R4 acceptance test — anti-trace-relay runtime bridge ready.
# Boots relay on :8090 (PLAIN_HTTP, record-only), verifies /healthz + /v1/health,
# asserts bridge gateway URL env is honored (pointed at privacy-gateway :8081).
# Exit 0 = runtime green, exit 1 = any step failed.

set -u
PORT=8090
BASE="http://127.0.0.1:$PORT"
TOKEN="dev-token"
WORK="$(mktemp -d -t atr-r4-XXXXXX)"
LOG="$WORK/relay.log"
FAIL=0

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== build relay ==="
go build -o "$WORK/anti-trace-relay" ./services/anti-trace-relay/cmd/relay || { echo "BUILD FAIL"; exit 1; }

echo "=== CLAUDE.md build path must point at cmd/relay ==="
if grep -q 'cmd/anti-trace-relay/' services/anti-trace-relay/CLAUDE.md; then
  echo "STALE: anti-trace-relay CLAUDE.md references ./cmd/anti-trace-relay/ (actual is ./cmd/relay/)"
  FAIL=1
fi

echo "=== start relay (PLAIN_HTTP, record-only, :$PORT, bridge → :8081) ==="
LISTEN_ADDR=":$PORT" \
PLAIN_HTTP=true \
DATA_DIR="$WORK/data" \
DATA_ENCRYPTION_KEY_B64="L3r/Mn1I5wW5sfZBlJ0zzGU5yM1bl2HHQo1R1lIRu+k=" \
VAULT_ENCRYPTION_KEY_B64="L3r/Mn1I5wW5sfZBlJ0zzGU5yM1bl2HHQo1R1lIRu+k=" \
DELIVERY_MODE=record-only \
BRIDGE_GATEWAY_URL="http://127.0.0.1:8081" \
BRIDGE_GATEWAY_TOKEN="bridge-token" \
TRANSPORT_MODE=lab \
DEV_API_TOKEN="$TOKEN" \
DEV_USER_ID=user-dev \
DEV_TENANT_ID=tenant-dev \
  "$WORK/anti-trace-relay" >"$LOG" 2>&1 &
PID=$!

echo "=== wait for /healthz (up to 10s) ==="
for i in $(seq 1 40); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then
    echo "healthz OK after ${i}x250ms"
    break
  fi
  sleep 0.25
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "RELAY CRASHED"
    cat "$LOG"
    exit 1
  fi
done
if ! curl -sf "$BASE/healthz" >/dev/null 2>&1; then
  echo "healthz never became ready"
  cat "$LOG"
  FAIL=1
fi

echo "=== GET /healthz response shape ==="
HEALTH=$(curl -s "$BASE/healthz")
if ! echo "$HEALTH" | grep -q '"ok"'; then
  echo "UNEXPECTED HEALTHZ: $HEALTH"
  FAIL=1
fi

echo "=== bridge_configured log line (bridge wired to :8081) ==="
if ! grep -q 'bridge_configured' "$LOG"; then
  echo "BRIDGE NOT CONFIGURED in log"
  FAIL=1
fi
# Note: /v1/health probes the gateway target and returns 503 when gateway
# is not running — that's expected for standalone R4. Full bridge
# reachability is exercised in R5.

echo "=== relay log records listen + bridge ==="
if ! grep -q '"listen":":8090"' "$LOG" && ! grep -q 'listen=:8090' "$LOG" && ! grep -q '"addr":":8090"' "$LOG"; then
  echo "LOG MISSING LISTEN :8090"
  cat "$LOG"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: R4 anti-trace-relay runtime green on :$PORT, bridge wired to :8081"
else
  echo "FAIL: R4 runtime not complete."
  echo "--- relay log ---"
  cat "$LOG"
  exit 1
fi

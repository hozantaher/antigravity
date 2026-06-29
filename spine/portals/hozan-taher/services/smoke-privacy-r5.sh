#!/bin/bash
# R5 acceptance test — BFF + Go wire-up end-to-end (record-only).
# Starts privacy-gateway (:8081) AND anti-trace-relay (:8090) with shared
# intake token. Asserts bridge reachability (relay /v1/health = 200).
# Exit 0 = pair up and bridge reachable, exit 1 = any step failed.

set -u
GW_PORT=8081
RELAY_PORT=8090
GW_BASE="http://127.0.0.1:$GW_PORT"
RELAY_BASE="http://127.0.0.1:$RELAY_PORT"
BRIDGE_TOKEN="bridge-intake-secret-r5"
KEY="L3r/Mn1I5wW5sfZBlJ0zzGU5yM1bl2HHQo1R1lIRu+k="
WORK="$(mktemp -d -t r5-XXXXXX)"
FAIL=0

cleanup() {
  for pidvar in GW_PID RELAY_PID; do
    eval pid=\$$pidvar
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== build both binaries ==="
go build -o "$WORK/privacy-gateway" ./services/privacy-gateway/cmd/privacy-gateway || { echo "GW BUILD FAIL"; exit 1; }
go build -o "$WORK/anti-trace-relay" ./services/anti-trace-relay/cmd/relay || { echo "RELAY BUILD FAIL"; exit 1; }

echo "=== start privacy-gateway with INTAKE_API_TOKEN ==="
LISTEN_ADDR=":$GW_PORT" \
ALIAS_DOMAIN=test.local \
DATA_DIR="$WORK/gw" \
DATA_ENCRYPTION_KEY_B64="$KEY" \
DELIVERY_MODE=record-only \
DEV_API_TOKEN=dev-token \
DEV_USER_ID=user-dev \
DEV_TENANT_ID=tenant-dev \
DEV_USER_EMAIL=user@test.local \
INTAKE_API_TOKEN="$BRIDGE_TOKEN" \
INTAKE_USER_ID=intake-user \
INTAKE_TENANT_ID=tenant-dev \
INTAKE_USER_EMAIL=intake@test.local \
  "$WORK/privacy-gateway" >"$WORK/gw.log" 2>&1 &
GW_PID=$!

echo "=== wait for gateway /healthz ==="
for i in $(seq 1 40); do
  if curl -sf "$GW_BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
  if ! kill -0 "$GW_PID" 2>/dev/null; then echo "GW CRASHED"; cat "$WORK/gw.log"; exit 1; fi
done
curl -sf "$GW_BASE/healthz" >/dev/null || { echo "gateway healthz not ready"; cat "$WORK/gw.log"; exit 1; }
echo "gateway up"

echo "=== start anti-trace-relay with bridge → gateway ==="
LISTEN_ADDR=":$RELAY_PORT" \
PLAIN_HTTP=true \
DATA_DIR="$WORK/relay" \
DATA_ENCRYPTION_KEY_B64="$KEY" \
VAULT_ENCRYPTION_KEY_B64="$KEY" \
DELIVERY_MODE=bridge \
BRIDGE_GATEWAY_URL="$GW_BASE" \
BRIDGE_GATEWAY_TOKEN="$BRIDGE_TOKEN" \
TRANSPORT_MODE=lab \
DEV_API_TOKEN=dev-token \
DEV_USER_ID=user-dev \
DEV_TENANT_ID=tenant-dev \
  "$WORK/anti-trace-relay" >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!

echo "=== wait for relay /healthz ==="
for i in $(seq 1 40); do
  if curl -sf "$RELAY_BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then echo "RELAY CRASHED"; cat "$WORK/relay.log"; exit 1; fi
done
curl -sf "$RELAY_BASE/healthz" >/dev/null || { echo "relay healthz not ready"; cat "$WORK/relay.log"; exit 1; }
echo "relay up"

echo "=== relay /v1/health reports gateway reachable (bridge live) ==="
V1=$(curl -s -o "$WORK/v1.json" -w '%{http_code}' "$RELAY_BASE/v1/health")
BODY=$(cat "$WORK/v1.json")
if [ "$V1" != "200" ]; then
  echo "BRIDGE UNREACHABLE: status=$V1 body=$BODY"
  FAIL=1
else
  echo "bridge reachable: $BODY"
fi

echo "=== relay logs bridge_configured pointing at gateway ==="
if ! grep -q 'bridge_configured' "$WORK/relay.log"; then
  echo "missing bridge_configured log line"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: R5 pair up. Gateway :$GW_PORT ↔ Relay :$RELAY_PORT bridge reachable."
else
  echo "FAIL: R5 incomplete."
  echo "--- gateway log ---"; cat "$WORK/gw.log"
  echo "--- relay log ---"; cat "$WORK/relay.log"
  exit 1
fi

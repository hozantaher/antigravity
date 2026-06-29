#!/bin/bash
# R2 acceptance test — verify go.work + port 8081 reassignment.
# Exit 0 = both modules build, gateway on :8081, no :8080 defaults in source.
# Exit 1 = failure.

set -u
FAIL=0

echo "=== go.work includes both modules ==="
if ! grep -q 'use ./services/anti-trace-relay' go.work; then
  echo "MISSING: go.work does not include services/anti-trace-relay"
  FAIL=1
fi
if ! grep -q 'use ./services/privacy-gateway' go.work; then
  echo "MISSING: go.work does not include services/privacy-gateway"
  FAIL=1
fi

echo "=== privacy-gateway default port is :8081 ==="
if grep -q 'LISTEN_ADDR", ":8080"' services/privacy-gateway/internal/config/config.go; then
  echo "STALE DEFAULT: config.go still defaults LISTEN_ADDR to :8080"
  FAIL=1
fi
if ! grep -q 'LISTEN_ADDR", ":8081"' services/privacy-gateway/internal/config/config.go; then
  echo "MISSING DEFAULT: config.go does not default LISTEN_ADDR to :8081"
  FAIL=1
fi

echo "=== config_test.go asserts :8081 default ==="
if grep -q 'cfg.ListenAddr != ":8080"' services/privacy-gateway/internal/config/config_test.go; then
  echo "STALE TEST: config_test.go still asserts :8080"
  FAIL=1
fi

echo "=== Dockerfile healthcheck on :8081 ==="
if grep -qE 'EXPOSE 8080|localhost:\$\{PORT:-8080\}' services/privacy-gateway/Dockerfile; then
  echo "STALE DOCKERFILE: references 8080 default"
  FAIL=1
fi

echo "=== go build succeeds for both modules ==="
if ! go build ./services/anti-trace-relay/... >/tmp/r2-build-atr.log 2>&1; then
  echo "BUILD FAIL: services/anti-trace-relay — see /tmp/r2-build-atr.log"
  tail -20 /tmp/r2-build-atr.log
  FAIL=1
fi
if ! go build ./services/privacy-gateway/... >/tmp/r2-build-pg.log 2>&1; then
  echo "BUILD FAIL: services/privacy-gateway — see /tmp/r2-build-pg.log"
  tail -20 /tmp/r2-build-pg.log
  FAIL=1
fi

echo "=== modules/outreach still builds (regression check) ==="
if ! go build ./modules/outreach/... >/tmp/r2-build-outreach.log 2>&1; then
  echo "BUILD FAIL: modules/outreach — see /tmp/r2-build-outreach.log"
  tail -20 /tmp/r2-build-outreach.log
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: R2 wire-up complete. Gateway on :8081, both modules build."
else
  echo "FAIL: R2 not yet complete."
  exit 1
fi

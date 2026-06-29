#!/bin/bash
# R7 acceptance test — anonymous transport via curated SOCKS5 pool, no Tor.
# Verifies the new NewStaticRotatingProxy seam: relay can seed its pool
# from an operator-controlled list (e.g. outreach-dashboard proxyCache,
# CZ + neighboring countries, seznam-friendly) instead of a public
# aggregator or Tor.
#
# Exit 0 = new seam compiles, unit tests pass, no Tor creeps back in.
# Exit 1 = any step failed.

set -u
FAIL=0

echo "=== new static proxy pool tests ==="
if ! go test -race -run 'StaticRotatingProxy' ./services/anti-trace-relay/internal/transport/... 2>/tmp/r7-static.log; then
  echo "STATIC POOL TESTS FAIL"
  cat /tmp/r7-static.log
  FAIL=1
fi

echo "=== full transport package regression (with -race) ==="
if ! go test -race -count=1 ./services/anti-trace-relay/internal/transport/... 2>/tmp/r7-full.log; then
  echo "TRANSPORT PKG REGRESSION"
  cat /tmp/r7-full.log
  FAIL=1
fi

echo "=== new file present ==="
if [ ! -f services/anti-trace-relay/internal/transport/proxy_pool_static.go ]; then
  echo "MISSING proxy_pool_static.go"
  FAIL=1
fi

echo "=== new code has no Tor references ==="
# Word-boundary match so 'operator' / 'torque' don't trip the check.
if grep -qEi '(^|[^A-Za-z])(tor|onion)([^A-Za-z]|$)' services/anti-trace-relay/internal/transport/proxy_pool_static.go services/anti-trace-relay/internal/transport/proxy_pool_static_test.go 2>/dev/null; then
  echo "TOR/ONION REF LEAKED into static pool code"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: R7 static SOCKS5 pool seam is in place. Relay can now be seeded from the outreach-dashboard proxyCache (CZ + neighbours, seznam-friendly) with no Tor."
else
  echo "FAIL: R7 incomplete."
  exit 1
fi

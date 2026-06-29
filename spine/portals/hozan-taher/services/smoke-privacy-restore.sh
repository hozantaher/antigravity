#!/bin/bash
# R1 acceptance test — verify privacy-mail-gateway sources are restored.
# Exit 0 = sources complete, exit 1 = missing.

set -u
FAIL=0

need() {
  if [ ! -e "$1" ]; then
    echo "MISSING: $1"
    FAIL=1
  fi
}

needmin() {
  # needmin <dir> <min_file_count>
  if [ ! -d "$1" ]; then
    echo "MISSING DIR: $1"
    FAIL=1
    return
  fi
  local n
  n=$(find "$1" -type f -name '*.go' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    echo "TOO FEW .go FILES: $1 has $n, need >= $2"
    FAIL=1
  fi
}

echo "=== anti-trace-relay ==="
need services/anti-trace-relay/go.mod
need services/anti-trace-relay/cmd/relay/main.go
need services/anti-trace-relay/cmd/submit/main.go
need services/anti-trace-relay/cmd/receive/main.go
need services/anti-trace-relay/Dockerfile
needmin services/anti-trace-relay/internal 60

echo "=== privacy-gateway ==="
need services/privacy-gateway/go.mod
need services/privacy-gateway/cmd/privacy-gateway/main.go
need services/privacy-gateway/Dockerfile
needmin services/privacy-gateway/internal 40

echo "=== key packages ==="
need services/anti-trace-relay/internal/transport
need services/anti-trace-relay/internal/intake
need services/anti-trace-relay/internal/contentenc
need services/anti-trace-relay/internal/bridge
need services/privacy-gateway/internal/httpapi
need services/privacy-gateway/internal/relay
need services/privacy-gateway/internal/submission
need services/privacy-gateway/internal/mail

if [ "$FAIL" -eq 0 ]; then
  echo "OK: privacy-mail-gateway sources restored."
else
  echo "FAIL: missing sources. Run R1 restoration."
  exit 1
fi

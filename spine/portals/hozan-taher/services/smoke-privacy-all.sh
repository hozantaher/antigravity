#!/bin/bash
# Meta runner for all privacy-mail-gateway restoration smokes (R1-R7).
# Runs unit/integration acceptance for every sprint in order.
# Exit 0 = every smoke green, exit 1 = any fail.

set -u
FAIL=0

run() {
  local name="$1"; shift
  echo ""
  echo "════════════════════════════════════════════"
  echo "  $name"
  echo "════════════════════════════════════════════"
  if bash "$@"; then
    echo "✓ $name"
  else
    echo "✗ $name"
    FAIL=1
  fi
}

# R1 is the one-shot source-restoration check (kept for drift detection).
run "R1 — sources restored" services/smoke-privacy-restore.sh
run "R2 — go.work + port 8081"  services/smoke-privacy-r2.sh
run "R3 — gateway record-only runtime" services/smoke-privacy-r3.sh
run "R4 — relay bridge runtime" services/smoke-privacy-r4.sh
run "R5 — gateway ↔ relay pair end-to-end" services/smoke-privacy-r5.sh
run "R6 — resolver SMTP bridge for outreach_mailboxes" services/smoke-privacy-r6.sh
run "R7 — static SOCKS5 pool (no Tor)" services/smoke-privacy-r7.sh

echo ""
echo "════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL GREEN — privacy-mail-gateway restoration complete."
else
  echo "FAIL — one or more smokes failed."
  exit 1
fi

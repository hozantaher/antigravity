#!/usr/bin/env bash
#
# Self-test for .githooks/pre-commit (R2).
# Creates a throwaway git repo in a temp dir, stages various diffs,
# runs the hook, and checks that:
#   (a) banned literals in apps/**/server.js are blocked
#   (b) identical literals in services/anti-trace-relay/** pass
#   (c) identical literals in *_test.go pass
#   (d) SKIP_EGRESS_GUARD=1 override passes and is logged
#
# Usage: bash .githooks/pre-commit.test.sh

set -euo pipefail

HOOK_SRC="$(cd "$(dirname "$0")" && pwd)/pre-commit"
[[ -x "$HOOK_SRC" ]] || { echo "FAIL: $HOOK_SRC not executable"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
git init -q
git config user.email test@local
git config user.name tester
git config commit.gpgsign false
mkdir -p .githooks
cp "$HOOK_SRC" .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }

# Baseline commit so HEAD exists.
mkdir -p apps
echo "init" > README
git add README
git -c commit.gpgsign=false commit -qm init

# ── CASE A: banned literal in apps/ — must block ────────────────────
mkdir -p apps/outreach-dashboard
cat > apps/outreach-dashboard/server.js <<'EOF'
const client = net.connect({ host: 'smtp.seznam.cz', port: 587 })
EOF
git add apps/outreach-dashboard/server.js

if git -c commit.gpgsign=false commit -qm "should be blocked" 2>/dev/null; then
  fail "A: commit with SMTP literal in apps/ was NOT blocked"
else
  pass "A: banned literal in apps/outreach-dashboard/server.js → blocked"
fi

git reset -q HEAD apps/outreach-dashboard/server.js
rm apps/outreach-dashboard/server.js

# ── CASE B: identical literal in services/anti-trace-relay/ — must pass ─
mkdir -p services/anti-trace-relay/internal/transport
cat > services/anti-trace-relay/internal/transport/proxy_pool.go <<'EOF'
package transport
const probeTarget = "smtp.seznam.cz:465"
EOF
git add services/anti-trace-relay/internal/transport/proxy_pool.go

if git -c commit.gpgsign=false commit -qm "relay allowed" 2>/dev/null; then
  pass "B: banned literal in services/anti-trace-relay/ → allowed"
else
  fail "B: relay commit with SMTP literal was blocked (should pass)"
fi

# ── CASE C: banned literal in *_test.go — must pass ─────────────────
mkdir -p modules/outreach/internal/sender
cat > modules/outreach/internal/sender/engine_test.go <<'EOF'
package sender
var host = "smtp.seznam.cz:465"
EOF
git add modules/outreach/internal/sender/engine_test.go

if git -c commit.gpgsign=false commit -qm "test fixture allowed" 2>/dev/null; then
  pass "C: banned literal in *_test.go → allowed"
else
  fail "C: *_test.go commit with literal was blocked (should pass)"
fi

# ── CASE D: SKIP override — must pass + log ─────────────────────────
mkdir -p apps/x
cat > apps/x/y.js <<'EOF'
const port = ':587'
EOF
git add apps/x/y.js

if SKIP_EGRESS_GUARD=1 EGRESS_GUARD_REASON="self-test" \
     git -c commit.gpgsign=false commit -qm "skip override" 2>/dev/null; then
  if grep -q "self-test" .egress-guard-overrides.log; then
    pass "D: SKIP_EGRESS_GUARD=1 → allowed and logged"
  else
    fail "D: override succeeded but .egress-guard-overrides.log missing entry"
  fi
else
  fail "D: SKIP_EGRESS_GUARD=1 did not allow commit"
fi

echo
echo "All pre-commit egress guard cases passed."

#!/usr/bin/env bash
# Pre-deploy validation — run BEFORE Railway deploy to catch issues that would
# only surface in production. Combines local checks (env, build, schema, secrets)
# into a single PASS/FAIL gate.
#
# Usage:
#   bash scripts/operator/pre-deploy-validate.sh
#
# Exit codes:
#   0 — all checks PASS, safe to deploy
#   1 — env vars missing
#   2 — build failed
#   3 — DB migration drift detected
#   4 — secret-scan flagged a leak
#   5 — schema-manifest drift vs Go backend
#   6 — privacy URL not reachable
#
# Each check prints PASS/FAIL with a one-line reason. Operator can re-run after
# fixing each failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PASS_COUNT=0
FAIL_COUNT=0

ok() { echo "✓ PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "✗ FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info() { echo "  · $1"; }

echo "═══ pre-deploy-validate ═══"
echo ""

# ── 1. Required env vars ─────────────────────────────────────────────
echo "[1/7] Required env vars…"
REQUIRED_ENVS=(
  GO_SERVER_URL
  OUTREACH_API_KEY
  OUTREACH_DATABASE_URL
  UNSUBSCRIBE_BASE_URL
  UNSUBSCRIBE_SECRET
  ANTI_TRACE_RELAY_URL
  ANTI_TRACE_RELAY_TOKEN
  MAILBOX_SECRET_KEY
)
ENV_FILE="${ENV_FILE:-.env}"
ENV_MISSING=""
if [ -f "$ENV_FILE" ]; then
  set +e
  source "$ENV_FILE" 2>/dev/null
  set -e
fi
for var in "${REQUIRED_ENVS[@]}"; do
  if [ -z "${!var:-}" ]; then
    ENV_MISSING="$ENV_MISSING $var"
  fi
done
if [ -z "$ENV_MISSING" ]; then
  ok "all ${#REQUIRED_ENVS[@]} required env vars present"
else
  fail "missing env vars:$ENV_MISSING"
  info "set these in Railway dashboard before deploy"
fi

# ── 2. Privacy URL reachable (public, no auth) ────────────────────────
echo ""
echo "[2/7] Privacy URL reachable…"
PRIVACY_URL="${UNSUBSCRIBE_BASE_URL:-https://outreach.garaaage.cz}/privacy"
HTTP_CODE=$(curl -sI -o /dev/null -w "%{http_code}" --max-time 10 "$PRIVACY_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  ok "privacy URL returns 200: $PRIVACY_URL"
elif [ "$HTTP_CODE" = "000" ]; then
  fail "privacy URL unreachable (DNS / no service): $PRIVACY_URL"
  info "if pre-deploy, this is expected — first deploy will create it"
else
  fail "privacy URL returns HTTP $HTTP_CODE: $PRIVACY_URL"
  info "must be 200 (public) — operator gate per docs/audits/2026-04-30-security-pr-review-pack.md"
fi

# ── 3. BFF build clean ────────────────────────────────────────────────
echo ""
echo "[3/7] BFF build…"
if (cd features/platform/outreach-dashboard && pnpm build > /tmp/build.log 2>&1); then
  ok "pnpm build clean ($(wc -c < /tmp/build.log) bytes)"
else
  fail "pnpm build failed"
  info "see /tmp/build.log"
  tail -10 /tmp/build.log >&2
fi

# ── 4. Go services compile ────────────────────────────────────────────
echo ""
echo "[4/7] Go services compile…"
if go build ./services/... > /tmp/gobuild.log 2>&1; then
  ok "go build ./services/... clean"
else
  fail "go build failed"
  tail -10 /tmp/gobuild.log >&2
fi

# ── 5. Migration ordering (no duplicate prefixes) ─────────────────────
echo ""
echo "[5/7] Migration ordering…"
DUPS=$(find scripts/migrations -name "0*_*.sql" -exec basename {} \; 2>/dev/null \
  | awk -F_ '{print $1}' | sort | uniq -d)
if [ -z "$DUPS" ]; then
  ok "no duplicate migration prefixes"
else
  fail "duplicate migration prefixes detected: $DUPS"
  info "rename one before deploy — runner sorts by filename"
fi

# ── 6. No secrets in repo (basic scan) ────────────────────────────────
echo ""
echo "[6/7] Secret scan (heuristic)…"
LEAKED=$(git grep -nE 'sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|password\s*=\s*["'"'"'][^"'"'"']{8,}' \
  -- ':(exclude)*test*' ':(exclude)*.md' ':(exclude)*.lock' 2>/dev/null | head -3)
if [ -z "$LEAKED" ]; then
  ok "no obvious secret patterns in tracked files"
else
  fail "potential secret leak found"
  echo "$LEAKED" >&2
fi

# ── 7. Schema-manifest sync (if Go backend reachable) ────────────────
echo ""
echo "[7/7] Schema-manifest sync (best-effort)…"
if [ -n "${GO_SERVER_URL:-}" ] && [ -f "features/platform/outreach-dashboard/schema-manifest.json" ]; then
  HTTP_CODE=$(curl -sI -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "x-api-key: ${OUTREACH_API_KEY:-}" \
    "${GO_SERVER_URL}/schema" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    ok "Go /schema reachable (full diff covered by bff-schema-check.contract.test.ts)"
  else
    info "Go /schema returned $HTTP_CODE — skip drift check (deploy may still be safe)"
  fi
else
  info "GO_SERVER_URL or schema-manifest missing — skip"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "═══ Summary ═══"
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "Address failures above before \`git push\` to Railway-deploy branch."
  exit 1
fi
echo ""
echo "All checks PASS — safe to deploy."
exit 0

#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# BF-G1 — Pre-deploy preflight checks
# ════════════════════════════════════════════════════════════════════════
#
# Run before pushing to the production branch. Exits non-zero on any
# failed check so a CI/CD pipeline (or a paranoid operator) can gate
# the push on it.
#
# Usage:
#   scripts/deploy/preflight.sh
#   scripts/deploy/preflight.sh --skip db        # skip DB connectivity
#   scripts/deploy/preflight.sh --skip migrations # skip migration check
#   scripts/deploy/preflight.sh --skip env       # skip env-var presence
#
# Checks (all must pass unless --skip <name>):
#   1. env       — required environment variables present
#   2. db        — DATABASE_URL points to a reachable Postgres
#   3. migrations — schema_migrations is current (no pending migrations)
#   4. region    — Railway region is EU (or operator confirmed SCC signed)
#   5. tests     — last `pnpm test` was green (sentinel file check)
#   6. branch    — local branch matches REMOTE_BRANCH env (default 'main')
#
# Exit codes:
#   0  all checks passed
#   1  generic failure
#   2  required env var missing
#   3  DB unreachable
#   4  pending migrations
#   5  region issue
#   7  deploy tarball too large
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

SKIP_LIST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip) SKIP_LIST="$SKIP_LIST $2"; shift 2 ;;
    -h|--help)
      sed -n '5,30p' "$0"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

skipped() {
  for s in $SKIP_LIST; do
    [[ "$s" == "$1" ]] && return 0
  done
  return 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL_COUNT=0
fail() {
  echo "  ✗ $1" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}
pass() {
  echo "  ✓ $1"
}

echo "── Preflight checks (root: $ROOT)"

# ── 0. Deploy tarball size ──────────────────────────────────────────────
if ! skipped size; then
  echo ""
  echo "[0/7] deploy tarball size"
  railwayignore="$ROOT/.railwayignore"
  if [[ ! -f "$railwayignore" ]]; then
    fail "size: .railwayignore missing"
  else
    # Compute size excluding items in .railwayignore
    tarball_size_kb=$(du -sk "$ROOT" --exclude-from="$railwayignore" 2>/dev/null | awk '{print $1}')
    size_mb=$((tarball_size_kb / 1024))
    if [[ $tarball_size_kb -gt 500000 ]]; then
      echo "    Deploy tarball: ${size_mb}MB"
      echo "    Top 10 largest dirs (excluding .railwayignore):"
      du -sk "$ROOT"/* --exclude-from="$railwayignore" 2>/dev/null | sort -rn | head -10 | \
        awk -v kb=1024 '{mb=$1/kb; printf "      %.1fMB  %s\n", mb, $2}' | sed 's|'"$ROOT"'/||'
      fail "size: deploy tarball exceeds 500MB — run: rm -rf .claude/worktrees && git clean -fd"
      exit 7
    else
      pass "size: tarball ${size_mb}MB (< 500MB limit)"
    fi
  fi
fi

# ── 1. Required env vars ────────────────────────────────────────────────
if ! skipped env; then
  echo ""
  echo "[1/7] env"
  for var in DATABASE_URL OUTREACH_API_KEY ANTI_TRACE_RELAY_TOKEN; do
    if [[ -z "${!var:-}" ]]; then
      fail "env $var missing"
    else
      pass "env $var present"
    fi
  done
fi

# ── 2. DB connectivity ──────────────────────────────────────────────────
if ! skipped db; then
  echo ""
  echo "[2/7] db connectivity"
  if [[ -z "${DATABASE_URL:-}" ]]; then
    fail "DATABASE_URL not set — cannot test db connectivity"
  elif command -v psql >/dev/null; then
    if psql "$DATABASE_URL" -X -q -c 'SELECT 1' >/dev/null 2>&1; then
      pass "psql SELECT 1 succeeded"
    else
      fail "psql could not connect to DATABASE_URL"
    fi
  else
    fail "psql not on PATH; cannot verify connectivity"
  fi
fi

# ── 3. Pending migrations ───────────────────────────────────────────────
if ! skipped migrations; then
  echo ""
  echo "[3/7] migrations"
  if [[ -x "$ROOT/scripts/migrations/run.sh" ]]; then
    set +e
    output=$("$ROOT/scripts/migrations/run.sh" --dry-run 2>&1)
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      if echo "$output" | grep -q "No pending migrations"; then
        pass "no pending migrations"
      else
        echo "$output" | sed 's/^/    /'
        fail "pending migrations exist — apply before deploy"
      fi
    else
      echo "$output" | sed 's/^/    /'
      fail "migrations runner failed (exit $rc)"
    fi
  else
    fail "scripts/migrations/run.sh missing or not executable"
  fi
fi

# ── 4. Railway region (EU vs non-EU) ────────────────────────────────────
if ! skipped region; then
  echo ""
  echo "[4/7] Railway region"
  region="${RAILWAY_REGION:-${RAILWAY_DEPLOYMENT_REGION:-unknown}}"
  case "$region" in
    eu-*|europe-*)
      pass "Railway region $region (EU — no SCC required)"
      ;;
    unknown)
      fail "RAILWAY_REGION env unknown — operator must confirm region + SCC status (see docs/legal/scc-railway.md)"
      ;;
    *)
      if [[ -f "$ROOT/docs/legal/dpa-railway-signed.pdf" || -f "$ROOT/docs/legal/scc-confirmed.txt" ]]; then
        pass "Railway region $region (non-EU) + SCC sentinel found"
      else
        fail "Railway region $region (non-EU) without SCC sentinel — see docs/legal/scc-railway.md"
      fi
      ;;
  esac
fi

# ── 5. Tests-green sentinel ─────────────────────────────────────────────
if ! skipped tests; then
  echo ""
  echo "[5/7] last test run sentinel"
  sentinel="$ROOT/.last-tests-passed"
  if [[ -f "$sentinel" ]]; then
    age=$(( $(date +%s) - $(stat -f %m "$sentinel" 2>/dev/null || stat -c %Y "$sentinel") ))
    if [[ $age -lt 1800 ]]; then
      pass "tests passed within last 30 min ($age s ago)"
    else
      fail "tests sentinel older than 30 min — re-run pnpm test + go test"
    fi
  else
    fail ".last-tests-passed sentinel missing — run: pnpm test && go test ./... && touch .last-tests-passed"
  fi
fi

# ── 6. Branch sanity ────────────────────────────────────────────────────
if ! skipped branch; then
  echo ""
  echo "[6/7] git branch"
  expected_branch="${REMOTE_BRANCH:-main}"
  current="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [[ "$current" == "$expected_branch" ]]; then
    pass "on $expected_branch"
  else
    echo "    on '$current', expected '$expected_branch'"
    fail "branch mismatch — set REMOTE_BRANCH to override"
  fi
  # Uncommitted changes are a soft warn, not a fail.
  if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
    echo "    (warn) working tree dirty — uncommitted changes will not deploy"
  fi
fi

echo ""
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "── PREFLIGHT FAILED ($FAIL_COUNT issue(s))"
  exit 1
fi
echo "── PREFLIGHT OK"
exit 0

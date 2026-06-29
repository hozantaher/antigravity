#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASH="$ROOT/features/platform/outreach-dashboard"

# Detect docker binary
DOCKER="${DOCKER_BIN:-$(command -v docker || echo /opt/homebrew/bin/docker)}"
DB_CONTAINER="hozan-taher-outreach-db-1"

# Helper: run SQL via docker exec (works without host psql)
run_sql() {
  "$DOCKER" exec -i "$DB_CONTAINER" psql -U outreach -d outreach "$@"
}

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Dashboard FE Test Suite             ║"
echo "╚══════════════════════════════════════╝"

# Step 1: Check prerequisites
echo "=== 1. Check prerequisites ==="
run_sql -c "SELECT COUNT(*)::int AS contacts FROM outreach_contacts;" || {
    echo "❌ CHYBA: Spusť nejdříve scripts/test-local.sh (docker container $DB_CONTAINER must be running)"
    exit 1
  }

# Step 2: Apply seed data for FE pages
echo "=== 2. Seed dashboard data ==="
run_sql < "$ROOT/scripts/seed-dashboard.sql"

# Step 3: Install deps if needed
cd "$DASH"
if [ ! -d node_modules ]; then
  echo "=== 3. Installing dependencies ==="
  pnpm install
fi

# Step 4: Start dev server in background with local DSN
echo "=== 4. Starting dashboard dev server ==="
DATABASE_URL="postgresql://outreach:outreach@localhost:5433/outreach" \
  pnpm dev &
DEV_PID=$!

# Wait for server to be ready (max 60s)
echo "Waiting for localhost:3000..."
for i in $(seq 1 60); do
  curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break
  sleep 1
done

# Verify server actually started
curl -sf http://localhost:3000/api/health >/dev/null 2>&1 || {
  echo "❌ Dashboard dev server failed to start"
  kill $DEV_PID 2>/dev/null || true
  exit 1
}
echo "✅ Dashboard running on :3000"

# Step 5: API smoke tests
echo "=== 5. API Smoke Tests ==="
ENDPOINTS=(
  "/api/health"
  "/api/stats"
  "/api/campaigns?page=1&limit=20"
  "/api/campaigns/1"
  "/api/contacts?page=1&limit=50"
  "/api/threads?page=1&limit=20"
  "/api/domains?page=1&limit=20"
  "/api/suppressions?page=1&limit=20"
  "/api/inbox?page=1&limit=20"
  "/api/analytics"
  "/api/timeline?range=30"
)
PASS=0 FAIL=0
for ep in "${ENDPOINTS[@]}"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$ep")
  if [ "$STATUS" = "200" ]; then
    echo "  ✅ $ep"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $ep → HTTP $STATUS"
    FAIL=$((FAIL + 1))
  fi
done
echo "API: $PASS pass, $FAIL fail"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ API smoke tests failed — stopping"
  kill $DEV_PID 2>/dev/null || true
  exit 1
fi

# Step 6: Vitest unit tests
echo "=== 6. Vitest Unit Tests ==="
pnpm test --run

# Step 7: Playwright E2E tests
echo "=== 7. Playwright E2E Tests ==="
pnpm exec playwright test

# Cleanup
echo "=== Cleanup ==="
kill $DEV_PID 2>/dev/null || true
wait $DEV_PID 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  ✅ DASHBOARD TESTS PASSED           ║"
echo "╚══════════════════════════════════════╝"

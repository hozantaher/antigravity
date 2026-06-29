#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/modules/outreach"

# ── ENV for local dev ──
export DB_HOST=localhost DB_PORT=5433 DB_NAME=outreach DB_USER=outreach DB_PASSWORD=outreach DB_SSL_MODE=disable
export MAILBOX_1_ADDRESS=test@local.dev
export MAILBOX_1_SMTP_HOST=localhost MAILBOX_1_SMTP_PORT=1025
export MAILBOX_1_IMAP_HOST=localhost MAILBOX_1_IMAP_PORT=1143
export MAILBOX_1_USERNAME=test MAILBOX_1_PASSWORD=test
export MAILBOX_1_DAILY_LIMIT=100 MAILBOX_1_WARMUP_DAY=0
export DEV_MODE=1
export SKIP_CALENDAR_CHECK=1
export SENDING_WINDOW_START=0 SENDING_WINDOW_END=24
export SENDING_MIN_DELAY_SECONDS=1 SENDING_MAX_DELAY_SECONDS=2
export SENDING_MAX_PER_DOMAIN_HOUR=100
export SAFETY_MAX_BOUNCE_RATE=0.5 SAFETY_MAX_COMPLAINTS_24H=100
export TARGET_INDUSTRIES=machinery,metalwork,construction

echo "=== 1. Starting services ==="
cd "$ROOT"
docker compose -f infra/docker/docker-compose.yml up -d greenmail outreach-db
echo "Waiting for PostgreSQL (5433) and GreenMail (1025, 1143)..."
for i in $(seq 1 20); do
  nc -z localhost 5433 2>/dev/null && nc -z localhost 1025 2>/dev/null && nc -z localhost 1143 2>/dev/null && break
  sleep 1
done

echo "=== 2. Build ==="
cd "$SVC"
go build -o outreach ./cmd/outreach

echo "=== 3. Migrate ==="
./outreach migrate

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  TRACK 1: Campaign Pipeline          ║"
echo "╚══════════════════════════════════════╝"

echo "=== 4. Import test contacts ==="
./outreach import "$ROOT/scripts/test-contacts.csv"

echo "=== 5. Mark contacts as valid (skip MX for local.dev) ==="
PGPASSWORD=outreach psql -h localhost -p 5433 -U outreach -d outreach -c \
  "UPDATE contacts SET status = 'valid' WHERE email LIKE '%@local.dev';"

echo "=== 6. Stats ==="
./outreach stats

echo "=== 7. Create campaign ==="
./outreach campaign-create "Local Test"

echo "=== 8. Run campaign + sender (timeout 30s) ==="
# macOS nemá timeout — použijeme background + sleep + kill
./outreach campaign-run 1 &
SENDER_PID=$!
sleep 30
kill $SENDER_PID 2>/dev/null || true
wait $SENDER_PID 2>/dev/null || true

echo "=== 9. Poll IMAP ==="
./outreach poll

echo "=== 10. Verify send_events ==="
PGPASSWORD=outreach psql -h localhost -p 5433 -U outreach -d outreach -c \
  "SELECT contact_id, mailbox_used, message_id, status, sent_at FROM send_events ORDER BY sent_at;"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  TRACK 2: Enrichment Pipeline        ║"
echo "╚══════════════════════════════════════╝"

echo "=== 11. Enrich local contacts ==="
./outreach enrich-local "$ROOT/scripts/test-contacts.csv"

echo "=== 12. Dashboard (outreach_contacts) ==="
./outreach dashboard

echo "=== 13. Recalculate consent scores ==="
./outreach recalc

echo "=== 14. Suppress test domain ==="
./outreach suppress "blocked-domain.cz" manual

echo "=== 15. Intelligence loop (one-shot) ==="
./outreach intel

echo "=== 16. Weekly report ==="
./outreach report || echo "(report may be empty — expected for fresh DB)"

echo "=== 17. Verify outreach_contacts ==="
PGPASSWORD=outreach psql -h localhost -p 5433 -U outreach -d outreach -c \
  "SELECT email, company_name, consent_score, industry_tags, status FROM outreach_contacts ORDER BY consent_score DESC;"

echo "=== 18. Verify outreach_domains ==="
PGPASSWORD=outreach psql -h localhost -p 5433 -U outreach -d outreach -c \
  "SELECT domain, domain_type, mx_verified, is_suppressed FROM outreach_domains;"

echo ""
echo "=== 19. Dashboard FE tests ==="
bash "$ROOT/scripts/test-dashboard.sh"

echo ""
echo "Pro zastaveni: docker compose -f infra/docker/docker-compose.yml stop greenmail outreach-db"
echo "HOTOVO — všechny 3 tracks otestovány (BE campaign + enrichment + FE dashboard)"

#!/usr/bin/env bash
set -euo pipefail

echo "=== Starting GreenMail ==="
docker compose -f infra/docker/docker-compose.yml up -d greenmail

echo "Waiting for GreenMail (SMTP:1025 + IMAP:1143)..."
for i in $(seq 1 30); do
  nc -z localhost 1025 2>/dev/null && nc -z localhost 1143 2>/dev/null && break
  sleep 1
done

if ! nc -z localhost 1025 2>/dev/null || ! nc -z localhost 1143 2>/dev/null; then
  echo "ERROR: GreenMail did not start within 30s"
  docker compose -f infra/docker/docker-compose.yml logs greenmail
  exit 1
fi

echo "=== Running integration tests ==="
cd modules/outreach
go test -v -tags integration -run TestIntegration_Mailbox ./internal/imap/...

echo ""
echo "To stop: docker compose -f infra/docker/docker-compose.yml stop greenmail"

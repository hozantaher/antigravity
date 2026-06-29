#!/bin/bash
# R6 acceptance test — SMTP bridge from gateway to outreach_mailboxes.
# Exercises mail.ResolverGateway: per-sender SMTP credentials picked from
# an injectable SMTPResolver (StaticSMTPResolver for tests; a future
# HTTPResolver will pull from outreach_mailboxes via BFF).
# Exit 0 = resolver gateway unit tests pass and mail pkg regression-free.

set -u
FAIL=0

echo "=== resolver gateway + static resolver unit tests ==="
if ! go test -race -run 'Resolver|StaticResolver' ./services/privacy-gateway/internal/mail/... 2>/tmp/r6-unit.log; then
  echo "RESOLVER UNIT FAIL"
  cat /tmp/r6-unit.log
  FAIL=1
fi

echo "=== full mail package regression ==="
if ! go test -race ./services/privacy-gateway/internal/mail/... 2>/tmp/r6-mail.log; then
  echo "MAIL PKG REGRESSION"
  cat /tmp/r6-mail.log
  FAIL=1
fi

echo "=== new files present ==="
for f in \
  services/privacy-gateway/internal/mail/smtp_resolver.go \
  services/privacy-gateway/internal/mail/smtp_resolver_test.go; do
  if [ ! -f "$f" ]; then
    echo "MISSING $f"
    FAIL=1
  fi
done

echo "=== no Fastmail references reintroduced in resolver ==="
if grep -qi 'fastmail' services/privacy-gateway/internal/mail/smtp_resolver.go services/privacy-gateway/internal/mail/smtp_resolver_test.go 2>/dev/null; then
  echo "LEAKED FASTMAIL REF"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: R6 resolver-based SMTP bridge is in place. Next step = HTTPResolver + BFF /api/mailboxes/:id/smtp-creds endpoint (R6b) for live outreach_mailboxes lookup."
else
  echo "FAIL: R6 incomplete."
  exit 1
fi

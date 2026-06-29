# AW7-8 Backfill IMAP APPEND for Historical Sends

## Context

PR #1210 (AW7-7) wired IMAP APPEND to the sender's Sent folder for **new** sends as of deployment time. However, 20 sends from 2026-05-10 17:30–21:00 CEST (before AW7-7 deployment) remain absent from the operator's Sent folder.

This playbook describes the manual backfill procedure using `features/inbound/orchestrator/cmd/backfill-imap-sent`.

## Pre-flight

1. Verify relay `/v1/imap-socks-addr` endpoint is live:
   ```bash
   curl -s "http://relay:3000/v1/imap-socks-addr?mailbox=goran.nowak@seznam.cz" | head
   # Should return: <host>:<port> for SOCKS5 endpoint
   ```

2. Verify operator DB is accessible:
   ```bash
   psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM send_events WHERE campaign_id=457 AND sent_at >= '2026-05-10 17:00:00+00';"
   ```
   Should return: 20

## Dry-run (recommended first)

```bash
export DATABASE_URL="postgres://user:pass@host/outreach-db"
export RELAY_ENDPOINT="http://relay:3000"

go run ./features/inbound/orchestrator/cmd/backfill-imap-sent/main.go \
  --campaign-id=457 \
  --sent-after="2026-05-10T17:00:00Z" \
  --limit=20 \
  --dry-run
```

Output shows 20 send records (sender mailbox, recipient, Message-ID) without APPENDing.

## Full run

Remove `--dry-run` to perform APPEND:

```bash
go run ./features/inbound/orchestrator/cmd/backfill-imap-sent/main.go \
  --campaign-id=457 \
  --sent-after="2026-05-10T17:00:00Z" \
  --limit=20
```

Logs show:
- ✓ "backfilled" for each successful APPEND
- ✗ "backfill failed" with error detail for any issues

## Idempotency

The program is **safe to re-run**:
- SEARCH before each APPEND checks for existing Message-ID in Sent folder
- Duplicate Message-IDs are silently skipped
- No audit rows are written (this is a one-off tool, not part of the engine)

## Output Redaction

Per memory `feedback_no_pii_in_commands`, all mailbox addresses in logs are redacted to `mb1@…/mb2@…` format:

```
send_id=456, mailbox=n…@…, recipient=m…@…
```

Full credentials never appear in stdout/stderr.

## Troubleshooting

### "no sends found to backfill"
- Check campaign ID and timestamp range
- Verify send_events has rows: `SELECT id, mailbox_used, sent_at FROM send_events WHERE campaign_id=<id>`

### "relay status 403"
- Relay endpoint requires AUTH_TOKEN header if gated (see relay deployment)
- Verify relay is healthy: `curl http://relay:3000/health`

### "append failed: […]"
- IMAP folder name mismatch (program tries 4 candidates; if all fail, retry with manual LIST)
- Permission denied on Sent folder (rare; check mailbox password)

### "dial socks: connection refused"
- SOCKS5 endpoint unreachable or stale (relay may have redeployed)
- Run relay's `/v1/imap-socks-addr?mailbox=test@seznam.cz` manually to verify

## Manual recovery

If the tool fails partway through (e.g., 10/20 APPENDed), re-run with `--dry-run` to see which sends remain. The idempotency check will skip already-appended messages.

## Audit trail

IMAP APPEND operations are not explicitly logged to `channel_audit_log` (this is a backfill tool, not part of the production sender engine). The recipient's Sent folder shows the timestamps (`INTERNALDATE`) of restored messages — that's the audit trail.

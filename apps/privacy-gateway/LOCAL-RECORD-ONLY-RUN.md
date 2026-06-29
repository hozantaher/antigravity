# Local Record-Only Run

## Goal

Run the privacy gateway locally with no external provider and verify:

- health
- alias creation
- outbound message submission
- outbox persistence
- restart persistence

This is the fastest safe end-to-end local rehearsal of the MVP core.

## Config

Use [/.env.local.record-only.test](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.local.record-only.test).

This config:

- does not contact real SMTP
- does not contact real IMAP
- still exercises API, persistence, encryption-at-rest wiring, and outbox behavior

## Start Service

From [services/privacy-gateway](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway):

```bash
set -a
source ./.env.local.record-only.test
set +a
go run ./cmd/privacy-gateway
```

Open a second terminal in the same directory for the requests below.

## 1. Health Check

```bash
curl http://localhost:8081/healthz
```

Expected:

- `200`
- `{"status":"ok"}`

## 2. Create Alias

```bash
curl -X POST http://localhost:8081/v1/aliases \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"label":"support"}'
```

Expected:

- `201`
- alias email ends with `test.local`

Save the returned alias `id`.

## 3. List Aliases

```bash
curl http://localhost:8081/v1/aliases \
  -H "Authorization: Bearer dev-token"
```

Expected:

- `200`
- created alias is present

## 4. Send Message

Replace `REPLACE_ALIAS_ID`.

```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "alias_id":"REPLACE_ALIAS_ID",
    "to":["recipient@example.com"],
    "subject":"LOCAL RECORD ONLY",
    "text_body":"Local record-only body."
  }'
```

Expected:

- `202`

## 5. Inspect Outbox

```bash
curl http://localhost:8081/v1/messages/outbox \
  -H "Authorization: Bearer dev-token"
```

Expected:

- `200`
- one message is present
- subject is `LOCAL RECORD ONLY`

## 6. Verify Inbox Sync Is Disabled

```bash
curl -X POST http://localhost:8081/v1/messages/inbox/sync \
  -H "Authorization: Bearer dev-token"
```

Expected:

- `501`

This is correct for the local record-only config because IMAP is intentionally not configured.

## 7. Restart Persistence Check

1. stop the service
2. start it again with the same `.env.local.record-only.test`
3. repeat alias list and outbox list

Expected:

- alias still exists
- outbox still contains the recorded message

## 8. Files To Confirm

Inside `./data-record-only-test`, confirm these files exist:

- `aliases.json`
- `outbox.json`

Optional:

- verify content is not plaintext business data if encryption is enabled

## Success Criteria

Mark the local record-only run successful if:

- health passed
- alias flow passed
- outbound submission passed
- outbox inspection passed
- restart persistence passed

## What This Does Not Prove

This local run does not prove:

- real SMTP delivery
- real IMAP sync
- real provider compatibility

For that, use:

- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
- [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md)

# Privacy Gateway MVP Smoke Test

## Goal

Validate the 3 MVP flows consistently on a release candidate:

1. alias setup
2. outbound send
3. inbound sync and inbox read

## Preconditions

- service is running
- operator has a valid bearer token
- chosen mode and env vars are configured
- for SMTP validation, a real relay is available
- for IMAP validation, a real mailbox is available

Use:

- base URL: `http://localhost:8080`
- token: `dev-token` unless overridden

## Step 1: Health

Request:

```bash
curl http://localhost:8080/healthz
```

Pass condition:

- returns `200`
- body contains `{"status":"ok"}`

## Step 2: Create Alias

Request:

```bash
curl -X POST http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"label":"support"}'
```

Pass condition:

- returns `201`
- response contains an alias `id`
- response email uses the configured alias domain

Record:

- save the returned `alias_id`

## Step 3: List Aliases

Request:

```bash
curl http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer dev-token"
```

Pass condition:

- returns `200`
- created alias is present in `aliases`

## Step 4: Send Outbound Message

Request:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "alias_id":"REPLACE_ALIAS_ID",
    "to":["recipient@example.com"],
    "subject":"MVP smoke test",
    "text_body":"Outbound smoke test body."
  }'
```

Pass condition:

- returns `202`

Mode-specific pass condition:

- in `record-only` mode: outbox contains the new message
- in `smtp` mode: outbox contains the new message and the recipient mailbox receives it once

## Step 5: Inspect Outbox

Request:

```bash
curl http://localhost:8080/v1/messages/outbox \
  -H "Authorization: Bearer dev-token"
```

Pass condition:

- returns `200`
- sent message appears in `messages`

## Step 6: Trigger Inbound Sync

Request:

```bash
curl -X POST http://localhost:8080/v1/messages/inbox/sync \
  -H "Authorization: Bearer dev-token"
```

Pass condition:

- in IMAP-configured environment: returns `202`
- in non-IMAP environment: returns `501`

For release-candidate validation:

- run this step in an IMAP-configured environment and require `202`

## Step 7: Inspect Inbox

Request:

```bash
curl http://localhost:8080/v1/messages/inbox \
  -H "Authorization: Bearer dev-token"
```

Pass condition:

- returns `200`
- synced test message appears in `messages`
- `text_body` is normalized plain text
- attachment metadata is present when the synced test email includes an attachment

## Step 8: Restart Persistence Check

Procedure:

1. stop the service
2. start the service again with the same env vars
3. repeat alias list, outbox list, and inbox list requests

Pass condition:

- alias is still present
- outbox records are still present
- inbox records are still present

If encryption is enabled:

- restart must reuse the same `DATA_ENCRYPTION_KEY_B64`

## Step 9: Incremental Sync Check

Procedure:

1. send or place one new inbound email after the first successful sync
2. call `POST /v1/messages/inbox/sync` again
3. inspect inbox again

Pass condition:

- new message appears
- previous messages are not duplicated unexpectedly

## Release Verdict

Mark the smoke test `PASS` only if:

- all required steps passed
- SMTP was verified once in a real relay-backed environment
- IMAP was verified once in a real mailbox-backed environment

Mark the smoke test `FAIL` if:

- any core step returns an unexpected status
- outbound/inbound real-environment verification fails
- persistence breaks after restart

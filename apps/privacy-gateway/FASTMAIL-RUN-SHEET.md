# Fastmail Live Verification Run Sheet

## Purpose

This is the concrete first live-verification run sheet for the current MVP release candidate using `Fastmail`.

Use this when you want one clean operator pass from startup to release verdict without improvisation.

This is the active provider-specific operator runbook for the first live verification attempt.

For broader verification scope or artifact roles, use:

- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
- [LIVE-VERIFICATION-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-PLAN.md)

## Why Fastmail First

Fastmail is the best first verification provider for the current service because:

- it supports direct standards-based IMAP and SMTP
- it documents stable server names and ports
- it uses app passwords cleanly
- it fits the gateway's current SMTP + IMAP model better than Gmail or Proton

## Required Accounts

Prepare these 3 email identities:

1. `fastmail_sender`
   Purpose: SMTP/IMAP authenticated account used by the gateway

2. `recipient_mailbox`
   Purpose: mailbox where you manually confirm outbound delivery

3. `inbound_test_mailbox`
   Purpose: mailbox polled over IMAP by the gateway

Recommended setup:

- `fastmail_sender` and `inbound_test_mailbox` may be the same Fastmail account
- `recipient_mailbox` should be separate so outbound delivery is easy to verify

## Required Fastmail Credentials

From Fastmail, prepare:

- full Fastmail username including domain
- Fastmail app password with email access

Do not use the normal account password.

## Fastmail Reference Settings

Based on Fastmail's documented settings:

- IMAP host: `imap.fastmail.com`
- IMAP port: `993`
- IMAP encryption: SSL/TLS
- SMTP host: `smtp.fastmail.com`
- SMTP port: `587` with STARTTLS

## Recommended Env File

Use these values as the baseline:

```bash
export LISTEN_ADDR=:8080
export ALIAS_DOMAIN=your-domain.example
export DATA_DIR=./data
export DATA_ENCRYPTION_KEY_B64=REPLACE_WITH_BASE64_32_BYTE_KEY

export DELIVERY_MODE=smtp
export SMTP_HOST=smtp.fastmail.com
export SMTP_PORT=587
export SMTP_USERNAME=fastmail-user@your-domain.example
export SMTP_PASSWORD=REPLACE_WITH_FASTMAIL_APP_PASSWORD
export SMTP_HELLO_DOMAIN=your-domain.example
export SMTP_REQUIRE_STARTTLS=true
export SMTP_CONNECT_TIMEOUT_SECONDS=10

export IMAP_HOST=imap.fastmail.com
export IMAP_PORT=993
export IMAP_USERNAME=fastmail-user@your-domain.example
export IMAP_PASSWORD=REPLACE_WITH_FASTMAIL_APP_PASSWORD
export IMAP_TIMEOUT_SECONDS=10

export DEV_API_TOKEN=dev-token
export DEV_USER_ID=user-dev
export DEV_TENANT_ID=tenant-dev
export DEV_USER_EMAIL=fastmail-user@your-domain.example
```

## Pre-Run Sanity Checks

Before starting the service, confirm:

- the Fastmail plan supports IMAP/SMTP access
- the app password works for both SMTP and IMAP
- IMAP host, username, and password are either all present or all absent, because partial IMAP config now fails startup
- `ALIAS_DOMAIN` matches the sender-domain strategy you actually want to test
- the recipient mailbox is empty enough that new test messages are obvious
- the inbound mailbox is ready to receive or already contains the planned test messages

## Test Data

Use these exact subjects so the run is easy to inspect:

- outbound message: `PG FASTMAIL SMTP LIVE 1`
- inbound plain-text message: `PG FASTMAIL IMAP LIVE 1`
- inbound attachment message: `PG FASTMAIL IMAP ATTACHMENT 1`
- incremental message: `PG FASTMAIL IMAP INCREMENTAL 1`

## Run Procedure

### Phase 1: Start Service

1. export the env values
2. start the service
3. call:

```bash
curl http://localhost:8080/healthz
```

Shortcut:

```bash
./scripts/start-live-run.sh ./.env.fastmail.local
```

Assisted shortcut (start -> wait for manual SMTP/IMAP actions -> postcheck -> stop):

```bash
./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Assisted shortcut with automatic RC post-run dry-run:

```bash
RUN_RC_POSTRUN=true ./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Assisted shortcut with automatic RC post-run apply:

```bash
RUN_RC_POSTRUN=true RC_POSTRUN_APPLY=true ./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Note:

- `start-live-run.sh` writes the current artifact directory to `./artifacts/last-run-path.txt`
- `run-live-postcheck.sh` reuses that path automatically unless `ARTIFACT_DIR` is explicitly set
- `run-live-postcheck.sh` auto-loads `./.env.fastmail.local` when present (or a custom `ENV_FILE`)
- `run-live-postcheck.sh` uses `API_TOKEN`, or `DEV_API_TOKEN` from the env file, then `dev-token`

Pass:

- returns `200`

Shutdown helper:

```bash
./scripts/stop-live-run.sh
```

Optional explicit target:

```bash
./scripts/stop-live-run.sh ./artifacts/<run-dir>
```

### Phase 2: Create Alias

Request:

```bash
curl -X POST http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"label":"support"}'
```

Pass:

- returns `201`
- save the returned `alias_id`
- returned alias email ends with your configured `ALIAS_DOMAIN`

### Phase 3: Verify Outbound SMTP

Create submission:

```bash
curl -X POST http://localhost:8080/v1/submissions \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id":"REPLACE_ALIAS_ID",
    "to":["recipient@example.com"],
    "subject":"PG FASTMAIL SMTP LIVE 1",
    "text_body":"Fastmail outbound verification body."
  }'
```

Save the returned submission `id`, then relay it:

```bash
curl -X POST http://localhost:8080/v1/submissions/REPLACE_SUBMISSION_ID/relay \
  -H "Authorization: Bearer dev-token"
```

Then inspect:

```bash
curl http://localhost:8080/v1/submissions/REPLACE_SUBMISSION_ID \
  -H "Authorization: Bearer dev-token"
```

Compatibility fallback if needed:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "alias_id":"REPLACE_ALIAS_ID",
    "to":["recipient@example.com"],
    "subject":"PG FASTMAIL SMTP LIVE 1",
    "text_body":"Fastmail outbound verification body."
  }'
```

Then inspect:

```bash
curl http://localhost:8080/v1/messages/outbox \
  -H "Authorization: Bearer dev-token"
```

Pass:

- submission create returns `201`
- submission relay returns `200`
- submission detail reaches `relayed`
- outbox contains `PG FASTMAIL SMTP LIVE 1`
- recipient mailbox receives exactly one matching message

Evidence to retain:

- submission create response
- submission relay response
- submission detail excerpt
- collected `submissions.json` and `submission.json` artifacts when using the live evidence helper
- optional intake dashboard/queue/detail/timeline checks via `run-live-postcheck.sh` when `INTAKE_API_TOKEN` is set
- optional intake evidence artifacts via `collect-live-evidence.sh` when `INTAKE_API_TOKEN` is set:
  - `intake-dashboard.json`
  - `intake-queue.json`
  - `intake-submission.json`
  - `intake-submission-timeline.json`

### Phase 4: Prepare Inbound Plain-Text Message

Place or send into the IMAP mailbox:

- subject: `PG FASTMAIL IMAP LIVE 1`
- body: `Fastmail inbound verification body.`

Trigger sync:

```bash
curl -X POST http://localhost:8080/v1/messages/inbox/sync \
  -H "Authorization: Bearer dev-token"
```

Inspect inbox:

```bash
curl http://localhost:8080/v1/messages/inbox \
  -H "Authorization: Bearer dev-token"
```

Pass:

- sync returns `202`
- inbox contains `PG FASTMAIL IMAP LIVE 1`
- `text_body` is readable normalized plain text
- `GET /v1/channels` shows at least one channel with `inbox_count > 0`
- `scripts/verify-read-models.sh` passes and can auto-discover the active alias plus latest related IDs
- intake read-model checks pass as well when `INTAKE_API_TOKEN` is provided for postcheck

### Phase 5: Prepare Inbound Attachment Message

Place or send into the IMAP mailbox:

- subject: `PG FASTMAIL IMAP ATTACHMENT 1`
- short plain-text body
- one safe attachment such as `sample.pdf` or `sample.png`

Trigger sync again and inspect inbox again.

Pass:

- inbox contains `PG FASTMAIL IMAP ATTACHMENT 1`
- `text_body` does not contain attachment payload
- attachment metadata is present
- attachment policy fields are present
- safe file should normally appear as non-blocked metadata
- if the inbound message correlates to a submission, `GET /v1/messages/inbox/{id}/timeline` stays readable

### Phase 6: Restart Persistence

1. stop the service
2. start it again with the same env
3. call:
   - `GET /v1/aliases`
   - `GET /v1/messages/outbox`
   - `GET /v1/messages/inbox`

Pass:

- alias still exists
- outbox still contains prior SMTP test message
- inbox still contains prior IMAP test messages
- `GET /v1/channels` still reflects prior activity after restart

### Phase 7: Incremental Sync

Place or send one more message into the IMAP mailbox:

- subject: `PG FASTMAIL IMAP INCREMENTAL 1`

Trigger sync again and inspect inbox.

Pass:

- new message appears
- existing messages are not duplicated unexpectedly
- `GET /v1/channels?has_inbox=true` still returns a coherent filtered feed

### Phase 8: Privacy-First Read Models

Inspect:

- `GET /v1/aliases/{alias_id}/timeline`
- `GET /v1/messages/inbox`
- `GET /v1/channels`
- `scripts/verify-read-models.sh`
- `scripts/run-live-postcheck.sh`

Pass:

- alias timeline shows one coherent channel view
- inbox records remain usable as message-level records
- channels feed remains usable as the top-level operator summary
- the one-shot post-run helper produces an artifact directory and draft report without manual stitching

## Files To Spot-Check

After the run, verify these files exist inside `DATA_DIR`:

- `aliases.json`
- `outbox.json`
- `inbox.json`
- `imap-sync-state.json`

If encryption is enabled:

- contents should not be human-readable business data in plaintext

## Evidence To Capture

Save or note:

- alias create response
- outbound send response
- outbox excerpt
- inbox excerpt for plain-text message
- inbox excerpt for attachment message
- alias timeline excerpt
- channels feed excerpt
- optional collected artifact directory from `scripts/collect-live-evidence.sh`
- recipient mailbox arrival confirmation
- `imap-sync-state.json` last-modified change or content state
- restart persistence result

## Fastmail-Specific Failure Hints

If SMTP fails:

- verify app password, not account password
- verify `SMTP_USERNAME` uses full address including domain
- verify `SMTP_PORT=587` with STARTTLS

If IMAP fails:

- verify app password, not account password
- verify `IMAP_HOST=imap.fastmail.com`
- verify `IMAP_PORT=993`
- verify the mailbox actually contains the test message

If delivery succeeds but sender behavior is wrong:

- verify `ALIAS_DOMAIN` aligns with the domain strategy you want Fastmail to accept

## Release Verdict

Mark the Fastmail run `PASS` only if:

- native submission relay passed
- inbound plain-text IMAP passed
- inbound attachment IMAP passed
- restart persistence passed
- incremental sync passed
- privacy-first read-model verification passed

If Fastmail passes end-to-end, this should be considered the preferred first MVP live verification result.

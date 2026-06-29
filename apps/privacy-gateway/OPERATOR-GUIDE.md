# Privacy Gateway Operator Guide

## Purpose

This guide is the minimum operator runbook for first MVP deployment and smoke testing.

It covers:

- `record-only` mode
- `smtp` mode
- `imap` mode
- current operator read models
- current retention controls

It does not cover:

- production KMS/Vault setup
- clustered deployment
- quarantine operations
- bounce processing

## Deployment Baseline

Required for every mode:

- `LISTEN_ADDR`
- `ALIAS_DOMAIN`
- `DATA_DIR`
- `DEV_API_TOKEN`
- `DEV_USER_ID`
- `DEV_TENANT_ID`
- `DEV_USER_EMAIL`

Recommended for every non-trivial environment:

- `DATA_ENCRYPTION_KEY_B64`
- explicit `MAX_RECIPIENTS`
- explicit `MAX_MESSAGE_BYTES`

Recommended when governance matters:

- explicit retention values instead of relying on defaults
- one chosen retention profile from [ENV-PROFILES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ENV-PROFILES.md)

## Mode 1: Record-Only

Use this mode for:

- local development
- contract testing
- safe API integration testing before relay credentials exist

Minimum env:

```bash
export LISTEN_ADDR=:8080
export ALIAS_DOMAIN=relay.local
export DATA_DIR=./data
export DELIVERY_MODE=record-only
export DEV_API_TOKEN=dev-token
export DEV_USER_ID=user-dev
export DEV_TENANT_ID=tenant-dev
export DEV_USER_EMAIL=user@example.com
```

Expected behavior:

- `POST /v1/messages` accepts valid messages
- no external SMTP delivery occurs
- outbound records appear in `GET /v1/messages/outbox`

## Mode 2: SMTP

Use this mode for:

- real outbound delivery through a trusted relay

Additional required env:

```bash
export DELIVERY_MODE=smtp
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_USERNAME=mailer
export SMTP_PASSWORD=replace-me
export SMTP_HELLO_DOMAIN=gateway.example.com
export SMTP_REQUIRE_STARTTLS=true
export SMTP_CONNECT_TIMEOUT_SECONDS=10
```

Operator constraints:

- the SMTP relay must allow sending for the chosen `ALIAS_DOMAIN`
- if the provider requires verified sender domains, `ALIAS_DOMAIN` must match that verified strategy
- the service only sends plain-text outbound content in MVP
- a successful API acceptance is not enough; verify real mailbox delivery once before release

Expected behavior:

- valid outbound submission is relayed through SMTP
- successfully relayed messages appear in outbox storage
- invalid SMTP configuration should fail startup/build wiring

## Mode 3: IMAP

Use this mode for:

- inbound sync into the app-facing inbox

Additional required env:

```bash
export IMAP_HOST=imap.example.com
export IMAP_PORT=993
export IMAP_USERNAME=imap-user
export IMAP_PASSWORD=replace-me
export IMAP_TIMEOUT_SECONDS=10
```

Operator constraints:

- IMAP sync is explicit; clients trigger it via `POST /v1/messages/inbox/sync`
- the service stores normalized text and attachment metadata, not full attachment payload delivery
- first sync performs a bounded backfill; later syncs continue from stored IMAP cursor state
- blocked attachment types remain metadata with policy outcomes, not downloadable artifacts

Expected behavior:

- `POST /v1/messages/inbox/sync` returns `202` when configured correctly
- `GET /v1/messages/inbox` shows normalized inbound records
- `imap-sync-state.json` advances after successful sync

## Operator Read Models

The service now has three practical operator views:

- `GET /v1/messages/inbox/{id}/timeline`
  Use when:
  you need one inbound message plus linked submission context
- `GET /v1/aliases/{id}/timeline`
  Use when:
  you need one alias/channel across outbound and inbound activity
- `GET /v1/channels`
  Use when:
  you need the top-level operator feed

Useful channel filters:

- `has_inbox=true|false`
- `has_failures=true|false`
- `latest_submission_status=accepted|queued|sanitized|relayed|failed|blocked`

Practical default:

- start at `GET /v1/channels`
- drill into `GET /v1/aliases/{id}/timeline`
- only then inspect `GET /v1/messages/inbox/{id}/timeline` if needed

## Retention Controls

Current retention controls:

- `AUDIT_RETENTION_HOURS`
- `IDENTITY_LINK_RETENTION_HOURS`
- `SUBMISSION_RETENTION_HOURS`
- `INBOX_RETENTION_HOURS`
- `OUTBOX_RETENTION_HOURS`
- `IMAP_CURSOR_RETENTION_HOURS`

Important current rule:

- `0` means pruning is disabled for that subsystem
- pruning is activity-driven, not scheduler-driven

Practical recommendation:

- local machine: use the `Dev` profile
- shared staging: use the `Small Team` profile
- privacy-sensitive shared environment: use the `Privacy-Strict` profile

## Recommended First Deploy

1. Start in `record-only` mode.
2. Verify alias creation, outbound send, outbox listing.
3. Enable `DATA_ENCRYPTION_KEY_B64`.
4. Verify restart persistence.
5. Add SMTP config and validate one real outbound message.
6. Add IMAP config and validate one real inbound sync.

## Fastmail Assisted Live Run

If you are running the first provider-backed Fastmail verification locally, prefer:

```bash
./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

This helper keeps the operator sequence consistent:

- env preflight validation
- service startup with artifact tracking
- manual SMTP/IMAP live actions pause
- postcheck evidence + report bootstrap
- clean shutdown

## Files Created By The Service

- `aliases.json`
- `submissions.json`
- `relay-attempts.json`
- `audit-events.json`
- `identity-links.json`
- `outbox.json`
- `inbox.json`
- `imap-sync-state.json`

With encryption enabled, file contents are stored as encrypted envelopes rather than readable JSON payloads.

## Failure Hints

If outbound mail is accepted but not delivered:

- verify `SMTP_HOST`, credentials, and STARTTLS support
- verify `ALIAS_DOMAIN` is acceptable to the relay
- verify recipient mailbox acceptance outside the app

If inbound sync returns `501`:

- IMAP credentials are not fully configured

If inbound sync returns `500`:

- verify IMAP host, credentials, TLS reachability, and mailbox contents
- remember that the API now returns the generic payload `{"error":"internal server error"}`
- use server-side logs for the detailed failure cause

If a channel looks wrong in `GET /v1/channels`:

- inspect `GET /v1/aliases/{id}/timeline`
- then inspect `GET /v1/messages/inbox/{id}/timeline` for a specific inbound record
- check retention settings before assuming data loss

If state does not survive restart:

- verify `DATA_DIR`
- verify file permissions
- verify the same `DATA_ENCRYPTION_KEY_B64` is reused after restart

## Cross-References

- [DEPLOYMENT-MODES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DEPLOYMENT-MODES.md)
- [OPERATOR-QUERY-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-QUERY-COOKBOOK.md)
- [DATA-RETENTION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DATA-RETENTION-NOTES.md)
- [TENANT-ISOLATION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/TENANT-ISOLATION-NOTES.md)

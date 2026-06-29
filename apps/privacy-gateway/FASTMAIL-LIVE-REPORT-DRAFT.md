# Privacy Gateway Fastmail Live Verification Report

Last updated: 2026-04-04

## How To Fill This Draft

Use this order:

1. run assisted verification:
   - `./scripts/fastmail-live-assist.sh ./.env.fastmail.local`
2. open the latest artifact directory from `./artifacts/last-run-path.txt`
3. fill `Run Metadata` and `Configuration Summary`
4. complete each result section using the artifact file listed in that section
5. set explicit `PASS` or `FAIL` values in `Overall Decision`
6. update RC documents if the decision changed

## Artifact Quick Map

- service health: `healthz.json`
- alias and channel state: `aliases.json`, `channels.json`, `alias-timeline.json`
- submission lifecycle: `submissions.json`, `submission.json`, `submission-timeline.json`
- inbox lifecycle: `inbox.json`, `inbox-timeline.json`
- intake read-models (optional): `intake-dashboard.json`, `intake-queue.json`, `intake-submission.json`, `intake-submission-timeline.json`
- run IDs and timing: `metadata.txt`

## Run Metadata

- Provider: `Fastmail`
- Date: `TBD`
- Operator: `TBD`
- Environment: `TBD`
- Service version or commit: `TBD`

## Configuration Summary

- `ALIAS_DOMAIN`: `TBD`
- `DATA_DIR`: `TBD`
- encryption at rest enabled: `TBD`
- outbound mode: `smtp`
- SMTP host: `smtp.fastmail.com`
- IMAP host: `imap.fastmail.com`

Sensitive values such as passwords and app tokens must not be pasted into this report.

## Verification Scope

This run is expected to cover:

- alias setup
- native submission create and relay through Fastmail SMTP
- inbound IMAP plain-text sync through Fastmail
- inbound attachment metadata sync through Fastmail
- restart persistence
- incremental sync
- privacy-first read-model coherence

## Test Subjects Used

- outbound message: `PG FASTMAIL SMTP LIVE 1`
- inbound plain-text message: `PG FASTMAIL IMAP LIVE 1`
- inbound attachment message: `PG FASTMAIL IMAP ATTACHMENT 1`
- incremental message: `PG FASTMAIL IMAP INCREMENTAL 1`

## Results

### 1. Health Check

- expected result: `GET /healthz` returns `200`
- actual result (`PASS/FAIL`): `TBD`
- evidence file: `healthz.json`
- notes: `TBD`

### 2. Alias Flow

- expected result: alias create returns `201`
- alias created (`PASS/FAIL`): `TBD`
- alias listed after creation (`PASS/FAIL`): `TBD`
- alias domain correct (`PASS/FAIL`): `TBD`
- evidence files: `aliases.json`, `channels.json`, `alias-timeline.json`
- notes: `TBD`

### 3. Native Submission Relay Verification

- expected result: submission create returns `201` and relay transitions submission to `relayed`
- submission create returned `201` (`PASS/FAIL`): `TBD`
- submission relay action accepted (`PASS/FAIL`): `TBD`
- submission status after relay (`PASS/FAIL`): `TBD`
- outbox recorded relayed `PG FASTMAIL SMTP LIVE 1` (`PASS/FAIL`): `TBD`
- real recipient mailbox received exactly one expected message (`PASS/FAIL`): `TBD`
- sender/domain behavior acceptable (`PASS/FAIL`): `TBD`
- evidence files: `submissions.json`, `submission.json`, `submission-timeline.json`, `outbox.json`
- notes: `TBD`

### 4. IMAP Plain-Text Verification

- expected result: sync API returns `202`
- sync API returned `202` (`PASS/FAIL`): `TBD`
- inbox stored `PG FASTMAIL IMAP LIVE 1` (`PASS/FAIL`): `TBD`
- normalized `text_body` acceptable (`PASS/FAIL`): `TBD`
- IMAP cursor advanced (`PASS/FAIL`): `TBD`
- evidence files: `inbox.json`, `metadata.txt`
- notes: `TBD`

### 5. IMAP Attachment Verification

- expected result: safe attachment appears as metadata, not body payload
- attachment message appeared in inbox (`PASS/FAIL`): `TBD`
- text body excluded attachment payload (`PASS/FAIL`): `TBD`
- attachment metadata present (`PASS/FAIL`): `TBD`
- attachment policy outcome present (`PASS/FAIL`): `TBD`
- result acceptable (`PASS/FAIL`): `TBD`
- evidence files: `inbox.json`, `inbox-timeline.json`
- notes: `TBD`

### 6. Restart Persistence Verification

- expected result: aliases, outbox, and inbox survive restart
- aliases survived restart (`PASS/FAIL`): `TBD`
- outbox survived restart (`PASS/FAIL`): `TBD`
- inbox survived restart (`PASS/FAIL`): `TBD`
- encrypted state reopened successfully (`PASS/FAIL`): `TBD`
- evidence files: `aliases.json`, `outbox.json`, `inbox.json`
- notes: `TBD`

### 7. Incremental Sync Verification

- expected result: only the new message is added after the follow-up sync
- new message appeared after second sync (`PASS/FAIL`): `TBD`
- old messages were not duplicated unexpectedly (`PASS/FAIL`): `TBD`
- cursor advanced again (`PASS/FAIL`): `TBD`
- evidence files: `inbox.json`, `metadata.txt`
- notes: `TBD`

### 8. Privacy-First Read-Model Verification

- expected result: channel and inbox timelines remain coherent after the live run
- alias timeline acceptable (`PASS/FAIL`): `TBD`
- inbox timeline acceptable (`PASS/FAIL`): `TBD`
- channels feed acceptable (`PASS/FAIL`): `TBD`
- intake dashboard/queue acceptable when enabled (`PASS/FAIL/NA`): `TBD`
- evidence files: `channels.json`, `alias-timeline.json`, `submission-timeline.json`, `inbox-timeline.json`, `intake-*.json` (optional)
- notes: `TBD`

## Evidence Summary

- artifact directory: `TBD`
- `metadata.txt` reviewed: `yes/no`
- core files present (`healthz`, `aliases`, `submissions`, `outbox`, `inbox`, `channels`, timelines): `yes/no`
- intake files present when token configured: `yes/no/na`
- mailbox-side manual confirmation captured: `yes/no`

## Issues Found

1. `none` or `TBD`
2. `none` or `TBD`
3. `none` or `TBD`

## Fastmail-Specific Caveats

- app password required instead of account password: `TBD`
- sender domain behavior versus `ALIAS_DOMAIN`: `TBD`
- any provider-specific quirks observed: `TBD`

## Overall Decision

- native submission relay verification: `PASS/FAIL`
- inbound IMAP verification: `PASS/FAIL`
- restart persistence: `PASS/FAIL`
- incremental sync: `PASS/FAIL`
- privacy-first read-model verification: `PASS/FAIL`
- overall live verification: `PASS/FAIL`

## Release Recommendation

Choose one:

- release candidate can be frozen now
- release candidate can be frozen after minor fixes
- do not freeze release candidate yet

Selected recommendation: `TBD`

## Follow-Up Actions

1. `TBD`
2. `TBD`
3. `TBD`

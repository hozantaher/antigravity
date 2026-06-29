# Privacy Gateway Live Verification Plan

## Purpose

This plan defines the final real-infrastructure verification needed before calling the current build an MVP release candidate.

This is the canonical provider-agnostic verification scope document.

Use it for:

- what live verification must prove
- pass and fail criteria
- evidence expectations

For operator sequencing and document selection, use:

- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)

It is provider-agnostic by design.
It should work with any SMTP/IMAP-capable provider as long as:

- SMTP relay credentials are available
- IMAP mailbox credentials are available
- the chosen alias domain is compatible with the outbound provider setup

## Verification Goal

Prove that the existing MVP works not only in tests and local persistence, but also against real provider infrastructure for:

1. native submission create and relay over real SMTP infrastructure
2. inbound IMAP sync
3. persistence across restart
4. attachment metadata and policy behavior on a real inbound message
5. privacy-first read-model coherence across channel and inbox timelines

## Assumed Environment

One release-candidate environment with:

- the current service build
- writable `DATA_DIR`
- stable `DATA_ENCRYPTION_KEY_B64`
- one bearer token for the test actor
- one real SMTP-capable account or relay
- one real IMAP-capable mailbox

Recommended test identities:

- sender alias domain: controlled by the operator
- recipient mailbox: a separate mailbox you can inspect manually
- IMAP mailbox: same recipient mailbox or a dedicated test inbox

## Required Inputs

Before starting, collect these values:

- base URL of the running service
- bearer token
- `ALIAS_DOMAIN`
- `DATA_DIR`
- `DATA_ENCRYPTION_KEY_B64`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`
- `SMTP_HELLO_DOMAIN`
- `IMAP_HOST`
- `IMAP_PORT`
- `IMAP_USERNAME`
- `IMAP_PASSWORD`
- one real recipient email address

## Provider Readiness Checks

Do these before running the actual app test:

- confirm the SMTP provider accepts authenticated relay from the chosen account
- confirm the SMTP provider allows the effective sender domain strategy used by `ALIAS_DOMAIN`
- confirm the IMAP mailbox can be reached with TLS and the provided credentials
- confirm the recipient mailbox is empty enough that new test messages are easy to identify

## Test Messages To Prepare

Prepare 3 real messages:

### Message A: Outbound Plain Text

- subject: `PG SMTP LIVE 1`
- body: unique plain-text line with timestamp

### Message B: Inbound Plain Text

- subject: `PG IMAP LIVE 1`
- body: unique plain-text line with timestamp

### Message C: Inbound With Attachment

- subject: `PG IMAP LIVE ATTACHMENT`
- body: short plain-text note
- one safe attachment such as `sample.pdf` or `sample.png`

## Execution Plan

### Phase 1: Start Service

1. configure the service with real SMTP and IMAP values
2. start the service
3. confirm `GET /healthz` returns `200`

Evidence to capture:

- startup command used
- effective mode and key env values redacted as needed
- health response

### Phase 2: Alias Flow

1. create a new alias via `POST /v1/aliases`
2. list aliases via `GET /v1/aliases`
3. save the created `alias_id`

Pass criteria:

- alias creation returns `201`
- alias list returns `200`
- alias domain matches expected configuration

### Phase 3: Native Submission Relay Verification

1. create Submission A through `POST /v1/submissions`
2. relay Submission A through `POST /v1/submissions/{id}/relay`
3. inspect `GET /v1/submissions/{id}`
4. inspect the real recipient mailbox manually

Pass criteria:

- submission create returns `201`
- relay action returns `200`
- submission reaches `relayed`
- recipient mailbox receives exactly one expected message
- sender identity matches the expected alias routing strategy

Failure criteria:

- submission relay reports success but mailbox receives nothing
- provider rewrites sender/domain in a way that breaks MVP assumptions

Evidence to capture:

- submission create response
- submission relay response
- submission detail excerpt after relay
- mailbox screenshot or operator note with exact subject and arrival time

### Phase 4: IMAP Plain-Text Verification

1. place Message B into the IMAP mailbox
2. call `POST /v1/messages/inbox/sync`
3. inspect `GET /v1/messages/inbox`
4. inspect `GET /v1/channels`

Pass criteria:

- sync returns `202`
- inbox returns `200`
- Message B appears with readable normalized `text_body`
- channel feed shows at least one alias channel with `inbox_count > 0`
- `imap-sync-state.json` advances after sync

Evidence to capture:

- sync response
- inbox response excerpt for Message B
- cursor file existence and updated timestamp

### Phase 5: IMAP Attachment Verification

1. place Message C into the IMAP mailbox
2. call `POST /v1/messages/inbox/sync` again
3. inspect `GET /v1/messages/inbox`
4. if a correlated reply exists, inspect `GET /v1/messages/inbox/{id}/timeline`

Pass criteria:

- Message C appears
- `text_body` contains only normalized message text, not raw attachment payload
- attachment metadata is present
- attachment policy outcome is present
- inbox timeline remains readable and does not regress when attachment metadata is present

Expected result:

- safe document/image attachments should appear as metadata with `allowed_metadata` or equivalent non-blocked action

Evidence to capture:

- inbox response excerpt for Message C
- attachment metadata fields

### Phase 6: Restart Persistence Verification

1. stop the service
2. start it again with the same env values
3. list aliases, outbox, and inbox again
4. inspect `GET /v1/channels` again

Pass criteria:

- prior alias still exists
- prior outbox message still exists
- prior inbox messages still exist
- channel summaries still reflect prior inbound and outbound activity
- encrypted state remains readable only with the same encryption key

### Phase 7: Incremental Sync Verification

1. place one additional inbound message after previous syncs
2. call `POST /v1/messages/inbox/sync`
3. verify only the new message is newly added
4. inspect `GET /v1/channels?has_inbox=true`

Pass criteria:

- incremental sync completes successfully
- previously synced messages are not duplicated unexpectedly
- cursor advances again
- filtered channel feed remains consistent with the new inbound state

### Phase 8: Privacy-First Read-Model Verification

1. inspect `GET /v1/aliases/{id}/timeline` for the alias created in Phase 2
2. inspect `GET /v1/messages/inbox/{id}/timeline` for at least one inbound message
3. inspect `GET /v1/channels?has_inbox=true`

Pass criteria:

- alias timeline shows a coherent channel view across submissions, inbox, relay attempts, and audit events
- inbox timeline shows the inbound message plus linked submission context when available
- channels feed exposes usable operator summary data without additional manual stitching

## Exit Criteria

The live verification is `PASS` only if all of these are true:

- native submission relay passed
- IMAP plain-text sync passed
- IMAP attachment metadata sync passed
- restart persistence passed
- incremental sync passed
- privacy-first read-model verification passed

The live verification is `FAIL` if any one of these is false.

## Deliverables From The Run

At the end of the run, record:

- provider used
- date/time of run
- whether native submission relay passed
- whether IMAP passed
- whether restart persistence passed
- whether incremental sync passed
- any provider-specific caveats discovered

## Recommended Provider Notes Template

Use this short template after the run:

```md
Provider:
Date:
Native submission relay result:
IMAP result:
Attachment policy result:
Restart persistence result:
Incremental sync result:
Observed caveats:
Decision:
```

## Next Step After Successful Run

If this plan passes end-to-end:

- mark live provider verification complete in the release checklist
- freeze the current build as the first MVP release candidate

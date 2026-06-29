# State Files Reference

## Purpose

This is the shortest reference for the local state files under `DATA_DIR`.

Use it when you need to answer:

- what each JSON snapshot file is for
- which runtime subsystem owns it
- what it means if the file exists, grows, or stays empty

By default these files live under:

- `data/`

When `DATA_ENCRYPTION_KEY_B64` is configured, file contents are stored as encrypted envelopes instead of plaintext JSON.

## Files

### `aliases.json`

Owned by:

- alias service

Purpose:

- stores tenant-scoped alias records created through `POST /v1/aliases`

What to expect:

- one entry per alias
- persisted across restarts
- used by legacy `/v1/messages` flow and alias lookups

Typical meaning if empty:

- no aliases have been created yet for the current environment

### `submissions.json`

Owned by:

- submission service

Purpose:

- stores submission records created through `POST /v1/submissions`
- also stores compatibility-path submission records as the privacy-first model grows

What to expect:

- one entry per submission
- submission lifecycle fields such as `status`, `source_path`, `relay_provider`, `relay_attempt_id`, and `relayed_at`

Typical meaning if growing:

- the intake side of the system is actively accepting or relaying work

### `relay-attempts.json`

Owned by:

- relay service

Purpose:

- stores tenant-scoped relay attempt records for sent and failed delivery tries

What to expect:

- one entry per relay attempt
- provider, submission, alias, and failure metadata
- useful for inspecting relay lifecycle independently of submission summary fields

Typical meaning if growing:

- relay-backed transport is actively attempting delivery

### `identity-links.json`

Owned by:

- identity vault

Purpose:

- stores alias-to-real-identity linkage records

What to expect:

- tenant-scoped identity link entries
- lifecycle fields such as `expires_at` and `revoked_at`
- active links are visible through the public read endpoints; expired or revoked links remain persisted but are hidden from active reads

Typical meaning if present:

- the environment has started using the privacy-first identity separation model

### `audit-events.json`

Owned by:

- audit service

Purpose:

- stores tenant-scoped audit trail events

What to expect:

- append-only style event records
- event metadata for create, revoke, sanitize, and other lifecycle actions
- read-time retention filtering is applied by the service, so older persisted rows may exist even if they no longer appear in API results

Typical meaning if growing:

- system activity is being recorded correctly

### `outbox.json`

Owned by:

- mail gateway

Purpose:

- stores recorded outbound message records

What to expect:

- in `record-only` mode, accepted outbound messages appear here
- in SMTP mode, only successfully relayed messages are recorded here

Typical meaning if empty:

- no successful outbound message records have been captured yet

### `inbox.json`

Owned by:

- inbox store

Purpose:

- stores normalized inbound mailbox records

What to expect:

- one record per stored inbound message
- normalized text body
- attachment metadata only, not raw attachment payloads
- policy outcome fields on attachments

Typical meaning if growing:

- IMAP sync is ingesting mail successfully, or local test data has been written

### `imap-sync-state.json`

Owned by:

- IMAP sync cursor store

Purpose:

- stores the last processed provider checkpoint per actor

What to expect:

- persisted cursor data, not full messages
- used to continue IMAP sync incrementally after restart

Typical meaning if absent:

- IMAP sync has never run yet in this environment

## Operational Notes

- files are written atomically
- files are created with restrictive permissions
- directories are created with restrictive permissions
- in encrypted mode, file contents are not human-readable without the same key
- in plaintext mode, these files should still be treated as sensitive local state

## Practical Heuristics

If `submissions.json` grows but `audit-events.json` does not:

- submission intake may be persisting while audit recording is broken or bypassed

If `identity-links.json` has entries but `GET /v1/identity-links` returns empty:

- links may be expired or revoked rather than missing

If `inbox.json` grows but `imap-sync-state.json` does not:

- inbound sync behavior may not be checkpointing correctly

If `outbox.json` stays empty in SMTP mode:

- relay attempts may be failing before the gateway records success
- check `relay-attempts.json` for failed attempts and failure metadata

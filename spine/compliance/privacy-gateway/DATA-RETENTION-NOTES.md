# Data Retention Notes

## Purpose

This is the shortest explanation of current data retention behavior in the service.

Use it when you need to answer:

- what data is actually deleted today
- what data is only hidden at read time
- which persisted files currently grow without a true prune mechanism

## Retention Posture Summary

The current system has a mixed retention model:

- some data is filtered at read time
- some data is retained indefinitely unless files are manually removed
- no general background prune job exists yet

This means current retention is partly operational policy and partly implementation gap.

## What Has Real Retention Enforcement

### Audit Events

Current behavior:

- `AUDIT_RETENTION_HOURS` is enforced by the audit service
- old events are pruned from persisted storage when audit activity occurs
- filtered audit reads also trigger prune enforcement

Operational meaning:

- old audit rows do not just disappear from API reads
- they are physically removed from `audit-events.json` during normal service activity

## What Has Lifecycle Filtering But Not Physical Deletion

### Identity Links

Current behavior:

- expired links are hidden from active reads
- revoked links are hidden from active reads
- detail lookup collapses expired and revoked links to `404`
- optional `IDENTITY_LINK_RETENTION_HOURS` enables physical prune of old inactive links during normal identity-vault activity

Important limitation:

- with the default `IDENTITY_LINK_RETENTION_HOURS=0`, inactive links remain stored in `identity-links.json`
- prune only applies after the configured retention window and only when identity-vault activity triggers it

Operational meaning:

- active API views are smaller than raw persisted state
- inactive identity records still exist at rest unless opt-in retention is enabled

### IMAP Cursor State

Current behavior:

- cursor records are updated incrementally for active sync behavior
- optional `IMAP_CURSOR_RETENTION_HOURS` enables physical prune of stale cursor entries during normal cursor activity
- legacy cursor files without timestamps are still readable and are upgraded on the next write

Important limitation:

- with the default `IMAP_CURSOR_RETENTION_HOURS=0`, stale cursor entries remain stored indefinitely
- prune only applies after the configured retention window and only when cursor activity triggers it

Operational meaning:

- old checkpoint state may survive long after a mailbox stops being used unless opt-in retention is enabled

## What Is Currently Retained Indefinitely

### Aliases

Current behavior:

- aliases persist in `aliases.json`
- no expiration, archival, or delete path exists yet

### Submissions

Current behavior:

- submissions persist in `submissions.json`
- optional `SUBMISSION_RETENTION_HOURS` enables physical prune of old terminal submissions during normal submission activity

Important limitation:

- with the default `SUBMISSION_RETENTION_HOURS=0`, submissions remain stored indefinitely
- current prune only targets old terminal states, currently `relayed` and `blocked`
- active states such as `accepted`, `queued`, and `sanitized` are intentionally retained

### Outbox Records

Current behavior:

- successful recorded sends persist in `outbox.json`
- optional `OUTBOX_RETENTION_HOURS` enables physical prune of old outbox rows during normal outbox activity

Important limitation:

- with the default `OUTBOX_RETENTION_HOURS=0`, outbox rows remain stored indefinitely
- prune applies only when outbox activity occurs

### Inbox Records

Current behavior:

- normalized inbound messages persist in `inbox.json`
- optional `INBOX_RETENTION_HOURS` enables physical prune of old inbox rows during normal inbox activity

Important limitation:

- with the default `INBOX_RETENTION_HOURS=0`, inbox rows remain stored indefinitely
- prune applies only when inbox activity occurs

Operational meaning for all of the above:

- these files will keep growing over time in active environments
- current retention is effectively manual unless external cleanup is applied

## Encryption Versus Retention

Encryption at rest is not retention.

Current behavior:

- `DATA_ENCRYPTION_KEY_B64` protects file contents at rest
- it does not reduce how long the data is stored
- it does not prune stale rows

Operational meaning:

- encrypted data can still be retained too long

## What Is Missing Today

The service does not yet have:

- scheduled pruning
- per-resource retention policies
- archive/export before delete flow
- inbox or outbox age-based deletion
- actor-level cursor cleanup

## Practical Debug Heuristics

If `GET /v1/audit-events` looks clean but `audit-events.json` is still large:

- prune may not have been triggered recently yet
- or non-audit state, not audit rows, may be the source of growth

If `GET /v1/identity-links` is empty but `identity-links.json` is not:

- stored links may be expired or revoked rather than absent

If `inbox.json`, `outbox.json`, or `submissions.json` keep growing:

- that is expected today because those files have no real prune path yet

## Current Operator Guidance

Treat current retention as conservative but incomplete:

- API read models already hide some stale or inactive data
- persisted files should still be treated as long-lived sensitive state
- local or operator environments should plan manual cleanup if long retention is undesirable

## Best Next Retention Improvements

The most useful next steps would be:

1. prune or archive policy for inactive identity links
2. broader scheduled retention for submissions, inbox, and outbox
3. cleanup for stale IMAP cursor records

Until then, the honest description is:

- audit retention is physically enforced during service activity
- identity-link inactivity is filtered by default and can now be physically pruned with opt-in retention
- submission retention is opt-in and currently prunes only old terminal states
- IMAP cursor retention is opt-in and prunes stale cursor checkpoints when enabled
- inbox and outbox retention are now opt-in and prune old records during normal store activity
- most other persisted state is durable by default

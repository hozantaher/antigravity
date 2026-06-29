# Retention Configuration Cookbook

## Purpose

This is the shortest practical guide for choosing retention settings across the service.

Use it when you need to answer:

- which retention profile fits the current environment
- which environment variables should be set together
- what `0` means for each retention control

## Retention Controls

The service currently exposes these retention settings:

- `AUDIT_RETENTION_HOURS`
- `IDENTITY_LINK_RETENTION_HOURS`
- `SUBMISSION_RETENTION_HOURS`
- `IMAP_CURSOR_RETENTION_HOURS`

Operational meaning:

- `0` means retention pruning is disabled for that store
- positive values mean old records are physically pruned during normal service activity

Important behavior:

- audit retention is already enabled by default with `AUDIT_RETENTION_HOURS=168`
- identity-link retention is opt-in and only prunes old inactive links
- submission retention is opt-in and only prunes old terminal states, currently `relayed` and `blocked`
- IMAP cursor retention is opt-in and only prunes stale cursor checkpoints

## Recommended Profiles

### Dev

Use when:

- you are debugging locally
- you want maximum inspectability
- disk growth is acceptable

Recommended settings:

```env
AUDIT_RETENTION_HOURS=168
IDENTITY_LINK_RETENTION_HOURS=0
SUBMISSION_RETENTION_HOURS=0
IMAP_CURSOR_RETENTION_HOURS=0
```

Why:

- keeps audit bounded enough for local work
- preserves other files for easier debugging and restart verification

### Small Team

Use when:

- a small internal team operates the service
- you want bounded growth without aggressive data loss
- operator review still matters more than shortest possible retention

Recommended settings:

```env
AUDIT_RETENTION_HOURS=336
IDENTITY_LINK_RETENTION_HOURS=720
SUBMISSION_RETENTION_HOURS=336
IMAP_CURSOR_RETENTION_HOURS=336
```

Why:

- keeps roughly 2 weeks of audit and submission history
- keeps identity links longer for operational continuity
- removes abandoned IMAP checkpoint state over time

### Privacy-Strict

Use when:

- minimizing stored sensitive state matters more than long operational history
- operators already understand that older state may disappear quickly
- you can tolerate shorter review windows

Recommended settings:

```env
AUDIT_RETENTION_HOURS=72
IDENTITY_LINK_RETENTION_HOURS=168
SUBMISSION_RETENTION_HOURS=72
IMAP_CURSOR_RETENTION_HOURS=72
```

Why:

- limits stored audit and submission history to a few days
- still gives identity links a slightly longer inactive window for orderly transitions
- keeps mailbox checkpoint state short-lived

### Investigation Window

Use when:

- you are temporarily debugging a production-like issue
- you want longer evidence retention for a limited period
- you plan to return to a tighter profile afterwards

Recommended settings:

```env
AUDIT_RETENTION_HOURS=720
IDENTITY_LINK_RETENTION_HOURS=1440
SUBMISSION_RETENTION_HOURS=720
IMAP_CURSOR_RETENTION_HOURS=720
```

Why:

- increases forensic visibility without permanently redefining the default posture
- gives operators time to correlate submissions, identity-link lifecycle, and audit history

## How To Choose

Choose `Dev` when:

- the environment is local
- restart and debugging visibility matter most

Choose `Small Team` when:

- the environment is shared but still operator-driven
- you want a balanced default

Choose `Privacy-Strict` when:

- data minimization is the primary operating principle
- short retention windows are acceptable

Choose `Investigation Window` when:

- you are diagnosing an incident
- you explicitly want longer temporary evidence retention

## Safe Starting Point

If you do not want to think too hard yet, start with:

```env
AUDIT_RETENTION_HOURS=168
IDENTITY_LINK_RETENTION_HOURS=720
SUBMISSION_RETENTION_HOURS=168
IMAP_CURSOR_RETENTION_HOURS=168
```

This is a conservative middle ground:

- audit stays bounded
- inactive identity links are eventually pruned
- terminal submissions do not grow forever
- IMAP cursor state does not remain forever once unused

## Important Caveats

Retention is activity-driven today:

- prune happens during normal service activity
- there is no general background scheduler yet

This means:

- old rows may remain slightly longer if the corresponding subsystem is idle
- reducing retention settings does not instantly rewrite every file at once

Retention also does not apply equally to every file:

- `outbox.json` now has opt-in age-based retention through `OUTBOX_RETENTION_HOURS`
- `inbox.json` now has opt-in age-based retention through `INBOX_RETENTION_HOURS`
- `aliases.json` still has no delete or expiration flow

## Practical Rollout Advice

When tightening retention in a shared environment:

1. change one profile as a deliberate operator decision
2. record the chosen values in deployment notes
3. watch file growth and operator usability for a few days
4. shorten further only if the team can still investigate incidents comfortably

## Cross-References

For current behavior details, see:

- [DATA-RETENTION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DATA-RETENTION-NOTES.md)
- [STATE-FILES-REFERENCE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/STATE-FILES-REFERENCE.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)

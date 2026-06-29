# ADR-005: Persistence Model — JSON Files vs. Database Migration Boundary

## Status: Accepted

## Context

Privacy-gateway uses JSON file-based persistence with optional AES-256-GCM encryption for all 8 data stores:

| Store | File | Retention | Access Pattern |
|-------|------|-----------|----------------|
| aliases | aliases.json | Configurable | Write-rarely, read-per-request |
| submissions | submissions.json | Configurable | Write-per-submit, read-per-dashboard |
| audit events | audit-events.json | 168h default | Append-heavy, read-per-dashboard |
| identity links | identity-links.json | Configurable | Write-rarely, read-per-request |
| inbox messages | inbox.json | Configurable | Write-per-sync, read-per-request |
| IMAP cursors | imap-sync-state.json | Configurable | Write-per-sync, read-per-sync |
| relay attempts | relay-attempts.json | Configurable | Append-per-relay, read-per-dashboard |
| outbox records | outbox.json | Configurable | Append-per-send, read-per-list |

All stores share the same pattern: in-memory slice/map + atomic JSON file write on mutation. Encryption is transparent via `filestore.Codec`.

## Decision

**Keep JSON file persistence as the production model.** Do not migrate to SQLite or Postgres unless one of the following thresholds is crossed:

### Migration Triggers (any one is sufficient)

1. **Row count > 10,000** in any single store — linear scan becomes measurably slow (>100ms for filtered list operations)
2. **Concurrent writers > 1 process** — JSON file atomicity assumes single-process ownership; multi-instance deployment requires shared state
3. **Cross-store queries needed** — joining aliases + submissions + audit in a single query requires relational semantics
4. **Backup/restore complexity** — if operators need point-in-time recovery, transaction logs, or incremental backups

### Why not migrate now

- **Current scale fits.** Single-operator deployment with <1000 records per store. Linear scan is sub-millisecond.
- **Encryption is transparent.** AES-256-GCM wraps the entire JSON payload. Database encryption (TDE, column-level) is significantly more complex.
- **Zero external dependencies.** No connection strings, no driver packages, no migration tooling, no backup scripts.
- **Atomic writes are sufficient.** `WriteJSONAtomic` (write-to-temp + rename) provides crash-safe persistence for single-process operation.
- **Retention pruning works.** All 8 stores now have `PruneBefore` methods with configurable retention, preventing unbounded growth.

### If migration is triggered

1. **SQLite first** — embedded, single-file, no network dependency. Preserves zero-external-dependency property.
2. **Postgres only if** multi-instance deployment or cross-service shared state is needed.
3. **Migration path:** Add `Repository` interface implementations backed by SQL. The existing interface-based architecture (`alias.Repository`, `relay.Repository`, `submission.Repository`) supports drop-in replacement without changing business logic.

## Alternatives Considered

1. **Migrate to SQLite now** — Rejected because: adds build complexity (CGo or pure-Go driver), migration tooling, and testing infrastructure for no measurable benefit at current scale.
2. **Migrate to Postgres now** — Rejected because: adds external dependency, connection management, credential management, and operational overhead. Contradicts the self-contained deployment story.
3. **Use BoltDB/bbolt** — Rejected because: key-value semantics don't improve over JSON for the current access patterns (mostly full-collection scans with retention pruning).

## Consequences

- Operators must monitor file sizes. If any JSON file exceeds ~1MB (roughly 10K records), performance should be re-evaluated.
- Multi-instance deployment is explicitly not supported until this ADR is superseded.
- The `Repository` interface pattern must be maintained for all new stores to preserve the migration path.

## Review Date: After Phase A RC decision, or when any migration trigger is observed.

# Migration Rollout — 005 + 007 (next ops window)

> **Created**: 2026-04-25 (post PR #25 merge)
> **Audience**: Operator (Tomáš).
> **Scope**: apply pending migrations in the correct order against
> production Postgres on Railway.
> **NOT executed by Claude.** This file is a runbook.

## What's pending

After PR #25 merge, two new migration files need to be applied to prod:

| ID | File | Purpose | Risk |
|---|---|---|---|
| 005 | `005_contacts_status_sync.sql` | Backfill `contacts.status='suppressed'` from `outreach_suppressions` + INSERT trigger to keep them in sync | LOW (chunked 50k, idempotent) |
| 007 | `007_campaign_lock_audit.sql` | New `campaign_lock_audit` table + cleanup function | LOW (CREATE TABLE IF NOT EXISTS, idempotent) |

Migration 006 (`seed_multi_mailbox_pool.sql`) is operator-driven —
DO NOT auto-apply. It seeds new mailbox skeletons; needs operator
review of the values first.

## Pre-flight (read-only, safe)

```bash
# 1. Verify schema_migrations table exists, bootstrap if not.
psql "$DATABASE_URL" -X -c "
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'schema_migrations'
  );
"

# If false → bootstrap (safe, idempotent):
psql "$DATABASE_URL" -X -f scripts/migrations/000_schema_migrations.sql
```

```bash
# 2. Backfill schema_migrations for already-applied migrations (one-time).
# This unblocks the run.sh predecessor check on existing deployments.
# Confirm 001..004 + 006 have actually been applied before running this.
psql "$DATABASE_URL" -X <<SQL
INSERT INTO schema_migrations(migration_id, filename, content_sha256, applied_by)
VALUES
  ('001', '001_drop_campaign_enrollments.sql',     'manual-backfill', 'ops'),
  ('002', '002_cleanup_contacts_first_name.sql',    'manual-backfill', 'ops'),
  ('003', '003_encrypt_mailbox_passwords.sql',      'manual-backfill', 'ops'),
  ('004', '004_populate_mailbox_password_encrypted.sql', 'manual-backfill', 'ops'),
  ('006', '006_seed_multi_mailbox_pool.sql',        'manual-backfill', 'ops')
ON CONFLICT (migration_id) DO NOTHING;
SQL
```

```bash
# 3. Dry-run: confirm the runner sees only 005 + 007 as pending.
scripts/migrations/run.sh --dry-run
```

Expected output:
```
── Pending: 005 007
── DRY-RUN — would apply (in order):
    005  scripts/migrations/005_contacts_status_sync.sql
    007  scripts/migrations/007_campaign_lock_audit.sql
```

If the dry-run shows anything else (e.g. predecessor missing, drift),
**stop** and investigate before proceeding.

## Apply (destructive)

After dry-run is clean:

```bash
# Optionally: tag the deploy SHA so the audit row records it.
export GIT_SHA="$(git rev-parse --short HEAD)"
export APPLIED_BY="ops"

# Apply both migrations in order.
scripts/migrations/run.sh
```

The runner wraps each migration + its bookkeeping INSERT in a single
transaction, so a partial-apply doesn't leave the table inconsistent.

## Post-flight (verification)

```sql
-- 1. schema_migrations should now include 005 + 007.
SELECT migration_id, filename, applied_at, applied_by
FROM schema_migrations
ORDER BY migration_id;

-- 2. BF-E3 sweep: should be 0.
SELECT COUNT(*) FROM contacts c
WHERE c.status NOT IN ('suppressed','replied','blacklisted')
  AND lower(trim(c.email)) IN (
    SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL
  );

-- 3. BF-E3 trigger sanity: insert a test suppression, verify mirror.
BEGIN;
INSERT INTO outreach_suppressions(email, reason)
VALUES ('e3-test-' || extract(epoch from now())::bigint || '@example.com', 'manual');
SELECT status FROM contacts
WHERE lower(trim(email)) = 'e3-test-' || (
  SELECT extract(epoch from MAX(applied_at))::bigint FROM schema_migrations
  WHERE migration_id = '005'
) || '@example.com';
ROLLBACK;  -- discard test row

-- 4. BF-E4 lock audit table exists.
SELECT table_name FROM information_schema.tables
 WHERE table_name = 'campaign_lock_audit';

-- 5. BF-E4 cleanup function exists + callable.
SELECT campaign_lock_audit_cleanup_stale();  -- returns rows-removed count
```

## Rollback

Migrations 005 + 007 are additive (no DROPs in 005 sweep; pure INSERTs into
contacts via trigger; no destructive DDL). Rollback if needed:

```sql
-- 005 rollback (rare — only if trigger misbehaves)
DROP TRIGGER IF EXISTS bf_e3_mirror_suppression ON outreach_suppressions;
DROP FUNCTION IF EXISTS bf_e3_mirror_suppression_to_contacts();
-- The contacts.status backfill is data-only; no automatic revert. If
-- needed, restore from pre-migration backup or set status='new' WHERE
-- updated_at = (the migration timestamp) AND status='suppressed'.

-- 007 rollback
DROP FUNCTION IF EXISTS campaign_lock_audit_cleanup_stale();
DROP TABLE IF EXISTS campaign_lock_audit;
```

After any rollback, also remove the bookkeeping rows:

```sql
DELETE FROM schema_migrations WHERE migration_id IN ('005', '007');
```

## Records

| Date | Migration | Applied By | Notes |
|---|---|---|---|
| 2026-04-25 | runbook drafted | Claude | post PR #25 merge |
| | | | |

---

## Addendum — 099 one-time prod compat migration (2026-05-01)

> **Trigger:** `column "migration_id" of relation "schema_migrations" does not exist` when applying 022/023/024.
> Prod DB was bootstrapped with legacy `(version text, applied_at timestamptz)` schema before BF-G3 runner was installed.

### What happened

Prod `schema_migrations` table has only two columns (`version`, `applied_at`). The BF-G3 runner (`run.sh`) expects the full schema from `000_schema_migrations.sql`:
`(migration_id, filename, content_sha256, applied_by, git_sha)`.

The runner was therefore failing with `column "migration_id" does not exist` on every INSERT.

### Fix (option B — preserve drift detection)

`099_schema_migrations_compat.sql` was added at a deliberately high migration number (099) so it sorts last and can be applied once manually, regardless of where 022–024 sit in the sequence. After 099 lands:

- All BF-G3 columns exist.
- Existing `version` rows are backfilled into `migration_id`.
- `content_sha256 = 'manual-backfill'` is set on pre-BF-G3 rows so drift detection skips them.
- Full drift detection (exit code 4) is re-enabled for all future migrations.

The runner also gained a backwards-compat shim: it probes `information_schema.columns` at startup and degrades gracefully to `version`-only INSERTs until 099 is applied, so in-flight runs don't crash.

### One-time prod apply procedure

```bash
# 1. Apply the compat migration manually (psql, not via run.sh).
#    This is safe — ADD COLUMN IF NOT EXISTS, idempotent UPDATEs.
psql "$DATABASE_URL" -X -f scripts/migrations/099_schema_migrations_compat.sql

# 2. Verify the schema now has all expected columns.
psql "$DATABASE_URL" -X -c "
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'schema_migrations'
  ORDER BY ordinal_position;
"
# Expected: id, migration_id, filename, content_sha256, applied_at, applied_by, git_sha, version

# 3. Verify existing rows were backfilled.
psql "$DATABASE_URL" -X -c "
  SELECT migration_id, version, content_sha256, applied_at
  FROM schema_migrations
  ORDER BY migration_id;
"
# migration_id should match version for every pre-BF-G3 row.

# 4. Dry-run the runner — should now show 022, 023, 024 (and 099 itself) as pending.
scripts/migrations/run.sh --dry-run

# 5. Apply pending migrations.
export GIT_SHA="$(git rev-parse --short HEAD)"
export APPLIED_BY="ops"
scripts/migrations/run.sh
```

### Post-apply verification

```sql
-- All rows should now have migration_id populated.
SELECT COUNT(*) FROM schema_migrations WHERE migration_id IS NULL;
-- Expected: 0

-- Drift detection active: run.sh --dry-run should complete without exit 4.
-- schema_migrations should include 099 row.
SELECT migration_id, content_sha256 FROM schema_migrations WHERE migration_id = '099';
```

### Drift detection re-enabled after 099

Once 099 is applied, the runner switches back to full-schema mode:
- `FULL_SCHEMA=1` (migration_id column found).
- Drift check queries `content_sha256` for every applied migration.
- Pre-BF-G3 rows use `'manual-backfill'` sentinel → drift check is skipped for them only.
- New migrations applied after 099 get real SHA-256 hashes → full drift protection.

| Date | Migration | Applied By | Notes |
|---|---|---|---|
| 2026-05-01 | 099 compat drafted | Claude | fix for prod column mismatch (BF-G runner) |

# S5.1 Mailbox Password Encryption — Phased Rollout

> **Why phased**: a broken decrypt at any step breaks ALL outbound sends.
> Each phase has rollback to the previous state.
>
> **Current state**: plaintext `outreach_mailboxes.password` (set during
> SEND-S1 unblock for mb=631/632). Migration 003 introduces encrypted
> column without removing plaintext.

## Phases

```
Phase 1 (003) ── add password_encrypted column ──> NULL on all rows ✓
Phase 2 (004) ── populate password_encrypted ──> both columns hold same value
Phase 3 (005) ── Go reads prefer encrypted ──> verify sends still work
Phase 4 (006) ── DROP plaintext password ──> migration complete
```

## Phase 1 — add column (safe)

```bash
psql "$DATABASE_URL" -f scripts/migrations/003_encrypt_mailbox_passwords.sql
```

**Effect**: `password_encrypted bytea` column added, NULL on all rows.
Nothing else changes. Sends still use plaintext.

**Rollback**: `ALTER TABLE outreach_mailboxes DROP COLUMN password_encrypted;`

## Phase 2 — populate encrypted (manual run)

Pre-requisites:
- Phase 1 applied
- `MAILBOX_SECRET_KEY` env var set on Railway (32+ char random)
  - Generate: `openssl rand -hex 32`
  - **Store in 1Password** — losing it means losing all mailbox passwords

```bash
export MAILBOX_SECRET_KEY="$(openssl rand -hex 32)"  # one-time generation
# Save to Railway env: railway variables set MAILBOX_SECRET_KEY=$MAILBOX_SECRET_KEY
# Save to 1Password: copy the value before losing terminal

psql "$DATABASE_URL" -v secret="$MAILBOX_SECRET_KEY" \
     -f scripts/migrations/004_populate_mailbox_password_encrypted.sql
```

**Effect**: every row's `password_encrypted = pgp_sym_encrypt(password, secret)`.
Plaintext column unchanged. Both columns hold same value.

**Verify**:
```sql
SELECT id, from_address,
       length(password) AS plaintext_len,
       length(password_encrypted) AS encrypted_len
FROM outreach_mailboxes
WHERE id IN (631, 632);
```

Both lengths should be > 0. encrypted_len ~= plaintext_len + 60 bytes overhead.

**Rollback**: `UPDATE outreach_mailboxes SET password_encrypted = NULL;`
(Plaintext is untouched.)

## Phase 3 — Go reads prefer encrypted

Update `features/outreach/mailboxes/mailbox/postgres.go` `mailboxColumns` to use
the priority expression:

```go
const passwordExpr = `COALESCE(
    CASE
        WHEN password_encrypted IS NOT NULL
             AND current_setting('app.mailbox_secret_key', true) <> ''
        THEN pgp_sym_decrypt(password_encrypted, current_setting('app.mailbox_secret_key'))
        ELSE NULL
    END,
    password,
    ''
)`
```

**Connection-level GUC**: pool needs to set `app.mailbox_secret_key`
on every checkout. For pgx, use `BeforeConnect` hook. For database/sql,
wrap each query that reads passwords with:
```go
tx, _ := db.BeginTx(ctx, nil)
tx.ExecContext(ctx, "SET LOCAL app.mailbox_secret_key = $1", secret)
// ... read mailboxes via tx ...
tx.Commit()
```

**Verify**: send-test from mb=631 + mb=632 to operator email. Both should
deliver. If failure: rollback Phase 3 commit, sends fall back to plaintext.

**Rollback**: revert Go code to use bare `password` column.

## Phase 4 — drop plaintext column (final)

After 30+ days of stable operation in Phase 3:

```sql
BEGIN;
ALTER TABLE outreach_mailboxes DROP COLUMN password;
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES ('schema_drop_column', 'migration', 'table',
        'outreach_mailboxes.password',
        '{"reason": "S5.1 phase 4 — encryption migration complete"}'::jsonb);
COMMIT;
```

**Effect**: plaintext column gone. Encrypted is single source of truth.

**Rollback impossible** — would need encrypt → decrypt → restore plaintext
which requires same secret. If secret was rotated between phase 3 and 4,
old encrypted column with old key would be decryptable; new password
column from operator UI updates would need fresh re-encrypt.

## Operational considerations

1. **Secret rotation**: every 12 months. To rotate:
   - Set MAILBOX_SECRET_KEY_NEW env
   - UPDATE rows: `password_encrypted = pgp_sym_encrypt(pgp_sym_decrypt(password_encrypted, OLD_KEY), NEW_KEY)`
   - Atomic: do in transaction
   - Update env to new key

2. **Backup**: Railway auto-backups Postgres. Encrypted column backed up
   transparently. Restore from backup → original key still decrypts.

3. **Disaster recovery if MAILBOX_SECRET_KEY lost**:
   - All mailbox passwords unrecoverable
   - Operator must regenerate Seznam app passwords + re-enter via UI
   - No data loss for contacts/campaigns/sends — only credentials

4. **Audit**: every phase's migration writes to `operator_audit_log` so the
   change is traceable.

## Schedule recommendation

- Day 0: Phase 1 (low risk, just adds column)
- Day 1-3: Set MAILBOX_SECRET_KEY env, store in 1Password
- Day 4: Phase 2 (populate encrypted)
- Day 5-7: Phase 3 (Go reads encrypted) — DO NOT MERGE if any send-test fails
- Day 30+: Phase 4 (drop plaintext) once confident

## Rollback playbook

If sends start failing after any phase, immediate steps:
1. Revert latest Go deploy (Railway: rollback to previous deploy)
2. If schema change: run `\set ON_ERROR_STOP on` and reverse migration
3. Test send-test
4. Investigate root cause before re-attempting

-- 065_email_verify_state.sql
--
-- Sprint AM1: schema + state machine foundation for contact deliverability
-- verify loop (initiative 2026-05-08-contact-deliverability-verify-loop.md).
--
-- Adds three columns to `contacts` for the loop's due-picker + retry logic:
--   - email_verify_priority  — higher = picked sooner (default 50)
--   - email_verify_attempts  — count of probe attempts (used by exponential backoff)
--   - email_verify_next_at   — when the next verify is scheduled (loop's primary
--                              picker key)
--
-- Adds CHECK constraint enumerating valid email_status values to prevent drift.
--
-- Adds composite index for fast due-picking by the loop:
--   WHERE email_verify_next_at <= NOW() AND email_status NOT IN ('bounce_hold', ...)
--   ORDER BY email_verify_priority DESC, email_verify_next_at ASC
--
-- Adds new table `email_verify_domain_quarantine` for per-domain backoff state
-- (3 timeouts in 1h → quarantine 24h, set by AM2 loop).
--
-- Backfill: every existing contact gets email_verify_next_at=NOW() so the loop
-- picks them up on first tick. Priority defaults to 50 (regular re-verify);
-- AM5 will introduce per-source priority bumps.
--
-- Predecessor: 065_outreach_mailboxes_preferred_country.sql (Sprint AN per-mailbox country affinity).

BEGIN;

-- ── Columns on contacts ─────────────────────────────────────────────────────

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_verify_priority INT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS email_verify_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_verify_next_at TIMESTAMPTZ;

-- ── State machine constraint ────────────────────────────────────────────────
--
-- email_status values:
--   unverified  — never probed (initial state for new imports)
--   verifying   — probe in flight (loop sets, clears within tick)
--   valid       — deliverable, non-role mailbox (high confidence)
--   role_only   — deliverable but role-based (info@, obchod@) — lower priority
--   risky       — temp errors / SMTP timeout — retry per backoff
--   invalid     — no MX, syntax invalid, hard bounce, disposable — never send
--   spamtrap    — known honeypot domain match — never send
--   bounce_hold — 5+ consecutive bounces — operator must explicitly reset
--
-- Drop previous constraint if exists (idempotency for re-runs).
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_email_status_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_email_status_check CHECK (
    email_status IS NULL OR email_status IN (
      'unverified', 'verifying', 'valid', 'role_only',
      'risky', 'invalid', 'spamtrap', 'bounce_hold',
      'suppressed'  -- legacy from outreach_suppressions sync; kept for backward compat
    )
  );

-- ── Index for due-picker (the loop's hot-path query) ───────────────────────
--
-- WHERE email_verify_next_at <= NOW() AND email_status NOT IN ('bounce_hold', 'spamtrap')
-- ORDER BY email_verify_priority DESC, email_verify_next_at ASC
-- LIMIT batch_size

CREATE INDEX IF NOT EXISTS idx_contacts_verify_due
  ON contacts (email_verify_next_at, email_verify_priority DESC)
  WHERE email_verify_next_at IS NOT NULL
    AND email_status NOT IN ('bounce_hold', 'spamtrap');

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Every contact without a scheduled verify time gets NOW() so the loop picks
-- them up on first tick (subject to rate limits).

UPDATE contacts
   SET email_verify_next_at = NOW()
 WHERE email_verify_next_at IS NULL
   AND (email_status IS NULL OR email_status IN ('unverified', 'risky'));

-- Already-verified contacts get NOW() + 90 days so they enter the re-verify
-- cycle at the right cadence rather than hammering on first tick.
UPDATE contacts
   SET email_verify_next_at = NOW() + INTERVAL '90 days'
 WHERE email_verify_next_at IS NULL
   AND email_status = 'valid';

UPDATE contacts
   SET email_verify_next_at = NOW() + INTERVAL '180 days'
 WHERE email_verify_next_at IS NULL
   AND email_status = 'role_only';

-- ── Domain quarantine table ─────────────────────────────────────────────────
--
-- AM2 loop will INSERT a row when a domain returns 3 timeouts in 1h.
-- Loop checks this table before probing — if quarantine_until > NOW(), skip
-- contacts on that domain.

CREATE TABLE IF NOT EXISTS email_verify_domain_quarantine (
  domain            TEXT NOT NULL PRIMARY KEY,
  quarantine_until  TIMESTAMPTZ NOT NULL,
  reason            TEXT NOT NULL,
  failure_count     INT NOT NULL DEFAULT 0,
  first_failure_at  TIMESTAMPTZ,
  last_failure_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Plain index on quarantine_until — Postgres rejects NOW() in partial index
-- predicate ("functions in index predicate must be marked IMMUTABLE"). Full
-- index works fine for the loop's "WHERE quarantine_until > NOW()" lookup
-- (table stays small; quarantine entries TTL via UPDATE not DELETE).
CREATE INDEX IF NOT EXISTS idx_evdq_quarantine_until
  ON email_verify_domain_quarantine (quarantine_until);

-- ── schema_migrations row ──────────────────────────────────────────────────

INSERT INTO schema_migrations (version)
VALUES ('066_email_verify_state')
ON CONFLICT (version) DO NOTHING;

COMMIT;

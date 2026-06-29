-- 067_email_verification_log_contact_id.sql
--
-- Sprint AM2: extend email_verification_log to support contact rows.
--
-- email_verification_log was originally COMPANY-ONLY (column company_ico,
-- no contact_id). AM2 adds contact_id so the runContactVerifyCron can
-- record verification events per-contact in the same audit table.
--
-- The column is nullable — existing company rows are unaffected.
-- Index covers the daily-budget query (WHERE contact_id IS NOT NULL).
--
-- Predecessor: 066_email_verify_state.sql (Sprint AM1 — contacts schema).

BEGIN;

ALTER TABLE email_verification_log
  ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES contacts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_email_verif_log_contact
  ON email_verification_log (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

-- ── schema_migrations row ──────────────────────────────────────────────────

INSERT INTO schema_migrations (version)
VALUES ('067_email_verification_log_contact_id')
ON CONFLICT (version) DO NOTHING;

COMMIT;

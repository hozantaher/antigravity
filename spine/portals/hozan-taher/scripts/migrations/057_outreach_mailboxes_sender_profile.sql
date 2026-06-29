-- 057_outreach_mailboxes_sender_profile.sql
--
-- Adds sender_phone and sender_name columns to outreach_mailboxes.
--
-- Context (Sprint X1):
--   anonymity-humanlike/main.go previously referenced om.metadata->>'phone' and
--   om.metadata->>'name', but no metadata JSONB column ever existed on this table
--   (latent runtime crash on first scoring run). This migration introduces two
--   explicit text columns as the authoritative per-mailbox sender profile.
--
-- Callers:
--   - services/orchestrator/cmd/anonymity-humanlike/main.go (loadMessages SQL)
--   - services/campaigns/content/humanlike_score.go (HumanlikeMessage.SenderPhone,
--     HumanlikeMessage.SenderName — populated at call-site by the caller)
--
-- Predecessor: 056_outreach_mailboxes_warmup.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '056_outreach_mailboxes_warmup'
  ) THEN
    RAISE EXCEPTION 'Predecessor 056_outreach_mailboxes_warmup not applied';
  END IF;
END $$;

ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS sender_phone text,
  ADD COLUMN IF NOT EXISTS sender_name  text;

COMMENT ON COLUMN outreach_mailboxes.sender_phone IS
  'Phone number printed in outbound email bodies (e.g. "702 855 326").
   Used by humanlike scorer to verify phone presence in body (Content +10 pts).
   NULL = not configured; scorer treats as phone_missing telltale.';

COMMENT ON COLUMN outreach_mailboxes.sender_name IS
  'Full name of the human sender represented by this mailbox
   (e.g. "Jan Novák"). Used by humanlike scorer to verify sign-off presence
   (Content +15 pts). NULL = not configured; scorer skips sign-off check.
   Distinct from display_name which is the SMTP From: display name and may
   include company branding.';

INSERT INTO schema_migrations (version) VALUES ('057_outreach_mailboxes_sender_profile')
  ON CONFLICT DO NOTHING;

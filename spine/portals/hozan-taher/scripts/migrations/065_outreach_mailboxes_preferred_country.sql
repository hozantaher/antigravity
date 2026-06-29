-- 065_outreach_mailboxes_preferred_country.sql
--
-- Adds preferred_country to outreach_mailboxes for explicit per-mailbox
-- egress country pinning. When set (ISO 3166-1 alpha-2, e.g. 'SK', 'RO'),
-- the wgpool picker filters active endpoints to that country first and
-- falls back to the full active pool only when the country has no healthy
-- endpoints. NULL = no preference (existing hash-based rotation continues).
--
-- Predecessor: 064_icp_sectors.sql
--
-- Apply with:
--   psql "$DATABASE_URL" -f scripts/migrations/065_outreach_mailboxes_preferred_country.sql
-- Or via migration runner:
--   scripts/migrations/run.sh --apply 065

BEGIN;

ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS preferred_country TEXT;

ALTER TABLE outreach_mailboxes
  ADD CONSTRAINT outreach_mailboxes_preferred_country_check
  CHECK (preferred_country IS NULL OR preferred_country ~ '^[A-Z]{2}$');

CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_preferred_country
  ON outreach_mailboxes (preferred_country) WHERE preferred_country IS NOT NULL;

-- Initial assignment for Goran mailboxes (operator's stated preference).
UPDATE outreach_mailboxes SET preferred_country = 'SK'
  WHERE from_address = 'nowak.gorak@email.cz' AND preferred_country IS NULL;

UPDATE outreach_mailboxes SET preferred_country = 'RO'
  WHERE from_address = 'goran.nowak@email.cz' AND preferred_country IS NULL;

INSERT INTO schema_migrations (version) VALUES
  ('065_outreach_mailboxes_preferred_country')
ON CONFLICT (version) DO NOTHING;

COMMIT;

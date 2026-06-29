-- 009_leads_table — extend existing `leads` table with reply-classification columns.
--
-- Background: `leads` already exists from earlier work (PK id, contact_id, campaign_id,
-- status, source, notes, created_at, updated_at, UNIQUE (contact_id, campaign_id)).
-- This migration adds the columns needed by the reply classifier webhook
-- (services/orchestrator/thread/inbound.go onClassified).
--
-- Idempotency: every ALTER uses IF NOT EXISTS (PG 9.6+).

BEGIN;

-- New columns
ALTER TABLE leads ADD COLUMN IF NOT EXISTS mailbox_id INTEGER
  REFERENCES outreach_mailboxes(id) ON DELETE SET NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sentiment TEXT
  CHECK (sentiment IN ('interested','meeting','later','objection','negative','ooo','unknown'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_message_id TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_text TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to TEXT;

-- Backfill: existing rows have NULL classified_at; fall back to created_at.
UPDATE leads SET classified_at = created_at WHERE classified_at IS NULL;

-- Index for the read pattern used by /leads UI (BFF GET /api/leads)
CREATE INDEX IF NOT EXISTS idx_leads_status_classified
  ON leads (status, classified_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_leads_sentiment_classified
  ON leads (sentiment, classified_at DESC NULLS LAST)
  WHERE sentiment IS NOT NULL;

-- Note: existing UNIQUE (contact_id, campaign_id) means we can have AT MOST one
-- lead row per (contact_id, campaign_id) pair. The classifier webhook should
-- ON CONFLICT (contact_id, campaign_id) DO UPDATE SET sentiment, classified_at, ...
-- to record the latest classification rather than insert duplicates.

COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

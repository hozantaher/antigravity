-- 109_outreach_domains_complaint_rate.sql
--
-- Adds the complaint_rate column to outreach_domains, which is referenced by
-- services/contacts/enrichment/recalc.go in the targeting score formula.
-- The column stores the complaint rate as a decimal (0.0 to 1.0+).
--
-- If total_sent is 0, complaint_rate is NULL. Otherwise it is
-- calculated as total_complained / total_sent.
--
-- Predecessor: 108_mailbox_alerts_notify_trigger.sql

BEGIN;

ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS complaint_rate DOUBLE PRECISION;

-- Backfill complaint_rate for all existing domains with send history
UPDATE outreach_domains
SET complaint_rate = CASE
    WHEN total_sent > 0 THEN total_complained::DOUBLE PRECISION / total_sent
    ELSE NULL
END
WHERE complaint_rate IS NULL AND (total_complained > 0 OR total_sent > 0);

INSERT INTO schema_migrations (version) VALUES ('109_outreach_domains_complaint_rate') ON CONFLICT DO NOTHING;

COMMIT;

-- 049_dedup_guard.sql
-- Cross-campaign + per-domain dedup guard.
--
-- Closes operator scenario:
--   "System must not (1) re-send to a contact already touched in any prior
--   campaign/segment, (2) blast multiple emails on the same domain
--   (e.g. boss@firma.cz + asistentka@firma.cz + info@firma.cz)."
--
-- Adds three contact-level fields + an indexed email_domain so per-domain
-- dedup queries don't full-scan. A lightweight trigger increments
-- lifetime_touches on each successful send_events row so the dedup guard
-- can read the running counter without joining send_events at decision time.

BEGIN;

-- ── Generated email_domain column + index ─────────────────────────────────
-- Indexed so per-domain cooldown query (typical pre-enqueue path) is O(log N)
-- instead of full-scan on contacts.email.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_domain TEXT
  GENERATED ALWAYS AS (lower(split_part(email, '@', 2))) STORED;

CREATE INDEX IF NOT EXISTS idx_contacts_email_domain
  ON contacts(email_domain) WHERE email_domain IS NOT NULL AND email_domain <> '';

-- ── Lifetime touch counter ────────────────────────────────────────────────
-- Operator-tunable threshold for the dedup guard. Default 0 = no contact
-- has been touched yet at migration time; bumped by trigger on send.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lifetime_touches INT NOT NULL DEFAULT 0;

-- Backfill from existing send_events history so existing contacts don't
-- look brand-new after this migration runs.
UPDATE contacts c SET lifetime_touches = sub.cnt
FROM (
  SELECT contact_id, COUNT(*)::int AS cnt
  FROM send_events
  WHERE status = 'sent' AND contact_id IS NOT NULL
  GROUP BY contact_id
) sub
WHERE c.id = sub.contact_id AND c.lifetime_touches = 0;

CREATE INDEX IF NOT EXISTS idx_contacts_lifetime_touches
  ON contacts(lifetime_touches) WHERE lifetime_touches > 0;

-- ── Do-not-track flag (GDPR Art. 21 right to object) ──────────────────────
-- Hard skip across all campaigns/segments. Set by:
--   - explicit unsubscribe (existing /unsubscribe endpoint should set this)
--   - reply classifier (negative replies → DNT after operator confirm)
--   - manual operator action via /contacts UI
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dnt BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_contacts_dnt ON contacts(dnt) WHERE dnt = true;

-- ── Trigger to bump lifetime_touches on each successful send ──────────────
CREATE OR REPLACE FUNCTION bump_lifetime_touches() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'sent' AND NEW.contact_id IS NOT NULL THEN
    UPDATE contacts SET lifetime_touches = lifetime_touches + 1
    WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bump_lifetime_touches ON send_events;
CREATE TRIGGER trg_bump_lifetime_touches
  AFTER INSERT OR UPDATE OF status ON send_events
  FOR EACH ROW
  WHEN (NEW.status = 'sent')
  EXECUTE FUNCTION bump_lifetime_touches();

-- ── Skipped-contact rationale on campaign_contacts ─────────────────────
-- When the dedup guard rejects a contact, we set status='skipped' and
-- write the reason into details JSONB. Without this column the runner
-- cannot persist guard rationale.
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS details JSONB;
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_details_skip_reason
  ON campaign_contacts ((details->>'skip_reason'))
  WHERE details ? 'skip_reason';

-- ── Audit row in operator_audit_log ───────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
VALUES (
  'migration_apply',
  'migrations',
  'schema',
  '049_dedup_guard',
  jsonb_build_object(
    'columns_added', jsonb_build_array('contacts.email_domain', 'contacts.lifetime_touches', 'contacts.dnt'),
    'indexes_added', jsonb_build_array('idx_contacts_email_domain', 'idx_contacts_lifetime_touches', 'idx_contacts_dnt'),
    'triggers_added', jsonb_build_array('trg_bump_lifetime_touches'),
    'reason', 'cross-campaign + per-domain dedup guard requested by operator 2026-05-05'
  ),
  now()
);

COMMIT;

INSERT INTO schema_migrations (version) VALUES ('049_dedup_guard') ON CONFLICT DO NOTHING;

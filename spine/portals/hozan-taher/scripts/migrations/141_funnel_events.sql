-- 141_funnel_events.sql
--
-- FUN-1.1 (2026-05-25): Funnel events foundation.
--
-- New canonical funnel events table — denormalized projection of
-- pipeline events for fast cohort and funnel aggregation.
--
-- Event types:
--   sent                  — email successfully delivered (from send_events)
--   opened                — open-pixel fire (from send_events.status='opened')
--   replied               — inbound reply received (from reply_inbox)
--   classified_engagement — reply classified as interested/meeting/engaged
--   classified_negative   — reply classified as negative/unsubscribe
--   classified_bounce     — hard or soft bounce event
--   lead_created          — lead row inserted (interested / meeting sentiment)
--   lead_won              — lead status changed to 'won'
--   lead_lost             — lead status changed to 'lost'
--   suppressed            — contact added to suppression list
--
-- Design decisions:
--   - Denormalized: template_name / campaign_id duplicated here for
--     fast GROUP BY without JOINs; source tables remain authoritative.
--   - All FK columns nullable: not every event has all dimensions.
--   - INSERT is best-effort (non-blocking); funnel is analytics, never
--     production-critical path.
--
-- Indexes:
--   idx_funnel_events_type_occurred  — primary query axis (type + time)
--   idx_funnel_events_campaign       — per-campaign aggregation
--   idx_funnel_events_template       — per-template comparison
--   idx_funnel_events_contact        — per-contact timeline
--
-- Schema verified 2026-05-25 via:
--   SELECT EXISTS(SELECT 1 FROM information_schema.tables
--     WHERE table_name='funnel_events') AS exists;
--   → f (table does not exist yet)
--
-- Predecessor: 140_template_variants
--
-- Per feedback_schema_verify_before_sql T0,
--    feedback_verify_select_after_migration T0,
--    feedback_audit_log_on_mutations T0.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '140_template_variants'
  ) THEN
    RAISE EXCEPTION 'Predecessor 140_template_variants not applied';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS funnel_events (
  id                  BIGSERIAL PRIMARY KEY,
  event_type          TEXT NOT NULL CHECK (event_type IN (
    'sent', 'opened', 'replied',
    'classified_engagement', 'classified_negative', 'classified_bounce',
    'lead_created', 'lead_won', 'lead_lost', 'suppressed'
  )),
  contact_id          BIGINT,
  campaign_id         BIGINT,
  send_event_id       BIGINT,
  reply_id            BIGINT,
  lead_id             BIGINT,
  template_name       TEXT,
  template_variant_id BIGINT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details             JSONB
);

COMMENT ON TABLE funnel_events IS
  'FUN-1.1: Denormalized projection of pipeline events for funnel analytics. '
  'Best-effort INSERTs — never blocks production send path. '
  'Source of truth remains send_events / reply_inbox / leads.';

COMMENT ON COLUMN funnel_events.event_type IS
  'Pipeline stage: sent|opened|replied|classified_*|lead_*|suppressed';

COMMENT ON COLUMN funnel_events.details IS
  'Extra context: step number, classification label, lead sentiment, etc.';

CREATE INDEX IF NOT EXISTS idx_funnel_events_type_occurred
  ON funnel_events(event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_funnel_events_campaign
  ON funnel_events(campaign_id, occurred_at DESC)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funnel_events_template
  ON funnel_events(template_name, occurred_at DESC)
  WHERE template_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funnel_events_contact
  ON funnel_events(contact_id, occurred_at DESC)
  WHERE contact_id IS NOT NULL;

INSERT INTO schema_migrations (version)
  VALUES ('141_funnel_events')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification (feedback_verify_select_after_migration T0):
\echo '── Table created: ──'
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'funnel_events'
 ORDER BY ordinal_position;

\echo '── Indexes created: ──'
SELECT indexname FROM pg_indexes
 WHERE tablename = 'funnel_events'
 ORDER BY indexname;

\echo '── Migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '141_funnel_events';

-- Audit log (feedback_audit_log_on_mutations T0).
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '141',
  jsonb_build_object(
    'migration', '141_funnel_events.sql',
    'reason', 'FUN-1.1: funnel_events foundation — denormalized pipeline event table for cohort analytics.',
    'sprint', 'FUN-1'
  )
);

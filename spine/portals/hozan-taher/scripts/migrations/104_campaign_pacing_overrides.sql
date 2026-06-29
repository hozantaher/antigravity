-- 104_campaign_pacing_overrides.sql
--
-- Adds per-campaign pacing override columns so the operator can tune
-- throttling at the campaign level without touching env vars or
-- per-mailbox settings.
--
-- ── Precedence (highest → lowest) ────────────────────────────────────────
--
--   1. campaign.mailbox_daily_cap_override  (this migration)
--      Set non-NULL to cap total daily sends for this campaign across all
--      mailboxes.  0 means "no campaign-level cap" — falls through to (2).
--
--   2. outreach_mailboxes.daily_cap_override (migration 071 + 102)
--      Per-mailbox cap — can now raise OR lower the phase ceiling (since
--      migration 102 made compute_daily_cap bidirectional).
--
--   3. compute_phase_cap(lifecycle_phase)   (migration 071)
--      Derived from the mailbox lifecycle phase:
--        warmup_d0   →  5/day
--        warmup_d3   → 10/day
--        warmup_d7   → 25/day
--        warmup_d14  → 50/day
--        production  → 100/day
--
--   campaign.mailbox_min_spacing_seconds operates independently of the
--   cap hierarchy — it only controls the minimum seconds between two
--   consecutive sends from the same campaign on the same mailbox.
--   NULL means "inherit from MAILBOX_MIN_SPACING_SECONDS env var
--   (default 60s)".
--
-- ── Columns ───────────────────────────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS mailbox_min_spacing_seconds INT,
  ADD COLUMN IF NOT EXISTS mailbox_daily_cap_override  INT;

-- Human-readable column comments so psql \d and pg_dump include them.
COMMENT ON COLUMN campaigns.mailbox_min_spacing_seconds IS
  'Minimum seconds between consecutive sends from the same campaign on '
  'the same mailbox. NULL = inherit MAILBOX_MIN_SPACING_SECONDS env (default 60). '
  'Valid range [30, 3600].';

COMMENT ON COLUMN campaigns.mailbox_daily_cap_override IS
  'Campaign-level daily send cap across all mailboxes. '
  '0 or NULL = no campaign cap; per-mailbox phase cap governs. '
  'Precedence: campaign override > mailbox override > lifecycle phase cap. '
  'Valid range [0, 5000].';

-- ── Audit record ─────────────────────────────────────────────────────────
-- entity_id is bigint; use migration number (104) as a conventional
-- migration-record identifier (same pattern used by the migration runner).

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'migration_applied',
  'migration_runner',
  'schema',
  104,
  jsonb_build_object(
    'description',
      'Sprint C2: adds mailbox_min_spacing_seconds + mailbox_daily_cap_override '
      'to campaigns table for inline pacing panel in CampaignDetail.',
    'migration_name', '104_campaign_pacing_overrides',
    'columns_added', jsonb_build_array(
      'campaigns.mailbox_min_spacing_seconds',
      'campaigns.mailbox_daily_cap_override'
    ),
    'idempotent', true,
    'reversible', true
  )
);

-- 106 — verify config in operator_settings (Sprint H3)
-- ─────────────────────────────────────────────────────────────────────────────
-- Migrates email verify loop configuration from Railway env vars to the
-- operator_settings table so the operator can tune them from the dashboard UI
-- without touching deployment variables.
--
-- Keys added:
--   email_verify_daily_max   — daily budget cap (default 500)
--   email_verify_batch_size  — contacts per cron tick (default 20)
--   verify_loop_enabled      — feature flag (default false; operator must
--                              explicitly enable via UI)
--
-- contactVerifyCron.js reads these keys first; falls back to env vars for
-- backward compat (VERIFY_DAILY_MAX, VERIFY_BATCH_SIZE,
-- VERIFY_LOOP_CONTACTS_ENABLED).

INSERT INTO operator_settings (key, value, updated_by) VALUES
  ('email_verify_daily_max',  '500',   'migration_106'),
  ('email_verify_batch_size', '20',    'migration_106'),
  ('verify_loop_enabled',     'false', 'migration_106')
ON CONFLICT (key) DO NOTHING;

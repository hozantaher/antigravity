-- 148_halt_advisory_thresholds.sql
--
-- Halt advisory thresholds (#1004 [S1.3]). The advisory endpoint
-- GET /api/campaigns/:id/halt-advisory compares a campaign's bounce rate
-- (send_events.status) against these operator-tunable thresholds rather than
-- hardcoded literals (feedback_no_magic_thresholds T0). The route also carries
-- named defaults as a boot fallback, so a fresh DB without these rows still
-- works (feedback_env_var_needs_db_fallback).
--
-- Defaults are the industry deliverability lines: >5% bounce → pause advised,
-- >10% → hard stop. Complaint threshold is retained for when/if a feedback
-- loop exists; Seznam currently exposes none (#1161), so the route reports
-- complaint_rate as null.
--
-- Idempotent: ON CONFLICT DO NOTHING so operator edits to these keys survive
-- a re-run. Applied to PROD 2026-06-01 via direct SQL; this file is the repo
-- record for fresh databases.

INSERT INTO operator_settings (key, value, description) VALUES
  ('halt_bounce_pause_pct', '5',
   '#1004 S1.3: campaign bounce rate (%) at/above which the halt advisory recommends PAUSE. Industry deliverability soft red line.'),
  ('halt_bounce_stop_pct', '10',
   '#1004 S1.3: campaign bounce rate (%) at/above which the halt advisory recommends HARD STOP.'),
  ('halt_complaint_pause_pct', '0.3',
   '#1004 S1.3: campaign complaint/spam rate (%) at/above which the halt advisory recommends PAUSE. Not yet observable (Seznam has no FBL, #1161).')
ON CONFLICT (key) DO NOTHING;

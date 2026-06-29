-- Migration 083: Mullvad endpoint reputation health tracking table
-- Sprint AR15 — single-endpoint reputation drop detection.
-- AP4 detects multi-country anomalies; AR15 detects per-endpoint bounce rate
-- elevation vs fleet average (e.g. cz-prg-2 higher bounce than cz-prg-1).
--
-- Cron: runMullvadEndpointReputationCron (every 6h, BFF scheduleCron)
-- Query: 7-day rolling window, grouped by egress_endpoint_label, HAVING count >= 50.
-- Flagged: bounce_rate >= 2× fleet average. Written to this table on each flag hit.
BEGIN;

CREATE TABLE IF NOT EXISTS mailbox_egress_endpoint_health (
  endpoint_label  TEXT        PRIMARY KEY,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sends_7d        INT         NOT NULL,
  bounces_7d      INT         NOT NULL,
  bounce_rate     REAL        NOT NULL,
  avg_rate_7d     REAL        NOT NULL,
  -- ratio = bounce_rate / avg_rate_7d (generated, immutable to division-by-zero via NULLIF)
  ratio           REAL        GENERATED ALWAYS AS (bounce_rate / NULLIF(avg_rate_7d, 0)) STORED,
  -- flagged = bounce_rate >= 2 × fleet average
  flagged         BOOLEAN     GENERATED ALWAYS AS (bounce_rate >= 2 * avg_rate_7d) STORED
);

COMMENT ON TABLE mailbox_egress_endpoint_health IS
  'Per-endpoint Mullvad bounce rate snapshot written by runMullvadEndpointReputationCron (AR15). '
  'PRIMARY KEY is endpoint_label so each tick UPSERTs latest state.';

INSERT INTO schema_migrations (version)
  VALUES ('083_endpoint_health_track')
  ON CONFLICT DO NOTHING;

COMMIT;

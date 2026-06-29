BEGIN;

CREATE TABLE IF NOT EXISTS mailbox_egress_observation (
  id               BIGSERIAL PRIMARY KEY,
  mailbox_id       BIGINT NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
  egress_country   TEXT NOT NULL,            -- ISO 3166-1 alpha-2
  egress_endpoint_label TEXT,               -- e.g. cz-prg-1
  egress_ip_hash   TEXT,                     -- sha256(IP) for privacy (don't store raw)
  op_type          TEXT NOT NULL,            -- send|probe|imap_poll|imap_inbox
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_egress_obs_mailbox_recent
  ON mailbox_egress_observation(mailbox_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_egress_obs_country_recent
  ON mailbox_egress_observation(egress_country, observed_at DESC);

-- Cron stored function for cheap aggregate
CREATE OR REPLACE FUNCTION detect_mailbox_egress_chaos(window_minutes INT DEFAULT 60)
RETURNS TABLE(mailbox_id BIGINT, country_count INT, country_list TEXT[]) AS $$
  SELECT mailbox_id,
         count(DISTINCT egress_country)::int AS country_count,
         array_agg(DISTINCT egress_country ORDER BY egress_country) AS country_list
  FROM mailbox_egress_observation
  WHERE observed_at > NOW() - make_interval(mins => window_minutes)
  GROUP BY mailbox_id
  HAVING count(DISTINCT egress_country) > 1;
$$ LANGUAGE sql STABLE;

INSERT INTO schema_migrations (version)
  VALUES ('075_mailbox_egress_observation')
  ON CONFLICT DO NOTHING;

COMMIT;

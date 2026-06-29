-- KT-A8 — block detection audit trail.
--
-- Each detected upstream block (rate-limit, captcha, cloudflare, forbidden)
-- inserts one row. Successful fetches do NOT land here — that path stays in
-- the KT-A7 proxy_source_health metrics. healing_log is purely the audit
-- view: "what abnormal happened, on which source, did we recover?".
--
-- Predecessor: 007_campaign_lock_audit.sql (root scripts/migrations/).
-- This file lives under services/contacts/migrations/ for the contacts
-- package; the runner walks both locations.

CREATE TABLE IF NOT EXISTS healing_log (
    id                  BIGSERIAL PRIMARY KEY,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_name         TEXT NOT NULL,                  -- ares | firmy_cz | <future>
    block_type          TEXT NOT NULL,                  -- rate_limit | captcha | cloudflare | forbidden
    fallback_attempted  TEXT,                           -- alt source name (KT-A7), NULL if none tried
    recovered           BOOLEAN NOT NULL DEFAULT FALSE, -- true when fallback fetch succeeded
    http_status         INT,                            -- original upstream status
    target_url          TEXT,                           -- the URL or ICO that tripped the block
    body_signature      TEXT,                           -- short hash + ~200-char body sample for forensic review
    CONSTRAINT healing_log_block_type_check
        CHECK (block_type IN ('rate_limit', 'captcha', 'cloudflare', 'forbidden'))
);

-- Hot read path: "give me the last 100 events for source X, newest first."
CREATE INDEX IF NOT EXISTS healing_log_source_created_idx
    ON healing_log (source_name, occurred_at DESC);

-- Operator dashboard slices by block_type as well.
CREATE INDEX IF NOT EXISTS healing_log_block_type_idx
    ON healing_log (block_type, occurred_at DESC);

COMMENT ON TABLE healing_log IS
    'KT-A8 audit trail: one row per scraper block detection event (rate_limit / captcha / cloudflare / forbidden) with optional fallback outcome. See docs/initiatives/2026-04-30-kt-a8-block-detection-design.md.';

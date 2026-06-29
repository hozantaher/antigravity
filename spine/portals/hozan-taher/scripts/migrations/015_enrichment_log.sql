-- ════════════════════════════════════════════════════════════════════════
-- KT-A9 — enrichment_log audit table
-- ════════════════════════════════════════════════════════════════════════
--
-- Records every multi-source enrichment run (ARES + firmy.cz + justice.cz)
-- so we can audit which source provided which field, what conflicts arose,
-- and how long the lookup took.
--
-- One row per Pipeline.Enrich call — even when no source returned data
-- ("we tried this ICO three times and got nothing").
--
-- NOTE: filename uses prefix `014` because 010..013 are already taken by
-- earlier migrations in this directory. The KT-A9 design doc references
-- this file as `010_enrichment_log.sql` — that name conflicted with
-- 010_email_templates_body_html.sql.
--
-- Predecessor: 013_message_attachments.sql (run.sh enforces ordering).
-- Idempotent — re-runs are safe (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS enrichment_log (
    id                       BIGSERIAL PRIMARY KEY,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Which contact was being enriched (FK soft — contacts.id is bigint).
    contact_id               BIGINT NOT NULL,

    -- The ICO that was looked up.
    ico                      TEXT NOT NULL,

    -- Which sources the pipeline tried (closed vocabulary: ares|firmy_cz|justice_cz).
    sources_attempted        TEXT[] NOT NULL DEFAULT '{}',

    -- Subset of sources_attempted that returned non-nil data.
    sources_success          TEXT[] NOT NULL DEFAULT '{}',

    -- Per-field conflicts encountered during merge.
    -- Shape: [{"field":"pravni_forma","ares":"112","firmy_cz":"Sro","resolved":"ares"}, ...]
    merge_conflicts          JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Closed vocabulary describing the overall outcome.
    enrichment_source_used   TEXT NOT NULL,

    -- Wall-clock duration of the Pipeline.Enrich call.
    duration_ms              INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT enrichment_log_outcome_chk
        CHECK (enrichment_source_used IN (
            'ares_only',
            'firmy_cz_only',
            'merged',
            'firmy_cz_fallback',
            'justice_cz_fallback',
            'none'
        ))
);

-- Audit lookup pattern: "show me the last N enrichment attempts for contact X".
CREATE INDEX IF NOT EXISTS idx_enrichment_log_contact_created
    ON enrichment_log (contact_id, created_at DESC);

-- Fleet-wide observability: "what's the failure rate by ICO for the last hour?".
CREATE INDEX IF NOT EXISTS idx_enrichment_log_ico_created
    ON enrichment_log (ico, created_at DESC);

-- Outcome aggregation: "how many runs landed on justice_cz fallback today?".
CREATE INDEX IF NOT EXISTS idx_enrichment_log_outcome_created
    ON enrichment_log (enrichment_source_used, created_at DESC);

COMMENT ON TABLE enrichment_log IS
'KT-A9 — multi-source enrichment audit. One row per Pipeline.Enrich call.';
COMMENT ON COLUMN enrichment_log.merge_conflicts IS
'Array of {field, ares, firmy_cz, resolved} entries for per-field conflicts.';
COMMENT ON COLUMN enrichment_log.enrichment_source_used IS
'Closed vocabulary: ares_only|firmy_cz_only|merged|firmy_cz_fallback|justice_cz_fallback|none.';

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

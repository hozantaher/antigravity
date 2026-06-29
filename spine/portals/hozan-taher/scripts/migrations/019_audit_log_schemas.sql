-- ════════════════════════════════════════════════════════════════════════
-- Track E — GDPR audit log schemas (M+3 minimal scope)
-- ════════════════════════════════════════════════════════════════════════
--
-- Goal: provide three forward-compatible audit tables that anchor the
-- GDPR layer rolled out for the M+3 minimal scope (email-only outbound +
-- internal photo parsing). The tables are referenced from:
--
--   - docs/legal/art30-register.md       (ROPA Činnost č. 6 — interní photo parsing)
--   - docs/legal/lia-direct-marketing.md (per-channel balancing test)
--   - docs/legal/privacy-notice.md       (DSR cascade scope §7)
--   - apps/outreach-dashboard/server.js  (/api/dsr/erase + /api/dsr/access)
--
-- Tables (1-row-per-event, append-only, JSONB metadata):
--   1. channel_audit_log     — per-channel send/receive audit (email today;
--                              whatsapp / portal_event reserved for Phase 2)
--   2. ai_suggestion_audit   — AI suggestion + operator action (RLHF dataset
--                              for KT-B5 lab feedback loop / KT-B2 prompts)
--   3. photo_parse_audit     — Ollama vision extraction over inbound photos
--                              (Garaaage portal listing prep)
--
-- Forward-compatibility:
--   - All tables idempotent (CREATE TABLE IF NOT EXISTS)
--   - No NOT NULL on the discriminator columns (subject_email/_phone) so
--     we don't fail when only one identifier is known at insert time.
--   - JSONB `details` column on every table for extension without ALTER.
--
-- Memory rules:
--   feedback_no_speculation — column shape derived from the M+3 minimal
--                             scope plan + GDPR Art. 30 ROPA fields,
--                             not invented.
--   feedback_extreme_testing — BFF + audit ratchet test cover happy/edge
--                             pairs around DSR cascade + UNION reads.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- ── 1. channel_audit_log ────────────────────────────────────────────────
-- One row per outbound or inbound channel event. Email today; the `channel`
-- column is open-ended TEXT so Phase 2 can land 'whatsapp' / 'portal_event'
-- without an ALTER TABLE.
CREATE TABLE IF NOT EXISTS channel_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    channel         TEXT        NOT NULL,
    direction       TEXT        NOT NULL,
    subject_email   TEXT,
    subject_phone   TEXT,
    message_id      TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    details         JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- DSR access reads everything the controller holds about an email subject
-- in chronological order. Index supports the
-- `WHERE subject_email = $1 ORDER BY occurred_at DESC` shape.
CREATE INDEX IF NOT EXISTS idx_channel_audit_subject_email
    ON channel_audit_log (subject_email, occurred_at DESC)
    WHERE subject_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_audit_subject_phone
    ON channel_audit_log (subject_phone, occurred_at DESC)
    WHERE subject_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_audit_channel_dir
    ON channel_audit_log (channel, direction, occurred_at DESC);

COMMENT ON TABLE channel_audit_log IS
    'Track E — per-channel send/receive audit. Email today; whatsapp / '
    'portal_event reserved for Phase 2. Append-only.';
COMMENT ON COLUMN channel_audit_log.channel IS
    'Free-form channel identifier: email | whatsapp (future) | portal_event (future).';
COMMENT ON COLUMN channel_audit_log.direction IS
    'outbound = controller -> subject; inbound = subject -> controller.';
COMMENT ON COLUMN channel_audit_log.subject_email IS
    'Lower-cased email of the data subject if known. NULLable so phone-only '
    'channels can still record an event in the same table.';

-- ── 2. ai_suggestion_audit ──────────────────────────────────────────────
-- One row per AI suggestion + operator action. RLHF dataset for prompt
-- iteration (KT-B2 + KT-B5). thread_id is a soft FK so we don't fail when
-- a thread row is later deleted by the DSR cascade — the AI history stays
-- intact for accountability (Art. 5/2 + Art. 30).
--
-- We do NOT add an FK constraint: the cascade test (gdpr-cascade-shape)
-- relies on this table being rewritable on erase (anonymize, not DELETE).
CREATE TABLE IF NOT EXISTS ai_suggestion_audit (
    id                BIGSERIAL PRIMARY KEY,
    thread_id         BIGINT,
    ai_suggestion     TEXT        NOT NULL,
    operator_action   TEXT        NOT NULL,
    final_output      TEXT,
    operator_id       TEXT,
    confidence_score  NUMERIC(5,4),
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    details           JSONB       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT ai_suggestion_audit_action_chk
        CHECK (operator_action IN ('approved','edited','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_thread
    ON ai_suggestion_audit (thread_id, occurred_at DESC)
    WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_audit_action
    ON ai_suggestion_audit (operator_action, occurred_at DESC);

COMMENT ON TABLE ai_suggestion_audit IS
    'Track E — RLHF dataset: AI suggestion + operator decision (approved | '
    'edited | rejected). Feeds KT-B2 prompt iteration + KT-B5 lab loop.';
COMMENT ON COLUMN ai_suggestion_audit.thread_id IS
    'Soft FK to outreach_threads.id. No FK constraint on purpose — DSR '
    'erase anonymizes the row instead of DELETE so the dataset stays usable.';
COMMENT ON COLUMN ai_suggestion_audit.final_output IS
    'NULL when operator_action = rejected; otherwise the text actually sent.';

-- ── 3. photo_parse_audit ────────────────────────────────────────────────
-- One row per Ollama vision call over an inbound photo. `extracted` =
-- everything the model returned; `retained` = subset we keep (machinery
-- attributes); `discarded` = subset dropped at parse time (faces, license
-- plates, OCR'd PII). Lets us audit data minimization (Art. 5/1/c).
CREATE TABLE IF NOT EXISTS photo_parse_audit (
    id            BIGSERIAL PRIMARY KEY,
    blob_ref      TEXT        NOT NULL,
    source        TEXT        NOT NULL,
    extracted     JSONB       NOT NULL,
    retained      JSONB       NOT NULL,
    discarded     JSONB,
    llm_provider  TEXT        NOT NULL DEFAULT 'ollama-llama3.2-vision',
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    details       JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_photo_parse_source
    ON photo_parse_audit (source, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_photo_parse_blob
    ON photo_parse_audit (blob_ref);

COMMENT ON TABLE photo_parse_audit IS
    'Track E (ROPA Činnost č. 6) — Ollama vision extraction audit. '
    'Local-only LLM, no third-party transfer. Default retention 12 měsíců.';
COMMENT ON COLUMN photo_parse_audit.source IS
    'Origin of the photo blob: email_attachment today; whatsapp_inbound '
    'reserved for Phase 2.';
COMMENT ON COLUMN photo_parse_audit.retained IS
    'Subset of extracted attributes we keep (machinery brand/model/year/'
    'condition). Drives docs/legal data-minimization claim (čl. 5/1/c).';
COMMENT ON COLUMN photo_parse_audit.discarded IS
    'Subset of extracted attributes dropped at parse time (faces, license '
    'plates, OCR text). Empty/NULL when nothing PII-like was detected.';

-- ── Audit log row (best-effort — table may not exist on a brand-new dev DB).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'operator_audit_log'
    ) THEN
        INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
        VALUES (
            'migration_applied',
            'migration_runner',
            'schema',
            '019_audit_log_schemas',
            jsonb_build_object(
                'description',
                    'Track E: GDPR audit log schemas — channel_audit_log, '
                    'ai_suggestion_audit, photo_parse_audit (M+3 minimal scope).',
                'idempotent', true,
                'reversible', true,
                'tables_added', jsonb_build_array(
                    'channel_audit_log',
                    'ai_suggestion_audit',
                    'photo_parse_audit'
                )
            )
        );
    END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the change
-- ════════════════════════════════════════════════════════════════════════
--
-- Restores pre-019 schema. Safe to re-run.
--
--   DROP TABLE IF EXISTS channel_audit_log;
--   DROP TABLE IF EXISTS ai_suggestion_audit;
--   DROP TABLE IF EXISTS photo_parse_audit;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── Track E: channel_audit_log + ai_suggestion_audit + photo_parse_audit ready.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

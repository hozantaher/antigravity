-- ════════════════════════════════════════════════════════════════════════
-- 093 — drop persona_slug column from outreach_mailboxes (AQ3)
-- ════════════════════════════════════════════════════════════════════════
--
-- Rationale: Single-persona migration. Previously, persona_slug allowed
-- per-mailbox persona override. Now, all sends use single persona from
-- operator_settings.persona_default. Column is dead code.
--
-- Pre-flight check: persona_slug should be all NULL or empty in PROD.
-- If any row has non-NULL persona_slug, this migration fails with an error.
--
-- Idempotent: uses IF EXISTS.

BEGIN;

-- Safety: fail if any non-NULL persona_slug found
DO $$
DECLARE
    cnt INTEGER;
BEGIN
    SELECT COUNT(*) INTO cnt FROM outreach_mailboxes
    WHERE persona_slug IS NOT NULL AND persona_slug != '';

    IF cnt > 0 THEN
        RAISE EXCEPTION 'Migration 093: Found % rows with non-NULL/non-empty persona_slug. Cannot drop column. Please audit and clean before retrying.', cnt;
    END IF;
END $$;

-- Drop the column
ALTER TABLE outreach_mailboxes DROP COLUMN IF EXISTS persona_slug;

-- Record migration
INSERT INTO schema_migrations (version) VALUES ('093_drop_persona_slug') ON CONFLICT DO NOTHING;

COMMIT;

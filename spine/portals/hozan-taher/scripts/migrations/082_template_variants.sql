-- Migration 082: template subject + body variants for fingerprint diversity
-- Sprint AR1 — 100 mails with identical subject+body fingerprint is a bulk-mail
-- signal for Seznam. This migration adds JSONB variant arrays so the render
-- engine can rotate formulations deterministically per envelope.
--
-- subject_variants: alternative subject formulations. Empty array = use main subject only.
-- body_variants:    alternative body templates.    Empty = use main body only.
--
-- Render logic: pickVariant(envelopeID, templateID, variants, mainContent)
-- uses SHA256(envelopeID + ":" + templateID) mod (len(variants)+1) so:
--   - same envelope always gets the same variant (deterministic, auditable)
--   - distribution across variants is approximately uniform
--   - main content is included in the pool (idx == len(variants) → main)
BEGIN;

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS subject_variants JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS body_variants    JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN email_templates.subject_variants IS 'Array of alternative subject formulations. Empty array = use main subject only.';
COMMENT ON COLUMN email_templates.body_variants    IS 'Array of alternative body templates. Empty = use main body only.';

INSERT INTO schema_migrations (version)
  VALUES ('082_template_variants')
  ON CONFLICT DO NOTHING;

COMMIT;

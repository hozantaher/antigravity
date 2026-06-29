-- 010_email_templates_body_html — explicit HTML body column.
--
-- Until now content/template.go Render() auto-generated HTML from plain
-- body via plainToHTML (which escapes < > & — preventing inline HTML
-- styling). For B2B compliance footers we need <small><em>...</em></small>
-- styling so the legal disclaimer is visually distinct from the personal
-- message body without making the plain-text version a wall of text.
--
-- Render logic (after this migration):
--   if body_html IS NOT NULL → use as HTML alternative part
--   else                     → plainToHTML(body) as before (backwards compat)

BEGIN;

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS body_html TEXT;

COMMENT ON COLUMN email_templates.body_html IS
  'Explicit HTML body for multipart/alternative. NULL → renderer falls back to plainToHTML(body).';

COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

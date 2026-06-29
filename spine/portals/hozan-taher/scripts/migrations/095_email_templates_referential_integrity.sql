-- 095_email_templates_referential_integrity.sql
--
-- Sprint C from docs/initiatives/2026-05-11-post-incident-hardening.md.
--
-- Today's incident (2026-05-11): renamed `email_templates.name` from
-- `intro_machinery` to `initial` during cleanup. Daemon crashed with
-- "template intro_machinery not found in email_templates" because
-- `campaigns.sequence_config` (jsonb) references template name by string
-- and no FK existed.
--
-- This trigger blocks UPDATE-name + DELETE on `email_templates` rows
-- that are referenced by any campaign in `running`, `draft`, or
-- `paused` state. Operator must detach the campaign sequence_config
-- first (replace template name with the new identifier), then UPDATE
-- or DELETE.
--
-- Safe DELETE of an unused template still works — trigger only fires
-- when refs > 0.

BEGIN;

CREATE OR REPLACE FUNCTION check_template_in_use() RETURNS TRIGGER AS $$
DECLARE
  refs INT;
  ref_ids TEXT;
BEGIN
  -- Only check when delete OR rename. UPDATE of body / subject / html
  -- is safe (no FK reference changes).
  IF (TG_OP = 'DELETE') OR (TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name) THEN
    SELECT count(*), string_agg(c.id::text, ',' ORDER BY c.id)
      INTO refs, ref_ids
      FROM campaigns c
      WHERE c.status IN ('running', 'draft', 'paused')
        AND c.sequence_config IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(c.sequence_config) AS step
           WHERE step->>'template' = OLD.name
        );
    IF refs > 0 THEN
      RAISE EXCEPTION 'email_templates.name=% is referenced by % active campaign(s) [ids: %]; detach via UPDATE campaigns SET sequence_config = ... first',
        OLD.name, refs, ref_ids
      USING ERRCODE = '23503'; -- foreign_key_violation
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_email_templates_in_use ON email_templates;
CREATE TRIGGER trg_email_templates_in_use
  BEFORE UPDATE OR DELETE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION check_template_in_use();

COMMIT;

-- 130_company_lifecycle_suppress_contacts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Autonomous sync (iter62): when a company transitions to dead/insolvent
-- (ARES lifecycle: v_insolvenci / v_likvidaci / datum_zaniku set), automatically
-- suppress its contacts so the outreach send layer stops targeting a firm in
-- insolvency/liquidation/dissolution. Previously NOTHING propagated company
-- lifecycle changes to contacts — a company going insolvent kept getting mailed.
--
-- Mechanism: AFTER UPDATE trigger on companies, guarded so it fires ONLY on the
-- not-dead → dead transition (not on every company UPDATE, and not repeatedly).
-- Mirrors the existing contacts bounce-cascade trigger pattern
-- (trg_contacts_bounced_to_suppression) — suppression by setting status.
--
-- Idempotent: only suppresses contacts not already suppressed; audit-logged in
-- the same statement (feedback_audit_log_on_mutations T0). ICO is a public
-- business identifier, not personal PII (feedback_no_pii_in_logs T0 — safe to
-- log the ICO + counts, no emails/names).
-- Predecessor: 129_promote_classified_unmatched_to_reply_inbox.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '129_promote_classified_unmatched_to_reply_inbox') THEN
    RAISE EXCEPTION 'Predecessor 129_promote_classified_unmatched_to_reply_inbox not applied';
  END IF;
END $$;

BEGIN;

CREATE OR REPLACE FUNCTION fn_company_lifecycle_suppress_contacts()
RETURNS trigger AS $$
DECLARE
  n int;
  reason text;
BEGIN
  reason := CASE
    WHEN COALESCE(NEW.v_insolvenci, false) THEN 'insolvence'
    WHEN COALESCE(NEW.v_likvidaci, false)  THEN 'likvidace'
    ELSE 'zanik'
  END;

  UPDATE contacts
     SET status = 'suppressed', updated_at = now()
   WHERE ico = NEW.ico
     AND ico IS NOT NULL AND ico <> ''
     AND status IS DISTINCT FROM 'suppressed';
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n > 0 THEN
    INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
    VALUES ('company_lifecycle_suppress_contacts', 'trigger', 'company', NEW.id,
            jsonb_build_object('ico', NEW.ico, 'reason', reason, 'suppressed_contacts', n), now());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_company_lifecycle_suppress_contacts ON companies;
CREATE TRIGGER trg_company_lifecycle_suppress_contacts
  AFTER UPDATE OF v_insolvenci, v_likvidaci, datum_zaniku ON companies
  FOR EACH ROW
  WHEN (
    -- became dead/insolvent NOW …
    ( COALESCE(NEW.v_insolvenci, false)
      OR COALESCE(NEW.v_likvidaci, false)
      OR (NEW.datum_zaniku IS NOT NULL AND NEW.datum_zaniku <> '') )
    AND
    -- … but was NOT before (transition edge only — no re-fire on later updates)
    NOT ( COALESCE(OLD.v_insolvenci, false)
      OR COALESCE(OLD.v_likvidaci, false)
      OR (OLD.datum_zaniku IS NOT NULL AND OLD.datum_zaniku <> '') )
  )
  EXECUTE FUNCTION fn_company_lifecycle_suppress_contacts();

INSERT INTO schema_migrations (version)
  VALUES ('130_company_lifecycle_suppress_contacts')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification (feedback_verify_select_after_migration T0)
\echo '── trigger present? ──'
SELECT tgname FROM pg_trigger WHERE tgname = 'trg_company_lifecycle_suppress_contacts';
\echo '── function present? ──'
SELECT proname FROM pg_proc WHERE proname = 'fn_company_lifecycle_suppress_contacts';

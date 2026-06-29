-- 119_recover_utf8_id504.sql
--
-- AL-F3 (2026-05-18): operator-visible cleanup of the single inbound
-- corrupted by the pre-AL-F3 charset bug.
--
-- Background: row id=504 in unmatched_inbound (from
-- <gerhatova@gevotransport.eu>, subject "RE: Dotaz") was ingested
-- before AL-F3 from a windows-1250 quoted-printable Outlook reply.
-- The previous parser called string(bodyBytes) directly without
-- charset transcoding, so the Czech 'ý' / 'ě' / 'á' bytes (0xFD /
-- 0xEC / 0xE1 in windows-1250) became U+FFFD REPLACEMENT CHARACTERS
-- when re-encoded as UTF-8 by safeUTF8(). The body now reads
-- "Dobr� den" instead of "Dobrý den" and the original bytes are
-- unrecoverable (the raw IMAP message was already expunged from
-- the Seznam mailbox by the time AL-F3 landed).
--
-- The AL-F3 fix in services/orchestrator/mime/parser.go::decodeBodyText
-- transcodes windows-1250 / iso-8859-2 / latin1 → UTF-8 before
-- stringifying, so new ingestions are safe. This migration handles
-- the one historical row by classifying it so the BFF default-filter
-- hides it from the operator's /replies (Nezpárované) view.
--
-- Why classification='corrupted_charset' instead of DELETE: we keep
-- the row for audit trail + so the AL-F3 ratchet
-- (services/orchestrator/thread/no_utf8_replacement_audit_test.go)
-- has a non-zero baseline to anchor against. Deleting would lose
-- evidence + reduce the baseline to 0, which is a more aggressive
-- regression signal than we have evidence for.
--
-- Predecessor: 118_unmatched_inbound_classification.sql
--
-- Idempotent: re-running the UPDATE is a no-op once classification
-- is set. The audit_log INSERT is unconditional (visible re-run
-- evidence, never destructive).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '118_unmatched_inbound_classification'
  ) THEN
    RAISE EXCEPTION 'Predecessor 118_unmatched_inbound_classification not applied';
  END IF;
END $$;

BEGIN;

-- 1. Reclassify the one corrupted row. Bounded by the exact U+FFFD
-- predicate so we never accidentally touch valid rows. classification
-- is only set when it is currently NULL or 'corrupted_charset' (re-run
-- safety) — operator-set values (e.g. 'bounce', 'auto_reply') win.
WITH reclassified AS (
  UPDATE unmatched_inbound
     SET classification = 'corrupted_charset'
   WHERE id = 504
     AND (
       position(chr(65533) IN coalesce(body_preview, '')) > 0
       OR position(chr(65533) IN coalesce(body_html, '')) > 0
     )
     AND (classification IS NULL OR classification = 'corrupted_charset')
   RETURNING id
)
SELECT count(*) AS rows_reclassified FROM reclassified \gset

-- 2. Audit log. feedback_audit_log_on_mutations T0 — operator-visible
-- state change must emit a row.
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'unmatched_inbound_corrupted_charset_classify',
  'migration',
  'unmatched_inbound',
  '504',
  jsonb_build_object(
    'migration',          '119_recover_utf8_id504.sql',
    'rows_reclassified',  :'rows_reclassified',
    'reason',             'AL-F3: pre-fix windows-1250 ingestion irreversibly corrupted with U+FFFD; raw IMAP message no longer fetchable',
    'reversible',         false,
    'baseline_anchor',    'services/orchestrator/thread/no_utf8_replacement_audit_test.go'
  )
);

-- 3. Record migration.
INSERT INTO schema_migrations (version)
  VALUES ('119_recover_utf8_id504')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification queries (feedback_verify_select_after_migration T0):
\echo '── Confirm id=504 is now classified as corrupted_charset:'
SELECT id, classification, LEFT(from_address, 50) AS from_address, LEFT(subject, 60) AS subject
  FROM unmatched_inbound
 WHERE id = 504;

\echo '── Confirm only id=504 carries corrupted_charset classification:'
SELECT count(*) AS corrupted_charset_count
  FROM unmatched_inbound
 WHERE classification = 'corrupted_charset';

\echo '── Confirm AL-F3 ratchet baseline (count must be 1):'
SELECT count(*) AS rows_with_u_fffd
  FROM unmatched_inbound
 WHERE position(chr(65533) IN coalesce(body_preview, '')) > 0
    OR position(chr(65533) IN coalesce(body_html, '')) > 0;

\echo '── Confirm audit log entry exists:'
SELECT created_at, action, entity_id, details->>'rows_reclassified' AS rows_reclassified
  FROM operator_audit_log
 WHERE action = 'unmatched_inbound_corrupted_charset_classify'
 ORDER BY created_at DESC
 LIMIT 1;

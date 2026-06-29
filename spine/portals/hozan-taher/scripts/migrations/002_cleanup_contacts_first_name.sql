-- ════════════════════════════════════════════════════════════════════════
-- S7.2 — contacts.first_name regex cleanup
-- ════════════════════════════════════════════════════════════════════════
--
-- Production data has `contacts.first_name` populated mostly with
-- company-name fragments (INGOS, Stavebniny, BENEŠ, KLEMPOSTAV, …)
-- rather than personal first names. Source: firmy.cz scraper output
-- where the parser couldn't separate person from company in the
-- "Kontaktní osoba" field.
--
-- Symptom: humanize.GreetingForStep produces "Vážený pane INGOS" /
-- "Dobrý den, pane KLEMPOSTAV" — obvious mail-merge spam.
--
-- Workaround for campaign 455 was to NULL first_name on the 20
-- enrolled rows manually (commit 887963c). This migration applies
-- the same cleanup across the full table (~759k rows total, ~600k
-- expected to NULL).
--
-- Strategy: regex-based detection of "not a personal first name":
--   1. ALL CAPS ≥ 3 chars (INGOS, BENEŠ, ZAPA…)
--   2. Multi-word (Pneuservis Slavík, Schody Stadler…)
--   3. Punctuation (REC.,, STOFI,, …)
--   4. Numeric prefix (1cernopolni, 002@…)
--   5. Length > 20 chars (likely full company name)
--
-- Run in 50k row chunks to keep transaction size manageable +
-- avoid long lock on contacts table.
--
-- Operator runs:
--   psql "$DATABASE_URL" -f scripts/migrations/002_cleanup_contacts_first_name.sql
--
-- Idempotent: re-running matches fewer rows each time as cleanup
-- progresses. Safe to run multiple times.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

\echo '── Pre-flight: count of bad first_name rows by pattern ──'

SELECT 'all_caps_3plus' AS pattern, COUNT(*)::int AS rows FROM contacts
  WHERE first_name ~ '^[A-ZČŠŘŽÝÁÍÉÚŮŇĎŤA-Z]{3,}$'
UNION ALL
SELECT 'multi_word', COUNT(*)::int FROM contacts
  WHERE first_name ~ '\s'
UNION ALL
SELECT 'punctuation', COUNT(*)::int FROM contacts
  WHERE first_name ~ '[,.;:0-9]'
UNION ALL
SELECT 'too_long_(>20)', COUNT(*)::int FROM contacts
  WHERE length(first_name) > 20
UNION ALL
SELECT 'too_short_(<2)', COUNT(*)::int FROM contacts
  WHERE first_name IS NOT NULL AND length(first_name) BETWEEN 1 AND 1
UNION ALL
SELECT 'total_non_null', COUNT(*)::int FROM contacts
  WHERE first_name IS NOT NULL AND first_name <> '';

\echo ''
\echo '── Cleanup: NULL first_name where it does not look like a personal name ──'

-- Run in chunks of 50k to keep lock duration bounded.
-- Loop continues until UPDATE returns 0 rows.
DO $$
DECLARE
    affected int;
    iteration int := 0;
    total_cleaned int := 0;
BEGIN
    LOOP
        iteration := iteration + 1;
        WITH bad AS (
            SELECT id FROM contacts
            WHERE first_name IS NOT NULL
              AND first_name <> ''
              AND (
                first_name ~ '^[A-ZČŠŘŽÝÁÍÉÚŮŇĎŤA-Z]{3,}$' OR
                first_name ~ '\s' OR
                first_name ~ '[,.;:0-9]' OR
                length(first_name) > 20 OR
                length(first_name) < 2
              )
            LIMIT 50000
        )
        UPDATE contacts SET first_name = NULL
        WHERE id IN (SELECT id FROM bad);
        GET DIAGNOSTICS affected = ROW_COUNT;
        total_cleaned := total_cleaned + affected;
        RAISE NOTICE 'iteration %: cleaned % rows (running total: %)', iteration, affected, total_cleaned;
        EXIT WHEN affected = 0;
        -- Safety: bail after 50 iterations (2.5M rows; production has ~759k)
        EXIT WHEN iteration >= 50;
    END LOOP;
    RAISE NOTICE 'cleanup complete: % rows NULL''d across % iterations', total_cleaned, iteration;
END $$;

\echo ''
\echo '── Post: count remaining non-null first_name rows (should be ~personal names only) ──'

SELECT
    COUNT(*) FILTER (WHERE first_name IS NOT NULL) AS remaining_non_null,
    COUNT(*) FILTER (WHERE first_name IS NULL) AS now_null,
    COUNT(*) AS total
FROM contacts;

\echo ''
\echo '── Audit log entry ──'

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'data_cleanup',
    'migration',
    'table',
    'contacts.first_name',
    jsonb_build_object(
        'reason', 'company-name fragments → NULL (S7.2)',
        'migration', '002_cleanup_contacts_first_name.sql',
        'reversible', false
    )
);

\echo '── Migration complete ──'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

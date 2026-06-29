-- suppression-check.sql — velikost obou suppression tabulek a jejich UNION
-- Read-only. Per memory two_suppression_tables: obě tabulky musí být zohledněny
-- při každém read (viz SUPPRESSION_LOOKUP_SQL v BFF).
SELECT 'outreach_suppressions' AS src, COUNT(*) AS row_count
FROM outreach_suppressions
UNION ALL
SELECT 'suppression_list', COUNT(*)
FROM suppression_list
UNION ALL
SELECT 'union_total (distinct emails)',
       COUNT(*) FROM (
         SELECT lower(trim(email)) FROM outreach_suppressions
         UNION
         SELECT lower(trim(email)) FROM suppression_list
       ) u;

-- ════════════════════════════════════════════════════════════════════════
-- 025 — Append GDPR footer (with {{.UnsubURL}} placeholder) to email
--       templates 1889/1890/1891 used by campaign 455
-- ════════════════════════════════════════════════════════════════════════
--
-- Source: docs/playbooks/launch-readiness.md § "DB rows for campaign 455
-- — operator SQL". Verbatim SQL packaged here so the migration runner
-- (scripts/migrations/run.sh) can apply it with predecessor-ordering +
-- content_sha256 audit, instead of an operator pasting raw UPDATEs.
--
-- Original task slot was "008" but 008_seed_heavy_templates.sql already
-- occupies that prefix. Next free numeric slot is 025. Predecessor 024
-- (anonymity_humanlike_scores) is unrelated; ordering is bookkeeping only.
--
-- ── Why this migration exists ────────────────────────────────────────────
-- The .tmpl files in services/campaigns/configs/templates/ were updated
-- with a GDPR footer (issue #585). The DB rows for campaign 455's three
-- templates (intro_machinery=1889, followup_1=1890, followup_2=1891) were
-- NOT regenerated from disk and still lack the {{.UnsubURL}} placeholder.
--
-- The render-time gate `template_render` in verify-launch.mjs checks for
-- {{.UnsubURL}} after Go template render → it stays RED until these rows
-- are updated. Sender refuses to dispatch without a working unsub link
-- (HARD RULE in CLAUDE.md red lines + Art. 21 GDPR opt-out gate).
--
-- ── Idempotency ─────────────────────────────────────────────────────────
-- Re-running this migration appends the footer ONLY if it is not already
-- present. The guard `WHERE body NOT LIKE '%{{.UnsubURL}}%'` makes the
-- UPDATEs no-ops on a second apply.
--
-- ── Contract verification (operator-run after apply) ─────────────────────
--
--   SELECT id, name, body LIKE '%{{.UnsubURL}}%' AS has_unsub
--     FROM email_templates
--    WHERE id IN (1889, 1890, 1891);
--
--   Expected: all three rows return has_unsub = true.

BEGIN;

-- ── intro_machinery (id=1889) ────────────────────────────────────────────
UPDATE email_templates
   SET body = body || E'\n\nOdhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.\nSprávce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.\nPrávní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).\nZdroj kontaktu: veřejný rejstřík firmy.cz.\nPrivacy policy: https://garaaage.cz/privacy'
 WHERE id = 1889
   AND body NOT LIKE '%{{.UnsubURL}}%';

-- ── followup_1 (id=1890) ─────────────────────────────────────────────────
UPDATE email_templates
   SET body = body || E'\n\nOdhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.\nSprávce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.\nPrávní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).\nZdroj kontaktu: veřejný rejstřík firmy.cz.\nPrivacy policy: https://garaaage.cz/privacy'
 WHERE id = 1890
   AND body NOT LIKE '%{{.UnsubURL}}%';

-- ── followup_2 (id=1891) ─────────────────────────────────────────────────
UPDATE email_templates
   SET body = body || E'\n\nOdhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.\nSprávce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.\nPrávní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).\nZdroj kontaktu: veřejný rejstřík firmy.cz.\nPrivacy policy: https://garaaage.cz/privacy'
 WHERE id = 1891
   AND body NOT LIKE '%{{.UnsubURL}}%';

-- ── Audit log ────────────────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '025_campaign_455_unsub_footer',
    jsonb_build_object(
        'description', 'Append GDPR footer + {{.UnsubURL}} placeholder to email_templates 1889/1890/1891 (campaign 455)',
        'idempotent', true,
        'source_playbook', 'docs/playbooks/launch-readiness.md',
        'gate_unblocked', 'template_render in verify-launch.mjs'
    )
);

COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

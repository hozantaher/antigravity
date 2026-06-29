-- ════════════════════════════════════════════════════════════════════════
-- Launch script: First campaign — soft launch, 20 contacts, machinery-relevant
-- ════════════════════════════════════════════════════════════════════════
--
-- Goal: create a draft campaign + enroll up to 20 contacts from
-- machinery-relevant industry tags. Operator-driven. Idempotent — safe
-- to re-run, will not duplicate enrollments.
--
-- Companion files:
--   - preview-001-machinery-soft-20.sql   read-only preview, run FIRST
--   - docs/playbooks/LAUNCH-CAMPAIGN-001.md   step-by-step Czech runbook
--
-- After running:
--   - campaign_id is printed at the end (status='draft')
--   - dry-run via UI: send-test from mb=631/632 to known recipient, then
--     flip status='running' to actually launch
--
-- HARD RULE: this script ONLY creates draft + enrolls. Does NOT flip
-- status to running. Activation is a separate manual step.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- ── 1. Resolve / create campaign (idempotent on name) ──────────────────
-- Constants are inlined below — search for "EDIT HERE" to change.
INSERT INTO campaigns (
    name, description, status,
    category_paths, category_match,
    sequence_config, sending_config, segment_query
)
SELECT
    -- EDIT HERE: campaign name
    'Soft launch 001 — odkup techniky 2026-04-25',
    -- EDIT HERE: description
    '20 kontaktů z machinery-relevant tagů. První ostrá kampaň. Single-step (initial.tmpl bez personalizace, žádný follow-up). Manuální review po prvním reply pulsu.',
    'draft',
    ARRAY[]::text[],
    'prefix',
    '[{"step":0,"delay_days":0,"template":"initial"}]'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb
WHERE NOT EXISTS (
    SELECT 1 FROM campaigns
    WHERE name = 'Soft launch 001 — odkup techniky 2026-04-25'
);

-- ── 2. Snapshot campaign_id for use below ──────────────────────────────
CREATE TEMPORARY TABLE _launch_campaign ON COMMIT DROP AS
SELECT id, status FROM campaigns
WHERE name = 'Soft launch 001 — odkup techniky 2026-04-25';

DO $$
DECLARE
    cid bigint;
    cstatus text;
BEGIN
    SELECT id, status INTO cid, cstatus FROM _launch_campaign;
    IF cid IS NULL THEN
        RAISE EXCEPTION 'campaign creation failed: name lookup returned no row';
    END IF;
    RAISE NOTICE 'campaign resolved: id=%, status=%', cid, cstatus;
    IF cstatus NOT IN ('draft','paused') THEN
        RAISE WARNING 'campaign is in status %, expected draft/paused — '
            'this script should not be run against an already-active campaign.', cstatus;
    END IF;
END $$;

-- ── 3. Enroll up to 20 contacts ────────────────────────────────────────
-- Filter:
--   - status='valid', has email, never contacted before
--   - skip placeholder/numeric/role-based local parts
--   - skip education/government domains
--   - machinery-relevant industry_tags
--   - not in either suppression table
--   - not already in any active campaign
-- Sort: md5(email) is deterministic pseudo-random — re-runs yield same set.
-- ON CONFLICT DO NOTHING means re-runs never duplicate.
INSERT INTO campaign_contacts (campaign_id, contact_id, status, current_step)
SELECT
    lc.id,
    c.id,
    'pending',
    0
FROM _launch_campaign lc
CROSS JOIN LATERAL (
    -- Two-stage selection:
    --   1. Filter eligible contacts and dedupe by lowercased email
    --      (production data has multiple contact_id rows for the same
    --      email; without dedupe, the same address would receive the
    --      same email twice in one tick).
    --   2. Random-stable pick of 20 from the deduped pool via md5(email).
    WITH eligible AS (
        SELECT DISTINCT ON (lower(c.email)) c.id, c.email
        FROM contacts c
        JOIN outreach_contacts oc ON oc.email_hash = c.email_hash
        WHERE c.status = 'valid'
          AND c.email IS NOT NULL AND c.email <> ''
          AND oc.last_contacted IS NULL
          AND c.email !~ '^[0-9]+@'
          AND length(split_part(c.email, '@', 1)) >= 3
          AND lower(split_part(c.email, '@', 1)) NOT IN (
            'noreply','no-reply','postmaster','notifications','mailer-daemon',
            'bounce','bounces','reklamace','dotazy'
          )
          AND lower(c.email) !~ '@(.*\.)?(vutbr|cuni|jamu|muni|czu|gov|edu)\.cz$'
          AND oc.industry_tags && ARRAY[
            'machinery','metalwork','construction','agriculture','transport',
            'automotive','woodwork','plastics','food_processing','chemicals',
            'waste','energy','printing'
          ]::text[]
          AND lower(trim(c.email)) NOT IN (
            SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL
            UNION
            SELECT lower(trim(email)) FROM suppression_list      WHERE email IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM campaign_contacts cc
            JOIN campaigns cmp ON cmp.id = cc.campaign_id
            WHERE cc.contact_id = c.id
              AND cmp.status IN ('draft','running','active','paused')
              AND cmp.id <> lc.id
          )
        ORDER BY lower(c.email), c.id  -- deterministic dedupe: pick lowest id
    )
    SELECT id FROM eligible
    ORDER BY md5(email)
    LIMIT 20  -- EDIT HERE: batch size
) c
ON CONFLICT (campaign_id, contact_id) DO NOTHING;

-- ── 4. Post-enrollment assertion ───────────────────────────────────────
-- If enrollment yielded fewer than 20 rows, ROLLBACK so the operator
-- can investigate (filter too tight, candidates exhausted, etc.).
DO $$
DECLARE
    enrolled int;
    expected int := 20;  -- EDIT HERE: must match LIMIT above
BEGIN
    SELECT COUNT(*) INTO enrolled
    FROM campaign_contacts cc
    JOIN _launch_campaign lc ON lc.id = cc.campaign_id;

    IF enrolled < expected THEN
        RAISE EXCEPTION 'enrollment FAIL: only % rows in campaign_contacts, expected %. '
            'Either filter is too tight or candidate pool is exhausted. '
            'ROLLBACK to keep DB clean.',
            enrolled, expected;
    END IF;
    RAISE NOTICE 'enrollment OK: % contacts in campaign_contacts', enrolled;
END $$;

-- ── 5. Summary ─────────────────────────────────────────────────────────
SELECT
    lc.id           AS campaign_id,
    cmp.name        AS campaign_name,
    cmp.status      AS campaign_status,
    COUNT(cc.id)    AS enrolled_count
FROM _launch_campaign lc
JOIN campaigns cmp ON cmp.id = lc.id
LEFT JOIN campaign_contacts cc ON cc.campaign_id = lc.id
GROUP BY lc.id, cmp.name, cmp.status;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- Next steps (manual, operator):
--   1. Verify campaign_id from output above
--   2. Open dashboard → Campaigns → pick this campaign
--   3. Verify preflight gate is GREEN before clicking Run
--   4. Send-test from each mailbox (mb=631, mb=632) to operator's own
--      address as a smoke check
--   5. Click "Run" only after preflight + send-test both pass
--   6. Monitor mailbox_alerts + send_events + reply_inbox for 24h
-- ════════════════════════════════════════════════════════════════════════

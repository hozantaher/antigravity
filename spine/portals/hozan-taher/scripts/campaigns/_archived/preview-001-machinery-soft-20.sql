-- ════════════════════════════════════════════════════════════════════════
-- Preview script for launch-001-machinery-soft-20.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Read-only sanity check. Run BEFORE launching the campaign so the
-- operator can:
--   1. Confirm candidate pool size is sane (not 5, not 50000)
--   2. Eyeball the top-20 emails that would be enrolled
--   3. Verify suppression lists are populated (preflight depends on this)
--   4. Verify mailboxes are ready (status=active, password set, recent
--      successful full-check)
--
-- Safe to run anytime — no INSERT/UPDATE. No transaction needed.
-- ════════════════════════════════════════════════════════════════════════

\set RELEVANT_SECTORS '''{machinery,metalwork,construction,agriculture,transport,automotive,woodwork,plastics,food_processing,chemicals,waste,energy,printing}'''
\set BATCH_LIMIT 20

-- ── 1. Candidate pool size by sector ───────────────────────────────────
-- How many eligible contacts per sector. Catches the "we have 0 in
-- agriculture, 5000 in construction" case where the soft-launch sample
-- would skew toward one industry only.
\echo
\echo '── 1. Eligible candidates by primary industry tag ──────────────────'
SELECT
    unnest(oc.industry_tags) AS industry_tag,
    COUNT(*) AS n
FROM contacts c
JOIN outreach_contacts oc ON oc.email_hash = c.email_hash
WHERE c.status = 'valid'
  AND c.email IS NOT NULL AND c.email <> ''
  AND oc.industry_tags && :RELEVANT_SECTORS::text[]
  AND lower(trim(c.email)) NOT IN (
    SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL
    UNION
    SELECT lower(trim(email)) FROM suppression_list      WHERE email IS NOT NULL
  )
GROUP BY 1
ORDER BY n DESC;

-- ── 2. Top-20 preview (exact rows that would be enrolled) ──────────────
-- Mirrors the launch script's selection. Operator should scan this list
-- for obvious red flags: internal domains, role-based addresses, spam
-- traps, dead companies.
\echo
\echo '── 2. Top-20 preview (these exact rows would be enrolled) ──────────'
SELECT
    c.id AS contact_id,
    c.email,
    c.first_name,
    c.last_name,
    c.company_name,
    c.region,
    oc.targeting_score,
    oc.industry_tags
FROM contacts c
JOIN outreach_contacts oc ON oc.email_hash = c.email_hash
WHERE c.status = 'valid'
  AND c.email IS NOT NULL AND c.email <> ''
  AND oc.industry_tags && :RELEVANT_SECTORS::text[]
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
  )
ORDER BY oc.targeting_score DESC NULLS LAST, c.email ASC
LIMIT :BATCH_LIMIT;

-- ── 3. Suppression sanity ──────────────────────────────────────────────
-- Both tables non-empty. Empty list = preflight gate would block, AND
-- compliance gap (anyone could be on either internal opt-out and we'd
-- still send).
\echo
\echo '── 3. Suppression list health (both tables — see commit e000fb9) ───'
SELECT
    'outreach_suppressions' AS source,
    COUNT(*) AS rows
FROM outreach_suppressions WHERE email IS NOT NULL
UNION ALL
SELECT
    'suppression_list' AS source,
    COUNT(*) AS rows
FROM suppression_list WHERE email IS NOT NULL;

-- ── 4. Mailbox readiness ───────────────────────────────────────────────
-- Operator must see status=active, password set (we never display the
-- password, just NOT NULL), and a successful full-check within the last
-- 6 hours. Anything else and the preflight gate would refuse to unpause.
\echo
\echo '── 4. Mailbox readiness (only active mailboxes shown) ──────────────'
SELECT
    m.id,
    m.from_address,
    m.status,
    (m.password IS NOT NULL AND m.password <> '') AS password_set,
    m.daily_cap_override,
    m.proxy_url IS NOT NULL AS has_proxy,
    h.checked_at AS last_check_at,
    h.ok AS last_check_ok,
    EXTRACT(EPOCH FROM (now() - h.checked_at))::int / 60 AS check_age_minutes
FROM outreach_mailboxes m
LEFT JOIN LATERAL (
    SELECT ok, checked_at FROM mailbox_check_history
    WHERE mailbox_id = m.id ORDER BY checked_at DESC LIMIT 1
) h ON true
WHERE m.status = 'active'
ORDER BY m.id;

-- ── 5. Anti-trace relay env ────────────────────────────────────────────
-- The runner panics on missing AntiTraceClient (sender.ErrAntiTraceRequired,
-- engine.go:267). If ANTI_TRACE_URL is unset in the orchestrator env,
-- engine.Run returns an error before any send. Operator should confirm
-- via Railway env vars on the orchestrator service. This query just
-- surfaces a hint from the dashboard's mirrored config table — true
-- source of truth is Railway dashboard.
\echo
\echo '── 5. Anti-trace relay config hint ─────────────────────────────────'
SELECT
    key,
    CASE WHEN length(value) > 0 THEN '✓ set (' || length(value) || ' chars)' ELSE '✗ EMPTY' END AS status
FROM outreach_config
WHERE key IN ('anti_trace_url', 'anti_trace_relay_url', 'last_relay_health_at')
ORDER BY key;

-- ── 6. Active campaigns already running (avoid double-launch) ──────────
\echo
\echo '── 6. Existing campaigns in non-terminal status ────────────────────'
SELECT
    id,
    name,
    status,
    created_at,
    (SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = c.id) AS enrolled,
    (SELECT COUNT(*) FROM send_events se WHERE se.campaign_id = c.id) AS sends_so_far
FROM campaigns c
WHERE status IN ('draft','running','active','paused')
ORDER BY created_at DESC
LIMIT 10;

\echo
\echo '── Preview complete. If sections 1–6 look sane, run:'
\echo '   psql ... -f scripts/campaigns/launch-001-machinery-soft-20.sql'
\echo

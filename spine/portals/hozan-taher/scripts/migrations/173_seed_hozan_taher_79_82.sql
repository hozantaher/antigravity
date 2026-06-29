-- ════════════════════════════════════════════════════════════════════════
-- 173 — Seed 4 new send mailboxes: hozan.taher.79-82@post.cz
-- ════════════════════════════════════════════════════════════════════════
--
-- Operator provisioned 4 additional post.cz accounts to expand outbound
-- send capacity. This seeds their outreach_mailboxes rows as exact peers of
-- the existing hozan.taher.{75,76,77,78}@post.cz fleet (ids 1180-1183).
--
-- WHY a DB row is mandatory (not optional):
--   The send_events BEFORE-INSERT trigger `enforce_warmup_cap()` RAISEs
--   `mailbox_not_in_db` and blocks the send for any from_address that has no
--   outreach_mailboxes row (env-var fallback hardening, 2026-05-13). So the
--   DB row is what actually unblocks sending for these addresses, AND it is
--   the registry allow-set the Go engine (sender/engine.go pickMailbox)
--   cross-checks before dispatching.
--
-- Lifecycle phase = 'production' (100/day) per operator decision 2026-06-23 —
-- matches the .75-.78 fleet, full capacity immediately. Note: the daily cap
-- is enforced by enforce_warmup_cap() reading lifecycle_phase ->
-- compute_daily_cap(phase, override). The auto-ramp function
-- advance_lifecycle_phase() is currently ABSENT in prod (migration 071
-- drift), so this phase value is sticky. If that function is ever restored,
-- it recomputes phase from created_at and would knock these (created today)
-- back to warmup_d0 — re-set to 'production' or backdate if that happens.
--
-- Password (123p123p123) is the fleet-wide credential. It trips the Go
-- mailbox.IsPlaceholderPassword heuristic (123p prefix + repeated trigram),
-- which only gates the cmd/anonymity-test CLI (escape: --allow-placeholder-
-- password). It does NOT gate production send, BFF preflight, or the UI badge
-- (the JS detector does not flag it). Matches existing .75-.78 exactly.
--
-- NOT integrated here (operator follow-up — outside DB scope):
--   - Railway env MAILBOX_N_* on machinery-outreach: the 24/7 Go daemon's
--     send list = config.LoadFromEnv() (MAILBOX_1.., contiguous, stops at
--     first gap). The DB row makes a mailbox ALLOWED + pollable; the engine
--     only DISPATCHES from mailboxes present in cfg.Mailboxes. Add
--     MAILBOX_5..8_* (ADDRESS/SMTP_HOST/SMTP_PORT/USERNAME/PASSWORD/
--     IMAP_HOST/IMAP_PORT/DAILY_LIMIT) to actually send via the daemon.
--   - services/orchestrator/thread/inbound.go InternalSenderAddresses — add
--     the 4 addresses (mb-to-mb / smoke inbound classification). Separate PR.
--
-- Idempotent: ON CONFLICT (from_address) DO NOTHING. Re-running is a no-op.
-- Reversible: DELETE FROM outreach_mailboxes WHERE from_address LIKE
--   'hozan.taher.8%@post.cz' OR from_address='hozan.taher.79@post.cz';
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO outreach_mailboxes (
    from_address, email, display_name,
    smtp_host, smtp_port, smtp_username, smtp_user,
    imap_host, imap_port, imap_username,
    password,
    status, environment, lifecycle_phase,
    daily_cap_override, tz, locale,
    status_reason,
    created_at, updated_at  -- nullable, NO default; OverlayRegistry store.List
                            -- scans created_at into a non-null *time.Time, so a
                            -- NULL row makes the whole boot overlay fail
)
VALUES
    ('hozan.taher.79@post.cz', 'hozan.taher.79@post.cz', 'Hozan Taher',
     'smtp.post.cz', 465, 'hozan.taher.79@post.cz', 'hozan.taher.79@post.cz',
     'imap.post.cz', 993, 'hozan.taher.79@post.cz',
     '123p123p123',
     'active', 'production', 'production',
     100, 'Europe/Prague', 'cs',
     'mig173 fleet expansion 2026-06-23', NOW(), NOW()),

    ('hozan.taher.80@post.cz', 'hozan.taher.80@post.cz', 'Hozan Taher',
     'smtp.post.cz', 465, 'hozan.taher.80@post.cz', 'hozan.taher.80@post.cz',
     'imap.post.cz', 993, 'hozan.taher.80@post.cz',
     '123p123p123',
     'active', 'production', 'production',
     100, 'Europe/Prague', 'cs',
     'mig173 fleet expansion 2026-06-23', NOW(), NOW()),

    ('hozan.taher.81@post.cz', 'hozan.taher.81@post.cz', 'Hozan Taher',
     'smtp.post.cz', 465, 'hozan.taher.81@post.cz', 'hozan.taher.81@post.cz',
     'imap.post.cz', 993, 'hozan.taher.81@post.cz',
     '123p123p123',
     'active', 'production', 'production',
     100, 'Europe/Prague', 'cs',
     'mig173 fleet expansion 2026-06-23', NOW(), NOW()),

    ('hozan.taher.82@post.cz', 'hozan.taher.82@post.cz', 'Hozan Taher',
     'smtp.post.cz', 465, 'hozan.taher.82@post.cz', 'hozan.taher.82@post.cz',
     'imap.post.cz', 993, 'hozan.taher.82@post.cz',
     '123p123p123',
     'active', 'production', 'production',
     100, 'Europe/Prague', 'cs',
     'mig173 fleet expansion 2026-06-23', NOW(), NOW())
ON CONFLICT (from_address) DO NOTHING;

-- Audit the mutation (feedback_audit_log_on_mutations) — one row per insert
-- actually applied (ON CONFLICT skips are not counted).
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
SELECT 'mailbox_create', 'migration', 'mailbox', m.id,
       jsonb_build_object(
         'from_address', m.from_address,
         'migration', '173_seed_hozan_taher_79_82.sql',
         'lifecycle_phase', m.lifecycle_phase,
         'reason', 'fleet expansion .79-.82 — operator decision: production cap',
         'reversible', true)
FROM outreach_mailboxes m
WHERE m.from_address IN (
    'hozan.taher.79@post.cz','hozan.taher.80@post.cz',
    'hozan.taher.81@post.cz','hozan.taher.82@post.cz')
  AND m.status_reason = 'mig173 fleet expansion 2026-06-23';

COMMIT;

-- Verify (feedback_verify_select_after_migration)
\echo ''
\echo '── 173 applied — new mailbox rows:'
SELECT id, from_address, status, environment, lifecycle_phase,
       compute_daily_cap(lifecycle_phase, daily_cap_override) AS effective_cap,
       (password = '123p123p123') AS pw_ok
FROM outreach_mailboxes
WHERE from_address LIKE 'hozan.taher.8%@post.cz'
   OR from_address = 'hozan.taher.79@post.cz'
ORDER BY from_address;

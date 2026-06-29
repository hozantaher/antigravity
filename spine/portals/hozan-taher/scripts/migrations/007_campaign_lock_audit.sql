-- ════════════════════════════════════════════════════════════════════════
-- BF-E4 / BF-D5 — campaign_lock_audit table for advisory-lock TTL guard
-- ════════════════════════════════════════════════════════════════════════
--
-- Postgres advisory locks (pg_try_advisory_lock) are session-scoped:
-- they auto-release when the holding connection closes. If a connection
-- is killed (Railway redeploy, OOM) the lock IS released.
--
-- BUT: a long-idle connection that's still healthy at the TCP level can
-- hold a stale lock indefinitely. There's no observability into who is
-- holding the lock from the application side — pg_locks tells us a lock
-- is held but not by which campaign tick.
--
-- This audit table runs in parallel with the actual advisory lock:
--   - INSERT on successful TryAdvisoryLock
--   - DELETE on ReleaseAdvisoryLock (or session close — see cleanup query)
--   - Health check selects rows older than TTL_MINUTES and emits a warning
--     so operators can decide whether to kill the holder connection.

CREATE TABLE IF NOT EXISTS campaign_lock_audit (
    id           SERIAL PRIMARY KEY,
    campaign_id  BIGINT NOT NULL,
    locked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    host         TEXT,           -- host/pid of the holder (filled by Go side)
    UNIQUE (campaign_id)         -- only one acquisition record per campaign
);

CREATE INDEX IF NOT EXISTS idx_campaign_lock_audit_locked_at
    ON campaign_lock_audit (locked_at);

COMMENT ON TABLE campaign_lock_audit IS
'BF-E4: advisory-lock TTL audit. Operator-visible record of which campaign tick is currently in-flight.';

-- ── Cleanup helper ──────────────────────────────────────────────────────
-- Removes audit rows for sessions that no longer exist. Useful after a
-- redeploy where the locker process died without reaching its DEFER.
-- Returns number of rows removed.
CREATE OR REPLACE FUNCTION campaign_lock_audit_cleanup_stale()
RETURNS INTEGER AS $fn$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM campaign_lock_audit a
  WHERE NOT EXISTS (
      SELECT 1 FROM pg_locks l
       WHERE l.locktype = 'advisory'
         AND l.objid = a.campaign_id::bigint
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION campaign_lock_audit_cleanup_stale() IS
'BF-E4: drop audit rows whose advisory lock is no longer held. Safe to call from a periodic health check.';

-- Audit log
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '007_campaign_lock_audit',
    jsonb_build_object(
        'description', 'BF-E4: advisory-lock TTL audit table + cleanup function',
        'idempotent', true
    )
);

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion

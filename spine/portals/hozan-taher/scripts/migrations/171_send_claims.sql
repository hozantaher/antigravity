-- 171_send_claims.sql
--
-- Exactly-once send-claim ledger. The single, shared, durable, atomic gate
-- that BOTH send paths (Go daemon engine + Node campaign-send-batch.mjs)
-- acquire immediately before submitting one email to the anti-trace-relay.
--
-- WHY THIS EXISTS (operator request 2026-06-22):
--   The two send paths historically used incompatible, path-local guards —
--   Path A an optimistic CAS on campaign_contacts(id,current_step), Path B a
--   FOR UPDATE SKIP LOCKED + operator_audit_log read. Neither could see the
--   other, so the "run only one path per campaign at a time" rule in
--   docs/subsystem-maps/send-paths.md was MANUAL operator discipline. The
--   relay has no Postgres and no idempotency, and neither send_events nor
--   campaign_contacts carried a UNIQUE constraint. This table is the missing
--   shared chokepoint that makes "same (campaign,contact,step) sent at most
--   once" a machine-enforced invariant rather than a convention.
--
--   This is NOT sender/dedup_guard.go (cross-campaign cooldown / lifetime
--   touches / per-domain) — that is policy/cadence ("should we contact this
--   person at all right now?"). send_claims is technical idempotence ("are we
--   about to PHYSICALLY send this exact message twice due to a retry, crash,
--   or path race?"). The two are orthogonal and complementary.
--
-- IDENTITY OF "ONE EMAIL" = (campaign_id, contact_id, step).
--   A follow-up is a different step → a different claim → never blocked.
--   A deliberate operator re-send is a sanctioned exception (relabel the
--   prior send_events 'sent' row + bump the claim attempt); it is NOT what
--   this gate prevents. The gate prevents UNINTENTIONAL duplicates.
--
-- LIFECYCLE (status column):
--   claiming → sent      (confirmed after a successful relay submit)
--   claiming → failed    (released after a submit error; re-claimable)
--   claiming → expired   (stale-claim sweep when the in_flight lease is
--                         reaped; re-claimable — see the reaper coupling in
--                         services/campaigns/campaign/in_flight_reaper.go and
--                         apps/outreach-dashboard/src/crons/runCampaignContactsStaleReclaim.js)
--
-- The UNIQUE(campaign_id, contact_id, step) constraint is the actual mutex:
-- the atomic claim is a single INSERT ... ON CONFLICT DO UPDATE ... WHERE
-- status IN ('failed','expired') statement, so Postgres performs the mutual
-- exclusion and no application-level race exists. See sender/sendclaim.go
-- (Go) and src/lib/sendClaim.js (Node) for the exact claim CTE.
--
-- Idempotent (IF NOT EXISTS). No manual schema_migrations insert — run.sh
-- records bookkeeping (matches the 151 convention).

CREATE TABLE IF NOT EXISTS send_claims (
    id           BIGSERIAL PRIMARY KEY,
    campaign_id  BIGINT  NOT NULL,
    contact_id   BIGINT  NOT NULL,
    step         INTEGER NOT NULL,
    -- Lifecycle state. CHECK documents the closed set + catches typo drift in
    -- the two independent (Go + JS) claim implementations.
    status       TEXT    NOT NULL DEFAULT 'claiming'
                 CHECK (status IN ('claiming', 'sent', 'failed', 'expired')),
    -- Monotonic per-key attempt counter, bumped on every (re)claim. Pure
    -- observability — NOT part of the unique key, so a retry reuses the same
    -- row rather than accumulating ledger rows per (campaign,contact,step).
    attempt      INTEGER NOT NULL DEFAULT 1,
    -- Which path acquired the claim: 'go_engine' | 'node_batch'. Lets the
    -- operator attribute a duplicate-prevented event to a send path.
    claimed_by   TEXT,
    -- Relay envelope_id, written on confirm. Null while 'claiming'/'failed'.
    envelope_id  TEXT,
    -- claimed_at = when the CURRENT claim attempt started (reset on re-claim).
    -- This is the column the stale-claim sweep ages out against.
    claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- THE MUTEX. One claim per logical message.
    CONSTRAINT uq_send_claims_key UNIQUE (campaign_id, contact_id, step)
);

-- Sweep index: the reaper coupling expires rows
-- WHERE status='claiming' AND claimed_at < now() - <stale threshold>.
CREATE INDEX IF NOT EXISTS idx_send_claims_sweep
    ON send_claims (status, claimed_at);

COMMENT ON TABLE send_claims IS
'Exactly-once send-claim ledger (migration 171). Shared atomic gate both send paths acquire before relay submit. See docs/subsystem-maps/send-paths.md + anti-trace.md.';

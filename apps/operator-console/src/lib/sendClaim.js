// sendClaim.js — exactly-once send-claim layer (Node twin of
// services/campaigns/sender/sendclaim.go, migration 171 send_claims).
//
// The operator send script (campaign-send-batch.mjs) and the Go daemon engine
// share ONE mutex: the UNIQUE(campaign_id, contact_id, step) constraint on the
// send_claims table. Both run the identical atomic claim CTE before submitting
// to the anti-trace-relay, so the dual send-path race documented in
// docs/subsystem-maps/send-paths.md is machine-enforced, not operator
// discipline. Keep this in lock-step with sendclaim.go — same SQL, same
// decision semantics.
//
// This is NOT a re-contact policy (that is sender/dedup_guard.go). It is
// technical idempotence: "are we about to physically send this exact message
// twice due to a retry / crash / path race?".

/** Claim decisions, mirroring sender.ClaimDecision in sendclaim.go. */
export const CLAIM_PROCEED = 'proceed'
export const CLAIM_ALREADY_SENT = 'already_sent'
export const CLAIM_IN_FLIGHT_ELSEWHERE = 'in_flight_elsewhere'

/** claimed_by tag stored in send_claims so a prevented duplicate is attributable. */
export const CLAIMED_BY_NODE_BATCH = 'node_batch'

/**
 * Atomically claim (campaignId, contactId, step) for sending. The single CTE
 * is the whole gate: INSERT ... ON CONFLICT DO UPDATE ... WHERE status IN
 * ('failed','expired') either inserts a fresh 'claiming' row, takes over a
 * failed/expired one (both → acquired), or does nothing because the row is
 * 'claiming'/'sent'. EXISTS(ins) is true exactly when we wrote. A vanished row
 * (delete race) defaults to 'claiming' — the safe choice is to skip, never to
 * double-send.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {number} campaignId
 * @param {number} contactId
 * @param {number} step
 * @param {string} [claimedBy]
 * @returns {Promise<'proceed'|'already_sent'|'in_flight_elsewhere'>}
 */
export async function acquireClaim(db, campaignId, contactId, step, claimedBy = CLAIMED_BY_NODE_BATCH) {
  const { rows } = await db.query(
    `WITH ins AS (
       INSERT INTO send_claims
         (campaign_id, contact_id, step, status, attempt, claimed_by, claimed_at, updated_at)
       VALUES ($1, $2, $3, 'claiming', 1, $4, now(), now())
       ON CONFLICT (campaign_id, contact_id, step) DO UPDATE
         SET status       = 'claiming',
             attempt      = send_claims.attempt + 1,
             claimed_by   = $4,
             claimed_at   = now(),
             updated_at   = now(),
             envelope_id  = NULL,
             confirmed_at = NULL
         WHERE send_claims.status IN ('failed', 'expired')
       RETURNING id
     )
     SELECT CASE
              WHEN EXISTS (SELECT 1 FROM ins) THEN 'acquired'
              ELSE COALESCE(
                     (SELECT status FROM send_claims
                       WHERE campaign_id = $1 AND contact_id = $2 AND step = $3),
                     'claiming')
            END AS outcome`,
    [campaignId, contactId, step, claimedBy],
  )
  switch (rows[0] && rows[0].outcome) {
    case 'acquired': return CLAIM_PROCEED
    case 'sent':     return CLAIM_ALREADY_SENT
    case 'claiming': return CLAIM_IN_FLIGHT_ELSEWHERE
    default:         return CLAIM_IN_FLIGHT_ELSEWHERE // fail-safe: do not send
  }
}

/**
 * Promote a held 'claiming' row to 'sent' after a successful relay submit.
 * CAS on status='claiming' → idempotent. Returns rows affected.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 */
export async function confirmClaim(db, campaignId, contactId, step, envelopeId) {
  const { rowCount } = await db.query(
    `UPDATE send_claims
        SET status       = 'sent',
            envelope_id  = $4,
            confirmed_at = now(),
            updated_at   = now()
      WHERE campaign_id = $1 AND contact_id = $2 AND step = $3
        AND status = 'claiming'`,
    [campaignId, contactId, step, envelopeId || null],
  )
  return rowCount
}

/**
 * Release a held 'claiming' row to 'failed' after a submit error so a retry can
 * re-claim. CAS on status='claiming' → idempotent. Returns rows affected.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 */
export async function releaseClaim(db, campaignId, contactId, step) {
  const { rowCount } = await db.query(
    `UPDATE send_claims
        SET status     = 'failed',
            updated_at = now()
      WHERE campaign_id = $1 AND contact_id = $2 AND step = $3
        AND status = 'claiming'`,
    [campaignId, contactId, step],
  )
  return rowCount
}

/**
 * Bulk-expire 'claiming' claims for a set of reclaimed contacts so that a
 * contact whose stuck in_flight lease was reset becomes re-claimable. Called by
 * the stale-lease reclaim cron with the rows it reclaimed (migration 171
 * coupling — without it a crashed sender's claim would block the contact
 * forever). Uses unnest so one statement handles the whole batch.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {Array<{campaign_id: number, contact_id: number}>} contacts
 * @returns {Promise<number>} rows expired
 */
export async function expireClaimsForContacts(db, contacts) {
  if (!contacts || contacts.length === 0) return 0
  const campaignIds = contacts.map((c) => c.campaign_id)
  const contactIds = contacts.map((c) => c.contact_id)
  const { rowCount } = await db.query(
    `UPDATE send_claims sc
        SET status     = 'expired',
            updated_at = now()
       FROM unnest($1::bigint[], $2::bigint[]) AS r(campaign_id, contact_id)
      WHERE sc.campaign_id = r.campaign_id
        AND sc.contact_id  = r.contact_id
        AND sc.status = 'claiming'`,
    [campaignIds, contactIds],
  )
  return rowCount
}

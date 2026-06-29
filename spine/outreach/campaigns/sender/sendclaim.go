// sendclaim.go — exactly-once send-claim layer (migration 171 send_claims).
//
// The single, shared, durable, atomic gate that BOTH send paths cross
// immediately before submitting one email to the anti-trace-relay:
//   - Path A (Go daemon): Engine.Run calls the injected ClaimFunc right
//     before antiTrace.Send (see WithSendClaim + the gate in engine.go).
//   - Path B (Node operator script): apps/outreach-dashboard/campaign-send-batch.mjs
//     runs the identical claim CTE via src/lib/sendClaim.js before fetch /v1/submit.
//
// The UNIQUE(campaign_id, contact_id, step) constraint on send_claims is the
// real mutex: AcquireClaim is one INSERT ... ON CONFLICT DO UPDATE ... WHERE
// status IN ('failed','expired') statement, so Postgres performs the mutual
// exclusion and there is NO application-level race. Two engines, two paths, a
// retry, or a crash-then-retry can all call AcquireClaim concurrently for the
// same (campaign,contact,step); at most one gets ClaimProceed.
//
// This is NOT dedup_guard.go. dedup_guard is policy/cadence (cross-campaign
// cooldown, lifetime touches, per-domain) — "should we contact this person at
// all?". send_claims is technical idempotence — "are we about to physically
// send this exact message twice?". Orthogonal and complementary; both run, in
// that order (dedup_guard pre-enqueue in the runner, send-claim pre-submit in
// the engine).
//
// Residual window (documented honestly): the claim is acquired, then the relay
// is called, then the claim is confirmed in the onSent callback. If the
// process dies in the sub-second window AFTER the relay accepted the message
// (202) but BEFORE ConfirmClaim commits, a later reaper-driven retry can
// re-send. Closing that final window requires an Idempotency-Key inside the
// relay itself (deferred by operator decision 2026-06-22). This layer
// eliminates every other duplicate vector: the dual-path race, concurrent
// ticks, retries after a failed submit, double-enqueue, and duplicate records.
//
// Slog op-field discipline (services/campaigns/CLAUDE.md): "op",
// "sender.<func>/<branch>" + "error" key (not "err").

package sender

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ClaimedByGoEngine / ClaimedByNodeBatch tag which send path acquired a claim,
// stored in send_claims.claimed_by so a duplicate-prevented event is
// attributable. The Node twin (src/lib/sendClaim.js) writes 'node_batch'.
const (
	ClaimedByGoEngine  = "go_engine"
	ClaimedByNodeBatch = "node_batch"
)

// ClaimDecision is the outcome of AcquireClaim for one (campaign,contact,step).
type ClaimDecision int

const (
	// ClaimProceed — this caller now owns the claim (a fresh INSERT, or a
	// takeover of a previously failed/expired claim). Proceed to submit.
	ClaimProceed ClaimDecision = iota
	// ClaimAlreadySent — a confirmed 'sent' claim already exists. Skip the
	// submit; the message was already delivered. The caller should finalize
	// the contact as sent (NOT insert a duplicate send_events row).
	ClaimAlreadySent
	// ClaimInFlightElsewhere — another caller holds a fresh 'claiming' lease.
	// Skip the submit and leave the contact's reservation untouched: the
	// holder finalizes it, or the stale-claim reaper recovers it. No duplicate.
	ClaimInFlightElsewhere
)

// String renders a ClaimDecision for structured logs.
func (d ClaimDecision) String() string {
	switch d {
	case ClaimProceed:
		return "proceed"
	case ClaimAlreadySent:
		return "already_sent"
	case ClaimInFlightElsewhere:
		return "in_flight_elsewhere"
	default:
		return "unknown"
	}
}

// ClaimFunc is the engine's injected gate (see Engine.WithSendClaim). It is
// called once per dispatched SendRequest immediately before the relay submit.
// A nil ClaimFunc disables the gate (legacy / unit-test path).
type ClaimFunc func(ctx context.Context, req SendRequest) (ClaimDecision, error)

// ClaimDB is the minimum DB surface the claim helpers need. Both *sql.DB and
// *sql.Tx satisfy it, plus go-sqlmock in tests. Mirrors DedupQuerier's shape.
type ClaimDB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// ErrDuplicateAlreadySent / ErrDuplicateInFlight are surfaced through
// SendResult.Error when the gate skips a send, so the orchestrator onSent
// callback can route the skip via errors.Is — exactly the pattern
// ErrPreSendDomainCheck uses. They are NOT real SMTP errors; recordSendResult
// is intentionally NOT called for them (a skip is not a send attempt).
var (
	ErrDuplicateAlreadySent = errors.New("send-claim: already sent (duplicate prevented)")
	ErrDuplicateInFlight    = errors.New("send-claim: in-flight elsewhere (duplicate prevented)")
)

// IsDuplicateSkip reports whether err is one of the send-claim skip sentinels.
// Used by the orchestrator callback and the audit ratchet.
func IsDuplicateSkip(err error) bool {
	return errors.Is(err, ErrDuplicateAlreadySent) || errors.Is(err, ErrDuplicateInFlight)
}

// AcquireClaim atomically claims (campaign_id, contact_id, step) for sending.
//
// The single CTE below is the whole gate. The INSERT ... ON CONFLICT DO UPDATE
// ... WHERE status IN ('failed','expired') either:
//   - inserts a fresh 'claiming' row (no prior claim)            → acquired
//   - takes over a 'failed'/'expired' row, bumping attempt       → acquired
//   - does nothing because the row is 'claiming'/'sent'          → not acquired
//
// `EXISTS (SELECT 1 FROM ins)` is true exactly when we wrote (insert OR
// takeover) → 'acquired'. Otherwise we read the existing status. The COALESCE
// fallback treats a vanished row (delete race) as 'claiming' — the safe
// default is to skip and let a later tick retry, never to double-send.
func AcquireClaim(ctx context.Context, db ClaimDB, req SendRequest, claimedBy string) (ClaimDecision, error) {
	const q = `
		WITH ins AS (
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
		       END`
	var outcome string
	err := db.QueryRowContext(ctx, q, req.CampaignID, req.ContactID, req.Step, claimedBy).Scan(&outcome)
	if err != nil {
		return ClaimInFlightElsewhere, fmt.Errorf("AcquireClaim: %w", err)
	}
	switch outcome {
	case "acquired":
		return ClaimProceed, nil
	case "sent":
		return ClaimAlreadySent, nil
	case "claiming":
		return ClaimInFlightElsewhere, nil
	default:
		// Defensive: any unexpected status (e.g. a future lifecycle value)
		// is treated as "do not send" — fail safe toward no-duplicate.
		slog.Warn("AcquireClaim unexpected outcome — treating as in-flight",
			"op", "sender.AcquireClaim/unexpectedOutcome",
			"outcome", outcome,
			"campaign_id", req.CampaignID, "contact_id", req.ContactID, "step", req.Step)
		return ClaimInFlightElsewhere, nil
	}
}

// ConfirmClaim promotes a held 'claiming' row to 'sent' after a successful
// relay submit, recording the envelope_id. CAS on status='claiming' makes it
// idempotent: a duplicate callback (engine quirk, reaper) matches 0 rows.
// Returns rows affected for observability.
func ConfirmClaim(ctx context.Context, db ClaimDB, req SendRequest, envelopeID string) (int64, error) {
	res, err := db.ExecContext(ctx,
		`UPDATE send_claims
		    SET status       = 'sent',
		        envelope_id  = $4,
		        confirmed_at = now(),
		        updated_at   = now()
		  WHERE campaign_id = $1 AND contact_id = $2 AND step = $3
		    AND status = 'claiming'`,
		req.CampaignID, req.ContactID, req.Step, nullableClaimEnvelope(envelopeID),
	)
	if err != nil {
		return 0, fmt.Errorf("ConfirmClaim: %w", err)
	}
	rows, _ := res.RowsAffected()
	return rows, nil
}

// ReleaseClaim moves a held 'claiming' row to 'failed' after a submit error so
// a controlled retry can re-claim it. CAS on status='claiming' → idempotent.
func ReleaseClaim(ctx context.Context, db ClaimDB, req SendRequest) (int64, error) {
	res, err := db.ExecContext(ctx,
		`UPDATE send_claims
		    SET status     = 'failed',
		        updated_at = now()
		  WHERE campaign_id = $1 AND contact_id = $2 AND step = $3
		    AND status = 'claiming'`,
		req.CampaignID, req.ContactID, req.Step,
	)
	if err != nil {
		return 0, fmt.Errorf("ReleaseClaim: %w", err)
	}
	rows, _ := res.RowsAffected()
	return rows, nil
}

// ExpireClaimForContact moves any 'claiming' rows for a (campaign,contact) to
// 'expired' so the contact is re-claimable. Called by the in_flight-lease
// reapers when they reset a stuck contact back to 'pending' — without this,
// a crashed sender's 'claiming' row would block the contact forever. Expiring
// by (campaign,contact) regardless of step is safe: a contact has at most one
// in-flight send at a time. Returns rows affected.
func ExpireClaimForContact(ctx context.Context, db ClaimDB, campaignID, contactID int64) (int64, error) {
	res, err := db.ExecContext(ctx,
		`UPDATE send_claims
		    SET status     = 'expired',
		        updated_at = now()
		  WHERE campaign_id = $1 AND contact_id = $2
		    AND status = 'claiming'`,
		campaignID, contactID,
	)
	if err != nil {
		return 0, fmt.Errorf("ExpireClaimForContact: %w", err)
	}
	rows, _ := res.RowsAffected()
	return rows, nil
}

// ExpireStaleClaims is a defensive blanket sweep: any 'claiming' row older than
// olderThan is moved to 'expired'. The per-contact reaper coupling
// (ExpireClaimForContact) is the primary path; this exists as a standalone
// safety net a daemon can run on a timer. olderThan MUST be a named constant /
// operator_setting, never a bare literal (feedback_no_magic_thresholds).
func ExpireStaleClaims(ctx context.Context, db ClaimDB, olderThan time.Duration) (int64, error) {
	if olderThan <= 0 {
		return 0, fmt.Errorf("ExpireStaleClaims: olderThan must be positive, got %v", olderThan)
	}
	cutoff := time.Now().Add(-olderThan)
	res, err := db.ExecContext(ctx,
		`UPDATE send_claims
		    SET status     = 'expired',
		        updated_at = now()
		  WHERE status = 'claiming'
		    AND claimed_at < $1`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("ExpireStaleClaims: %w", err)
	}
	rows, _ := res.RowsAffected()
	return rows, nil
}

// nullableClaimEnvelope maps an empty envelope id to SQL NULL so the column
// stays clean (a 'sent' claim with no relay id is meaningfully distinct from
// one with id "").
func nullableClaimEnvelope(id string) any {
	if id == "" {
		return nil
	}
	return id
}

// dupSkipResult builds the synthetic SendResult the engine hands to onSent
// when the claim gate skips a send. The sentinel in Error routes the
// orchestrator callback (mirrors preSendSkipResult). MailboxUsed is carried
// for the audit log even though no SMTP attempt was made.
func dupSkipResult(mailbox string, decision ClaimDecision) SendResult {
	err := ErrDuplicateInFlight
	msg := "dup-skip: in-flight elsewhere"
	if decision == ClaimAlreadySent {
		err = ErrDuplicateAlreadySent
		msg = "dup-skip: already sent"
	}
	return SendResult{
		MailboxUsed:  mailbox,
		SMTPResponse: msg,
		Error:        err,
		SentAt:       time.Now(),
	}
}

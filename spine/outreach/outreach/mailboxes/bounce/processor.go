package bounce

import (
	"context"
	"database/sql"
	"log/slog"
	"common/audit"
	"mailboxes/mailbox"
	"strings"
	"time"
)

// BounceType classifies the bounce severity.
type BounceType string

const (
	BounceHard      BounceType = "hard"
	BounceSoft      BounceType = "soft"
	BounceComplaint BounceType = "complaint"
)

// Event represents a parsed bounce notification.
type Event struct {
	OriginalMessageID string
	Type              BounceType
	Code              string
	Reason            string
	RawMessage        string
}

// DB abstracts database operations for testability.
type DB interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// Processor handles bounce classification, blacklisting, and contact status updates.
type Processor struct {
	db       DB
	registry mailbox.Backpressure // optional — updates outreach_mailboxes counters on hard bounce / complaint
}

// NewProcessor creates a bounce processor.
func NewProcessor(db DB) *Processor {
	return &Processor{db: db}
}

// WithMailboxRegistry wires the outreach_mailboxes backpressure adapter so
// that every hard bounce / complaint processed by the inbound pipeline also
// increments the sending mailbox's consecutive_bounces counter and flips the
// mailbox into bounce_hold once the threshold is reached. A nil argument
// keeps the legacy behaviour (no registry update). Fail-safe: registry
// errors are logged and swallowed so a registry outage never blocks bounce
// processing.
func (p *Processor) WithMailboxRegistry(bp mailbox.Backpressure) *Processor {
	p.registry = bp
	return p
}

// Process classifies a bounce and takes appropriate action.
func (p *Processor) Process(event Event) error {
	// Find the original send event. mailbox_used is needed so we can update
	// the outreach_mailboxes registry when the bounce is hard or a complaint.
	var sendEventID, contactID int64
	var email, mailboxUsed string
	err := p.db.QueryRow(
		`SELECT se.id, se.contact_id, c.email, se.mailbox_used
		 FROM send_events se JOIN contacts c ON c.id = se.contact_id
		 WHERE se.message_id = $1`, event.OriginalMessageID,
	).Scan(&sendEventID, &contactID, &email, &mailboxUsed)
	if err != nil {
		slog.Error("bounce could not find send event", "message_id", event.OriginalMessageID, "error", err)
		return err
	}

	// Record bounce event
	_, err = p.db.Exec(
		`INSERT INTO bounce_events (send_event_id, contact_id, bounce_type, bounce_code, bounce_reason, raw_message)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		sendEventID, contactID, event.Type, event.Code, event.Reason, event.RawMessage,
	)
	if err != nil {
		return err
	}

	// Update send event status. Non-fatal: failing here still lets us
	// record the bounce event in bounce_events (already inserted above),
	// but ops needs visibility. Was H3 in the 2026-04-21 audit: bare
	// p.db.Exec silently swallowed the error.
	if _, err := p.db.Exec(`UPDATE send_events SET status = 'bounced' WHERE id = $1`, sendEventID); err != nil {
		slog.Warn("bounce: failed to mark send_event bounced", "send_event_id", sendEventID, "error", err)
	}

	switch event.Type {
	case BounceHard:
		// Hard bounce: update contact status — guard prevents overwriting terminal
		// statuses (blacklisted, unsubscribed, opted_out, human_handoff) with 'bounced',
		// which would lose suppression intent.
		//
		// Each Exec below was bare pre-2026-04-22 — H3 in the audit. The
		// calls are intentionally non-blocking (we still want the bounce
		// cascade to best-effort progress), but errors are now logged so
		// partial failures surface instead of silently corrupting the
		// suppression / blacklist / thread state machine.
		if _, err := p.db.Exec(`UPDATE contacts SET status = 'bounced', updated_at = now()
			WHERE id = $1 AND status NOT IN ('blacklisted', 'unsubscribed', 'opted_out', 'human_handoff')`, contactID); err != nil {
			slog.Warn("bounce: hard bounce contact status update failed", "contact_id", contactID, "error", err)
		}
		if _, err := p.db.Exec(
			`INSERT INTO blacklist (email, reason, source_event_id, created_at)
			 VALUES ($1, 'hard_bounce', $2, $3)
			 ON CONFLICT (email) DO NOTHING`,
			email, sendEventID, time.Now(),
		); err != nil {
			slog.Warn("bounce: blacklist insert failed", "email", audit.MaskEmail(email), "error", err)
		}
		// Feed back to the companies verification state so recalc picks up the penalty.
		if _, err := p.db.Exec(
			`UPDATE companies SET email_status = 'invalid', email_verified_at = now()
			 WHERE email = $1 AND email_status != 'invalid'`,
			email,
		); err != nil {
			slog.Warn("bounce: companies email_status update failed", "email", audit.MaskEmail(email), "error", err)
		}
		// Cascade: mark any open outreach thread for this contact as error so
		// the campaign runner stops attempting further sends.
		if _, err := p.db.Exec(`
			UPDATE outreach_threads t
			SET status = 'error', next_action = 'done', next_action_at = NULL, updated_at = now()
			FROM outreach_contacts oc
			WHERE t.contact_id = oc.id AND oc.email = $1
			  AND t.status IN ('new', 'active', 'paused')`,
			email,
		); err != nil {
			slog.Warn("bounce: outreach_threads cascade update failed", "email", audit.MaskEmail(email), "error", err)
		}
		slog.Warn("bounce hard bounce, blacklisted, thread marked error", "email", audit.MaskEmail(email), "code", event.Code)
		// D2.3: tick the sending mailbox's consecutive-bounce counter and
		// auto-hold if threshold reached. Fail-safe: registry errors are
		// swallowed inside the adapter so they cannot block bounce processing.
		if p.registry != nil && mailboxUsed != "" {
			p.registry.RecordBounce(context.Background(), mailboxUsed, "hard_bounce: "+event.Code)
		}

	case BounceSoft:
		// Soft bounce: count how many soft bounces this contact has accumulated.
		// After 2 soft bounces, pause the thread for 7 days to allow the mailbox
		// to recover before trying again.
		// After 3 soft bounces → companies.email_status = 'risky'.
		// After 5 soft bounces → companies.email_status = 'invalid' (address is unreachable).
		//
		// H3 (2026-04-21 audit): Scan error was dropped. A failed
		// SELECT COUNT(*) left softCount=0, defaulting to the below-
		// threshold branch and silently skipping the pause/escalation
		// cascade (a corrupted bounce-count would keep re-sending to a
		// permanently failing mailbox). Now we log and bail out of the
		// escalation logic so we never gate on a zero count that came
		// from an error.
		var softCount int
		scanErr := p.db.QueryRow(
			`SELECT COUNT(*) FROM bounce_events WHERE contact_id = $1 AND bounce_type = 'soft'`,
			contactID,
		).Scan(&softCount)
		if scanErr != nil {
			slog.Error("bounce: failed to count soft bounces — escalation skipped (data integrity)",
				"contact_id", contactID, "email", audit.MaskEmail(email), "error", scanErr)
			return nil // event was recorded; downstream gating can run next tick
		}
		if softCount >= 2 {
			pauseUntil := time.Now().Add(7 * 24 * time.Hour)
			if _, err := p.db.Exec(`
				UPDATE outreach_threads t
				SET status = 'paused', pause_until = $2, next_action = 'paused',
				    next_action_at = NULL, updated_at = now()
				FROM outreach_contacts oc
				WHERE t.contact_id = oc.id AND oc.email = $1
				  AND t.status IN ('new', 'active')`,
				email, pauseUntil,
			); err != nil {
				slog.Warn("bounce: soft pause thread update failed", "email", audit.MaskEmail(email), "error", err)
			}
			slog.Warn("bounce soft bounce threshold reached, thread paused 7d",
				"email", audit.MaskEmail(email), "soft_bounces", softCount)
		} else {
			slog.Info("bounce soft bounce", "email", audit.MaskEmail(email),
				"code", event.Code, "reason", event.Reason, "soft_bounces", softCount)
		}
		// Escalate email_status based on accumulated soft bounces.
		if softCount >= 5 {
			if _, err := p.db.Exec(
				`UPDATE companies SET email_status = 'invalid', email_verified_at = now()
				 WHERE email = $1 AND email_status NOT IN ('invalid')`,
				email,
			); err != nil {
				slog.Warn("bounce: soft->invalid escalation failed", "email", audit.MaskEmail(email), "error", err)
			}
		} else if softCount >= 3 {
			if _, err := p.db.Exec(
				`UPDATE companies SET email_status = 'risky', email_verified_at = now()
				 WHERE email = $1 AND email_status NOT IN ('invalid', 'risky')`,
				email,
			); err != nil {
				slog.Warn("bounce: soft->risky escalation failed", "email", audit.MaskEmail(email), "error", err)
			}
		}

	case BounceComplaint:
		// Complaint: blacklist immediately and halt campaign.
		// See H3 note in hard-bounce branch above.
		if _, err := p.db.Exec(`UPDATE contacts SET status = 'blacklisted', updated_at = now() WHERE id = $1`, contactID); err != nil {
			slog.Warn("bounce: complaint contact update failed", "contact_id", contactID, "error", err)
		}
		if _, err := p.db.Exec(
			`INSERT INTO blacklist (email, reason, source_event_id, created_at)
			 VALUES ($1, 'complaint', $2, $3)
			 ON CONFLICT (email) DO NOTHING`,
			email, sendEventID, time.Now(),
		); err != nil {
			slog.Warn("bounce: complaint blacklist insert failed", "email", audit.MaskEmail(email), "error", err)
		}
		// Mark as risky in the verification state — address exists but sender is unwelcome.
		if _, err := p.db.Exec(
			`UPDATE companies SET email_status = 'risky', email_verified_at = now()
			 WHERE email = $1 AND email_status NOT IN ('invalid', 'risky')`,
			email,
		); err != nil {
			slog.Warn("bounce: complaint companies risky update failed", "email", audit.MaskEmail(email), "error", err)
		}
		// Complaint cascade: close thread immediately (stronger than error — no retry).
		if _, err := p.db.Exec(`
			UPDATE outreach_threads t
			SET status = 'closed', next_action = 'done', next_action_at = NULL, updated_at = now()
			FROM outreach_contacts oc
			WHERE t.contact_id = oc.id AND oc.email = $1
			  AND t.status IN ('new', 'active', 'paused')`,
			email,
		); err != nil {
			slog.Warn("bounce: complaint threads close failed", "email", audit.MaskEmail(email), "error", err)
		}
		slog.Error("bounce complaint, blacklisted, thread closed", "email", audit.MaskEmail(email))
		// D2.3: complaints are also registry-relevant — auto-hold the
		// mailbox aggressively on complaints since they damage sender
		// reputation much more than regular bounces.
		if p.registry != nil && mailboxUsed != "" {
			p.registry.RecordBounce(context.Background(), mailboxUsed, "complaint")
		}
	}

	return nil
}

// ClassifyBounce determines bounce type from SMTP status code and message.
func ClassifyBounce(code, message string) BounceType {
	msg := strings.ToLower(message)

	// Complaint indicators
	if strings.Contains(msg, "complaint") || strings.Contains(msg, "spam") ||
		strings.Contains(msg, "abuse") || strings.Contains(msg, "junk") {
		return BounceComplaint
	}

	// Hard bounce codes (5xx permanent)
	if strings.HasPrefix(code, "5") {
		hardCodes := []string{"550", "551", "552", "553", "554"}
		for _, hc := range hardCodes {
			if strings.HasPrefix(code, hc) {
				return BounceHard
			}
		}
	}

	// Hard bounce keywords
	hardKeywords := []string{
		"user unknown", "mailbox not found", "no such user",
		"does not exist", "invalid recipient", "rejected",
		"address rejected", "undeliverable", "permanent",
	}
	for _, kw := range hardKeywords {
		if strings.Contains(msg, kw) {
			return BounceHard
		}
	}

	// Everything else is soft
	return BounceSoft
}

// CheckBlacklist returns true if the email or domain is blacklisted.
//
// H3 (2026-04-21 audit — DATA INTEGRITY): both QueryRow.Scan errors were
// previously dropped. On a DB error Scan leaves count=0 and the function
// returns false, i.e. "not blacklisted" — which lets an otherwise-
// suppressed address slip past the gate and get sent.
//
// The safe default on Scan error is fail-closed (return true / treat as
// blacklisted) so a transient DB issue can't let suppressed traffic
// leak. This is the same philosophy as the JS BlacklistProbe: when in
// doubt, hold.
func (p *Processor) CheckBlacklist(email string) bool {
	var count int

	// Check exact email.
	if err := p.db.QueryRow(`SELECT COUNT(*) FROM blacklist WHERE email = $1`, email).Scan(&count); err != nil {
		slog.Error("bounce: blacklist email check failed — failing closed",
			"email", audit.MaskEmail(email), "error", err)
		return true
	}
	if count > 0 {
		return true
	}

	// Check domain.
	parts := strings.SplitN(email, "@", 2)
	if len(parts) == 2 {
		count = 0
		if err := p.db.QueryRow(`SELECT COUNT(*) FROM blacklist WHERE domain = $1`, parts[1]).Scan(&count); err != nil {
			slog.Error("bounce: blacklist domain check failed — failing closed",
				"domain", parts[1], "error", err)
			return true
		}
		if count > 0 {
			return true
		}
	}

	return false
}

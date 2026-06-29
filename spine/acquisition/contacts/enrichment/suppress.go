package enrich

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"common/audit"
	"strings"
)

// SuppressionReason describes why a contact is suppressed.
type SuppressionReason string

const (
	SuppressHardBounce    SuppressionReason = "hard_bounce"
	SuppressComplaint     SuppressionReason = "complaint"
	SuppressUnsubscribe   SuppressionReason = "unsubscribe"
	SuppressNegativeReply SuppressionReason = "negative_reply"
	SuppressManual        SuppressionReason = "manual"
	SuppressHoneypot      SuppressionReason = "honeypot"
)

// SuppressEmail adds an email to the global suppression list and updates the contact status.
func SuppressEmail(ctx context.Context, db *sql.DB, email string, reason SuppressionReason, eventID *int) error {
	email = strings.ToLower(strings.TrimSpace(email))

	// Insert suppression
	var eventIDVal sql.NullInt64
	if eventID != nil {
		eventIDVal = sql.NullInt64{Int64: int64(*eventID), Valid: true}
	}

	_, err := db.ExecContext(ctx, `
		INSERT INTO outreach_suppressions (email, reason, source_event_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (email) DO NOTHING
	`, email, string(reason), eventIDVal)
	if err != nil {
		return fmt.Errorf("insert suppression: %w", err)
	}

	// Update contact status
	_, err = db.ExecContext(ctx, `
		UPDATE outreach_contacts SET status = 'suppressed', updated_at = now()
		WHERE email_hash = encode(sha256($1::bytea), 'hex')
	`, email)
	if err != nil {
		return fmt.Errorf("update contact status: %w", err)
	}

	// Cascade: close all active/paused threads for this contact so no further
	// emails are sent after suppression (deliverability / reputation protection).
	if _, err := db.ExecContext(ctx, `
		UPDATE outreach_threads SET status = 'closed', updated_at = now()
		WHERE contact_id = (
			SELECT id FROM outreach_contacts
			WHERE email_hash = encode(sha256($1::bytea), 'hex')
		)
		AND status IN ('new', 'active', 'paused')
	`, email); err != nil {
		slog.Warn("suppress: thread cascade failed", "op", "enrich.SuppressEmail/cascade", "email", audit.MaskEmail(email), "error", err)
	}

	slog.Info("email suppressed", "email", audit.MaskEmail(email), "reason", reason)
	return nil
}

// SuppressDomain adds a domain to the suppression list and flags all contacts on it.
func SuppressDomain(ctx context.Context, db *sql.DB, domain string, reason SuppressionReason) error {
	domain = strings.ToLower(strings.TrimSpace(domain))

	_, err := db.ExecContext(ctx, `
		INSERT INTO outreach_suppressions (domain, reason)
		VALUES ($1, $2)
		ON CONFLICT DO NOTHING
	`, domain, string(reason))
	if err != nil {
		return fmt.Errorf("insert domain suppression: %w", err)
	}

	// Flag domain
	_, err = db.ExecContext(ctx, `
		UPDATE outreach_domains SET is_suppressed = true, suppressed_reason = $1, updated_at = now()
		WHERE domain = $2
	`, string(reason), domain)

	slog.Info("domain suppressed", "domain", domain, "reason", reason)
	return err
}

// RunSuppressInactive suppresses outreach_contacts that have gone inactive and
// are still in an active state. A contact is inactive when it was last contacted
// longer ago than inactiveDays, OR it was never contacted AND was created longer
// ago than inactiveDays. The age guard on the never-contacted branch is critical:
// without it, every brand-new prospect (last_contacted IS NULL) would be swept
// into suppression the moment this job runs. Returns the number suppressed.
func RunSuppressInactive(ctx context.Context, db *sql.DB, inactiveDays int) (int, error) {
	result, err := db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET status = 'suppressed', updated_at = now()
		WHERE status IN ('new', 'valid', 'active')
		  AND (
		      (last_contacted IS NULL AND created_at < now() - ($1 || ' days')::interval)
		      OR last_contacted < now() - ($1 || ' days')::interval
		  )
	`, inactiveDays)
	if err != nil {
		return 0, fmt.Errorf("suppress inactive: %w", err)
	}
	n, _ := result.RowsAffected()
	slog.Info("suppressed inactive contacts", "count", n, "inactive_days", inactiveDays)
	return int(n), nil
}

// IsSuppressed checks if an email or its domain is in the suppression list.
func IsSuppressed(ctx context.Context, db *sql.DB, email string) (bool, string) {
	email = strings.ToLower(strings.TrimSpace(email))
	domain := DomainFromEmail(email)

	// Check email
	var reason string
	err := db.QueryRowContext(ctx, `
		SELECT reason FROM outreach_suppressions WHERE email = $1
	`, email).Scan(&reason)
	if err == nil {
		return true, reason
	}

	// Check domain
	err = db.QueryRowContext(ctx, `
		SELECT reason FROM outreach_suppressions WHERE domain = $1
	`, domain).Scan(&reason)
	if err == nil {
		return true, "domain:" + reason
	}

	return false, ""
}

// SuppressionStats returns counts by reason.
func SuppressionStats(ctx context.Context, db *sql.DB) (map[string]int, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT reason, COUNT(*) FROM outreach_suppressions GROUP BY reason
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int)
	for rows.Next() {
		var reason string
		var count int
		rows.Scan(&reason, &count)
		result[reason] = count
	}
	return result, rows.Err()
}

// AutoSuppressFromEvents scans recent events and auto-suppresses as needed.
func AutoSuppressFromEvents(ctx context.Context, db *sql.DB) (int, error) {
	suppressed := 0

	// Hard bounces → suppress email
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT c.email, e.id
		FROM outreach_events e
		JOIN outreach_contacts c ON c.id = e.contact_id
		WHERE e.event_type = 'bounced'
			AND c.status NOT IN ('suppressed')
			AND c.total_bounced >= 1
			AND NOT EXISTS (SELECT 1 FROM outreach_suppressions s WHERE s.email = c.email)
	`)
	if err != nil {
		return 0, fmt.Errorf("query bounced: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var email string
		var eventID int
		rows.Scan(&email, &eventID)
		SuppressEmail(ctx, db, email, SuppressHardBounce, &eventID)
		suppressed++
	}

	// Domains with >10% bounce rate → suppress domain
	domRows, err := db.QueryContext(ctx, `
		SELECT domain FROM outreach_domains
		WHERE total_sent >= 10 AND bounce_rate > 0.10 AND NOT is_suppressed
	`)
	if err != nil {
		return suppressed, fmt.Errorf("query bad domains: %w", err)
	}
	defer domRows.Close()

	for domRows.Next() {
		var domain string
		domRows.Scan(&domain)
		SuppressDomain(ctx, db, domain, SuppressHardBounce)
		suppressed++
	}

	// Domains with >0.1% complaint rate → suppress
	rows2, err := db.QueryContext(ctx, `
		SELECT domain FROM outreach_domains
		WHERE total_sent >= 20 AND complaint_rate > 0.001 AND NOT is_suppressed
	`)
	if err != nil {
		return suppressed, fmt.Errorf("complaint domains query: %w", err)
	}
	defer rows2.Close()

	for rows2.Next() {
		var domain string
		if err := rows2.Scan(&domain); err != nil {
			continue
		}
		if err := SuppressDomain(ctx, db, domain, SuppressComplaint); err != nil {
			slog.Warn("auto-suppress complaint domain failed", "op", "enrich.AutoSuppressFromEvents/complaintsLoop", "domain", domain, "error", err)
			continue
		}
		suppressed++
	}

	return suppressed, nil
}

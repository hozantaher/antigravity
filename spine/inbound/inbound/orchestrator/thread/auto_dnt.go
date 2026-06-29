package thread

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// AutoDNTResult describes the outcome of an auto-DNT decision.
type AutoDNTResult struct {
	Applied bool   // whether the contact was marked as DNT
	Reason  string // human-readable reason (for auditing)
	Error   error  // if any operation failed
}

// ApplyAutoDNT evaluates a reply classification and applies do-not-track (DNT)
// status automatically when high-confidence negative signals are detected.
//
// Current implementation: Applies DNT for 'negative' category replies.
// Future: Extend when ClassifySentiment interface provides confidence scores.
//
// Category mapping for auto-DNT:
//   - "negative" → applies DNT (refusal, unsubscribe, blocking signals)
//   - Other categories → no auto-DNT (requires confidence > 0.85 threshold in future)
//
// Actions on DNT application:
//   1. Set contacts.dnt = true
//   2. INSERT outreach_suppressions row
//   3. Audit log entry
func ApplyAutoDNT(ctx context.Context, db *sql.DB, contactID int64, category string) (AutoDNTResult, error) {
	// Until ClassifySentiment returns confidence scores, we apply DNT only to
	// high-signal categories that are deterministically negative.
	if !isAutoDNTCategory(category) {
		return AutoDNTResult{Applied: false, Reason: "category does not trigger auto-DNT"}, nil
	}

	// 1. Set contacts.dnt = true
	if err := setContactDNT(ctx, db, contactID); err != nil {
		return AutoDNTResult{
			Applied: false,
			Reason:  "failed to set contacts.dnt",
			Error:   err,
		}, fmt.Errorf("set contact dnt: %w", err)
	}

	// 2. INSERT outreach_suppressions row
	if err := insertSuppression(ctx, db, contactID, "auto_dnt_classifier"); err != nil {
		return AutoDNTResult{
			Applied: false,
			Reason:  "failed to insert suppression",
			Error:   err,
		}, fmt.Errorf("insert suppression: %w", err)
	}

	// 3. Audit log entry
	slog.Info("auto-dnt applied by classifier",
		"op", "thread.auto_dnt/applied",
		"contact_id", contactID,
		"category", category)

	return AutoDNTResult{
		Applied: true,
		Reason:  fmt.Sprintf("auto-dnt from category=%s", category),
	}, nil
}

// isAutoDNTCategory returns true if the category should trigger automatic DNT.
func isAutoDNTCategory(category string) bool {
	// Only "negative" is deterministic enough for auto-application without confidence.
	// Categories like "unsubscribe", "legal_threat", "do_not_contact", "remove"
	// require explicit confidence > 0.85 threshold when classifier interface adds it.
	return category == "negative"
}

// setContactDNT sets the contacts.dnt flag to true, idempotently.
func setContactDNT(ctx context.Context, db *sql.DB, contactID int64) error {
	// Idempotent UPDATE: no error if already true
	_, err := db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET dnt = true
		WHERE id = $1
	`, contactID)
	if err != nil {
		return fmt.Errorf("update contacts.dnt: %w", err)
	}
	return nil
}

// insertSuppression inserts a row into outreach_suppressions, idempotently.
// Fetches email from contacts table to populate the suppression record.
func insertSuppression(ctx context.Context, db *sql.DB, contactID int64, reason string) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO outreach_suppressions (email, reason)
		SELECT email, $2
		  FROM outreach_contacts WHERE id = $1 AND email IS NOT NULL
		ON CONFLICT (email) DO NOTHING
	`, contactID, reason)
	if err != nil {
		return fmt.Errorf("insert suppression: %w", err)
	}
	return nil
}

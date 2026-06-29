package watchdog

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// AuthFailStore records and queries SMTP auth failures per mailbox.
// Populated by the sender (out-of-scope for S2) and consumed by the daemon
// to decide when to swap a mailbox's proxy.
type AuthFailStore struct {
	DB *sql.DB
}

// NewAuthFailStore wraps a *sql.DB.
func NewAuthFailStore(db *sql.DB) *AuthFailStore {
	return &AuthFailStore{DB: db}
}

// Record inserts one auth failure. Safe to call fire-and-forget from hot
// send paths; callers should not block on the return value.
func (s *AuthFailStore) Record(ctx context.Context, mailboxID int64, smtpResponse string) error {
	if s == nil || s.DB == nil {
		return nil
	}
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO mailbox_auth_fails (mailbox_id, smtp_response)
		VALUES ($1, $2)
	`, mailboxID, smtpResponse)
	if err != nil {
		return fmt.Errorf("watchdog: record auth fail: %w", err)
	}
	return nil
}

// CountRecent returns the number of unresolved auth fails in the last window
// for one mailbox.
func (s *AuthFailStore) CountRecent(ctx context.Context, mailboxID int64, window time.Duration) (int, error) {
	if s == nil || s.DB == nil {
		return 0, nil
	}
	var n int
	err := s.DB.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM mailbox_auth_fails
		WHERE mailbox_id = $1
		  AND resolved_at IS NULL
		  AND failed_at > now() - ($2 || ' seconds')::interval
	`, mailboxID, int(window.Seconds())).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("watchdog: count auth fails: %w", err)
	}
	return n, nil
}

// ResolveAll marks all unresolved fails for a mailbox as handled. Called
// after a successful proxy swap so the counter does not stack across cycles.
func (s *AuthFailStore) ResolveAll(ctx context.Context, mailboxID int64) error {
	if s == nil || s.DB == nil {
		return nil
	}
	_, err := s.DB.ExecContext(ctx, `
		UPDATE mailbox_auth_fails
		SET resolved_at = now()
		WHERE mailbox_id = $1 AND resolved_at IS NULL
	`, mailboxID)
	if err != nil {
		return fmt.Errorf("watchdog: resolve auth fails: %w", err)
	}
	return nil
}

// ListRecent returns the failed_at timestamps of all unresolved auth fails
// within the last window for one mailbox. Ordered ascending. Used by the
// SEND-S6.3 alert primitive which evaluates the last-15min count.
func (s *AuthFailStore) ListRecent(ctx context.Context, mailboxID int64, window time.Duration) ([]AuthFailEvent, error) {
	if s == nil || s.DB == nil {
		return nil, nil
	}
	rows, err := s.DB.QueryContext(ctx, `
		SELECT failed_at
		FROM mailbox_auth_fails
		WHERE mailbox_id = $1
		  AND resolved_at IS NULL
		  AND failed_at > now() - ($2 || ' seconds')::interval
		ORDER BY failed_at ASC
	`, mailboxID, int(window.Seconds()))
	if err != nil {
		return nil, fmt.Errorf("watchdog: list auth fails: %w", err)
	}
	defer rows.Close()
	var out []AuthFailEvent
	for rows.Next() {
		var at time.Time
		if err := rows.Scan(&at); err != nil {
			return nil, fmt.Errorf("watchdog: scan auth fail: %w", err)
		}
		out = append(out, AuthFailEvent{FailedAt: at})
	}
	return out, rows.Err()
}

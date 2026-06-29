package thread

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Status represents the state of a conversation thread.
type Status string

const (
	StatusNew     Status = "new"
	StatusActive  Status = "active"
	StatusReplied Status = "replied"
	StatusClosed  Status = "closed"
	StatusPaused  Status = "paused"
	// StatusExpired marks threads where the contact never replied within the
	// expiry window (default 30 days after last outreach step).
	StatusExpired Status = "expired"
	// StatusError marks threads that encountered unrecoverable delivery errors
	// (e.g. 3 consecutive hard bounces).
	StatusError Status = "error"
)

// NextAction describes what should happen next in the thread.
type NextAction string

const (
	ActionSendStep     NextAction = "send_step"
	ActionWaitReply    NextAction = "wait_reply"
	ActionManualFollow NextAction = "manual_followup"
	ActionPaused       NextAction = "paused"
	ActionDone         NextAction = "done"
)

// Thread represents a conversation thread with a contact.
type Thread struct {
	ID           int
	ContactID    int
	CampaignID   int
	Status       Status
	CurrentStep  int
	NextActionAt *time.Time
	NextAction   NextAction
	PauseUntil   *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Manager handles thread lifecycle operations.
type Manager struct {
	db *sql.DB
}

// NewManager creates a thread manager.
func NewManager(db *sql.DB) *Manager {
	return &Manager{db: db}
}

// Create starts a new conversation thread.
func (m *Manager) Create(ctx context.Context, contactID, campaignID int) (int, error) {
	var id int
	err := m.db.QueryRowContext(ctx, `
		INSERT INTO outreach_threads (contact_id, campaign_id, status, current_step, next_action)
		VALUES ($1, $2, 'new', 0, 'send_step')
		RETURNING id
	`, contactID, campaignID).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create thread: %w", err)
	}
	return id, nil
}

// Get retrieves a thread by ID.
func (m *Manager) Get(ctx context.Context, threadID int) (*Thread, error) {
	t := &Thread{}
	var nextActionAt, pauseUntil sql.NullTime
	var nextAction sql.NullString

	err := m.db.QueryRowContext(ctx, `
		SELECT id, contact_id, campaign_id, status, current_step,
			next_action_at, next_action, pause_until, created_at, updated_at
		FROM outreach_threads WHERE id = $1
	`, threadID).Scan(
		&t.ID, &t.ContactID, &t.CampaignID, &t.Status, &t.CurrentStep,
		&nextActionAt, &nextAction, &pauseUntil, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get thread %d: %w", threadID, err)
	}

	if nextActionAt.Valid { t.NextActionAt = &nextActionAt.Time }
	if pauseUntil.Valid { t.PauseUntil = &pauseUntil.Time }
	if nextAction.Valid { t.NextAction = NextAction(nextAction.String) }

	return t, nil
}

// FindByContact returns active threads for a contact.
func (m *Manager) FindByContact(ctx context.Context, contactID int) ([]Thread, error) {
	rows, err := m.db.QueryContext(ctx, `
		SELECT id, contact_id, campaign_id, status, current_step,
			next_action_at, next_action, pause_until, created_at, updated_at
		FROM outreach_threads
		WHERE contact_id = $1 AND status NOT IN ('closed')
		ORDER BY created_at DESC
	`, contactID)
	if err != nil {
		return nil, fmt.Errorf("find threads: %w", err)
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var nextActionAt, pauseUntil sql.NullTime
		var nextAction sql.NullString
		if err := rows.Scan(
			&t.ID, &t.ContactID, &t.CampaignID, &t.Status, &t.CurrentStep,
			&nextActionAt, &nextAction, &pauseUntil, &t.CreatedAt, &t.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if nextActionAt.Valid { t.NextActionAt = &nextActionAt.Time }
		if pauseUntil.Valid { t.PauseUntil = &pauseUntil.Time }
		if nextAction.Valid { t.NextAction = NextAction(nextAction.String) }
		threads = append(threads, t)
	}
	return threads, rows.Err()
}

// AdvanceStep moves the thread to the next step with a scheduled send time.
func (m *Manager) AdvanceStep(ctx context.Context, threadID int, nextSendAt time.Time) error {
	_, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET current_step = current_step + 1, status = 'active',
			next_action = 'send_step', next_action_at = $1, updated_at = now()
		WHERE id = $2
	`, nextSendAt, threadID)
	return err
}

// MarkReplied transitions thread to replied state.
func (m *Manager) MarkReplied(ctx context.Context, threadID int, action NextAction) error {
	_, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET status = 'replied', next_action = $1, next_action_at = NULL, updated_at = now()
		WHERE id = $2
	`, string(action), threadID)
	return err
}

// Pause pauses the thread until a specific date (for OOO/later replies).
func (m *Manager) Pause(ctx context.Context, threadID int, until time.Time) error {
	_, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET status = 'paused', next_action = 'paused', pause_until = $1,
			next_action_at = $1, updated_at = now()
		WHERE id = $2
	`, until, threadID)
	return err
}

// Close terminates the thread.
func (m *Manager) Close(ctx context.Context, threadID int) error {
	_, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET status = 'closed', next_action = 'done', next_action_at = NULL, updated_at = now()
		WHERE id = $1
	`, threadID)
	return err
}

// ResumeExpiredPauses finds paused threads past their pause_until and resumes them.
func (m *Manager) ResumeExpiredPauses(ctx context.Context) (int, error) {
	result, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET status = 'active', next_action = 'send_step', next_action_at = now(),
			pause_until = NULL, updated_at = now()
		WHERE status = 'paused' AND pause_until <= now()
	`)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// PendingSends returns threads that are ready to send their next step.
func (m *Manager) PendingSends(ctx context.Context, limit int) ([]Thread, error) {
	rows, err := m.db.QueryContext(ctx, `
		SELECT id, contact_id, campaign_id, status, current_step,
			next_action_at, next_action, pause_until, created_at, updated_at
		FROM outreach_threads
		WHERE status = 'active' AND next_action = 'send_step'
			AND (next_action_at IS NULL OR next_action_at <= now())
		ORDER BY next_action_at NULLS FIRST
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var threads []Thread
	for rows.Next() {
		var t Thread
		var nextActionAt, pauseUntil sql.NullTime
		var nextAction sql.NullString
		rows.Scan(&t.ID, &t.ContactID, &t.CampaignID, &t.Status, &t.CurrentStep,
			&nextActionAt, &nextAction, &pauseUntil, &t.CreatedAt, &t.UpdatedAt)
		if nextActionAt.Valid { t.NextActionAt = &nextActionAt.Time }
		if pauseUntil.Valid { t.PauseUntil = &pauseUntil.Time }
		if nextAction.Valid { t.NextAction = NextAction(nextAction.String) }
		threads = append(threads, t)
	}
	return threads, rows.Err()
}

// ExpireStaleThreads transitions active/replied threads that have not advanced
// for more than staleDays to StatusExpired. Returns the count of expired threads.
// Called by the intelligence loop to keep thread states accurate.
func (m *Manager) ExpireStaleThreads(ctx context.Context, staleDays int) (int, error) {
	result, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET status = 'expired', next_action = 'done', next_action_at = NULL, updated_at = now()
		WHERE status IN ('active', 'replied', 'new')
		  AND updated_at < now() - ($1 || ' days')::interval
	`, staleDays)
	if err != nil {
		return 0, fmt.Errorf("expire stale threads: %w", err)
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// MarkError transitions a thread to the error state (e.g. after repeated bounce).
func (m *Manager) MarkError(ctx context.Context, threadID int, reason string) error {
	_, err := m.db.ExecContext(ctx, `
		UPDATE outreach_threads
		SET status = 'error', next_action = 'done', next_action_at = NULL,
			updated_at = now()
		WHERE id = $1
	`, threadID)
	if err != nil {
		return fmt.Errorf("mark thread error %d: %w", threadID, err)
	}
	return nil
}


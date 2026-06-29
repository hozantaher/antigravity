package watchdog

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// EventType enumerates the kinds of self-heal actions the watchdog records.
type EventType string

const (
	EventProxySwap      EventType = "proxy_swap"
	EventBounceDecay    EventType = "bounce_decay"
	EventAutoRelease    EventType = "auto_release"
	EventAuthFailSpike  EventType = "auth_fail_spike"
	EventAuthFailAlert  EventType = "auth_fail_alert"
	EventCircuitBreaker EventType = "circuit_breaker"
	EventManualTrigger  EventType = "manual_trigger"
	EventHeartbeat      EventType = "heartbeat"
)

// Event is one row in the watchdog_events audit log.
type Event struct {
	ID         int64
	MailboxID  *int64 // nil for global events (heartbeat)
	Type       EventType
	AutoHealed bool
	Reason     string
	Metadata   map[string]any
	CreatedAt  time.Time
}

// EventRecorder persists watchdog events to the audit log. A nil recorder
// makes Record a no-op — useful for tests and migrations-not-applied boots.
type EventRecorder struct {
	DB *sql.DB
}

// NewEventRecorder wraps a *sql.DB.
func NewEventRecorder(db *sql.DB) *EventRecorder {
	return &EventRecorder{DB: db}
}

// Record inserts one event. Metadata is marshaled as JSON.
func (r *EventRecorder) Record(ctx context.Context, e Event) error {
	if r == nil || r.DB == nil {
		return nil
	}
	meta := []byte("{}")
	if len(e.Metadata) > 0 {
		b, err := json.Marshal(e.Metadata)
		if err != nil {
			return fmt.Errorf("watchdog: marshal metadata: %w", err)
		}
		meta = b
	}
	var mboxID any
	if e.MailboxID != nil {
		mboxID = *e.MailboxID
	}
	// check_name + message are NOT NULL from an earlier schema iteration;
	// event_type + reason are the newer columns. Populate both so the insert
	// satisfies legacy constraints without requiring a migration.
	checkName := string(e.Type)
	message := e.Reason
	if message == "" {
		message = checkName
	}
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO watchdog_events (check_name, message, mailbox_id, event_type, auto_healed, reason, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
	`, checkName, message, mboxID, string(e.Type), e.AutoHealed, e.Reason, meta)
	if err != nil {
		return fmt.Errorf("watchdog: insert event: %w", err)
	}
	return nil
}

// ListByMailbox returns up to limit most-recent events for one mailbox.
func (r *EventRecorder) ListByMailbox(ctx context.Context, mailboxID int64, limit int) ([]Event, error) {
	if r == nil || r.DB == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}
	rows, err := r.DB.QueryContext(ctx, `
		SELECT id, mailbox_id, event_type, auto_healed, reason, metadata, created_at
		FROM watchdog_events
		WHERE mailbox_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, mailboxID, limit)
	if err != nil {
		return nil, fmt.Errorf("watchdog: list events: %w", err)
	}
	defer rows.Close()
	out := make([]Event, 0, limit)
	for rows.Next() {
		var e Event
		var mboxID sql.NullInt64
		var etype string
		var metaRaw []byte
		if err := rows.Scan(&e.ID, &mboxID, &etype, &e.AutoHealed, &e.Reason, &metaRaw, &e.CreatedAt); err != nil {
			return nil, err
		}
		if mboxID.Valid {
			id := mboxID.Int64
			e.MailboxID = &id
		}
		e.Type = EventType(etype)
		if len(metaRaw) > 0 {
			_ = json.Unmarshal(metaRaw, &e.Metadata)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

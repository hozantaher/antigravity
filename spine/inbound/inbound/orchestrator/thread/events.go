package thread

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// EventType describes what happened.
type EventType string

const (
	EventSent         EventType = "sent"
	EventDelivered    EventType = "delivered"
	EventOpened       EventType = "opened"
	EventClicked      EventType = "clicked"
	EventReplied      EventType = "replied"
	EventBounced      EventType = "bounced"
	EventComplained   EventType = "complained"
	EventSuppressed   EventType = "suppressed"
	EventScoreChanged EventType = "score_changed"
)

// Event is a single audit trail entry.
type Event struct {
	ID        int
	ContactID int
	ThreadID  *int
	MessageID *int
	Type      EventType
	Metadata  map[string]any
	CreatedAt time.Time
}

// EventLogger records events in the audit trail.
type EventLogger struct {
	db *sql.DB
}

// NewEventLogger creates an event logger.
func NewEventLogger(db *sql.DB) *EventLogger {
	return &EventLogger{db: db}
}

// Log records a single event.
func (l *EventLogger) Log(ctx context.Context, contactID int, threadID, messageID *int, eventType EventType, metadata map[string]any) (int, error) {
	metaJSON := "{}"
	if metadata != nil {
		data, _ := json.Marshal(metadata)
		metaJSON = string(data)
	}

	var threadIDVal, messageIDVal sql.NullInt64
	if threadID != nil {
		threadIDVal = sql.NullInt64{Int64: int64(*threadID), Valid: true}
	}
	if messageID != nil {
		messageIDVal = sql.NullInt64{Int64: int64(*messageID), Valid: true}
	}

	var id int
	err := l.db.QueryRowContext(ctx, `
		INSERT INTO outreach_events (contact_id, thread_id, message_id, event_type, metadata)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, contactID, threadIDVal, messageIDVal, string(eventType), metaJSON).Scan(&id)

	return id, err
}

// LogSent records that a message was sent and updates contact counters.
func (l *EventLogger) LogSent(ctx context.Context, contactID, threadID, messageID int) error {
	_, err := l.Log(ctx, contactID, &threadID, &messageID, EventSent, nil)
	if err != nil {
		return err
	}

	_, err = l.db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET total_sent = total_sent + 1, last_contacted = now(), status = 'active', updated_at = now()
		WHERE id = $1
	`, contactID)
	return err
}

// LogOpened records that a message was opened.
func (l *EventLogger) LogOpened(ctx context.Context, contactID, threadID, messageID int) error {
	_, err := l.Log(ctx, contactID, &threadID, &messageID, EventOpened, nil)
	if err != nil {
		return err
	}

	_, err = l.db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET total_opened = total_opened + 1, last_opened = now(), updated_at = now()
		WHERE id = $1
	`, contactID)
	return err
}

// LogReplied records that a reply was received.
func (l *EventLogger) LogReplied(ctx context.Context, contactID, threadID, messageID int, replyType string) error {
	_, err := l.Log(ctx, contactID, &threadID, &messageID, EventReplied, map[string]any{"reply_type": replyType})
	if err != nil {
		return err
	}

	_, err = l.db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET total_replied = total_replied + 1, last_replied = now(), updated_at = now()
		WHERE id = $1
	`, contactID)
	return err
}

// LogBounced records a bounce event.
func (l *EventLogger) LogBounced(ctx context.Context, contactID, threadID, messageID int, bounceType string) error {
	_, err := l.Log(ctx, contactID, &threadID, &messageID, EventBounced, map[string]any{"bounce_type": bounceType})
	if err != nil {
		return err
	}

	_, err = l.db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET total_bounced = total_bounced + 1, updated_at = now()
		WHERE id = $1
	`, contactID)

	// Update domain stats. Non-fatal: bounce was already recorded at
	// the contact level, and intelligence.DetectDomainIssues reads
	// total_bounced to gate suppression. H4 in the 2026-04-21 audit:
	// silent failure here drifted the domain counter and mis-gated the
	// suppression logic. Log so ops can see when drift happens.
	if _, domErr := l.db.ExecContext(ctx, `
		UPDATE outreach_domains d
		SET total_bounced = total_bounced + 1, updated_at = now()
		FROM outreach_contacts c
		WHERE c.id = $1 AND d.id = c.domain_id
	`, contactID); domErr != nil {
		slog.Warn("thread: outreach_domains bounce counter update failed", "op", "EventLogger.LogBounced/domainUpdate", "contact_id", contactID, "error", domErr)
	}

	return err
}

// LogComplained records a spam complaint event and increments domain complaint counter.
func (l *EventLogger) LogComplained(ctx context.Context, contactID, threadID, messageID int) error {
	_, err := l.Log(ctx, contactID, &threadID, &messageID, EventComplained, nil)
	if err != nil {
		return err
	}

	_, err = l.db.ExecContext(ctx, `
		UPDATE outreach_contacts
		SET updated_at = now()
		WHERE id = $1
	`, contactID)
	if err != nil {
		return fmt.Errorf("update contact complained: %w", err)
	}

	// Update domain stats. See H4 rationale in LogBounced above —
	// complaints are even higher signal than bounces for the suppression
	// gate, so silent drift here is strictly worse.
	if _, domErr := l.db.ExecContext(ctx, `
		UPDATE outreach_domains d
		SET total_complained = total_complained + 1, updated_at = now()
		FROM outreach_contacts c
		WHERE c.id = $1 AND d.id = c.domain_id
	`, contactID); domErr != nil {
		slog.Warn("thread: outreach_domains complaint counter update failed", "op", "EventLogger.LogComplained/domainUpdate", "contact_id", contactID, "error", domErr)
	}

	return nil
}

// ContactTimeline returns all events for a contact, newest first.
func (l *EventLogger) ContactTimeline(ctx context.Context, contactID, limit int) ([]Event, error) {
	rows, err := l.db.QueryContext(ctx, `
		SELECT id, contact_id, thread_id, message_id, event_type, metadata, created_at
		FROM outreach_events
		WHERE contact_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, contactID, limit)
	if err != nil {
		return nil, fmt.Errorf("timeline: %w", err)
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		var threadID, messageID sql.NullInt64
		var metaJSON string
		rows.Scan(&e.ID, &e.ContactID, &threadID, &messageID, &e.Type, &metaJSON, &e.CreatedAt)
		if threadID.Valid {
			tid := int(threadID.Int64)
			e.ThreadID = &tid
		}
		if messageID.Valid {
			mid := int(messageID.Int64)
			e.MessageID = &mid
		}
		if metaJSON != "" {
			json.Unmarshal([]byte(metaJSON), &e.Metadata)
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

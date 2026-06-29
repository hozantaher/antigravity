// Package seedstore selects classified inbound replies from prod for
// anonymized injection into the Mail Lab and tracks which message_ids
// have already been seeded so re-runs stay idempotent.
//
// KT-B5 — Lab feedback loop. Two responsibilities:
//
//  1. SelectClassifiedReplies — fetches the most recent N inbound rows
//     from outreach_messages where direction='inbound' AND reply_type
//     IS NOT NULL. The query LEFT JOINs the union of suppression
//     tables (outreach_suppressions ∪ suppression_list, the project
//     standard per project_two_suppression_tables memory) and skips
//     rows whose contact email has been flagged for DSR erasure.
//
//  2. AlreadySeeded / RecordSeeded — small bookkeeping pair backed by
//     the operator_practice_seed_log table. New rows go in; existing
//     rows mean "we shipped this message-id to the lab on $date — do
//     not re-seed". Idempotency safety net so the nightly cron can
//     replay the same window without duplicate inbox entries.
package seedstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	op "operator-practice/internal/anonymize"
)

// Querier is the subset of *sql.DB / *sql.Tx that this package needs.
// Using an interface keeps the package easy to mock in tests.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row
}

// Store reads + writes the seed log table.
type Store struct {
	db Querier
}

// New constructs a Store. db must be non-nil.
func New(db Querier) *Store {
	return &Store{db: db}
}

// SelectQuery returns the SQL used by SelectClassifiedReplies. Exposed
// so tests can assert query shape (DSR LEFT JOIN + suppression union)
// without wiring a full driver.
const SelectQuery = `
SELECT
    m.id,
    m.message_id,
    COALESCE(c.email, '') AS from_addr,
    COALESCE(m.subject, '') AS subject,
    COALESCE(m.body_text, '') AS body_text,
    COALESCE(m.body_html, '') AS body_html,
    m.created_at,
    COALESCE(m.reply_type, 'ambiguous') AS classification,
    COALESCE(m.in_reply_to, '') AS in_reply_to
FROM outreach_messages m
JOIN outreach_threads t ON t.id = m.thread_id
JOIN outreach_contacts c ON c.id = t.contact_id
LEFT JOIN outreach_suppressions s1 ON lower(s1.email) = lower(c.email)
LEFT JOIN suppression_list s2 ON lower(s2.email) = lower(c.email)
WHERE m.direction = 'inbound'
  AND m.reply_type IS NOT NULL
  AND s1.email IS NULL
  AND s2.email IS NULL
ORDER BY m.created_at DESC
LIMIT $1
`

// SelectClassifiedReplies returns up to limit rows. Rows whose contact
// has been suppressed (either Schema A `outreach_suppressions` or
// Schema B `suppression_list`) are filtered out at the SQL layer so
// the application code never sees PII for an erased subject.
func (s *Store) SelectClassifiedReplies(ctx context.Context, limit int) ([]op.Message, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, SelectQuery, limit)
	if err != nil {
		return nil, fmt.Errorf("select classified replies: %w", err)
	}
	defer rows.Close()

	out := make([]op.Message, 0, limit)
	for rows.Next() {
		var (
			id             int64
			messageID      string
			fromAddr       string
			subject        string
			bodyText       string
			bodyHTML       string
			createdAt      time.Time
			classification string
			inReplyTo      string
		)
		if err := rows.Scan(&id, &messageID, &fromAddr, &subject, &bodyText, &bodyHTML, &createdAt, &classification, &inReplyTo); err != nil {
			return nil, fmt.Errorf("scan classified reply: %w", err)
		}
		out = append(out, op.Message{
			ID:             id,
			FromAddr:       fromAddr,
			Subject:        subject,
			BodyText:       bodyText,
			BodyHTML:       bodyHTML,
			ReceivedAt:     createdAt,
			Classification: normalizeCategory(classification),
			MessageID:      messageID,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate classified replies: %w", err)
	}
	return out, nil
}

// SchemaSQL — DDL for the seed log table. Idempotent (`IF NOT EXISTS`).
// Cron invokes EnsureSchema once at boot before the first batch.
const SchemaSQL = `
CREATE TABLE IF NOT EXISTS operator_practice_seed_log (
    message_id    TEXT PRIMARY KEY,
    seeded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    batch_id      TEXT NOT NULL,
    category      TEXT NOT NULL,
    lab_mailbox   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_practice_seed_log_batch
    ON operator_practice_seed_log(batch_id);
CREATE INDEX IF NOT EXISTS idx_operator_practice_seed_log_seeded_at
    ON operator_practice_seed_log(seeded_at DESC);
`

// EnsureSchema applies SchemaSQL. Safe to call repeatedly.
func (s *Store) EnsureSchema(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, SchemaSQL); err != nil {
		return fmt.Errorf("ensure seed log schema: %w", err)
	}
	return nil
}

// AlreadySeeded returns the subset of messageIDs that already appear in
// operator_practice_seed_log. Used for idempotency: skip rows we already
// shipped to the lab on a previous nightly run.
func (s *Store) AlreadySeeded(ctx context.Context, messageIDs []string) (map[string]struct{}, error) {
	if len(messageIDs) == 0 {
		return map[string]struct{}{}, nil
	}
	placeholders := make([]string, len(messageIDs))
	args := make([]interface{}, len(messageIDs))
	for i, id := range messageIDs {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = id
	}
	q := "SELECT message_id FROM operator_practice_seed_log WHERE message_id IN (" + strings.Join(placeholders, ",") + ")"
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		// On a missing-table error (cron didn't run EnsureSchema yet, or
		// fresh dev DB) treat every message as not-yet-seeded so the
		// caller can proceed. The first RecordSeeded will surface the
		// schema error definitively.
		if isMissingTable(err) {
			return map[string]struct{}{}, nil
		}
		return nil, fmt.Errorf("look up already-seeded ids: %w", err)
	}
	defer rows.Close()

	out := map[string]struct{}{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan seeded id: %w", err)
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// RecordSeeded inserts a new row tracking that messageID was shipped to
// the lab. Re-recording the same id is a no-op (ON CONFLICT DO NOTHING)
// so this is safe to call from concurrent batches.
func (s *Store) RecordSeeded(ctx context.Context, messageID, batchID, category, labMailbox string) error {
	if strings.TrimSpace(messageID) == "" {
		return errors.New("RecordSeeded: empty messageID")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO operator_practice_seed_log (message_id, batch_id, category, lab_mailbox)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (message_id) DO NOTHING
	`, messageID, batchID, category, labMailbox)
	if err != nil {
		return fmt.Errorf("record seeded message %s: %w", messageID, err)
	}
	return nil
}

// FilterUnseen removes already-seeded messages from the input slice.
// Returns a fresh slice so callers can safely chain — input is unmutated.
func (s *Store) FilterUnseen(ctx context.Context, msgs []op.Message) ([]op.Message, error) {
	if len(msgs) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		if strings.TrimSpace(m.MessageID) != "" {
			ids = append(ids, m.MessageID)
		}
	}
	seen, err := s.AlreadySeeded(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]op.Message, 0, len(msgs))
	for _, m := range msgs {
		if _, dup := seen[m.MessageID]; dup {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

func normalizeCategory(reply string) string {
	switch strings.ToLower(strings.TrimSpace(reply)) {
	case "interested", "meeting":
		return "interested"
	case "ooo", "auto_ooo", "auto-ooo":
		return "ooo"
	case "negative":
		return "not-interested"
	case "objection":
		return "objection"
	case "wrong_person", "wrong-person":
		return "wrong-person"
	case "later":
		return "later"
	case "spam":
		return "spam"
	case "":
		return "ambiguous"
	default:
		return strings.ToLower(reply)
	}
}

func isMissingTable(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "operator_practice_seed_log") &&
		(strings.Contains(msg, "does not exist") || strings.Contains(msg, "no such table"))
}

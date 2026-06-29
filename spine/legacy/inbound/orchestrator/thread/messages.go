package thread

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"
)

// Direction of a message.
type Direction string

const (
	Outbound Direction = "outbound"
	Inbound  Direction = "inbound"
)

// Sentiment of a reply.
type Sentiment string

const (
	SentimentPositive Sentiment = "positive"
	SentimentNeutral  Sentiment = "neutral"
	SentimentNegative Sentiment = "negative"
	SentimentOOO      Sentiment = "ooo"
)

// Message represents a single email in a thread.
type Message struct {
	ID              int
	ThreadID        int
	Direction       Direction
	MessageID       string // SMTP Message-ID
	InReplyTo       string // parent Message-ID
	ReferencesHdr   string // RFC 5322 References
	Subject         string
	BodyPreview     string
	BodyHash        string
	Sentiment       Sentiment
	ReplyType       string
	SentAt          *time.Time
	DeliveredAt     *time.Time
	OpenedAt        *time.Time
	ClickedAt       *time.Time
	RepliedAt       *time.Time
	BouncedAt       *time.Time
	MailboxUsed     string
	SMTPResponse    string
	HumanizeApplied bool
	IsBump          bool
	CreatedAt       time.Time
}

// MessageRecorder handles message persistence and tracking updates.
type MessageRecorder struct {
	db        *sql.DB
	sanitizer HTMLSanitizer
}

// NewMessageRecorder creates a message recorder with the production
// bluemonday sanitizer. Use WithSanitizer for tests.
func NewMessageRecorder(db *sql.DB) *MessageRecorder {
	return &MessageRecorder{db: db, sanitizer: NewSanitizer()}
}

// WithSanitizer overrides the HTML sanitizer (test injection point).
func (r *MessageRecorder) WithSanitizer(s HTMLSanitizer) *MessageRecorder {
	r.sanitizer = s
	return r
}

// RecordOutbound saves an outbound message.
func (r *MessageRecorder) RecordOutbound(ctx context.Context, msg OutboundMessage) (int, error) {
	preview := msg.BodyPlain
	if len(preview) > 200 {
		preview = preview[:200]
	}

	var id int
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO outreach_messages (
			thread_id, direction, message_id, in_reply_to, references_header,
			subject, body_preview, body_hash,
			sent_at, mailbox_used, humanize_applied, is_bump
		) VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id
	`,
		msg.ThreadID, msg.MessageID, msg.InReplyTo, msg.ReferencesHdr,
		msg.Subject, preview, hashBody(msg.BodyPlain),
		msg.SentAt, msg.MailboxUsed, msg.HumanizeApplied, msg.IsBump,
	).Scan(&id)

	return id, err
}

// RecordInbound saves an inbound reply matched to a thread, plus any
// attachments. body_html is sanitized at write time; body_html_raw
// retains the original input for DSR Article 15 export — never served
// to UI. Schema columns: migrations 012 + 013 (PR #210).
//
// Implementation note: when there are NO attachments the legacy
// single-statement INSERT is preserved (no transaction overhead).
// When attachments are present we wrap in BEGIN/COMMIT for atomicity —
// either both message + all attachments persist, or none. This split
// keeps existing sqlmock tests (no-attachment cases) unchanged.
func (r *MessageRecorder) RecordInbound(ctx context.Context, msg InboundMessage) (int, error) {
	preview := msg.BodyPlain
	if len(preview) > 200 {
		preview = preview[:200]
	}

	sanitized := ""
	if r.sanitizer != nil && msg.BodyHTML != "" {
		sanitized = r.sanitizer.Sanitize(msg.BodyHTML)
	}

	insertSQL := `
		INSERT INTO outreach_messages (
			thread_id, direction, message_id, in_reply_to, references_header,
			subject, body_preview, body_hash,
			body_text, body_html, body_html_raw, body_size_bytes,
			sentiment, reply_type, replied_at
		) VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id
	`
	args := []interface{}{
		msg.ThreadID, msg.MessageID, msg.InReplyTo, msg.ReferencesHdr,
		msg.Subject, preview, hashBody(msg.BodyPlain),
		nullableString(msg.BodyPlain), nullableString(sanitized), nullableString(msg.BodyHTML),
		nullableInt(msg.BodySizeBytes),
		string(msg.Sentiment), msg.ReplyType, msg.ReceivedAt,
	}

	// Fast path — no attachments, single statement.
	if len(msg.Attachments) == 0 {
		var id int
		err := r.db.QueryRowContext(ctx, insertSQL, args...).Scan(&id)
		if err != nil {
			return 0, fmt.Errorf("insert outreach_messages: %w", err)
		}
		notifyInbound(ctx, r.db, msg.ThreadID, id)
		return id, nil
	}

	// Attachment path — BEGIN/COMMIT for atomicity.
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var id int
	if err := tx.QueryRowContext(ctx, insertSQL, args...).Scan(&id); err != nil {
		return 0, fmt.Errorf("insert outreach_messages: %w", err)
	}

	for i, att := range msg.Attachments {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO message_attachments (
				message_id, content_id, filename, content_type,
				size_bytes, sha256, data, is_inline
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`,
			id, nullableString(att.ContentID), att.Filename, att.ContentType,
			att.SizeBytes, att.SHA256, att.Data, att.IsInline,
		)
		if err != nil {
			return 0, fmt.Errorf("insert message_attachments[%d] (%s): %w", i, att.Filename, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}

	notifyInbound(ctx, r.db, msg.ThreadID, id)
	return id, nil
}

// notifyInbound emits a PG NOTIFY on `thread_inbound` so the BFF SSE
// channel (mail-client S3.1) can fan out the new-message event to
// connected ThreadDetail clients in real time.
//
// Best-effort — failures are logged but do NOT fail the caller. The
// BFF's UI polling fallback (S3.3 30s refresh) catches gaps. NOTIFY
// fires AFTER tx.Commit so a rolled-back insert never produces a
// phantom event.
func notifyInbound(ctx context.Context, db *sql.DB, threadID, messageID int) {
	payload := fmt.Sprintf(`{"thread_id":%d,"message_id":%d}`, threadID, messageID)
	if _, err := db.ExecContext(ctx, `SELECT pg_notify('thread_inbound', $1)`, payload); err != nil {
		// Don't propagate — caller already has the row in DB. Log so
		// ops can spot listener-side breakage (e.g. PG out of advisory
		// notification slots, network partition between services).
		slog.Warn("thread_inbound notify failed",
			"op", "thread.notifyInbound",
			"thread_id", threadID,
			"message_id", messageID,
			"error", err)
	}
}

// nullableString returns nil for empty strings so PG stores NULL — keeps
// the DB clean of '' values that would defeat IS NULL filters.
func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func nullableInt(n int) interface{} {
	if n == 0 {
		return nil
	}
	return n
}

// MarkOpened updates the first outbound message in the thread as opened.
func (r *MessageRecorder) MarkOpened(ctx context.Context, messageID string, openedAt time.Time) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE outreach_messages SET opened_at = $1
		WHERE message_id = $2 AND opened_at IS NULL
	`, openedAt, messageID)
	return err
}

// MarkClicked updates a message as clicked.
func (r *MessageRecorder) MarkClicked(ctx context.Context, messageID string, clickedAt time.Time) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE outreach_messages SET clicked_at = $1
		WHERE message_id = $2 AND clicked_at IS NULL
	`, clickedAt, messageID)
	return err
}

// MarkBounced updates a message as bounced.
func (r *MessageRecorder) MarkBounced(ctx context.Context, messageID string, bouncedAt time.Time, smtpResponse string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE outreach_messages SET bounced_at = $1, smtp_response = $2
		WHERE message_id = $3 AND bounced_at IS NULL
	`, bouncedAt, smtpResponse, messageID)
	return err
}

// FindByMessageID looks up a message by its SMTP Message-ID.
func (r *MessageRecorder) FindByMessageID(ctx context.Context, messageID string) (*Message, error) {
	msg := &Message{}
	var sentAt, deliveredAt, openedAt, clickedAt, repliedAt, bouncedAt sql.NullTime
	var inReplyTo, refsHdr, sentiment, replyType, mailbox, smtp sql.NullString

	err := r.db.QueryRowContext(ctx, `
		SELECT id, thread_id, direction, message_id, in_reply_to, references_header,
			subject, body_preview, body_hash, sentiment, reply_type,
			sent_at, delivered_at, opened_at, clicked_at, replied_at, bounced_at,
			mailbox_used, smtp_response, humanize_applied, is_bump, created_at
		FROM outreach_messages WHERE message_id = $1
	`, messageID).Scan(
		&msg.ID, &msg.ThreadID, &msg.Direction, &msg.MessageID,
		&inReplyTo, &refsHdr, &msg.Subject, &msg.BodyPreview, &msg.BodyHash,
		&sentiment, &replyType,
		&sentAt, &deliveredAt, &openedAt, &clickedAt, &repliedAt, &bouncedAt,
		&mailbox, &smtp, &msg.HumanizeApplied, &msg.IsBump, &msg.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("find message %s: %w", messageID, err)
	}

	if inReplyTo.Valid { msg.InReplyTo = inReplyTo.String }
	if refsHdr.Valid { msg.ReferencesHdr = refsHdr.String }
	if sentiment.Valid { msg.Sentiment = Sentiment(sentiment.String) }
	if replyType.Valid { msg.ReplyType = replyType.String }
	if sentAt.Valid { msg.SentAt = &sentAt.Time }
	if deliveredAt.Valid { msg.DeliveredAt = &deliveredAt.Time }
	if openedAt.Valid { msg.OpenedAt = &openedAt.Time }
	if clickedAt.Valid { msg.ClickedAt = &clickedAt.Time }
	if repliedAt.Valid { msg.RepliedAt = &repliedAt.Time }
	if bouncedAt.Valid { msg.BouncedAt = &bouncedAt.Time }
	if mailbox.Valid { msg.MailboxUsed = mailbox.String }
	if smtp.Valid { msg.SMTPResponse = smtp.String }

	return msg, nil
}

// ThreadMessages returns all messages in a thread, ordered chronologically.
func (r *MessageRecorder) ThreadMessages(ctx context.Context, threadID int) ([]Message, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, thread_id, direction, message_id, subject, body_preview,
			sentiment, reply_type, sent_at, replied_at, opened_at, is_bump, created_at
		FROM outreach_messages
		WHERE thread_id = $1
		ORDER BY created_at
	`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []Message
	for rows.Next() {
		var m Message
		var sentAt, repliedAt, openedAt sql.NullTime
		var msgID, sentiment, replyType sql.NullString
		rows.Scan(&m.ID, &m.ThreadID, &m.Direction, &msgID, &m.Subject, &m.BodyPreview,
			&sentiment, &replyType, &sentAt, &repliedAt, &openedAt, &m.IsBump, &m.CreatedAt)
		if msgID.Valid { m.MessageID = msgID.String }
		if sentiment.Valid { m.Sentiment = Sentiment(sentiment.String) }
		if replyType.Valid { m.ReplyType = replyType.String }
		if sentAt.Valid { m.SentAt = &sentAt.Time }
		if repliedAt.Valid { m.RepliedAt = &repliedAt.Time }
		if openedAt.Valid { m.OpenedAt = &openedAt.Time }
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// OutboundMessage is the input for recording a sent email.
type OutboundMessage struct {
	ThreadID        int
	MessageID       string
	InReplyTo       string
	ReferencesHdr   string
	Subject         string
	BodyPlain       string
	SentAt          time.Time
	MailboxUsed     string
	HumanizeApplied bool
	IsBump          bool
}

// InboundMessage is the input for recording a received reply.
type InboundMessage struct {
	ThreadID      int
	MessageID     string
	InReplyTo     string
	ReferencesHdr string
	Subject       string
	BodyPlain     string
	BodyHTML      string // RAW HTML — RecordInbound sanitizes before write
	BodySizeBytes int    // full RFC822 size
	Sentiment     Sentiment
	ReplyType     string
	ReceivedAt    time.Time
	Attachments   []InboundAttachment
}

// InboundAttachment is one MIME part lifted from the parsed message.
// Caller computes SHA256 + SizeBytes; RecordInbound persists as-is.
type InboundAttachment struct {
	ContentID   string // bare value, no angle brackets; "" for non-inline
	Filename    string
	ContentType string
	Data        []byte
	SizeBytes   int
	SHA256      string // hex-encoded
	IsInline    bool
}

func hashBody(body string) string {
	h := sha256.Sum256([]byte(body))
	return hex.EncodeToString(h[:16]) // first 16 bytes = 32 hex chars
}

// cron_outbound_reply.go — Z3-A outbound reply cron migrated from BFF
// runOutboundReplyCron (apps/outreach-dashboard/src/crons/runOutboundReplyCron.js).
//
// Behaviour:
//
//   - Every interval (default 90s) the loop drains pending rows in
//     manual_reply_outbox whose attempts < MAX_ATTEMPTS, joins them
//     with reply_inbox + outreach_mailboxes + manual_reply_outbox_attachments
//     to assemble a relay /v1/submit request, and writes back success /
//     failure into the row.
//
//   - On success: sent_at + envelope_id are set on manual_reply_outbox,
//     an outreach_messages outbound row is recorded so the thread view
//     shows the operator's reply, and operator_audit_log gets a row.
//
//   - On failure: attempts is incremented, error column is updated with
//     the relay's response, and operator_audit_log gets a row.
//
// HARD RULE compliance:
//
//   - feedback_engine_path_test (T0)         — outbound goes through the
//     same /v1/submit endpoint the campaign engine uses; the relay
//     applies PreSendHook + drain. No bypass.
//   - feedback_audit_log_on_mutations (T0)   — every UPDATE on
//     manual_reply_outbox writes an operator_audit_log row.
//   - feedback_no_pii_in_commands (T0)       — slog labels use
//     mailbox_id + outbox_id + envelope_id; the recipient address is
//     never logged.
//   - feedback_no_magic_thresholds (T0)      — interval + max attempts
//     defined as package constants.
//   - feedback_external_io_backoff (T0)      — each attempt has a 45s
//     HTTP timeout; the attempts counter is the backoff knob (each
//     failed attempt re-runs on the next tick).
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"common/audit"
	"common/envconfig"
)

// ─── Named thresholds (no magic numbers) ────────────────────────────────

const (
	// defaultOutboundReplyInterval mirrors the BFF cron's 90s schedule.
	defaultOutboundReplyInterval = 90 * time.Second

	// defaultOutboxMaxAttempts mirrors the BFF env knob OUTBOX_MAX_ATTEMPTS.
	defaultOutboxMaxAttempts = 3

	// outboundReplyBatch caps the number of pending rows pulled per tick.
	outboundReplyBatch = 20

	// outboundReplyHTTPTimeout is the per-attempt HTTP ceiling for the
	// relay POST /v1/submit call. Matches BFF (45s).
	outboundReplyHTTPTimeout = 45 * time.Second
)

// ─── Types ──────────────────────────────────────────────────────────────

// outboxRow captures every column the cron needs for one submit attempt.
type outboxRow struct {
	OutboxID         int64
	Body             string
	SubjectOverride  sql.NullString
	Attempts         int
	ReplyInboxID     int64
	Recipient        string
	OriginalSubject  sql.NullString
	MailboxID        int64
	SendEventID      sql.NullInt64
	InReplyTo        sql.NullString
	MailboxAddr      string
	SMTPHost         string
	SMTPPort         int
	SMTPUsername     sql.NullString
	Password         string
	IMAPHost         sql.NullString
	IMAPPort         sql.NullInt64
	PreferredCountry sql.NullString
	// Forward feature (migration 175). ForwardTo overrides the recipient
	// (NULL = reply to original sender). Kind is 'reply' | 'forward'.
	ForwardTo sql.NullString
	Kind      string
}

// isForward reports whether this outbox row is a forward (operator-chosen
// third-party recipient) rather than a reply to the original sender.
func (r outboxRow) isForward() bool { return r.Kind == "forward" }

// outboxAttachment is the relay-submit shape for a single attached file.
type outboxAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	DataB64     string `json:"data_b64"`
	SHA256      string `json:"sha256,omitempty"`
	IsInline    bool   `json:"is_inline"`
}

// submitRequest mirrors services/relay/internal/model.IntakeRequest with
// the extra `attachments` array the relay's outbound MIME assembler
// already consumes. We send the full structured payload (body_html
// omitted — replies are plain text) per feedback_relay_submit_full_payload
// (T1) so the recipient sees the operator's wording exactly as drafted.
type submitRequest struct {
	Recipient        string             `json:"recipient"`
	Subject          string             `json:"subject"`
	Body             string             `json:"body"`
	FromAddress      string             `json:"from_address"`
	SMTPHost         string             `json:"smtp_host"`
	SMTPPort         int                `json:"smtp_port"`
	SMTPUsername     string             `json:"smtp_username"`
	SMTPPassword     string             `json:"smtp_password"`
	IMAPHost         string             `json:"imap_host,omitempty"`
	IMAPPort         int                `json:"imap_port,omitempty"`
	Headers          map[string]string  `json:"headers,omitempty"`
	PreferredCountry string             `json:"preferred_country,omitempty"`
	MailboxID        string             `json:"mailbox_id,omitempty"`
	Attachments      []outboxAttachment `json:"attachments,omitempty"`
}

// submitResponse mirrors the fields the cron actually needs from the
// relay's response — the standard json decoder tolerates extras.
type submitResponse struct {
	EnvelopeID string `json:"envelope_id"`
	Status     string `json:"status"`
	Error      string `json:"error,omitempty"`
}

// ─── Loop ───────────────────────────────────────────────────────────────

// OutboundReplyLoop drains manual_reply_outbox rows on a schedule and
// POSTs each to the anti-trace-relay's /v1/submit endpoint.
type OutboundReplyLoop struct {
	db          *sql.DB
	relayURL    string
	relayToken  string
	interval    time.Duration
	maxAttempts int
	httpClient  *http.Client
	logger      *slog.Logger
}

// OutboundReplyOption is a functional option for NewOutboundReplyLoop.
type OutboundReplyOption func(*OutboundReplyLoop)

// WithOutboundInterval overrides the default 90s tick interval.
func WithOutboundInterval(d time.Duration) OutboundReplyOption {
	return func(l *OutboundReplyLoop) {
		if d > 0 {
			l.interval = d
		}
	}
}

// WithOutboundMaxAttempts overrides the per-row retry cap (default 3).
func WithOutboundMaxAttempts(n int) OutboundReplyOption {
	return func(l *OutboundReplyLoop) {
		if n > 0 {
			l.maxAttempts = n
		}
	}
}

// WithOutboundHTTPClient injects a custom HTTP client for tests.
func WithOutboundHTTPClient(c *http.Client) OutboundReplyOption {
	return func(l *OutboundReplyLoop) {
		if c != nil {
			l.httpClient = c
		}
	}
}

// WithOutboundLogger replaces the default slog.Default logger.
func WithOutboundLogger(lg *slog.Logger) OutboundReplyOption {
	return func(l *OutboundReplyLoop) {
		if lg != nil {
			l.logger = lg
		}
	}
}

// NewOutboundReplyLoop constructs an OutboundReplyLoop.
func NewOutboundReplyLoop(db *sql.DB, relayURL, relayToken string, opts ...OutboundReplyOption) *OutboundReplyLoop {
	l := &OutboundReplyLoop{
		db:          db,
		relayURL:    strings.TrimRight(relayURL, "/"),
		relayToken:  relayToken,
		interval:    defaultOutboundReplyInterval,
		maxAttempts: defaultOutboxMaxAttempts,
		httpClient:  &http.Client{Timeout: outboundReplyHTTPTimeout},
		logger:      slog.Default(),
	}
	for _, o := range opts {
		o(l)
	}
	return l
}

// Run starts the long-running drain loop. Blocks until ctx cancels.
func (l *OutboundReplyLoop) Run(ctx context.Context) error {
	l.logger.Info("outbound reply loop started",
		"op", "OutboundReplyLoop.Run",
		"interval", l.interval,
		"max_attempts", l.maxAttempts,
		"relay_url", l.relayURL)

	l.tick(ctx)

	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			l.logger.Info("outbound reply loop stopped", "op", "OutboundReplyLoop.Run/stop")
			return ctx.Err()
		case <-ticker.C:
			l.tick(ctx)
		}
	}
}

// tick drains one batch of pending outbox rows.
func (l *OutboundReplyLoop) tick(ctx context.Context) {
	if l.relayURL == "" || l.relayToken == "" {
		l.logger.Warn("outbound reply: relay not configured",
			"op", "OutboundReplyLoop.tick/relayMissing",
			"have_url", l.relayURL != "",
			"have_token", l.relayToken != "")
		return
	}
	pending, err := l.loadPending(ctx)
	if err != nil {
		l.logger.Error("outbound reply: load pending failed",
			"op", "OutboundReplyLoop.tick/load",
			"error", err)
		return
	}
	if len(pending) == 0 {
		return
	}

	for _, row := range pending {
		if ctx.Err() != nil {
			return
		}
		l.processOne(ctx, row)
	}
}

// loadPending returns the next batch of unsent reply outbox rows. The
// SQL JOIN matches the BFF cron exactly so behaviour stays bit-for-bit
// identical during the cutover window.
func (l *OutboundReplyLoop) loadPending(ctx context.Context) ([]outboxRow, error) {
	if l.db == nil {
		return nil, nil
	}
	// Forward feature (migration 175): recipient = COALESCE(forward_to,
	// from_email) so a forward overrides the reply-to-sender default; the
	// sending mailbox = COALESCE(from_mailbox_id, reply_inbox.mailbox_id) so a
	// forward can pin an explicit identity (and so unmatched-reply forwards,
	// where reply_inbox.mailbox_id IS NULL, still resolve a mailbox). We scan
	// m.id (not r.mailbox_id) so mailbox_id always reflects the ACTUAL sender.
	rows, err := l.db.QueryContext(ctx, `
		SELECT o.id, o.body, o.subject_override, o.attempts,
		       o.reply_inbox_id,
		       COALESCE(o.forward_to, r.from_email) AS recipient, r.subject AS original_subject,
		       m.id AS mailbox_id, r.send_event_id,
		       se.message_id AS in_reply_to,
		       m.from_address AS mailbox_addr,
		       m.smtp_host,
		       COALESCE(m.smtp_port, 465),
		       m.smtp_username, m.password,
		       m.imap_host, m.imap_port,
		       m.preferred_country,
		       o.forward_to, o.kind
		FROM manual_reply_outbox o
		JOIN reply_inbox r          ON r.id = o.reply_inbox_id
		LEFT JOIN send_events se    ON se.id = r.send_event_id
		JOIN outreach_mailboxes m   ON m.id = COALESCE(o.from_mailbox_id, r.mailbox_id)
		WHERE o.sent_at IS NULL
		  AND o.attempts < $1
		ORDER BY o.id
		LIMIT $2
	`, l.maxAttempts, outboundReplyBatch)
	if err != nil {
		return nil, fmt.Errorf("select pending: %w", err)
	}
	defer rows.Close()

	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(
			&r.OutboxID, &r.Body, &r.SubjectOverride, &r.Attempts,
			&r.ReplyInboxID, &r.Recipient, &r.OriginalSubject,
			&r.MailboxID, &r.SendEventID, &r.InReplyTo,
			&r.MailboxAddr, &r.SMTPHost, &r.SMTPPort,
			&r.SMTPUsername, &r.Password,
			&r.IMAPHost, &r.IMAPPort,
			&r.PreferredCountry,
			&r.ForwardTo, &r.Kind,
		); err != nil {
			return nil, fmt.Errorf("scan pending: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// loadAttachments fetches the inline attachments associated with an outbox row.
func (l *OutboundReplyLoop) loadAttachments(ctx context.Context, outboxID int64) ([]outboxAttachment, error) {
	if l.db == nil {
		return nil, nil
	}
	rows, err := l.db.QueryContext(ctx, `
		SELECT filename, content_type, size_bytes, data, sha256, is_inline
		FROM manual_reply_outbox_attachments
		WHERE outbox_id = $1
		ORDER BY position
	`, outboxID)
	if err != nil {
		return nil, fmt.Errorf("select attachments: %w", err)
	}
	defer rows.Close()
	var out []outboxAttachment
	for rows.Next() {
		var (
			a    outboxAttachment
			data []byte
		)
		if err := rows.Scan(&a.Filename, &a.ContentType, &a.SizeBytes, &data, &a.SHA256, &a.IsInline); err != nil {
			return nil, fmt.Errorf("scan attachment: %w", err)
		}
		a.DataB64 = base64.StdEncoding.EncodeToString(data)
		out = append(out, a)
	}
	return out, rows.Err()
}

// processOne assembles the relay submit payload and updates the row
// according to the response. Errors here are logged + persisted; the
// loop continues with the next row.
func (l *OutboundReplyLoop) processOne(ctx context.Context, row outboxRow) {
	atts, err := l.loadAttachments(ctx, row.OutboxID)
	if err != nil {
		l.logger.Warn("outbound reply: load attachments failed",
			"op", "OutboundReplyLoop.processOne/loadAtt",
			"outbox_id", row.OutboxID,
			"error", err)
		// Continue without attachments — better to send the body than
		// silently retry forever waiting for the attachment table to load.
		atts = nil
	}

	subject := buildReplySubject(row)
	headers := buildReplyHeaders(row)
	reqBody := submitRequest{
		Recipient:        row.Recipient,
		Subject:          subject,
		Body:             row.Body,
		FromAddress:      row.MailboxAddr,
		SMTPHost:         row.SMTPHost,
		SMTPPort:         row.SMTPPort,
		SMTPUsername:     stringOrFallback(row.SMTPUsername, row.MailboxAddr),
		SMTPPassword:     row.Password,
		IMAPHost:         row.IMAPHost.String,
		IMAPPort:         int(row.IMAPPort.Int64),
		Headers:          headers,
		PreferredCountry: row.PreferredCountry.String,
		MailboxID:        fmt.Sprintf("%d", row.MailboxID),
		Attachments:      atts,
	}

	resp, status, sendErr := l.submitToRelay(ctx, reqBody)
	if sendErr != nil {
		l.recordFailure(ctx, row, sendErr.Error())
		return
	}
	if status >= 400 {
		errMsg := resp.Error
		if errMsg == "" {
			errMsg = fmt.Sprintf("relay HTTP %d", status)
		}
		l.recordFailure(ctx, row, errMsg)
		return
	}

	l.recordSuccess(ctx, row, resp.EnvelopeID, subject)
}

// submitToRelay POSTs the assembled request to the relay /v1/submit
// endpoint. Returns the parsed response, HTTP status, and an error
// distinct from a non-2xx response (which is signalled by status).
func (l *OutboundReplyLoop) submitToRelay(ctx context.Context, req submitRequest) (*submitResponse, int, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal submit: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, outboundReplyHTTPTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(cctx, http.MethodPost, l.relayURL+"/v1/submit", bytes.NewReader(body))
	if err != nil {
		return nil, 0, fmt.Errorf("build submit request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if l.relayToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+l.relayToken)
	}
	res, err := l.httpClient.Do(httpReq)
	if err != nil {
		return nil, 0, fmt.Errorf("submit http: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024))
	if err != nil {
		return nil, res.StatusCode, fmt.Errorf("submit read body: %w", err)
	}
	var parsed submitResponse
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &parsed)
	}
	return &parsed, res.StatusCode, nil
}

// recordSuccess marks the outbox row sent, writes the outbound thread
// message, and emits an operator_audit_log entry.
func (l *OutboundReplyLoop) recordSuccess(ctx context.Context, row outboxRow, envelopeID, subject string) {
	if l.db == nil {
		return
	}
	if _, err := l.db.ExecContext(ctx, `
		UPDATE manual_reply_outbox
		   SET sent_at     = now(),
		       envelope_id = $1,
		       error       = NULL,
		       updated_at  = now()
		 WHERE id = $2
	`, envelopeID, row.OutboxID); err != nil {
		l.logger.Warn("outbound reply: update success failed",
			"op", "OutboundReplyLoop.recordSuccess/update",
			"outbox_id", row.OutboxID,
			"error", err)
		return
	}

	// Persist the operator's outbound reply on the thread so the UI shows it
	// without waiting for the next IMAP poll to APPEND-roundtrip. A FORWARD is
	// not part of the lead's conversation (it went to a third party), so skip
	// this thread-insert for forwards.
	if !row.isForward() {
		inReplyTo := sql.NullString{}
		if row.InReplyTo.Valid {
			inReplyTo = row.InReplyTo
		}
		if _, err := l.db.ExecContext(ctx, `
			INSERT INTO outreach_messages (
			    thread_id, direction, message_id, in_reply_to, body_text, subject, replied_at
			)
			SELECT t.id, 'outbound', $1, $2, $3, $4, now()
			  FROM reply_inbox r
			  LEFT JOIN outreach_threads t ON t.contact_id = r.contact_id
			 WHERE r.id = $5
			 LIMIT 1
		`, envelopeID, inReplyTo, row.Body, subject, row.ReplyInboxID); err != nil {
			// Non-fatal — relay accepted the message; the UI will catch up
			// from the next IMAP poll. Logged so operators see drift if it
			// repeats.
			l.logger.Warn("outbound reply: outreach_messages insert failed",
				"op", "OutboundReplyLoop.recordSuccess/messages",
				"outbox_id", row.OutboxID,
				"error", err)
		}
	}

	action := "outbound_reply.sent"
	if row.isForward() {
		action = "outbound_forward.sent"
	}
	audit.Log(ctx, l.db, action, "go.cron.outbound_reply",
		"manual_reply_outbox", fmt.Sprintf("%d", row.OutboxID),
		map[string]any{
			"envelope_id":    envelopeID,
			"mailbox_id":     row.MailboxID,
			"reply_inbox_id": row.ReplyInboxID,
			"kind":           row.Kind,
		})

	l.logger.Info("outbound reply sent",
		"op", "OutboundReplyLoop.recordSuccess/ok",
		"outbox_id", row.OutboxID,
		"mailbox_id", row.MailboxID,
		"envelope_id", envelopeID)
}

// recordFailure bumps the attempt counter, writes the error column, and
// audits the failure for operator visibility.
func (l *OutboundReplyLoop) recordFailure(ctx context.Context, row outboxRow, errMsg string) {
	if l.db == nil {
		return
	}
	// Truncate to match the BFF column cap (500 chars).
	if len(errMsg) > 500 {
		errMsg = errMsg[:500]
	}
	if _, err := l.db.ExecContext(ctx, `
		UPDATE manual_reply_outbox
		   SET attempts   = attempts + 1,
		       error      = $1,
		       updated_at = now()
		 WHERE id = $2
	`, errMsg, row.OutboxID); err != nil {
		l.logger.Warn("outbound reply: update failure failed",
			"op", "OutboundReplyLoop.recordFailure/update",
			"outbox_id", row.OutboxID,
			"error", err)
		return
	}
	action := "outbound_reply.failed"
	if row.isForward() {
		action = "outbound_forward.failed"
	}
	audit.Log(ctx, l.db, action, "go.cron.outbound_reply",
		"manual_reply_outbox", fmt.Sprintf("%d", row.OutboxID),
		map[string]any{
			"mailbox_id":     row.MailboxID,
			"reply_inbox_id": row.ReplyInboxID,
			"attempts":       row.Attempts + 1,
			"error":          errMsg,
			"kind":           row.Kind,
		})
	l.logger.Warn("outbound reply failed",
		"op", "OutboundReplyLoop.recordFailure/logged",
		"outbox_id", row.OutboxID,
		"mailbox_id", row.MailboxID,
		"attempts", row.Attempts+1,
		"error", errMsg)
}

// ─── Helpers ────────────────────────────────────────────────────────────

// buildReplySubject mirrors the BFF logic: explicit subject_override
// wins, otherwise prepend "Re: " when the original subject lacks it.
func buildReplySubject(row outboxRow) string {
	if row.SubjectOverride.Valid {
		s := strings.TrimSpace(row.SubjectOverride.String)
		if s != "" {
			return s
		}
	}
	orig := strings.TrimSpace(row.OriginalSubject.String)
	if orig == "" {
		return "Re: "
	}
	low := strings.ToLower(orig)
	if strings.HasPrefix(low, "re:") {
		return orig
	}
	return "Re: " + orig
}

// buildReplyHeaders constructs the standard RFC 5322 §3.6.5 threading
// headers so the recipient's mail client (Seznam, Gmail, Outlook all
// honour these) keeps the reply glued to the operator's original.
func buildReplyHeaders(row outboxRow) map[string]string {
	h := map[string]string{
		"Date": time.Now().UTC().Format(time.RFC1123Z),
	}
	// A forward is a fresh message to a third party who never saw the
	// original thread — emitting In-Reply-To/References pointing at the
	// campaign send would be semantically wrong, so omit them for forwards.
	if !row.isForward() && row.InReplyTo.Valid {
		v := strings.TrimSpace(row.InReplyTo.String)
		if v != "" {
			h["In-Reply-To"] = "<" + v + ">"
			h["References"] = "<" + v + ">"
		}
	}
	return h
}

// stringOrFallback returns the NULL-safe string or the fallback when
// either NULL or empty.
func stringOrFallback(ns sql.NullString, fallback string) string {
	if ns.Valid {
		if s := strings.TrimSpace(ns.String); s != "" {
			return s
		}
	}
	return fallback
}

// startOutboundReplyLoop wires the cron into the `server` boot path.
func startOutboundReplyLoop(ctx context.Context, db *sql.DB) bool {
	if envconfig.BoolOr("DISABLE_OUTBOUND_REPLY_LOOP", false) {
		slog.Info("outbound reply loop disabled (DISABLE_OUTBOUND_REPLY_LOOP=1)",
			"op", "main.startOutboundReplyLoop/disabled")
		return false
	}
	relayURL := envconfig.GetOr("ANTI_TRACE_RELAY_URL", "")
	relayToken := envconfig.GetOr("ANTI_TRACE_RELAY_TOKEN", envconfig.GetOr("ANTI_TRACE_TOKEN", ""))
	if relayURL == "" || relayToken == "" {
		slog.Warn("outbound reply loop not started — relay url/token unset",
			"op", "main.startOutboundReplyLoop/configMissing",
			"have_url", relayURL != "",
			"have_token", relayToken != "")
		return false
	}

	opts := []OutboundReplyOption{}
	if v := envconfig.GetOr("OUTBOUND_REPLY_INTERVAL", ""); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			opts = append(opts, WithOutboundInterval(d))
		}
	}
	if v := envconfig.GetOr("OUTBOX_MAX_ATTEMPTS", ""); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			opts = append(opts, WithOutboundMaxAttempts(n))
		}
	}
	loop := NewOutboundReplyLoop(db, relayURL, relayToken, opts...)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("outbound reply loop panic recovered",
					"op", "main.startOutboundReplyLoop/recover",
					"recover", r)
			}
		}()
		if err := loop.Run(ctx); err != nil && ctx.Err() == nil {
			slog.Error("outbound reply loop exited unexpectedly",
				"op", "main.startOutboundReplyLoop/exit",
				"error", err)
		}
	}()
	slog.Info("outbound reply loop started",
		"op", "main.startOutboundReplyLoop/ok",
		"relay_url", relayURL)
	return true
}

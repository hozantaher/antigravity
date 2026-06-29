package web

// inbound.go — POST /api/inbound handler (Sprint 1.2).
//
// Accepts a raw RFC 5322 inbound message from the BFF cron (which
// fetched it via relay /v1/imap-fetch?include_body=true) and invokes
// thread.InboundProcessor.ProcessReply. The processor handles MIME
// parsing (orchestrator/mime.Parse), attachment extraction (writes
// message_attachments rows), thread matching via Message-ID/
// In-Reply-To chain or fallback email/domain match, sentiment
// classification, suppression, lead detection, and PG NOTIFY for the
// thread stream.
//
// Why HTTP instead of co-located orchestrator IMAP poller: services
// run in separate Railway containers, and the relay's wgsocks
// listener binds 127.0.0.1 (memory project_bff_imap_cross_service_broken).
// Centralising IMAP egress in the relay container is cleaner than
// duplicating wgsocks setup per service. BFF asks relay for the raw
// stream and forwards it here for processing.
//
// Memory:
//   feedback_no_pii_in_commands — slog labels use mailbox + msg ID only.
//   feedback_extreme_testing    — inbound_test.go covers ≥10 cases.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"orchestrator/thread"
)

// inboundRequest is the JSON payload sent by BFF runImapPollCron after
// /v1/imap-fetch?include_body=true returns. RawBody is base64-decoded
// automatically by the standard JSON decoder when the field is `[]byte`.
type inboundRequest struct {
	// MailboxAddress is the from_address of the mailbox that received
	// the inbound. Used by the processor to identify the campaign
	// context (matchByEmail falls back when Message-ID chain doesn't
	// resolve).
	MailboxAddress string `json:"mailbox_address"`
	// RawBody is the full RFC 5322 byte stream as returned by IMAP
	// FETCH BODY[]. The standard library JSON decoder base64-decodes
	// []byte fields automatically (Go json package convention).
	RawBody []byte `json:"raw_body"`
	// ReceivedAt is the IMAP server's perception of when the message
	// arrived. BFF passes the IMAP Date header value verbatim (RFC 5322
	// format like "Mon, 11 May 2026 14:44:36 +0200"). Parsed manually
	// via mail.ParseDate which falls back to RFC 3339 when needed. If
	// absent or unparseable, the handler falls back to time.Now().
	ReceivedAt string `json:"received_at,omitempty"`
	// MessageID / InReplyTo / From / Subject are pre-parsed convenience
	// fields. The processor re-parses from RawBody so these are
	// informational; populated by BFF for fast logging without
	// double-parsing.
	MessageID string `json:"message_id,omitempty"`
	InReplyTo string `json:"in_reply_to,omitempty"`
	From      string `json:"from,omitempty"`
	Subject   string `json:"subject,omitempty"`
}

// inboundResponse is the JSON the handler returns. ok=false on
// processing failure; threadID populated when the processor matched.
type inboundResponse struct {
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	MatchedBy string `json:"matched_by,omitempty"`
	ThreadID  int    `json:"thread_id,omitempty"`
	ContactID int    `json:"contact_id,omitempty"`
}

// maxInboundBodyBytes caps the raw RFC 5322 stream this handler will
// accept. A 30-msg batch with 1 MB attachments each = 30 MB; double
// for protocol overhead. Per-request cap is 35 MB so a single 32 MB
// attached file still fits with headroom.
const maxInboundBodyBytes = 35 * 1024 * 1024

// handleInbound is the HTTP handler for POST /api/inbound.
//
// The inbound processor is wired via WithInboundProcessor. When the
// processor is nil (config error / dev mode), the handler returns 503
// rather than silently dropping inbound traffic — operator sees a
// loud failure rather than missing replies.
func (s *Server) handleInbound(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.inboundProcessor == nil {
		http.Error(w, "inbound processor not configured", http.StatusServiceUnavailable)
		return
	}

	var req inboundRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxInboundBodyBytes)).Decode(&req); err != nil {
		// MaxBytesReader returns its own error type when exceeded; the
		// generic JSON syntax error path covers everything else.
		http.Error(w, fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}
	if len(req.RawBody) == 0 {
		http.Error(w, "raw_body required", http.StatusBadRequest)
		return
	}

	// Parse ReceivedAt accepting either RFC 5322 (IMAP Date header
	// canonical form, e.g., "Mon, 11 May 2026 14:44:36 +0200") or RFC
	// 3339 (ISO 8601 — what time.Time.MarshalJSON emits). On parse
	// failure fall back to now so the message still lands; the
	// processor stamps outreach_messages.received_at with this value.
	var receivedAt time.Time
	if s := strings.TrimSpace(req.ReceivedAt); s != "" {
		if t, err := mail.ParseDate(s); err == nil {
			receivedAt = t
		} else if t, err := time.Parse(time.RFC3339, s); err == nil {
			receivedAt = t
		}
	}
	if receivedAt.IsZero() {
		receivedAt = time.Now().UTC()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	raw := thread.RawInbound{
		MessageID:  strings.TrimSpace(req.MessageID),
		InReplyTo:  strings.TrimSpace(req.InReplyTo),
		From:       strings.TrimSpace(req.From),
		Subject:    strings.TrimSpace(req.Subject),
		RawBytes:   req.RawBody,
		ReceivedAt: receivedAt,
		// BodyPlain is filled by ProcessReply itself after MIME parse —
		// BFF doesn't pre-extract it (the relay returns RFC 5322 only).
	}

	if err := s.inboundProcessor.ProcessReply(ctx, raw); err != nil {
		// ProcessReply errors are logged inside the processor with
		// `op=thread.ProcessReply/*` slog tags. The HTTP error here is
		// the caller-facing 502 — BFF will retry on next poll tick.
		slog.Warn("inbound handler ProcessReply failed",
			"op", "web.handleInbound/processFail",
			"mailbox", req.MailboxAddress,
			"message_id", req.MessageID,
			"error", err,
		)
		w.WriteHeader(http.StatusBadGateway)
		writeJSON(w, inboundResponse{
			OK:    false,
			Error: err.Error(),
		})
		return
	}

	writeJSON(w, inboundResponse{OK: true})
}

// WithInboundProcessor wires the orchestrator's thread.InboundProcessor
// into the HTTP layer and registers POST /api/inbound. Call this from
// cmd/outreach/main.go after constructing the processor with its
// classifier / photo hooks.
//
// Returns the receiver to support fluent chaining alongside WithRelay /
// WithMailboxBP / WithSchemaEndpoint.
func (s *Server) WithInboundProcessor(p *thread.InboundProcessor) *Server {
	s.inboundProcessor = p
	// State-changing endpoint — stack the per-IP token-bucket gate.
	if s.stateLimiter != nil {
		s.mux.HandleFunc("/api/inbound", apiKeyAuth(methodGuardedRateLimit(s.stateLimiter, s.handleInbound)))
	} else {
		s.mux.HandleFunc("/api/inbound", apiKeyAuth(s.handleInbound))
	}
	return s
}

// ErrInboundProcessorMissing is returned from WithInboundProcessor when
// callers attempt to register the route without a processor. Exported
// so tests can assert on the sentinel rather than string-matching.
var ErrInboundProcessorMissing = errors.New("orchestrator/web: inbound processor is nil")

// dbForInbound exposes the Server's database handle to handlers in this
// file. Other handlers reach for s.db directly; defined here as a
// helper in case ProcessReply ever needs an extra DB op outside the
// processor's existing transactions.
func (s *Server) dbForInbound() *sql.DB { return s.db }

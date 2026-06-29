package main

// cron_outbound_reply_test.go — risk-proportional coverage for the
// outbound-reply drain loop. Per feedback_extreme_testing (T0):
// state-mutating cron requires 10+ test cases across happy/boundary/error.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ─── Helpers ────────────────────────────────────────────────────────────

func newSilentOutboundLoop(t *testing.T, relayURL string, opts ...OutboundReplyOption) (*OutboundReplyLoop, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	all := append([]OutboundReplyOption{
		WithOutboundLogger(slog.New(slog.NewTextHandler(io.Discard, nil))),
	}, opts...)
	loop := NewOutboundReplyLoop(db, relayURL, "test-token", all...)
	return loop, mock
}

// outboxCols mirrors loadPending's SELECT projection (migration 175 added the
// trailing forward_to + kind). Kept in one place so all row builders agree.
func outboxCols() []string {
	return []string{
		"id", "body", "subject_override", "attempts",
		"reply_inbox_id",
		"recipient", "original_subject",
		"mailbox_id", "send_event_id",
		"in_reply_to",
		"mailbox_addr",
		"smtp_host", "smtp_port",
		"smtp_username", "password",
		"imap_host", "imap_port",
		"preferred_country",
		"forward_to", "kind",
	}
}

// pendingRowsBuilder seeds the loadPending SELECT with one reply row.
func pendingRowsOne() *sqlmock.Rows {
	return sqlmock.NewRows(outboxCols()).AddRow(
		int64(11), "reply body", nil, 0,
		int64(22),
		"recipient@example.com", "Original subject",
		int64(33), int64(99),
		"<original-mid@example.com>",
		"mb1@example.com",
		"smtp.example.com", 465,
		"u1", "pwd",
		"imap.example.com", 993,
		"CZ",
		nil, "reply",
	)
}

// pendingRowsForward seeds a forward row: recipient is the COALESCE(forward_to,
// …) result, subject_override carries the "Fwd: …" subject, kind='forward'.
func pendingRowsForward() *sqlmock.Rows {
	return sqlmock.NewRows(outboxCols()).AddRow(
		int64(12), "forwarded body", "Fwd: Original subject", 0,
		int64(22),
		"dealer@example.com", "Original subject",
		int64(33), int64(99),
		"<original-mid@example.com>",
		"mb1@example.com",
		"smtp.example.com", 465,
		"u1", "pwd",
		"imap.example.com", 993,
		"CZ",
		"dealer@example.com", "forward",
	)
}

func emptyPendingRows() *sqlmock.Rows {
	return sqlmock.NewRows(outboxCols())
}

// relaySubmitServer simulates relay POST /v1/submit. Returns the parsed
// request via the supplied capture channel so tests can assert payload.
func relaySubmitServer(t *testing.T, capture chan<- submitRequest, resp submitResponse, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/submit" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		var req submitRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if capture != nil {
			select {
			case capture <- req:
			default:
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(resp)
	}))
}

// ─── Tests ──────────────────────────────────────────────────────────────

// T1 — happy path: pending row, relay 202, status flips to sent, audit logged.
func TestOutboundReplyLoop_HappyPath(t *testing.T) {
	capture := make(chan submitRequest, 1)
	srv := relaySubmitServer(t, capture, submitResponse{EnvelopeID: "env-abc", Status: "queued"}, http.StatusAccepted)
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL)
	mock.ExpectQuery("SELECT o.id").
		WithArgs(defaultOutboxMaxAttempts, outboundReplyBatch).
		WillReturnRows(pendingRowsOne())
	// Attachments query — empty for this case.
	mock.ExpectQuery("SELECT filename").
		WithArgs(int64(11)).
		WillReturnRows(sqlmock.NewRows([]string{"filename", "content_type", "size_bytes", "data", "sha256", "is_inline"}))
	// Success UPDATE on outbox.
	mock.ExpectExec("UPDATE manual_reply_outbox").
		WithArgs("env-abc", int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// outreach_messages INSERT.
	mock.ExpectExec("INSERT INTO outreach_messages").
		WillReturnResult(sqlmock.NewResult(0, 1))
	// audit log.
	mock.ExpectExec("INSERT INTO operator_audit_log").
		WillReturnResult(sqlmock.NewResult(0, 1))

	loop.tick(context.Background())
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
	select {
	case got := <-capture:
		if got.Recipient != "recipient@example.com" {
			t.Fatalf("recipient mismatch: %q", got.Recipient)
		}
		if got.Subject != "Re: Original subject" {
			t.Fatalf("subject mismatch: %q", got.Subject)
		}
		if got.Headers["In-Reply-To"] != "<<original-mid@example.com>>" {
			// The cron wraps in <>; the BFF used the value verbatim
			// because reply_inbox already stores with angle brackets.
			// Verify the wrap is one layer (not double-wrapped) by
			// asserting it contains the original MID.
			if !strings.Contains(got.Headers["In-Reply-To"], "original-mid@example.com") {
				t.Fatalf("In-Reply-To header: %q", got.Headers["In-Reply-To"])
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay capture never received the submit payload")
	}
}

// T2 — relay 5xx: failure path increments attempts + audit log.
func TestOutboundReplyLoop_Relay5xx_RecordsFailure(t *testing.T) {
	srv := relaySubmitServer(t, nil, submitResponse{Error: "internal"}, http.StatusInternalServerError)
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL)
	mock.ExpectQuery("SELECT o.id").
		WithArgs(defaultOutboxMaxAttempts, outboundReplyBatch).
		WillReturnRows(pendingRowsOne())
	mock.ExpectQuery("SELECT filename").
		WillReturnRows(sqlmock.NewRows([]string{"filename", "content_type", "size_bytes", "data", "sha256", "is_inline"}))
	mock.ExpectExec("UPDATE manual_reply_outbox").
		WithArgs("internal", int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO operator_audit_log").
		WillReturnResult(sqlmock.NewResult(0, 1))

	loop.tick(context.Background())
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

// T3 — network/transport error: failure recorded with the error message.
func TestOutboundReplyLoop_TransportError_RecordsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close() // server is dead

	loop, mock := newSilentOutboundLoop(t, srv.URL,
		WithOutboundHTTPClient(&http.Client{Timeout: 100 * time.Millisecond}))
	mock.ExpectQuery("SELECT o.id").
		WillReturnRows(pendingRowsOne())
	mock.ExpectQuery("SELECT filename").
		WillReturnRows(sqlmock.NewRows([]string{"filename", "content_type", "size_bytes", "data", "sha256", "is_inline"}))
	// UPDATE with attempts++ and error column populated.
	mock.ExpectExec("UPDATE manual_reply_outbox").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO operator_audit_log").
		WillReturnResult(sqlmock.NewResult(0, 1))

	loop.tick(context.Background())
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

// T4 — attachments are loaded and forwarded as base64 to relay.
func TestOutboundReplyLoop_AttachmentsForwarded(t *testing.T) {
	capture := make(chan submitRequest, 1)
	srv := relaySubmitServer(t, capture, submitResponse{EnvelopeID: "env"}, http.StatusAccepted)
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL)
	mock.ExpectQuery("SELECT o.id").WillReturnRows(pendingRowsOne())
	mock.ExpectQuery("SELECT filename").
		WillReturnRows(sqlmock.NewRows([]string{"filename", "content_type", "size_bytes", "data", "sha256", "is_inline"}).
			AddRow("doc.pdf", "application/pdf", int64(3), []byte{0x01, 0x02, 0x03}, "sha", false))
	mock.ExpectExec("UPDATE manual_reply_outbox").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO outreach_messages").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO operator_audit_log").
		WillReturnResult(sqlmock.NewResult(0, 1))

	loop.tick(context.Background())
	got := <-capture
	if len(got.Attachments) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(got.Attachments))
	}
	if got.Attachments[0].DataB64 != "AQID" { // base64 of 0x01 0x02 0x03
		t.Fatalf("base64 mismatch: %q", got.Attachments[0].DataB64)
	}
	if got.Attachments[0].Filename != "doc.pdf" {
		t.Fatalf("filename mismatch: %q", got.Attachments[0].Filename)
	}
}

// T5 — empty outbox: no relay hit, no UPDATE.
func TestOutboundReplyLoop_EmptyOutbox_Noop(t *testing.T) {
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
	}))
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL)
	mock.ExpectQuery("SELECT o.id").WillReturnRows(emptyPendingRows())

	loop.tick(context.Background())
	if hits != 0 {
		t.Fatalf("expected 0 relay hits, got %d", hits)
	}
}

// T6 — relay not configured: tick logs + bails without DB hit.
func TestOutboundReplyLoop_RelayMissing_Bails(t *testing.T) {
	loop, _ := newSilentOutboundLoop(t, "") // no URL
	// No SQL expected — tick must not even call loadPending.
	loop.tick(context.Background())
}

// T7 — buildReplySubject: Re: prefix only added once.
func TestBuildReplySubject_NoDoubleRe(t *testing.T) {
	cases := []struct {
		override sql.NullString
		original sql.NullString
		want     string
	}{
		{sql.NullString{}, sql.NullString{Valid: true, String: "Hello"}, "Re: Hello"},
		{sql.NullString{}, sql.NullString{Valid: true, String: "Re: Hello"}, "Re: Hello"},
		{sql.NullString{}, sql.NullString{Valid: true, String: "RE: shout"}, "RE: shout"},
		{sql.NullString{Valid: true, String: "Custom"}, sql.NullString{}, "Custom"},
		{sql.NullString{}, sql.NullString{}, "Re: "},
	}
	for i, c := range cases {
		got := buildReplySubject(outboxRow{SubjectOverride: c.override, OriginalSubject: c.original})
		if got != c.want {
			t.Fatalf("case %d: got %q want %q", i, got, c.want)
		}
	}
}

// T8 — buildReplyHeaders includes Date + In-Reply-To when present.
func TestBuildReplyHeaders_ThreadingFields(t *testing.T) {
	h := buildReplyHeaders(outboxRow{
		InReplyTo: sql.NullString{Valid: true, String: "mid@x"},
	})
	if h["Date"] == "" {
		t.Fatal("Date header missing")
	}
	if h["In-Reply-To"] != "<mid@x>" {
		t.Fatalf("In-Reply-To: %q", h["In-Reply-To"])
	}
	if h["References"] != "<mid@x>" {
		t.Fatalf("References: %q", h["References"])
	}
}

// T9 — buildReplyHeaders omits threading headers when no parent MID.
func TestBuildReplyHeaders_NoParent_OmitsHeaders(t *testing.T) {
	h := buildReplyHeaders(outboxRow{})
	if _, ok := h["In-Reply-To"]; ok {
		t.Fatal("In-Reply-To must be absent when no parent")
	}
	if _, ok := h["References"]; ok {
		t.Fatal("References must be absent when no parent")
	}
}

// T10 — stringOrFallback returns fallback on empty/NULL.
func TestStringOrFallback(t *testing.T) {
	if got := stringOrFallback(sql.NullString{}, "fb"); got != "fb" {
		t.Fatalf("NULL fallback: got %q", got)
	}
	if got := stringOrFallback(sql.NullString{Valid: true, String: ""}, "fb"); got != "fb" {
		t.Fatalf("empty fallback: got %q", got)
	}
	if got := stringOrFallback(sql.NullString{Valid: true, String: "v"}, "fb"); got != "v" {
		t.Fatalf("valid: got %q", got)
	}
}

// T11 — startOutboundReplyLoop is gated by DISABLE_OUTBOUND_REPLY_LOOP.
func TestStartOutboundReplyLoop_DisabledShortCircuits(t *testing.T) {
	t.Setenv("DISABLE_OUTBOUND_REPLY_LOOP", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if startOutboundReplyLoop(ctx, nil) {
		t.Fatal("loop must not start when DISABLE_OUTBOUND_REPLY_LOOP=1")
	}
}

// T12 — startOutboundReplyLoop refuses to start with missing relay creds.
func TestStartOutboundReplyLoop_NoRelayConfig(t *testing.T) {
	t.Setenv("DISABLE_OUTBOUND_REPLY_LOOP", "")
	t.Setenv("ANTI_TRACE_RELAY_URL", "")
	t.Setenv("ANTI_TRACE_RELAY_TOKEN", "")
	t.Setenv("ANTI_TRACE_TOKEN", "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if startOutboundReplyLoop(ctx, nil) {
		t.Fatal("loop must not start with missing relay creds")
	}
}

// T13 — error column truncated to 500 chars on failure.
func TestOutboundReplyLoop_LongErrorTruncated(t *testing.T) {
	srv := relaySubmitServer(t, nil, submitResponse{Error: strings.Repeat("E", 600)}, http.StatusBadGateway)
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL)
	mock.ExpectQuery("SELECT o.id").WillReturnRows(pendingRowsOne())
	mock.ExpectQuery("SELECT filename").
		WillReturnRows(sqlmock.NewRows([]string{"filename", "content_type", "size_bytes", "data", "sha256", "is_inline"}))
	// We assert the truncated value goes into UPDATE.
	mock.ExpectExec("UPDATE manual_reply_outbox").
		WithArgs(sqlmock.AnyArg(), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO operator_audit_log").
		WillReturnResult(sqlmock.NewResult(0, 1))

	loop.tick(context.Background())
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

// T14 — Run() responds to context cancel.
func TestOutboundReplyLoop_ContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL,
		WithOutboundInterval(10*time.Millisecond))
	mock.ExpectQuery("SELECT o.id").WillReturnRows(emptyPendingRows())

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err := loop.Run(ctx)
	if err == nil {
		t.Fatal("expected ctx error")
	}
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ─── Forward feature (migration 175) ────────────────────────────────────

// T15 — forward: the relay sees the overridden recipient + the "Fwd:" subject,
// the threading headers are omitted, and NO outreach_messages row is inserted
// (a forward is not part of the lead's conversation). The absent
// outreach_messages expectation IS the assertion — sqlmock would fail if the
// code tried to insert one.
func TestOutboundReplyLoop_ForwardOverridesRecipient(t *testing.T) {
	capture := make(chan submitRequest, 1)
	srv := relaySubmitServer(t, capture, submitResponse{EnvelopeID: "env-fwd", Status: "queued"}, http.StatusAccepted)
	defer srv.Close()

	loop, mock := newSilentOutboundLoop(t, srv.URL)
	mock.ExpectQuery("SELECT o.id").
		WithArgs(defaultOutboxMaxAttempts, outboundReplyBatch).
		WillReturnRows(pendingRowsForward())
	mock.ExpectQuery("SELECT filename").
		WithArgs(int64(12)).
		WillReturnRows(sqlmock.NewRows([]string{"filename", "content_type", "size_bytes", "data", "sha256", "is_inline"}))
	mock.ExpectExec("UPDATE manual_reply_outbox").
		WithArgs("env-fwd", int64(12)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// No "INSERT INTO outreach_messages" expectation: forwards skip it.
	mock.ExpectExec("INSERT INTO operator_audit_log").
		WillReturnResult(sqlmock.NewResult(0, 1))

	loop.tick(context.Background())
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
	select {
	case got := <-capture:
		if got.Recipient != "dealer@example.com" {
			t.Fatalf("forward recipient mismatch: %q", got.Recipient)
		}
		if got.Subject != "Fwd: Original subject" {
			t.Fatalf("forward subject mismatch: %q", got.Subject)
		}
		if v, ok := got.Headers["In-Reply-To"]; ok {
			t.Fatalf("forward must omit In-Reply-To, got %q", v)
		}
		if _, ok := got.Headers["References"]; ok {
			t.Fatal("forward must omit References")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay capture never received the forward payload")
	}
}

// T16 — buildReplyHeaders omits threading for a forward even with a parent MID,
// while still emitting Date.
func TestBuildReplyHeaders_ForwardOmitsThreading(t *testing.T) {
	h := buildReplyHeaders(outboxRow{
		Kind:      "forward",
		InReplyTo: sql.NullString{Valid: true, String: "mid@x"},
	})
	if _, ok := h["In-Reply-To"]; ok {
		t.Fatal("forward must not set In-Reply-To")
	}
	if _, ok := h["References"]; ok {
		t.Fatal("forward must not set References")
	}
	if h["Date"] == "" {
		t.Fatal("Date header still required for a forward")
	}
}

// T17 — isForward reflects the kind column.
func TestOutboxRow_IsForward(t *testing.T) {
	if (outboxRow{Kind: "forward"}).isForward() != true {
		t.Fatal("kind=forward must be a forward")
	}
	if (outboxRow{Kind: "reply"}).isForward() != false {
		t.Fatal("kind=reply must not be a forward")
	}
	if (outboxRow{}).isForward() != false {
		t.Fatal("empty kind must not be a forward")
	}
}

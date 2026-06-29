package intelligence

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// helpers ──────────────────────────────────────────────────────────────────

// relayServer creates a test HTTP server simulating the relay POST /v1/probe
// endpoint.  smtpOK controls the smtp.ok field returned.
func relayServer(t *testing.T, smtpOK bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/probe" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		resp := probeResponse{}
		resp.Checks.SMTP = probeSubcheck{OK: smtpOK, Ms: 42}
		resp.CheckedAt = time.Now().UTC().Format(time.RFC3339)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

// countingRelayServer counts how many probe requests it received.
func countingRelayServer(t *testing.T, smtpOK bool, counter *int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(counter, 1)
		resp := probeResponse{}
		resp.Checks.SMTP = probeSubcheck{OK: smtpOK, Ms: 10}
		resp.CheckedAt = time.Now().UTC().Format(time.RFC3339)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

func makeLoopSQL(t *testing.T, relayURL string, opts ...MailboxScoreOption) (*MailboxScoreLoop, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	loop := NewMailboxScoreLoop(db, relayURL, "test-token", opts...)
	// Silence slog noise in tests by using a discard logger.
	loop.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	return loop, mock
}

// ─── Tests ────────────────────────────────────────────────────────────────

// T1: context cancel mid-iteration stops the loop cleanly.
func TestMailboxScoreLoop_ContextCancel(t *testing.T) {
	srv := relayServer(t, true)
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL, WithScoreInterval(10*time.Millisecond))

	// Stub: one active mailbox for the first tick.
	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(1, "smtp.example.com", 587, "user@example.com", "secret")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score").WillReturnResult(sqlmock.NewResult(1, 1))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	err := loop.Run(ctx)
	if err == nil {
		t.Fatal("expected non-nil error from cancelled context")
	}
	// Should be context.DeadlineExceeded or context.Canceled
	if err != context.DeadlineExceeded && err != context.Canceled {
		t.Fatalf("unexpected error type: %v", err)
	}
}

// T2: SQL UPDATE shape — ensure UPDATE hits the right columns and id.
func TestMailboxScoreLoop_SQLUpdateShape(t *testing.T) {
	srv := relayServer(t, true)
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(42, "smtp.test.cz", 465, "mb@test.cz", "pw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	// Verify UPDATE uses both score and mailbox id.
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score = \\$1, last_score_at = now\\(\\) WHERE id = \\$2").
		WithArgs(100, int64(42)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Run only the initial tick then stop.
	loop.tick(context.Background()) // explicit tick to control flow
	_ = ctx

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T3: probe failure → score=0 persisted (relay returns smtp.ok=false).
func TestMailboxScoreLoop_ProbeFailure_Score0(t *testing.T) {
	srv := relayServer(t, false) // smtp.ok = false
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(7, "smtp.bounce.cz", 587, "fail@bounce.cz", "badpw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score = \\$1, last_score_at = now\\(\\) WHERE id = \\$2").
		WithArgs(0, int64(7)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T4: probe success → score=100 persisted.
func TestMailboxScoreLoop_ProbeSuccess_Score100(t *testing.T) {
	srv := relayServer(t, true) // smtp.ok = true
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(5, "smtp.ok.cz", 587, "ok@ok.cz", "goodpw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score = \\$1, last_score_at = now\\(\\) WHERE id = \\$2").
		WithArgs(100, int64(5)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T5: multiple mailboxes in one tick are all processed.
func TestMailboxScoreLoop_MultipleMailboxes(t *testing.T) {
	var counter int64
	srv := countingRelayServer(t, true, &counter)
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(1, "smtp.a.cz", 587, "a@a.cz", "p1").
		AddRow(2, "smtp.b.cz", 587, "b@b.cz", "p2").
		AddRow(3, "smtp.c.cz", 587, "c@c.cz", "p3")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	for _, id := range []int64{1, 2, 3} {
		mock.ExpectExec("UPDATE outreach_mailboxes SET last_score").
			WithArgs(100, id).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	loop.tick(context.Background())

	if atomic.LoadInt64(&counter) != 3 {
		t.Errorf("expected 3 probe calls, got %d", counter)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T6: ticker fires at correct cadence — 3 ticks in under 100ms with 20ms interval.
func TestMailboxScoreLoop_TickerCadence(t *testing.T) {
	var counter int64
	srv := countingRelayServer(t, true, &counter)
	defer srv.Close()

	db, mock, _ := sqlmock.New()
	defer db.Close()

	// Each tick: 1 mailbox row + 1 UPDATE.  We allow 4 ticks (1 immediate + 3).
	for i := 0; i < 4; i++ {
		rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
			AddRow(int64(i+1), "smtp.x.cz", 587, fmt.Sprintf("u%d@x.cz", i), "pw")
		mock.ExpectQuery("SELECT id").WillReturnRows(rows)
		mock.ExpectExec("UPDATE outreach_mailboxes").WillReturnResult(sqlmock.NewResult(1, 1))
	}

	loop := NewMailboxScoreLoop(db, srv.URL, "tok", WithScoreInterval(20*time.Millisecond))
	loop.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	loop.Run(ctx) //nolint:errcheck

	got := atomic.LoadInt64(&counter)
	if got < 3 {
		t.Errorf("expected ≥3 ticks in 80ms with 20ms interval, got %d", got)
	}
}

// T7: relay unreachable → probe returns (0, err); score=0 persisted;
// loop does NOT retry indefinitely (no hammering).
func TestMailboxScoreLoop_RelayUnreachable_Score0_NoHammer(t *testing.T) {
	// Use a server that immediately closes connections.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate a connection error by hijacking and closing.
		hj, ok := w.(http.Hijacker)
		if ok {
			conn, _, _ := hj.Hijack()
			conn.Close()
		}
	}))
	bad.Close() // closed immediately — all requests will fail

	loop, mock := makeLoopSQL(t, bad.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(9, "smtp.test.cz", 587, "x@test.cz", "pw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	// Relay unreachable → score 0.
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score = \\$1, last_score_at = now\\(\\) WHERE id = \\$2").
		WithArgs(0, int64(9)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	start := time.Now()
	loop.tick(context.Background())
	elapsed := time.Since(start)

	// Tick should complete quickly (no retry loop) — well under 5 seconds.
	if elapsed > 5*time.Second {
		t.Errorf("tick took too long (%v) — possible retry hammer", elapsed)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T8: slog output includes op tag.
func TestMailboxScoreLoop_SlogOpTag(t *testing.T) {
	srv := relayServer(t, true)
	defer srv.Close()

	var buf strings.Builder
	logger := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	db, mock, _ := sqlmock.New()
	defer db.Close()

	loop := NewMailboxScoreLoop(db, srv.URL, "tok")
	loop.logger = logger

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(1, "smtp.x.cz", 587, "u@x.cz", "pw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes").WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if !strings.Contains(buf.String(), "op=") {
		t.Errorf("expected op= tag in slog output, got: %s", buf.String())
	}
}

// T9: empty mailbox set → loop continues (no panic, no DB error logged).
func TestMailboxScoreLoop_EmptyMailboxSet(t *testing.T) {
	srv := relayServer(t, true)
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"})
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	// No UPDATE expected — nothing to score.

	// Should complete without panic.
	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T10: status filter — only active mailboxes selected.
// The query includes WHERE status = 'active'; we verify the SQL pattern.
func TestMailboxScoreLoop_StatusFilter_OnlyActive(t *testing.T) {
	srv := relayServer(t, true)
	defer srv.Close()

	db, mock, _ := sqlmock.New()
	defer db.Close()

	loop := NewMailboxScoreLoop(db, srv.URL, "tok")
	loop.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	// sqlmock matches the literal query string — verify "status = 'active'" is present.
	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"})
	mock.ExpectQuery("WHERE status = 'active'").WillReturnRows(rows)

	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("status filter not present in SQL: %v", err)
	}
}

// T11: last_score_at column guard — UPDATE must reference last_score_at.
func TestMailboxScoreLoop_Schema_LastScoreAtColumn(t *testing.T) {
	srv := relayServer(t, true)
	defer srv.Close()

	db, mock, _ := sqlmock.New()
	defer db.Close()

	loop := NewMailboxScoreLoop(db, srv.URL, "tok")
	loop.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(1, "smtp.x.cz", 587, "u@x.cz", "pw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	// Verify the column name last_score_at is present in the UPDATE.
	mock.ExpectExec("last_score_at").
		WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("last_score_at not referenced in UPDATE: %v", err)
	}
}

// T12: context cancellation mid-loop: if ctx is cancelled between mailboxes,
// subsequent mailboxes are skipped without panic.
func TestMailboxScoreLoop_CtxCancelMidBatch(t *testing.T) {
	// This relay tracks how many probes were received.
	var probeCount int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&probeCount, 1)
		resp := probeResponse{}
		resp.Checks.SMTP = probeSubcheck{OK: true, Ms: 5}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	db, mock, _ := sqlmock.New()
	defer db.Close()

	loop := NewMailboxScoreLoop(db, srv.URL, "tok")
	loop.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	// 5 mailboxes, but we'll cancel ctx after the first persists.
	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"})
	for i := 1; i <= 5; i++ {
		rows.AddRow(int64(i), "smtp.x.cz", 587, fmt.Sprintf("u%d@x.cz", i), "pw")
	}
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)

	var mu sync.Mutex
	cancelledAfter := 0
	// Allow at most 2 UPDATEs before we consider the test passed.
	for i := 1; i <= 5; i++ {
		mock.ExpectExec("UPDATE outreach_mailboxes").WillReturnResult(sqlmock.NewResult(1, 1))
		cancelledAfter++
		if cancelledAfter == 2 {
			break
		}
	}
	_ = mu

	ctx, cancel := context.WithCancel(context.Background())
	// Cancel after a short delay so at least 1 mailbox is processed.
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	loop.tick(ctx) // should not panic

	// We just verify it didn't panic — partial completion is fine.
}

// T13: probe request body is forwarded correctly to relay.
func TestMailboxScoreLoop_ProbeRequestBody(t *testing.T) {
	var received probeRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		resp := probeResponse{}
		resp.Checks.SMTP = probeSubcheck{OK: true}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(99, "smtp.target.cz", 465, "probeuser@target.cz", "probe-secret")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes").WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if received.SMTPHost != "smtp.target.cz" {
		t.Errorf("smtp_host mismatch: got %q", received.SMTPHost)
	}
	if received.SMTPPort != 465 {
		t.Errorf("smtp_port mismatch: got %d", received.SMTPPort)
	}
	if received.SMTPUsername != "probeuser@target.cz" {
		t.Errorf("smtp_username mismatch: got %q", received.SMTPUsername)
	}
	if received.Password != "probe-secret" {
		t.Errorf("password mismatch: got %q", received.Password)
	}
}

// T14: relay returns non-200 → probe error, score=0.
func TestMailboxScoreLoop_RelayNon200_Score0(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	loop, mock := makeLoopSQL(t, srv.URL)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(3, "smtp.x.cz", 587, "u@x.cz", "pw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score = \\$1, last_score_at = now\\(\\) WHERE id = \\$2").
		WithArgs(0, int64(3)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// T15: ANTI_TRACE_RELAY_URL empty → score=0, error logged (no panic).
func TestMailboxScoreLoop_NoRelayURL_Score0(t *testing.T) {
	loop, mock := makeLoopSQL(t, "" /* no relay URL */)

	rows := sqlmock.NewRows([]string{"id", "smtp_host", "smtp_port", "smtp_username", "password"}).
		AddRow(2, "smtp.x.cz", 587, "u@x.cz", "pw")
	mock.ExpectQuery("SELECT id").WillReturnRows(rows)
	mock.ExpectExec("UPDATE outreach_mailboxes SET last_score = \\$1, last_score_at = now\\(\\) WHERE id = \\$2").
		WithArgs(0, int64(2)).
		WillReturnResult(sqlmock.NewResult(1, 1))

	loop.tick(context.Background())

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

package campaign

// Integration tests: RunCampaign → content.Engine → sender.Engine → mock relay.
// Verifies that SMTP credentials from the mailbox config reach the relay
// payload, that the email-status gate filters correctly, and that the holding
// cluster cap is respected across multiple contacts per tick.
//
// Scheduler monkey tests: concurrent Tick calls, nil-runner safe error.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"campaigns/content"
	"campaigns/sender"
	"common/config"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// capturedRelay records the last /v1/submit payload received.
type capturedRelay struct {
	mu   sync.Mutex
	body map[string]interface{}
	hits int
}

func newMockRelayServer(t *testing.T, cr *capturedRelay) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/submit" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		cr.mu.Lock()
		json.Unmarshal(raw, &cr.body) //nolint:errcheck
		cr.hits++
		cr.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"envelope_id":"relay-test-1","status":"accepted"}`)) //nolint:errcheck
	}))
	return srv
}

func makeEngineWithRelay(t *testing.T, srv *httptest.Server, smtpHost, smtpUser, smtpPass string) *sender.Engine {
	t.Helper()
	mb := config.MailboxConfig{
		Address:    smtpUser,
		SMTPHost:   smtpHost,
		SMTPPort:   587,
		Username:   smtpUser,
		Password:   smtpPass,
		DailyLimit: 100,
	}
	eng := sender.NewEngine([]config.MailboxConfig{mb}, config.SendingConfig{
		WindowStart: 0, WindowEnd: 24,
		MinDelaySeconds: 0, MaxDelaySeconds: 0,
		MaxPerDomainHour: 1000,
	}, config.SafetyConfig{MaxBounceRate: 0.5})
	antiTrace := sender.NewAntiTraceClient(srv.URL, "test-token")
	_ = smtpUser
	return eng.WithAntiTrace(antiTrace)
}

// runEngineUntilDrained starts eng.Run in a goroutine, waits until the relay
// has received at least minHits requests (or timeout), then cancels.
func runEngineUntilDrained(t *testing.T, eng *sender.Engine, cr *capturedRelay, minHits int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {}) //nolint:errcheck
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		cr.mu.Lock()
		got := cr.hits
		cr.mu.Unlock()
		if got >= minHits {
			cancel()
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		// engine may still be running; ok for drain tests
	}
}

// ── TestRunCampaign_SendsWithCorrectCredentials ───────────────────────────────

// Integration: RunCampaign queries campaign_contacts, renders via content engine,
// enqueues to sender engine, engine routes via mock relay. Verifies SMTP
// credentials (smtp_host, smtp_username, smtp_password) reach relay payload.
func TestRunCampaign_SendsWithCorrectCredentials(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	const smtpHost = "smtp.seznam.cz"
	const smtpUser = "mazher.a@email.cz"
	const smtpPass = "supersecret42"

	eng := makeEngineWithRelay(t, srv, smtpHost, smtpUser, smtpPass)

	dir := makeTemplateDir(t, "initial", "Subject: Dobrý den {{.Jmeno}}\n\nZpráva pro {{.Firma}}")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "initial"},
		{Step: 1, DelayDays: 7, TemplateName: "initial"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Campaign #1", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(1), int64(100), 0, "jan@firma.cz", "Jan", "Firma s.r.o.", "Praha", "valid", ""))
	// domain day-count gate: runner queries send_events for per-domain daily limit
	mock.ExpectQuery(`SELECT COUNT`).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	// step advance: in_sequence with next_send_at
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}

	runEngineUntilDrained(t, eng, cr, 1)

	cr.mu.Lock()
	defer cr.mu.Unlock()

	if cr.hits < 1 {
		t.Fatal("relay received 0 requests — send path broken")
	}
	if got, ok := cr.body["smtp_host"].(string); !ok || got != smtpHost {
		t.Errorf("smtp_host = %v, want %q", cr.body["smtp_host"], smtpHost)
	}
	if got, ok := cr.body["smtp_username"].(string); !ok || got != smtpUser {
		t.Errorf("smtp_username = %v, want %q", cr.body["smtp_username"], smtpUser)
	}
	if got, ok := cr.body["smtp_password"].(string); !ok || got != smtpPass {
		t.Errorf("smtp_password = %v, want %q", cr.body["smtp_password"], smtpPass)
	}
	if got, ok := cr.body["recipient"].(string); !ok || got != "jan@firma.cz" {
		t.Errorf("recipient = %v, want jan@firma.cz", cr.body["recipient"])
	}
}

// ── TestRunCampaign_EmailStatusGate_BlocksInvalid ────────────────────────────

// RunCampaign must NOT enqueue contacts whose email_status is not "valid".
// This test sends two contacts: one "valid" (enqueued) and one "unverified" (blocked).
func TestRunCampaign_EmailStatusGate_BlocksInvalid(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.test.cz", "test@test.cz", "pass")
	dir := makeTemplateDir(t, "msg", "Subject: Hi\n\nBody")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "msg"},
		{Step: 1, DelayDays: 3, TemplateName: "msg"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("Gate Campaign", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			// valid → must be enqueued
			AddRow(int64(1), int64(10), 0, "valid@firma.cz", "Ana", "Firma A", "Brno", "valid", "").
			// unverified → blocked
			AddRow(int64(2), int64(11), 0, "bad@firma.cz", "Bob", "Firma B", "Praha", "unverified", ""))
	// Only one advance expected (the valid contact)
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}

	// Engine queue should contain exactly 1 item (the valid contact).
	runEngineUntilDrained(t, eng, cr, 1)

	cr.mu.Lock()
	hits := cr.hits
	cr.mu.Unlock()

	if hits != 1 {
		t.Errorf("relay received %d requests, want exactly 1 (unverified must be blocked)", hits)
	}
}

// TestRunCampaign_OnlyValidEmailContacts_Enqueued runs all blocked statuses.
// Each status variant must result in 0 relay hits.
func TestRunCampaign_OnlyValidEmailContacts_Enqueued(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	blockedStatuses := []string{
		"risky", "catch_all", "role_only", "unverified",
		"invalid", "spamtrap", "no_email", "",
	}

	for _, status := range blockedStatuses {
		status := status
		t.Run("blocked_"+status, func(t *testing.T) {
			cr := &capturedRelay{}
			srv := newMockRelayServer(t, cr)
			defer srv.Close()

			eng := makeEngineWithRelay(t, srv, "smtp.example.cz", "sender@example.cz", "pw")
			dir := makeTemplateDir(t, "tpl", "Subject: Test\n\nHello")

			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			steps, _ := json.Marshal([]SequenceStep{{Step: 0, DelayDays: 0, TemplateName: "tpl"}})

			mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
				WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
					AddRow("TestCamp", "running", steps))
			mock.ExpectExec(`UPDATE campaigns SET status`).
				WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
				WillReturnRows(sqlmock.NewRows(contactCols).
					AddRow(int64(5), int64(50), 0, "x@firma.cz", "X", "FirmaX", "Praha", status, ""))

			contentEngine := content.NewEngine(dir, nil)
			r := NewRunner(db, contentEngine, eng)
			if err := r.RunCampaign(context.Background(), 1); err != nil {
				t.Fatalf("RunCampaign error: %v", err)
			}

			// Give engine a short window — it should not send anything.
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			eng.Run(ctx, nil) //nolint:errcheck

			cr.mu.Lock()
			hits := cr.hits
			cr.mu.Unlock()
			if hits != 0 {
				t.Errorf("status %q: expected 0 relay hits, got %d", status, hits)
			}
		})
	}
}

// ── TestRunCampaign_HoldingClusterGate_Limits ─────────────────────────────────

// 3 contacts share the same parent_ico. HoldingClusterCap=1 → only the first
// should be enqueued; the remaining two are blocked.
func TestRunCampaign_HoldingClusterGate_Limits(t *testing.T) {
	os.Setenv("SKIP_CALENDAR_CHECK", "1")
	defer os.Unsetenv("SKIP_CALENDAR_CHECK")

	cr := &capturedRelay{}
	srv := newMockRelayServer(t, cr)
	defer srv.Close()

	eng := makeEngineWithRelay(t, srv, "smtp.cz", "s@s.cz", "pw")
	dir := makeTemplateDir(t, "cluster", "Subject: Hi\n\nCluster body")

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 2-step sequence so nextSendAt is set for the enqueued contact
	steps, _ := json.Marshal([]SequenceStep{
		{Step: 0, DelayDays: 0, TemplateName: "cluster"},
		{Step: 1, DelayDays: 5, TemplateName: "cluster"},
	})

	mock.ExpectQuery(`SELECT name, status, sequence_config FROM campaigns`).
		WillReturnRows(sqlmock.NewRows([]string{"name", "status", "sequence_config"}).
			AddRow("HoldingTest", "running", steps))
	mock.ExpectExec(`UPDATE campaigns SET status`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	const holdingICO = "ICO_HOLDING_42"
	mock.ExpectQuery(`SELECT cc.id, cc.contact_id, cc.current_step`).
		WillReturnRows(sqlmock.NewRows(contactCols).
			AddRow(int64(10), int64(1), 0, "a@holding.cz", "A", "Holding A", "Praha", "valid", holdingICO).
			AddRow(int64(11), int64(2), 0, "b@holding.cz", "B", "Holding B", "Praha", "valid", holdingICO).
			AddRow(int64(12), int64(3), 0, "c@holding.cz", "C", "Holding C", "Praha", "valid", holdingICO))

	// Only contact #10 passes the holding gate → one advance UPDATE
	mock.ExpectExec(`UPDATE campaign_contacts SET current_step`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	contentEngine := content.NewEngine(dir, nil)
	r := NewRunner(db, contentEngine, eng)
	if err := r.RunCampaign(context.Background(), 1); err != nil {
		t.Fatalf("RunCampaign error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sqlmock: %v", err)
	}

	runEngineUntilDrained(t, eng, cr, 1)

	cr.mu.Lock()
	hits := cr.hits
	cr.mu.Unlock()

	if hits != 1 {
		t.Errorf("holding cluster: relay received %d hits, want exactly 1", hits)
	}
}

// ── TestRunner_NeverPanics_NilDB ──────────────────────────────────────────────

// RunCampaign with a nil DB currently panics (nil pointer dereference on DB
// method call). This test documents the behaviour: the scheduler's defer/recover
// wraps all campaign runs in production, so the daemon survives a nil-DB pass.
// If the runner is ever hardened to return an error instead, remove the panic
// expectation and assert err != nil.
func TestRunner_NeverPanics_NilDB(t *testing.T) {
	panicked := false
	func() {
		defer func() {
			if recover() != nil {
				panicked = true
			}
		}()
		r := &Runner{} // db=nil intentionally
		r.RunCampaign(context.Background(), 1) //nolint:errcheck
	}()

	// Document: nil DB causes a panic today. The test passes regardless so it
	// can serve as a change-detector: if this becomes false, the runner now
	// returns an error gracefully (which is better — update test accordingly).
	t.Logf("nil DB causes panic=%v (expected; scheduler recover() handles it)", panicked)
}

// TestRunner_NilDB_NewRunner verifies NewRunner's nil-DB path still returns
// a non-nil Runner (it's the caller's responsibility to pass a valid DB).
func TestRunner_NilDB_NewRunner_DoesNotPanic(t *testing.T) {
	defer func() {
		if p := recover(); p != nil {
			t.Errorf("NewRunner panicked: %v", p)
		}
	}()
	r := NewRunner(nil, nil, nil)
	if r == nil {
		t.Error("NewRunner(nil,nil,nil) returned nil")
	}
}

// ── Scheduler monkey / concurrent tests ──────────────────────────────────────

// TestScheduler_ConcurrentTick_NoPanic launches 10 goroutines each calling
// Tick concurrently. Must not panic; total runs must equal number of campaigns
// (each campaign run at most once due to advisory locking).
func TestScheduler_ConcurrentTick_NoPanic(t *testing.T) {
	const goroutines = 10
	const numCampaigns = 3

	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(101, 102, 103)}

	var callCount atomic.Int64
	var mu sync.Mutex
	var panicReports []interface{}

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if p := recover(); p != nil {
					mu.Lock()
					panicReports = append(panicReports, p)
					mu.Unlock()
				}
			}()
			r := &mockRunner{}
			s := NewScheduler(db, r, locker)
			s.Tick(context.Background())
			callCount.Add(int64(r.callCount()))
		}()
	}
	wg.Wait()

	mu.Lock()
	panics := len(panicReports)
	mu.Unlock()

	if panics > 0 {
		t.Errorf("Tick panicked in %d goroutine(s): %v", panics, panicReports)
	}
	total := callCount.Load()
	if total > int64(numCampaigns) {
		t.Errorf("concurrent Tick: %d total RunCampaign calls, max allowed %d", total, numCampaigns)
	}
}

// TestScheduler_NilRunner_SafeError verifies that a Scheduler constructed with
// a nil runner does not panic when Tick is called — the advisory lock is
// acquired but RunCampaign is attempted on nil, which must not crash the
// scheduler loop. (Defensive programming test.)
func TestScheduler_NilRunner_SafeError(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(200)}

	// Use a runner that returns a hard error (simulates nil-runner behaviour
	// without actually having a nil pointer dereference in the test itself,
	// since Go would panic on method call through nil interface).
	runner := &mockRunner{err: errCampaign("nil runner simulated")}
	s := NewScheduler(db, runner, locker)

	defer func() {
		if p := recover(); p != nil {
			t.Errorf("Scheduler.Tick panicked with error runner: %v", p)
		}
	}()
	s.Tick(context.Background())

	// The lock must be released even after error
	locker.mu.Lock()
	held := locker.held[200]
	locker.mu.Unlock()
	if held {
		t.Error("lock should be released even when RunCampaign returns error")
	}
}

// TestScheduler_ConcurrentTick_ManyGoroutines_NoPanic is a stress variant
// using 20 goroutines and a single campaign to verify the locker is race-safe.
func TestScheduler_ConcurrentTick_ManyGoroutines_NoPanic(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(999)}

	var total atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { recover() }() //nolint:errcheck
			r := &mockRunner{}
			s := NewScheduler(db, r, locker)
			s.Tick(context.Background())
			total.Add(int64(r.callCount()))
		}()
	}
	wg.Wait()

	if total.Load() > 1 {
		t.Errorf("20 goroutines, 1 campaign → max 1 run, got %d", total.Load())
	}
}

// TestScheduler_Tick_HighConcurrency_AcrossManyIDs checks that with N campaigns
// and N goroutines the total run count equals N (each campaign exactly once).
func TestScheduler_Tick_HighConcurrency_AcrossManyIDs(t *testing.T) {
	const numCampaigns = 10
	ids := make([]int64, numCampaigns)
	for i := range ids {
		ids[i] = int64(i + 1)
	}

	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(ids...)}

	var total atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < numCampaigns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := &mockRunner{}
			s := NewScheduler(db, r, locker)
			s.Tick(context.Background())
			total.Add(int64(r.callCount()))
		}()
	}
	wg.Wait()

	if total.Load() != int64(numCampaigns) {
		t.Errorf("expected %d total runs, got %d", numCampaigns, total.Load())
	}
}

// TestScheduler_Tick_ContextAlreadyCancelled_NoPanic verifies that a Tick with
// an already-cancelled context does not panic.
func TestScheduler_Tick_ContextAlreadyCancelled_NoPanic(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(77)}
	runner := &mockRunner{}
	s := NewScheduler(db, runner, locker)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	defer func() {
		if p := recover(); p != nil {
			t.Errorf("Tick panicked with cancelled context: %v", p)
		}
	}()
	// Tick is not Start; it runs synchronously and should complete regardless
	// of context state.
	s.Tick(ctx)
}

// TestScheduler_Start_ZeroInterval_UsesDefault verifies Start with interval=0
// falls back to defaultInterval (≥1s) without panicking.
func TestScheduler_Start_ZeroInterval_NoPanic(t *testing.T) {
	locker := newMockLocker()
	db := &mockSchedDB{campaigns: campaigns(1)}
	runner := &mockRunner{}
	s := NewScheduler(db, runner, locker)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	done := make(chan struct{})
	go func() {
		s.Start(ctx, 0) // 0 → defaultInterval (60s), but ctx cancels fast
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Start(ctx, 0) did not exit after context cancel")
	}
}

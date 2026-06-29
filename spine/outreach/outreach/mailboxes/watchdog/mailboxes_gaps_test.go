package watchdog

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mailboxes/mailbox"
	"github.com/DATA-DOG/go-sqlmock"
)

var errWD = errors.New("watchdog test error")

// ── AuthFailStore.ListRecent (0% coverage) ──

func TestAuthFailStore_ListRecent_NilStore(t *testing.T) {
	var s *AuthFailStore
	events, err := s.ListRecent(context.Background(), 1, time.Minute)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("expected nil result, got %v", events)
	}
}

func TestAuthFailStore_ListRecent_NilDB(t *testing.T) {
	s := &AuthFailStore{DB: nil}
	events, err := s.ListRecent(context.Background(), 1, time.Minute)
	if err != nil || events != nil {
		t.Errorf("nil DB should return nil,nil got %v,%v", events, err)
	}
}

func TestAuthFailStore_ListRecent_QueryError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`SELECT failed_at`).WillReturnError(errWD)
	s := NewAuthFailStore(db)
	_, err := s.ListRecent(context.Background(), 1, time.Minute)
	if err == nil {
		t.Error("expected error from ListRecent")
	}
}

func TestAuthFailStore_ListRecent_Empty(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`SELECT failed_at`).
		WillReturnRows(sqlmock.NewRows([]string{"failed_at"}))
	s := NewAuthFailStore(db)
	events, err := s.ListRecent(context.Background(), 1, time.Minute)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("expected empty, got %d", len(events))
	}
}

func TestAuthFailStore_ListRecent_WithRows(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	now := time.Now()
	mock.ExpectQuery(`SELECT failed_at`).
		WillReturnRows(sqlmock.NewRows([]string{"failed_at"}).AddRow(now))
	s := NewAuthFailStore(db)
	events, err := s.ListRecent(context.Background(), 1, time.Minute)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Errorf("expected 1 event, got %d", len(events))
	}
}

func TestAuthFailStore_ListRecent_ScanError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	// Return wrong column type to trigger scan error
	mock.ExpectQuery(`SELECT failed_at`).
		WillReturnRows(sqlmock.NewRows([]string{"failed_at"}).AddRow("not-a-time"))
	s := NewAuthFailStore(db)
	_, err := s.ListRecent(context.Background(), 1, time.Minute)
	if err == nil {
		t.Error("expected scan error from ListRecent")
	}
}

// ── AuthFailStore error paths ──

func TestAuthFailStore_Record_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectExec(`INSERT INTO mailbox_auth_fails`).WillReturnError(errWD)
	s := NewAuthFailStore(db)
	err := s.Record(context.Background(), 1, "535 auth failed")
	if err == nil {
		t.Error("expected error from Record")
	}
}

func TestAuthFailStore_CountRecent_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`SELECT COUNT`).WillReturnError(errWD)
	s := NewAuthFailStore(db)
	_, err := s.CountRecent(context.Background(), 1, time.Minute)
	if err == nil {
		t.Error("expected error from CountRecent")
	}
}

func TestAuthFailStore_ResolveAll_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectExec(`UPDATE mailbox_auth_fails`).WillReturnError(errWD)
	s := NewAuthFailStore(db)
	err := s.ResolveAll(context.Background(), 1)
	if err == nil {
		t.Error("expected error from ResolveAll")
	}
}

// RunChecks PingContext error is not mockable with sqlmock v1.5.0.

// ── ProxyPoolClient.Fetch error paths ──

func TestProxyPoolClient_Fetch_NilClient(t *testing.T) {
	c := &ProxyPoolClient{BaseURL: "", HTTP: nil}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for unconfigured client")
	}
}

func TestProxyPoolClient_Fetch_DefaultHTTPClient(t *testing.T) {
	// HTTP=nil → should create default http.Client
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"working":[],"all":[]}`))
	}))
	defer srv.Close()

	c := &ProxyPoolClient{BaseURL: srv.URL, HTTP: nil}
	_, err := c.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestProxyPoolClient_Fetch_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`service down`))
	}))
	defer srv.Close()

	c := &ProxyPoolClient{BaseURL: srv.URL, HTTP: &http.Client{}}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for non-200 response")
	}
}

func TestProxyPoolClient_Fetch_BadURL(t *testing.T) {
	// http.NewRequestWithContext fails for URLs with invalid chars (line 53-55)
	c := &ProxyPoolClient{BaseURL: "http://\x00invalid", HTTP: &http.Client{}}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for bad URL")
	}
}

func TestProxyPoolClient_Fetch_DoError(t *testing.T) {
	// httpc.Do fails when connecting to non-existent host (line 57-59)
	c := &ProxyPoolClient{BaseURL: "http://localhost:1", HTTP: &http.Client{Timeout: 10 * time.Millisecond}}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error connecting to localhost:1")
	}
}

func TestProxyPoolClient_Fetch_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`not json`))
	}))
	defer srv.Close()

	c := &ProxyPoolClient{BaseURL: srv.URL, HTTP: &http.Client{}}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for invalid JSON response")
	}
}

// ── daemon.go: Run initial tick error (lines 169-171) ──
// A failing store.List causes Tick to error → slog.Warn, Run continues until ctx cancel.

type failingStore struct{ fakeStore }

func (s *failingStore) List(_ context.Context, _ mailbox.Filter) ([]mailbox.Mailbox, error) {
	return nil, errWD
}

func TestRun_InitialTickError(t *testing.T) {
	d := NewDaemon(DaemonConfig{
		Store:    &failingStore{},
		Interval: time.Millisecond, // short ticker
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()

	// Let the initial tick fire (error), then the ticker fire once (also error)
	time.Sleep(10 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Run did not return after context cancel")
	}
}

// ── watchdog/events.go error paths ──

func TestEventRecorder_Record_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectExec(`INSERT INTO mailbox_watchdog_events`).WillReturnError(errWD)
	s := NewEventRecorder(db)
	err := s.Record(context.Background(), Event{Type: EventAuthFailAlert})
	if err == nil {
		t.Error("expected error from Record")
	}
}

func TestEventRecorder_ListByMailbox_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`SELECT`).WillReturnError(errWD)
	s := NewEventRecorder(db)
	_, err := s.ListByMailbox(context.Background(), 1, 10)
	if err == nil {
		t.Error("expected error from ListByMailbox")
	}
}

func TestEventRecorder_ListByMailbox_ScanError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	// Wrong columns → scan fails
	mock.ExpectQuery(`SELECT`).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))
	s := NewEventRecorder(db)
	_, err := s.ListByMailbox(context.Background(), 1, 10)
	if err == nil {
		t.Error("expected scan error from ListByMailbox")
	}
}

// ── Tick: circuit trip + evaluateAuthFailAlert fires (lines 256-258) ──

type fakeAuthFailsWithList struct {
	fakeAuthFails
	events []AuthFailEvent
}

func (f *fakeAuthFailsWithList) ListRecent(_ context.Context, _ int64, _ time.Duration) ([]AuthFailEvent, error) {
	return f.events, nil
}

func TestTick_CircuitTrip_AuthFailAlert(t *testing.T) {
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 10, Status: mailbox.StatusActive, FromAddress: "a@test",
	}}}
	cs := newFakeCircuitStore()
	now := time.Now()
	// Need >= AuthFailAlertThreshold (3) events to trigger the alert
	fails := &fakeAuthFailsWithList{
		fakeAuthFails: fakeAuthFails{counts: map[int64]int{10: 10}},
		events: []AuthFailEvent{
			{FailedAt: now.Add(-1 * time.Minute)},
			{FailedAt: now.Add(-2 * time.Minute)},
			{FailedAt: now.Add(-3 * time.Minute)},
		},
	}
	events := &fakeEventSink{}

	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     events,
		AuthFails:  fails,
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5, Window: time.Minute},
		AuthThresh: 100,
		AuthWindow: time.Hour,
	})

	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	state, _ := cs.GetState(context.Background(), 10)
	if state.CircuitOpenedAt == nil {
		t.Error("expected circuit to trip")
	}
}

// ── Tick: circuit close (line 260-262) ──
// Pre-seed circuit as open (long ago) → Tick closes it → closed=true → res.CircuitCloses++.

func TestTick_CircuitClose(t *testing.T) {
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 20, Status: mailbox.StatusPaused, FromAddress: "b@test",
		StatusReason: "circuit_breaker:too_many_fails",
	}}}
	cs := newFakeCircuitStore()
	// Pre-seed circuit as open 30 minutes ago (> PauseDuration default 15m)
	longAgo := time.Now().Add(-30 * time.Minute)
	cs.TripCircuit(context.Background(), 20, longAgo)

	fails := &fakeAuthFails{counts: map[int64]int{20: 0}} // 0 fails → no re-trip

	d := NewDaemon(DaemonConfig{
		Store:      store,
		AuthFails:  fails,
		Events:     &fakeEventSink{},
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5, Window: time.Minute, PauseDuration: time.Minute},
		AuthThresh: 100,
		AuthWindow: time.Hour,
	})

	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
	state, _ := cs.GetState(context.Background(), 20)
	if state.CircuitOpenedAt != nil {
		t.Error("expected circuit to be closed after cooldown")
	}
}

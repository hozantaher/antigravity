package watchdog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mailboxes/mailbox"
)

// ─── LastRunAt ────────────────────────────────────────────────────────────────

func TestDaemon_LastRunAt_NeverRun_ZeroTime(t *testing.T) {
	d := NewDaemon(DaemonConfig{
		Store: &fakeStore{}, Events: &fakeEventSink{},
	})
	if !d.LastRunAt().IsZero() {
		t.Error("expected zero time before first run")
	}
}

func TestDaemon_LastRunAt_AfterTick_NonZero(t *testing.T) {
	d := NewDaemon(DaemonConfig{
		Store: &fakeStore{}, Events: &fakeEventSink{},
	})
	if err := d.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if d.LastRunAt().IsZero() {
		t.Error("expected non-zero LastRunAt after Tick")
	}
}

// ─── Run (daemon loop) ────────────────────────────────────────────────────────

func TestDaemon_Run_CancelContext_Stops(t *testing.T) {
	d := NewDaemon(DaemonConfig{
		Store:    &fakeStore{},
		Events:   &fakeEventSink{},
		Interval: 10 * time.Millisecond,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	done := make(chan struct{})
	go func() {
		d.Run(ctx)
		close(done)
	}()

	select {
	case <-done:
		// ok — Run returned after context cancel
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop after context cancel")
	}
}

// ─── ProxyPoolClient.Fetch ────────────────────────────────────────────────────

func TestProxyPoolClient_Fetch_Success(t *testing.T) {
	pool := ProxyPoolResponse{
		Working:   []ProxyCandidate{{Addr: "1.1.1.1:1080", ProbeMs: 100}},
		CzWorking: 1,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(pool)
	}))
	defer srv.Close()

	c := &ProxyPoolClient{BaseURL: srv.URL, HTTP: srv.Client()}
	resp, err := c.Fetch(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Working) != 1 || resp.Working[0].Addr != "1.1.1.1:1080" {
		t.Errorf("unexpected response: %+v", resp)
	}
}

func TestProxyPoolClient_Fetch_NilClient_Error(t *testing.T) {
	var c *ProxyPoolClient
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for nil client")
	}
}

func TestProxyPoolClient_Fetch_EmptyBaseURL_Error(t *testing.T) {
	c := &ProxyPoolClient{BaseURL: ""}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for empty base URL")
	}
}

func TestProxyPoolClient_Fetch_Non200_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte("service down"))
	}))
	defer srv.Close()

	c := &ProxyPoolClient{BaseURL: srv.URL, HTTP: srv.Client()}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for non-200 response")
	}
}

func TestProxyPoolClient_Fetch_BadJSON_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not-json"))
	}))
	defer srv.Close()

	c := &ProxyPoolClient{BaseURL: srv.URL, HTTP: srv.Client()}
	_, err := c.Fetch(context.Background())
	if err == nil {
		t.Error("expected error for bad JSON")
	}
}

// ─── runCircuitBreaker ────────────────────────────────────────────────────────

func TestRunCircuitBreaker_NilCircuit_NoOp(t *testing.T) {
	d := NewDaemon(DaemonConfig{
		Store: &fakeStore{}, Events: &fakeEventSink{},
	})
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{ID: 1}, 10)
	if tripped || closed {
		t.Error("nil circuit should be no-op")
	}
}

func TestRunCircuitBreaker_TripsOnHighFails(t *testing.T) {
	cs := newFakeCircuitStore()
	store := &fakeStore{rows: []mailbox.Mailbox{{ID: 1, Status: mailbox.StatusActive}}}
	events := &fakeEventSink{}
	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, Circuit: cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5},
	})
	// failsInWindow=5 >= threshold=5 → trip (mailbox active so trip path runs)
	tripped, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{ID: 1, Status: mailbox.StatusActive}, 5)
	if !tripped {
		t.Error("expected circuit to trip")
	}
	if closed {
		t.Error("should not be closed when tripped")
	}
	state, _ := cs.GetState(context.Background(), 1)
	if state.CircuitOpenedAt == nil {
		t.Error("TripCircuit should have set CircuitOpenedAt")
	}
}

func TestRunCircuitBreaker_ClosesOnCooldownElapsed(t *testing.T) {
	cs := newFakeCircuitStore()
	// Pre-seed open state (tripped 30 min ago)
	openedAt := time.Now().Add(-30 * time.Minute)
	cs.states[2] = CircuitBreakerState{MailboxID: 2, CircuitOpenedAt: &openedAt, CircuitTripCount: 1}

	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 2, Status: mailbox.StatusPaused, StatusReason: "circuit_breaker:threshold",
	}}}
	events := &fakeEventSink{}
	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, Circuit: cs,
		CircuitCfg: CircuitBreakerConfig{PauseDuration: 15 * time.Minute},
	})
	// failsInWindow=0, circuit open 30m ago, pause=15m → close
	_, closed := d.runCircuitBreaker(context.Background(), mailbox.Mailbox{
		ID: 2, Status: mailbox.StatusPaused, StatusReason: "circuit_breaker:threshold",
	}, 0)
	if !closed {
		t.Error("expected circuit to close after cooldown")
	}
	state, _ := cs.GetState(context.Background(), 2)
	if state.CircuitOpenedAt != nil {
		t.Error("CloseCircuit should have cleared CircuitOpenedAt")
	}
}

package watchdog

import (
	"context"
	"errors"
	"testing"
	"time"

	"mailboxes/mailbox"
)

// errAuthFails makes CountRecent return an error on demand.
type errAuthFails struct {
	fakeAuthFails
	countErr error
}

func (f *errAuthFails) CountRecent(ctx context.Context, mailboxID int64, w time.Duration) (int, error) {
	if f.countErr != nil {
		return 0, f.countErr
	}
	return f.fakeAuthFails.CountRecent(ctx, mailboxID, w)
}

// errListStore makes List return an error.
type errListStore struct {
	fakeStore
	listErr error
}

func (s *errListStore) List(_ context.Context, _ mailbox.Filter) ([]mailbox.Mailbox, error) {
	return nil, s.listErr
}

// ─── Tick: nil Store ──────────────────────────────────────────────────────────

func TestTick_NilStore_ReturnsError(t *testing.T) {
	d := NewDaemon(DaemonConfig{Events: &fakeEventSink{}})
	if err := d.Tick(context.Background()); err == nil {
		t.Fatal("expected error for nil Store")
	}
}

// ─── Tick: Store.List error ───────────────────────────────────────────────────

func TestTick_ListError_ReturnsError(t *testing.T) {
	d := NewDaemon(DaemonConfig{
		Store:  &errListStore{listErr: errors.New("db down")},
		Events: &fakeEventSink{},
	})
	if err := d.Tick(context.Background()); err == nil {
		t.Fatal("expected error when List fails")
	}
}

// ─── Tick: AuthFails + Circuit → CountRecent for circuit window ───────────────

// TestTick_CircuitFails_CountRecent verifies that when both AuthFails and Circuit
// are set, Tick calls CountRecent with the circuit window and feeds that count to
// runCircuitBreaker. If fails >= threshold, circuit trips.
func TestTick_CircuitFails_CountRecent_TripsCircuit(t *testing.T) {
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 1, Status: mailbox.StatusActive, FromAddress: "a@test",
	}}}
	cs := newFakeCircuitStore()
	fails := &fakeAuthFails{counts: map[int64]int{1: 10}}
	events := &fakeEventSink{}

	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     events,
		AuthFails:  fails,
		Circuit:    cs,
		CircuitCfg: CircuitBreakerConfig{FailThreshold: 5, Window: time.Minute},
		AuthThresh: 100, // high so swapProxy path is not reached
		AuthWindow: time.Hour,
	})

	if err := d.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	state, _ := cs.GetState(context.Background(), 1)
	if state.CircuitOpenedAt == nil {
		t.Error("expected circuit to be tripped when fails >= threshold")
	}
}

// ─── Tick: auth spike with pool == nil ────────────────────────────────────────

// TestTick_AuthSpike_PoolNil_RecordsEventNoSwap verifies the branch where the
// auth spike threshold is hit but there is no proxy pool available — the watchdog
// records an EventAuthFailSpike but does not attempt a swap.
func TestTick_AuthSpike_PoolNil_RecordsEventNoSwap(t *testing.T) {
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 2, Status: mailbox.StatusActive, FromAddress: "b@test",
	}}}
	fails := &fakeAuthFails{counts: map[int64]int{2: 5}}
	events := &fakeEventSink{}

	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     events,
		AuthFails:  fails,
		ProxyPool:  nil, // no pool
		AuthThresh: 5,
		AuthWindow: time.Hour,
	})

	if err := d.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Store must not have been updated (no swap).
	if len(store.updated) != 0 {
		t.Errorf("expected no Store.Update for pool-nil path, got %d", len(store.updated))
	}
	// EventAuthFailSpike must have been recorded.
	var found bool
	for _, e := range events.events {
		if e.Type == EventAuthFailSpike {
			found = true
			if e.AutoHealed {
				t.Error("spike-without-swap event should have AutoHealed=false")
			}
		}
	}
	if !found {
		t.Error("expected EventAuthFailSpike event when pool is nil")
	}
}

// ─── Tick: auth spike CountRecent error ───────────────────────────────────────

// TestTick_AuthFails_CountRecentError_Skips verifies that when CountRecent for
// the auth-spike window returns an error, Tick logs and continues (no panic, no
// swap, no event).
func TestTick_AuthFails_CountRecentError_Skips(t *testing.T) {
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 3, Status: mailbox.StatusActive, FromAddress: "c@test",
	}}}
	fails := &errAuthFails{countErr: errors.New("db: timeout")}
	events := &fakeEventSink{}

	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     events,
		AuthFails:  fails,
		AuthThresh: 5,
		AuthWindow: time.Hour,
	})

	if err := d.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.updated) != 0 {
		t.Error("CountRecent error should skip the mailbox without update")
	}
}

// ─── Tick: proxy pool Fetch error ─────────────────────────────────────────────

// TestTick_ProxyPoolFetchError_ContinuesWithoutPool verifies that a ProxyPool
// Fetch error is swallowed (pool stays nil) and the Tick does not fail.
func TestTick_ProxyPoolFetchError_ContinuesWithoutPool(t *testing.T) {
	store := &fakeStore{rows: []mailbox.Mailbox{{
		ID: 4, Status: mailbox.StatusActive, FromAddress: "d@test",
	}}}
	poolFetcher := &fakeProxyFetcher{err: errors.New("pool unavailable")}
	events := &fakeEventSink{}

	d := NewDaemon(DaemonConfig{
		Store:      store,
		Events:     events,
		ProxyPool:  poolFetcher,
		AuthThresh: 100, // high so no swap attempted
		AuthWindow: time.Hour,
	})

	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("Tick must not fail when proxy pool fetch errors: %v", err)
	}
}

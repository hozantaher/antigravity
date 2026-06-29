package watchdog

import (
	"context"
	"errors"
	"testing"
	"time"

	"mailboxes/mailbox"
)

// failEventSink always returns an error from Record.
type failEventSink struct{}

func (f *failEventSink) Record(_ context.Context, _ Event) error {
	return errors.New("event sink failed")
}

// ─── decayBounce ─────────────────────────────────────────────────────────────

func TestDecayBounce_Success(t *testing.T) {
	mb := mailbox.Mailbox{ID: 10, ConsecutiveBounces: 3, FromAddress: "jan@test.local"}
	store := &fakeStore{rows: []mailbox.Mailbox{mb}}
	events := &fakeEventSink{}

	d := NewDaemon(DaemonConfig{Store: store, Events: events, BounceDecay: 24 * time.Hour})
	if err := d.decayBounce(context.Background(), mb); err != nil {
		t.Fatalf("decayBounce: %v", err)
	}
	if len(events.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events.events))
	}
	if events.events[0].Type != EventBounceDecay {
		t.Errorf("event type = %q, want %q", events.events[0].Type, EventBounceDecay)
	}
}

func TestDecayBounce_StoreResetFails(t *testing.T) {
	// Mailbox not in store → ResetBounce returns ErrMailboxNotFound → error propagated.
	store := &fakeStore{rows: nil}
	events := &fakeEventSink{}
	d := NewDaemon(DaemonConfig{Store: store, Events: events, BounceDecay: 24 * time.Hour})

	mb := mailbox.Mailbox{ID: 99}
	if err := d.decayBounce(context.Background(), mb); err == nil {
		t.Fatal("expected error from ResetBounce failure")
	}
}

func TestDecayBounce_EventFails(t *testing.T) {
	mb := mailbox.Mailbox{ID: 20, ConsecutiveBounces: 1}
	store := &fakeStore{rows: []mailbox.Mailbox{mb}}

	d := NewDaemon(DaemonConfig{Store: store, Events: &failEventSink{}, BounceDecay: 24 * time.Hour})
	if err := d.decayBounce(context.Background(), mb); err == nil {
		t.Fatal("expected error from Events.Record failure")
	}
}

// ─── swapProxy ───────────────────────────────────────────────────────────────

func TestSwapProxy_NoCandidates_Error(t *testing.T) {
	mb := mailbox.Mailbox{ID: 1, ProxyURL: "socks5://old.proxy:1080"}
	store := &fakeStore{rows: []mailbox.Mailbox{mb}}
	events := &fakeEventSink{}
	authFails := &fakeAuthFails{counts: map[int64]int{}}

	d := NewDaemon(DaemonConfig{Store: store, Events: events, AuthFails: authFails})
	pool := &ProxyPoolResponse{Working: nil} // no candidates

	if err := d.swapProxy(context.Background(), mb, pool, 5); err == nil {
		t.Fatal("expected error when no proxy candidates")
	}
}

func TestSwapProxy_SameProxy_Error(t *testing.T) {
	// Only candidate is current proxy → swap refused.
	mb := mailbox.Mailbox{ID: 2, ProxyURL: "socks5://same.proxy:1080"}
	store := &fakeStore{rows: []mailbox.Mailbox{mb}}
	events := &fakeEventSink{}
	authFails := &fakeAuthFails{counts: map[int64]int{}}

	d := NewDaemon(DaemonConfig{Store: store, Events: events, AuthFails: authFails})
	pool := &ProxyPoolResponse{
		Working: []ProxyCandidate{{Addr: "same.proxy:1080", ProbeMs: 50}},
	}

	if err := d.swapProxy(context.Background(), mb, pool, 5); err == nil {
		t.Fatal("expected error when only candidate equals current proxy")
	}
}

func TestSwapProxy_StoreUpdateFails_Error(t *testing.T) {
	// Store has no matching mailbox → Update returns ErrMailboxNotFound.
	mb := mailbox.Mailbox{ID: 999, ProxyURL: "socks5://old.proxy:1080"}
	store := &fakeStore{rows: nil} // ID 999 not in store
	events := &fakeEventSink{}
	authFails := &fakeAuthFails{counts: map[int64]int{}}

	d := NewDaemon(DaemonConfig{Store: store, Events: events, AuthFails: authFails})
	pool := &ProxyPoolResponse{
		Working: []ProxyCandidate{{Addr: "new.proxy:1080", ProbeMs: 30}},
	}

	if err := d.swapProxy(context.Background(), mb, pool, 3); err == nil {
		t.Fatal("expected error from Store.Update failure")
	}
}

func TestSwapProxy_Success(t *testing.T) {
	mb := mailbox.Mailbox{ID: 3, ProxyURL: "socks5://old.proxy:1080"}
	store := &fakeStore{rows: []mailbox.Mailbox{mb}}
	events := &fakeEventSink{}
	authFails := &fakeAuthFails{counts: map[int64]int{3: 2}}

	d := NewDaemon(DaemonConfig{Store: store, Events: events, AuthFails: authFails})
	pool := &ProxyPoolResponse{
		Working:   []ProxyCandidate{{Addr: "new.proxy:1080", ProbeMs: 25, Country: "CZ"}},
		CzWorking: 1,
	}

	if err := d.swapProxy(context.Background(), mb, pool, 3); err != nil {
		t.Fatalf("swapProxy: %v", err)
	}
	if len(events.events) != 1 || events.events[0].Type != EventProxySwap {
		t.Errorf("expected EventProxySwap, got %+v", events.events)
	}
	if len(authFails.resolved) != 1 || authFails.resolved[0] != 3 {
		t.Errorf("expected auth fails resolved for mailbox 3, got %v", authFails.resolved)
	}
}

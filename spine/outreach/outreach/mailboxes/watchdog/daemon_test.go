package watchdog

import (
	"context"
	"testing"
	"time"

	"mailboxes/mailbox"
)

// fakeStore is a minimal in-memory implementation of mailbox.Store for watchdog tests.
type fakeStore struct {
	rows    []mailbox.Mailbox
	updated []mailbox.Mailbox // records every Update() call
}

func (s *fakeStore) List(_ context.Context, _ mailbox.Filter) ([]mailbox.Mailbox, error) {
	return s.rows, nil
}
func (s *fakeStore) Get(_ context.Context, id int64) (mailbox.Mailbox, error) {
	for _, m := range s.rows {
		if m.ID == id {
			return m, nil
		}
	}
	return mailbox.Mailbox{}, mailbox.ErrMailboxNotFound
}
func (s *fakeStore) GetByAddress(_ context.Context, _ string) (mailbox.Mailbox, error) {
	return mailbox.Mailbox{}, mailbox.ErrMailboxNotFound
}
func (s *fakeStore) UpsertFromConfig(_ context.Context, m mailbox.Mailbox) (mailbox.Mailbox, error) {
	return m, nil
}
func (s *fakeStore) UpdateStatus(_ context.Context, id int64, st mailbox.Status, reason string) (mailbox.Mailbox, error) {
	for i := range s.rows {
		if s.rows[i].ID == id {
			s.rows[i].Status = st
			s.rows[i].StatusReason = reason
			return s.rows[i], nil
		}
	}
	return mailbox.Mailbox{}, mailbox.ErrMailboxNotFound
}
func (s *fakeStore) TouchLastSend(_ context.Context, _ int64, _ time.Time) error { return nil }
func (s *fakeStore) IncrementBounce(_ context.Context, _ int64) (mailbox.Mailbox, error) {
	return mailbox.Mailbox{}, nil
}
func (s *fakeStore) ResetBounce(_ context.Context, id int64) error {
	for i := range s.rows {
		if s.rows[i].ID == id {
			s.rows[i].ConsecutiveBounces = 0
			return nil
		}
	}
	return mailbox.ErrMailboxNotFound
}
func (s *fakeStore) Create(_ context.Context, m mailbox.Mailbox) (mailbox.Mailbox, error) {
	return m, nil
}
func (s *fakeStore) Update(_ context.Context, id int64, m mailbox.Mailbox) (mailbox.Mailbox, error) {
	s.updated = append(s.updated, m)
	for i := range s.rows {
		if s.rows[i].ID == id {
			s.rows[i] = m
			return m, nil
		}
	}
	return mailbox.Mailbox{}, mailbox.ErrMailboxNotFound
}
func (s *fakeStore) Delete(_ context.Context, _ int64) error { return nil }

// fakeEventSink records every event for assertion.
type fakeEventSink struct {
	events []Event
}

func (s *fakeEventSink) Record(_ context.Context, e Event) error {
	s.events = append(s.events, e)
	return nil
}

// fakeAuthFails simulates per-mailbox counts and tracks ResolveAll calls.
type fakeAuthFails struct {
	counts   map[int64]int
	resolved []int64
}

func (f *fakeAuthFails) CountRecent(_ context.Context, mailboxID int64, _ time.Duration) (int, error) {
	return f.counts[mailboxID], nil
}
func (f *fakeAuthFails) ResolveAll(_ context.Context, mailboxID int64) error {
	f.resolved = append(f.resolved, mailboxID)
	f.counts[mailboxID] = 0
	return nil
}

// fakeProxyFetcher returns a canned pool.
type fakeProxyFetcher struct {
	pool *ProxyPoolResponse
	err  error
}

func (f *fakeProxyFetcher) Fetch(_ context.Context) (*ProxyPoolResponse, error) {
	return f.pool, f.err
}

func TestDaemon_SwapsProxyAfterAuthSpike(t *testing.T) {
	store := &fakeStore{
		rows: []mailbox.Mailbox{{
			ID:          1,
			FromAddress: "jan@sender.test",
			Status:      mailbox.StatusActive,
			ProxyURL:    "socks5://1.1.1.1:1080",
			UpdatedAt:   time.Now().Add(-48 * time.Hour), // old = bounce decay eligible
		}},
	}
	events := &fakeEventSink{}
	fails := &fakeAuthFails{counts: map[int64]int{1: 3}}
	pool := &fakeProxyFetcher{pool: &ProxyPoolResponse{
		Working: []ProxyCandidate{
			{Addr: "2.2.2.2:1080", Country: "CZ", Source: "proxifly", ProbeMs: 150},
			{Addr: "3.3.3.3:1080", Country: "SK", Source: "proxifly", ProbeMs: 220},
		},
		CzWorking: 1,
	}}

	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, AuthFails: fails, ProxyPool: pool,
		AuthThresh: 3, AuthWindow: time.Hour,
	})
	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}

	if len(store.updated) != 1 {
		t.Fatalf("expected 1 store Update, got %d", len(store.updated))
	}
	if got := store.updated[0].ProxyURL; got != "socks5://2.2.2.2:1080" {
		t.Errorf("proxy not swapped to fastest: got %q", got)
	}
	var hasSwap bool
	for _, e := range events.events {
		if e.Type == EventProxySwap {
			hasSwap = true
			if !e.AutoHealed {
				t.Errorf("swap event should be auto_healed=true")
			}
			if e.MailboxID == nil || *e.MailboxID != 1 {
				t.Errorf("swap event mailbox_id: got %v", e.MailboxID)
			}
		}
	}
	if !hasSwap {
		t.Errorf("no proxy_swap event recorded; events=%+v", events.events)
	}
	if len(fails.resolved) != 1 || fails.resolved[0] != 1 {
		t.Errorf("auth fails not cleared after swap: resolved=%v", fails.resolved)
	}
}

func TestDaemon_DoesNotSwapBelowThreshold(t *testing.T) {
	store := &fakeStore{
		rows: []mailbox.Mailbox{{
			ID: 1, FromAddress: "jan@sender.test", Status: mailbox.StatusActive,
			ProxyURL: "socks5://1.1.1.1:1080", UpdatedAt: time.Now(),
		}},
	}
	events := &fakeEventSink{}
	fails := &fakeAuthFails{counts: map[int64]int{1: 2}} // below threshold
	pool := &fakeProxyFetcher{pool: &ProxyPoolResponse{
		Working: []ProxyCandidate{{Addr: "2.2.2.2:1080", ProbeMs: 150}},
	}}

	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, AuthFails: fails, ProxyPool: pool,
		AuthThresh: 3, AuthWindow: time.Hour,
	})
	_ = d.Tick(context.Background())

	if len(store.updated) != 0 {
		t.Errorf("should not swap below threshold, got %d updates", len(store.updated))
	}
	for _, e := range events.events {
		if e.Type == EventProxySwap {
			t.Errorf("unexpected proxy_swap event")
		}
	}
}

func TestDaemon_BounceDecayZeroesCounter(t *testing.T) {
	store := &fakeStore{
		rows: []mailbox.Mailbox{{
			ID: 1, FromAddress: "jan@sender.test", Status: mailbox.StatusActive,
			ConsecutiveBounces: 3,
			UpdatedAt:          time.Now().Add(-48 * time.Hour),
		}},
	}
	events := &fakeEventSink{}
	fails := &fakeAuthFails{counts: map[int64]int{}}

	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, AuthFails: fails,
	})
	_ = d.Tick(context.Background())

	if store.rows[0].ConsecutiveBounces != 0 {
		t.Errorf("bounce counter not decayed: got %d", store.rows[0].ConsecutiveBounces)
	}
	var decayed bool
	for _, e := range events.events {
		if e.Type == EventBounceDecay {
			decayed = true
		}
	}
	if !decayed {
		t.Errorf("no bounce_decay event recorded")
	}
}

func TestDaemon_FailOpenWhenProxyPoolUnavailable(t *testing.T) {
	store := &fakeStore{
		rows: []mailbox.Mailbox{{
			ID: 1, FromAddress: "jan@sender.test", Status: mailbox.StatusActive,
			UpdatedAt: time.Now(),
		}},
	}
	events := &fakeEventSink{}
	fails := &fakeAuthFails{counts: map[int64]int{1: 5}}
	pool := &fakeProxyFetcher{err: context.DeadlineExceeded}

	d := NewDaemon(DaemonConfig{
		Store: store, Events: events, AuthFails: fails, ProxyPool: pool,
		AuthThresh: 3, AuthWindow: time.Hour,
	})
	if err := d.Tick(context.Background()); err != nil {
		t.Fatalf("tick must fail-open on proxy pool error, got: %v", err)
	}
	// Expect a spike event (non-healed) recorded even though swap couldn't happen.
	var spike bool
	for _, e := range events.events {
		if e.Type == EventAuthFailSpike && !e.AutoHealed {
			spike = true
		}
	}
	if !spike {
		t.Errorf("expected auth_fail_spike event when pool unavailable")
	}
}

func TestPickProxy_SkipsCurrentAndPicksFastest(t *testing.T) {
	m := mailbox.Mailbox{ProxyURL: "socks5://1.1.1.1:1080"}
	candidates := []ProxyCandidate{
		{Addr: "1.1.1.1:1080", ProbeMs: 100},
		{Addr: "2.2.2.2:1080", ProbeMs: 500},
		{Addr: "3.3.3.3:1080", ProbeMs: 200},
	}
	got, ok := pickProxy(m, candidates, nil)
	if !ok || got.Addr != "3.3.3.3:1080" {
		t.Errorf("pickProxy: got %+v ok=%v, want 3.3.3.3 fastest non-current", got, ok)
	}
}

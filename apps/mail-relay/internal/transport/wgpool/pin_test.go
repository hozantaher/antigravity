package wgpool

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// ─── in-process stub PinReader / PinWriter ────────────────────────────────

type stubPinStore struct {
	mu   sync.Mutex
	pins map[string]string // mailboxID → label
}

func newStubPinStore() *stubPinStore {
	return &stubPinStore{pins: make(map[string]string)}
}

func (s *stubPinStore) GetMailboxPinnedEndpoint(mailboxID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pins[mailboxID], nil
}

func (s *stubPinStore) GetAllPinnedLabels() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := make(map[string]struct{}, len(s.pins))
	var out []string
	for _, label := range s.pins {
		if label == "" {
			continue
		}
		if _, dup := seen[label]; !dup {
			seen[label] = struct{}{}
			out = append(out, label)
		}
	}
	return out, nil
}

func (s *stubPinStore) SetMailboxPin(mailboxID, endpointLabel, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// First call wins.
	if _, exists := s.pins[mailboxID]; !exists {
		s.pins[mailboxID] = endpointLabel
	}
	return nil
}

// ─── Test 1: Pick with pinned mailbox returns that endpoint ──────────────

func TestPick_PinnedMailbox_ReturnsPinnedEndpoint(t *testing.T) {
	p := mkPool(t, 4, Config{})
	store := newStubPinStore()
	store.pins["mb-pinned"] = "ep-b"

	p.WithPinReader(store)

	ep, err := p.Pick("env-x", "mb-pinned")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if ep.Label != "ep-b" {
		t.Fatalf("want ep-b, got %s", ep.Label)
	}
}

// ─── Test 2: Pick with pinned-quarantined returns ErrPinnedEndpointQuarantined

func TestPick_PinnedEndpointQuarantined_ReturnsError(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkPool(t, 4, Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  10 * time.Minute,
		Now:                 func() time.Time { return now },
	})
	store := newStubPinStore()
	store.pins["mb-pinned"] = "ep-a"

	p.WithPinReader(store)
	p.RecordFailure("ep-a") // quarantines ep-a

	_, err := p.Pick("env-x", "mb-pinned")
	if !errors.Is(err, ErrPinnedEndpointQuarantined) {
		t.Fatalf("want ErrPinnedEndpointQuarantined, got %v", err)
	}
}

// ─── Test 3: Pick with pinned-missing-from-pool returns ErrPinnedEndpointMissing

func TestPick_PinnedEndpointMissingFromPool_ReturnsError(t *testing.T) {
	p := mkPool(t, 3, Config{})
	store := newStubPinStore()
	store.pins["mb-ghost"] = "ep-gone" // not in pool (pool has ep-a, ep-b, ep-c)

	p.WithPinReader(store)

	_, err := p.Pick("env-x", "mb-ghost")
	if !errors.Is(err, ErrPinnedEndpointMissing) {
		t.Fatalf("want ErrPinnedEndpointMissing, got %v", err)
	}
}

// ─── Test 4: Pick without pin uses country filter (existing behavior preserved)

func TestPick_WithoutPin_UsesCountryFilter(t *testing.T) {
	// Pool: 2 CZ + 2 DE; mailbox has no pin.
	eps := []Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:1080", Country: "CZ"},
		{Label: "cz2", SocksAddr: "127.0.0.1:1081", Country: "CZ"},
		{Label: "de1", SocksAddr: "127.0.0.1:1082", Country: "DE"},
		{Label: "de2", SocksAddr: "127.0.0.1:1083", Country: "DE"},
	}
	p, err := New(eps, Config{})
	if err != nil {
		t.Fatal(err)
	}
	store := newStubPinStore() // no pins
	p.WithPinReader(store)

	for i := 0; i < 20; i++ {
		ep, err := p.Pick("env-de", "mb-de", "DE")
		if err != nil {
			t.Fatalf("pick %d: %v", i, err)
		}
		if ep.Country != "DE" {
			t.Fatalf("pick %d: expected DE endpoint, got %s (%s)", i, ep.Label, ep.Country)
		}
	}
}

// ─── Test 5: SetPin first call succeeds

func TestSetPin_FirstCallSucceeds(t *testing.T) {
	p := mkPool(t, 3, Config{})
	store := newStubPinStore()
	p.WithPinWriter(store)

	if err := p.SetPin("mb-1", "ep-a", "drain_first_send"); err != nil {
		t.Fatalf("SetPin: %v", err)
	}
	if store.pins["mb-1"] != "ep-a" {
		t.Fatalf("pin not set: %v", store.pins)
	}
}

// ─── Test 6: SetPin race: first wins

func TestSetPin_ConcurrentCalls_FirstWins(t *testing.T) {
	p := mkPool(t, 4, Config{})
	store := newStubPinStore()
	p.WithPinWriter(store)

	const goroutines = 20
	var wg sync.WaitGroup
	wg.Add(goroutines)
	labels := []string{"ep-a", "ep-b", "ep-c", "ep-d"}
	for i := 0; i < goroutines; i++ {
		label := labels[i%len(labels)]
		go func(l string) {
			defer wg.Done()
			_ = p.SetPin("mb-race", l, "test")
		}(label)
	}
	wg.Wait()

	// Exactly one label should be set.
	got := store.pins["mb-race"]
	if got == "" {
		t.Fatal("expected a pin to be set, got empty")
	}
	// Verify the stored label is one of the valid ones.
	valid := false
	for _, l := range labels {
		if l == got {
			valid = true
			break
		}
	}
	if !valid {
		t.Fatalf("unexpected label: %s", got)
	}
}

// ─── Test 7: SetPin without writer returns ErrDBWriterUnavailable

func TestSetPin_WithoutWriter_ReturnsError(t *testing.T) {
	p := mkPool(t, 2, Config{})
	// no WithPinWriter
	err := p.SetPin("mb-1", "ep-a", "test")
	if !errors.Is(err, ErrDBWriterUnavailable) {
		t.Fatalf("want ErrDBWriterUnavailable, got %v", err)
	}
}

// ─── Test 8: WithPinReader nil → no-pin behavior (no crash)

func TestPick_NoPinReader_NoPinBehavior(t *testing.T) {
	p := mkPool(t, 4, Config{})
	// no WithPinReader — should behave as before AP2
	ep, err := p.Pick("env-1", "mb-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Label == "" {
		t.Fatal("expected an endpoint label")
	}
}

// ─── Test 9: LabelBySocksAddr

func TestLabelBySocksAddr(t *testing.T) {
	p := mkPool(t, 3, Config{})

	got := p.LabelBySocksAddr("127.0.0.1:1080")
	if got != "ep-a" {
		t.Fatalf("want ep-a, got %q", got)
	}

	notFound := p.LabelBySocksAddr("127.0.0.1:9999")
	if notFound != "" {
		t.Fatalf("want empty, got %q", notFound)
	}
}

// ─── Test 10: PinReader error → treated as no-pin (degraded gracefully)

func TestPick_PinReaderError_FallsBackToNormal(t *testing.T) {
	p := mkPool(t, 4, Config{})
	errStore := &erroringPinReader{}
	p.WithPinReader(errStore)

	// Should not error — DB error is treated as "no pin set".
	ep, err := p.Pick("env-1", "mb-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Label == "" {
		t.Fatal("expected an endpoint")
	}
}

type erroringPinReader struct{}

func (e *erroringPinReader) GetMailboxPinnedEndpoint(_ string) (string, error) {
	return "", errors.New("db connection refused")
}

func (e *erroringPinReader) GetAllPinnedLabels() ([]string, error) {
	return nil, errors.New("db connection refused")
}

// ─── Test 11: WithPinReader / WithPinWriter are fluent (return *Pool)

func TestWithPinFluent(t *testing.T) {
	p := mkPool(t, 2, Config{})
	store := newStubPinStore()
	p2 := p.WithPinReader(store).WithPinWriter(store)
	if p2 != p {
		t.Fatal("fluent methods should return the same *Pool")
	}
}

// ─── Test 12: Pin is enforced over affinity

func TestPick_PinOverridesAffinity(t *testing.T) {
	p := mkPool(t, 4, Config{AffinityEnabled: true, AffinityWindow: 10})
	store := newStubPinStore()
	p.WithPinReader(store)

	// First pick without pin — affinity binds to whatever hash selects.
	_, err := p.Pick("env-seed", "mb-aff")
	if err != nil {
		t.Fatal(err)
	}

	// Now pin to ep-c.
	store.mu.Lock()
	store.pins["mb-aff"] = "ep-c"
	store.mu.Unlock()

	// Next pick must return ep-c, ignoring affinity.
	ep, err := p.Pick("env-different", "mb-aff")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Label != "ep-c" {
		t.Fatalf("pin overrides affinity: want ep-c, got %s", ep.Label)
	}
}

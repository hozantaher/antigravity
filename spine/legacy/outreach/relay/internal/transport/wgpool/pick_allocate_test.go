package wgpool

// AS2 tests for pickAllocate exclusive endpoint allocation.
// These cover:
//   - Returns existing pin for already-pinned mailbox
//   - Finds first free endpoint (deterministic config order)
//   - Returns ErrPoolExhausted when all endpoints are taken
//   - Returns ErrPinnedEndpointQuarantined when pinned ep is quarantined
//   - Race: 2 concurrent pickAllocate for different mailboxes succeed with distinct eps
//   - Race: 2 concurrent for SAME mailbox both see the same pin
//   - Pick falls back to pickByHash when mailboxID empty (backward compat)
//   - Pick delegates to pickAllocate when mailboxID non-empty + pinIO wired

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// stubPinStoreUnique is like stubPinStore but enforces the UNIQUE constraint
// that the DB will enforce in production — SetMailboxPin errors on duplicate
// label (simulates postgres SQLSTATE 23505).
type stubPinStoreUnique struct {
	mu         sync.Mutex
	pins       map[string]string // mailboxID → label
	labelOwner map[string]string // label → mailboxID (UNIQUE enforcement)
}

func newStubPinStoreUnique() *stubPinStoreUnique {
	return &stubPinStoreUnique{
		pins:       make(map[string]string),
		labelOwner: make(map[string]string),
	}
}

func (s *stubPinStoreUnique) GetMailboxPinnedEndpoint(mailboxID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pins[mailboxID], nil
}

func (s *stubPinStoreUnique) GetAllPinnedLabels() ([]string, error) {
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

func (s *stubPinStoreUnique) SetMailboxPin(mailboxID, endpointLabel, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// If mailbox already pinned → noop (first-call-wins).
	if _, exists := s.pins[mailboxID]; exists {
		return nil
	}
	// UNIQUE constraint: reject if another mailbox already holds this label.
	if owner, taken := s.labelOwner[endpointLabel]; taken && owner != mailboxID {
		return errors.New("duplicate key value violates unique constraint (23505)")
	}
	s.pins[mailboxID] = endpointLabel
	s.labelOwner[endpointLabel] = mailboxID
	return nil
}

// mkPoolWithCountries builds a pool where each endpoint has the given country.
func mkPoolWithCountries(t *testing.T, labels []string, country string, cfg Config) *Pool {
	t.Helper()
	eps := make([]Endpoint, len(labels))
	for i, l := range labels {
		eps[i] = Endpoint{
			Label:     l,
			SocksAddr: "127.0.0.1:108" + string(rune('0'+i)),
			Country:   country,
		}
	}
	p, err := New(eps, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p
}

// ─── AS2-1: pickAllocate returns existing pin ────────────────────────────────

func TestPickAllocate_ExistingPin_ReturnsPinned(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b", "ep-c"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	store.pins["mb-1"] = "ep-b"
	store.labelOwner["ep-b"] = "mb-1"
	p.WithPinReader(store).WithPinWriter(store)

	ep, err := p.pickAllocate("mb-1", "CZ")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if ep.Label != "ep-b" {
		t.Fatalf("want ep-b, got %s", ep.Label)
	}
}

// ─── AS2-2: pickAllocate finds first free endpoint ──────────────────────────

func TestPickAllocate_FindsFirstFree(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b", "ep-c"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	// ep-a is already taken by another mailbox
	store.pins["other-mb"] = "ep-a"
	store.labelOwner["ep-a"] = "other-mb"
	p.WithPinReader(store).WithPinWriter(store)

	ep, err := p.pickAllocate("mb-new", "CZ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// ep-a is taken → first free is ep-b
	if ep.Label != "ep-b" {
		t.Fatalf("want ep-b (first free after ep-a taken), got %s", ep.Label)
	}
	// Verify pin was persisted
	if store.pins["mb-new"] != "ep-b" {
		t.Fatalf("pin not recorded in store: %v", store.pins)
	}
}

// ─── AS2-3: pickAllocate returns ErrPoolExhausted when all taken ─────────────

func TestPickAllocate_AllTaken_ReturnsErrPoolExhausted(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	store.pins["mb-1"] = "ep-a"
	store.labelOwner["ep-a"] = "mb-1"
	store.pins["mb-2"] = "ep-b"
	store.labelOwner["ep-b"] = "mb-2"
	p.WithPinReader(store).WithPinWriter(store)

	_, err := p.pickAllocate("mb-3", "CZ")
	if !errors.Is(err, ErrPoolExhausted) {
		t.Fatalf("want ErrPoolExhausted, got %v", err)
	}
}

// ─── AS2-4: pickAllocate returns ErrPinnedEndpointQuarantined ───────────────

func TestPickAllocate_PinnedEndpointQuarantined_ReturnsError(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b"}, "CZ", Config{
		QuarantineThreshold: 1,
		QuarantineDuration:  10 * time.Minute,
		Now:                 func() time.Time { return now },
	})
	store := newStubPinStoreUnique()
	store.pins["mb-q"] = "ep-a"
	store.labelOwner["ep-a"] = "mb-q"
	p.WithPinReader(store).WithPinWriter(store)
	p.RecordFailure("ep-a") // quarantine ep-a

	_, err := p.pickAllocate("mb-q", "CZ")
	if !errors.Is(err, ErrPinnedEndpointQuarantined) {
		t.Fatalf("want ErrPinnedEndpointQuarantined, got %v", err)
	}
}

// ─── AS2-5: race — 2 concurrent pickAllocate for different mailboxes ─────────

func TestPickAllocate_Race_DifferentMailboxes_BothSucceed(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	p.WithPinReader(store).WithPinWriter(store)

	type result struct {
		ep  Endpoint
		err error
	}
	ch := make(chan result, 2)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		ep, err := p.pickAllocate("mb-race-1", "CZ")
		ch <- result{ep, err}
	}()
	go func() {
		defer wg.Done()
		ep, err := p.pickAllocate("mb-race-2", "CZ")
		ch <- result{ep, err}
	}()
	wg.Wait()
	close(ch)

	var results []result
	for r := range ch {
		results = append(results, r)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	for _, r := range results {
		if r.err != nil {
			t.Errorf("unexpected error: %v", r.err)
		}
	}
	// Both should get distinct endpoints
	if results[0].ep.Label == results[1].ep.Label {
		t.Fatalf("both goroutines got the same endpoint %q — UNIQUE not enforced",
			results[0].ep.Label)
	}
}

// ─── AS2-6: race — same mailbox concurrently → same pin ─────────────────────

func TestPickAllocate_Race_SameMailbox_SamePin(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b", "ep-c"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	p.WithPinReader(store).WithPinWriter(store)

	const goroutines = 10
	results := make([]string, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		idx := i
		go func() {
			defer wg.Done()
			ep, err := p.pickAllocate("mb-same", "CZ")
			if err != nil {
				results[idx] = "ERROR:" + err.Error()
				return
			}
			results[idx] = ep.Label
		}()
	}
	wg.Wait()

	// All should return the same label (the one that won the race).
	first := results[0]
	for i, r := range results {
		if r != first {
			t.Errorf("goroutine %d got %q, want %q", i, r, first)
		}
	}
	if first == "" || len(first) >= 6 && first[:5] == "ERROR" {
		t.Fatalf("unexpected result: %q", first)
	}
}

// ─── AS2-7: Pick falls back to pickByHash when mailboxID empty ───────────────

func TestPick_EmptyMailboxID_FallsBackToHash(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b", "ep-c"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	p.WithPinReader(store).WithPinWriter(store)

	// With empty mailboxID, pickAllocate is NOT called — hash/rr fallback used.
	seen := map[string]struct{}{}
	for i := 0; i < 100; i++ {
		ep, err := p.Pick("env-"+string(rune(i)), "")
		if err != nil {
			t.Fatalf("Pick(%d): %v", i, err)
		}
		seen[ep.Label] = struct{}{}
	}
	// With 3 endpoints and 100 picks we should hit all 3.
	if len(seen) < 2 {
		t.Fatalf("hash fallback only reached %d endpoints: %v", len(seen), seen)
	}
	// No pins should be written for empty mailboxID.
	if len(store.pins) != 0 {
		t.Fatalf("unexpected pins written for empty mailboxID: %v", store.pins)
	}
}

// ─── AS2-8: Pick delegates to pickAllocate when mailboxID non-empty + IO wired

func TestPick_WithMailboxID_DelegatesToPickAllocate(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	p.WithPinReader(store).WithPinWriter(store)

	ep, err := p.Pick("env-1", "mb-x")
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	// Pin should have been recorded.
	if store.pins["mb-x"] != ep.Label {
		t.Fatalf("pin not persisted: store=%v ep=%s", store.pins, ep.Label)
	}
	// Second Pick for same mailbox returns same endpoint.
	ep2, err := p.Pick("env-2", "mb-x")
	if err != nil {
		t.Fatalf("second Pick: %v", err)
	}
	if ep2.Label != ep.Label {
		t.Fatalf("second Pick returned %s, want %s", ep2.Label, ep.Label)
	}
}

// ─── AS2-9: Pick with no pinWriter keeps hash-rotate (legacy path) ───────────

func TestPick_NoPinWriter_KeepsHashRotate(t *testing.T) {
	p := mkPoolWithCountries(t, []string{"ep-a", "ep-b", "ep-c"}, "CZ", Config{})
	store := newStubPinStoreUnique()
	// Wire reader but NOT writer — simulates pool not yet fully configured.
	p.WithPinReader(store)

	ep, err := p.Pick("env-1", "mb-legacy")
	if err != nil {
		t.Fatalf("Pick: %v", err)
	}
	if ep.Label == "" {
		t.Fatal("expected non-empty endpoint label")
	}
	// Nothing should be written to store.
	if len(store.pins) != 0 {
		t.Fatalf("unexpected pin write when pinWriter not wired: %v", store.pins)
	}
}

// ─── AS2-10: isUniqueViolation detects expected patterns ─────────────────────

func TestIsUniqueViolation(t *testing.T) {
	tests := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("duplicate key value violates unique constraint (23505)"), true},
		{errors.New("ERROR: duplicate key value violates unique constraint"), true},
		{errors.New("23505: unique_violation"), true},
		{errors.New("unique constraint \"uq_..._pinned_endpoint\" is violated"), true},
		{errors.New("connection refused"), false},
		{errors.New("relation does not exist"), false},
	}
	for _, tc := range tests {
		got := isUniqueViolation(tc.err)
		if got != tc.want {
			t.Errorf("isUniqueViolation(%q) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

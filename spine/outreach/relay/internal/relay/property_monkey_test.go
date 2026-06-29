package relay

import (
	"relay/internal/deaddrop"
	"relay/internal/filestore"
	"relay/internal/model"
	"relay/internal/transport/fragment"
	"context"
	"encoding/base64"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"testing/quick"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func testCodecProp(t *testing.T) filestore.Codec {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 33)
	}
	c, _ := filestore.NewCodecFromBase64(base64.StdEncoding.EncodeToString(key))
	return c
}

func newSchedulerForProp(t *testing.T) *Scheduler {
	t.Helper()
	s, err := NewScheduler(
		filepath.Join(t.TempDir(), "q.json"),
		testCodecProp(t),
		time.Hour,
		2*time.Hour,
		0,
	)
	if err != nil {
		t.Fatalf("NewScheduler: %v", err)
	}
	return s
}

// ─────────────────────────────────────────────────────────────────────────────
// Krok 2 — multipath.go property tests
// ─────────────────────────────────────────────────────────────────────────────

// TestMultipath_NeverPanics_NilPaths verifies NewMultiPathRouter(nil) and
// subsequent Route/Poll calls with nil slices never panic.
func TestMultipath_NeverPanics_NilPaths(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on nil paths: %v", r)
		}
	}()

	router := NewMultiPathRouter(nil)
	// Route with nil fragments must not panic — it may return error or nil
	_ = router.Route(context.Background(), nil)
	// Poll with nil slots must not panic
	_, _ = router.PollFromRelays(context.Background(), nil)
}

// TestMultipath_EmptyPaths_Handled verifies empty (not nil) inputs are handled gracefully.
func TestMultipath_EmptyPaths_Handled(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on empty paths: %v", r)
		}
	}()

	router := NewMultiPathRouter([]RelayEndpoint{})
	// Route with zero fragments over zero relays: no panic
	_ = router.Route(context.Background(), []fragment.FragmentedShare{})
	// Poll with zero slots: no panic, returns empty slice
	got, err := router.PollFromRelays(context.Background(), []deaddrop.SlotID{})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 fragments, got %d", len(got))
	}
}

// TestMultipath_Property_OutputBounded uses quick.Check to verify:
//  1. Route distributes across at most len(relays) servers (round-robin bounded).
//  2. No panic for any uint8 fragment count.
func TestMultipath_Property_OutputBounded(t *testing.T) {
	// Build a counting server
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f := func(n uint8) bool {
		defer func() { recover() }()

		router := NewMultiPathRouter([]RelayEndpoint{{URL: srv.URL}})
		frags := make([]fragment.FragmentedShare, n)
		for i := range frags {
			frags[i] = newFragment(t, i, []byte{byte(i)})
		}
		before := hits
		_ = router.Route(context.Background(), frags)
		after := hits
		// Number of HTTP calls must equal fragment count (one POST per fragment).
		return (after - before) == int(n)
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Errorf("property violated: %v", err)
	}
}

// TestMultipath_Property_RoundRobinIndex verifies that with R relays and N
// fragments the assignment index follows i % R for all uint8 combos.
func TestMultipath_Property_RoundRobinIndex(t *testing.T) {
	f := func(nRelays uint8, nFrags uint8) bool {
		if nRelays == 0 {
			return true // no relays — handled separately
		}
		defer func() { recover() }()

		counts := make([]int, nRelays)
		srvs := make([]*httptest.Server, nRelays)
		endpoints := make([]RelayEndpoint, nRelays)

		for i := range nRelays {
			idx := i // capture
			srvs[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				counts[idx]++
				w.WriteHeader(http.StatusOK)
			}))
			endpoints[i] = RelayEndpoint{URL: srvs[i].URL}
		}
		defer func() {
			for _, s := range srvs {
				s.Close()
			}
		}()

		router := NewMultiPathRouter(endpoints)
		frags := make([]fragment.FragmentedShare, nFrags)
		for i := range frags {
			frags[i] = newFragment(t, i, []byte{byte(i)})
		}
		_ = router.Route(context.Background(), frags)

		// Verify: each relay got exactly floor(nFrags/nRelays) or that+1 hits.
		// Specifically relay[i] gets hits for all j where j%nRelays == i.
		expected := make([]int, nRelays)
		for j := range int(nFrags) {
			expected[j%int(nRelays)]++
		}
		for i := range int(nRelays) {
			if counts[i] != expected[i] {
				return false
			}
		}
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Errorf("round-robin property violated: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Krok 3 — Scheduler edge-case tests
// ─────────────────────────────────────────────────────────────────────────────

// TestScheduler_EmptyQueue_NoPanic verifies all read methods on a fresh
// empty scheduler return sensible zero values without panicking.
func TestScheduler_EmptyQueue_NoPanic(t *testing.T) {
	s := newSchedulerForProp(t)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on empty queue: %v", r)
		}
	}()

	if s.PendingCount() != 0 {
		t.Errorf("expected 0 pending, got %d", s.PendingCount())
	}
	if envs := s.PendingEnvelopes(); len(envs) != 0 {
		t.Errorf("expected empty slice, got %d", len(envs))
	}
	if age := s.OldestPendingAge(); age != -1 {
		t.Errorf("expected -1 age, got %v", age)
	}
	ready, err := s.DrainReady(context.Background())
	if err != nil {
		t.Errorf("DrainReady on empty: unexpected error: %v", err)
	}
	if len(ready) != 0 {
		t.Errorf("expected 0 ready, got %d", len(ready))
	}
}

// TestScheduler_ContextCancel_Exits verifies that passing an already-cancelled
// context to Schedule and DrainReady does not cause panics or unexpected errors.
func TestScheduler_ContextCancel_Exits(t *testing.T) {
	s := newSchedulerForProp(t)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with cancelled context: %v", r)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	// Schedule with cancelled context: currently the implementation doesn't
	// propagate ctx into crypto or filestore, so it should still succeed.
	_, err := s.Schedule(ctx, model.Envelope{
		ID:       "ctx-cancel-env",
		TenantID: "t",
		Status:   model.StatusSealed,
	})
	// We do not assert err==nil here because future implementations may honour ctx.
	// We only require no panic.
	_ = err

	_, _ = s.DrainReady(ctx)
}

// TestScheduler_ZeroDelays_ScheduleAndDrainImmediately verifies min==max==0
// causes the envelope to be ready immediately.
func TestScheduler_ZeroDelays_ScheduleAndDrainImmediately(t *testing.T) {
	s, err := NewScheduler(
		filepath.Join(t.TempDir(), "q.json"),
		testCodecProp(t),
		0, // min
		0, // max
		0,
	)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	_, err = s.Schedule(ctx, model.Envelope{ID: "zero-delay", TenantID: "t", Status: model.StatusSealed})
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	ready, err := s.DrainReady(ctx)
	if err != nil {
		t.Fatalf("DrainReady: %v", err)
	}
	if len(ready) != 1 {
		t.Errorf("expected 1 ready with zero delay, got %d", len(ready))
	}
}

// TestScheduler_MarkRelayed_UnknownID_NoPanic verifies marking an unknown
// envelope relayed neither panics nor errors.
func TestScheduler_MarkRelayed_UnknownID_NoPanic(t *testing.T) {
	s := newSchedulerForProp(t)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic on unknown ID MarkRelayed: %v", r)
		}
	}()

	if err := s.MarkRelayed(context.Background(), "does-not-exist"); err != nil {
		t.Errorf("MarkRelayed on unknown ID returned error: %v", err)
	}
}

// TestScheduler_ConcurrentSchedule_NoPanic verifies concurrent Schedule calls
// do not cause data races or panics (run with -race).
func TestScheduler_ConcurrentSchedule_NoPanic(t *testing.T) {
	s := newSchedulerForProp(t)
	ctx := context.Background()

	done := make(chan struct{})
	for i := range 10 {
		go func(i int) {
			defer func() { recover() }()
			s.Schedule(ctx, model.Envelope{ //nolint:errcheck
				ID:       "concurrent-" + string(rune('a'+i)),
				TenantID: "t",
				Status:   model.StatusSealed,
			})
			done <- struct{}{}
		}(i)
	}
	for range 10 {
		<-done
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Krok 4 — MONKEY: all exported functions with nil/zero inputs
// ─────────────────────────────────────────────────────────────────────────────

// TestAllPublicFunctions_NeverPanicOnNilInputs calls every exported method on
// MultiPathRouter and Scheduler with nil / zero / empty values and verifies no
// unrecovered panic escapes.
func TestAllPublicFunctions_NeverPanicOnNilInputs(t *testing.T) {
	ctx := context.Background()

	t.Run("NewMultiPathRouter_nil", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		r := NewMultiPathRouter(nil)
		if r == nil {
			t.Fatal("expected non-nil router")
		}
	})

	t.Run("Route_nil_fragments", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://127.0.0.1:1"}})
		_ = r.Route(ctx, nil)
	})

	t.Run("Route_empty_fragments", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://127.0.0.1:1"}})
		_ = r.Route(ctx, []fragment.FragmentedShare{})
	})

	t.Run("PollFromRelays_nil_slots", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://127.0.0.1:1"}})
		_, _ = r.PollFromRelays(ctx, nil)
	})

	t.Run("PollFromRelays_empty_slots", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		r := NewMultiPathRouter([]RelayEndpoint{{URL: "http://127.0.0.1:1"}})
		_, _ = r.PollFromRelays(ctx, []deaddrop.SlotID{})
	})

	t.Run("Scheduler_PendingCount_fresh", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_ = s.PendingCount()
	})

	t.Run("Scheduler_PendingEnvelopes_fresh", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_ = s.PendingEnvelopes()
	})

	t.Run("Scheduler_OldestPendingAge_fresh", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_ = s.OldestPendingAge()
	})

	t.Run("Scheduler_DrainReady_empty", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_, _ = s.DrainReady(ctx)
	})

	t.Run("Scheduler_Schedule_zero_envelope", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_, _ = s.Schedule(ctx, model.Envelope{})
	})

	t.Run("Scheduler_MarkRelayed_empty_id", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_ = s.MarkRelayed(ctx, "")
	})

	t.Run("Scheduler_MarkFailed_empty_id", func(t *testing.T) {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic: %v", r)
			}
		}()
		s := newSchedulerForProp(t)
		_ = s.MarkFailed(ctx, "")
	})
}

// TestCryptoRandDuration_Property verifies the result is always within [min, max].
func TestCryptoRandDuration_Property(t *testing.T) {
	f := func(a, b uint32) bool {
		min := time.Duration(a) * time.Millisecond
		max := time.Duration(b) * time.Millisecond
		if max < min {
			min, max = max, min
		}
		d, err := cryptoRandDuration(min, max)
		if err != nil {
			return false
		}
		return d >= min && d <= max
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Errorf("cryptoRandDuration out of bounds: %v", err)
	}
}

// TestCryptoRandDuration_EqualBounds verifies min==max returns min.
func TestCryptoRandDuration_EqualBounds(t *testing.T) {
	for _, d := range []time.Duration{0, time.Second, 5 * time.Minute} {
		got, err := cryptoRandDuration(d, d)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != d {
			t.Errorf("equal bounds: want %v, got %v", d, got)
		}
	}
}

// TestScheduler_Property_DrainOnlyReady uses quick.Check to verify that
// DrainReady never returns an envelope whose ScheduledAt is in the future.
func TestScheduler_Property_DrainOnlyReady(t *testing.T) {
	f := func(n uint8) bool {
		defer func() { recover() }()

		s, err := NewScheduler(
			filepath.Join(t.TempDir(), "q.json"),
			testCodecProp(t),
			0, 0, 0,
		)
		if err != nil {
			return false
		}

		fixedNow := time.Date(2025, 6, 1, 12, 0, 0, 0, time.UTC)
		s.now = func() time.Time { return fixedNow }

		ctx := context.Background()
		for i := range n {
			// Half scheduled in the past (should drain), half in the future (should not).
			if i%2 == 0 {
				env := model.Envelope{
					ID: "p-" + string(rune('a'+i%26)), TenantID: "t",
					Status: model.StatusSealed,
				}
				if _, err := s.Schedule(ctx, env); err != nil {
					return false
				}
				// Directly override ScheduledAt to the past
				s.mu.Lock()
				for j := range s.envelopes {
					if s.envelopes[j].Status == model.StatusScheduled {
						if s.envelopes[j].ScheduledAt.After(fixedNow) {
							s.envelopes[j].ScheduledAt = fixedNow.Add(-time.Second)
						}
					}
				}
				s.mu.Unlock()
			} else {
				// Future — random large delay applied by NewScheduler with hour bounds
				s2, _ := NewScheduler(
					filepath.Join(t.TempDir(), "q2.json"),
					testCodecProp(t),
					time.Hour, 2*time.Hour, 0,
				)
				s2.now = func() time.Time { return fixedNow }
				s2.Schedule(ctx, model.Envelope{ //nolint:errcheck
					ID: "f-" + string(rune('a'+i%26)), TenantID: "t",
					Status: model.StatusSealed,
				})
				// Pull from s2 into s: inject envelope with future ScheduledAt
				pe := s2.PendingEnvelopes()
				if len(pe) > 0 {
					s.mu.Lock()
					s.envelopes = append(s.envelopes, pe[0])
					s.mu.Unlock()
				}
			}
		}

		ready, err := s.DrainReady(ctx)
		if err != nil {
			return false
		}
		for _, env := range ready {
			if env.ScheduledAt.After(fixedNow) {
				return false // drained a future envelope — violation!
			}
		}
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Errorf("DrainReady drained a future envelope: %v", err)
	}
}

// TestMultipath_Property_NoRelaySeesAllFragments verifies that with ≥2 relays
// and ≥2 fragments each relay sees a strict subset (no single relay sees all).
func TestMultipath_Property_NoRelaySeesAllFragments(t *testing.T) {
	f := func(seed uint64) bool {
		rng := rand.New(rand.NewPCG(seed, 0))
		nRelays := int(rng.IntN(4)) + 2 // 2..5
		nFrags := int(rng.IntN(6)) + 2  // 2..7

		counts := make([]int, nRelays)
		srvs := make([]*httptest.Server, nRelays)
		endpoints := make([]RelayEndpoint, nRelays)

		for i := range nRelays {
			idx := i
			srvs[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				counts[idx]++
				w.WriteHeader(http.StatusOK)
			}))
			endpoints[i] = RelayEndpoint{URL: srvs[i].URL}
		}
		defer func() {
			for _, s := range srvs {
				s.Close()
			}
		}()

		router := NewMultiPathRouter(endpoints)
		frags := make([]fragment.FragmentedShare, nFrags)
		for i := range frags {
			frags[i] = newFragment(t, i, []byte{byte(i)})
		}
		_ = router.Route(context.Background(), frags)

		// With round-robin and nFrags > nRelays each relay should get some
		// but no single relay should get ALL fragments.
		for i, c := range counts {
			if c == nFrags {
				t.Logf("relay %d got all %d fragments (nRelays=%d)", i, nFrags, nRelays)
				return false
			}
		}
		return true
	}

	if err := quick.Check(f, &quick.Config{MaxCount: 30}); err != nil {
		t.Errorf("relay privacy property violated: %v", err)
	}
}

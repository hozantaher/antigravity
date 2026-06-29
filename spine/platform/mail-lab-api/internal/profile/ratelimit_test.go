package profile

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.5 — sliding-window send rate tracker.
// ════════════════════════════════════════════════════════════════════════

// Helper: tracker with a fixed clock so tests are deterministic.
func newFixedTracker(t *testing.T, window time.Duration, start time.Time) (*Tracker, *time.Time) {
	t.Helper()
	tr := NewTracker(window)
	now := start
	tr.SetClock(func() time.Time { return now })
	return tr, &now
}

// 1. New tracker reports 0 for never-recorded mailbox.
func TestS25_Tracker_EmptyZero(t *testing.T) {
	tr := NewTracker(time.Hour)
	if got := tr.Count("a@x"); got != 0 {
		t.Errorf("count %d, want 0", got)
	}
}

// 2. Record returns post-record count (monotonic).
func TestS25_Tracker_RecordIncrements(t *testing.T) {
	tr := NewTracker(time.Hour)
	if got := tr.Record("a@x"); got != 1 {
		t.Errorf("first record %d, want 1", got)
	}
	if got := tr.Record("a@x"); got != 2 {
		t.Errorf("second record %d, want 2", got)
	}
	if got := tr.Record("a@x"); got != 3 {
		t.Errorf("third record %d, want 3", got)
	}
}

// 3. Different mailboxes track independently.
func TestS25_Tracker_PerMailboxIsolation(t *testing.T) {
	tr := NewTracker(time.Hour)
	tr.Record("a@x")
	tr.Record("a@x")
	tr.Record("b@x")
	if got := tr.Count("a@x"); got != 2 {
		t.Errorf("a count %d, want 2", got)
	}
	if got := tr.Count("b@x"); got != 1 {
		t.Errorf("b count %d, want 1", got)
	}
}

// 4. Window slides — events older than window are pruned.
func TestS25_Tracker_WindowSlides(t *testing.T) {
	tr, now := newFixedTracker(t, time.Hour, time.Now())
	tr.Record("a@x")
	tr.Record("a@x")
	if got := tr.Count("a@x"); got != 2 {
		t.Fatalf("pre-slide count %d, want 2", got)
	}
	*now = now.Add(2 * time.Hour) // > window
	if got := tr.Count("a@x"); got != 0 {
		t.Errorf("post-slide count %d, want 0", got)
	}
}

// 5. Boundary — event exactly at cutoff stays in window (>= cutoff).
func TestS25_Tracker_AtBoundary(t *testing.T) {
	start := time.Now()
	tr, now := newFixedTracker(t, time.Hour, start)
	tr.Record("a@x")
	*now = start.Add(time.Hour) // cutoff = now - 1h = start; event at start is at cutoff
	if got := tr.Count("a@x"); got != 1 {
		t.Errorf("at-boundary count %d, want 1", got)
	}
	*now = start.Add(time.Hour + time.Nanosecond) // 1ns past
	if got := tr.Count("a@x"); got != 0 {
		t.Errorf("just-past count %d, want 0", got)
	}
}

// 6. Allow returns true under limit.
func TestS25_Tracker_AllowUnderLimit(t *testing.T) {
	tr := NewTracker(time.Hour)
	p := &Profile{RateLimitPerHour: 3}
	tr.Record("a@x")
	tr.Record("a@x")
	if !tr.Allow("a@x", p) {
		t.Error("Allow false at count=2 limit=3, want true")
	}
}

// 7. Allow returns false at limit (boundary).
func TestS25_Tracker_AllowAtLimit(t *testing.T) {
	tr := NewTracker(time.Hour)
	p := &Profile{RateLimitPerHour: 3}
	tr.Record("a@x")
	tr.Record("a@x")
	tr.Record("a@x")
	if tr.Allow("a@x", p) {
		t.Error("Allow true at count=3 limit=3, want false")
	}
}

// 8. Nil profile = unlimited (Allow always true).
func TestS25_Tracker_NilProfileUnlimited(t *testing.T) {
	tr := NewTracker(time.Hour)
	for i := 0; i < 1000; i++ {
		tr.Record("a@x")
	}
	if !tr.Allow("a@x", nil) {
		t.Error("nil profile Allow=false")
	}
}

// 9. Profile with limit<=0 is unlimited.
func TestS25_Tracker_ZeroLimitUnlimited(t *testing.T) {
	tr := NewTracker(time.Hour)
	tr.Record("a@x")
	if !tr.Allow("a@x", &Profile{RateLimitPerHour: 0}) {
		t.Error("zero-limit profile Allow=false")
	}
}

// 10. Reset clears all state.
func TestS25_Tracker_Reset(t *testing.T) {
	tr := NewTracker(time.Hour)
	tr.Record("a@x")
	tr.Record("b@x")
	tr.Reset()
	if got := tr.Count("a@x"); got != 0 {
		t.Errorf("post-reset a %d, want 0", got)
	}
	if got := tr.Count("b@x"); got != 0 {
		t.Errorf("post-reset b %d, want 0", got)
	}
}

// 11. Mailbox normalized: case + whitespace.
func TestS25_Tracker_NormalizedKey(t *testing.T) {
	tr := NewTracker(time.Hour)
	tr.Record("  Alice@X.LAB  ")
	if got := tr.Count("alice@x.lab"); got != 1 {
		t.Errorf("normalized count %d, want 1", got)
	}
}

// 12. Concurrent Record race-free + correct total.
func TestS25_Tracker_ConcurrentRecord(t *testing.T) {
	tr := NewTracker(time.Hour)
	var wg sync.WaitGroup
	const N = 100
	var ok int32
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tr.Record("a@x") > 0 {
				atomic.AddInt32(&ok, 1)
			}
		}()
	}
	wg.Wait()
	if atomic.LoadInt32(&ok) != N {
		t.Errorf("ok=%d, want %d", ok, N)
	}
	if got := tr.Count("a@x"); got != N {
		t.Errorf("final count %d, want %d", got, N)
	}
}

// 13. Concurrent Record + Count race-free.
func TestS25_Tracker_ConcurrentMixed(t *testing.T) {
	tr := NewTracker(time.Hour)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); tr.Record("a@x") }()
		go func() { defer wg.Done(); _ = tr.Count("a@x") }()
	}
	wg.Wait()
}

// 14. Default window is 1h on zero/negative input.
func TestS25_Tracker_DefaultWindow(t *testing.T) {
	for _, w := range []time.Duration{0, -1 * time.Second} {
		tr := NewTracker(w)
		// We can't read window directly; smoke-test by recording, advancing
		// 30min, and confirming the event is still counted.
		now := time.Now()
		clock := now
		tr.SetClock(func() time.Time { return clock })
		tr.Record("a@x")
		clock = now.Add(30 * time.Minute)
		if got := tr.Count("a@x"); got != 1 {
			t.Errorf("window=%v: count %d, want 1 (default 1h)", w, got)
		}
	}
}

// 15. Registry RateRecord increments + returns limit.
func TestS25_Registry_RateRecord(t *testing.T) {
	r := loadedRegistry(t)
	count, limit, err := r.RateRecord("seznam.lab", "a@seznam.lab")
	if err != nil {
		t.Fatalf("rate record: %v", err)
	}
	if count != 1 {
		t.Errorf("count %d, want 1", count)
	}
	if limit != 100 { // seznam profile rate_limit_per_hour
		t.Errorf("limit %d, want 100", limit)
	}
}

// 16. Registry RateCount returns 0 for unrecorded mailbox.
func TestS25_Registry_RateCount_Empty(t *testing.T) {
	r := loadedRegistry(t)
	count, limit, err := r.RateCount("gmail.lab", "fresh@gmail.lab")
	if err != nil {
		t.Fatalf("rate count: %v", err)
	}
	if count != 0 || limit != 500 {
		t.Errorf("count=%d limit=%d, want 0/500", count, limit)
	}
}

// 17. Registry RateRecord on unknown domain → ErrUnknownDomain.
func TestS25_Registry_RateRecord_Unknown(t *testing.T) {
	r := loadedRegistry(t)
	_, _, err := r.RateRecord("never.lab", "a@x")
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 18. Registry RateAllow respects per-domain limit.
func TestS25_Registry_RateAllow_PerDomain(t *testing.T) {
	r := loadedRegistry(t)
	// outlook limit is 30/h — record 30, then Allow=false.
	for i := 0; i < 30; i++ {
		_, _, _ = r.RateRecord("outlook.lab", "spammy@outlook.lab")
	}
	allow, _ := r.RateAllow("outlook.lab", "spammy@outlook.lab")
	if allow {
		t.Error("Allow=true at 30/30, want false")
	}
}

// 19. Registry RateReset clears tracker.
func TestS25_Registry_RateReset(t *testing.T) {
	r := loadedRegistry(t)
	r.RateRecord("seznam.lab", "a@seznam.lab")
	r.RateReset()
	count, _, _ := r.RateCount("seznam.lab", "a@seznam.lab")
	if count != 0 {
		t.Errorf("post-reset count %d, want 0", count)
	}
}

// 20. Registry RateAllow on unlimited (zero rate_limit_per_hour) → true.
func TestS25_Registry_RateAllow_Unlimited(t *testing.T) {
	r := NewRegistry()
	r.profiles["x.lab"] = &Profile{Domain: "x.lab", RateLimitPerHour: 0}
	for i := 0; i < 1000; i++ {
		r.RateRecord("x.lab", "a@x.lab")
	}
	allow, _ := r.RateAllow("x.lab", "a@x.lab")
	if !allow {
		t.Error("zero-limit profile not unlimited")
	}
}

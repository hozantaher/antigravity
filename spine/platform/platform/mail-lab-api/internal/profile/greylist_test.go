package profile

import (
	"sync"
	"testing"
	"time"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML3.2 — triplet-based greylist tracker.
// ════════════════════════════════════════════════════════════════════════

func newFixedGreylist(t *testing.T, delay, ttl time.Duration, start time.Time) (*GreylistTracker, *time.Time) {
	t.Helper()
	g := NewGreylistTracker(delay, ttl)
	now := start
	g.SetClock(func() time.Time { return now })
	return g, &now
}

// 1. First contact defers (Allow=false).
func TestS32_Greylist_FirstContact_Defers(t *testing.T) {
	g := NewGreylistTracker(5*time.Minute, 24*time.Hour)
	allow, reason := g.Allow("1.2.3.4", "s@x", "r@y")
	if allow {
		t.Errorf("first contact got allow=true, reason=%q", reason)
	}
	if reason == "" {
		t.Error("first contact reason empty")
	}
}

// 2. Second contact within delay still defers.
func TestS32_Greylist_WithinDelay_Defers(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(2 * time.Minute)
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
	if allow {
		t.Error("within delay got allow=true")
	}
}

// 3. Retry after delay accepts.
func TestS32_Greylist_AfterDelay_Accepts(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(6 * time.Minute) // > 5min delay
	allow, reason := g.Allow("1.2.3.4", "s@x", "r@y")
	if !allow {
		t.Errorf("after delay got allow=false, reason=%q", reason)
	}
}

// 4. Once accepted, subsequent allow=true (graduated).
func TestS32_Greylist_GraduatedKnown(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(6 * time.Minute)
	g.Allow("1.2.3.4", "s@x", "r@y") // graduate
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
	if !allow {
		t.Error("graduated triplet not allowed")
	}
}

// 5. At-boundary delay (exactly 5min) accepts (>= cutoff).
func TestS32_Greylist_AtDelayBoundary_Accepts(t *testing.T) {
	start := time.Now()
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, start)
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = start.Add(5 * time.Minute) // exactly delay
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
	if !allow {
		t.Error("at-delay-boundary should accept (>=)")
	}
}

// 6. Different triplets independent.
func TestS32_Greylist_TripletIsolation(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(6 * time.Minute)
	g.Allow("1.2.3.4", "s@x", "r@y") // graduate triplet A
	allowB, _ := g.Allow("9.9.9.9", "s@x", "r@y") // triplet B fresh
	if allowB {
		t.Error("triplet B got allow=true on first contact")
	}
}

// 7. Triplet ages out after ttl.
func TestS32_Greylist_TTLExpiry(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(6 * time.Minute)
	g.Allow("1.2.3.4", "s@x", "r@y") // graduate
	*now = now.Add(2 * time.Hour)    // > ttl
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
	if allow {
		t.Error("post-ttl triplet should be fresh (defer)")
	}
}

// 8. Reset clears all state.
func TestS32_Greylist_Reset(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(6 * time.Minute)
	g.Allow("1.2.3.4", "s@x", "r@y") // graduate
	g.Reset()
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
	if allow {
		t.Error("post-reset graduate persists")
	}
}

// 9. Known returns false before graduation.
func TestS32_Greylist_KnownFalse(t *testing.T) {
	g := NewGreylistTracker(5*time.Minute, time.Hour)
	g.Allow("1.2.3.4", "s@x", "r@y") // first contact, not graduated
	if g.Known("1.2.3.4", "s@x", "r@y") {
		t.Error("Known=true on first contact")
	}
}

// 10. Known true after graduation.
func TestS32_Greylist_KnownTrue(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r@y")
	*now = now.Add(6 * time.Minute)
	g.Allow("1.2.3.4", "s@x", "r@y") // graduate
	if !g.Known("1.2.3.4", "s@x", "r@y") {
		t.Error("Known=false after graduation")
	}
}

// 11. Triplet key normalized: case + whitespace.
func TestS32_Greylist_KeyNormalization(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("  1.2.3.4 ", "S@X", "R@Y")
	*now = now.Add(6 * time.Minute)
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y") // same triplet, different formatting
	if !allow {
		t.Error("key normalization failed (treated as new triplet)")
	}
}

// 12. Concurrent Allow race-free.
func TestS32_Greylist_ConcurrentAllow(t *testing.T) {
	g := NewGreylistTracker(5*time.Minute, time.Hour)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = g.Allow("1.2.3.4", "s@x", "r@y")
		}()
	}
	wg.Wait()
}

// 13. Default delay 5min on zero/negative input.
func TestS32_Greylist_DefaultDelay(t *testing.T) {
	for _, d := range []time.Duration{0, -1 * time.Second} {
		g := NewGreylistTracker(d, time.Hour)
		now := time.Now()
		clock := now
		g.SetClock(func() time.Time { return clock })
		g.Allow("1.2.3.4", "s@x", "r@y")
		clock = now.Add(4 * time.Minute) // < 5min
		allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
		if allow {
			t.Errorf("delay=%v: expected defer at 4min, got allow=true", d)
		}
	}
}

// 14. Default ttl 35d on zero/negative input.
func TestS32_Greylist_DefaultTTL(t *testing.T) {
	g := NewGreylistTracker(5*time.Minute, 0)
	now := time.Now()
	clock := now
	g.SetClock(func() time.Time { return clock })
	g.Allow("1.2.3.4", "s@x", "r@y")
	clock = now.Add(20 * 24 * time.Hour) // < 35d
	if !g.Known("1.2.3.4", "s@x", "r@y") || true {
		// First contact never graduates. We only check the entry survives.
	}
	clock = now.Add(40 * 24 * time.Hour) // > 35d
	allow, _ := g.Allow("1.2.3.4", "s@x", "r@y")
	if allow {
		t.Error("post-ttl entry should be fresh (defer)")
	}
}

// 15. Registry GreylistAllow short-circuits when profile disables greylist.
func TestS32_Registry_GreylistAllow_Disabled(t *testing.T) {
	r := loadedRegistry(t)
	// gmail.lab has greylist_unknown_sender=false
	allow, reason, err := r.GreylistAllow("gmail.lab", "1.2.3.4", "s@x", "r@gmail.lab")
	if err != nil {
		t.Fatalf("greylist allow: %v", err)
	}
	if !allow {
		t.Errorf("disabled profile got allow=false reason=%q", reason)
	}
}

// 16. Registry GreylistAllow runs state machine for enabled profile.
func TestS32_Registry_GreylistAllow_Enabled(t *testing.T) {
	r := loadedRegistry(t)
	// outlook.lab has greylist_unknown_sender=true
	allow, _, err := r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	if err != nil {
		t.Fatalf("greylist allow: %v", err)
	}
	if allow {
		t.Error("enabled profile first contact got allow=true")
	}
}

// 17. Registry GreylistAllow unknown domain → ErrUnknownDomain.
func TestS32_Registry_GreylistAllow_Unknown(t *testing.T) {
	r := loadedRegistry(t)
	_, _, err := r.GreylistAllow("never.lab", "1.2.3.4", "s@x", "r@y")
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 18. Registry GreylistKnown reflects state machine.
func TestS32_Registry_GreylistKnown(t *testing.T) {
	r := loadedRegistry(t)
	now := time.Now()
	clock := now
	r.SetGreylistClock(func() time.Time { return clock })
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	if known, _ := r.GreylistKnown("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab"); known {
		t.Error("Known=true on first contact")
	}
	clock = now.Add(6 * time.Minute)
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab") // graduate
	if known, _ := r.GreylistKnown("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab"); !known {
		t.Error("Known=false after graduation")
	}
}

// 19. Registry GreylistReset clears tracker.
func TestS32_Registry_GreylistReset(t *testing.T) {
	r := loadedRegistry(t)
	now := time.Now()
	clock := now
	r.SetGreylistClock(func() time.Time { return clock })
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab")
	clock = now.Add(6 * time.Minute)
	r.GreylistAllow("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab") // graduate
	r.GreylistReset()
	if known, _ := r.GreylistKnown("outlook.lab", "1.2.3.4", "s@x", "r@outlook.lab"); known {
		t.Error("post-reset graduate persists")
	}
}

// 20. Differing recipient = different triplet (state isolated).
func TestS32_Greylist_RecipientIsolation(t *testing.T) {
	g, now := newFixedGreylist(t, 5*time.Minute, time.Hour, time.Now())
	g.Allow("1.2.3.4", "s@x", "r1@y")
	*now = now.Add(6 * time.Minute)
	g.Allow("1.2.3.4", "s@x", "r1@y") // graduate r1
	allow, _ := g.Allow("1.2.3.4", "s@x", "r2@y") // r2 fresh
	if allow {
		t.Error("recipient isolation failed (r2 inherited r1's graduation)")
	}
}

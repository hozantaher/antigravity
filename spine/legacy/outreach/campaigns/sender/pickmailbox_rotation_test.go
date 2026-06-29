package sender

import (
	"fmt"
	"common/config"
	"testing"
	"time"
)

// ─── pickMailbox fair-rotation matrix ────────────────────────────────────────
//
// Extends the existing registry/circuit-breaker/state tests with a pure focus
// on round-robin fairness: does pickMailbox visit every eligible mailbox
// before repeating, does currentIdx advance correctly, how does it handle
// pools of various sizes, capacity exhaustion, and partial disqualification.

func mbs(n int, perMailboxCap int) []config.MailboxConfig {
	out := make([]config.MailboxConfig, n)
	for i := range out {
		out[i] = config.MailboxConfig{
			Address:    fmt.Sprintf("m%d@sender.test", i+1),
			DailyLimit: perMailboxCap,
		}
	}
	return out
}

func TestPickMailbox_Rotation_VisitsAllThenWraps(t *testing.T) {
	pool := mbs(5, 10)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})

	// First 5 picks must yield 5 different mailboxes.
	seen := map[string]int{}
	for i := 0; i < 5; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		seen[mb.Address]++
		// Simulate send so the sentCount increments (pickMailbox does not
		// do this itself). Without increment, the same mailbox would keep
		// being selected.
		e.mu.Lock()
		e.sentCounts[mb.Address]++
		e.mu.Unlock()
	}
	if len(seen) != 5 {
		t.Errorf("expected 5 distinct mailboxes in first 5 picks, got %d distinct: %v", len(seen), seen)
	}
}

func TestPickMailbox_Rotation_Over24MailboxPool(t *testing.T) {
	pool := mbs(24, 5)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})

	seen := map[string]int{}
	for i := 0; i < 24; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		seen[mb.Address]++
		e.mu.Lock()
		e.sentCounts[mb.Address]++
		e.mu.Unlock()
	}
	if len(seen) != 24 {
		t.Errorf("24 picks should hit 24 distinct mailboxes, got %d", len(seen))
	}
}

func TestPickMailbox_Rotation_AfterAllAtCapReturnsError(t *testing.T) {
	pool := mbs(3, 1)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})

	// Burn all capacity.
	for i := 0; i < 3; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d] before cap: %v", i, err)
		}
		e.mu.Lock()
		e.sentCounts[mb.Address] = 1
		e.mu.Unlock()
	}

	if _, err := e.pickMailbox(""); err == nil {
		t.Error("all mailboxes at cap: expected error, got nil")
	}
}

func TestPickMailbox_Rotation_SingletonPoolAlwaysPicksSame(t *testing.T) {
	pool := mbs(1, 100)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	for i := 0; i < 10; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		if mb.Address != "m1@sender.test" {
			t.Errorf("singleton pool: picked %s, want m1@sender.test", mb.Address)
		}
		e.mu.Lock()
		e.sentCounts[mb.Address]++
		e.mu.Unlock()
	}
}

func TestPickMailbox_Rotation_EmptyPoolReturnsError(t *testing.T) {
	e := NewEngine(nil, config.SendingConfig{}, config.SafetyConfig{})
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("empty pool: expected error, got nil")
	}
}

func TestPickMailbox_Rotation_PerMailboxCapBoundary(t *testing.T) {
	caps := []int{1, 2, 5, 10, 100}
	for _, cap_ := range caps {
		t.Run(fmt.Sprintf("cap=%d", cap_), func(t *testing.T) {
			pool := mbs(3, cap_)
			e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})

			// 3 mailboxes × cap_ should be exactly enough picks.
			for i := 0; i < 3*cap_; i++ {
				mb, err := e.pickMailbox("")
				if err != nil {
					t.Fatalf("pick[%d]: %v", i, err)
				}
				e.mu.Lock()
				e.sentCounts[mb.Address]++
				e.mu.Unlock()
			}
			// One more should fail.
			if _, err := e.pickMailbox(""); err == nil {
				t.Error("after exact cap: expected error, got nil")
			}
		})
	}
}

func TestPickMailbox_Rotation_ZeroCapImmediatelyErrors(t *testing.T) {
	pool := mbs(3, 0)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("DailyLimit=0: expected immediate error, got nil")
	}
}

func TestPickMailbox_Rotation_NegativeCapImmediatelyErrors(t *testing.T) {
	pool := mbs(3, -5)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("DailyLimit<0: expected immediate error, got nil")
	}
}

func TestPickMailbox_Rotation_DailyCapOracleExhausts(t *testing.T) {
	pool := mbs(3, 100)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	// Oracle reports m2 as exhausted — pickMailbox should skip it.
	e.WithDailyCapFunc(func(addr string) (bool, error) {
		return addr == "m2@sender.test", nil
	})
	seen := map[string]int{}
	for i := 0; i < 8; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		seen[mb.Address]++
		e.mu.Lock()
		e.sentCounts[mb.Address]++
		e.mu.Unlock()
	}
	if seen["m2@sender.test"] != 0 {
		t.Errorf("m2 should be skipped by oracle, got %d picks", seen["m2@sender.test"])
	}
}

func TestPickMailbox_Rotation_DailyCapOracleFailOpen(t *testing.T) {
	pool := mbs(2, 100)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	// Oracle errors — pickMailbox must proceed without opinion (fail-open).
	e.WithDailyCapFunc(func(addr string) (bool, error) {
		return false, fmt.Errorf("db down")
	})
	// Should still succeed.
	if _, err := e.pickMailbox(""); err != nil {
		t.Errorf("oracle error must fail-open, got %v", err)
	}
}

func TestPickMailbox_Rotation_CooldownUntilSkips(t *testing.T) {
	pool := mbs(2, 100)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	// Cool down m1 until future — pickMailbox should skip.
	e.mu.Lock()
	e.mailboxCooldownUntil["m1@sender.test"] = time.Now().Add(5 * time.Minute)
	e.mu.Unlock()

	for i := 0; i < 5; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		if mb.Address == "m1@sender.test" {
			t.Errorf("pick[%d]: got m1 despite cooldown", i)
		}
		e.mu.Lock()
		e.sentCounts[mb.Address]++
		e.mu.Unlock()
	}
}

func TestPickMailbox_Rotation_CooldownExpiredReinstated(t *testing.T) {
	pool := mbs(2, 100)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	// Cool down m1 in the PAST — pickMailbox should clean up and allow it again.
	e.mu.Lock()
	e.mailboxCooldownUntil["m1@sender.test"] = time.Now().Add(-5 * time.Minute)
	e.mailboxConsecutiveFails["m1@sender.test"] = mailboxFailThreshold
	e.mu.Unlock()

	got := map[string]int{}
	for i := 0; i < 4; i++ {
		mb, err := e.pickMailbox("")
		if err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		got[mb.Address]++
		e.mu.Lock()
		e.sentCounts[mb.Address]++
		e.mu.Unlock()
	}
	if got["m1@sender.test"] == 0 {
		t.Error("expired cooldown: m1 should be reinstated")
	}
	e.mu.Lock()
	_, coolStillSet := e.mailboxCooldownUntil["m1@sender.test"]
	_, failsStillSet := e.mailboxConsecutiveFails["m1@sender.test"]
	e.mu.Unlock()
	if coolStillSet {
		t.Error("expired cooldown should be cleaned from mailboxCooldownUntil")
	}
	if failsStillSet {
		t.Error("expired cooldown should also clear mailboxConsecutiveFails")
	}
}

func TestPickMailbox_Rotation_VariousPoolSizes(t *testing.T) {
	for _, n := range []int{1, 2, 3, 5, 10, 24, 50} {
		t.Run(fmt.Sprintf("n=%d", n), func(t *testing.T) {
			pool := mbs(n, 1)
			e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
			got := map[string]int{}
			for i := 0; i < n; i++ {
				mb, err := e.pickMailbox("")
				if err != nil {
					t.Fatalf("pick[%d]: %v", i, err)
				}
				got[mb.Address]++
				e.mu.Lock()
				e.sentCounts[mb.Address]++
				e.mu.Unlock()
			}
			if len(got) != n {
				t.Errorf("n=%d: should yield %d distinct, got %d", n, n, len(got))
			}
		})
	}
}

func TestPickMailbox_Rotation_WarmupLimiterOverridesConfig(t *testing.T) {
	pool := []config.MailboxConfig{
		{Address: "m1@sender.test", DailyLimit: 1000}, // config says 1000
	}
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})

	// Warmup limiter clamps to 2.
	e.WithWarmupLimiter(warmupFn(func(addr string, cfgLimit int) (int, error) {
		return 2, nil
	}))

	for i := 0; i < 2; i++ {
		if _, err := e.pickMailbox(""); err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		e.mu.Lock()
		e.sentCounts["m1@sender.test"]++
		e.mu.Unlock()
	}
	// Third pick must fail — warmup limiter tightened to 2.
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("after warmup limit reached: expected error, got nil")
	}
}

type warmupFn func(address string, fallback int) (int, error)

func (f warmupFn) LimitForMailbox(addr string, fallback int) (int, error) {
	return f(addr, fallback)
}

func TestPickMailbox_Rotation_WarmupLimiterErrorFallsBack(t *testing.T) {
	pool := []config.MailboxConfig{{Address: "m1@sender.test", DailyLimit: 3}}
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	// DB error → keep config limit (3).
	e.WithWarmupLimiter(warmupFn(func(addr string, cfgLimit int) (int, error) {
		return 0, fmt.Errorf("db boom")
	}))
	for i := 0; i < 3; i++ {
		if _, err := e.pickMailbox(""); err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		e.mu.Lock()
		e.sentCounts["m1@sender.test"]++
		e.mu.Unlock()
	}
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("after config limit 3 reached: expected error")
	}
}

func TestPickMailbox_Rotation_WarmupDayOverridesDailyLimit(t *testing.T) {
	// WarmupDay > 0 swaps in engine.warmupLimit(day). Day 1 = 10.
	pool := []config.MailboxConfig{
		{Address: "m1@sender.test", DailyLimit: 1000, WarmupDay: 1},
	}
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	for i := 0; i < 10; i++ {
		if _, err := e.pickMailbox(""); err != nil {
			t.Fatalf("pick[%d]: %v", i, err)
		}
		e.mu.Lock()
		e.sentCounts["m1@sender.test"]++
		e.mu.Unlock()
	}
	if _, err := e.pickMailbox(""); err == nil {
		t.Error("after warmup day 1 limit (10) reached: expected error")
	}
}

func TestPickMailbox_Rotation_WarmupDayMatrix(t *testing.T) {
	cases := []struct {
		day   int
		limit int
	}{
		{1, 10}, {2, 20}, {3, 40}, {7, 120}, {14, 150},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("day=%d", c.day), func(t *testing.T) {
			pool := []config.MailboxConfig{
				{Address: "m1@sender.test", DailyLimit: 9999, WarmupDay: c.day},
			}
			e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
			for i := 0; i < c.limit; i++ {
				if _, err := e.pickMailbox(""); err != nil {
					t.Fatalf("pick[%d]: %v", i, err)
				}
				e.mu.Lock()
				e.sentCounts["m1@sender.test"]++
				e.mu.Unlock()
			}
			if _, err := e.pickMailbox(""); err == nil {
				t.Errorf("day=%d expected cap=%d: one more pick should fail", c.day, c.limit)
			}
		})
	}
}

func TestPickMailbox_Rotation_CurrentIdxAdvances(t *testing.T) {
	pool := mbs(4, 5)
	e := NewEngine(pool, config.SendingConfig{}, config.SafetyConfig{})
	// After 4 picks, currentIdx should have wrapped.
	for i := 0; i < 4; i++ {
		if _, err := e.pickMailbox(""); err != nil {
			t.Fatal(err)
		}
		e.mu.Lock()
		e.sentCounts[pool[i].Address]++
		e.mu.Unlock()
	}
	e.mu.Lock()
	idx := e.currentIdx
	e.mu.Unlock()
	// After 4 sequential picks over 4 mailboxes, currentIdx should be 0 again.
	if idx != 0 {
		t.Errorf("currentIdx after full cycle: got %d, want 0", idx)
	}
}

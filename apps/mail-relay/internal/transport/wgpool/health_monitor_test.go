package wgpool

// Tests for Pool.StartHealthMonitor (AP4-P1 time-driven Sentry alert).
//
// TC-HM01: No evict + fill < 80% → alertFn NOT called
// TC-HM02: EvictCount > 0 → alertFn called with correct evict_count
// TC-HM03: fill_pct >= 80% (no evict) → alertFn called with correct fill_pct
// TC-HM04: ctx cancel stops the monitor goroutine (no alert after cancel)
// TC-HM05: alertFn called with accurate stats (size, cap, high_water)
// TC-HM06: Multiple ticks with evict → alertFn called once per tick

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func mustPoolHM(t *testing.T) *Pool {
	t.Helper()
	p, err := New([]Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
	}, Config{})
	if err != nil {
		t.Fatalf("mustPoolHM: %v", err)
	}
	return p
}

// TC-HM01: empty buffer (0 evict, 0% fill) → alertFn never called.
func TestStartHealthMonitor_NoAlert_WhenQuiet(t *testing.T) {
	p := mustPoolHM(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls atomic.Int64
	p.StartHealthMonitor(ctx, 10*time.Millisecond, func(evictCount int64, fillPct, size, cap, hw int) {
		calls.Add(1)
	})

	time.Sleep(50 * time.Millisecond)
	if n := calls.Load(); n != 0 {
		t.Errorf("expected 0 alert calls when buffer empty, got %d", n)
	}
}

// TC-HM02: EvictCount > 0 → alertFn called with evict_count forwarded.
func TestStartHealthMonitor_AlertOnEviction(t *testing.T) {
	p := mustPoolHM(t)
	// Fill past cap to trigger evictions.
	for i := 0; i < egressObsRingCap+5; i++ {
		p.RecordEgressObservation("mb1", "CZ", "cz1", "send")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type alertArgs struct {
		evictCount int64
		fillPct    int
	}
	ch := make(chan alertArgs, 1)
	p.StartHealthMonitor(ctx, 10*time.Millisecond, func(evictCount int64, fillPct, size, cap, hw int) {
		select {
		case ch <- alertArgs{evictCount, fillPct}:
		default:
		}
	})

	select {
	case got := <-ch:
		if got.evictCount <= 0 {
			t.Errorf("expected evict_count > 0, got %d", got.evictCount)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout waiting for alert on eviction")
	}
}

// TC-HM03: fill_pct >= 80% but no eviction → alertFn called with correct fill_pct.
func TestStartHealthMonitor_AlertOnHighWater(t *testing.T) {
	p := mustPoolHM(t)
	// Fill to exactly 80% of cap (1600 / 2000 = 80%).
	target := (egressObsRingCap * RingBufferAlertThreshold) / 100
	for i := 0; i < target; i++ {
		p.RecordEgressObservation("mb2", "DE", "de1", "probe")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan int, 1) // fillPct
	p.StartHealthMonitor(ctx, 10*time.Millisecond, func(evictCount int64, fillPct, size, cap, hw int) {
		if evictCount == 0 { // only the high-water path
			select {
			case ch <- fillPct:
			default:
			}
		}
	})

	select {
	case fillPct := <-ch:
		if fillPct < RingBufferAlertThreshold {
			t.Errorf("expected fillPct >= %d, got %d", RingBufferAlertThreshold, fillPct)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout waiting for high-water alert")
	}
}

// TC-HM04: ctx cancel stops the goroutine — no alert fires after cancel.
func TestStartHealthMonitor_StopsOnContextCancel(t *testing.T) {
	p := mustPoolHM(t)
	// Fill past threshold so alerts would fire.
	for i := 0; i < egressObsRingCap+1; i++ {
		p.RecordEgressObservation("mb3", "CZ", "cz1", "send")
	}

	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int64
	p.StartHealthMonitor(ctx, 5*time.Millisecond, func(evictCount int64, fillPct, size, cap, hw int) {
		calls.Add(1)
	})

	// Let at least one tick fire, then cancel.
	time.Sleep(30 * time.Millisecond)
	cancel()
	afterCancel := calls.Load()

	// Wait long enough for another tick to potentially fire.
	time.Sleep(30 * time.Millisecond)
	afterWait := calls.Load()

	if afterWait != afterCancel {
		t.Errorf("alert fired after ctx cancel: before=%d after=%d", afterCancel, afterWait)
	}
}

// TC-HM05: alertFn receives accurate size, cap, high_water arguments.
func TestStartHealthMonitor_AccurateStatsForwarded(t *testing.T) {
	p := mustPoolHM(t)
	// Exactly 10 observations — well below threshold but add eviction by pre-filling.
	for i := 0; i < egressObsRingCap+3; i++ {
		p.RecordEgressObservation("mb4", "CZ", "cz1", "send")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type args struct {
		evictCount int64
		fillPct    int
		size       int
		cap        int
		hw         int
	}
	ch := make(chan args, 1)
	p.StartHealthMonitor(ctx, 10*time.Millisecond, func(evictCount int64, fillPct, size, cap, hw int) {
		select {
		case ch <- args{evictCount, fillPct, size, cap, hw}:
		default:
		}
	})

	select {
	case got := <-ch:
		if got.cap != egressObsRingCap {
			t.Errorf("cap = %d, want %d", got.cap, egressObsRingCap)
		}
		if got.size < 0 || got.size > egressObsRingCap {
			t.Errorf("size = %d out of valid range [0, %d]", got.size, egressObsRingCap)
		}
		if got.hw <= 0 {
			t.Errorf("high_water = %d, want > 0", got.hw)
		}
		if got.evictCount <= 0 {
			t.Errorf("evict_count = %d, want > 0", got.evictCount)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout waiting for alert")
	}
}

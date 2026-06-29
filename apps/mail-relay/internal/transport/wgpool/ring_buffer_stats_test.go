package wgpool

// Sprint AP4-HW — ring buffer high-water mark + evict count tracking.
//
// Tests: TC-HW01..TC-HW08 covering initial state, high-water tracking,
// evict counter, EgressObsStatsSnapshot accuracy, fill percentage,
// concurrent safety, drain resets size (not high-water), and threshold check.

import (
	"sync"
	"testing"
)

func makeSingleEndpointPool(t *testing.T) *Pool {
	t.Helper()
	p, err := New([]Endpoint{
		{Label: "cz1", SocksAddr: "127.0.0.1:10801", Country: "CZ"},
	}, Config{})
	if err != nil {
		t.Fatalf("makeSingleEndpointPool: %v", err)
	}
	return p
}

// TC-HW01: Fresh pool has all ring buffer stats at zero.
func TestEgressObsStats_InitialState(t *testing.T) {
	p := makeSingleEndpointPool(t)
	s := p.EgressObsStatsSnapshot()

	if s.RingBufferSize != 0 {
		t.Errorf("RingBufferSize initial = %d, want 0", s.RingBufferSize)
	}
	if s.RingBufferHighWater != 0 {
		t.Errorf("RingBufferHighWater initial = %d, want 0", s.RingBufferHighWater)
	}
	if s.EvictCount != 0 {
		t.Errorf("EvictCount initial = %d, want 0", s.EvictCount)
	}
	if s.RingBufferCap != egressObsRingCap {
		t.Errorf("RingBufferCap = %d, want %d", s.RingBufferCap, egressObsRingCap)
	}
	if s.RingBufferFillPct != 0 {
		t.Errorf("RingBufferFillPct initial = %d, want 0", s.RingBufferFillPct)
	}
}

// TC-HW02: High-water mark rises with insertions and never decreases.
func TestEgressObsStats_HighWaterRises(t *testing.T) {
	p := makeSingleEndpointPool(t)

	for i := 0; i < 5; i++ {
		p.RecordEgressObservation("42", "CZ", "cz1", "send")
	}
	s5 := p.EgressObsStatsSnapshot()
	if s5.RingBufferHighWater != 5 {
		t.Errorf("high-water after 5 inserts = %d, want 5", s5.RingBufferHighWater)
	}

	// Drain — size drops, high-water stays
	p.DrainEgressObservations()
	sAfterDrain := p.EgressObsStatsSnapshot()
	if sAfterDrain.RingBufferSize != 0 {
		t.Errorf("size after drain = %d, want 0", sAfterDrain.RingBufferSize)
	}
	if sAfterDrain.RingBufferHighWater != 5 {
		t.Errorf("high-water after drain = %d, want 5 (must not decrease)", sAfterDrain.RingBufferHighWater)
	}
}

// TC-HW03: EvictCount increments when ring buffer overflows.
func TestEgressObsStats_EvictCountIncrements(t *testing.T) {
	p := makeSingleEndpointPool(t)

	// Fill exactly to cap — no eviction yet
	for i := 0; i < egressObsRingCap; i++ {
		p.RecordEgressObservation("1", "CZ", "cz1", "send")
	}
	s := p.EgressObsStatsSnapshot()
	if s.EvictCount != 0 {
		t.Errorf("evict count at cap = %d, want 0", s.EvictCount)
	}

	// One more — triggers first eviction
	p.RecordEgressObservation("2", "CZ", "cz1", "send")
	s2 := p.EgressObsStatsSnapshot()
	if s2.EvictCount != 1 {
		t.Errorf("evict count after overflow = %d, want 1", s2.EvictCount)
	}

	// Three more evictions
	for i := 0; i < 3; i++ {
		p.RecordEgressObservation("3", "CZ", "cz1", "send")
	}
	s5 := p.EgressObsStatsSnapshot()
	if s5.EvictCount != 4 {
		t.Errorf("evict count after 4 overflows = %d, want 4", s5.EvictCount)
	}
}

// TC-HW04: FillPct equals (size * 100) / cap, rounded down.
func TestEgressObsStats_FillPctAccurate(t *testing.T) {
	p := makeSingleEndpointPool(t)

	// Insert exactly 80% of cap
	target := (egressObsRingCap * 80) / 100
	for i := 0; i < target; i++ {
		p.RecordEgressObservation("42", "CZ", "cz1", "send")
	}
	s := p.EgressObsStatsSnapshot()
	// Due to integer division the pct may be ±1 from 80
	if s.RingBufferFillPct < 79 || s.RingBufferFillPct > 81 {
		t.Errorf("fill pct = %d, want ~80", s.RingBufferFillPct)
	}
}

// TC-HW05: Stats snapshot is consistent under concurrent writes.
func TestEgressObsStats_ConcurrentSafety(t *testing.T) {
	p := makeSingleEndpointPool(t)

	const goroutines = 8
	const perGoroutine = 100
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				p.RecordEgressObservation("99", "CZ", "cz1", "probe")
				p.EgressObsStatsSnapshot() // must not race
			}
		}()
	}
	wg.Wait()
	// No race detected = pass (run with -race flag)
}

// TC-HW06: DrainEgressObservations resets size to zero but keeps high-water.
func TestEgressObsStats_DrainResetsSize(t *testing.T) {
	p := makeSingleEndpointPool(t)

	for i := 0; i < 10; i++ {
		p.RecordEgressObservation("1", "CZ", "cz1", "send")
	}
	pre := p.EgressObsStatsSnapshot()
	if pre.RingBufferHighWater != 10 {
		t.Fatalf("pre-drain high-water = %d, want 10", pre.RingBufferHighWater)
	}

	p.DrainEgressObservations()
	post := p.EgressObsStatsSnapshot()
	if post.RingBufferSize != 0 {
		t.Errorf("post-drain size = %d, want 0", post.RingBufferSize)
	}
	if post.RingBufferHighWater != 10 {
		t.Errorf("post-drain high-water = %d, want 10", post.RingBufferHighWater)
	}
	if post.RingBufferFillPct != 0 {
		t.Errorf("post-drain fill-pct = %d, want 0", post.RingBufferFillPct)
	}
}

// TC-HW07: Full cap produces 100% fill pct.
func TestEgressObsStats_FullCapFillPct100(t *testing.T) {
	p := makeSingleEndpointPool(t)
	for i := 0; i < egressObsRingCap; i++ {
		p.RecordEgressObservation("1", "CZ", "cz1", "send")
	}
	s := p.EgressObsStatsSnapshot()
	if s.RingBufferFillPct != 100 {
		t.Errorf("fill pct at cap = %d, want 100", s.RingBufferFillPct)
	}
}

// TC-HW08: High-water threshold check — size >= 80% returns true.
func TestEgressObsStats_HighWaterThresholdCheck(t *testing.T) {
	p := makeSingleEndpointPool(t)
	threshold := (egressObsRingCap * 80) / 100

	// Below threshold
	for i := 0; i < threshold-1; i++ {
		p.RecordEgressObservation("1", "CZ", "cz1", "send")
	}
	below := p.EgressObsStatsSnapshot()
	if below.RingBufferFillPct >= 80 {
		t.Errorf("expected below 80%%, got %d%%", below.RingBufferFillPct)
	}

	// At threshold
	p.RecordEgressObservation("1", "CZ", "cz1", "send")
	at := p.EgressObsStatsSnapshot()
	if at.RingBufferFillPct < 80 {
		t.Errorf("expected >=80%% at threshold, got %d%%", at.RingBufferFillPct)
	}
}

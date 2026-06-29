package admin

import (
	"testing"
	"testing/quick"
	"time"
)

// --- percentile unit tests ---

func TestPercentile_EmptySlice(t *testing.T) {
	if got := percentile(nil, 50); got != 0 {
		t.Errorf("percentile(nil,50) = %d, want 0", got)
	}
}

func TestPercentile_SingleElement(t *testing.T) {
	if got := percentile([]int64{7}, 50); got != 7 {
		t.Errorf("percentile([7],50) = %d, want 7", got)
	}
}

func TestPercentile_OddSlice(t *testing.T) {
	// p50 of [1,2,3,4,5] should be 3 (nearest-rank: ceil(0.5*5)=3rd element = 3)
	samples := []int64{5, 1, 3, 2, 4}
	tests := []struct {
		p    int
		want int64
	}{
		{50, 3},
		{0, 1},
		{100, 5},
	}
	for _, tt := range tests {
		got := percentile(samples, tt.p)
		if got != tt.want {
			t.Errorf("percentile(%v, %d) = %d, want %d", samples, tt.p, got, tt.want)
		}
	}
}

func TestPercentile_P95P99(t *testing.T) {
	// 100 elements: 1..100
	samples := make([]int64, 100)
	for i := range samples {
		samples[i] = int64(i + 1)
	}
	tests := []struct {
		p    int
		want int64
	}{
		{50, 50},
		{95, 95},
		{99, 99},
	}
	for _, tt := range tests {
		got := percentile(samples, tt.p)
		if got != tt.want {
			t.Errorf("p%d = %d, want %d", tt.p, got, tt.want)
		}
	}
}

// --- Stats counter tests ---

func TestStats_IncRequests(t *testing.T) {
	s := NewStats()
	for i := 0; i < 5; i++ {
		s.IncRequests()
	}
	snap := s.Snapshot()
	if snap.RequestsTotal != 5 {
		t.Errorf("RequestsTotal = %d, want 5", snap.RequestsTotal)
	}
}

func TestStats_AddBytes(t *testing.T) {
	s := NewStats()
	s.AddBytes(1024)
	s.AddBytes(512)
	snap := s.Snapshot()
	if snap.BytesForwarded != 1536 {
		t.Errorf("BytesForwarded = %d, want 1536", snap.BytesForwarded)
	}
}

func TestStats_ObserveLatency_Percentiles(t *testing.T) {
	s := NewStats()
	// Record 5 samples: 10, 20, 30, 40, 50 ms
	for _, ms := range []time.Duration{10, 20, 30, 40, 50} {
		s.ObserveLatency(ms * time.Millisecond)
	}
	snap := s.Snapshot()
	// p50 of [10,20,30,40,50] = 30
	if snap.LatencyP50Ms != 30 {
		t.Errorf("LatencyP50Ms = %d, want 30", snap.LatencyP50Ms)
	}
	if snap.LatencyP95Ms != 50 {
		t.Errorf("LatencyP95Ms = %d, want 50", snap.LatencyP95Ms)
	}
	if snap.LatencyP99Ms != 50 {
		t.Errorf("LatencyP99Ms = %d, want 50", snap.LatencyP99Ms)
	}
}

func TestStats_UptimePositive(t *testing.T) {
	s := NewStats()
	snap := s.Snapshot()
	if snap.UptimeSeconds < 0 {
		t.Errorf("UptimeSeconds = %d, want >= 0", snap.UptimeSeconds)
	}
}

func TestStats_RingBufferWraps(t *testing.T) {
	s := NewStats()
	// Fill more than ringSize samples; the last ringSize should dominate.
	for i := 0; i < ringSize+100; i++ {
		s.ObserveLatency(time.Duration(i+1) * time.Millisecond)
	}
	snap := s.Snapshot()
	// After wrapping, p99 should be close to the last recorded values (near ringSize+100).
	// We only assert it's non-zero and plausible.
	if snap.LatencyP99Ms <= 0 {
		t.Errorf("LatencyP99Ms = %d after ring wrap, want > 0", snap.LatencyP99Ms)
	}
}

// --- percentile edge / boundary cases ---

// TestPercentile_AboveP100_ClampsToMax covers the rank > n branch.
// With p > 100 the nearest-rank formula yields rank > n; the code clamps it to n.
func TestPercentile_AboveP100_ClampsToMax(t *testing.T) {
	samples := []int64{1, 2, 3, 4, 5}
	// p=101 → rank = (101*5+99)/100 = 604/100 = 6 > 5; must clamp to max (5).
	got := percentile(samples, 101)
	if got != 5 {
		t.Errorf("percentile(samples, 101) = %d, want 5 (clamped to max)", got)
	}
	// p=200 → extreme over-bound, still clamped to max.
	got = percentile(samples, 200)
	if got != 5 {
		t.Errorf("percentile(samples, 200) = %d, want 5 (clamped to max)", got)
	}
}

// TestPercentile_P0_ClampsToMin covers the rank < 1 branch (p=0).
func TestPercentile_P0_ClampsToMin(t *testing.T) {
	samples := []int64{10, 20, 30}
	// p=0 → rank = (0*3+99)/100 = 0; clamps to 1; returns sorted[0] = 10.
	got := percentile(samples, 0)
	if got != 10 {
		t.Errorf("percentile(samples, 0) = %d, want 10", got)
	}
}

// TestPercentile_P100_ReturnsMax confirms p=100 returns the maximum element.
func TestPercentile_P100_ReturnsMax(t *testing.T) {
	samples := []int64{3, 1, 4, 1, 5, 9, 2, 6}
	got := percentile(samples, 100)
	if got != 9 {
		t.Errorf("percentile(samples, 100) = %d, want 9", got)
	}
}

// TestPercentile_TwoElements checks boundary behaviour with exactly 2 elements.
func TestPercentile_TwoElements(t *testing.T) {
	samples := []int64{7, 3}
	// p50 → rank = ceil(0.5*2) = 1 → sorted[0] = 3
	if got := percentile(samples, 50); got != 3 {
		t.Errorf("percentile([7,3], 50) = %d, want 3", got)
	}
	// p100 → rank = 2 → sorted[1] = 7
	if got := percentile(samples, 100); got != 7 {
		t.Errorf("percentile([7,3], 100) = %d, want 7", got)
	}
}

// TestPercentile_NeverPanics_Property runs percentile with arbitrary inputs.
func TestPercentile_NeverPanics_Property(t *testing.T) {
	f := func(samples []int64, p uint8) bool {
		defer func() { recover() }()
		percentile(samples, int(p))
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("percentile panicked: %v", err)
	}
}

// TestPercentile_NeverPanics_NegativeP exercises p < 0 inputs.
func TestPercentile_NeverPanics_NegativeP(t *testing.T) {
	samples := []int64{1, 2, 3}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("percentile panicked on negative p: %v", r)
		}
	}()
	_ = percentile(samples, -1)
}

// TestStats_Snapshot_AllFieldsPopulated verifies every field is non-zero after recording.
func TestStats_Snapshot_AllFieldsPopulated(t *testing.T) {
	s := NewStats()
	s.IncRequests()
	s.AddBytes(512)
	s.ObserveLatency(100 * time.Millisecond)

	snap := s.Snapshot()
	if snap.RequestsTotal != 1 {
		t.Errorf("RequestsTotal = %d, want 1", snap.RequestsTotal)
	}
	if snap.BytesForwarded != 512 {
		t.Errorf("BytesForwarded = %d, want 512", snap.BytesForwarded)
	}
	if snap.LatencyP50Ms != 100 {
		t.Errorf("LatencyP50Ms = %d, want 100", snap.LatencyP50Ms)
	}
	if snap.UptimeSeconds < 0 {
		t.Errorf("UptimeSeconds = %d, want >= 0", snap.UptimeSeconds)
	}
}

// TestStats_EmptySnapshot_LatenciesAreZero verifies zero-value percentiles before any observation.
func TestStats_EmptySnapshot_LatenciesAreZero(t *testing.T) {
	s := NewStats()
	snap := s.Snapshot()
	if snap.LatencyP50Ms != 0 || snap.LatencyP95Ms != 0 || snap.LatencyP99Ms != 0 {
		t.Errorf("expected zero latency percentiles, got p50=%d p95=%d p99=%d",
			snap.LatencyP50Ms, snap.LatencyP95Ms, snap.LatencyP99Ms)
	}
}

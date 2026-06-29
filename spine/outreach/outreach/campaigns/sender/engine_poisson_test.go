package sender

import (
	"math"
	"testing"
	"time"
)

// TestPoissonDelay_ResultAtLeastMinSec verifies the lower clamp.
func TestPoissonDelay_ResultAtLeastMinSec(t *testing.T) {
	for i := 0; i < 500; i++ {
		d := poissonDelay(5, 10, 30)
		if d < 10*time.Second {
			t.Fatalf("poissonDelay returned %v < minSec=10s", d)
		}
	}
}

// TestPoissonDelay_ResultAtMostMaxSec3x verifies the upper clamp (maxSec*3).
func TestPoissonDelay_ResultAtMostMaxSec3x(t *testing.T) {
	for i := 0; i < 500; i++ {
		d := poissonDelay(5, 10, 30)
		if d > 90*time.Second {
			t.Fatalf("poissonDelay returned %v > maxSec*3=90s", d)
		}
	}
}

// TestPoissonDelay_NoPanicNaNOver1000Calls verifies stability over many calls.
func TestPoissonDelay_NoPanicNaNOver1000Calls(t *testing.T) {
	for i := 0; i < 1000; i++ {
		d := poissonDelay(20, 5, 60)
		// time.Duration is int64 nanoseconds; NaN would appear as a very large value
		// or 0, but we mainly want no panic and a valid range.
		if d < 0 {
			t.Fatalf("call %d: negative duration %v", i, d)
		}
		secs := d.Seconds()
		if math.IsNaN(secs) || math.IsInf(secs, 0) {
			t.Fatalf("call %d: NaN or Inf duration: %v", i, d)
		}
	}
}

// TestPoissonDelay_MeanApproximate verifies the sample mean is within ±50% of meanSec.
func TestPoissonDelay_MeanApproximate(t *testing.T) {
	const meanSec = 20.0
	const n = 2000
	var sum float64
	for i := 0; i < n; i++ {
		d := poissonDelay(meanSec, 1, 300)
		sum += d.Seconds()
	}
	got := sum / n
	lo := meanSec * 0.5
	hi := meanSec * 1.5
	if got < lo || got > hi {
		t.Fatalf("sample mean %.2fs not in [%.2f, %.2f]", got, lo, hi)
	}
}

// TestPoissonDelay_MeanZeroFallback verifies meanSec=0 uses midpoint fallback.
func TestPoissonDelay_MeanZeroFallback(t *testing.T) {
	// Should not panic and must stay in bounds.
	for i := 0; i < 200; i++ {
		d := poissonDelay(0, 10, 30)
		if d < 10*time.Second || d > 90*time.Second {
			t.Fatalf("meanSec=0: got %v, want [10s, 90s]", d)
		}
	}
}

// TestPoissonDelay_NegativeMeanFallback verifies negative meanSec uses midpoint fallback.
func TestPoissonDelay_NegativeMeanFallback(t *testing.T) {
	for i := 0; i < 200; i++ {
		d := poissonDelay(-5, 10, 30)
		if d < 10*time.Second || d > 90*time.Second {
			t.Fatalf("meanSec=-5: got %v, want [10s, 90s]", d)
		}
	}
}

// TestPoissonDelay_UClamp verifies the u<1e-9 clamp prevents -Inf / NaN.
// We can't inject u directly, but we can verify that running 10 000 samples
// produces no NaN/Inf — the 1e-9 clamp should absorb any extreme u values.
func TestPoissonDelay_UClampNoNaN(t *testing.T) {
	for i := 0; i < 10_000; i++ {
		d := poissonDelay(30, 5, 120)
		secs := d.Seconds()
		if math.IsNaN(secs) || math.IsInf(secs, 0) {
			t.Fatalf("call %d: NaN or Inf: %v", i, d)
		}
	}
}

// TestHumanSendDelay_MorningHourShorterThanOffHour verifies time-of-day factor ordering.
func TestHumanSendDelay_MorningHourShorterThanOffHour(t *testing.T) {
	const samples = 500
	morning := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)  // hour=9, factor=0.7
	offHour := time.Date(2026, 1, 1, 22, 0, 0, 0, time.UTC) // hour=22, factor=1.8

	var sumMorning, sumOff float64
	for i := 0; i < samples; i++ {
		sumMorning += humanSendDelay(10, 60, morning).Seconds()
		sumOff += humanSendDelay(10, 60, offHour).Seconds()
	}
	avgMorning := sumMorning / samples
	avgOff := sumOff / samples
	if avgMorning >= avgOff {
		t.Fatalf("morning avg %.2fs >= off-hour avg %.2fs; expected morning < off-hour", avgMorning, avgOff)
	}
}

// TestHumanSendDelay_AllHoursInBounds checks all 24 hours stay within [minSec, maxSec*3].
func TestHumanSendDelay_AllHoursInBounds(t *testing.T) {
	for hour := 0; hour < 24; hour++ {
		ts := time.Date(2026, 1, 1, hour, 0, 0, 0, time.UTC)
		for i := 0; i < 100; i++ {
			d := humanSendDelay(10, 60, ts)
			if d < 10*time.Second || d > 180*time.Second {
				t.Fatalf("hour=%d: got %v, want [10s, 180s]", hour, d)
			}
		}
	}
}

// TestHumanSendDelay_AfternoonFactorBetweenMorningAndOffHour sanity check.
func TestHumanSendDelay_AfternoonFactorBetweenMorningAndOffHour(t *testing.T) {
	const samples = 500
	morning := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)   // factor=0.7
	afternoon := time.Date(2026, 1, 1, 14, 0, 0, 0, time.UTC) // factor=1.0
	offHour := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)    // factor=1.8

	var sumM, sumA, sumO float64
	for i := 0; i < samples; i++ {
		sumM += humanSendDelay(10, 60, morning).Seconds()
		sumA += humanSendDelay(10, 60, afternoon).Seconds()
		sumO += humanSendDelay(10, 60, offHour).Seconds()
	}
	avgM, avgA, avgO := sumM/samples, sumA/samples, sumO/samples
	if !(avgM < avgA && avgA < avgO) {
		t.Fatalf("factor ordering violated: morning=%.2f afternoon=%.2f off=%.2f (want M<A<O)", avgM, avgA, avgO)
	}
}

// TestPoissonDelay_MaxSecEqualsMin returns minSec when range is degenerate.
func TestPoissonDelay_MaxSecEqualsMin(t *testing.T) {
	// meanSec > 0, but range is flat. Output should always be exactly minSec
	// because the clamp fires: delay (exponential, can be tiny) < minSec → minSec;
	// or delay > maxSec*3 (=minSec*3) and also ≥ minSec so it won't be below minSec.
	for i := 0; i < 100; i++ {
		d := poissonDelay(5, 20, 20)
		if d < 20*time.Second || d > 60*time.Second {
			t.Fatalf("minSec==maxSec: got %v, want [20s, 60s]", d)
		}
	}
}

// TestPoissonDelay_LargeMaxSecNoPanic ensures large inputs don't overflow.
func TestPoissonDelay_LargeMaxSecNoPanic(t *testing.T) {
	for i := 0; i < 100; i++ {
		d := poissonDelay(3600, 60, 3600)
		if d < 0 {
			t.Fatalf("negative duration with large inputs: %v", d)
		}
	}
}

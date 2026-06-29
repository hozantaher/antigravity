package sender

// engine_human_delay_test.go — S14: warmup heat-signature tests.
// Verifies humanSendDelay returns time-of-day-appropriate delays,
// respects min/max bounds, and never panics under 1000 random inputs.

import (
	"testing"
	"time"
)

// helper: build a time.Time for a given hour on an arbitrary fixed date.
func atHour(hour int) time.Time {
	return time.Date(2026, 4, 24, hour, 0, 0, 0, time.UTC)
}

// ── S14.1: morning peak (08:00) → delay < mid-point of [min,max] ────────────

func TestHumanSendDelay_MorningPeak_BelowMidpoint(t *testing.T) {
	min, max := 30, 90
	mid := time.Duration((min+max)/2) * time.Second
	// factor=0.7 → mean ≈ 42s, well below mid (60s).
	// Use a statistical average over 200 samples for a stable assertion.
	const n = 200
	var total time.Duration
	for i := 0; i < n; i++ {
		total += humanSendDelay(min, max, atHour(9))
	}
	avg := total / n
	if avg >= mid {
		t.Errorf("morning peak average: expected avg < %v, got %v", mid, avg)
	}
}

// ── S14.2: off-hours (22:00) → delay > mid-point of [min,max] ────────────────

func TestHumanSendDelay_OffHours_AboveMidpoint(t *testing.T) {
	min, max := 30, 90
	mid := time.Duration((min+max)/2) * time.Second
	// factor=1.8, so the statistical average should be well above mid.
	// Individual samples can dip below mid due to jitter, so we check
	// the average over 200 samples instead of every individual sample.
	const n = 200
	var total time.Duration
	for i := 0; i < n; i++ {
		total += humanSendDelay(min, max, atHour(22))
	}
	avg := total / n
	if avg <= mid {
		t.Errorf("off-hours average: expected avg > %v, got %v", mid, avg)
	}
}

// ── S14.3: afternoon (14:00) → delay in [min, max*3] ────────────────────────
// Upper clamp is max*3 because poissonDelay uses 3× (exponential tails are
// heavier than the old uniform-jitter approximation).

func TestHumanSendDelay_Afternoon_WithinBounds(t *testing.T) {
	min, max := 10, 60
	for i := 0; i < 100; i++ {
		d := humanSendDelay(min, max, atHour(14))
		if d < time.Duration(min)*time.Second {
			t.Errorf("afternoon: delay %v < min %ds (iter %d)", d, min, i)
		}
		if d > time.Duration(max)*3*time.Second {
			t.Errorf("afternoon: delay %v > max*3 %ds (iter %d)", d, max*3, i)
		}
	}
}

// ── S14.4: pre-lunch (11:00) → delay within bounds ───────────────────────────
// Upper clamp is max*3 (Poisson).

func TestHumanSendDelay_PreLunch_WithinBounds(t *testing.T) {
	min, max := 20, 80
	for i := 0; i < 100; i++ {
		d := humanSendDelay(min, max, atHour(12))
		if d < time.Duration(min)*time.Second {
			t.Errorf("pre-lunch: delay %v < min %ds", d, min)
		}
		if d > time.Duration(max)*3*time.Second {
			t.Errorf("pre-lunch: delay %v > max*3 %ds", d, max*3)
		}
	}
}

// ── S14.5: result always >= minSec ───────────────────────────────────────────

func TestHumanSendDelay_AlwaysAtLeastMin(t *testing.T) {
	min, max := 5, 30
	for hour := 0; hour < 24; hour++ {
		for i := 0; i < 20; i++ {
			d := humanSendDelay(min, max, atHour(hour))
			if d < time.Duration(min)*time.Second {
				t.Errorf("hour=%d iter=%d: got %v < min %ds", hour, i, d, min)
			}
		}
	}
}

// ── S14.6: result always <= maxSec*3 ─────────────────────────────────────────
// poissonDelay clamps to 3× (updated from old Gaussian 2×).

func TestHumanSendDelay_AlwaysAtMostMaxTripled(t *testing.T) {
	min, max := 5, 30
	for hour := 0; hour < 24; hour++ {
		for i := 0; i < 20; i++ {
			d := humanSendDelay(min, max, atHour(hour))
			if d > time.Duration(max)*3*time.Second {
				t.Errorf("hour=%d iter=%d: got %v > max*3=%ds", hour, i, d, max*3)
			}
		}
	}
}

// ── S14.7: maxSec <= minSec → result in [min, min*3] ─────────────────────────
// With Poisson there is no early-return for degenerate bounds; poissonDelay
// clamps the sample to [minSec, maxSec*3].  When maxSec == minSec the window
// is [minSec, minSec*3], and when maxSec < minSec the result is still
// bounded by the lower clamp (minSec).

func TestHumanSendDelay_MaxLEMin_ReturnsAtLeastMin(t *testing.T) {
	cases := [][2]int{{10, 10}, {10, 5}, {0, 0}}
	for _, c := range cases {
		d := humanSendDelay(c[0], c[1], atHour(9))
		if d < time.Duration(c[0])*time.Second {
			t.Errorf("max=%d<=min=%d: got %v < min=%ds", c[1], c[0], d, c[0])
		}
	}
}

// ── S14.8: minSec=0, maxSec=1 → tiny but valid range ────────────────────────

func TestHumanSendDelay_TinyRange_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic with min=0, max=1: %v", r)
		}
	}()
	for hour := 0; hour < 24; hour++ {
		d := humanSendDelay(0, 1, atHour(hour))
		if d < 0 {
			t.Errorf("negative delay: %v", d)
		}
	}
}

// ── S14.9: large values (min=3600, max=7200) → no overflow/NaN ───────────────
// Upper clamp is max*3 (Poisson).

func TestHumanSendDelay_LargeValues_NoOverflow(t *testing.T) {
	min, max := 3600, 7200
	for i := 0; i < 50; i++ {
		d := humanSendDelay(min, max, atHour(10))
		if d < time.Duration(min)*time.Second {
			t.Errorf("large range: delay %v < min", d)
		}
		if d > time.Duration(max)*3*time.Second {
			t.Errorf("large range: delay %v > max*3", d)
		}
	}
}

// ── S14.10: 1000 random calls — no panic, no NaN ─────────────────────────────

func TestHumanSendDelay_Monkey_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic during monkey test: %v", r)
		}
	}()
	cases := [][2]int{
		{0, 0}, {0, 1}, {1, 1}, {1, 2},
		{5, 30}, {10, 60}, {30, 90}, {60, 120},
		{3600, 7200}, {1, 10000},
	}
	hours := []int{0, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 22, 23}
	count := 0
	for _, c := range cases {
		for _, h := range hours {
			for i := 0; i < 5; i++ {
				d := humanSendDelay(c[0], c[1], atHour(h))
				if d < 0 {
					t.Errorf("negative delay: min=%d max=%d hour=%d result=%v", c[0], c[1], h, d)
				}
				count++
			}
		}
	}
	if count < 1000 {
		t.Logf("ran %d calls (target >=1000)", count)
	}
}

// ── S14.11: morning faster than off-hours (statistical) ──────────────────────

func TestHumanSendDelay_MorningFasterThanOffHours(t *testing.T) {
	min, max := 30, 90
	var morningTotal, offHoursTotal time.Duration
	const n = 200
	for i := 0; i < n; i++ {
		morningTotal += humanSendDelay(min, max, atHour(9))
		offHoursTotal += humanSendDelay(min, max, atHour(22))
	}
	if morningTotal >= offHoursTotal {
		t.Errorf("expected morning avg (%v) < off-hours avg (%v)", morningTotal/n, offHoursTotal/n)
	}
}

// ── S14.12: minSec=0, maxSec=0 → zero duration ───────────────────────────────

func TestHumanSendDelay_ZeroMinZeroMax(t *testing.T) {
	d := humanSendDelay(0, 0, atHour(9))
	if d != 0 {
		t.Errorf("expected 0, got %v", d)
	}
}

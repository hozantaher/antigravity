package humanize

import (
	"testing"
	"time"
)

// ── Property: IsBusinessHour never panics across all hours ──────
func TestProperty_IsBusinessHour_NoPanic(t *testing.T) {
	c := NewCircadianEngine()
	// Walk a full week minute-by-minute to catch edge cases.
	base := time.Date(2025, 1, 6, 0, 0, 0, 0, time.UTC) // Monday
	for day := 0; day < 7; day++ {
		for hour := 0; hour < 24; hour++ {
			for min := 0; min < 60; min += 5 { // 5-min increments
				tt := base.AddDate(0, 0, day).Add(time.Duration(hour)*time.Hour + time.Duration(min)*time.Minute)
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("panic on %v: %v", tt, r)
					}
				}()
				_ = c.IsBusinessHour(tt)
			}
		}
	}
}

// ── Property: IsBusinessHour is false outside 8:00-17:00 CZ time ──
func TestProperty_IsBusinessHour_OutsideBusinessHours(t *testing.T) {
	c := NewCircadianEngine()
	loc, _ := time.LoadLocation("Europe/Prague")
	nonBusinessHours := []int{0, 1, 2, 3, 4, 5, 6, 7, 17, 18, 19, 20, 21, 22, 23}
	for _, h := range nonBusinessHours {
		tt := time.Date(2025, 3, 10, h, 0, 0, 0, loc) // Monday
		if c.IsBusinessHour(tt) {
			t.Fatalf("hour %d should NOT be business hour", h)
		}
	}
}

// ── Property: IsBusinessHour is true for 8:00-11:59 and 14:00-16:59 ──
func TestProperty_IsBusinessHour_InBusinessHours(t *testing.T) {
	c := NewCircadianEngine()
	loc, _ := time.LoadLocation("Europe/Prague")
	businessHours := []int{8, 9, 10, 11, 14, 15, 16}
	for _, h := range businessHours {
		tt := time.Date(2025, 3, 10, h, 0, 0, 0, loc) // Monday
		if !c.IsBusinessHour(tt) {
			t.Fatalf("hour %d should BE business hour", h)
		}
	}
}

// ── Property: Lunch zone (12:00-13:29) always false ────────────
func TestProperty_IsBusinessHour_LunchDead(t *testing.T) {
	c := NewCircadianEngine()
	loc, _ := time.LoadLocation("Europe/Prague")
	// All of 12:xx → false
	for min := 0; min < 60; min += 10 {
		tt := time.Date(2025, 3, 10, 12, min, 0, 0, loc)
		if c.IsBusinessHour(tt) {
			t.Fatalf("12:%02d should be lunch → false", min)
		}
	}
	// 13:00-13:29 → false; 13:30-13:59 → true (post-lunch resumption).
	for min := 0; min < 30; min++ {
		tt := time.Date(2025, 3, 10, 13, min, 0, 0, loc)
		if c.IsBusinessHour(tt) {
			t.Fatalf("13:%02d should still be lunch → false", min)
		}
	}
	for min := 30; min < 60; min++ {
		tt := time.Date(2025, 3, 10, 13, min, 0, 0, loc)
		if !c.IsBusinessHour(tt) {
			t.Fatalf("13:%02d should be post-lunch → true", min)
		}
	}
}

// ── Property: PlanDay returns day plan that never panics ───────
func TestProperty_PlanDay_NoPanic(t *testing.T) {
	c := NewCircadianEngine()
	loc, _ := time.LoadLocation("Europe/Prague")
	// Test various dates + base counts.
	baseCounts := []int{0, 1, 5, 10, 50, 100, 500}
	for _, count := range baseCounts {
		for day := 0; day < 30; day++ {
			date := time.Date(2025, 1, 1, 12, 0, 0, 0, loc).AddDate(0, 0, day)
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic on count=%d day=%d: %v", count, day, r)
				}
			}()
			_ = c.PlanDay(date, count)
		}
	}
}

// ── Property: NextBusinessTime always returns a business-valid time ──
// Given any random input, the result is always within 14 days and
// either (a) a business hour or (b) the fallback (input + 24h).
func TestProperty_NextBusinessTime_BoundedLookahead(t *testing.T) {
	c := NewCircadianEngine()
	loc, _ := time.LoadLocation("Europe/Prague")
	cases := []time.Time{
		time.Date(2025, 1, 1, 0, 0, 0, 0, loc),      // New Year midnight
		time.Date(2025, 6, 15, 3, 0, 0, 0, loc),     // summer pre-dawn
		time.Date(2025, 7, 6, 12, 15, 0, 0, loc),    // Jan Hus holiday, lunch time
		time.Date(2025, 12, 25, 9, 0, 0, 0, loc),    // Christmas morning
	}
	for _, in := range cases {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on %v: %v", in, r)
			}
		}()
		out := c.NextBusinessTime(in)
		diff := out.Sub(in)
		// Max 14 days + 24h fallback = 15 days = 360h
		if diff > 360*time.Hour {
			t.Fatalf("NextBusinessTime(%v) = %v; diff = %v (>360h)", in, out, diff)
		}
		// Must be >= input (monotonic forward)
		if out.Before(in) {
			t.Fatalf("NextBusinessTime went backward: input=%v output=%v", in, out)
		}
	}
}

// ── Property: NewCircadianEngine default config sane ───────────
func TestProperty_NewCircadianEngine_Defaults(t *testing.T) {
	c := NewCircadianEngine()
	if c.loc == nil {
		t.Fatal("loc should not be nil (falls back to UTC if LoadLocation fails)")
	}
	if c.morningStart < 0 || c.morningStart >= 24 {
		t.Fatalf("morningStart out of range: %d", c.morningStart)
	}
	if c.eveningEnd <= c.morningStart {
		t.Fatalf("eveningEnd must be > morningStart (got %d <= %d)", c.eveningEnd, c.morningStart)
	}
	if c.lunchStart <= c.morningStart || c.lunchEnd >= c.eveningEnd {
		t.Fatalf("lunch must be strictly inside business hours")
	}
	if c.clusterMin < 1 || c.clusterMax < c.clusterMin {
		t.Fatalf("cluster sizes invalid: %d-%d", c.clusterMin, c.clusterMax)
	}
	// Weekly multiplier: Sun and Sat should be 0 (no weekend work).
	if c.weeklyMultiplier[time.Sunday] != 0 {
		t.Fatalf("Sunday multiplier should be 0, got %f", c.weeklyMultiplier[time.Sunday])
	}
	if c.weeklyMultiplier[time.Saturday] != 0 {
		t.Fatalf("Saturday multiplier should be 0, got %f", c.weeklyMultiplier[time.Saturday])
	}
	// Skip-day probability in [0,1].
	if c.skipDayProb < 0 || c.skipDayProb > 1 {
		t.Fatalf("skipDayProb out of range: %f", c.skipDayProb)
	}
}

// ── Property: Weekend IsBusinessHour → would still be true for hours
// but the weeklyMultiplier=0 in PlanDay produces no sends anyway.
// This documents the layered design (IsBusinessHour is hour-only; day filter
// lives in caller). ─────────────────────────────────────────────
func TestProperty_WeekendIsBusinessHour_HourLevelOnly(t *testing.T) {
	c := NewCircadianEngine()
	loc, _ := time.LoadLocation("Europe/Prague")
	// Saturday 10am IS technically a business hour (IsBusinessHour doesn't
	// weekend-filter); callers are expected to check weeklyMultiplier.
	sat := time.Date(2025, 3, 8, 10, 0, 0, 0, loc) // Saturday
	if !c.IsBusinessHour(sat) {
		t.Fatal("Saturday 10am: IsBusinessHour is hour-only, should return true (caller filters weekday)")
	}
}

package calendar

import (
	"testing"
	"testing/quick"
	"time"
)

// ── Property: IsSendableDay never panics ──────────────────────
func TestProperty_IsSendableDay_NoPanic(t *testing.T) {
	f := func(unix int64) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on unix=%d: %v", unix, r)
			}
		}()
		// Clamp unix to reasonable range (year 1900-2300).
		if unix < -2208988800 || unix > 10410019199 {
			return true
		}
		_ = IsSendableDay(time.Unix(unix, 0).UTC())
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: Saturdays + Sundays ALWAYS not sendable ─────────
func TestProperty_Weekend_NotSendable(t *testing.T) {
	// Walk 3 years of weekends.
	for y := 2024; y <= 2026; y++ {
		d := time.Date(y, 1, 1, 12, 0, 0, 0, time.UTC)
		end := time.Date(y+1, 1, 1, 0, 0, 0, 0, time.UTC)
		for d.Before(end) {
			if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
				if IsSendableDay(d) {
					t.Fatalf("weekend %s should NOT be sendable", d.Format("2006-01-02 Mon"))
				}
			}
			d = d.AddDate(0, 0, 1)
		}
	}
}

// ── Property: specific CZ holidays → not sendable ─────────────
func TestProperty_FixedHolidays_NotSendable(t *testing.T) {
	// Known fixed holidays per zákon 245/2000 Sb.
	cases := []struct{ year, m, d int }{
		{2025, 1, 1},  // Nový rok
		{2025, 5, 1},  // Svátek práce
		{2025, 5, 8},  // Den vítězství
		{2025, 7, 5},  // Cyril a Metoděj
		{2025, 7, 6},  // Jan Hus
		{2025, 9, 28}, // Den české státnosti
		{2025, 10, 28}, // Den vzniku ČSR
		{2025, 11, 17}, // Sametová revoluce
		{2025, 12, 24}, // Štědrý den
		{2025, 12, 25}, // 1. svátek vánoční
		{2025, 12, 26}, // 2. svátek vánoční
	}
	for _, c := range cases {
		d := time.Date(c.year, time.Month(c.m), c.d, 12, 0, 0, 0, time.UTC)
		if IsSendableDay(d) {
			t.Fatalf("%04d-%02d-%02d should NOT be sendable (CZ holiday)", c.year, c.m, c.d)
		}
		if !IsCzechPublicHoliday(d) {
			t.Fatalf("%04d-%02d-%02d should be recognized as holiday", c.year, c.m, c.d)
		}
	}
}

// ── Property: Easter-relative holidays work in multiple years ──
func TestProperty_EasterHolidays_2024_2026(t *testing.T) {
	// Known Easter-Sunday dates:
	// 2024: March 31
	// 2025: April 20
	// 2026: April 5
	cases := []struct {
		y          int
		easter     time.Time
		goodFriday time.Time
		easterMon  time.Time
	}{
		{2024, time.Date(2024, 3, 31, 0, 0, 0, 0, time.UTC), time.Date(2024, 3, 29, 0, 0, 0, 0, time.UTC), time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC)},
		{2025, time.Date(2025, 4, 20, 0, 0, 0, 0, time.UTC), time.Date(2025, 4, 18, 0, 0, 0, 0, time.UTC), time.Date(2025, 4, 21, 0, 0, 0, 0, time.UTC)},
		{2026, time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC), time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC), time.Date(2026, 4, 6, 0, 0, 0, 0, time.UTC)},
	}
	for _, c := range cases {
		if !IsCzechPublicHoliday(c.goodFriday) {
			t.Fatalf("Good Friday %v (%d) should be a holiday", c.goodFriday.Format("2006-01-02"), c.y)
		}
		if !IsCzechPublicHoliday(c.easterMon) {
			t.Fatalf("Easter Monday %v (%d) should be a holiday", c.easterMon.Format("2006-01-02"), c.y)
		}
	}
}

// ── Property: typical Tuesdays in non-holiday weeks ARE sendable ──
func TestProperty_RegularTuesday_Sendable(t *testing.T) {
	// Pick 5 Tuesdays away from holidays.
	cases := []time.Time{
		time.Date(2025, 1, 14, 10, 0, 0, 0, time.UTC),
		time.Date(2025, 2, 11, 10, 0, 0, 0, time.UTC),
		time.Date(2025, 3, 11, 10, 0, 0, 0, time.UTC),
		time.Date(2025, 6, 17, 10, 0, 0, 0, time.UTC),
		time.Date(2025, 10, 14, 10, 0, 0, 0, time.UTC),
	}
	for _, d := range cases {
		if d.Weekday() != time.Tuesday {
			t.Fatalf("test data bug: %s is not Tuesday", d.Format("2006-01-02 Mon"))
		}
		if !IsSendableDay(d) {
			t.Fatalf("Tuesday %s should be sendable", d.Format("2006-01-02"))
		}
	}
}

// ── Property: determinism - same input = same output ───────────
func TestProperty_IsSendableDay_Deterministic(t *testing.T) {
	for i := 0; i < 100; i++ {
		d := time.Date(2020+i%6, time.Month(1+i%12), 1+i%28, 12, 0, 0, 0, time.UTC)
		a := IsSendableDay(d)
		b := IsSendableDay(d)
		if a != b {
			t.Fatalf("non-deterministic for %v: %v vs %v", d, a, b)
		}
	}
}

// ── Property: IsCzechPublicHoliday and IsSendableDay coherent ──
// Rule: if it's a public holiday, IsSendableDay is false.
func TestProperty_Holiday_Excludes_Sendable(t *testing.T) {
	for y := 2024; y <= 2026; y++ {
		d := time.Date(y, 1, 1, 12, 0, 0, 0, time.UTC)
		end := time.Date(y+1, 1, 1, 0, 0, 0, 0, time.UTC)
		for d.Before(end) {
			if IsCzechPublicHoliday(d) && IsSendableDay(d) {
				t.Fatalf("coherence broken on %s: holiday=true but sendable=true", d.Format("2006-01-02 Mon"))
			}
			d = d.AddDate(0, 0, 1)
		}
	}
}

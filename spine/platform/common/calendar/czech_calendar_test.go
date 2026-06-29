package calendar

import (
	"testing"
	"testing/quick"
	"time"
)

// ── CzechCalendar struct tests ────────────────────────────────────

// TestNewCzechCalendar_NonNilReturn verifies the constructor always returns a
// non-nil calendar with a non-nil timezone location.
func TestNewCzechCalendar_NonNilReturn(t *testing.T) {
	cal := NewCzechCalendar()
	if cal == nil {
		t.Fatal("NewCzechCalendar must not return nil")
	}
	if cal.loc == nil {
		t.Fatal("cal.loc must not be nil (should fall back to UTC if tzdata absent)")
	}
}

// TestNewCzechCalendar_UTCFallback verifies a CzechCalendar constructed with
// UTC loc still reports holidays and dead days correctly.
func TestNewCzechCalendar_UTCFallback(t *testing.T) {
	cal := &CzechCalendar{loc: time.UTC}
	xmas := time.Date(2026, 12, 25, 12, 0, 0, 0, time.UTC)
	if !cal.IsDeadDay(xmas) {
		t.Error("Christmas must be a dead day even with UTC loc")
	}
	monday := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC) // regular Monday
	if cal.IsDeadDay(monday) {
		t.Error("regular Monday must not be a dead day with UTC loc")
	}
}

// TestIsDeadDay_Property_NeverPanics runs quick.Check with random year/month/day
// combinations to confirm IsDeadDay never panics regardless of input.
func TestIsDeadDay_Property_NeverPanics(t *testing.T) {
	cal := NewCzechCalendar()
	f := func(year, month, day int) bool {
		defer func() { recover() }() //nolint:errcheck
		d := time.Date(year, time.Month((month%12)+1), (day%28)+1, 0, 0, 0, 0, time.UTC)
		cal.IsDeadDay(d)
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestIsDeadDay_WeekendAlwaysDead verifies weekends are always dead days.
func TestIsDeadDay_WeekendAlwaysDead(t *testing.T) {
	cal := NewCzechCalendar()
	// 2026-04-18 Saturday, 2026-04-19 Sunday.
	sat := time.Date(2026, 4, 18, 10, 0, 0, 0, time.UTC)
	sun := time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC)
	if !cal.IsDeadDay(sat) {
		t.Error("Saturday must be a dead day")
	}
	if !cal.IsDeadDay(sun) {
		t.Error("Sunday must be a dead day")
	}
}

// TestIsDeadDay_FixedHolidaysAreDead verifies all 11 fixed Czech public holidays
// are treated as dead days.
func TestIsDeadDay_FixedHolidaysAreDead(t *testing.T) {
	cal := NewCzechCalendar()
	holidays := []struct{ m, d int }{
		{1, 1}, {5, 1}, {5, 8}, {7, 5}, {7, 6},
		{9, 28}, {10, 28}, {11, 17},
		{12, 24}, {12, 25}, {12, 26},
	}
	for _, h := range holidays {
		day := time.Date(2026, time.Month(h.m), h.d, 12, 0, 0, 0, time.UTC)
		if !cal.IsDeadDay(day) {
			t.Errorf("CZ holiday %02d-%02d must be dead day", h.m, h.d)
		}
	}
}

// TestIsDeadDay_ChristmasDeadZone verifies Dec 22–31 and Jan 1–2 are dead days.
func TestIsDeadDay_ChristmasDeadZone(t *testing.T) {
	cal := NewCzechCalendar()
	deadZone := []struct{ y, m, d int }{
		{2026, 12, 22}, {2026, 12, 27}, {2026, 12, 28}, {2026, 12, 29},
		{2026, 12, 30}, {2026, 12, 31},
		{2027, 1, 1}, {2027, 1, 2},
	}
	for _, z := range deadZone {
		day := time.Date(z.y, time.Month(z.m), z.d, 12, 0, 0, 0, time.UTC)
		if !cal.IsDeadDay(day) {
			t.Errorf("Christmas dead zone %04d-%02d-%02d must be dead day", z.y, z.m, z.d)
		}
	}
}

// TestIsDeadDay_RegularWeekdayNotDead verifies a normal mid-week day is not a dead day.
func TestIsDeadDay_RegularWeekdayNotDead(t *testing.T) {
	cal := NewCzechCalendar()
	wednesday := time.Date(2026, 4, 15, 10, 0, 0, 0, time.UTC)
	if cal.IsDeadDay(wednesday) {
		t.Error("regular Wednesday must not be a dead day")
	}
}

// ── VolumeMultiplier tests ────────────────────────────────────────

// TestVolumeMultiplier_BetweenZeroAndOne verifies the multiplier is always in [0,1].
func TestVolumeMultiplier_BetweenZeroAndOne(t *testing.T) {
	cal := NewCzechCalendar()
	f := func(year, month, day int) bool {
		d := time.Date(year, time.Month((month%12)+1), (day%28)+1, 0, 0, 0, 0, time.UTC)
		v := cal.VolumeMultiplier(d)
		return v >= 0.0 && v <= 1.0
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

// TestVolumeMultiplier_DeadDayIsZero verifies dead days always return 0.0.
func TestVolumeMultiplier_DeadDayIsZero(t *testing.T) {
	cal := NewCzechCalendar()
	// Saturday
	sat := time.Date(2026, 4, 18, 10, 0, 0, 0, time.UTC)
	if v := cal.VolumeMultiplier(sat); v != 0.0 {
		t.Errorf("Saturday VolumeMultiplier = %f, want 0.0", v)
	}
	// Christmas
	xmas := time.Date(2026, 12, 25, 12, 0, 0, 0, time.UTC)
	if v := cal.VolumeMultiplier(xmas); v != 0.0 {
		t.Errorf("Christmas VolumeMultiplier = %f, want 0.0", v)
	}
}

// TestVolumeMultiplier_NormalDayIsOne verifies a regular weekday returns 1.0.
func TestVolumeMultiplier_NormalDayIsOne(t *testing.T) {
	cal := NewCzechCalendar()
	// Normal Wednesday in April
	wednesday := time.Date(2026, 4, 15, 10, 0, 0, 0, time.UTC)
	if v := cal.VolumeMultiplier(wednesday); v != 1.0 {
		t.Errorf("regular Wednesday VolumeMultiplier = %f, want 1.0", v)
	}
}

// TestVolumeMultiplier_ReducedDayIsHalf verifies summer months return 0.5.
func TestVolumeMultiplier_ReducedDayIsHalf(t *testing.T) {
	cal := NewCzechCalendar()
	// Monday in July (not a holiday)
	julyMonday := time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC)
	if v := cal.VolumeMultiplier(julyMonday); v != 0.5 {
		t.Errorf("July Monday VolumeMultiplier = %f, want 0.5", v)
	}
	// Monday in August
	augMonday := time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC)
	if v := cal.VolumeMultiplier(augMonday); v != 0.5 {
		t.Errorf("August Monday VolumeMultiplier = %f, want 0.5", v)
	}
}

// ── IsReducedDay tests ────────────────────────────────────────────

// TestIsReducedDay_SummerMonths verifies July and August are always reduced days
// when they are not dead days (i.e., not weekends/holidays).
func TestIsReducedDay_SummerMonths(t *testing.T) {
	cal := NewCzechCalendar()
	// July Monday (not a holiday)
	julyMonday := time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC)
	if !cal.IsReducedDay(julyMonday) {
		t.Error("July Monday must be reduced day")
	}
	// August Wednesday
	augWednesday := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	if !cal.IsReducedDay(augWednesday) {
		t.Error("August Wednesday must be reduced day")
	}
}

// TestIsReducedDay_NonSummerNormalDay verifies spring/autumn weekdays are not reduced.
func TestIsReducedDay_NonSummerNormalDay(t *testing.T) {
	cal := NewCzechCalendar()
	// Regular Wednesday in March
	march := time.Date(2026, 3, 11, 10, 0, 0, 0, time.UTC)
	if cal.IsReducedDay(march) {
		t.Error("regular March Wednesday must not be reduced day")
	}
	// October Wednesday
	oct := time.Date(2026, 10, 7, 10, 0, 0, 0, time.UTC)
	if cal.IsReducedDay(oct) {
		t.Error("regular October Wednesday must not be reduced day")
	}
}

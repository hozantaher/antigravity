package calendar

import (
	"testing"
	"time"
)

// pragueTime constructs a time in the Europe/Prague timezone.
// Panics if the timezone cannot be loaded (should never happen in a properly
// configured CI environment — fails loudly rather than silently lying about
// test coverage).
func pragueTime(year int, month time.Month, day, hour, min int) time.Time {
	loc, err := time.LoadLocation("Europe/Prague")
	if err != nil {
		panic("Europe/Prague timezone unavailable: " + err.Error())
	}
	return time.Date(year, month, day, hour, min, 0, 0, loc)
}

// ── InSendWindow ──────────────────────────────────────────────────────────────

func TestInSendWindow_MondayMorning(t *testing.T) {
	// 2026-04-20 (Monday) 10:00 Prague — inside window.
	got := InSendWindow(pragueTime(2026, 4, 20, 10, 0), "Europe/Prague")
	if !got {
		t.Error("Monday 10:00 Prague: want InSendWindow=true, got false")
	}
}

func TestInSendWindow_MondayTooEarly(t *testing.T) {
	// 2026-04-20 (Monday) 07:59 Prague — before window opens.
	got := InSendWindow(pragueTime(2026, 4, 20, 7, 59), "Europe/Prague")
	if got {
		t.Error("Monday 07:59 Prague: want InSendWindow=false, got true")
	}
}

func TestInSendWindow_MondayAtWindowEnd(t *testing.T) {
	// 2026-04-20 (Monday) 17:00 Prague — window is [8,17), so 17 is outside.
	got := InSendWindow(pragueTime(2026, 4, 20, 17, 0), "Europe/Prague")
	if got {
		t.Error("Monday 17:00 Prague: want InSendWindow=false (exclusive end), got true")
	}
}

func TestInSendWindow_MondayLastMinute(t *testing.T) {
	// 2026-04-20 (Monday) 16:59 Prague — last minute inside window.
	got := InSendWindow(pragueTime(2026, 4, 20, 16, 59), "Europe/Prague")
	if !got {
		t.Error("Monday 16:59 Prague: want InSendWindow=true, got false")
	}
}

func TestInSendWindow_Saturday(t *testing.T) {
	// 2026-04-18 (Saturday) 10:00 Prague — weekend.
	got := InSendWindow(pragueTime(2026, 4, 18, 10, 0), "Europe/Prague")
	if got {
		t.Error("Saturday 10:00 Prague: want InSendWindow=false, got true")
	}
}

func TestInSendWindow_Sunday(t *testing.T) {
	// 2026-04-19 (Sunday) 10:00 Prague — weekend.
	got := InSendWindow(pragueTime(2026, 4, 19, 10, 0), "Europe/Prague")
	if got {
		t.Error("Sunday 10:00 Prague: want InSendWindow=false, got true")
	}
}

func TestInSendWindow_UnknownTimezone_NoOanic(t *testing.T) {
	// An unrecognised timezone must fall back to UTC, not panic.
	// 2026-04-20 (Monday) passed as UTC 10:00 with a bogus tz — should not panic.
	utcTime := time.Date(2026, 4, 20, 10, 0, 0, 0, time.UTC)
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("InSendWindow panicked on unknown timezone: %v", r)
		}
	}()
	// Just calling it must not panic. Result is UTC-based (10:00 UTC Mon = inside).
	_ = InSendWindow(utcTime, "Not/A/Real/Zone")
}

func TestInSendWindow_WindowOpen(t *testing.T) {
	// Boundary: exactly 08:00 is inside the window.
	got := InSendWindow(pragueTime(2026, 4, 20, 8, 0), "Europe/Prague")
	if !got {
		t.Error("Monday 08:00 Prague: want InSendWindow=true (window open), got false")
	}
}

// ── NextSendTime ──────────────────────────────────────────────────────────────

func TestNextSendTime_MondayBeforeWindow_ReturnsMonday9(t *testing.T) {
	// Monday 07:00 is before the window opens (08:00) on a sendable weekday,
	// so the earliest valid slot is the SAME day at the open hour (09:00).
	// Advancing to the next day would needlessly delay a pre-open send by a
	// full day.
	in := pragueTime(2026, 4, 20, 7, 0) // Monday 07:00
	got := NextSendTime(in, "Europe/Prague")
	wantDay := pragueTime(2026, 4, 20, 9, 0).UTC() // Monday 09:00 Prague in UTC
	if !got.Equal(wantDay) {
		t.Errorf("Monday 07:00 → want Monday 09:00 UTC (%v), got %v", wantDay, got)
	}
}

func TestNextSendTime_MondayAfterWindow_ReturnsTuesday9(t *testing.T) {
	// Monday 18:00 → Tuesday 09:00.
	in := pragueTime(2026, 4, 20, 18, 0)
	got := NextSendTime(in, "Europe/Prague")
	want := pragueTime(2026, 4, 21, 9, 0).UTC() // Tuesday 09:00 Prague in UTC
	if !got.Equal(want) {
		t.Errorf("Monday 18:00 → want Tuesday 09:00 UTC (%v), got %v", want, got)
	}
}

func TestNextSendTime_FridayAfterWindow_ReturnsMonday9(t *testing.T) {
	// Friday 18:00 → skip Saturday + Sunday → Monday 09:00.
	// 2026-04-17 is a Friday; 2026-04-20 is the following Monday.
	in := pragueTime(2026, 4, 17, 18, 0)
	got := NextSendTime(in, "Europe/Prague")
	want := pragueTime(2026, 4, 20, 9, 0).UTC()
	if !got.Equal(want) {
		t.Errorf("Friday 18:00 → want Monday 09:00 UTC (%v), got %v", want, got)
	}
}

func TestNextSendTime_SaturdayMorning_ReturnsMonday9(t *testing.T) {
	// Saturday 10:00 → Monday 09:00 (skip Saturday afternoon and Sunday).
	in := pragueTime(2026, 4, 18, 10, 0)
	got := NextSendTime(in, "Europe/Prague")
	want := pragueTime(2026, 4, 20, 9, 0).UTC()
	if !got.Equal(want) {
		t.Errorf("Saturday 10:00 → want Monday 09:00 UTC (%v), got %v", want, got)
	}
}

func TestNextSendTime_InsideWindow_ReturnsUnchanged(t *testing.T) {
	// Monday 10:00 is already in window — must be returned unchanged.
	in := pragueTime(2026, 4, 20, 10, 0)
	got := NextSendTime(in, "Europe/Prague")
	if !got.Equal(in) {
		t.Errorf("Monday 10:00 (in window): want unchanged (%v), got %v", in, got)
	}
}

func TestNextSendTime_ResultAlwaysInWindow(t *testing.T) {
	// Property: NextSendTime output must always satisfy InSendWindow.
	cases := []time.Time{
		pragueTime(2026, 4, 20, 7, 0),  // Mon before window
		pragueTime(2026, 4, 20, 17, 30), // Mon after window
		pragueTime(2026, 4, 18, 10, 0),  // Sat
		pragueTime(2026, 4, 19, 10, 0),  // Sun
		pragueTime(2026, 4, 17, 20, 0),  // Fri evening
		pragueTime(2026, 4, 21, 0, 0),   // Tue midnight
	}
	for _, tc := range cases {
		result := NextSendTime(tc, "Europe/Prague")
		if !InSendWindow(result, "Europe/Prague") {
			t.Errorf("NextSendTime(%v) = %v — not inside send window", tc, result)
		}
	}
}

func TestNextSendTime_UnknownTimezone_NoNanic(t *testing.T) {
	// Unknown tz falls back to UTC; must not panic.
	in := time.Date(2026, 4, 20, 18, 0, 0, 0, time.UTC) // Monday 18:00 UTC
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("NextSendTime panicked on unknown timezone: %v", r)
		}
	}()
	got := NextSendTime(in, "Bogus/Zone")
	// Result must be in send window (UTC fallback, Tuesday 09:00 UTC).
	if !InSendWindow(got, "") {
		t.Errorf("NextSendTime with bogus tz: result %v not in UTC send window", got)
	}
}

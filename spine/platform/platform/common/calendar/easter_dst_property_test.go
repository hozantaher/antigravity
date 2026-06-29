package calendar

import (
	"testing"
	"time"
)

// TestEasterSunday_KnownDates2024to2030 locks the Meeus/Jones/Butcher
// algorithm output against authoritative Czech holiday calendar dates.
// A regression here would silently shift Velký pátek + Velikonoční pondělí
// — sending a campaign on a national holiday is a § 7 / GDPR red flag.
func TestEasterSunday_KnownDates2024to2030(t *testing.T) {
	// Authoritative dates from kalendar.beda.cz / svatky.estranky.cz
	// (cross-checked against US Naval Observatory Easter dates).
	knownEaster := map[int]string{
		2024: "2024-03-31",
		2025: "2025-04-20",
		2026: "2026-04-05",
		2027: "2027-03-28",
		2028: "2028-04-16",
		2029: "2029-04-01",
		2030: "2030-04-21",
	}

	for year, want := range knownEaster {
		got := EasterSunday(year).Format("2006-01-02")
		if got != want {
			t.Errorf("EasterSunday(%d) = %s, want %s", year, got, want)
		}
	}
}

// TestIsSendableDay_EasterMondayBlocked verifies that Velikonoční pondělí
// (Easter Monday) is correctly recognised across years.
func TestIsSendableDay_EasterMondayBlocked(t *testing.T) {
	years := []int{2024, 2025, 2026, 2027, 2028}
	for _, y := range years {
		easter := EasterSunday(y)
		easterMonday := easter.AddDate(0, 0, 1)
		if IsSendableDay(easterMonday) {
			t.Errorf("Easter Monday %s (%d) should NOT be sendable", easterMonday.Format("2006-01-02"), y)
		}
	}
}

// TestIsSendableDay_GoodFridayBlocked verifies Velký pátek (Good Friday).
func TestIsSendableDay_GoodFridayBlocked(t *testing.T) {
	years := []int{2024, 2025, 2026, 2027, 2028}
	for _, y := range years {
		easter := EasterSunday(y)
		goodFriday := easter.AddDate(0, 0, -2)
		if IsSendableDay(goodFriday) {
			t.Errorf("Good Friday %s (%d) should NOT be sendable", goodFriday.Format("2006-01-02"), y)
		}
	}
}

// TestInSendWindow_DSTSpring2026 verifies window behavior across the
// 2026-03-29 spring DST transition (CET 02:00 → CEST 03:00 in Europe/Prague).
//
// At the wall-clock instant 02:30 Prague on that date:
//   - Before the transition (CET): instant doesn't exist (clocks jump 02→03)
//   - Go's time package handles this by using the offset that was active
//     before the jump (CET +01:00) → equivalent UTC moment 01:30 UTC.
//
// The window check should still respect business hours regardless of which
// DST offset is active.
func TestInSendWindow_DSTSpring2026(t *testing.T) {
	prague := "Europe/Prague"

	// Just before DST jump: 01:59 CET Sunday (outside window: weekend)
	beforeJump := time.Date(2026, 3, 29, 1, 59, 0, 0, time.UTC)
	if InSendWindow(beforeJump, prague) {
		t.Error("Sunday 01:59 UTC should NOT be in send window (weekend)")
	}

	// Monday after DST: 08:00 Prague = 06:00 UTC (CEST = UTC+2)
	mondayMorning := time.Date(2026, 3, 30, 6, 0, 0, 0, time.UTC)
	if !InSendWindow(mondayMorning, prague) {
		t.Error("Monday 08:00 Prague (06:00 UTC, CEST) should be in send window")
	}

	// Monday 16:59 Prague = 14:59 UTC — last second of window
	endWindow := time.Date(2026, 3, 30, 14, 59, 0, 0, time.UTC)
	if !InSendWindow(endWindow, prague) {
		t.Error("Monday 16:59 Prague (14:59 UTC) should be in window — last second")
	}

	// Monday 17:00 Prague = 15:00 UTC — first second outside
	pastWindow := time.Date(2026, 3, 30, 15, 0, 0, 0, time.UTC)
	if InSendWindow(pastWindow, prague) {
		t.Error("Monday 17:00 Prague (15:00 UTC) should NOT be in window")
	}
}

// TestInSendWindow_DSTAutumn2026 verifies the autumn DST transition
// (2026-10-25, CEST 03:00 → CET 02:00). On that day 02:00–03:00 happens
// twice; Go uses the *post-transition* offset (CET +01:00) for
// time.Date(...) constructed in UTC.
func TestInSendWindow_DSTAutumn2026(t *testing.T) {
	prague := "Europe/Prague"

	// Sunday 25 Oct 2026 — weekend always blocked
	sunday := time.Date(2026, 10, 25, 8, 0, 0, 0, time.UTC)
	if InSendWindow(sunday, prague) {
		t.Error("Sunday 25 Oct 2026 should be blocked (weekend) regardless of DST")
	}

	// Monday 26 Oct 2026 08:00 Prague = 07:00 UTC (CET = UTC+1, post-DST)
	mondayMorning := time.Date(2026, 10, 26, 7, 0, 0, 0, time.UTC)
	if !InSendWindow(mondayMorning, prague) {
		t.Error("Monday 08:00 Prague post-DST (07:00 UTC, CET) should be in window")
	}

	// Boundary at start of window — 07:59 Prague (06:59 UTC) NOT in window
	boundaryStart := time.Date(2026, 10, 26, 6, 59, 0, 0, time.UTC)
	if InSendWindow(boundaryStart, prague) {
		t.Error("Monday 07:59 Prague (06:59 UTC) should NOT be in window")
	}

	// 08:00 Prague exactly (07:00 UTC) IN window
	atBoundary := time.Date(2026, 10, 26, 7, 0, 0, 0, time.UTC)
	if !InSendWindow(atBoundary, prague) {
		t.Error("Monday 08:00 Prague exactly (07:00 UTC) should be in window")
	}
}

// TestNextSendTime_FridayPMtoMondayAM verifies that the next valid slot
// after Friday end-of-window is the following Monday morning.
func TestNextSendTime_FridayPMtoMondayAM(t *testing.T) {
	prague := "Europe/Prague"

	// Friday 27 March 2026 17:00 Prague = 16:00 UTC (CET, pre-DST jump)
	// Wait — actually 27 March 2026 is BEFORE DST (jump on 29 Mar). So CET = UTC+1.
	// 17:00 Prague = 16:00 UTC.
	fridayEnd := time.Date(2026, 3, 27, 16, 0, 0, 0, time.UTC)
	got := NextSendTime(fridayEnd, prague)

	// Expect Monday 30 March, 09:00 Prague. After DST jump on Sunday, Monday
	// 30 Mar uses CEST = UTC+2. So 09:00 Prague = 07:00 UTC.
	wantUTC := time.Date(2026, 3, 30, 7, 0, 0, 0, time.UTC)
	if !got.Equal(wantUTC) {
		t.Errorf("Friday 17:00 Prague pre-DST → next slot:\n  got:  %s\n  want: %s",
			got.Format(time.RFC3339), wantUTC.Format(time.RFC3339))
	}
}

// TestNextSendTime_HolidayMondaySkipped verifies that Easter Monday is
// skipped to Tuesday.
func TestNextSendTime_HolidayMondaySkipped(t *testing.T) {
	prague := "Europe/Prague"

	// Easter Monday 2026 = April 6. Friday April 3 = Good Friday (also blocked).
	// Friday April 3 17:00 Prague = 15:00 UTC (CEST = UTC+2 post-DST 29 Mar)
	goodFridayEnd := time.Date(2026, 4, 3, 15, 0, 0, 0, time.UTC)
	got := NextSendTime(goodFridayEnd, prague)

	// Expect Tuesday April 7, 09:00 Prague = 07:00 UTC (skipping Sat, Sun, Easter Monday)
	wantUTC := time.Date(2026, 4, 7, 7, 0, 0, 0, time.UTC)
	if !got.Equal(wantUTC) {
		t.Errorf("Good Friday 17:00 Prague → next slot (skip weekend + Easter Monday):\n  got:  %s\n  want: %s",
			got.Format(time.RFC3339), wantUTC.Format(time.RFC3339))
	}
}

// TestInSendWindow_ExactBoundaries pins down the exact
// inclusive/exclusive semantics at minute boundaries.
func TestInSendWindow_ExactBoundaries(t *testing.T) {
	prague := "Europe/Prague"

	// Use a known workday outside DST quirks: Wednesday 2026-04-15.
	// Window: 08:00-16:59 inclusive Prague (CEST = UTC+2).

	cases := []struct {
		hour   int
		minute int
		utcOffset int // UTC hour for that Prague time
		want   bool
		desc   string
	}{
		{7, 59, 5, false, "07:59:59 → false"},
		{8, 0, 6, true, "08:00:00 → true"},
		{12, 0, 10, true, "12:00 noon → true"},
		{16, 59, 14, true, "16:59:59 → true (last second)"},
		{17, 0, 15, false, "17:00:00 → false (first second outside)"},
		{23, 0, 21, false, "23:00 → false"},
	}

	for _, c := range cases {
		t.Run(c.desc, func(t *testing.T) {
			at := time.Date(2026, 4, 15, c.utcOffset, c.minute, 0, 0, time.UTC)
			got := InSendWindow(at, prague)
			if got != c.want {
				t.Errorf("%s: got %v, want %v (UTC=%s)", c.desc, got, c.want, at.Format(time.RFC3339))
			}
		})
	}
}

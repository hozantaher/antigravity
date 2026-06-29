package calendar

import (
	"testing"
	"time"
)

// D3.8 Czech calendar gate. Cold outreach must not fire on weekends or
// national holidays — both for cultural reasons (recipients read Monday
// bulk as tone-deaf) and for deliverability (Czech ESPs penalise senders
// whose volume spikes on holidays).

func TestIsSendableDay_SkipsWeekend(t *testing.T) {
	// 2026-04-18 is a Saturday.
	d := time.Date(2026, 4, 18, 10, 0, 0, 0, time.UTC)
	if IsSendableDay(d) {
		t.Errorf("Saturday must not be sendable: %v", d.Weekday())
	}
	// 2026-04-19 is a Sunday.
	d = time.Date(2026, 4, 19, 10, 0, 0, 0, time.UTC)
	if IsSendableDay(d) {
		t.Errorf("Sunday must not be sendable: %v", d.Weekday())
	}
}

func TestIsSendableDay_AllowsOrdinaryWeekday(t *testing.T) {
	// 2026-04-17 is a Friday, no holiday.
	d := time.Date(2026, 4, 17, 10, 0, 0, 0, time.UTC)
	if !IsSendableDay(d) {
		t.Errorf("ordinary Friday must be sendable: %v", d)
	}
	// 2026-04-15 is a Wednesday.
	d = time.Date(2026, 4, 15, 10, 0, 0, 0, time.UTC)
	if !IsSendableDay(d) {
		t.Errorf("ordinary Wednesday must be sendable: %v", d)
	}
}

func TestIsSendableDay_SkipsFixedCzechHolidays(t *testing.T) {
	// Canonical fixed Czech public holidays (zákon 245/2000 Sb.):
	//   1.1  Den obnovy samostatného českého státu (New Year)
	//   1.5  Svátek práce
	//   8.5  Den vítězství
	//   5.7  Den slovanských věrozvěstů Cyrila a Metoděje
	//   6.7  Den upálení mistra Jana Husa
	//   28.9 Den české státnosti
	//   28.10 Den vzniku samostatného československého státu
	//   17.11 Den boje za svobodu a demokracii
	//   24.12 Štědrý den
	//   25.12 1. svátek vánoční
	//   26.12 2. svátek vánoční
	cases := []struct {
		m, d int
	}{
		{1, 1}, {5, 1}, {5, 8}, {7, 5}, {7, 6},
		{9, 28}, {10, 28}, {11, 17},
		{12, 24}, {12, 25}, {12, 26},
	}
	for _, c := range cases {
		day := time.Date(2026, time.Month(c.m), c.d, 10, 0, 0, 0, time.UTC)
		if IsSendableDay(day) {
			t.Errorf("CZ holiday %04d-%02d-%02d must not be sendable", 2026, c.m, c.d)
		}
	}
}

func TestIsSendableDay_SkipsEasterMonday(t *testing.T) {
	// Easter Monday 2026 = 2026-04-06 (Gauss: Easter Sunday 2026-04-05).
	easterMon := time.Date(2026, 4, 6, 10, 0, 0, 0, time.UTC)
	if IsSendableDay(easterMon) {
		t.Errorf("Easter Monday 2026-04-06 must not be sendable")
	}
	// Good Friday 2026 = 2026-04-03 (public holiday since 2016).
	goodFri := time.Date(2026, 4, 3, 10, 0, 0, 0, time.UTC)
	if IsSendableDay(goodFri) {
		t.Errorf("Good Friday 2026-04-03 must not be sendable")
	}
}

func TestIsSendableDay_SkipsEasterMonday_MultiYear(t *testing.T) {
	// Spot-check Gauss across years to catch off-by-one date errors.
	cases := []struct {
		year       int
		goodFriday [2]int // month, day
		easterMon  [2]int
	}{
		{2024, [2]int{3, 29}, [2]int{4, 1}},
		{2025, [2]int{4, 18}, [2]int{4, 21}},
		{2026, [2]int{4, 3}, [2]int{4, 6}},
		{2027, [2]int{3, 26}, [2]int{3, 29}},
	}
	for _, c := range cases {
		gf := time.Date(c.year, time.Month(c.goodFriday[0]), c.goodFriday[1], 10, 0, 0, 0, time.UTC)
		if IsSendableDay(gf) {
			t.Errorf("%d Good Friday %v must not be sendable", c.year, gf)
		}
		em := time.Date(c.year, time.Month(c.easterMon[0]), c.easterMon[1], 10, 0, 0, 0, time.UTC)
		if IsSendableDay(em) {
			t.Errorf("%d Easter Monday %v must not be sendable", c.year, em)
		}
	}
}

// ───────────────────────────────────────────────────────────────────
//  IsExtendedDeadDay — Sprint C2 (post-purge rebuild plan)
//  Extends IsSendableDay with the 22.12.–2.1. Vánoce quiet zone.
// ───────────────────────────────────────────────────────────────────

func TestIsExtendedDeadDay_BlocksWeekends(t *testing.T) {
	// Saturday + Sunday must be dead.
	sat := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC) // Saturday
	sun := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC) // Sunday
	if !IsExtendedDeadDay(sat) {
		t.Error("Saturday must be dead")
	}
	if !IsExtendedDeadDay(sun) {
		t.Error("Sunday must be dead")
	}
}

func TestIsExtendedDeadDay_BlocksStateHolidays(t *testing.T) {
	// Sample fixed holiday: 8.5. Den vítězství 2026.
	d := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	if !IsExtendedDeadDay(d) {
		t.Error("state holiday must be dead")
	}
}

func TestIsExtendedDeadDay_BlocksVanoceWindow(t *testing.T) {
	cases := []struct {
		y, m, d int
		desc    string
	}{
		{2025, 12, 22, "first day of zone"},
		{2025, 12, 23, "Tuesday before Štědrý den"},
		{2025, 12, 27, "weekend day inside zone"},
		{2025, 12, 28, "Sunday inside zone"},
		{2025, 12, 31, "Silvestr"},
		{2026, 1, 1, "New Year"},
		{2026, 1, 2, "last day of zone"},
	}
	for _, tc := range cases {
		d := time.Date(tc.y, time.Month(tc.m), tc.d, 12, 0, 0, 0, time.UTC)
		if !IsExtendedDeadDay(d) {
			t.Errorf("%s (%d-%d-%d) must be dead", tc.desc, tc.y, tc.m, tc.d)
		}
	}
}

func TestIsExtendedDeadDay_AllowsJanuary3rdOnward(t *testing.T) {
	// 3.1.2026 is Saturday → still dead (weekend), but the EXTENDED zone
	// no longer applies. Test 5.1.2026 Monday — first sendable day of year.
	d := time.Date(2026, 1, 5, 12, 0, 0, 0, time.UTC)
	if IsExtendedDeadDay(d) {
		t.Errorf("5.1.2026 (Monday) should be sendable, was dead")
	}
}

func TestIsExtendedDeadDay_AllowsDecember21(t *testing.T) {
	// Vánoce zone starts 22.12., so 21.12. must be allowed.
	// 21.12.2026 is Monday — clean test.
	d := time.Date(2026, 12, 21, 12, 0, 0, 0, time.UTC)
	if IsExtendedDeadDay(d) {
		t.Errorf("21.12.2026 (Monday, day before Vánoce zone) should be sendable")
	}
}

func TestIsExtendedDeadDay_AllowsSummerWeekday(t *testing.T) {
	// Sprint C2 deliberately does NOT block summer (operator can use
	// daily_cap to reduce). 7.7.2026 is Tuesday in July — must be sendable.
	d := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	if IsExtendedDeadDay(d) {
		t.Error("July weekday should be sendable (summer reduction is volume-only)")
	}
}

func TestIsExtendedDeadDay_AllowsRegularWeekday(t *testing.T) {
	// 6.5.2026 is a Wednesday — must be sendable.
	d := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	if IsExtendedDeadDay(d) {
		t.Error("regular weekday must be sendable")
	}
}

func TestIsExtendedDeadDay_BlocksEasterMonday(t *testing.T) {
	// Inherits from IsSendableDay → IsCzechPublicHoliday. Easter Monday
	// 2026 = April 6.
	d := time.Date(2026, 4, 6, 12, 0, 0, 0, time.UTC)
	if !IsExtendedDeadDay(d) {
		t.Error("Easter Monday must be dead")
	}
}

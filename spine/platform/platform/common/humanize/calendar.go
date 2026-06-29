package humanize

import "time"

// CzechCalendar knows about Czech public holidays and dead zones.
type CzechCalendar struct {
	loc *time.Location
}

// NewCzechCalendar creates a calendar aware of Czech holidays.
func NewCzechCalendar() *CzechCalendar {
	loc, _ := time.LoadLocation("Europe/Prague")
	if loc == nil {
		loc = time.UTC
	}
	return &CzechCalendar{loc: loc}
}

// IsDeadDay returns true if no emails should be sent on this date.
func (c *CzechCalendar) IsDeadDay(date time.Time) bool {
	date = date.In(c.loc)
	m := date.Month()
	d := date.Day()

	// Fixed holidays
	holidays := [][2]int{
		{1, 1},   // Nový rok
		{5, 1},   // Svátek práce
		{5, 8},   // Den vítězství
		{7, 5},   // Cyril a Metoděj
		{7, 6},   // Jan Hus
		{9, 28},  // Den české státnosti
		{10, 28}, // Vznik ČSR
		{11, 17}, // Den boje za svobodu a demokracii
		{12, 24}, // Štědrý den
		{12, 25}, // 1. svátek vánoční
		{12, 26}, // 2. svátek vánoční
	}

	for _, h := range holidays {
		if int(m) == h[0] && d == h[1] {
			return true
		}
	}

	// Christmas/New Year dead zone: Dec 22 - Jan 2
	if (m == 12 && d >= 22) || (m == 1 && d <= 2) {
		return true
	}

	// Easter Monday (approximate -- varies yearly)
	if c.isEasterMonday(date) {
		return true
	}

	// Weekends
	dow := date.Weekday()
	if dow == time.Saturday || dow == time.Sunday {
		return true
	}

	return false
}

// IsReducedDay returns true if volume should be reduced (summer, bridge days).
func (c *CzechCalendar) IsReducedDay(date time.Time) bool {
	date = date.In(c.loc)
	m := date.Month()

	// Summer: July-August = 50% volume
	if m == 7 || m == 8 {
		return true
	}

	// Fridays before/after holidays
	dow := date.Weekday()
	if dow == time.Friday {
		tomorrow := date.AddDate(0, 0, 1)
		nextMonday := date.AddDate(0, 0, 3)
		if c.IsDeadDay(tomorrow) || c.IsDeadDay(nextMonday) {
			return true
		}
	}

	return false
}

// VolumeMultiplier returns the sending volume multiplier for the date.
// 1.0 = normal, 0.5 = reduced, 0.0 = dead day.
func (c *CzechCalendar) VolumeMultiplier(date time.Time) float64 {
	if c.IsDeadDay(date) {
		return 0.0
	}
	if c.IsReducedDay(date) {
		return 0.5
	}
	return 1.0
}

// isEasterMonday approximates Easter Monday.
// Uses a simplified computation for years 2024-2030.
func (c *CzechCalendar) isEasterMonday(date time.Time) bool {
	year := date.Year()
	easterMondays := map[int][2]int{
		2024: {4, 1},
		2025: {4, 21},
		2026: {4, 6},
		2027: {3, 29},
		2028: {4, 17},
		2029: {4, 2},
		2030: {4, 22},
	}
	if em, ok := easterMondays[year]; ok {
		return int(date.Month()) == em[0] && date.Day() == em[1]
	}
	return false
}

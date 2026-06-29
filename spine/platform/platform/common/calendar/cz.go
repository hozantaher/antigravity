// Package calendar implements Czech-calendar gates for the outreach send
// pipeline. D3.8: outbound mail must not fire on weekends or national
// holidays (zákon 245/2000 Sb.) — both for cultural fit and for deliverability
// (Czech ESPs throttle senders whose volume spikes on holidays).
package calendar

import "time"

// CzechCalendar wraps the package-level helpers as a reusable struct.
// It exposes IsDeadDay, IsReducedDay, and VolumeMultiplier for use by
// higher-level packages (e.g. humanize engine).
type CzechCalendar struct {
	loc *time.Location
}

// NewCzechCalendar creates a CzechCalendar aware of the Europe/Prague timezone.
// Falls back to UTC when the timezone database is unavailable.
func NewCzechCalendar() *CzechCalendar {
	loc, _ := time.LoadLocation("Europe/Prague")
	if loc == nil {
		loc = time.UTC
	}
	return &CzechCalendar{loc: loc}
}

// IsDeadDay reports whether no outreach emails should be sent on this date.
// Dead days are weekends, Czech public holidays, and the Christmas/New Year
// dead zone (Dec 22 – Jan 2).
func (c *CzechCalendar) IsDeadDay(t time.Time) bool {
	t = t.In(c.loc)
	if !IsSendableDay(t) {
		return true
	}
	// Christmas/New Year extended dead zone.
	m := t.Month()
	d := t.Day()
	if (m == time.December && d >= 22) || (m == time.January && d <= 2) {
		return true
	}
	return false
}

// IsReducedDay reports whether sending volume should be reduced on this date.
// Summer months (July–August) and bridge Fridays adjacent to dead days are
// considered reduced days.
func (c *CzechCalendar) IsReducedDay(t time.Time) bool {
	t = t.In(c.loc)
	m := t.Month()
	// Summer reduced-volume months.
	if m == time.July || m == time.August {
		return true
	}
	// Bridge Fridays: Friday before or after a dead day.
	if t.Weekday() == time.Friday {
		tomorrow := t.AddDate(0, 0, 1)
		nextMonday := t.AddDate(0, 0, 3)
		if c.IsDeadDay(tomorrow) || c.IsDeadDay(nextMonday) {
			return true
		}
	}
	return false
}

// VolumeMultiplier returns the fractional sending volume for the date.
// 0.0 = dead day (no sending), 0.5 = reduced, 1.0 = normal.
func (c *CzechCalendar) VolumeMultiplier(t time.Time) float64 {
	if c.IsDeadDay(t) {
		return 0.0
	}
	if c.IsReducedDay(t) {
		return 0.5
	}
	return 1.0
}

// IsSendableDay reports whether the given local date is a legitimate cold
// outreach day in Czechia: weekday and not a public holiday.
// The time-of-day portion of t is ignored — the function only cares about the
// calendar date (interpreted in t's location).
func IsSendableDay(t time.Time) bool {
	// Weekend gate.
	switch t.Weekday() {
	case time.Saturday, time.Sunday:
		return false
	}
	// Fixed and moving holiday gate.
	return !IsCzechPublicHoliday(t)
}

// IsExtendedDeadDay extends IsSendableDay's gate with the operator-stated
// "Vánoce" extended quiet zone (22.12. – 2.1.). Used by the campaign runner
// to block cold-outreach sends through the Czech end-of-year cycle when most
// recipient inboxes are unattended. Sprint C2 of the post-purge rebuild plan
// (initiative 2026-05-05-post-purge-rebuild-plan.md).
//
// Summer reduction (July–August) is intentionally not enforced here — the
// existing CzechCalendar.IsReducedDay/VolumeMultiplier path applies a 0.5
// multiplier on volume rather than a hard block. Operator can tighten later
// via daily_cap_per_mailbox if summer regressions show up.
func IsExtendedDeadDay(t time.Time) bool {
	if !IsSendableDay(t) {
		return true
	}
	m := t.Month()
	d := t.Day()
	if (m == time.December && d >= 22) || (m == time.January && d <= 2) {
		return true
	}
	return false
}

// IsCzechPublicHoliday reports whether the given date is a Czech public
// holiday under zákon 245/2000 Sb. Covers fixed-date holidays and the two
// Easter-relative holidays (Velký pátek, Velikonoční pondělí).
func IsCzechPublicHoliday(t time.Time) bool {
	y, m, d := t.Date()
	// Fixed-date holidays.
	switch {
	case m == time.January && d == 1: // Den obnovy samostatného českého státu
		return true
	case m == time.May && d == 1: // Svátek práce
		return true
	case m == time.May && d == 8: // Den vítězství
		return true
	case m == time.July && d == 5: // Cyril a Metoděj
		return true
	case m == time.July && d == 6: // Jan Hus
		return true
	case m == time.September && d == 28: // Den české státnosti
		return true
	case m == time.October && d == 28: // Den vzniku samostatného ČSR
		return true
	case m == time.November && d == 17: // Boj za svobodu a demokracii
		return true
	case m == time.December && d == 24: // Štědrý den
		return true
	case m == time.December && d == 25: // 1. svátek vánoční
		return true
	case m == time.December && d == 26: // 2. svátek vánoční
		return true
	}
	// Moving holidays.
	easter := EasterSunday(y)
	goodFriday := easter.AddDate(0, 0, -2)
	easterMonday := easter.AddDate(0, 0, 1)
	if sameYMD(t, goodFriday) || sameYMD(t, easterMonday) {
		return true
	}
	return false
}

// EasterSunday returns the Gregorian Easter Sunday for the given year using
// the Meeus/Jones/Butcher algorithm. Time component is 00:00 UTC.
func EasterSunday(year int) time.Time {
	a := year % 19
	b := year / 100
	c := year % 100
	d := b / 4
	e := b % 4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i := c / 4
	k := c % 4
	L := (32 + 2*e + 2*i - h - k) % 7
	mM := (a + 11*h + 22*L) / 451
	month := (h + L - 7*mM + 114) / 31
	day := ((h + L - 7*mM + 114) % 31) + 1
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
}

func sameYMD(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

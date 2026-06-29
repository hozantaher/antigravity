package calendar

import "time"

const (
	// SendWindowStart is the first hour (inclusive) of the business send window
	// in the recipient's local timezone.
	SendWindowStart = 8 // 08:00 local time

	// SendWindowEnd is the first hour (exclusive) past the business send window.
	SendWindowEnd = 17 // 17:00 local time (sends stop at 16:59)
)

// InSendWindow reports true when t falls within business hours (Mon–Fri, 08:00–16:59)
// in the given IANA timezone string. An unrecognised or empty tz falls back to UTC.
func InSendWindow(t time.Time, tz string) bool {
	loc := loadLocation(tz)
	local := t.In(loc)
	if local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		return false
	}
	h := local.Hour()
	return h >= SendWindowStart && h < SendWindowEnd
}

// NextSendTime returns the earliest time that is inside the send window.
// If t is already inside the window, t is returned unchanged. When t falls on
// a sendable weekday but BEFORE the window opens, the result is TODAY at 09:00.
// Otherwise (t is at/after the window close, or the day is a weekend/holiday)
// the result is 09:00 on the next business weekday (Mon–Fri). The result is
// expressed in UTC.
func NextSendTime(t time.Time, tz string) time.Time {
	if InSendWindow(t, tz) {
		return t
	}
	loc := loadLocation(tz)
	local := t.In(loc)

	// Pick the target day. When t already falls on a sendable weekday but
	// BEFORE the window opens (hour < SendWindowStart), the earliest valid
	// slot is TODAY at the open hour — advancing to the next day would delay a
	// pre-open send by a full day (e.g. Fri 07:00 would skip to Mon instead of
	// returning Fri 09:00). Only advance to the next calendar day when t is
	// at/after the window close OR today is not a sendable day.
	next := local
	if !(IsSendableDay(local) && local.Hour() < SendWindowStart) {
		// Move to the next calendar day, then keep skipping until we land on a
		// sendable weekday. IsSendableDay covers weekends + Czech holidays
		// (fixed-date + Easter-relative via Meeus). Without this guard,
		// NextSendTime would happily return Easter Monday 09:00 — the runner
		// then skips the campaign on the next tick (IsSendableDay gate at
		// runner.go:147), wasting one full scheduler cycle. Bound the loop
		// at 30 iterations as a safety net against pathological tz/holiday
		// configurations (real-world max gap is ~5 days for Christmas + NY).
		next = local.AddDate(0, 0, 1)
		for i := 0; i < 30; i++ {
			if IsSendableDay(next) {
				break
			}
			next = next.AddDate(0, 0, 1)
		}
	}

	// Fix the time to 09:00 on that day (within the send window, with a small
	// margin after the 08:00 open so the very first send is not at the sharp edge).
	next = time.Date(next.Year(), next.Month(), next.Day(), 9, 0, 0, 0, loc)
	return next.UTC()
}

// loadLocation parses an IANA timezone name and falls back to UTC on error.
func loadLocation(tz string) *time.Location {
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.UTC
	}
	return loc
}

// Package sender — wrap-around send-window gate tests.
//
// Operator spec 2026-05-13:
//
//	"6-3 wrap = 06:00 Prague → 03:00 next day"
//
// Engine must accept (start > end) as an overnight wrap-around window
// in addition to the legacy (start < end) same-day shape. This test
// pack exercises HourInSendWindow + the engine's inWorkingHours gate
// across every shape (same-day, wrap, zero-width, all-day).
//
// Risk-proportional testing per HARD RULE feedback_extreme_testing T0:
// the engine is state-mutating, security-adjacent (mis-firing outside
// business hours is a deliverability + complaint risk). Coverage spans
// boundary hours, both window shapes, and the inWorkingHours plumbing
// in a Europe/Prague locale.
package sender

import (
	"common/config"
	"testing"
	"time"
)

// TestHourInSendWindow_SameDay verifies the legacy (start < end) shape
// behaves exactly as the original `hour >= start && hour < end` predicate.
// Boundary check: start hour is inside, end hour is outside.
func TestHourInSendWindow_SameDay(t *testing.T) {
	cases := []struct {
		hour       int
		want       bool
		annotation string
	}{
		{0, false, "midnight before window"},
		{5, false, "hour before start"},
		{6, true, "start hour inclusive"},
		{12, true, "midday inside"},
		{22, true, "last hour inside (end-1)"},
		{23, false, "end hour exclusive"},
	}
	start, end := 6, 23
	for _, tc := range cases {
		got := config.HourInSendWindow(tc.hour, start, end)
		if got != tc.want {
			t.Errorf("same-day [%d,%d) hour=%d (%s): got %v, want %v",
				start, end, tc.hour, tc.annotation, got, tc.want)
		}
	}
}

// TestHourInSendWindow_OvernightWrap_22_3 verifies the overnight shape
// where start > end. Valid hours sit in [22, 24) ∪ [0, 3).
func TestHourInSendWindow_OvernightWrap_22_3(t *testing.T) {
	cases := []struct {
		hour       int
		want       bool
		annotation string
	}{
		{22, true, "start hour inclusive"},
		{23, true, "last evening hour"},
		{0, true, "midnight wraps into window"},
		{1, true, "post-midnight inside"},
		{2, true, "last hour before end"},
		{3, false, "end hour exclusive"},
		{4, false, "morning gap"},
		{12, false, "midday outside"},
		{21, false, "hour before start"},
	}
	start, end := 22, 3
	for _, tc := range cases {
		got := config.HourInSendWindow(tc.hour, start, end)
		if got != tc.want {
			t.Errorf("wrap [%d→24)∪[0→%d) hour=%d (%s): got %v, want %v",
				start, end, tc.hour, tc.annotation, got, tc.want)
		}
	}
}

// TestHourInSendWindow_OvernightWrap_6_3 is the operator's actual
// requested shape: 06:00 Prague → 03:00 next day. The window spans
// 21 hours; only hours 3, 4, 5 are excluded.
func TestHourInSendWindow_OvernightWrap_6_3(t *testing.T) {
	cases := []struct {
		hour       int
		want       bool
		annotation string
	}{
		{0, true, "midnight inside wrap tail"},
		{2, true, "last hour before end"},
		{3, false, "end hour exclusive — first gap hour"},
		{4, false, "deep in morning gap"},
		{5, false, "last gap hour before start"},
		{6, true, "start hour inclusive"},
		{12, true, "midday inside"},
		{23, true, "last evening hour"},
	}
	start, end := 6, 3
	for _, tc := range cases {
		got := config.HourInSendWindow(tc.hour, start, end)
		if got != tc.want {
			t.Errorf("wrap [%d→24)∪[0→%d) hour=%d (%s): got %v, want %v",
				start, end, tc.hour, tc.annotation, got, tc.want)
		}
	}
}

// TestHourInSendWindow_ZeroWidth — start == end is treated as "never
// send". Operators that want "always send" must use (0, 24).
func TestHourInSendWindow_ZeroWidth(t *testing.T) {
	for hour := 0; hour < 24; hour++ {
		if config.HourInSendWindow(hour, 12, 12) {
			t.Errorf("zero-width window 12==12 hour=%d: expected never send", hour)
		}
	}
}

// TestHourInSendWindow_AllDay verifies (0, 24) — the canonical
// "always send" config used by every unit test fixture in the package.
func TestHourInSendWindow_AllDay(t *testing.T) {
	for hour := 0; hour < 24; hour++ {
		if !config.HourInSendWindow(hour, 0, 24) {
			t.Errorf("all-day window (0,24) hour=%d: expected send", hour)
		}
	}
}

// TestEffectiveSendWindow_OvernightLegacy ensures the legacy fields
// (WindowStart, WindowEnd) also accept the wrap-around shape — required
// because Railway env SENDING_WINDOW_START / SENDING_WINDOW_END flow
// into those fields and the operator wants 6→3 via that legacy path
// without renaming env vars.
func TestEffectiveSendWindow_OvernightLegacy(t *testing.T) {
	s := config.SendingConfig{WindowStart: 6, WindowEnd: 3}
	start, end := s.EffectiveSendWindow()
	if start != 6 || end != 3 {
		t.Errorf("legacy wrap (6,3): got (%d,%d)", start, end)
	}
	if !config.HourInSendWindow(0, start, end) {
		t.Error("expected hour=0 inside wrap")
	}
	if config.HourInSendWindow(4, start, end) {
		t.Error("expected hour=4 outside wrap")
	}
}

// TestEffectiveSendWindow_OvernightNewFieldsWin verifies the new
// SendWindowStartHour / SendWindowEndHour pair also supports wrap.
func TestEffectiveSendWindow_OvernightNewFieldsWin(t *testing.T) {
	s := config.SendingConfig{
		WindowStart:         9,
		WindowEnd:           17,
		SendWindowStartHour: 22,
		SendWindowEndHour:   3,
	}
	start, end := s.EffectiveSendWindow()
	if start != 22 || end != 3 {
		t.Errorf("expected new-field wrap (22,3), got (%d,%d)", start, end)
	}
}

// TestEngineInWorkingHours_OvernightWrap_Prague exercises the actual
// engine gate (not just the helper) in Europe/Prague so DST/locale logic
// stays honest. Picks a non-DST-transition day for stability.
func TestEngineInWorkingHours_OvernightWrap_Prague(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Prague")
	if err != nil {
		t.Fatalf("load Europe/Prague: %v", err)
	}
	e := &Engine{
		sending: config.SendingConfig{
			Environment: "production",
			Timezone:    "Europe/Prague",
			// Operator spec — 06:00 Prague → 03:00 next day.
			WindowStart: 6,
			WindowEnd:   3,
		},
	}
	mb := config.MailboxConfig{Address: "test@example.com"}
	// 2026-06-15 is a Monday (weekday) outside both Czech DST transitions
	// (last-Sun-March, last-Sun-October) so we exercise the gate cleanly.
	day := func(hour int) time.Time {
		return time.Date(2026, 6, 15, hour, 30, 0, 0, loc)
	}
	cases := []struct {
		hour int
		want bool
		why  string
	}{
		{0, true, "midnight inside wrap tail"},
		{2, true, "last hour before end"},
		{3, false, "end hour exclusive"},
		{4, false, "morning gap"},
		{5, false, "last gap hour"},
		{6, true, "start inclusive"},
		{12, true, "midday inside"},
		{23, true, "last evening hour"},
	}
	for _, tc := range cases {
		got := e.inWorkingHours(day(tc.hour), mb)
		if got != tc.want {
			t.Errorf("Prague %02d:30 (%s): got %v, want %v",
				tc.hour, tc.why, got, tc.want)
		}
	}
}

// TestEngineInWorkingHours_OvernightWrap_WeekdaysOnly verifies the
// WeekdaysOnly veto still applies on top of wrap-around windows. A
// Saturday post-midnight hour is inside the time window but must be
// rejected because the day is a weekend.
func TestEngineInWorkingHours_OvernightWrap_WeekdaysOnly(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Prague")
	if err != nil {
		t.Fatalf("load Europe/Prague: %v", err)
	}
	e := &Engine{
		sending: config.SendingConfig{
			Environment:  "production",
			Timezone:     "Europe/Prague",
			WeekdaysOnly: true,
			WindowStart:  22,
			WindowEnd:    3,
		},
	}
	mb := config.MailboxConfig{Address: "test@example.com"}
	// 2026-06-13 is a Saturday in Europe/Prague.
	saturdayAt1AM := time.Date(2026, 6, 13, 1, 0, 0, 0, loc)
	if e.inWorkingHours(saturdayAt1AM, mb) {
		t.Error("weekday-only must reject Saturday even when hour is inside wrap window")
	}
	// Sunday 23:00 — also inside the wrap window, also weekend.
	sundayAt11PM := time.Date(2026, 6, 14, 23, 0, 0, 0, loc)
	if e.inWorkingHours(sundayAt11PM, mb) {
		t.Error("weekday-only must reject Sunday even when hour is inside wrap window")
	}
	// Monday 23:00 — inside the wrap window, weekday → must pass.
	mondayAt11PM := time.Date(2026, 6, 15, 23, 0, 0, 0, loc)
	if !e.inWorkingHours(mondayAt11PM, mb) {
		t.Error("weekday-only must accept Monday 23:00 inside wrap window")
	}
}

// TestEngineInWorkingHours_SameDayUnchanged is the regression net for
// the legacy same-day shape so the wrap-around code path does not leak
// into existing 9-17 deployments.
func TestEngineInWorkingHours_SameDayUnchanged(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Prague")
	if err != nil {
		t.Fatalf("load Europe/Prague: %v", err)
	}
	e := &Engine{
		sending: config.SendingConfig{
			Environment: "production",
			Timezone:    "Europe/Prague",
			WindowStart: 9,
			WindowEnd:   17,
		},
	}
	mb := config.MailboxConfig{Address: "test@example.com"}
	day := func(hour int) time.Time {
		return time.Date(2026, 6, 15, hour, 30, 0, 0, loc)
	}
	for _, tc := range []struct {
		hour int
		want bool
	}{
		{0, false}, {8, false}, {9, true}, {12, true},
		{16, true}, {17, false}, {23, false},
	} {
		if got := e.inWorkingHours(day(tc.hour), mb); got != tc.want {
			t.Errorf("same-day [9,17) hour=%d: got %v, want %v", tc.hour, got, tc.want)
		}
	}
}

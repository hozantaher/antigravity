package sender

// engine_anti_trace_timing_test.go — feat/anti-trace-timing-scheduler
//
// Coverage for three production hard-gates added after the brutal
// anonymity test (2026-05-01 score 17/100):
//
//   1. Subject scrub — strip "[A:<short>]" run-id markers in production
//      and relocate them to the X-Test-Run-ID header (relay strips X-*).
//   2. Working-hours scheduler — defer sends outside the mailbox-local
//      [SendWindowStartHour, SendWindowEndHour) window, weekdays only
//      when SEND_WEEKDAYS_ONLY=true.
//   3. Wider Poisson timing — clampedPoisson with mean=120s, [30,300] clamp
//      and per-mailbox MailboxMinSpacingSeconds dampener.
//
// All gates are no-ops when SendingConfig.Environment != "production",
// preserving existing test and dev behaviour.

import (
	"strings"
	"testing"
	"time"

	"common/config"
)

// ── FIX 1: subject scrub ─────────────────────────────────────────────────────

func newEngineForScrub(env string, allow bool) *Engine {
	return NewEngine(
		nil,
		config.SendingConfig{
			Environment:      env,
			AllowTestMarkers: allow,
		},
		config.SafetyConfig{},
	)
}

func TestScrubSubjectMarker_ProductionStripsMarker(t *testing.T) {
	e := newEngineForScrub("production", false)
	req := SendRequest{
		Subject: "[A:1a2b3c4d] Váš stroj je připraven",
		Headers: map[string]string{},
	}
	modified := e.scrubSubjectMarker(&req)
	if !modified {
		t.Fatalf("expected scrub to fire in production")
	}
	if strings.Contains(req.Subject, subjectMarkerPrefix) {
		t.Errorf("subject still contains marker: %q", req.Subject)
	}
	if got := req.Headers[xTestRunIDHeader]; got != "1a2b3c4d" {
		t.Errorf("X-Test-Run-ID = %q, want %q", got, "1a2b3c4d")
	}
}

func TestScrubSubjectMarker_NonProductionPassthrough(t *testing.T) {
	e := newEngineForScrub("dev", false)
	req := SendRequest{
		Subject: "[A:1a2b3c4d] Hello",
		Headers: map[string]string{},
	}
	modified := e.scrubSubjectMarker(&req)
	if modified {
		t.Errorf("expected no scrub outside production")
	}
	if !strings.Contains(req.Subject, subjectMarkerPrefix) {
		t.Errorf("non-production must preserve marker, got %q", req.Subject)
	}
}

func TestScrubSubjectMarker_AllowTestMarkersPreserves(t *testing.T) {
	e := newEngineForScrub("production", true)
	req := SendRequest{
		Subject: "[A:abcd1234] Hello",
		Headers: map[string]string{},
	}
	modified := e.scrubSubjectMarker(&req)
	if modified {
		t.Errorf("ALLOW_TEST_MARKERS=true should preserve marker even in prod")
	}
	if !strings.HasPrefix(req.Subject, subjectMarkerPrefix) {
		t.Errorf("subject got mutated: %q", req.Subject)
	}
}

func TestScrubSubjectMarker_NoMarkerNoOp(t *testing.T) {
	e := newEngineForScrub("production", false)
	req := SendRequest{Subject: "Plain old subject", Headers: map[string]string{}}
	if e.scrubSubjectMarker(&req) {
		t.Errorf("scrub fired with no marker present")
	}
	if req.Subject != "Plain old subject" {
		t.Errorf("subject changed: %q", req.Subject)
	}
}

func TestScrubSubjectMarker_NilHeadersAllocates(t *testing.T) {
	e := newEngineForScrub("production", false)
	req := SendRequest{Subject: "[A:deadbeef] x"}
	if !e.scrubSubjectMarker(&req) {
		t.Fatalf("expected scrub")
	}
	if req.Headers == nil {
		t.Fatalf("expected Headers to be allocated")
	}
	if req.Headers[xTestRunIDHeader] != "deadbeef" {
		t.Errorf("expected header to be set, got %v", req.Headers)
	}
}

func TestScrubSubjectMarker_MalformedPrefixStripsLiteralOnly(t *testing.T) {
	// Subject begins with "[A:" but never closes — defensive strip path.
	e := newEngineForScrub("production", false)
	req := SendRequest{Subject: "[A:no-bracket runaway", Headers: map[string]string{}}
	modified := e.scrubSubjectMarker(&req)
	if !modified {
		t.Fatalf("expected scrub for malformed prefix")
	}
	if strings.HasPrefix(req.Subject, subjectMarkerPrefix) {
		t.Errorf("literal prefix must be removed, got %q", req.Subject)
	}
}

func TestScrubSubjectMarker_DoesNotOverrideExistingHeader(t *testing.T) {
	e := newEngineForScrub("production", false)
	req := SendRequest{
		Subject: "[A:newval] hi",
		Headers: map[string]string{xTestRunIDHeader: "preset"},
	}
	if !e.scrubSubjectMarker(&req) {
		t.Fatalf("scrub did not fire")
	}
	if req.Headers[xTestRunIDHeader] != "preset" {
		t.Errorf("scrub must not clobber existing header; got %q", req.Headers[xTestRunIDHeader])
	}
}

// ── FIX 2: working-hours scheduler ───────────────────────────────────────────

func newEngineForWorkingHours(env string, weekdaysOnly bool, mbTZ string) *Engine {
	return NewEngine(
		[]config.MailboxConfig{{Address: "test@example.cz", Timezone: mbTZ}},
		config.SendingConfig{
			Environment:         env,
			Timezone:            "Europe/Prague",
			SendWindowStartHour: 9,
			SendWindowEndHour:   17,
			WeekdaysOnly:        weekdaysOnly,
		},
		config.SafetyConfig{},
	)
}

func mailboxFor(e *Engine) config.MailboxConfig {
	return e.mailboxes[0]
}

// 16:59 Friday Europe/Prague → still inside window.
func TestInWorkingHours_ProductionFridayEdge1659_Allows(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 1, 16, 59, 0, 0, loc) // Friday
	if !e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("16:59 Friday should be inside the window")
	}
}

// 17:01 Friday → outside (end is exclusive).
func TestInWorkingHours_ProductionFridayEdge1701_Defers(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 1, 17, 1, 0, 0, loc)
	if e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("17:01 must be outside [9, 17)")
	}
}

// 09:00 Monday → first sendable minute.
func TestInWorkingHours_ProductionMonday0900_Allows(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 4, 9, 0, 0, 0, loc) // Monday
	if !e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("09:00 Monday should be inside")
	}
}

// 08:59 Monday → outside (before start).
func TestInWorkingHours_ProductionMonday0859_Defers(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 4, 8, 59, 0, 0, loc)
	if e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("08:59 Monday must be before window start")
	}
}

// Saturday/Sunday rejected when WeekdaysOnly=true.
func TestInWorkingHours_ProductionSaturday_Defers(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 2, 12, 0, 0, 0, loc) // Saturday
	if e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("Saturday must be deferred when WeekdaysOnly=true")
	}
}

func TestInWorkingHours_ProductionSunday_Defers(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 3, 12, 0, 0, 0, loc) // Sunday
	if e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("Sunday must be deferred when WeekdaysOnly=true")
	}
}

// WeekdaysOnly=false allows Saturday in window.
func TestInWorkingHours_ProductionSaturdayWeekendsAllowed(t *testing.T) {
	e := newEngineForWorkingHours("production", false, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	now := time.Date(2026, 5, 2, 12, 0, 0, 0, loc) // Saturday noon
	if !e.inWorkingHours(now, mailboxFor(e)) {
		t.Errorf("WeekdaysOnly=false should allow Saturday in-window")
	}
}

// Non-production = always allow.
func TestInWorkingHours_NonProductionAlwaysAllow(t *testing.T) {
	e := newEngineForWorkingHours("dev", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	weekend := time.Date(2026, 5, 3, 22, 17, 0, 0, loc) // Sunday 22:17 — the case the brutal test flagged
	if !e.inWorkingHours(weekend, mailboxFor(e)) {
		t.Errorf("non-production must keep legacy permissive behaviour")
	}
}

// nextWorkingHour: Sunday 22:17 → Monday 09:00 local.
func TestNextWorkingHour_SundayLateEvening_ReturnsMonday0900(t *testing.T) {
	e := newEngineForWorkingHours("production", true, "Europe/Prague")
	loc, _ := time.LoadLocation("Europe/Prague")
	sunday := time.Date(2026, 5, 3, 22, 17, 0, 0, loc) // Sunday
	got := e.nextWorkingHour(sunday, mailboxFor(e)).In(loc)
	if got.Weekday() != time.Monday {
		t.Errorf("expected Monday, got %s", got.Weekday())
	}
	if got.Hour() != 9 {
		t.Errorf("expected hour=9, got %d", got.Hour())
	}
}

// Mailbox-local timezone overrides global.
func TestMailboxLocalTimezone_PerMailboxOverride(t *testing.T) {
	tz := mailboxLocalTimezone(
		config.SendingConfig{Timezone: "Europe/Prague"},
		config.MailboxConfig{Timezone: "America/New_York"},
	)
	if tz != "America/New_York" {
		t.Errorf("expected mailbox TZ to win, got %q", tz)
	}
}

func TestMailboxLocalTimezone_FallbackChain(t *testing.T) {
	tz := mailboxLocalTimezone(
		config.SendingConfig{Timezone: ""},
		config.MailboxConfig{Timezone: ""},
	)
	if tz != "Europe/Prague" {
		t.Errorf("expected default Europe/Prague, got %q", tz)
	}
}

// EffectiveSendWindow falls back when new fields unset.
func TestEffectiveSendWindow_NewFieldsWin(t *testing.T) {
	s := config.SendingConfig{
		WindowStart:         8,
		WindowEnd:           18,
		SendWindowStartHour: 10,
		SendWindowEndHour:   16,
	}
	start, end := s.EffectiveSendWindow()
	if start != 10 || end != 16 {
		t.Errorf("expected (10,16), got (%d,%d)", start, end)
	}
}

func TestEffectiveSendWindow_LegacyFallback(t *testing.T) {
	s := config.SendingConfig{WindowStart: 8, WindowEnd: 18}
	start, end := s.EffectiveSendWindow()
	if start != 8 || end != 18 {
		t.Errorf("expected (8,18), got (%d,%d)", start, end)
	}
}

func TestEffectiveSendWindow_OvernightWrapPreserved(t *testing.T) {
	// Per operator spec 2026-05-13: start > end is now a valid overnight
	// wrap-around (18→8 = 18:00 today through 08:00 next morning), not a
	// misconfiguration. The previous defensive 9-17 rewrite would silently
	// shrink an operator-chosen overnight window.
	s := config.SendingConfig{WindowStart: 18, WindowEnd: 8}
	start, end := s.EffectiveSendWindow()
	if start != 18 || end != 8 {
		t.Errorf("expected overnight wrap (18,8) preserved, got (%d,%d)", start, end)
	}
}

func TestEffectiveSendWindow_ZeroConfigDefault(t *testing.T) {
	// Both fields unset (zero) → defensive 09:00–17:00 so a misconfigured
	// boot does not collapse to "never send" or "always send".
	s := config.SendingConfig{}
	start, end := s.EffectiveSendWindow()
	if start != 9 || end != 17 {
		t.Errorf("expected zero-config default (9,17), got (%d,%d)", start, end)
	}
}

// ── FIX 3: Poisson timing distribution ───────────────────────────────────────

// 1000 samples within configured min/max bounds, mean within adjusted bounds.
// Right-skew of clamped Poisson (clamping left cuts more mass than right) shifts mean
// slightly above unclamped target. Bounds [105s, 145s] accommodate this + provide stability.
func TestHumanSendDelayConfig_DistributionWithinBounds(t *testing.T) {
	cfg := config.SendingConfig{
		PoissonMeanSeconds: 120,
		PoissonMinSeconds:  30,
		PoissonMaxSeconds:  300,
	}
	noon := time.Date(2026, 5, 4, 14, 0, 0, 0, time.UTC) // afternoon factor=1.0
	const n = 1000
	var total time.Duration
	for i := 0; i < n; i++ {
		d := humanSendDelayConfig(cfg, noon)
		if d < 30*time.Second {
			t.Fatalf("sample %d: %v < 30s", i, d)
		}
		if d > 300*time.Second {
			t.Fatalf("sample %d: %v > 300s", i, d)
		}
		total += d
	}
	avg := total / n
	// Mean in [105s, 145s] window (accounts for right-skew of clamped Poisson).
	if avg < 105*time.Second || avg > 145*time.Second {
		t.Errorf("avg %v not in [105s, 145s] over %d samples", avg, n)
	}
}

// Hard clamp: clampedPoisson never returns < min or > max.
func TestClampedPoisson_HardClamp(t *testing.T) {
	for i := 0; i < 1000; i++ {
		d := clampedPoisson(120, 30, 300)
		if d < 30*time.Second {
			t.Fatalf("iter %d: got %v < 30s", i, d)
		}
		if d > 300*time.Second {
			t.Fatalf("iter %d: got %v > 300s", i, d)
		}
	}
}

// LegacyMinDelaySeconds fallback (Poisson fields unset).
func TestHumanSendDelayConfig_LegacyFallback(t *testing.T) {
	cfg := config.SendingConfig{
		MinDelaySeconds: 45,
		MaxDelaySeconds: 180,
	}
	for i := 0; i < 200; i++ {
		d := humanSendDelayConfig(cfg, time.Now())
		if d < 45*time.Second || d > 180*time.Second {
			t.Errorf("iter %d: %v outside legacy [45s,180s]", i, d)
		}
	}
}

// Anti-burst: mailboxSpacingOK enforces MIN_SPACING.
func TestMailboxSpacingOK_DefersWhenTooSoon(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@x"}},
		config.SendingConfig{MailboxMinSpacingSeconds: 60},
		config.SafetyConfig{},
	)
	now := time.Now()
	// Stamp last_send_at as "10s ago".
	e.mu.Lock()
	e.mailboxLastSend["a@x"] = now.Add(-10 * time.Second)
	e.mu.Unlock()
	ok, wait := e.mailboxSpacingOK("a@x", now)
	if ok {
		t.Errorf("expected defer; got ok=true")
	}
	if wait < 49*time.Second || wait > 51*time.Second {
		t.Errorf("expected ~50s wait, got %v", wait)
	}
}

func TestMailboxSpacingOK_AllowsWhenSpacingMet(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@x"}},
		config.SendingConfig{MailboxMinSpacingSeconds: 60},
		config.SafetyConfig{},
	)
	now := time.Now()
	e.mu.Lock()
	e.mailboxLastSend["a@x"] = now.Add(-2 * time.Minute)
	e.mu.Unlock()
	ok, _ := e.mailboxSpacingOK("a@x", now)
	if !ok {
		t.Errorf("expected allow after 2min")
	}
}

func TestMailboxSpacingOK_NoLastSendAllows(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@x"}},
		config.SendingConfig{MailboxMinSpacingSeconds: 60},
		config.SafetyConfig{},
	)
	ok, wait := e.mailboxSpacingOK("a@x", time.Now())
	if !ok || wait != 0 {
		t.Errorf("expected (true, 0) for first send; got (%v, %v)", ok, wait)
	}
}

func TestMailboxSpacingOK_DisabledWhenZero(t *testing.T) {
	e := NewEngine(
		[]config.MailboxConfig{{Address: "a@x"}},
		config.SendingConfig{MailboxMinSpacingSeconds: 0},
		config.SafetyConfig{},
	)
	now := time.Now()
	e.mu.Lock()
	e.mailboxLastSend["a@x"] = now.Add(-1 * time.Millisecond)
	e.mu.Unlock()
	ok, _ := e.mailboxSpacingOK("a@x", now)
	if !ok {
		t.Errorf("expected disabled=>allow")
	}
}

// IsProduction parses ENVIRONMENT variants safely.
func TestIsProduction_VariantParsing(t *testing.T) {
	cases := []struct {
		env string
		ok  bool
	}{
		{"production", true},
		{"Production", true},
		{"PRODUCTION", true},
		{" production ", true},
		{"prod", false},
		{"", false},
		{"staging", false},
		{"dev", false},
	}
	for _, tc := range cases {
		s := config.SendingConfig{Environment: tc.env}
		if got := s.IsProduction(); got != tc.ok {
			t.Errorf("Environment=%q → IsProduction=%v, want %v", tc.env, got, tc.ok)
		}
	}
}

// minDuration helper smoke.
func TestMinDuration(t *testing.T) {
	a := time.Second
	b := 2 * time.Second
	if minDuration(a, b) != a {
		t.Errorf("expected %v, got %v", a, minDuration(a, b))
	}
	if minDuration(b, a) != a {
		t.Errorf("expected %v, got %v (reversed)", a, minDuration(b, a))
	}
}

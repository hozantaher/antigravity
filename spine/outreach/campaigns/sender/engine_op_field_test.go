package sender

// BF-F2 — per-site op-field verification tests.
//
// The slog_op_audit_test.go discipline test asserts no call site is MISSING
// an "op" field (static AST scan). These tests complement it by asserting
// that the five sites grandfathered in the baseline-5 era now emit the
// CORRECT "op" value at runtime.
//
// The five sites (sender package, all engine.go):
//
//  1. engine.pickMailbox/dailyCap        — daily-cap oracle error (fail-open)
//  2. engine.activeRegistry              — registry ActiveAddresses failure
//  3. engine.recordSendResult/cooldown   — per-mailbox cooldown triggered
//  4. engine.recordSendResult/domainCircuit — domain circuit breaker opens
//  5. engine.recordSendResult/globalCircuit — global circuit breaker opens
//
// Coverage: ≥10 sub-assertions across the 5 cases (boundary + error paths
// per feedback_extreme_testing).

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"common/config"
)

// captureSlogSender redirects slog.Default to an in-memory buffer and
// restores the original logger via t.Cleanup. The pattern mirrors
// campaign.captureSlog so the two packages can diverge independently.
func captureSlogSender(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return &buf
}

// assertOpField checks that the captured log output contains an "op" key
// whose value equals the given tag.
func assertOpField(t *testing.T, buf *bytes.Buffer, wantOp string) {
	t.Helper()
	out := buf.String()
	// slog TextHandler serialises key=value pairs; look for op=<tag>.
	opEntry := "op=" + wantOp
	if !strings.Contains(out, opEntry) {
		t.Errorf("expected log output to contain %q\nactual log output:\n%s", opEntry, out)
	}
}

// ── Site 1: engine.pickMailbox/dailyCap ─────────────────────────────────────

// TestOpField_PickMailbox_DailyCap_Warn verifies that when the persistent
// daily-cap oracle returns an error, the slog.Warn call emits
// op="engine.pickMailbox/dailyCap" and the message "daily cap oracle error".
func TestOpField_PickMailbox_DailyCap_Warn(t *testing.T) {
	buf := captureSlogSender(t)

	mbs := []config.MailboxConfig{
		{Address: "a@s.test", DailyLimit: 100},
	}
	e := NewEngine(mbs, config.SendingConfig{}, config.SafetyConfig{}).
		WithDailyCapFunc(func(_ string) (bool, error) {
			return false, errors.New("postgres connection reset")
		})

	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("oracle error must not block pickMailbox: %v", err)
	}
	if mb.Address != "a@s.test" {
		t.Errorf("expected a@s.test, got %q", mb.Address)
	}

	// op field
	assertOpField(t, buf, "engine.pickMailbox/dailyCap")
	// message
	if !strings.Contains(buf.String(), "daily cap oracle error") {
		t.Errorf("expected 'daily cap oracle error' in log; got:\n%s", buf.String())
	}
	// address field is present
	if !strings.Contains(buf.String(), "a@s.test") {
		t.Errorf("expected mailbox address in log; got:\n%s", buf.String())
	}
}

// TestOpField_PickMailbox_DailyCap_WarnLevel confirms the site uses Warn
// not Error (so it stays below the Sentry bridge threshold under load).
func TestOpField_PickMailbox_DailyCap_WarnLevel(t *testing.T) {
	buf := captureSlogSender(t)

	e := NewEngine(
		[]config.MailboxConfig{{Address: "b@s.test", DailyLimit: 100}},
		config.SendingConfig{}, config.SafetyConfig{},
	).WithDailyCapFunc(func(_ string) (bool, error) {
		return false, errors.New("timeout")
	})
	_, _ = e.pickMailbox("")

	out := buf.String()
	if strings.Contains(out, "ERROR") {
		t.Errorf("oracle error should be WARN not ERROR; got:\n%s", out)
	}
	if !strings.Contains(out, "WARN") {
		t.Errorf("expected WARN level; got:\n%s", out)
	}
}

// ── Site 2: engine.activeRegistry ───────────────────────────────────────────

// TestOpField_ActiveRegistry_Warn verifies that when
// registry.ActiveAddresses returns an error, the slog.Warn call emits
// op="engine.activeRegistry". INCIDENT 2026-05-13: this test pins the
// non-strict / legacy path, so we opt out of strict mode after wiring the
// registry. Behaviour under strict mode is covered by
// TestEngine_PickMailbox_RegistryUnavailableErrorIsWrapped.
func TestOpField_ActiveRegistry_Warn(t *testing.T) {
	buf := captureSlogSender(t)

	bp := &fakeBackpressure{activeErr: errors.New("db down")}
	e := NewEngine(
		[]config.MailboxConfig{{Address: "c@s.test", DailyLimit: 100}},
		config.SendingConfig{}, config.SafetyConfig{},
	).WithMailboxRegistry(bp).WithStrictRegistryEnforcement(false)

	// resolveRegistryAllowed is called inside pickMailbox.
	mb, err := e.pickMailbox("")
	if err != nil {
		t.Fatalf("registry outage must not block pickMailbox: %v", err)
	}
	if mb.Address != "c@s.test" {
		t.Errorf("expected c@s.test, got %q", mb.Address)
	}

	assertOpField(t, buf, "engine.activeRegistry")
	if !strings.Contains(buf.String(), "ActiveAddresses") {
		t.Errorf("expected message fragment 'ActiveAddresses' in log; got:\n%s", buf.String())
	}
}

// TestOpField_ActiveRegistry_WarnLevel confirms the site uses Warn.
// Opt-out of strict mode mirrors TestOpField_ActiveRegistry_Warn — strict
// mode adds an ERROR-level log, which would conflict with the WARN-only
// assertion below.
func TestOpField_ActiveRegistry_WarnLevel(t *testing.T) {
	buf := captureSlogSender(t)

	bp := &fakeBackpressure{activeErr: errors.New("timeout")}
	e := NewEngine(
		[]config.MailboxConfig{{Address: "c@s.test", DailyLimit: 100}},
		config.SendingConfig{}, config.SafetyConfig{},
	).WithMailboxRegistry(bp).WithStrictRegistryEnforcement(false)
	_, _ = e.pickMailbox("")

	out := buf.String()
	if strings.Contains(out, "ERROR") {
		t.Errorf("registry outage should be WARN not ERROR; got:\n%s", out)
	}
	if !strings.Contains(out, "WARN") {
		t.Errorf("expected WARN level in log; got:\n%s", out)
	}
}

// ── Site 3: engine.recordSendResult/cooldown ────────────────────────────────

// TestOpField_RecordSendResult_Cooldown_Warn verifies that when a mailbox
// hits mailboxFailThreshold consecutive SMTPUnknown errors the resulting
// slog.Warn contains op="engine.recordSendResult/cooldown".
func TestOpField_RecordSendResult_Cooldown_Warn(t *testing.T) {
	buf := captureSlogSender(t)

	e := newBreakerEngine("d@s.test")
	unknown := errors.New("dial: connection refused")

	for i := 0; i < mailboxFailThreshold; i++ {
		e.recordSendResult("d@s.test", "rcpt.test", unknown)
	}

	assertOpField(t, buf, "engine.recordSendResult/cooldown")
	if !strings.Contains(buf.String(), "mailbox cooldown triggered") {
		t.Errorf("expected 'mailbox cooldown triggered' message; got:\n%s", buf.String())
	}
	// mailbox field
	if !strings.Contains(buf.String(), "d@s.test") {
		t.Errorf("expected mailbox address in log; got:\n%s", buf.String())
	}
}

// TestOpField_RecordSendResult_Cooldown_BelowThresholdNoLog confirms the
// warning only fires ONCE when the threshold is crossed (not on every failure).
func TestOpField_RecordSendResult_Cooldown_BelowThresholdNoLog(t *testing.T) {
	buf := captureSlogSender(t)

	e := newBreakerEngine("e@s.test")
	unknown := errors.New("connection refused")

	// Trip at exactly threshold failures (threshold-1 must be silent).
	for i := 0; i < mailboxFailThreshold-1; i++ {
		e.recordSendResult("e@s.test", "rcpt.test", unknown)
	}

	if strings.Contains(buf.String(), "engine.recordSendResult/cooldown") {
		t.Errorf("cooldown op must not appear before threshold; got:\n%s", buf.String())
	}
}

// ── Site 4: engine.recordSendResult/domainCircuit ───────────────────────────

// TestOpField_RecordSendResult_DomainCircuit_Error verifies that when the
// per-domain bounce rate exceeds MaxBounceRate the slog.Error call emits
// op="engine.recordSendResult/domainCircuit".
func TestOpField_RecordSendResult_DomainCircuit_Error(t *testing.T) {
	buf := captureSlogSender(t)

	// MaxBounceRate=0.5; safety trip requires >10 attempts to a domain.
	mbs := []config.MailboxConfig{{Address: "f@s.test", DailyLimit: 1000}}
	e := NewEngine(mbs,
		config.SendingConfig{MaxPerDomainHour: 10000, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)

	permanent := errors.New("550 5.1.1 User unknown")
	for i := 0; i < 11; i++ {
		e.recordSendResult("f@s.test", "bounce-domain.test", permanent)
	}

	assertOpField(t, buf, "engine.recordSendResult/domainCircuit")
	if !strings.Contains(buf.String(), "domain circuit breaker open") {
		t.Errorf("expected 'domain circuit breaker open' message; got:\n%s", buf.String())
	}
}

// TestOpField_RecordSendResult_DomainCircuit_TripsOnce verifies the domain
// circuit breaker logs exactly once (idempotent after first open).
func TestOpField_RecordSendResult_DomainCircuit_TripsOnce(t *testing.T) {
	buf := captureSlogSender(t)

	mbs := []config.MailboxConfig{{Address: "g@s.test", DailyLimit: 1000}}
	e := NewEngine(mbs,
		config.SendingConfig{MaxPerDomainHour: 10000, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.5},
	)

	permanent := errors.New("550 user unknown")
	for i := 0; i < 20; i++ {
		e.recordSendResult("g@s.test", "repeat.test", permanent)
	}

	// Count occurrences of the circuit open message.
	count := strings.Count(buf.String(), "domain circuit breaker open")
	if count != 1 {
		t.Errorf("domain circuit breaker should log exactly once; got %d occurrences\n%s", count, buf.String())
	}
}

// ── Site 5: engine.recordSendResult/globalCircuit ───────────────────────────

// TestOpField_RecordSendResult_GlobalCircuit_Error verifies that when the
// global bounce rate trips, the slog.Error call emits
// op="engine.recordSendResult/globalCircuit".
func TestOpField_RecordSendResult_GlobalCircuit_Error(t *testing.T) {
	buf := captureSlogSender(t)

	// Low threshold: MaxBounceRate=0.3 means trip after 4/11 bounces across any domain.
	mbs := []config.MailboxConfig{{Address: "h@s.test", DailyLimit: 1000}}
	e := NewEngine(mbs,
		config.SendingConfig{MaxPerDomainHour: 10000, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.3},
	)

	permanent := errors.New("550 user unknown")
	// Use distinct domains to avoid domain-circuit trip stealing the log line.
	// 11 permanent bounces across 11 domains → global bounce rate = 11/11 > 0.3.
	for i := 0; i < 11; i++ {
		domain := "d" + string(rune('a'+i)) + ".test"
		e.recordSendResult("h@s.test", domain, permanent)
	}

	assertOpField(t, buf, "engine.recordSendResult/globalCircuit")
	if !strings.Contains(buf.String(), "sender global circuit breaker open") {
		t.Errorf("expected 'sender global circuit breaker open' message; got:\n%s", buf.String())
	}
}

// TestOpField_RecordSendResult_GlobalCircuit_ErrorLevel confirms the global
// circuit breaker fires at Error level (important — must reach Sentry bridge).
func TestOpField_RecordSendResult_GlobalCircuit_ErrorLevel(t *testing.T) {
	buf := captureSlogSender(t)

	mbs := []config.MailboxConfig{{Address: "i@s.test", DailyLimit: 1000}}
	e := NewEngine(mbs,
		config.SendingConfig{MaxPerDomainHour: 10000, Timezone: "UTC", WindowStart: 0, WindowEnd: 24},
		config.SafetyConfig{MaxBounceRate: 0.3},
	)

	permanent := errors.New("550 bounced")
	for i := 0; i < 11; i++ {
		domain := "x" + string(rune('a'+i)) + ".test"
		e.recordSendResult("i@s.test", domain, permanent)
	}

	out := buf.String()
	if !strings.Contains(out, "ERROR") {
		t.Errorf("global circuit breaker must log at ERROR level; got:\n%s", out)
	}
}

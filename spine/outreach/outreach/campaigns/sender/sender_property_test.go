package sender

// sender_property_test.go — additional property+monkey tests for campaigns/sender.
// Focuses on pure functions: ClassifySMTPError, greylistingBackoff,
// generateMessageID, randomDelay — edge cases not covered by existing test files.

import (
	"errors"
	"fmt"
	"net/textproto"
	"strings"
	"testing"
	"testing/quick"
	"time"
)

// ─── ClassifySMTPError — monkey and boundary ──────────────────────────────

// TestProperty_ClassifySMTPError_OutputBounded locks the enum to exactly
// the 4 known values — the canonical "bounded output" property test.
func TestProperty_ClassifySMTPError_OutputBounded(t *testing.T) {
	validClasses := map[SMTPClass]bool{
		SMTPOK: true, SMTPTransient: true, SMTPPermanent: true, SMTPUnknown: true,
	}
	f := func(msg string) bool {
		class := ClassifySMTPError(errors.New(msg))
		return validClasses[class]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// TestProperty_ClassifySMTPError_NeverPanicsOnLongStrings monkey test with
// strings up to 4 KB — guards against any substring scan that might read OOB.
func TestProperty_ClassifySMTPError_NeverPanicsOnLongStrings(t *testing.T) {
	padded := strings.Repeat("x", 4096)
	variants := []string{
		padded,
		padded + "greylist",
		padded + "550 user unknown",
		"greylist" + padded,
		"550 " + padded,
	}
	for _, s := range variants {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("panic on long string: %v", r)
				}
			}()
			_ = ClassifySMTPError(errors.New(s))
		}()
	}
}

// TestProperty_ClassifySMTPError_TextprotoCode399IsUnknown boundary: code 399
// is the highest 3xx code — not 4xx, not 5xx → SMTPUnknown.
func TestProperty_ClassifySMTPError_TextprotoCode399IsUnknown(t *testing.T) {
	err := &textproto.Error{Code: 399, Msg: "redirect"}
	if got := ClassifySMTPError(err); got != SMTPUnknown {
		t.Errorf("code 399: want SMTPUnknown, got %v", got)
	}
}

// TestProperty_ClassifySMTPError_TextprotoCode600IsUnknown boundary: 600 is
// just above 5xx range.
func TestProperty_ClassifySMTPError_TextprotoCode600IsUnknown(t *testing.T) {
	err := &textproto.Error{Code: 600, Msg: "??"}
	if got := ClassifySMTPError(err); got != SMTPUnknown {
		t.Errorf("code 600: want SMTPUnknown, got %v", got)
	}
}

// TestProperty_ClassifySMTPError_TextprotoCode499IsTransient boundary: 499
// is the highest 4xx code.
func TestProperty_ClassifySMTPError_TextprotoCode499IsTransient(t *testing.T) {
	err := &textproto.Error{Code: 499, Msg: "last transient"}
	if got := ClassifySMTPError(err); got != SMTPTransient {
		t.Errorf("code 499: want SMTPTransient, got %v", got)
	}
}

// TestProperty_ClassifySMTPError_TextprotoCode599IsPermanent boundary: 599
// is the highest 5xx code.
func TestProperty_ClassifySMTPError_TextprotoCode599IsPermanent(t *testing.T) {
	err := &textproto.Error{Code: 599, Msg: "last permanent"}
	if got := ClassifySMTPError(err); got != SMTPPermanent {
		t.Errorf("code 599: want SMTPPermanent, got %v", got)
	}
}

// TestProperty_ClassifySMTPError_EmptyStringIsUnknown verifies the empty
// error string does not trigger any hint match.
func TestProperty_ClassifySMTPError_EmptyStringIsUnknown(t *testing.T) {
	if got := ClassifySMTPError(errors.New("")); got != SMTPUnknown {
		t.Errorf("empty error string: want SMTPUnknown, got %v", got)
	}
}

// TestProperty_ClassifySMTPError_MixedCaseTransientHints verifies that all
// combinations of upper/lower case for a critical hint still classify correctly.
func TestProperty_ClassifySMTPError_MixedCaseTransientHints(t *testing.T) {
	hints := []string{"GREYLIST", "Greylist", "GrEyLiSt", "TRY AGAIN", "Try Again"}
	for _, h := range hints {
		got := ClassifySMTPError(errors.New(h))
		if got != SMTPTransient {
			t.Errorf("mixed-case %q: want SMTPTransient, got %v", h, got)
		}
	}
}

// TestProperty_ClassifySMTPError_CzechHints tests specific Czech MTA phrases.
func TestProperty_ClassifySMTPError_CzechHints(t *testing.T) {
	transient := []string{
		"451 4.7.1 Greylisting applied, see http://postgrey.schweikert.ch/help/",
		"421 Service temporarily unavailable",
		"452 Insufficient system storage",
	}
	for _, h := range transient {
		got := ClassifySMTPError(errors.New(h))
		if got != SMTPTransient {
			t.Errorf("Czech transient %q: want SMTPTransient, got %v", h, got)
		}
	}

	permanent := []string{
		"550 5.1.1 The email account that you tried to reach does not exist",
		"553 5.1.3 Invalid address format",
	}
	for _, h := range permanent {
		got := ClassifySMTPError(errors.New(h))
		if got != SMTPPermanent {
			t.Errorf("Czech permanent %q: want SMTPPermanent, got %v", h, got)
		}
	}
}

// TestProperty_ClassifySMTPError_DoublyWrapped verifies triple-wrapped errors
// are unwrapped to find the textproto.Error via errors.As.
func TestProperty_ClassifySMTPError_DoublyWrapped(t *testing.T) {
	inner := &textproto.Error{Code: 451, Msg: "greylisted"}
	level1 := fmt.Errorf("smtp: %w", inner)
	level2 := fmt.Errorf("send: %w", level1)
	level3 := fmt.Errorf("campaign: %w", level2)

	if got := ClassifySMTPError(level3); got != SMTPTransient {
		t.Errorf("triple-wrapped 451: want SMTPTransient, got %v", got)
	}
}

// ─── greylistingBackoff — property tests ─────────────────────────────────

// TestProperty_GreylistingBackoff_NeverZero ensures backoff is always positive.
func TestProperty_GreylistingBackoff_NeverZero(t *testing.T) {
	for attempt := -5; attempt <= 20; attempt++ {
		d := greylistingBackoff(attempt)
		if d <= 0 {
			t.Errorf("attempt=%d: backoff must be positive, got %v", attempt, d)
		}
	}
}

// TestProperty_GreylistingBackoff_MaxIs24h verifies the ceiling is exactly 24h.
func TestProperty_GreylistingBackoff_MaxIs24h(t *testing.T) {
	for attempt := 3; attempt <= 100; attempt++ {
		d := greylistingBackoff(attempt)
		if d != 24*time.Hour {
			t.Errorf("attempt=%d: want 24h ceiling, got %v", attempt, d)
		}
	}
}

// TestProperty_GreylistingBackoff_ScheduleExact locks all 4 segments.
func TestProperty_GreylistingBackoff_ScheduleExact(t *testing.T) {
	cases := map[int]time.Duration{
		-99: 15 * time.Minute,
		-1:  15 * time.Minute,
		0:   15 * time.Minute,
		1:   1 * time.Hour,
		2:   4 * time.Hour,
		3:   24 * time.Hour,
	}
	for attempt, want := range cases {
		got := greylistingBackoff(attempt)
		if got != want {
			t.Errorf("attempt=%d: want %v, got %v", attempt, want, got)
		}
	}
}

// ─── generateMessageID — property tests ──────────────────────────────────

// TestProperty_GenerateMessageID_FormatValid verifies the Message-ID contains
// '@' (RFC 5322 shape: <local@domain>).
func TestProperty_GenerateMessageID_FormatValid(t *testing.T) {
	addrs := []string{
		"sender@firma.cz",
		"info@company.com",
		"a@b.cz",
		"",
	}
	for _, addr := range addrs {
		id := generateMessageID(addr)
		if !strings.Contains(id, "@") {
			t.Errorf("generateMessageID(%q) = %q: missing '@'", addr, id)
		}
	}
}

// TestProperty_GenerateMessageID_NeverEmpty verifies non-empty result.
func TestProperty_GenerateMessageID_NeverEmpty(t *testing.T) {
	addrs := []string{"a@b.cz", "", "x@y.com", "sender@domain.example"}
	for _, addr := range addrs {
		if id := generateMessageID(addr); id == "" {
			t.Errorf("generateMessageID(%q) returned empty string", addr)
		}
	}
}

// TestProperty_GenerateMessageID_Unique100 generates 100 IDs and checks no
// collisions — guards against entropy regression.
func TestProperty_GenerateMessageID_Unique100(t *testing.T) {
	seen := make(map[string]struct{}, 100)
	for i := 0; i < 100; i++ {
		id := generateMessageID("test@firma.cz")
		if _, dup := seen[id]; dup {
			t.Fatalf("collision after %d calls: %q", i, id)
		}
		seen[id] = struct{}{}
	}
}

// ─── randomDelay — property tests ────────────────────────────────────────

// TestProperty_RandomDelay_EqualMinMax returns exactly min when min==max.
func TestProperty_RandomDelay_EqualMinMax(t *testing.T) {
	cases := []int{0, 1, 5, 30, 3600}
	for _, v := range cases {
		got := randomDelay(v, v)
		want := time.Duration(v) * time.Second
		if got != want {
			t.Errorf("randomDelay(%d,%d) = %v, want %v", v, v, got, want)
		}
	}
}

// TestProperty_RandomDelay_MaxLessThanMinReturnsMin covers the `maxSec<=minSec` branch.
func TestProperty_RandomDelay_MaxLessThanMinReturnsMin(t *testing.T) {
	cases := [][2]int{{10, 5}, {100, 1}, {7, 3}, {60, 0}}
	for _, c := range cases {
		min, max := c[0], c[1]
		got := randomDelay(min, max)
		want := time.Duration(min) * time.Second
		if got != want {
			t.Errorf("randomDelay(%d,%d) = %v, want %v (min fallback)", min, max, got, want)
		}
	}
}

// TestProperty_RandomDelay_InBounds verifies the result is in [minSec, maxSec).
func TestProperty_RandomDelay_InBounds(t *testing.T) {
	tests := [][2]int{{1, 2}, {0, 5}, {10, 20}, {1, 60}, {3, 4}}
	for _, tc := range tests {
		minS, maxS := tc[0], tc[1]
		for i := 0; i < 50; i++ {
			d := randomDelay(minS, maxS)
			secs := int(d.Seconds())
			if secs < minS || secs >= maxS {
				t.Errorf("randomDelay(%d,%d) = %v (%ds) out of [%d,%d)", minS, maxS, d, secs, minS, maxS)
			}
		}
	}
}

// TestProperty_RandomDelay_ZeroMinZeroMax returns 0 duration.
func TestProperty_RandomDelay_ZeroMinZeroMax(t *testing.T) {
	got := randomDelay(0, 0)
	if got != 0 {
		t.Errorf("randomDelay(0,0) = %v, want 0", got)
	}
}

// TestProperty_RandomDelay_Distribution verifies non-trivial range produces
// multiple distinct values (statistical guard against constant output).
func TestProperty_RandomDelay_Distribution(t *testing.T) {
	seen := make(map[time.Duration]bool)
	for i := 0; i < 200; i++ {
		seen[randomDelay(0, 10)] = true
	}
	if len(seen) < 3 {
		t.Errorf("randomDelay(0,10) over 200 calls produced only %d distinct values", len(seen))
	}
}

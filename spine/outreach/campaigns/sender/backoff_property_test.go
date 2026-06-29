package sender

import (
	"errors"
	"fmt"
	"net/textproto"
	"strings"
	"testing"
	"testing/quick"
	"time"
)

// ── Property: ClassifySMTPError never panics ─────────────────
func TestProperty_ClassifySMTPError_NoPanic(t *testing.T) {
	f := func(msg string) bool {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on %q: %v", msg, r)
			}
		}()
		_ = ClassifySMTPError(errors.New(msg))
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: nil error → SMTPOK ─────────────────────────────
func TestProperty_ClassifySMTPError_NilOK(t *testing.T) {
	if got := ClassifySMTPError(nil); got != SMTPOK {
		t.Fatalf("nil error: want SMTPOK, got %v", got)
	}
}

// ── Property: deterministic ──────────────────────────────────
func TestProperty_ClassifySMTPError_Deterministic(t *testing.T) {
	f := func(msg string) bool {
		e := errors.New(msg)
		return ClassifySMTPError(e) == ClassifySMTPError(e)
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: textproto 4xx → SMTPTransient ──────────────────
func TestProperty_ClassifySMTPError_4xxTransient(t *testing.T) {
	for code := 400; code < 500; code += 5 {
		err := &textproto.Error{Code: code, Msg: "some msg"}
		if got := ClassifySMTPError(err); got != SMTPTransient {
			t.Fatalf("code=%d: want SMTPTransient, got %v", code, got)
		}
	}
}

// ── Property: textproto 5xx → SMTPPermanent ──────────────────
func TestProperty_ClassifySMTPError_5xxPermanent(t *testing.T) {
	for code := 500; code < 600; code += 5 {
		err := &textproto.Error{Code: code, Msg: "some msg"}
		if got := ClassifySMTPError(err); got != SMTPPermanent {
			t.Fatalf("code=%d: want SMTPPermanent, got %v", code, got)
		}
	}
}

// ── Property: textproto out-of-range → SMTPUnknown ───────────
func TestProperty_ClassifySMTPError_OutOfRangeUnknown(t *testing.T) {
	for _, code := range []int{200, 300, 399, 600, 700, 900} {
		err := &textproto.Error{Code: code, Msg: "msg"}
		if got := ClassifySMTPError(err); got != SMTPUnknown {
			t.Fatalf("code=%d: want SMTPUnknown, got %v", code, got)
		}
	}
}

// ── Property: greylisting hints → SMTPTransient ──────────────
func TestProperty_ClassifySMTPError_GreylistingHints(t *testing.T) {
	hints := []string{
		"421 server too busy",
		"450 greylist try again",
		"451 try later please",
		"452 mailbox temporarily unavailable",
		"GREYLIST",                                      // case-insensitive
		"Try Again in 15 minutes",
		"temporary failure in handling",
		"deferred until 12:00",
		"resources temporarily unavailable",
	}
	for _, h := range hints {
		got := ClassifySMTPError(errors.New(h))
		if got != SMTPTransient {
			t.Fatalf("%q: want SMTPTransient, got %v", h, got)
		}
	}
}

// ── Property: permanent hints → SMTPPermanent ────────────────
func TestProperty_ClassifySMTPError_PermanentHints(t *testing.T) {
	hints := []string{
		"550 user unknown",
		"551 not local",
		"552 mailbox full",
		"553 relay denied",
		"554 transaction failed",
		"Mailbox Unavailable",   // case-insensitive
		"User Unknown on domain",
		"No such user here",
		"does not exist",
		"relay denied by policy",
	}
	for _, h := range hints {
		got := ClassifySMTPError(errors.New(h))
		if got != SMTPPermanent {
			t.Fatalf("%q: want SMTPPermanent, got %v", h, got)
		}
	}
}

// ── Property: unclassifiable → SMTPUnknown ───────────────────
func TestProperty_ClassifySMTPError_UnknownFallback(t *testing.T) {
	hints := []string{
		"connection reset",
		"i/o timeout",
		"tls handshake error",
		"dns lookup failed",
		"some random garbage",
		"",
	}
	for _, h := range hints {
		got := ClassifySMTPError(errors.New(h))
		if got != SMTPUnknown {
			t.Fatalf("%q: want SMTPUnknown (no hint match), got %v", h, got)
		}
	}
}

// ── Property: output enum constrained to 4 values ────────────
func TestProperty_ClassifySMTPError_EnumRange(t *testing.T) {
	valid := map[SMTPClass]bool{
		SMTPOK: true, SMTPTransient: true, SMTPPermanent: true, SMTPUnknown: true,
	}
	f := func(msg string) bool {
		return valid[ClassifySMTPError(errors.New(msg))]
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

// ── Property: greylistingBackoff monotonically non-decreasing ─
func TestProperty_GreylistingBackoff_MonotonicNonDecreasing(t *testing.T) {
	prev := greylistingBackoff(0)
	for attempt := 1; attempt <= 10; attempt++ {
		cur := greylistingBackoff(attempt)
		if cur < prev {
			t.Fatalf("backoff regressed at attempt=%d: prev=%v cur=%v", attempt, prev, cur)
		}
		prev = cur
	}
}

// ── Property: greylistingBackoff bounded ─────────────────────
// Negative attempts fallback to 15m; attempts ≥3 cap at 24h.
func TestProperty_GreylistingBackoff_Bounded(t *testing.T) {
	cases := map[int]time.Duration{
		-1: 15 * time.Minute,
		0:  15 * time.Minute,
		1:  1 * time.Hour,
		2:  4 * time.Hour,
		3:  24 * time.Hour,
		4:  24 * time.Hour, // capped
		99: 24 * time.Hour, // still capped
	}
	for attempt, want := range cases {
		if got := greylistingBackoff(attempt); got != want {
			t.Fatalf("greylistingBackoff(%d) = %v, want %v", attempt, got, want)
		}
	}
}

// ── Property: textproto 4xx trumps permanent hint in error string ─
// Priority lock: explicit reply code wins over substring heuristic.
func TestProperty_ClassifySMTPError_CodeTrumpsString(t *testing.T) {
	// A 4xx textproto.Error whose Msg also contains "550 user unknown"
	// must still classify as Transient (code takes precedence).
	err := &textproto.Error{Code: 421, Msg: "server busy 550 user unknown"}
	if got := ClassifySMTPError(err); got != SMTPTransient {
		t.Fatalf("code 421 should win over '550 user unknown' msg; got %v", got)
	}
}

// ── Property: string hints case-insensitive ──────────────────
func TestProperty_ClassifySMTPError_HintCaseInsensitive(t *testing.T) {
	for _, base := range []string{"greylist", "user unknown", "temporary failure"} {
		lower := ClassifySMTPError(errors.New(strings.ToLower(base)))
		upper := ClassifySMTPError(errors.New(strings.ToUpper(base)))
		if lower != upper {
			t.Fatalf("case mismatch for %q: lower=%v upper=%v", base, lower, upper)
		}
	}
}

// ── Property: multiple conflicting hints → first match wins ──
// Implementation detail lock: transient hints are checked FIRST,
// so a string containing both "greylist" and "user unknown" maps to
// Transient (greylist wins by order).
func TestProperty_ClassifySMTPError_ConflictOrder(t *testing.T) {
	err := errors.New("greylist and user unknown together")
	if got := ClassifySMTPError(err); got != SMTPTransient {
		t.Fatalf("greylist should win over user-unknown in combined string; got %v", got)
	}
}

// ── Property: wrapped errors also classified ─────────────────
// Use fmt.Errorf("... %w", ...) — should unwrap to textproto.Error.
func TestProperty_ClassifySMTPError_WrappedErrors(t *testing.T) {
	inner := &textproto.Error{Code: 550, Msg: "user unknown"}
	wrapped := fmt.Errorf("send failed: %w", inner)
	if got := ClassifySMTPError(wrapped); got != SMTPPermanent {
		t.Fatalf("wrapped 550 should classify as Permanent, got %v", got)
	}
}

package sender

import (
	"errors"
	"fmt"
	"net/textproto"
	"testing"
	"time"
)

// ─── ClassifySMTPError: exhaustive matrix ────────────────────────────────────

func TestClassifySMTPError_NilIsOKExt(t *testing.T) {
	if ClassifySMTPError(nil) != SMTPOK {
		t.Errorf("nil err: want SMTPOK")
	}
}

func TestClassifySMTPError_Code4xxIsTransient(t *testing.T) {
	cases := []int{400, 420, 421, 422, 430, 440, 450, 451, 452, 470, 480, 499}
	for _, code := range cases {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			err := &textproto.Error{Code: code, Msg: "x"}
			if got := ClassifySMTPError(err); got != SMTPTransient {
				t.Errorf("code=%d got=%d want SMTPTransient", code, got)
			}
		})
	}
}

func TestClassifySMTPError_Code5xxIsPermanent(t *testing.T) {
	cases := []int{500, 501, 502, 503, 504, 550, 551, 552, 553, 554, 555, 569, 599}
	for _, code := range cases {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			err := &textproto.Error{Code: code, Msg: "x"}
			if got := ClassifySMTPError(err); got != SMTPPermanent {
				t.Errorf("code=%d got=%d want SMTPPermanent", code, got)
			}
		})
	}
}

func TestClassifySMTPError_Code1xx2xx3xxIsUnknown(t *testing.T) {
	cases := []int{100, 200, 250, 300, 399}
	for _, code := range cases {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			err := &textproto.Error{Code: code, Msg: "x"}
			if got := ClassifySMTPError(err); got != SMTPUnknown {
				t.Errorf("code=%d got=%d want SMTPUnknown", code, got)
			}
		})
	}
}

func TestClassifySMTPError_TransientStringHints(t *testing.T) {
	hints := []string{
		"greylist in effect",
		"GREYLISTING active",
		"try again later",
		"please TRY AGAIN",
		"try later",
		"deferred delivery",
		"message temporarily queued",
		"resources temporarily unavailable",
		"temporary failure",
		"421 server busy",
		"450 not available",
		"451 please retry",
		"452 insufficient storage",
	}
	for _, h := range hints {
		t.Run(h, func(t *testing.T) {
			if got := ClassifySMTPError(errors.New(h)); got != SMTPTransient {
				t.Errorf("hint %q got %d want SMTPTransient", h, got)
			}
		})
	}
}

func TestClassifySMTPError_PermanentStringHints(t *testing.T) {
	hints := []string{
		"550 mailbox does not exist",
		"551 user not local",
		"552 message size",
		"553 requested action not taken",
		"554 transaction failed",
		"MAILBOX UNAVAILABLE",
		"user unknown in virtual mailbox table",
		"no such user here",
		"relay denied",
	}
	for _, h := range hints {
		t.Run(h, func(t *testing.T) {
			if got := ClassifySMTPError(errors.New(h)); got != SMTPPermanent {
				t.Errorf("hint %q got %d want SMTPPermanent", h, got)
			}
		})
	}
}

func TestClassifySMTPError_ConnectionErrorsAreUnknown(t *testing.T) {
	cases := []string{
		"connection refused",
		"no route to host",
		"i/o timeout",
		"tls handshake failure",
		"authentication failed",
		"EOF",
		"",
	}
	for _, e := range cases {
		t.Run(fmt.Sprintf("%q", e), func(t *testing.T) {
			err := errors.New(e)
			if got := ClassifySMTPError(err); got != SMTPUnknown {
				t.Errorf("%q got %d want SMTPUnknown", e, got)
			}
		})
	}
}

// ─── greylistingBackoff: exhaustive schedule ─────────────────────────────────

func TestGreylistingBackoff_ScheduleExtended(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{-10, 15 * time.Minute},
		{-1, 15 * time.Minute},
		{0, 15 * time.Minute},
		{1, 1 * time.Hour},
		{2, 4 * time.Hour},
		{3, 24 * time.Hour},
		{4, 24 * time.Hour},
		{10, 24 * time.Hour},
		{100, 24 * time.Hour},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("attempt=%d", c.attempt), func(t *testing.T) {
			if got := greylistingBackoff(c.attempt); got != c.want {
				t.Errorf("attempt=%d got=%v want=%v", c.attempt, got, c.want)
			}
		})
	}
}

func TestGreylistingBackoff_MonotonicNonDecreasing(t *testing.T) {
	var prev time.Duration = -1
	for attempt := 0; attempt < 10; attempt++ {
		d := greylistingBackoff(attempt)
		if d < prev {
			t.Errorf("schedule must be monotonic: prev=%v curr=%v attempt=%d", prev, d, attempt)
		}
		prev = d
	}
}

func TestGreylistingBackoff_AllPositive(t *testing.T) {
	for attempt := -5; attempt < 20; attempt++ {
		if d := greylistingBackoff(attempt); d <= 0 {
			t.Errorf("attempt=%d: backoff must be positive, got %v", attempt, d)
		}
	}
}

func TestMaxGreylistingAttempts_ValueExt(t *testing.T) {
	// Invariant: schedule must cover at least maxGreylistingAttempts slots
	// with meaningful, distinct delays in the first few positions.
	if maxGreylistingAttempts < 1 {
		t.Fatalf("maxGreylistingAttempts must be >= 1, got %d", maxGreylistingAttempts)
	}
	seen := map[time.Duration]bool{}
	for i := 0; i < maxGreylistingAttempts; i++ {
		seen[greylistingBackoff(i)] = true
	}
	if len(seen) < 2 {
		t.Errorf("schedule must have at least 2 distinct delays over %d attempts, got %d",
			maxGreylistingAttempts, len(seen))
	}
}

// ─── SMTPClass constants ─────────────────────────────────────────────────────

func TestSMTPClass_Constants(t *testing.T) {
	cases := []struct {
		c    SMTPClass
		name string
	}{
		{SMTPOK, "SMTPOK"},
		{SMTPTransient, "SMTPTransient"},
		{SMTPPermanent, "SMTPPermanent"},
		{SMTPUnknown, "SMTPUnknown"},
	}
	seen := map[SMTPClass]string{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if other, ok := seen[c.c]; ok {
				t.Errorf("SMTPClass collision: %s and %s share value %d", c.name, other, c.c)
			}
			seen[c.c] = c.name
		})
	}
}

// ─── Edge cases: wrapped errors, nested errors.As ───────────────────────────

type wrappedErr struct{ inner error }

func (w *wrappedErr) Error() string { return "wrap: " + w.inner.Error() }
func (w *wrappedErr) Unwrap() error { return w.inner }

func TestClassifySMTPError_UnwrapsTextprotoError(t *testing.T) {
	inner := &textproto.Error{Code: 550, Msg: "nope"}
	wrapped := &wrappedErr{inner: inner}
	if got := ClassifySMTPError(wrapped); got != SMTPPermanent {
		t.Errorf("wrapped 550 got %d want SMTPPermanent", got)
	}
}

func TestClassifySMTPError_UnwrapsMultiLevel(t *testing.T) {
	inner := &textproto.Error{Code: 421, Msg: "busy"}
	wrapped := &wrappedErr{inner: &wrappedErr{inner: inner}}
	if got := ClassifySMTPError(wrapped); got != SMTPTransient {
		t.Errorf("double-wrapped 421 got %d want SMTPTransient", got)
	}
}

func TestClassifySMTPError_StringMatchIsCaseInsensitive(t *testing.T) {
	cases := []struct {
		msg   string
		class SMTPClass
	}{
		{"GREYLIST ACTIVE", SMTPTransient},
		{"Try Again", SMTPTransient},
		{"RELAY DENIED", SMTPPermanent},
		{"NO SUCH USER", SMTPPermanent},
		{"USER UNKNOWN on server", SMTPPermanent},
	}
	for _, c := range cases {
		t.Run(c.msg, func(t *testing.T) {
			if got := ClassifySMTPError(errors.New(c.msg)); got != c.class {
				t.Errorf("%q got %d want %d", c.msg, got, c.class)
			}
		})
	}
}

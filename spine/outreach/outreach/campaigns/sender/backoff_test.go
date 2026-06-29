package sender

import (
	"errors"
	"net/textproto"
	"testing"
	"time"
)

func TestClassifySMTPError_Nil(t *testing.T) {
	if got := ClassifySMTPError(nil); got != SMTPOK {
		t.Errorf("nil error: got %v, want SMTPOK", got)
	}
}

func TestClassifySMTPError_TextprotoTransient(t *testing.T) {
	cases := []int{421, 450, 451, 452}
	for _, code := range cases {
		err := &textproto.Error{Code: code, Msg: "temporary failure"}
		if got := ClassifySMTPError(err); got != SMTPTransient {
			t.Errorf("code %d: got %v, want SMTPTransient", code, got)
		}
	}
}

func TestClassifySMTPError_TextprotoPermanent(t *testing.T) {
	cases := []int{550, 551, 552, 553, 554}
	for _, code := range cases {
		err := &textproto.Error{Code: code, Msg: "mailbox unavailable"}
		if got := ClassifySMTPError(err); got != SMTPPermanent {
			t.Errorf("code %d: got %v, want SMTPPermanent", code, got)
		}
	}
}

func TestClassifySMTPError_TextprotoUnknown(t *testing.T) {
	err := &textproto.Error{Code: 250, Msg: "ok"}
	if got := ClassifySMTPError(err); got != SMTPUnknown {
		t.Errorf("code 250 (non 4xx/5xx): got %v, want SMTPUnknown", got)
	}
}

func TestClassifySMTPError_HeuristicTransient_Czech(t *testing.T) {
	// Seznam.cz and other Czech MTAs use these phrases in plain errors
	// (not wrapped in textproto.Error after our layers of error wrapping).
	cases := []string{
		"smtp: 451 greylisting in effect, try again later",
		"421 service temporarily unavailable",
		"mail deferred: please try later",
		"450 resources temporarily unavailable",
	}
	for _, msg := range cases {
		err := errors.New(msg)
		if got := ClassifySMTPError(err); got != SMTPTransient {
			t.Errorf("%q: got %v, want SMTPTransient", msg, got)
		}
	}
}

func TestClassifySMTPError_HeuristicPermanent(t *testing.T) {
	cases := []string{
		"smtp: 550 5.1.1 no such user",
		"553 mailbox unavailable",
		"user unknown in local recipient table",
		"relay denied",
	}
	for _, msg := range cases {
		err := errors.New(msg)
		if got := ClassifySMTPError(err); got != SMTPPermanent {
			t.Errorf("%q: got %v, want SMTPPermanent", msg, got)
		}
	}
}

func TestClassifySMTPError_UnclassifiableIsUnknown(t *testing.T) {
	cases := []string{
		"tls dial: connection refused",
		"smtp client: EOF",
		"auth: 535 bad credentials", // 535 not in our heuristic list
	}
	for _, msg := range cases {
		err := errors.New(msg)
		if got := ClassifySMTPError(err); got != SMTPUnknown {
			t.Errorf("%q: got %v, want SMTPUnknown", msg, got)
		}
	}
}

func TestClassifySMTPError_WrappedTextproto(t *testing.T) {
	// Real send path wraps errors (fmt.Errorf("rcpt to: %w", err)). The
	// classifier must see through the wrapper via errors.As.
	inner := &textproto.Error{Code: 451, Msg: "greylisted"}
	wrapped := errors.New("rcpt to: " + inner.Error())
	// String-only wrapping would not preserve the type, but fmt.Errorf with %w would.
	// We test the textproto-visible path separately — here we verify heuristic still wins.
	if got := ClassifySMTPError(wrapped); got != SMTPTransient {
		t.Errorf("wrapped 451: got %v, want SMTPTransient (via heuristic)", got)
	}
}

func TestGreylistingBackoff_Schedule(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 15 * time.Minute},
		{1, 1 * time.Hour},
		{2, 4 * time.Hour},
		{3, 24 * time.Hour},
		{4, 24 * time.Hour},
		{99, 24 * time.Hour},
	}
	for _, c := range cases {
		if got := greylistingBackoff(c.attempt); got != c.want {
			t.Errorf("attempt=%d: got %v, want %v", c.attempt, got, c.want)
		}
	}
}

func TestGreylistingBackoff_NegativeAttempt(t *testing.T) {
	// Defensive: should not panic, should return minimum backoff.
	if got := greylistingBackoff(-5); got != 15*time.Minute {
		t.Errorf("negative attempt: got %v, want 15m", got)
	}
}

func TestMaxGreylistingAttempts_Sane(t *testing.T) {
	// Guard against someone changing this to 0 by accident.
	if maxGreylistingAttempts < 2 {
		t.Errorf("maxGreylistingAttempts=%d too low, need at least 2", maxGreylistingAttempts)
	}
	if maxGreylistingAttempts > 10 {
		t.Errorf("maxGreylistingAttempts=%d too high, would waste a week per bad domain", maxGreylistingAttempts)
	}
}
